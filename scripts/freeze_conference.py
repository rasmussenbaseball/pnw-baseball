#!/usr/bin/env python3
"""
Step 2 of the playoff-freeze feature: freeze a single conference.

Given a conference key and the date of the final regular-season game, this
script locks in the "as of regular season end" state of that conference for
downstream features (All-Conference, Standings, Playoff Projections, etc.).

What it does, in order:

1. Resolves the conference key to a list of team_ids (using the same
   conference name/abbreviation matching that /all-conference uses).

2. If an existing freeze exists for this conf_key, refuses to proceed
   unless --force is supplied. With --force, wipes the previous frozen
   rows for this conf_key before re-inserting.

3. Snapshots current batting_stats, pitching_stats, and team_season_stats
   rows for those teams into the *_frozen tables, stamping each row with
   the conf_key so per-conference refreshes stay isolated.

4. Marks games played after the regular_season_end_date involving any of
   those teams as is_postseason = TRUE. This flag is what downstream game
   queries will filter on if they want to exclude postseason games.

5. Inserts (or updates on conflict) the row in conference_freezes. This
   row is the signal to the rest of the app that "this conference is
   frozen, use the snapshot."

The script is safe to run in --dry-run mode first to preview the effect.

Usage:
    PYTHONPATH=backend python3 scripts/freeze_conference.py \\
        --conf ccc --end-date 2026-04-26

    PYTHONPATH=backend python3 scripts/freeze_conference.py \\
        --conf ccc --end-date 2026-04-26 --dry-run

    PYTHONPATH=backend python3 scripts/freeze_conference.py \\
        --conf ccc --end-date 2026-04-26 --force

Supported conf keys:
    gnac, nwc, ccc,
    nwac-north, nwac-east, nwac-south, nwac-west,
    all-nwac, all-pnw
"""

import sys
import os
import argparse
import logging
from datetime import date, datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("freeze_conference")


# Mirror of ALL_CONF_GROUPS in backend/app/api/routes.py. If you add a new
# grouping there, add it here too (or factor into a shared module later).
CONF_GROUPS = {
    "gnac": {
        "label": "GNAC (D2)",
        "conf_names": ["Great Northwest Athletic Conference", "GNAC"],
        "conf_abbrevs": ["GNAC"],
    },
    "nwc": {
        "label": "NWC (D3)",
        "conf_names": ["Northwest Conference", "NWC"],
        "conf_abbrevs": ["NWC"],
    },
    "ccc": {
        "label": "CCC (NAIA)",
        "conf_names": ["Cascade Collegiate Conference", "CCC"],
        "conf_abbrevs": ["CCC"],
    },
    "nwac-north": {
        "label": "NWAC North",
        "conf_names": ["NWAC North Division", "NWAC North"],
        "conf_abbrevs": ["NWAC-N"],
    },
    "nwac-east": {
        "label": "NWAC East",
        "conf_names": ["NWAC East Division", "NWAC East"],
        "conf_abbrevs": ["NWAC-E"],
    },
    "nwac-south": {
        "label": "NWAC South",
        "conf_names": ["NWAC South Division", "NWAC South"],
        "conf_abbrevs": ["NWAC-S"],
    },
    "nwac-west": {
        "label": "NWAC West",
        "conf_names": ["NWAC West Division", "NWAC West"],
        "conf_abbrevs": ["NWAC-W"],
    },
    "all-nwac": {
        "label": "All-NWAC",
        "conf_names": [
            "NWAC North Division", "NWAC East Division",
            "NWAC South Division", "NWAC West Division",
        ],
        "conf_abbrevs": ["NWAC-N", "NWAC-E", "NWAC-S", "NWAC-W"],
    },
    # all-pnw intentionally omitted: there is no "end of regular season" for
    # a virtual grouping that spans every division, and its All-PNW page
    # derives from the individual conference freezes anyway.
}


def resolve_team_ids(cur, conf_key, season):
    """Return (group_label, [team_id, ...]) for the given conference key."""
    group = CONF_GROUPS.get(conf_key)
    if not group:
        raise ValueError(
            f"Unknown conf key: {conf_key!r}. "
            f"Supported: {sorted(CONF_GROUPS.keys())}"
        )

    cur.execute(
        """
        SELECT t.id, t.name, t.short_name
        FROM teams t
        JOIN conferences c ON c.id = t.conference_id
        WHERE t.is_active = 1
          AND (c.name = ANY(%s) OR c.abbreviation = ANY(%s))
        ORDER BY t.name
        """,
        (group["conf_names"], group["conf_abbrevs"]),
    )
    teams = [dict(r) for r in cur.fetchall()]
    return group["label"], teams


def get_shared_columns(cur, live_table, frozen_table):
    """Return the ordered list of columns to copy from live_table to frozen_table.

    Uses the intersection of the two tables' columns so the script survives
    future schema changes on either side. Excludes conf_key (that's the
    stamp column we append at insert time).
    """
    cur.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = %s ORDER BY ordinal_position",
        (live_table,),
    )
    live_cols = {r["column_name"] for r in cur.fetchall()}

    cur.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = %s ORDER BY ordinal_position",
        (frozen_table,),
    )
    frozen_cols_ordered = [r["column_name"] for r in cur.fetchall()]

    return [c for c in frozen_cols_ordered if c in live_cols and c != "conf_key"]


def existing_freeze(cur, conf_key):
    cur.execute(
        "SELECT conf_key, regular_season_end_date, frozen_at "
        "FROM conference_freezes WHERE conf_key = %s",
        (conf_key,),
    )
    return cur.fetchone()


def snapshot_table(cur, live_table, frozen_table, conf_key, season, team_ids, dry_run):
    """Copy rows from live_table to frozen_table for the given teams/season."""
    cols = get_shared_columns(cur, live_table, frozen_table)
    col_list = ", ".join(cols)

    # Preview count first.
    cur.execute(
        f"SELECT COUNT(*) AS n FROM {live_table} "
        f"WHERE season = %s AND team_id = ANY(%s)",
        (season, team_ids),
    )
    count = cur.fetchone()["n"]
    logger.info("  %s: %d rows will be snapshotted", live_table, count)

    if dry_run:
        return count

    cur.execute(
        f"INSERT INTO {frozen_table} ({col_list}, conf_key) "
        f"SELECT {col_list}, %s "
        f"FROM {live_table} "
        f"WHERE season = %s AND team_id = ANY(%s)",
        (conf_key, season, team_ids),
    )
    return count


def mark_postseason_games(cur, team_ids, end_date, dry_run):
    """Flag games after end_date involving any of the given teams as postseason."""
    cur.execute(
        """
        SELECT COUNT(*) AS n
        FROM games
        WHERE game_date > %s
          AND (home_team_id = ANY(%s) OR away_team_id = ANY(%s))
          AND (is_postseason IS NULL OR is_postseason = FALSE)
        """,
        (end_date, team_ids, team_ids),
    )
    count = cur.fetchone()["n"]
    logger.info("  games to flag as postseason: %d", count)

    if dry_run:
        return count

    cur.execute(
        """
        UPDATE games
        SET is_postseason = TRUE
        WHERE game_date > %s
          AND (home_team_id = ANY(%s) OR away_team_id = ANY(%s))
        """,
        (end_date, team_ids, team_ids),
    )
    return count


def run(conf_key, end_date, season, force, dry_run):
    with get_connection() as conn:
        cur = conn.cursor()

        label, teams = resolve_team_ids(cur, conf_key, season)
        if not teams:
            raise SystemExit(f"No active teams found for {conf_key!r}.")
        team_ids = [t["id"] for t in teams]

        logger.info("=" * 60)
        logger.info("Freeze target: %s  (conf_key=%s)", label, conf_key)
        logger.info("Season:        %d", season)
        logger.info("End date:      %s", end_date)
        logger.info("Teams (%d):", len(teams))
        for t in teams:
            logger.info("  %d  %s", t["id"], t["short_name"] or t["name"])
        logger.info("=" * 60)

        existing = existing_freeze(cur, conf_key)
        if existing and not force:
            raise SystemExit(
                f"{conf_key!r} is already frozen "
                f"(end_date={existing['regular_season_end_date']}, "
                f"frozen_at={existing['frozen_at']}). "
                f"Re-run with --force to overwrite."
            )

        if existing and force and not dry_run:
            logger.info("--force supplied: wiping previous freeze for %s", conf_key)
            cur.execute("DELETE FROM batting_stats_frozen WHERE conf_key = %s", (conf_key,))
            cur.execute("DELETE FROM pitching_stats_frozen WHERE conf_key = %s", (conf_key,))
            cur.execute("DELETE FROM team_season_stats_frozen WHERE conf_key = %s", (conf_key,))

        logger.info("Snapshotting player and team aggregates...")
        snapshot_table(cur, "batting_stats", "batting_stats_frozen",
                       conf_key, season, team_ids, dry_run)
        snapshot_table(cur, "pitching_stats", "pitching_stats_frozen",
                       conf_key, season, team_ids, dry_run)
        snapshot_table(cur, "team_season_stats", "team_season_stats_frozen",
                       conf_key, season, team_ids, dry_run)

        logger.info("Flagging postseason games...")
        mark_postseason_games(cur, team_ids, end_date, dry_run)

        if not dry_run:
            cur.execute(
                """
                INSERT INTO conference_freezes (conf_key, regular_season_end_date, frozen_at)
                VALUES (%s, %s, NOW())
                ON CONFLICT (conf_key) DO UPDATE
                  SET regular_season_end_date = EXCLUDED.regular_season_end_date,
                      frozen_at = NOW()
                """,
                (conf_key, end_date),
            )
            conn.commit()
            logger.info("Freeze recorded in conference_freezes.")
            logger.info("DONE.")
        else:
            conn.rollback()
            logger.info("DRY RUN: no changes written.")


def parse_args():
    ap = argparse.ArgumentParser(description="Freeze a single conference's regular-season state.")
    ap.add_argument("--conf", required=True,
                    help="Conference key (e.g. ccc, gnac, nwc, nwac-north, all-nwac)")
    ap.add_argument("--end-date", required=True,
                    help="Final regular-season date, YYYY-MM-DD. Games AFTER this date "
                         "involving these teams will be flagged as postseason.")
    ap.add_argument("--season", type=int, default=2026,
                    help="Season year (default: 2026)")
    ap.add_argument("--force", action="store_true",
                    help="Overwrite an existing freeze for this conference.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Report what would happen without writing anything.")
    return ap.parse_args()


if __name__ == "__main__":
    args = parse_args()
    try:
        end = datetime.strptime(args.end_date, "%Y-%m-%d").date()
    except ValueError:
        raise SystemExit("end-date must be YYYY-MM-DD")
    run(args.conf, end, args.season, args.force, args.dry_run)
