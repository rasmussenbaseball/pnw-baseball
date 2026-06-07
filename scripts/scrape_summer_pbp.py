#!/usr/bin/env python3
"""
WCL / summer play-by-play ingest orchestrator.

For each final summer_games row with a box-score source_url, fetch the
wclstats.com page, parse the play-by-play with parse_wcl_pbp, resolve
batter / pitcher names to summer_players IDs (within the correct team),
and write one summer_game_events row per plate appearance.

Pipeline per game:
  1. fetch HTML (wclstats.com serves the PBP server-side in the .xml URL)
  2. seed starting pitchers from summer_game_pitching.is_starter so the
     first batters of the game get the right pitcher_name
  3. parse_wcl_pbp(html, starters, home/away names)
  4. batting/defending team derived from the half (top → away bats),
     so we never depend on fuzzy team-name matching
  5. resolve batter (on batting team) + pitcher (on defending team) to
     summer_players IDs via the resolve_summer_game_players lookup
  6. DELETE existing events for the game, then INSERT fresh (idempotent)

Usage:
    PYTHONPATH=backend python3 scripts/scrape_summer_pbp.py --dry-run
    PYTHONPATH=backend python3 scripts/scrape_summer_pbp.py --season 2026
    PYTHONPATH=backend python3 scripts/scrape_summer_pbp.py --game-id 8
    PYTHONPATH=backend python3 scripts/scrape_summer_pbp.py --limit 3 --rescrape
"""

import argparse
import logging
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import requests

from app.models.database import get_connection
from parse_wcl_pbp import parse_wcl_pbp
from resolve_summer_game_players import build_lookup, resolve_one, sanitize_player_name
from wcl_http import mount_retries, fetch as wcl_fetch


logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("scrape_summer_pbp")

LEAGUE_ABBR = "WCL"
USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
]


def get_session():
    s = requests.Session()
    s.headers.update({
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml",
        "Referer": "https://westcoastleague.com/",
    })
    mount_retries(s)
    return s


def get_league_id(cur, abbr):
    cur.execute("SELECT id FROM summer_leagues WHERE abbreviation = %s", (abbr,))
    row = cur.fetchone()
    if not row:
        raise RuntimeError(f"summer_leagues row for '{abbr}' missing")
    return row["id"]


def games_needing_pbp(cur, league_id, season, rescrape=False, limit=None, game_id=None):
    """Final games with a source_url that don't yet have parsed events
    (unless --rescrape / a single --game-id is requested)."""
    params = [league_id, season]
    sql = """
        SELECT id, source_url, game_date, away_team_id, home_team_id,
               away_team_name, home_team_name
        FROM summer_games g
        WHERE league_id = %s AND season = %s
          AND status = 'final'
          AND source_url IS NOT NULL
    """
    if game_id is not None:
        sql += " AND id = %s"
        params.append(game_id)
    elif not rescrape:
        sql += " AND NOT EXISTS (SELECT 1 FROM summer_game_events e WHERE e.game_id = g.id)"
    sql += " ORDER BY game_date DESC"
    if limit:
        sql += " LIMIT %s"
        params.append(limit)
    cur.execute(sql, params)
    return cur.fetchall()


def seed_starters(cur, game_id, away_name, home_name):
    """{team_name: starting_pitcher_name} from summer_game_pitching."""
    cur.execute(
        """
        SELECT player_name, is_home
        FROM summer_game_pitching
        WHERE game_id = %s AND is_starter = TRUE
        """,
        (game_id,),
    )
    starters = {}
    for r in cur.fetchall():
        name = sanitize_player_name(r["player_name"])
        if not name:
            continue
        starters[home_name if r["is_home"] else away_name] = name
    return starters


def ingest_game(cur, session, game, exact, by_last, dry_run=False):
    """Parse + resolve + write one game's events. Returns (n_events, n_batter_resolved, n_pitcher_resolved)."""
    gid = game["id"]
    html = wcl_fetch(session, game["source_url"], timeout=30).text

    starters = seed_starters(cur, gid, game["away_team_name"], game["home_team_name"])
    events, meta = parse_wcl_pbp(
        html,
        starters=starters,
        home_team_name=game["home_team_name"],
        away_team_name=game["away_team_name"],
    )
    if not meta["has_pbp"] or not events:
        logger.warning("game %d (%s @ %s): no PBP parsed (has_pbp=%s, events=%d)",
                       gid, game["away_team_name"], game["home_team_name"],
                       meta["has_pbp"], len(events))
        return 0, 0, 0

    away_id, home_id = game["away_team_id"], game["home_team_id"]
    rows = []
    bat_res = pit_res = 0
    for e in events:
        # Team derives from the half — robust, no name matching needed.
        if e["half"] == "top":
            batting_id, defending_id = away_id, home_id
        else:
            batting_id, defending_id = home_id, away_id

        batter_pid = None
        if e["batter_name"]:
            batter_pid = resolve_one(sanitize_player_name(e["batter_name"]),
                                     batting_id, exact, by_last)
            if batter_pid:
                bat_res += 1
        pitcher_pid = None
        if e["pitcher_name"] and e["pitcher_name"] != "<UNKNOWN STARTER>":
            pitcher_pid = resolve_one(sanitize_player_name(e["pitcher_name"]),
                                      defending_id, exact, by_last)
            if pitcher_pid:
                pit_res += 1

        rows.append((
            gid, e["inning"], e["half"], e["sequence_idx"],
            batting_id, defending_id,
            batter_pid, e["batter_name"],
            pitcher_pid, e["pitcher_name"],
            e["balls_before"], e["strikes_before"],
            e["pitch_sequence"], e["pitches_thrown"], e["was_in_play"],
            e["result_type"], e["result_text"], e["rbi"],
        ))

    if not dry_run:
        cur.execute("DELETE FROM summer_game_events WHERE game_id = %s", (gid,))
        cur.executemany(
            """
            INSERT INTO summer_game_events
              (game_id, inning, half, sequence_idx, batting_team_id, defending_team_id,
               batter_player_id, batter_name, pitcher_player_id, pitcher_name,
               balls_before, strikes_before, pitch_sequence, pitches_thrown, was_in_play,
               result_type, result_text, rbi)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """,
            rows,
        )
    return len(rows), bat_res, pit_res


def run(season=2026, rescrape=False, limit=None, game_id=None, dry_run=False):
    session = get_session()
    with get_connection() as conn:
        cur = conn.cursor()
        league_id = get_league_id(cur, LEAGUE_ABBR)
        exact, by_last = build_lookup(cur)
        games = games_needing_pbp(cur, league_id, season, rescrape, limit, game_id)
        logger.info("Games to process: %d (season=%s, rescrape=%s, dry_run=%s)",
                    len(games), season, rescrape, dry_run)

        tot_events = tot_bat = tot_pit = done = 0
        for g in games:
            try:
                n, b, p = ingest_game(cur, session, g, exact, by_last, dry_run=dry_run)
            except Exception as ex:
                logger.error("game %d failed: %s", g["id"], ex)
                continue
            if n:
                done += 1
                tot_events += n
                tot_bat += b
                tot_pit += p
                logger.info("game %d (%s @ %s): %d events  (batter %d/%d, pitcher %d/%d resolved)",
                            g["id"], g["away_team_name"], g["home_team_name"],
                            n, b, n, p, n)
            time.sleep(random.uniform(0.6, 1.4))

        if not dry_run:
            conn.commit()

        logger.info("DONE: %d games, %d events  (batter %d/%d, pitcher %d/%d resolved)%s",
                    done, tot_events, tot_bat, tot_events, tot_pit, tot_events,
                    "  [DRY RUN — nothing written]" if dry_run else "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--game-id", type=int, help="Process a single summer_games.id")
    ap.add_argument("--rescrape", action="store_true", help="Re-ingest games that already have events")
    ap.add_argument("--dry-run", action="store_true", help="Parse + resolve but write nothing")
    args = ap.parse_args()
    run(season=args.season, rescrape=args.rescrape, limit=args.limit,
        game_id=args.game_id, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
