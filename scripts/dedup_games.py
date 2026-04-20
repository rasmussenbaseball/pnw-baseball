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

    total_deleted = 0
    total_batting_deleted = 0
    total_pitching_deleted = 0

    # ========== Pass 1: home/away-flipped duplicates ==========
    # Group by the NORMALIZED team pair so games with teams swapped between
    # home and away are caught as the same matchup. Requires both team_ids
    # to be non-NULL. NULL-opponent orphans are handled in Pass 2.
    cur.execute("""
        SELECT
            game_date,
            LEAST(home_team_id, away_team_id)    AS team_lo,
            GREATEST(home_team_id, away_team_id) AS team_hi,
            game_number,
            COUNT(*) as cnt,
            array_agg(id ORDER BY id) as game_ids
        FROM games
        WHERE season = %s AND status = 'final'
          AND home_team_id IS NOT NULL
          AND away_team_id IS NOT NULL
        GROUP BY game_date,
                 LEAST(home_team_id, away_team_id),
                 GREATEST(home_team_id, away_team_id),
                 game_number
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
    """, (season,))

    dup_groups = cur.fetchall()
    logger.info(f"Pass 1 (same team pair, either orientation): "
                f"found {len(dup_groups)} duplicate groups")

    for group in dup_groups:
        game_ids = group["game_ids"]
        date = group["game_date"]
        t_lo = group["team_lo"]
        t_hi = group["team_hi"]
        gnum = group["game_number"]

        # For each game in the group, count batting rows and keep the fullest.
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
            f"  {date} teams=({t_lo},{t_hi}) gn={gnum}: "
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
            total_batting_deleted += cur.rowcount

            cur.execute("DELETE FROM game_pitching WHERE game_id = %s", (did,))
            total_pitching_deleted += cur.rowcount

            cur.execute("DELETE FROM games WHERE id = %s", (did,))
            total_deleted += 1

        conn.commit()

    # ========== Pass 2: NULL-opponent orphan games ==========
    # Find games with NULL home_team_id or away_team_id that have a valid
    # counterpart on the same date + game_number where the valid game shares
    # one of the known team_ids. These orphans are safe to delete because the
    # valid game already contains the real data.
    cur.execute("""
        SELECT DISTINCT ON (g1.id)
            g1.id                AS orphan_id,
            g1.game_date         AS game_date,
            g1.game_number       AS game_number,
            g1.home_team_id      AS orphan_home,
            g1.away_team_id      AS orphan_away,
            g2.id                AS valid_id,
            g2.home_team_id      AS valid_home,
            g2.away_team_id      AS valid_away
        FROM games g1
        JOIN games g2
          ON g1.season = g2.season
         AND g1.game_date = g2.game_date
         AND COALESCE(g1.game_number, 1) = COALESCE(g2.game_number, 1)
         AND g1.id <> g2.id
         AND g2.home_team_id IS NOT NULL
         AND g2.away_team_id IS NOT NULL
         AND (
              g1.home_team_id IN (g2.home_team_id, g2.away_team_id)
           OR g1.away_team_id IN (g2.home_team_id, g2.away_team_id)
         )
        WHERE g1.season = %s
          AND g1.status = 'final'
          AND (g1.home_team_id IS NULL OR g1.away_team_id IS NULL)
        ORDER BY g1.id, g2.id
    """, (season,))

    orphans = cur.fetchall()
    logger.info(f"Pass 2 (NULL-opponent orphans with a valid counterpart): "
                f"found {len(orphans)}")

    for o in orphans:
        logger.info(
            f"  {o['game_date']} gn={o['game_number']} "
            f"orphan={o['orphan_id']} "
            f"home={o['orphan_home']} away={o['orphan_away']} "
            f"-> valid={o['valid_id']} "
            f"(home={o['valid_home']} away={o['valid_away']})"
        )

        if dry_run:
            cur.execute("SELECT COUNT(*) as cnt FROM game_batting  WHERE game_id = %s",
                        (o["orphan_id"],))
            total_batting_deleted += cur.fetchone()["cnt"]
            cur.execute("SELECT COUNT(*) as cnt FROM game_pitching WHERE game_id = %s",
                        (o["orphan_id"],))
            total_pitching_deleted += cur.fetchone()["cnt"]
            total_deleted += 1
            continue

        cur.execute("DELETE FROM game_batting  WHERE game_id = %s", (o["orphan_id"],))
        total_batting_deleted += cur.rowcount
        cur.execute("DELETE FROM game_pitching WHERE game_id = %s", (o["orphan_id"],))
        total_pitching_deleted += cur.rowcount
        cur.execute("DELETE FROM games         WHERE id      = %s", (o["orphan_id"],))
        total_deleted += 1

    if not dry_run:
        conn.commit()

    # ========== Summary ==========
    logger.info(f"\n{'='*60}")
    logger.info(f"{'DRY RUN - ' if dry_run else ''}Dedup complete for season {season}")
    logger.info(f"  Pass 1 duplicate groups: {len(dup_groups)}")
    logger.info(f"  Pass 2 orphan games:     {len(orphans)}")
    logger.info(f"  Games deleted:           {total_deleted}")
    logger.info(f"  Batting rows deleted:    {total_batting_deleted}")
    logger.info(f"  Pitching rows deleted:   {total_pitching_deleted}")

    # Show final game count
    cur.execute("SELECT COUNT(*) as cnt FROM games WHERE season = %s AND status = 'final'", (season,))
    remaining = cur.fetchone()["cnt"]
    logger.info(f"  Games remaining:         {remaining}")

    conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Deduplicate games")
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    dedup_games(args.season, args.dry_run)
