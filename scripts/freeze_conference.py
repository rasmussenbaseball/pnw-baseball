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

6. Captures the current /playoff-projections output for this conference
   into projection_snapshots, keyed by conf_key. The projections endpoint
   will replace this conference's section of its response with the
   snapshot when serving, so Monte Carlo never re-runs for frozen
   conferences.

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
import json
import logging
from datetime import date, datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

import psycopg2.extras
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


# Maps conf_key to the conference_abbrev value used inside the
# /playoff-projections response. Used to extract the matching section of
# the response at snapshot time.
CONF_KEY_TO_RESPONSE_ABBREV = {
    "gnac": "GNAC",
    "nwc": "NWC",
    "ccc": "CCC",
    "nwac-north": "NWAC-N",
    "nwac-east": "NWAC-E",
    "nwac-south": "NWAC-S",
    "nwac-west": "NWAC-W",
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


def _fixup_frozen_conference_section(cur, season, conf_section, bracket_section):
    """For a conference whose regular season has ended, replace each team's
    projected_X stats with their actual current totals (no Monte Carlo drift)
    and re-sort using the head-to-head tiebreaker. Also re-order the bracket
    to match.

    Mutates `conf_section` and `bracket_section` in place.
    """
    from app.stats.tiebreakers import apply_head_to_head
    from app.models.database import get_connection

    teams = conf_section.get("teams") or []
    if not teams:
        return

    team_ids = [t["team_id"] for t in teams]
    cur.execute(
        """
        SELECT team_id, wins, losses, conference_wins, conference_losses
        FROM team_season_stats
        WHERE season = %s AND team_id = ANY(%s)
        """,
        (season, team_ids),
    )
    actuals = {r["team_id"]: dict(r) for r in cur.fetchall()}

    for t in teams:
        a = actuals.get(t["team_id"])
        if not a:
            continue
        t["projected_wins"] = a["wins"]
        t["projected_losses"] = a["losses"]
        t["projected_conf_wins"] = a["conference_wins"]
        t["projected_conf_losses"] = a["conference_losses"]
        wt = (a["wins"] or 0) + (a["losses"] or 0)
        ct = (a["conference_wins"] or 0) + (a["conference_losses"] or 0)
        t["projected_win_pct"] = round(a["wins"] / wt, 3) if wt > 0 else 0.0
        t["projected_conf_win_pct"] = round(a["conference_wins"] / ct, 3) if ct > 0 else 0.0

    # Re-sort with H2H tiebreaker. apply_head_to_head expects keys named
    # `id`, `conf_win_pct`, `win_pct`, `wins`. We adapt by aliasing.
    proxies = []
    for t in teams:
        proxies.append({
            **t,
            "id": t["team_id"],
            "conf_win_pct": t.get("projected_conf_win_pct", 0),
            "win_pct": t.get("projected_win_pct", 0),
            "wins": t.get("projected_wins", 0),
        })
    proxies.sort(key=lambda x: x["conf_win_pct"], reverse=True)
    proxies = apply_head_to_head(
        proxies, get_connection, season,
        primary_key="conf_win_pct",
    )
    # Rebuild conf_section["teams"] keyed by team_id, in the new sorted order.
    # We preserve the original team dicts (with their full Monte Carlo odds,
    # seed_probabilities, etc.) and just reshuffle the list.
    by_pid = {t["team_id"]: t for t in teams}
    conf_section["teams"] = [by_pid[p["team_id"]] for p in proxies]

    # Re-order the bracket section the same way (bracket teams have a
    # `team_id` field too). Preserve seed metadata if present.
    if bracket_section and bracket_section.get("teams"):
        b_by_pid = {t["team_id"]: t for t in bracket_section["teams"]}
        # Bracket only includes teams that made the cut; preserve membership
        # but reseed in the new order.
        new_bracket_teams = []
        seed = 1
        for p in proxies:
            if p["team_id"] in b_by_pid:
                bt = dict(b_by_pid[p["team_id"]])
                bt["seed"] = seed
                seed += 1
                new_bracket_teams.append(bt)
        bracket_section["teams"] = new_bracket_teams

    logger.info("  fixup applied: actuals overrode projections, H2H tiebreaker re-sorted")


def snapshot_playoff_projection(cur, conf_key, season, dry_run):
    """Capture the /playoff-projections output for this conference and store it.

    Runs the live projection, then extracts:
      - The `conferences[N]` entry whose abbrev matches this conf_key
        (projected standings + Monte Carlo odds for every team)
      - The `playoffs[M]` bracket whose abbrev matches (the seeded
        tournament entries). For NWAC divisions, the cross-conference
        bracket does not match a single division abbrev, so no bracket
        section is captured -- that case gets handled separately once all
        four NWAC divisions are frozen.

    Stored as a JSONB blob in projection_snapshots. The endpoint will pull
    this row and swap it into the live response for this conference.
    """
    response_abbrev = CONF_KEY_TO_RESPONSE_ABBREV.get(conf_key)
    if not response_abbrev:
        logger.warning("No response abbrev mapping for %s; skipping projection snapshot.", conf_key)
        return None

    # Import here so the freeze script only imports the full routes module
    # when it actually needs the projection output. Keeps the --dry-run
    # path cheap (this helper is skipped entirely in dry-run).
    from app.api.routes import playoff_projections

    logger.info("Running live playoff projection to capture snapshot...")
    full_response = playoff_projections(season=season)

    conf_section = None
    for c in full_response.get("conferences", []):
        if c.get("conference_abbrev") == response_abbrev:
            conf_section = c
            break

    bracket_section = None
    for b in full_response.get("playoffs", []):
        if b.get("conference_abbrev") == response_abbrev:
            bracket_section = b
            break

    if conf_section is None:
        logger.warning(
            "No matching conference section found in projection response "
            "(looked for abbrev=%s). Snapshot will be empty.",
            response_abbrev,
        )

    # ── Post-process: regular season is OVER by definition. Override
    # projected stats with the team's actual current record so a phantom
    # +0.4 wins from never-to-be-played scheduled games doesn't drift
    # standings. Then re-sort with the head-to-head tiebreaker (the
    # projection's native sort skips H2H, so two teams with identical
    # actual records can come out in the wrong order).
    if conf_section:
        _fixup_frozen_conference_section(cur, season, conf_section, bracket_section)

    snapshot = {
        "conf_key": conf_key,
        "response_abbrev": response_abbrev,
        "conference_section": conf_section,
        "bracket_section": bracket_section,
        "schedule_last_updated": full_response.get("schedule_last_updated"),
    }

    logger.info("  conference entry captured: %s", conf_section is not None)
    logger.info("  bracket entry captured:    %s", bracket_section is not None)

    if dry_run:
        return snapshot

    cur.execute(
        """
        INSERT INTO projection_snapshots (conf_key, season, snapshot_json, snapshotted_at)
        VALUES (%s, %s, %s, NOW())
        ON CONFLICT (conf_key, season) DO UPDATE
          SET snapshot_json = EXCLUDED.snapshot_json,
              snapshotted_at = NOW()
        """,
        (conf_key, season, psycopg2.extras.Json(snapshot)),
    )
    return snapshot


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
            # Commit the freeze metadata + snapshot tables now so the
            # projection snapshot (run next) sees the frozen state via
            # the downstream endpoints.
            conn.commit()
            logger.info("Freeze recorded in conference_freezes.")

            logger.info("Capturing playoff projection snapshot...")
            snapshot_playoff_projection(cur, conf_key, season, dry_run=False)
            conn.commit()
            logger.info("Projection snapshot stored.")

            logger.info("DONE.")
        else:
            conn.rollback()
            logger.info("DRY RUN: no changes written.")
            # Still preview the projection snapshot extraction so the
            # operator can see what would be captured.
            logger.info("Previewing projection snapshot extraction (dry run)...")
            snapshot_playoff_projection(cur, conf_key, season, dry_run=True)


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
