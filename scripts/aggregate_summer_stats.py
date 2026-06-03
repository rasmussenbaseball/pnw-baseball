#!/usr/bin/env python3
"""
Aggregate summer_game_batting/pitching into summer_batting_stats/pitching_stats.

Rolls per-game rows up into per-season totals so /summer/leaderboards
returns data even before Pointstreak's season-aggregate page reflects
the latest games. Idempotent — uses ON CONFLICT (player_id, team_id,
season) DO UPDATE.

Only rolls up rows whose player_id has been resolved (the name->id
resolver runs separately). Unresolved player_name rows are ignored
to avoid creating duplicate season lines.

Usage:
    PYTHONPATH=backend python3 scripts/aggregate_summer_stats.py
    PYTHONPATH=backend python3 scripts/aggregate_summer_stats.py --season 2026 --league WCL
"""

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.models.database import get_connection


logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("aggregate_summer_stats")


def _league_id(cur, abbr):
    cur.execute("SELECT id FROM summer_leagues WHERE abbreviation = %s", (abbr,))
    row = cur.fetchone()
    if not row:
        raise RuntimeError(f"summer_leagues row for '{abbr}' missing")
    return row["id"]


def rollup_batting(cur, league_id, season):
    """Sum game batting → season batting. Computes rate stats."""
    cur.execute(
        """
        WITH game_sums AS (
            SELECT
                b.player_id,
                b.team_id,
                COUNT(*)::int            AS games,
                SUM(b.ab)::int           AS ab,
                SUM(b.r)::int            AS r,
                SUM(b.h)::int            AS h,
                SUM(b."2b")::int         AS doubles,
                SUM(b."3b")::int         AS triples,
                SUM(b.hr)::int           AS hr,
                SUM(b.rbi)::int          AS rbi,
                SUM(b.bb)::int           AS bb,
                SUM(b.so)::int           AS so,
                SUM(b.sb)::int           AS sb,
                SUM(b.cs)::int           AS cs,
                SUM(b.sf)::int           AS sf,
                SUM(b.sh)::int           AS sh,
                SUM(b.hbp)::int          AS hbp
            FROM summer_game_batting b
            JOIN summer_games g ON g.id = b.game_id
            WHERE g.league_id = %s AND g.season = %s AND g.status = 'final'
              AND b.player_id IS NOT NULL AND b.team_id IS NOT NULL
            GROUP BY b.player_id, b.team_id
        )
        INSERT INTO summer_batting_stats (
            player_id, team_id, season,
            games, plate_appearances, at_bats, runs, hits,
            doubles, triples, home_runs, rbi, walks, strikeouts,
            hit_by_pitch, sacrifice_flies, sacrifice_bunts,
            stolen_bases, caught_stealing,
            batting_avg, on_base_pct, slugging_pct, ops, iso
        )
        SELECT
            player_id, team_id, %s AS season,
            games,
            (ab + bb + hbp + sf + sh) AS plate_appearances,
            ab, r, h, doubles, triples, hr, rbi, bb, so,
            hbp, sf, sh, sb, cs,
            CASE WHEN ab > 0 THEN h::real / ab ELSE 0 END               AS batting_avg,
            CASE WHEN (ab + bb + hbp + sf) > 0
                 THEN (h + bb + hbp)::real / (ab + bb + hbp + sf)
                 ELSE 0 END                                              AS on_base_pct,
            CASE WHEN ab > 0
                 THEN (h + doubles + 2*triples + 3*hr)::real / ab
                 ELSE 0 END                                              AS slugging_pct,
            CASE WHEN ab > 0
                 THEN
                   (CASE WHEN (ab + bb + hbp + sf) > 0
                         THEN (h + bb + hbp)::real / (ab + bb + hbp + sf)
                         ELSE 0 END) +
                   ((h + doubles + 2*triples + 3*hr)::real / ab)
                 ELSE 0 END                                              AS ops,
            CASE WHEN ab > 0
                 THEN ((h + doubles + 2*triples + 3*hr)::real - h) / ab
                 ELSE 0 END                                              AS iso
        FROM game_sums
        ON CONFLICT (player_id, team_id, season) DO UPDATE SET
            games = EXCLUDED.games,
            plate_appearances = EXCLUDED.plate_appearances,
            at_bats = EXCLUDED.at_bats,
            runs = EXCLUDED.runs,
            hits = EXCLUDED.hits,
            doubles = EXCLUDED.doubles,
            triples = EXCLUDED.triples,
            home_runs = EXCLUDED.home_runs,
            rbi = EXCLUDED.rbi,
            walks = EXCLUDED.walks,
            strikeouts = EXCLUDED.strikeouts,
            hit_by_pitch = EXCLUDED.hit_by_pitch,
            sacrifice_flies = EXCLUDED.sacrifice_flies,
            sacrifice_bunts = EXCLUDED.sacrifice_bunts,
            stolen_bases = EXCLUDED.stolen_bases,
            caught_stealing = EXCLUDED.caught_stealing,
            batting_avg = EXCLUDED.batting_avg,
            on_base_pct = EXCLUDED.on_base_pct,
            slugging_pct = EXCLUDED.slugging_pct,
            ops = EXCLUDED.ops,
            iso = EXCLUDED.iso,
            updated_at = CURRENT_TIMESTAMP
        """,
        (league_id, season, season),
    )
    return cur.rowcount


def rollup_pitching(cur, league_id, season):
    """Sum game pitching → season pitching. ip is decimal; we convert
    to outs internally for accurate aggregation."""
    cur.execute(
        """
        WITH game_sums AS (
            SELECT
                p.player_id,
                p.team_id,
                COUNT(*)::int        AS games,
                SUM(CASE WHEN p.is_starter THEN 1 ELSE 0 END)::int AS games_started,
                -- Convert 6.2 IP → 20 outs, sum outs, convert back
                SUM(
                    FLOOR(p.ip)::int * 3
                    + ROUND(((p.ip - FLOOR(p.ip)) * 10)::numeric)::int
                )::int                                AS outs,
                SUM(p.h)::int        AS hits,
                SUM(p.r)::int        AS runs,
                SUM(p.er)::int       AS er,
                SUM(p.bb)::int       AS bb,
                SUM(p.so)::int       AS so,
                SUM(p.hr)::int       AS hr,
                SUM(p.bf)::int       AS bf,
                SUM(p.wp)::int       AS wp,
                SUM(p.hbp)::int      AS hbp,
                SUM(CASE WHEN upper(p.decision) = 'W' THEN 1 ELSE 0 END)::int AS wins,
                SUM(CASE WHEN upper(p.decision) = 'L' THEN 1 ELSE 0 END)::int AS losses,
                -- The box-score parser stores a save as 'S' (Presto) — older
                -- Pointstreak data used 'SV'. Accept both so saves roll up.
                SUM(CASE WHEN upper(p.decision) IN ('S', 'SV') THEN 1 ELSE 0 END)::int AS saves
            FROM summer_game_pitching p
            JOIN summer_games g ON g.id = p.game_id
            WHERE g.league_id = %s AND g.season = %s AND g.status = 'final'
              AND p.player_id IS NOT NULL AND p.team_id IS NOT NULL
            GROUP BY p.player_id, p.team_id
        )
        INSERT INTO summer_pitching_stats (
            player_id, team_id, season,
            games, games_started, wins, losses, saves,
            innings_pitched, hits_allowed, runs_allowed, earned_runs,
            walks, strikeouts, home_runs_allowed, hit_batters, wild_pitches,
            batters_faced,
            era, whip, k_per_9, bb_per_9, h_per_9, hr_per_9, k_bb_ratio,
            k_pct, bb_pct
        )
        SELECT
            player_id, team_id, %s AS season,
            games, games_started, wins, losses, saves,
            -- outs back to baseball notation: 20 outs → 6.2 IP
            (outs / 3) + ((outs %% 3) * 0.1)                          AS innings_pitched,
            hits, runs, er, bb, so, hr, hbp, wp,
            bf,
            CASE WHEN outs > 0 THEN er * 27.0 / outs ELSE NULL END     AS era,
            CASE WHEN outs > 0 THEN (bb + hits) * 3.0 / outs ELSE NULL END AS whip,
            CASE WHEN outs > 0 THEN so * 27.0 / outs ELSE NULL END     AS k_per_9,
            CASE WHEN outs > 0 THEN bb * 27.0 / outs ELSE NULL END     AS bb_per_9,
            CASE WHEN outs > 0 THEN hits * 27.0 / outs ELSE NULL END   AS h_per_9,
            CASE WHEN outs > 0 THEN hr * 27.0 / outs ELSE NULL END     AS hr_per_9,
            CASE WHEN bb > 0 THEN so::real / bb ELSE NULL END          AS k_bb_ratio,
            CASE WHEN bf > 0 THEN so::real / bf ELSE NULL END          AS k_pct,
            CASE WHEN bf > 0 THEN bb::real / bf ELSE NULL END          AS bb_pct
        FROM game_sums
        ON CONFLICT (player_id, team_id, season) DO UPDATE SET
            games = EXCLUDED.games,
            games_started = EXCLUDED.games_started,
            wins = EXCLUDED.wins,
            losses = EXCLUDED.losses,
            saves = EXCLUDED.saves,
            innings_pitched = EXCLUDED.innings_pitched,
            hits_allowed = EXCLUDED.hits_allowed,
            runs_allowed = EXCLUDED.runs_allowed,
            earned_runs = EXCLUDED.earned_runs,
            walks = EXCLUDED.walks,
            strikeouts = EXCLUDED.strikeouts,
            home_runs_allowed = EXCLUDED.home_runs_allowed,
            hit_batters = EXCLUDED.hit_batters,
            wild_pitches = EXCLUDED.wild_pitches,
            batters_faced = EXCLUDED.batters_faced,
            era = EXCLUDED.era,
            whip = EXCLUDED.whip,
            k_per_9 = EXCLUDED.k_per_9,
            bb_per_9 = EXCLUDED.bb_per_9,
            h_per_9 = EXCLUDED.h_per_9,
            hr_per_9 = EXCLUDED.hr_per_9,
            k_bb_ratio = EXCLUDED.k_bb_ratio,
            k_pct = EXCLUDED.k_pct,
            bb_pct = EXCLUDED.bb_pct,
            updated_at = CURRENT_TIMESTAMP
        """,
        (league_id, season, season),
    )
    return cur.rowcount


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", default="WCL")
    parser.add_argument("--season", type=int, default=2026)
    args = parser.parse_args()
    with get_connection() as conn:
        cur = conn.cursor()
        league_id = _league_id(cur, args.league)
        bat = rollup_batting(cur, league_id, args.season)
        pit = rollup_pitching(cur, league_id, args.season)
        conn.commit()
    logger.info(f"Rolled up batting={bat}, pitching={pit} ({args.league} {args.season})")


if __name__ == "__main__":
    main()
