#!/usr/bin/env python3
"""
Backfill missing Sidearm box scores by probing the JSON API.

For new Sidearm Nuxt sites (UW, Oregon, OSU, WSU), the schedule page
renders client-side and our HTML parser misses older games. This script
bypasses the schedule page entirely by:

  1. Probing a range of box score IDs via the Sidearm v2 JSON API
  2. Filtering to baseball-only results
  3. Skipping games we already have in the database
  4. Inserting missing games + game_batting + game_pitching rows

Usage:
    cd /opt/pnw-baseball
    PYTHONPATH=backend python3 scripts/backfill_sidearm_boxscores.py --team UW --dry-run
    PYTHONPATH=backend python3 scripts/backfill_sidearm_boxscores.py --team UW
    PYTHONPATH=backend python3 scripts/backfill_sidearm_boxscores.py --team UW --start-id 24900 --end-id 25050
    PYTHONPATH=backend python3 scripts/backfill_sidearm_boxscores.py --all-d1
"""

import sys
import os
import time
import random
import argparse
import logging
import re
from datetime import datetime, date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import requests
from app.models.database import get_connection

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("backfill_sidearm")

# ============================================================
# Team configs: base_url, tenant, db_short_name
# ============================================================
SIDEARM_TEAMS = {
    "UW":         ("https://gohuskies.com",    "washington",  "UW"),
    "Oregon":     ("https://goducks.com",       "uoregon",     "Oregon"),
    "Oregon St.": ("https://osubeavers.com",    "oregonstate",  "Oregon St."),
    "Wash. St.":  ("https://wsucougars.com",    "wsu",          "Wash. St."),
}

USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
]


def fetch_boxscore_api(base_url, game_id, tenant):
    """Fetch a single box score from the Sidearm v2 API. Returns JSON dict or None."""
    api_url = f"{base_url}/api/v2/stats/boxscore/{game_id}"
    try:
        resp = requests.get(
            api_url,
            headers={
                "tenant": tenant,
                "Accept": "application/json",
                "User-Agent": random.choice(USER_AGENTS),
            },
            timeout=15,
        )
        if resp.status_code == 204:
            return None
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()
    except requests.exceptions.HTTPError:
        return None
    except Exception as e:
        logger.debug(f"  ID {game_id}: error {e}")
        return None


def is_baseball_game(data):
    """Check if a Sidearm API response is a baseball game by looking at the PDF path."""
    pdf = data.get("pdfDoc", "")
    if "/baseball/" in pdf.lower() or "/bsb/" in pdf.lower():
        return True
    # Also check if players have baseball-specific stats (hitting.atBats)
    for team_key in ("homeTeam", "visitingTeam"):
        team = data.get(team_key, {})
        players = team.get("players", [])
        for p in players:
            hitting = p.get("hitting") or {}
            if "atBats" in hitting:
                return True
    return False


def get_game_date(data):
    """Extract game date from Sidearm API response."""
    venue = data.get("venue", {})
    date_str = venue.get("date", "")
    if not date_str:
        return None
    try:
        # Format: "MM/DD/YYYY"
        return datetime.strptime(date_str, "%m/%d/%Y").date()
    except ValueError:
        try:
            return datetime.strptime(date_str, "%m/%d/%y").date()
        except ValueError:
            logger.warning(f"  Could not parse date: {date_str}")
            return None


def get_existing_source_urls(team_short, season):
    """Get set of source_urls already in the database for this team."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT g.source_url FROM games g
            WHERE g.season = %s
              AND (g.home_team_name = %s OR g.away_team_name = %s
                   OR g.home_team_id = (SELECT id FROM teams WHERE short_name = %s LIMIT 1)
                   OR g.away_team_id = (SELECT id FROM teams WHERE short_name = %s LIMIT 1))
        """, (season, team_short, team_short, team_short, team_short))
        return {r["source_url"] for r in cur.fetchall() if r["source_url"]}


def get_team_id(team_short):
    """Look up team ID from short_name."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM teams WHERE short_name = %s", (team_short,))
        row = cur.fetchone()
        return row["id"] if row else None


def resolve_opponent_id(opponent_name, prefer_team_id=None):
    """Try to match opponent name to a team in our database."""
    with get_connection() as conn:
        cur = conn.cursor()
        # Direct match on name or short_name
        cur.execute("""
            SELECT id, short_name FROM teams
            WHERE short_name ILIKE %s OR name ILIKE %s
            LIMIT 1
        """, (opponent_name, opponent_name))
        row = cur.fetchone()
        if row:
            return row["id"]

        # Try alias match
        cur.execute("""
            SELECT team_id FROM team_aliases
            WHERE alias ILIKE %s
            LIMIT 1
        """, (opponent_name,))
        row = cur.fetchone()
        if row:
            return row["team_id"]
    return None


def parse_boxscore_data(data, base_url, game_id, team_short, team_id):
    """
    Parse Sidearm v2 API JSON into game/batting/pitching dicts.
    Returns (game_data, home_batting, away_batting, home_pitching, away_pitching) or None.
    """
    venue = data.get("venue", {})
    game_date = get_game_date(data)
    if not game_date:
        return None

    home_team = data.get("homeTeam", {})
    away_team = data.get("visitingTeam", {})

    home_name = home_team.get("name", "Unknown")
    away_name = away_team.get("name", "Unknown")

    # Determine if our team is home or away
    our_team_is_home = home_team.get("isTenantTeam", False)

    # Parse scores from scoreSummary
    home_score_str = (home_team.get("scoreSummary") or {}).get("score", "0")
    away_score_str = (away_team.get("scoreSummary") or {}).get("score", "0")
    try:
        home_score = int(home_score_str)
    except (ValueError, TypeError):
        home_score = 0
    try:
        away_score = int(away_score_str)
    except (ValueError, TypeError):
        away_score = 0

    # Innings from score by period
    score_by_inning = (home_team.get("scoreSummary") or {}).get("scoreByPeriod", "")
    innings = len(score_by_inning.split(",")) if score_by_inning else 9

    # Conference game
    is_conference = venue.get("isALeagueGame", False)
    is_postseason = venue.get("isAPostseasonGame", False)
    location = venue.get("location", "")
    stadium = venue.get("stadium", "")
    attendance = venue.get("attendance", "")

    source_url = f"{base_url}/boxscore.aspx?id={game_id}"

    # Resolve team IDs
    if our_team_is_home:
        home_team_id = team_id
        away_team_id = resolve_opponent_id(away_name)
        home_team_display = team_short
        away_team_display = away_name
    else:
        away_team_id = team_id
        home_team_id = resolve_opponent_id(home_name)
        home_team_display = home_name
        away_team_display = team_short

    game_data = {
        "season": game_date.year if game_date.month >= 2 else game_date.year,
        "game_date": game_date,
        "home_team_id": home_team_id,
        "away_team_id": away_team_id,
        "home_team_name": home_team_display,
        "away_team_name": away_team_display,
        "home_score": home_score,
        "away_score": away_score,
        "innings": innings,
        "is_conference_game": is_conference,
        "is_postseason": is_postseason,
        "game_number": 1,
        "location": f"{stadium}, {location}" if stadium and location else location or stadium,
        "source_url": source_url,
        "status": "final",
        "attendance": attendance,
    }

    # Parse batting lines
    def parse_batting(team_data, bat_team_id):
        batters = []
        for p in team_data.get("players", []):
            hitting = p.get("hitting", {})
            if not hitting or hitting.get("atBats") is None:
                continue
            # Skip pitchers who didn't bat (0 AB, 0 PA in some formats)
            ab = _int(hitting.get("atBats", 0))
            # Include all batters who appeared in the batting order
            batter = {
                "team_id": bat_team_id,
                "player_name": p.get("playerFirstLastName", p.get("name", "")),
                "position": (p.get("position") or "").upper(),
                "batting_order": _int(p.get("battingOrder", 0)),
                "at_bats": ab,
                "runs": _int(hitting.get("runsScored", 0)),
                "hits": _int(hitting.get("hits", 0)),
                "doubles": _int(hitting.get("doubles", 0)),
                "triples": _int(hitting.get("triples", 0)),
                "home_runs": _int(hitting.get("homeRuns", 0)),
                "rbi": _int(hitting.get("runsBattedIn", 0)),
                "walks": _int(hitting.get("walks", 0)),
                "strikeouts": _int(hitting.get("strikeouts", 0)),
                "hit_by_pitch": _int(hitting.get("hitByPitch", 0)),
                "stolen_bases": _int(hitting.get("stolenBases", 0)),
                "caught_stealing": _int(hitting.get("caughtStealing", 0)),
                "sacrifice_flies": _int(hitting.get("sacrificeFlies", 0)),
                "sacrifice_bunts": _int(hitting.get("sacrificeHits", 0)),
                "left_on_base": _int(hitting.get("leftOnBase", 0)),
            }
            batters.append(batter)
        return batters

    def parse_pitching(team_data, pitch_team_id):
        pitchers = []
        order = 0
        for p in team_data.get("players", []):
            pitching = p.get("pitching", {})
            if not pitching or pitching.get("inningsPitched") is None:
                continue
            ip_str = str(pitching.get("inningsPitched", "0"))
            ip = _parse_ip(ip_str)
            if ip == 0 and _int(pitching.get("hitsAllowed", 0)) == 0:
                continue
            order += 1
            pitcher = {
                "team_id": pitch_team_id,
                "player_name": p.get("playerFirstLastName", p.get("name", "")),
                "pitch_order": order,
                "is_starter": order == 1,
                "decision": _parse_decision(pitching),
                "innings_pitched": ip,
                "hits_allowed": _int(pitching.get("hitsAllowed", 0)),
                "runs_allowed": _int(pitching.get("runsAllowed", 0)),
                "earned_runs": _int(pitching.get("earnedRuns", 0)),
                "walks": _int(pitching.get("walks", 0)),
                "strikeouts": _int(pitching.get("strikeouts", 0)),
                "home_runs_allowed": _int(pitching.get("homeRunsAllowed", 0)),
                "hit_batters": _int(pitching.get("hitBatters", 0)),
                "wild_pitches": _int(pitching.get("wildPitches", 0)),
                "batters_faced": _int(pitching.get("battersFaced", 0)),
                "pitches_thrown": _int(pitching.get("pitches", 0)),
                "strikes": _int(pitching.get("strikes", 0)),
            }
            pitchers.append(pitcher)
        return pitchers

    home_batting = parse_batting(home_team, home_team_id)
    away_batting = parse_batting(away_team, away_team_id)
    home_pitching = parse_pitching(home_team, home_team_id)
    away_pitching = parse_pitching(away_team, away_team_id)

    return game_data, home_batting, away_batting, home_pitching, away_pitching


def _int(val):
    """Safely convert to int."""
    try:
        return int(val)
    except (ValueError, TypeError):
        return 0


def _parse_ip(ip_str):
    """Parse innings pitched string (e.g. '6.1' -> 6.333)."""
    try:
        if "." in str(ip_str):
            whole, frac = str(ip_str).split(".")
            return int(whole) + int(frac) / 3.0
        return float(ip_str)
    except (ValueError, TypeError):
        return 0.0


def _parse_decision(pitching):
    """Extract W/L/S decision from pitching data."""
    if pitching.get("win"):
        return "W"
    if pitching.get("loss"):
        return "L"
    if pitching.get("save"):
        return "S"
    return None


def match_player_id(cur, player_name, team_id, season):
    """Try to match a player name to a player_id in our database."""
    if not player_name:
        return None

    # Try exact name match for this team
    parts = player_name.strip().split()
    if len(parts) >= 2:
        first = parts[0]
        last = parts[-1]
        cur.execute("""
            SELECT p.id FROM players p
            JOIN batting_stats bs ON bs.player_id = p.id AND bs.team_id = %s AND bs.season = %s
            WHERE p.last_name ILIKE %s AND p.first_name ILIKE %s
            LIMIT 1
        """, (team_id, season, last, first))
        row = cur.fetchone()
        if row:
            return row["id"]

        # Try pitching stats too
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


def insert_game(game_data, home_batting, away_batting, home_pitching, away_pitching, season):
    """Insert a game and all its batting/pitching lines into the database."""
    with get_connection() as conn:
        cur = conn.cursor()

        # Check if game already exists by source_url
        cur.execute("SELECT id FROM games WHERE source_url = %s", (game_data["source_url"],))
        if cur.fetchone():
            logger.info(f"    Game already exists (source_url match)")
            return False

        # Also check for duplicate by date + teams (different Sidearm IDs for same game)
        cur.execute("""
            SELECT id FROM games
            WHERE game_date = %s AND season = %s
              AND ((home_team_id = %s AND away_team_id = %s)
                OR (home_team_id = %s AND away_team_id = %s))
              AND game_number = %s
        """, (
            game_data["game_date"], game_data["season"],
            game_data.get("home_team_id"), game_data.get("away_team_id"),
            game_data.get("away_team_id"), game_data.get("home_team_id"),
            game_data.get("game_number", 1),
        ))
        if cur.fetchone():
            logger.info(f"    Game already exists (date+teams match): {game_data['game_date']}")
            return False

        # Insert game
        cur.execute("""
            INSERT INTO games (season, game_date, home_team_id, away_team_id,
                             home_team_name, away_team_name, home_score, away_score,
                             innings, is_conference_game, is_postseason, game_number,
                             location, source_url, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (
            game_data["season"], game_data["game_date"],
            game_data["home_team_id"], game_data["away_team_id"],
            game_data["home_team_name"], game_data["away_team_name"],
            game_data["home_score"], game_data["away_score"],
            game_data["innings"], game_data["is_conference_game"],
            game_data["is_postseason"], game_data["game_number"],
            game_data["location"], game_data["source_url"], game_data["status"],
        ))
        game_id = cur.fetchone()["id"]

        # Insert batting lines
        for batters, team_label in [(home_batting, "home"), (away_batting, "away")]:
            for b in batters:
                player_id = match_player_id(cur, b["player_name"], b["team_id"], season)
                cur.execute("""
                    INSERT INTO game_batting (game_id, team_id, player_id, player_name,
                        batting_order, position, at_bats, runs, hits, doubles, triples,
                        home_runs, rbi, walks, strikeouts, hit_by_pitch, stolen_bases,
                        caught_stealing, sacrifice_flies, sacrifice_bunts, left_on_base)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    game_id, b["team_id"], player_id, b["player_name"],
                    b["batting_order"], b["position"],
                    b["at_bats"], b["runs"], b["hits"], b["doubles"], b["triples"],
                    b["home_runs"], b["rbi"], b["walks"], b["strikeouts"],
                    b["hit_by_pitch"], b["stolen_bases"], b["caught_stealing"],
                    b["sacrifice_flies"], b["sacrifice_bunts"], b["left_on_base"],
                ))

        # Insert pitching lines
        for pitchers, team_label in [(home_pitching, "home"), (away_pitching, "away")]:
            for p in pitchers:
                player_id = match_player_id(cur, p["player_name"], p["team_id"], season)
                cur.execute("""
                    INSERT INTO game_pitching (game_id, team_id, player_id, player_name,
                        pitch_order, is_starter, decision, innings_pitched, hits_allowed,
                        runs_allowed, earned_runs, walks, strikeouts, home_runs_allowed,
                        hit_batters, wild_pitches, batters_faced, pitches_thrown, strikes)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    game_id, p["team_id"], player_id, p["player_name"],
                    p["pitch_order"], p["is_starter"], p["decision"],
                    p["innings_pitched"], p["hits_allowed"], p["runs_allowed"],
                    p["earned_runs"], p["walks"], p["strikeouts"],
                    p["home_runs_allowed"], p["hit_batters"], p["wild_pitches"],
                    p["batters_faced"], p["pitches_thrown"], p["strikes"],
                ))

        conn.commit()
        logger.info(f"    Inserted game {game_id}: {game_data['game_date']} "
                    f"{game_data['away_team_name']} @ {game_data['home_team_name']} "
                    f"({game_data['away_score']}-{game_data['home_score']}) "
                    f"[{len(home_batting)+len(away_batting)} batters, "
                    f"{len(home_pitching)+len(away_pitching)} pitchers]")
        return True


def backfill_team(team_key, start_id=None, end_id=None, dry_run=False, season=2026):
    """Probe Sidearm API IDs to find and backfill missing baseball box scores for a team."""
    if team_key not in SIDEARM_TEAMS:
        logger.error(f"Unknown team: {team_key}. Available: {list(SIDEARM_TEAMS.keys())}")
        return

    base_url, tenant, db_short = SIDEARM_TEAMS[team_key]
    team_id = get_team_id(db_short)
    if not team_id:
        logger.error(f"Team '{db_short}' not found in database")
        return

    # Get existing source URLs to skip
    existing = get_existing_source_urls(db_short, season)
    logger.info(f"Team {db_short}: {len(existing)} games already in database")

    # Determine ID range to probe
    # Extract max existing ID from source URLs
    existing_ids = set()
    for url in existing:
        m = re.search(r'id=(\d+)', url)
        if m:
            existing_ids.add(int(m.group(1)))

    if existing_ids:
        max_existing = max(existing_ids)
        min_existing = min(existing_ids)
        logger.info(f"  Existing box score IDs: {min_existing} - {max_existing}")
    else:
        max_existing = 25050  # Default for 2026 season
        min_existing = 25050

    # Default range: probe 200 IDs before the earliest known game
    if start_id is None:
        start_id = min_existing - 200
    if end_id is None:
        end_id = max_existing + 10  # Also check a few above in case we missed recent ones

    logger.info(f"  Probing IDs {start_id} - {end_id} ({end_id - start_id + 1} total)")

    found_games = []
    # Track date+opponent combos to detect doubleheaders vs duplicates
    seen_date_matchups = {}  # (date, frozenset({home,away})) -> list of game_ids
    inserted = 0
    skipped = 0
    skipped_dup = 0

    for gid in range(start_id, end_id + 1):
        source_url = f"{base_url}/boxscore.aspx?id={gid}"

        # Skip if we already have this game
        if source_url in existing:
            continue

        data = fetch_boxscore_api(base_url, gid, tenant)
        if not data:
            continue

        if not is_baseball_game(data):
            continue

        game_date = get_game_date(data)
        if not game_date:
            continue

        # Filter to correct season
        if game_date.year != season or game_date.month < 2:
            continue

        home_name = data.get("homeTeam", {}).get("name", "?")
        away_name = data.get("visitingTeam", {}).get("name", "?")
        home_score = (data.get("homeTeam", {}).get("scoreSummary") or {}).get("score", "?")
        away_score = (data.get("visitingTeam", {}).get("scoreSummary") or {}).get("score", "?")

        # Check for duplicate: same date + same two teams + same score = likely same game
        matchup_key = (game_date, frozenset([home_name.lower(), away_name.lower()]))
        if matchup_key in seen_date_matchups:
            prev_list = seen_date_matchups[matchup_key]
            # Allow up to 2 games per date+opponent (doubleheader), skip beyond that
            if len(prev_list) >= 2:
                logger.debug(f"  SKIP duplicate ID {gid}: {game_date} {away_name} @ {home_name}")
                skipped_dup += 1
                continue
            # Same date + same opponent but only 1 so far = could be doubleheader
            seen_date_matchups[matchup_key].append(data)
        else:
            seen_date_matchups[matchup_key] = [data]

        logger.info(f"  FOUND baseball game ID {gid}: {game_date} — {away_name} @ {home_name} ({away_score}-{home_score})")
        found_games.append((gid, data))

        if not dry_run:
            parsed = parse_boxscore_data(data, base_url, gid, db_short, team_id)
            if parsed:
                game_data, hb, ab, hp, ap = parsed
                if insert_game(game_data, hb, ab, hp, ap, season):
                    inserted += 1
                else:
                    skipped += 1

        # Rate limit
        time.sleep(0.3)

    logger.info(f"\n{'='*60}")
    logger.info(f"BACKFILL COMPLETE: {db_short}")
    logger.info(f"  IDs probed: {end_id - start_id + 1}")
    logger.info(f"  Baseball games found: {len(found_games)}")
    logger.info(f"  Duplicate IDs skipped: {skipped_dup}")
    if dry_run:
        logger.info(f"  DRY RUN — nothing inserted")
    else:
        logger.info(f"  Inserted: {inserted}")
        logger.info(f"  Skipped (already exist): {skipped}")
    logger.info(f"{'='*60}")


def main():
    parser = argparse.ArgumentParser(description="Backfill missing Sidearm box scores")
    parser.add_argument("--team", type=str, help="Team key: UW, Oregon, 'Oregon St.', 'Wash. St.'")
    parser.add_argument("--all-d1", action="store_true", help="Backfill all D1 Sidearm teams")
    parser.add_argument("--start-id", type=int, help="Start of ID range to probe")
    parser.add_argument("--end-id", type=int, help="End of ID range to probe")
    parser.add_argument("--season", type=int, default=2026, help="Season year (default: 2026)")
    parser.add_argument("--dry-run", action="store_true", help="Find games but don't insert")
    args = parser.parse_args()

    if not args.team and not args.all_d1:
        parser.error("Must specify --team or --all-d1")

    if args.all_d1:
        for team_key in SIDEARM_TEAMS:
            backfill_team(team_key, args.start_id, args.end_id, args.dry_run, args.season)
    else:
        backfill_team(args.team, args.start_id, args.end_id, args.dry_run, args.season)


if __name__ == "__main__":
    main()
