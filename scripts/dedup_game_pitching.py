#!/usr/bin/env python3
"""
Deduplicate game_pitching rows.

Root cause: two scrapers write the same pitcher's line from the same game
under different player_name formats:
  - scripts/scrape_boxscores.py writes "First Last"
  - scripts/scrape_nwac.py process_seattle_u writes "Last, First" (WMT API)
Both resolve to the SAME player_id, but there is no UNIQUE (game_id, player_id)
constraint on game_pitching, so two rows get inserted and downstream aggregations
(GREATEST(ps, box)) get inflated.

This script groups game_pitching by (game_id, player_id) where both are NOT NULL,
keeps the row with the largest id (most recently inserted), and deletes the others.
Orphan rows with player_id IS NULL are reported separately but NOT touched.

Usage (on Mac or server):
    cd /Users/naterasmussen/Desktop/pnw-baseball   # or /opt/pnw-baseball on server
    python3 scripts/dedup_game_pitching.py --dry-run
    python3 scripts/dedup_game_pitching.py --season 2026 --dry-run
    python3 scripts/dedup_game_pitching.py                 # commits across all seasons
    python3 scripts/dedup_game_pitching.py --season 2026   # commits for 2026 only
"""

import argparse
import logging
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

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


def dedup_game_pitching(season=None, dry_run=False):
    conn = get_conn()
    cur = conn.cursor()

    # Build a season filter that plugs into both queries.
    season_sql = ""
    season_params = ()
    if season is not None:
        season_sql = " AND g.season = %s"
        season_params = (season,)

    # ---------- Report: orphan rows (player_id IS NULL) ----------
    # Break down by whether team_id is populated. Orphans WITH a team_id still
    # count in the team-ERA CTE in /api/v1/team-stats, so they inflate totals.
    cur.execute(
        f"""
        SELECT g.season,
               CASE WHEN gp.team_id IS NULL THEN 'team_id NULL'
                    ELSE 'team_id SET' END AS bucket,
               COUNT(*) AS orphan_count,
               SUM(COALESCE(gp.innings_pitched, 0))   AS sum_ip,
               SUM(COALESCE(gp.earned_runs, 0))       AS sum_er,
               SUM(COALESCE(gp.batters_faced, 0))     AS sum_bf
        FROM game_pitching gp
        JOIN games g ON gp.game_id = g.id
        WHERE gp.player_id IS NULL
          {season_sql}
        GROUP BY g.season, bucket
        ORDER BY g.season, bucket
        """,
        season_params,
    )
    orphan_rows = cur.fetchall()
    total_orphans = sum(r["orphan_count"] for r in orphan_rows)
    if total_orphans:
        logger.info("Orphan game_pitching rows (player_id IS NULL) - NOT touched by this script:")
        for r in orphan_rows:
            logger.info(
                "  season %s  %-13s  rows=%-5s  sum_ip=%-7s  sum_er=%-5s  sum_bf=%s",
                r["season"], r["bucket"], r["orphan_count"],
                r["sum_ip"], r["sum_er"], r["sum_bf"],
            )
        logger.info("  TOTAL orphans: %s  (orphans with team_id SET are inflating team ERA)", total_orphans)
    else:
        logger.info("No orphan rows (player_id IS NULL) found.")

    # ---------- Find (game_id, player_id) duplicates ----------
    cur.execute(
        f"""
        SELECT gp.game_id,
               gp.player_id,
               g.season,
               gp.team_id,
               COUNT(*) AS cnt,
               array_agg(gp.id ORDER BY gp.id) AS row_ids,
               array_agg(gp.player_name ORDER BY gp.id) AS names
        FROM game_pitching gp
        JOIN games g ON gp.game_id = g.id
        WHERE gp.player_id IS NOT NULL
          {season_sql}
        GROUP BY gp.game_id, gp.player_id, g.season, gp.team_id
        HAVING COUNT(*) > 1
        ORDER BY g.season DESC, gp.game_id
        """,
        season_params,
    )
    dup_groups = cur.fetchall()

    if not dup_groups:
        logger.info("No duplicate (game_id, player_id) groups found. Nothing to do.")
        conn.close()
        return

    logger.info("Found %s duplicate (game_id, player_id) groups.", len(dup_groups))

    # ---------- Breakdown by team ----------
    by_team_season = {}
    for g in dup_groups:
        # keep all but the largest id
        loser_count = len(g["row_ids"]) - 1
        key = (g["season"], g["team_id"])
        by_team_season[key] = by_team_season.get(key, 0) + loser_count

    # Resolve team names in one shot.
    team_ids = sorted({k[1] for k in by_team_season.keys() if k[1] is not None})
    team_names = {}
    if team_ids:
        cur.execute(
            "SELECT id, short_name FROM teams WHERE id = ANY(%s)",
            (team_ids,),
        )
        team_names = {r["id"]: r["short_name"] for r in cur.fetchall()}

    logger.info("Duplicate rows to remove, grouped by (season, team):")
    # Some dup groups may have team_id = NULL; coerce to -1 so the sort tuple is comparable.
    def _sort_key(item):
        (s, tid), cnt = item
        return (-cnt, s if s is not None else 0, tid if tid is not None else -1)
    for (s, tid), cnt in sorted(by_team_season.items(), key=_sort_key):
        name = team_names.get(tid, f"(team_id={tid})") if tid is not None else "(team_id=NULL)"
        logger.info("  %s  %-28s  %s rows", s, name, cnt)

    # Collect loser row ids (keep max(id), delete the rest).
    loser_ids = []
    for g in dup_groups:
        row_ids = sorted(g["row_ids"])
        survivor = row_ids[-1]
        for rid in row_ids[:-1]:
            loser_ids.append(rid)

    logger.info("Total rows that will be DELETED: %s", len(loser_ids))
    logger.info("Total surviving groups: %s", len(dup_groups))

    # Show a small sample of what's being removed.
    logger.info("Sample of duplicate groups (first 5):")
    for g in dup_groups[:5]:
        tname = team_names.get(g["team_id"], f"team_id={g['team_id']}")
        logger.info(
            "  game_id=%s  player_id=%s  team=%s  count=%s  ids=%s  names=%s",
            g["game_id"], g["player_id"], tname, g["cnt"],
            g["row_ids"], g["names"],
        )

    # ---------- DELETE ----------
    if not loser_ids:
        logger.info("Nothing to delete.")
        conn.close()
        return

    # Delete in batches to keep statement size sane.
    BATCH = 1000
    deleted = 0
    for i in range(0, len(loser_ids), BATCH):
        chunk = loser_ids[i:i + BATCH]
        cur.execute("DELETE FROM game_pitching WHERE id = ANY(%s)", (chunk,))
        deleted += cur.rowcount

    if dry_run:
        conn.rollback()
        logger.info("[DRY RUN] would have DELETED %s rows. ROLLED BACK.", deleted)
    else:
        conn.commit()
        logger.info("COMMITTED. DELETED %s rows from game_pitching.", deleted)

    conn.close()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--season", type=int, default=None,
                   help="Limit to a single season. Default: all seasons.")
    p.add_argument("--dry-run", action="store_true",
                   help="Roll back instead of committing. Safe to run.")
    args = p.parse_args()

    if not DATABASE_URL:
        logger.error("DATABASE_URL not set in environment / .env")
        sys.exit(1)

    dedup_game_pitching(season=args.season, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
