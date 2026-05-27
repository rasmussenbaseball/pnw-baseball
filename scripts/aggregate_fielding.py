#!/usr/bin/env python3
"""Roll game_fielding rows up into per-season per-position fielding_stats.

For each (player_id, team_id, season, position) combination we sum the
counting stats and derive fielding_pct, range_factor (when innings are
available), and cs_pct (catcher only).

Idempotent — UPSERT on the unique key, so re-running is safe.

Run on the server after a box-score scrape:

    cd /opt/pnw-baseball
    PYTHONPATH=backend python3 scripts/aggregate_fielding.py --season 2026

Or for all seasons present in game_fielding:

    PYTHONPATH=backend python3 scripts/aggregate_fielding.py --all
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.models.database import get_connection  # noqa: E402


AGGREGATE_SQL = """
WITH agg AS (
    SELECT
        gf.player_id,
        gf.team_id,
        g.season,
        gf.position,
        COUNT(*) AS games,
        COALESCE(SUM(gf.games_started), 0) AS games_started,
        -- SUM(innings) returns NULL only if every row's innings is
        -- NULL, which matches the "not available" semantic we want
        -- in fielding_stats.innings.
        SUM(gf.innings) AS innings,
        COALESCE(SUM(gf.putouts), 0) AS putouts,
        COALESCE(SUM(gf.assists), 0) AS assists,
        COALESCE(SUM(gf.errors), 0) AS errors,
        COALESCE(SUM(gf.double_plays), 0) AS double_plays,
        COALESCE(SUM(gf.triple_plays), 0) AS triple_plays,
        COALESCE(SUM(gf.passed_balls), 0) AS passed_balls,
        COALESCE(SUM(gf.stolen_bases_against), 0) AS stolen_bases_against,
        COALESCE(SUM(gf.caught_stealing_by), 0) AS caught_stealing_by,
        COALESCE(SUM(gf.pickoffs), 0) AS pickoffs,
        COALESCE(SUM(gf.catchers_interference), 0) AS catchers_interference
    FROM game_fielding gf
    JOIN games g ON g.id = gf.game_id
    WHERE g.season = %s OR %s IS NULL
    GROUP BY gf.player_id, gf.team_id, g.season, gf.position
)
INSERT INTO fielding_stats (
    player_id, team_id, season, position,
    games, games_started, innings,
    putouts, assists, errors,
    double_plays, triple_plays,
    passed_balls, stolen_bases_against, caught_stealing_by,
    pickoffs, catchers_interference,
    fielding_pct, range_factor, cs_pct
)
SELECT
    player_id, team_id, season, position,
    games, games_started, innings,
    putouts, assists, errors,
    double_plays, triple_plays,
    passed_balls, stolen_bases_against, caught_stealing_by,
    pickoffs, catchers_interference,
    -- fielding_pct: nullable when no chances (e.g. a CF with PO=0,
    -- A=0, E=0 over the sample). Stored as 4-decimal NUMERIC.
    CASE WHEN (putouts + assists + errors) > 0
        THEN ROUND((putouts + assists)::numeric
                   / (putouts + assists + errors), 4)
    END AS fielding_pct,
    -- range_factor only meaningful when we have innings.
    -- RF/9 = (PO + A) / innings * 9.
    CASE WHEN innings IS NOT NULL AND innings > 0
        THEN ROUND((putouts + assists)::numeric / innings * 9, 2)
    END AS range_factor,
    -- cs_pct only meaningful for catchers; will be NULL when CS+SBA=0.
    CASE WHEN (stolen_bases_against + caught_stealing_by) > 0
        THEN ROUND(caught_stealing_by::numeric
                   / (stolen_bases_against + caught_stealing_by), 4)
    END AS cs_pct
FROM agg
ON CONFLICT (player_id, season, position, team_id) DO UPDATE SET
    games = EXCLUDED.games,
    games_started = EXCLUDED.games_started,
    innings = EXCLUDED.innings,
    putouts = EXCLUDED.putouts,
    assists = EXCLUDED.assists,
    errors = EXCLUDED.errors,
    double_plays = EXCLUDED.double_plays,
    triple_plays = EXCLUDED.triple_plays,
    passed_balls = EXCLUDED.passed_balls,
    stolen_bases_against = EXCLUDED.stolen_bases_against,
    caught_stealing_by = EXCLUDED.caught_stealing_by,
    pickoffs = EXCLUDED.pickoffs,
    catchers_interference = EXCLUDED.catchers_interference,
    fielding_pct = EXCLUDED.fielding_pct,
    range_factor = EXCLUDED.range_factor,
    cs_pct = EXCLUDED.cs_pct,
    updated_at = now()
"""


# Prune fielding_stats rows that have no corresponding game_fielding
# evidence anymore. Happens when a player's game gets re-scraped under
# a different position and the old row becomes stale.
PRUNE_SQL = """
DELETE FROM fielding_stats fs
WHERE fs.season = %s
  -- Position 'ALL' rows are populated by scrape_season_fielding.py
  -- directly from team/conference season pages; they intentionally
  -- have no game_fielding backing, so the prune must skip them.
  AND fs.position != 'ALL'
  AND NOT EXISTS (
    SELECT 1
    FROM game_fielding gf
    JOIN games g ON g.id = gf.game_id
    WHERE gf.player_id = fs.player_id
      AND gf.team_id = fs.team_id
      AND gf.position = fs.position
      AND g.season = fs.season
  )
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, help="Season year")
    ap.add_argument("--all", action="store_true", help="Aggregate every season in game_fielding")
    args = ap.parse_args()

    if not args.season and not args.all:
        ap.error("Provide --season YEAR or --all")

    season_param = None if args.all else args.season

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(AGGREGATE_SQL, (season_param, season_param))
        affected = cur.rowcount
        if season_param is not None:
            cur.execute(PRUNE_SQL, (season_param,))
            pruned = cur.rowcount
        else:
            pruned = 0
        conn.commit()

    target = f"season {args.season}" if args.season else "all seasons"
    print(f"Aggregated {affected} rows into fielding_stats for {target}.")
    if pruned:
        print(f"Pruned {pruned} stale rows.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
