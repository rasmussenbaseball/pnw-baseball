#!/usr/bin/env python3
"""
Deduplicate game_batting rows.

Mirrors scripts/dedup_game_pitching.py. Two scrapers can write the same batter's
line from the same game under different player_name formats:
  - scripts/scrape_boxscores.py writes "First Last"
  - scripts/scrape_nwac_boxscores.py process_seattle_u writes "Last, First" (WMT API)
Both resolve to the SAME player_id, but without a UNIQUE (game_id, player_id)
constraint on game_batting, two rows get inserted. Per-game box score totals
(AB, H, HR, RBI, etc.) then double-count the batter in game detail views.
Team-level season aggregates are safe because /team-stats sums from batting_stats,
but per-game views still need this cleaned up.

This script groups game_batting by (game_id, player_id) where both are NOT NULL,
keeps the row whose team_id matches one of the game's actual teams (home or away),
and deletes the rest. Orphan rows with player_id IS NULL are reported separately
but NOT touched.

Usage (on Mac or server):
    cd /Users/naterasmussen/Desktop/pnw-baseball   # or /opt/pnw-baseball on server
    python3 scripts/dedup_game_batting.py --dry-run
    python3 scripts/dedup_game_batting.py --season 2026 --dry-run
    python3 scripts/dedup_game_batting.py                 # commits across all seasons
    python3 scripts/dedup_game_batting.py --season 2026   # commits for 2026 only
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


def dedup_game_batting(season=None, dry_run=False):
    conn = get_conn()
    cur = conn.cursor()

    season_sql = ""
    season_params = ()
    if season is not None:
        season_sql = " AND g.season = %s"
        season_params = (season,)

    # ---------- Report: orphan rows (player_id IS NULL) ----------
    cur.execute(
        f"""
        SELECT g.season,
               CASE WHEN gb.team_id IS NULL THEN 'team_id NULL'
                    ELSE 'team_id SET' END AS bucket,
               COUNT(*) AS orphan_count,
               SUM(COALESCE(gb.at_bats, 0))   AS sum_ab,
               SUM(COALESCE(gb.hits, 0))      AS sum_h,
               SUM(COALESCE(gb.home_runs, 0)) AS sum_hr
        FROM game_batting gb
        JOIN games g ON gb.game_id = g.id
        WHERE gb.player_id IS NULL
          {season_sql}
        GROUP BY g.season, bucket
        ORDER BY g.season, bucket
        """,
        season_params,
    )
    orphan_rows = cur.fetchall()
    total_orphans = sum(r["orphan_count"] for r in orphan_rows)
    if total_orphans:
        logger.info("Orphan game_batting rows (player_id IS NULL) - NOT touched by this script:")
        for r in orphan_rows:
            logger.info(
                "  season %s  %-13s  rows=%-5s  sum_ab=%-6s  sum_h=%-5s  sum_hr=%s",
                r["season"], r["bucket"], r["orphan_count"],
                r["sum_ab"], r["sum_h"], r["sum_hr"],
            )
        logger.info("  TOTAL orphans: %s", total_orphans)
    else:
        logger.info("No orphan rows (player_id IS NULL) found.")

    # ---------- Find (game_id, player_id) duplicates ----------
    # Do NOT include team_id in the GROUP BY. See the pitching version for why.
    cur.execute(
        f"""
        SELECT gb.game_id,
               gb.player_id,
               g.season,
               g.home_team_id,
               g.away_team_id,
               COUNT(*) AS cnt,
               array_agg(gb.id          ORDER BY gb.id) AS row_ids,
               array_agg(gb.team_id     ORDER BY gb.id) AS row_team_ids,
               array_agg(gb.player_name ORDER BY gb.id) AS names
        FROM game_batting gb
        JOIN games g ON gb.game_id = g.id
        WHERE gb.player_id IS NOT NULL
          {season_sql}
        GROUP BY gb.game_id, gb.player_id, g.season, g.home_team_id, g.away_team_id
        HAVING COUNT(*) > 1
        ORDER BY g.season DESC, gb.game_id
        """,
        season_params,
    )
    dup_groups = cur.fetchall()

    if not dup_groups:
        logger.info("No duplicate (game_id, player_id) groups found. Nothing to do.")
        conn.close()
        return

    logger.info("Found %s duplicate (game_id, player_id) groups.", len(dup_groups))

    # ---------- Pick survivor + losers for each group ----------
    loser_ids = []
    survivor_team_by_group = []
    for g in dup_groups:
        row_ids = list(g["row_ids"])
        row_team_ids = list(g["row_team_ids"])
        legit_teams = {g["home_team_id"], g["away_team_id"]}

        preferred = [(rid, tid) for rid, tid in zip(row_ids, row_team_ids)
                     if tid in legit_teams]
        if preferred:
            survivor_rid, survivor_tid = max(preferred, key=lambda x: x[0])
        else:
            idx = row_ids.index(max(row_ids))
            survivor_rid, survivor_tid = row_ids[idx], row_team_ids[idx]

        for rid in row_ids:
            if rid != survivor_rid:
                loser_ids.append(rid)

        survivor_team_by_group.append((g["season"], survivor_tid, len(row_ids) - 1))

    # ---------- Breakdown by team (for reporting) ----------
    by_team_season = {}
    for season, tid, loser_count in survivor_team_by_group:
        key = (season, tid)
        by_team_season[key] = by_team_season.get(key, 0) + loser_count

    team_ids = sorted({k[1] for k in by_team_season.keys() if k[1] is not None})
    team_names = {}
    if team_ids:
        cur.execute(
            "SELECT id, short_name FROM teams WHERE id = ANY(%s)",
            (team_ids,),
        )
        team_names = {r["id"]: r["short_name"] for r in cur.fetchall()}

    logger.info("Duplicate rows to remove, grouped by (season, survivor team):")
    def _sort_key(item):
        (s, tid), cnt = item
        return (-cnt, s if s is not None else 0, tid if tid is not None else -1)
    for (s, tid), cnt in sorted(by_team_season.items(), key=_sort_key):
        name = team_names.get(tid, f"(team_id={tid})") if tid is not None else "(team_id=NULL)"
        logger.info("  %s  %-28s  %s rows", s, name, cnt)

    logger.info("Total rows that will be DELETED: %s", len(loser_ids))
    logger.info("Total surviving groups: %s", len(dup_groups))

    logger.info("Sample of duplicate groups (first 5):")
    for g in dup_groups[:5]:
        logger.info(
            "  game_id=%s  player_id=%s  home=%s away=%s  row_ids=%s  team_ids=%s  names=%s",
            g["game_id"], g["player_id"], g["home_team_id"], g["away_team_id"],
            g["row_ids"], g["row_team_ids"], g["names"],
        )

    # ---------- DELETE ----------
    if not loser_ids:
        logger.info("Nothing to delete.")
        conn.close()
        return

    BATCH = 1000
    deleted = 0
    for i in range(0, len(loser_ids), BATCH):
        chunk = loser_ids[i:i + BATCH]
        cur.execute("DELETE FROM game_batting WHERE id = ANY(%s)", (chunk,))
        deleted += cur.rowcount

    if dry_run:
        conn.rollback()
        logger.info("[DRY RUN] would have DELETED %s rows. ROLLED BACK.", deleted)
    else:
        conn.commit()
        logger.info("COMMITTED. DELETED %s rows from game_batting.", deleted)

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

    dedup_game_batting(season=args.season, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
