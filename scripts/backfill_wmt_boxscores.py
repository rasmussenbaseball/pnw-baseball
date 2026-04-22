#!/usr/bin/env python3
"""
Backfill box scores from the WMT Games API.

The WMT (Winsipedia/Sidearm) API exposes game-level player stats that aren't
available via the standard Sidearm v2 API on some sites (e.g., Seattle U).

Usage (on server):
    cd /opt/pnw-baseball
    python3 scripts/backfill_wmt_boxscores.py --team "Seattle U" --season 2026
    python3 scripts/backfill_wmt_boxscores.py --team "Seattle U" --season 2026 --dry-run
"""

import argparse
import logging
import os
import random
import sys
import time

import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
# Add scripts directory so shared helpers can be imported as top-level modules
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import psycopg2
import psycopg2.extras

# Shared team-name matching (see scripts/team_matching.py)
from team_matching import (
    get_team_id_by_short_name,
    get_or_create_ooc_team,
)

DATABASE_URL = os.environ.get("DATABASE_URL")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
]

# ── Team configs ──
# wmt_team_ids maps season year -> WMT team ID
WMT_TEAMS = {
    "Seattle U": {
        "db_short": "Seattle U",
        "wmt_domain": "goseattleu",
        "wmt_team_ids": {2026: 614833},
    },
}


def get_conn():
    url = DATABASE_URL
    if url and "sslmode" not in url:
        sep = "&" if "?" in url else "?"
        url = url + sep + "sslmode=require"
    conn = psycopg2.connect(url)
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def get_team_id(short_name):
    """Exact short_name lookup. Opens a connection, delegates to shared helper."""
    conn = get_conn()
    try:
        cur = conn.cursor()
        return get_team_id_by_short_name(cur, short_name)
    finally:
        conn.close()


def resolve_opponent_id(cur, opponent_name, prefer_team_id=None):
    """Resolve opponent name to a team_id using the shared resolver.

    Auto-creates an inactive OOC team if no match exists, preventing
    NULL team_ids in game rows. Uses prefer_division_of_team_id to bias
    ambiguous names toward the tenant's division.
    """
    if not opponent_name:
        return None
    return get_or_create_ooc_team(
        cur, opponent_name, prefer_division_of_team_id=prefer_team_id
    )


def match_player_id(cur, player_name, team_id, season):
    """Match a player name (Last, First or First Last) to a player_id in the DB."""
    if not player_name:
        return None

    # Parse name
    if "," in player_name:
        parts = player_name.split(",", 1)
        last = parts[0].strip()
        first = parts[1].strip()
    else:
        parts = player_name.strip().split()
        if len(parts) >= 2:
            first = parts[0]
            last = " ".join(parts[1:])
        else:
            last = player_name.strip()
            first = "%"

    # Try exact match on this team
    cur.execute("""
        SELECT id FROM players
        WHERE team_id = %s AND last_name ILIKE %s AND first_name ILIKE %s
        LIMIT 1
    """, (team_id, last, first))
    row = cur.fetchone()
    if row:
        return row["id"]

    # Try matching against batting_stats for this team+season
    cur.execute("""
        SELECT p.id FROM players p
        JOIN batting_stats bs ON bs.player_id = p.id AND bs.team_id = %s AND bs.season = %s
        WHERE p.last_name ILIKE %s AND p.first_name ILIKE %s
        LIMIT 1
    """, (team_id, season, last, first))
    row = cur.fetchone()
    if row:
        return row["id"]

    # Try matching against pitching_stats
    cur.execute("""
        SELECT p.id FROM players p
        JOIN pitching_stats ps ON ps.player_id = p.id AND ps.team_id = %s AND ps.season = %s
        WHERE p.last_name ILIKE %s AND p.first_name ILIKE %s
        LIMIT 1
    """, (team_id, season, last, first))
    row = cur.fetchone()
    if row:
        return row["id"]

    return None


def fetch_all_games(wmt_team_id):
    """Fetch all games for a WMT team (handles pagination via cursor)."""
    all_games = []
    cursor = None
    page = 0

    while True:
        page += 1
        url = f"https://api.wmt.games/api/statistics/teams/{wmt_team_id}/games?per_page=100"
        if cursor:
            url += f"&cursor={cursor}"

        logger.info(f"  Fetching games page {page}...")
        resp = requests.get(url, headers={"User-Agent": random.choice(USER_AGENTS)}, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        games = data.get("data", [])
        all_games.extend(games)

        next_cursor = data.get("meta", {}).get("pagination", {}).get("next_page")
        if not next_cursor or len(games) == 0:
            break
        cursor = next_cursor
        time.sleep(0.3)

    return all_games


def fetch_game_players(game_id):
    """Fetch player-level stats for a specific game."""
    url = f"https://api.wmt.games/api/statistics/games/{game_id}/players?per_page=100"
    resp = requests.get(url, headers={"User-Agent": random.choice(USER_AGENTS)}, timeout=30)
    resp.raise_for_status()
    return resp.json().get("data", [])


def parse_player_stats(player_data, team_id):
    """Extract batting and pitching stats from a WMT player entry."""
    # Get game totals (period == 0)
    totals = {}
    for s in player_data.get("statistic", []):
        if s["period"] == 0:
            totals = s["statistic"]
            break

    name = player_data.get("xml_name", "")  # "Last, First"
    position = player_data.get("xml_position", "")
    spot = totals.get("sSpot", 0)  # lineup order (0 = not in lineup)

    result = {"name": name, "position": position, "batting": None, "pitching": None}

    # Batting stats
    ab = totals.get("sAtBats", 0)
    ip_raw = totals.get("sInningsPitched", 0)
    # Normalize IP to baseball notation (.0, .1, .2).
    # WMT usually returns baseball notation, but some rows come through as decimals.
    try:
        ip_val = float(ip_raw) if ip_raw is not None else 0.0
        whole = int(ip_val)
        frac = round((ip_val - whole) * 10)
        if frac in (0, 1, 2):
            ip = float(f"{whole}.{frac}")
        else:
            outs_total = round(ip_val * 3)
            ip = float(f"{outs_total // 3}.{outs_total % 3}")
    except (ValueError, TypeError):
        ip = 0.0

    if ab is not None and ab > 0 or totals.get("sWalks", 0) or totals.get("sHitByPitch", 0) or totals.get("sRuns", 0) or totals.get("sSacrificeFlies", 0) or totals.get("sSacrificeBunts", 0):
        result["batting"] = {
            "player_name": name,
            "team_id": team_id,
            "batting_order": spot if spot else None,
            "position": position,
            "at_bats": ab or 0,
            "runs": totals.get("sRuns", 0) or 0,
            "hits": totals.get("sHits", 0) or 0,
            "doubles": totals.get("sDoubles", 0) or 0,
            "triples": totals.get("sTriples", 0) or 0,
            "home_runs": totals.get("sHomeRuns", 0) or 0,
            "rbi": totals.get("sRunsBattedIn", 0) or 0,
            "walks": totals.get("sWalks", 0) or 0,
            "strikeouts": totals.get("sStrikeoutsHitting", 0) or 0,
            "hit_by_pitch": totals.get("sHitByPitch", 0) or 0,
            "stolen_bases": totals.get("sStolenBases", 0) or 0,
            "caught_stealing": totals.get("sCaughtStealing", 0) or 0,
            "sacrifice_flies": totals.get("sSacrificeFlies", 0) or 0,
            "sacrifice_bunts": totals.get("sSacrificeBunts", 0) or 0,
            "left_on_base": totals.get("sLeftOnBase", 0) or 0,
        }

    # Pitching stats
    if ip and ip > 0:
        result["pitching"] = {
            "player_name": name,
            "team_id": team_id,
            "pitch_order": spot if spot else None,
            "is_starter": bool(totals.get("sGamesStarted", 0)),
            "decision": None,  # WMT doesn't expose W/L/S directly
            "innings_pitched": ip,
            "hits_allowed": totals.get("sHitsAllowed", 0) or 0,
            "runs_allowed": totals.get("sRunsAllowed", 0) or 0,
            "earned_runs": totals.get("sEarnedRuns", 0) or 0,
            "walks": totals.get("sBasesOnBallsAllowed", 0) or 0,
            "strikeouts": totals.get("sStrikeouts", 0) or 0,
            "home_runs_allowed": totals.get("sHomeRunsAllowed", 0) or 0,
            "hit_batters": totals.get("sHitBattersPitching", 0) or 0,
            "wild_pitches": totals.get("sWildPitches", 0) or 0,
            "batters_faced": totals.get("sBattersFaced", 0) or 0,
            "pitches_thrown": totals.get("sPitchCount", 0) or 0,
            "strikes": totals.get("sStrikes", 0) or 0,
        }

    return result


def backfill_team(team_key, season=2026, dry_run=False):
    """Backfill box scores for a team using the WMT Games API."""
    if team_key not in WMT_TEAMS:
        logger.error(f"Unknown team: {team_key}. Available: {list(WMT_TEAMS.keys())}")
        return

    config = WMT_TEAMS[team_key]
    db_short = config["db_short"]
    db_team_id = get_team_id(db_short)
    if not db_team_id:
        logger.error(f"Team '{db_short}' not found in database")
        return

    wmt_team_id = config["wmt_team_ids"].get(season)
    if not wmt_team_id:
        logger.error(f"No WMT team_id configured for {team_key} season {season}")
        return

    logger.info(f"{'='*60}")
    logger.info(f"Backfilling {team_key} (db_id={db_team_id}, wmt_id={wmt_team_id})")
    logger.info(f"Season: {season}, Dry run: {dry_run}")

    # Fetch all games
    all_games = fetch_all_games(wmt_team_id)
    finalized = [g for g in all_games if g.get("stats_finalized")]
    logger.info(f"  Found {len(all_games)} total games, {len(finalized)} finalized")

    # Deduplicate (API can return duplicates across pages)
    seen_ids = set()
    unique_games = []
    for g in finalized:
        if g["id"] not in seen_ids:
            seen_ids.add(g["id"])
            unique_games.append(g)
    finalized = unique_games
    logger.info(f"  {len(finalized)} unique finalized games")

    conn = get_conn()
    cur = conn.cursor()

    inserted = 0
    skipped = 0

    for game in finalized:
        game_id = game["id"]
        game_date = game["game_date"][:10]  # "2026-02-19"
        periods = game.get("periods_played", 9)

        competitors = game.get("competitors", [])
        home_comp = next((c for c in competitors if c.get("homeTeam")), None)
        away_comp = next((c for c in competitors if not c.get("homeTeam")), None)

        if not home_comp or not away_comp:
            logger.warning(f"  Skipping game {game_id}: missing competitors")
            skipped += 1
            continue

        home_name = home_comp.get("nameTabular", "Unknown")
        away_name = away_comp.get("nameTabular", "Unknown")
        home_score = home_comp.get("score")
        away_score = away_comp.get("score")

        if home_score is None or away_score is None:
            logger.info(f"  Skipping {game_date} {away_name} @ {home_name}: no score (not played yet)")
            skipped += 1
            continue

        # Determine which competitor is "us" (Seattle U)
        is_home = home_comp.get("teamId") == wmt_team_id
        my_comp = home_comp if is_home else away_comp
        opp_comp = away_comp if is_home else home_comp
        opp_name = opp_comp.get("nameTabular", "Unknown")

        # Resolve team IDs in our DB. Pass the tenant's team_id so same-division
        # teams are preferred when an opponent name is ambiguous.
        if is_home:
            home_team_id = db_team_id
            away_team_id = resolve_opponent_id(cur, opp_name, prefer_team_id=db_team_id)
        else:
            away_team_id = db_team_id
            home_team_id = resolve_opponent_id(cur, opp_name, prefer_team_id=db_team_id)

        is_conference = game.get("conference_contest", False)
        source_url = f"wmt://games/{game_id}"

        # Check for existing game
        cur.execute("SELECT id FROM games WHERE source_url = %s", (source_url,))
        if cur.fetchone():
            logger.debug(f"  Already exists (source_url): {game_date} vs {opp_name}")
            skipped += 1
            continue

        # Also check by date + teams
        if home_team_id and away_team_id:
            cur.execute("""
                SELECT id FROM games
                WHERE game_date = %s AND season = %s
                  AND ((home_team_id = %s AND away_team_id = %s)
                    OR (home_team_id = %s AND away_team_id = %s))
            """, (game_date, season, home_team_id, away_team_id, away_team_id, home_team_id))
            if cur.fetchone():
                logger.debug(f"  Already exists (date+teams): {game_date} vs {opp_name}")
                skipped += 1
                continue

        logger.info(f"  Processing: {game_date} {away_name} {away_score} @ {home_name} {home_score} (wmt_id={game_id})")

        if dry_run:
            inserted += 1
            continue

        # Fetch player stats for this game
        try:
            game_players = fetch_game_players(game_id)
            time.sleep(0.3)
        except Exception as e:
            logger.error(f"    Failed to fetch players: {e}")
            continue

        # Split players by team and parse stats
        home_batting = []
        away_batting = []
        home_pitching = []
        away_pitching = []

        for gp in game_players:
            player_team_id = gp.get("team_id")
            if player_team_id == wmt_team_id:
                this_team_id = db_team_id
                is_player_home = is_home
            else:
                this_team_id = home_team_id if not is_home else away_team_id
                is_player_home = not is_home

            parsed = parse_player_stats(gp, this_team_id)

            if parsed["batting"]:
                if is_player_home:
                    home_batting.append(parsed["batting"])
                else:
                    away_batting.append(parsed["batting"])

            if parsed["pitching"]:
                if is_player_home:
                    home_pitching.append(parsed["pitching"])
                else:
                    away_pitching.append(parsed["pitching"])

        # Insert game
        try:
            cur.execute("""
                INSERT INTO games (season, game_date, home_team_id, away_team_id,
                                 home_team_name, away_team_name, home_score, away_score,
                                 innings, is_conference_game, is_postseason, game_number,
                                 location, source_url, status)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id
            """, (
                season, game_date, home_team_id, away_team_id,
                home_name, away_name, home_score, away_score,
                periods, is_conference, False, 1,
                None, source_url, "final",
            ))
            db_game_id = cur.fetchone()["id"]

            # Insert batting lines
            for batters in [home_batting, away_batting]:
                for b in batters:
                    player_id = match_player_id(cur, b["player_name"], b["team_id"], season)
                    cur.execute("""
                        INSERT INTO game_batting (game_id, team_id, player_id, player_name,
                            batting_order, position, at_bats, runs, hits, doubles, triples,
                            home_runs, rbi, walks, strikeouts, hit_by_pitch, stolen_bases,
                            caught_stealing, sacrifice_flies, sacrifice_bunts, left_on_base)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT DO NOTHING
                    """, (
                        db_game_id, b["team_id"], player_id, b["player_name"],
                        b["batting_order"], b["position"],
                        b["at_bats"], b["runs"], b["hits"], b["doubles"], b["triples"],
                        b["home_runs"], b["rbi"], b["walks"], b["strikeouts"],
                        b["hit_by_pitch"], b["stolen_bases"], b["caught_stealing"],
                        b["sacrifice_flies"], b["sacrifice_bunts"], b["left_on_base"],
                    ))

            # Insert pitching lines
            for pitchers in [home_pitching, away_pitching]:
                for p in pitchers:
                    player_id = match_player_id(cur, p["player_name"], p["team_id"], season)
                    cur.execute("""
                        INSERT INTO game_pitching (game_id, team_id, player_id, player_name,
                            pitch_order, is_starter, decision, innings_pitched, hits_allowed,
                            runs_allowed, earned_runs, walks, strikeouts, home_runs_allowed,
                            hit_batters, wild_pitches, batters_faced, pitches_thrown, strikes)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT DO NOTHING
                    """, (
                        db_game_id, p["team_id"], player_id, p["player_name"],
                        p["pitch_order"], p["is_starter"], p["decision"],
                        p["innings_pitched"], p["hits_allowed"], p["runs_allowed"],
                        p["earned_runs"], p["walks"], p["strikeouts"],
                        p["home_runs_allowed"], p["hit_batters"], p["wild_pitches"],
                        p["batters_faced"], p["pitches_thrown"], p["strikes"],
                    ))

            conn.commit()

            total_b = len(home_batting) + len(away_batting)
            total_p = len(home_pitching) + len(away_pitching)
            logger.info(f"    Inserted game {db_game_id}: {game_date} "
                        f"{away_name} {away_score} @ {home_name} {home_score} "
                        f"[{total_b} batters, {total_p} pitchers]")
            inserted += 1

        except Exception as e:
            conn.rollback()
            logger.error(f"    Failed to insert game: {e}")
            continue

    conn.close()
    logger.info(f"\nDone: {inserted} games {'would be ' if dry_run else ''}inserted, {skipped} skipped")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill box scores from WMT Games API")
    parser.add_argument("--team", type=str, required=True, help="Team name (e.g., 'Seattle U')")
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--dry-run", action="store_true", help="Don't actually insert, just show what would be done")
    args = parser.parse_args()

    backfill_team(args.team, args.season, args.dry_run)
