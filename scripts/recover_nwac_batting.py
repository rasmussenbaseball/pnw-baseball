#!/usr/bin/env python3
"""
Recover NWAC batting data lost during dedup.

The dedup_games.py script deleted duplicate NWAC games, but each "duplicate"
had different player data (scraped from different team perspectives). This
script prepares for recovery by:

1. Finding NWAC games with NO batting data (can be re-scraped directly)
2. Finding NWAC games with PARTIAL batting data (only one team represented)
3. Optionally clearing partial data so the backfill scraper will re-process them

After running this script, run the backfill scraper:
    PYTHONPATH=backend python3 scripts/scrape_nwac_boxscores.py --backfill

Usage (on server):
    cd /opt/pnw-baseball
    python3 scripts/recover_nwac_batting.py --season 2026
    python3 scripts/recover_nwac_batting.py --season 2026 --clear-partial
"""

import argparse
import os
import sys

import psycopg2
import psycopg2.extras

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
DATABASE_URL = os.environ.get("DATABASE_URL")


def get_conn():
    url = DATABASE_URL
    if url and "sslmode" not in url:
        sep = "&" if "?" in url else "?"
        url = url + sep + "sslmode=require"
    conn = psycopg2.connect(url)
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def run_recovery(season, clear_partial=False):
    conn = get_conn()
    cur = conn.cursor()

    # Get all NWAC teams (JUCO division)
    cur.execute("""
        SELECT t.id, t.short_name
        FROM teams t
        JOIN conferences c ON c.id = t.conference_id
        JOIN divisions d ON d.id = c.division_id
        WHERE d.level = 'JUCO'
    """)
    nwac_team_ids = {row["id"] for row in cur.fetchall()}
    print(f"Found {len(nwac_team_ids)} NWAC teams\n")

    # ── 1. Games with NO batting data ──
    cur.execute("""
        SELECT g.id, g.game_date, g.home_team_id, g.away_team_id,
               g.home_team_name, g.away_team_name, g.source_url
        FROM games g
        WHERE g.season = %s AND g.status = 'final'
          AND (g.home_team_id = ANY(%s) OR g.away_team_id = ANY(%s))
          AND NOT EXISTS (SELECT 1 FROM game_batting gb WHERE gb.game_id = g.id)
        ORDER BY g.game_date
    """, (season, list(nwac_team_ids), list(nwac_team_ids)))
    no_batting = cur.fetchall()

    has_url = sum(1 for g in no_batting if g["source_url"] and "nwacsports.com" in g["source_url"])
    no_url = len(no_batting) - has_url

    print(f"{'='*60}")
    print(f"NWAC games with NO batting data: {len(no_batting)}")
    print(f"  With NWAC source_url: {has_url} (daily scraper can handle)")
    print(f"  Without NWAC source_url: {no_url} (backfill will match by date+teams)")
    print(f"{'='*60}\n")

    # ── 2. Games with PARTIAL batting data (only one team) ──
    cur.execute("""
        SELECT g.id, g.game_date, g.home_team_id, g.away_team_id,
               g.home_team_name, g.away_team_name, g.source_url,
               COUNT(DISTINCT gb.team_id) AS teams_with_batting,
               COUNT(gb.id) AS total_rows,
               array_agg(DISTINCT gb.team_id) AS batting_team_ids
        FROM games g
        JOIN game_batting gb ON gb.game_id = g.id
        WHERE g.season = %s AND g.status = 'final'
          AND (g.home_team_id = ANY(%s) OR g.away_team_id = ANY(%s))
        GROUP BY g.id, g.game_date, g.home_team_id, g.away_team_id,
                 g.home_team_name, g.away_team_name, g.source_url
        HAVING COUNT(DISTINCT gb.team_id) < 2
        ORDER BY g.game_date
    """, (season, list(nwac_team_ids), list(nwac_team_ids)))
    partial_batting = cur.fetchall()

    print(f"{'='*60}")
    print(f"NWAC games with PARTIAL batting data (1 team only): {len(partial_batting)}")
    print(f"{'='*60}")

    if partial_batting:
        for g in partial_batting[:20]:
            print(f"  {g['game_date']} {g['away_team_name']} @ {g['home_team_name']} "
                  f"(game {g['id']}, {g['total_rows']} rows, teams: {g['batting_team_ids']})")
        if len(partial_batting) > 20:
            print(f"  ... and {len(partial_batting) - 20} more")

    # ── 3. Summary of total games with complete batting ──
    cur.execute("""
        SELECT COUNT(*) as cnt
        FROM (
            SELECT g.id
            FROM games g
            JOIN game_batting gb ON gb.game_id = g.id
            WHERE g.season = %s AND g.status = 'final'
              AND (g.home_team_id = ANY(%s) OR g.away_team_id = ANY(%s))
            GROUP BY g.id
            HAVING COUNT(DISTINCT gb.team_id) >= 2
        ) complete
    """, (season, list(nwac_team_ids), list(nwac_team_ids)))
    complete = cur.fetchone()["cnt"]

    cur.execute("""
        SELECT COUNT(*) as cnt FROM games
        WHERE season = %s AND status = 'final'
          AND (home_team_id = ANY(%s) OR away_team_id = ANY(%s))
    """, (season, list(nwac_team_ids), list(nwac_team_ids)))
    total = cur.fetchone()["cnt"]

    print(f"\n{'='*60}")
    print(f"SUMMARY for season {season}:")
    print(f"  Total NWAC games: {total}")
    print(f"  Complete batting (both teams): {complete}")
    print(f"  Partial batting (one team): {len(partial_batting)}")
    print(f"  No batting data: {len(no_batting)}")
    print(f"  Need recovery: {len(no_batting) + len(partial_batting)}")
    print(f"  Estimated backfill credits: {(len(no_batting) + len(partial_batting)) * 10}")
    print(f"{'='*60}")

    # ── 4. Clear partial data if requested ──
    if clear_partial and partial_batting:
        print(f"\nClearing batting/pitching data for {len(partial_batting)} partial games...")
        cleared = 0
        for g in partial_batting:
            cur.execute("DELETE FROM game_batting WHERE game_id = %s", (g["id"],))
            cur.execute("DELETE FROM game_pitching WHERE game_id = %s", (g["id"],))
            cleared += 1
        conn.commit()
        print(f"Cleared {cleared} games. These will now be picked up by the backfill scraper.")
    elif partial_batting:
        print(f"\nTo clear partial data and prepare for re-scrape, run with --clear-partial")

    conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Recover NWAC batting data")
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--clear-partial", action="store_true",
                        help="Clear incomplete batting data so backfill will re-scrape")
    args = parser.parse_args()

    run_recovery(args.season, args.clear_partial)
