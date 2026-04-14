#!/usr/bin/env python3
"""
Deduplicate games in the database.

Games can be duplicated when:
- The same game is scraped from both teams' sites
- NULL team_ids cause dedup checks to fail (NULL != NULL in SQL)
- Multiple scrape runs re-insert the same games

For each group of duplicates (same date + same teams), keeps the game
with the most game_batting rows and deletes the rest.

Usage (on server):
    cd /opt/pnw-baseball
    python3 scripts/dedup_games.py --season 2026 --dry-run
    python3 scripts/dedup_games.py --season 2026
"""

import argparse
import logging
import os
import sys

import psycopg2
import psycopg2.extras

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
DATABASE_URL = os.environ.get("DATABASE_URL")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def get_conn():
    url = DATABASE_URL
    if url and "sslmode" not in url:
        sep = "&" if "?" in url else "?"
        url = url + sep + "sslmode=require"
    conn = psycopg2.connect(url)
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def dedup_games(season, dry_run=False):
    conn = get_conn()
    cur = conn.cursor()

    # Find all duplicate groups using IS NOT DISTINCT FROM for NULL-safe comparison
    cur.execute("""
        SELECT
            game_date,
            home_team_id,
            away_team_id,
            game_number,
            COUNT(*) as cnt,
            array_agg(id ORDER BY id) as game_ids
        FROM games
        WHERE season = %s AND status = 'final'
        GROUP BY game_date, home_team_id, away_team_id, game_number
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
    """, (season,))

    dup_groups = cur.fetchall()
    logger.info(f"Found {len(dup_groups)} duplicate game groups")

    total_deleted = 0
    total_batting_deleted = 0
    total_pitching_deleted = 0

    for group in dup_groups:
        game_ids = group["game_ids"]
        date = group["game_date"]
        home = group["home_team_id"]
        away = group["away_team_id"]
        gnum = group["game_number"]

        # For each game in the group, count batting rows
        best_id = None
        best_count = -1
        game_counts = {}

        for gid in game_ids:
            cur.execute("SELECT COUNT(*) as cnt FROM game_batting WHERE game_id = %s", (gid,))
            cnt = cur.fetchone()["cnt"]
            game_counts[gid] = cnt
            if cnt > best_count:
                best_count = cnt
                best_id = gid

        ids_to_delete = [gid for gid in game_ids if gid != best_id]

        if not ids_to_delete:
            continue

        logger.info(
            f"  {date} home={home} away={away} gn={gnum}: "
            f"keeping game {best_id} ({best_count} batting rows), "
            f"deleting {len(ids_to_delete)} dupes {ids_to_delete}"
        )

        if dry_run:
            total_deleted += len(ids_to_delete)
            for did in ids_to_delete:
                total_batting_deleted += game_counts[did]
            continue

        # Delete batting and pitching rows for duplicate games
        for did in ids_to_delete:
            cur.execute("DELETE FROM game_batting WHERE game_id = %s", (did,))
            b_del = cur.rowcount
            total_batting_deleted += b_del

            cur.execute("DELETE FROM game_pitching WHERE game_id = %s", (did,))
            p_del = cur.rowcount
            total_pitching_deleted += p_del

            cur.execute("DELETE FROM games WHERE id = %s", (did,))
            total_deleted += 1

        conn.commit()

    logger.info(f"\n{'='*60}")
    logger.info(f"{'DRY RUN - ' if dry_run else ''}Dedup complete for season {season}")
    logger.info(f"  Duplicate groups found: {len(dup_groups)}")
    logger.info(f"  Games deleted: {total_deleted}")
    logger.info(f"  Batting rows deleted: {total_batting_deleted}")
    logger.info(f"  Pitching rows deleted: {total_pitching_deleted}")

    # Show final game count
    cur.execute("SELECT COUNT(*) as cnt FROM games WHERE season = %s AND status = 'final'", (season,))
    remaining = cur.fetchone()["cnt"]
    logger.info(f"  Games remaining: {remaining}")

    conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Deduplicate games")
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    dedup_games(args.season, args.dry_run)
