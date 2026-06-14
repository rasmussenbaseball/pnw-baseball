"""
FastAPI routes for PNW College Baseball Analytics API.

Provides endpoints for:
- Teams, conferences, divisions browsing
- Batting/pitching leaderboards with filters
- Player profiles and search
- Advanced stats and WAR leaderboards
- Data administration (scrape triggers, recalculations)
"""

import json
import math
import os
import re
import threading
from bisect import bisect_left, bisect_right
from datetime import datetime, date, timedelta

from fastapi import APIRouter, Depends, Query, HTTPException, Body
from fastapi.responses import JSONResponse, FileResponse
from psycopg2.extras import Json
from typing import Optional
from ..models.database import get_connection
from ..cache import cached_endpoint
from ..config import CURRENT_SEASON
from .auth import require_admin, require_tier
from .leverage import compute_li
from .lineup_helper import (
    compute_team_lineup_helper,
    compute_manual_lineup,
    compute_build_lineup,
)
from .team_scouting import compute_team_scouting

# Phase E: batted-ball + spray classifier (lives in scripts/ but is
# pure Python — import via path manipulation so the API can use it.)
import sys as _sys
import pathlib as _pathlib
_sys.path.insert(
    0,
    str(_pathlib.Path(__file__).resolve().parents[3] / "scripts"),
)
try:
    from classify_batted_ball import spray_for as _spray_for  # noqa: E402
except ImportError:
    _spray_for = lambda zone, bats: None  # noqa: E731
from ..stats.advanced import (
    BattingLine, PitchingLine,
    compute_batting_advanced, compute_pitching_advanced, compute_college_war,
    normalize_position, DEFAULT_WEIGHTS,
    POSITION_ADJUSTMENTS_FULL,
    compute_fip_constant, innings_to_outs,
)
from ..stats.cpi import compute_cpi_for_division, SEASON_GAMES_BY_LEVEL
from ..stats.tiebreakers import apply_head_to_head
from ..stats.projections import (
    load_future_schedules,
    project_remaining_games,
    run_monte_carlo,
    build_projected_standings,
    determine_playoff_fields,
    elo_win_prob,
    simulate_nwac_championship_odds,
    resolve_known_nwac_results,
    pct_to_american,
    NWAC_2026_CHAMP_SEEDS,
    NWAC_2026_CHAMP_HOST_ID,
    PLAYOFF_FORMATS,
    CONFERENCE_TO_FORMAT,
)

# Year groups: selecting "Fr" also matches "R-Fr", etc.
_YEAR_GROUPS = {
    "Fr": ("Fr", "R-Fr"),
    "So": ("So", "R-So"),
    "Jr": ("Jr", "R-Jr"),
    "Sr": ("Sr", "R-Sr"),
}


# ── Qualification thresholds (per team game played) ──
QUALIFIED_PA_PER_GAME = 2.0      # Batters: 2 PA per team game
QUALIFIED_IP_PER_GAME = 0.75     # Pitchers: 0.75 IP per team game

# SQL fragments for qualified filter - join team_season_stats to get team games
QUALIFIED_BATTING_JOIN = """
    LEFT JOIN team_season_stats tss
      ON tss.team_id = bs.team_id AND tss.season = bs.season
"""
QUALIFIED_BATTING_WHERE = (
    " AND bs.plate_appearances >= {pa_per_game} * (COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0))"
    .format(pa_per_game=QUALIFIED_PA_PER_GAME)
)
QUALIFIED_PITCHING_JOIN = """
    LEFT JOIN team_season_stats tss
      ON tss.team_id = ps.team_id AND tss.season = ps.season
"""
# innings_pitched is stored in baseball notation (5.2 = 5 2/3, not 5.2
# decimal). The qualifier comparison must convert to true innings before
# comparing against the threshold, otherwise a pitcher at 34.2 (= 34 2/3
# true) is incorrectly disqualified by a 34.5-IP threshold even though
# they cleared it. Sam Wilson (Lane 2026) hit this exact case.
PITCHING_TRUE_IP_SQL = (
    "(FLOOR(ps.innings_pitched) + "
    "  CASE "
    "    WHEN ROUND((ps.innings_pitched - FLOOR(ps.innings_pitched))::numeric * 10) = 1 THEN 1.0/3.0 "
    "    WHEN ROUND((ps.innings_pitched - FLOOR(ps.innings_pitched))::numeric * 10) = 2 THEN 2.0/3.0 "
    "    ELSE 0 "
    "  END)"
)
QUALIFIED_PITCHING_WHERE = (
    f" AND {PITCHING_TRUE_IP_SQL} >= {QUALIFIED_IP_PER_GAME} * "
    "(COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0))"
)


# ── Baseball IP helpers ────────────────────────────────────────────────
# Innings pitched are stored in baseball notation: 3.1 means 3⅓ innings
# (10 outs), 3.2 means 3⅔ (11 outs). Summing these as plain decimals
# (3.1 + 3.1 = 6.2) gives nonsense — 10+10 outs is 20 outs = 6⅔ = 6.2,
# but 3.1 + 0.2 = 3.3 mathematically collides with the next whole inning.
# These helpers convert between baseball IP and raw outs so sums and
# ERA math are correct.

def ip_to_outs(ip_val):
    """Convert a baseball-notation IP (e.g. 3.1 = 3⅓) to total outs."""
    if ip_val is None:
        return 0
    try:
        ip = float(ip_val)
    except (TypeError, ValueError):
        return 0
    whole = int(ip)
    frac = round((ip - whole) * 10)
    # Clamp malformed fractions (.3+ rolls over to the next inning).
    if frac >= 3:
        whole += frac // 3
        frac = frac % 3
    return whole * 3 + frac


def outs_to_ip(outs):
    """Convert total outs back to baseball-notation IP (float: 10 -> 3.1)."""
    if outs is None or outs <= 0:
        return 0.0
    whole = outs // 3
    frac = outs % 3
    return float(f"{whole}.{frac}")


def era_from_outs(er, outs):
    """ERA = earned runs × 9 ÷ innings, where innings = outs / 3."""
    if outs <= 0:
        return None
    return round(er * 27 / outs, 2)


# ── Conference-only CTE: aggregate game-level stats for conference games ──

CONF_BATTING_CTE = """
    conf_bat AS (
        SELECT
            gb.player_id,
            gb.team_id,
            g.season,
            COUNT(DISTINCT gb.game_id) as games,
            0 as games_started,
            SUM(COALESCE(gb.at_bats,0)) + SUM(COALESCE(gb.walks,0)) + SUM(COALESCE(gb.hit_by_pitch,0))
                + SUM(COALESCE(gb.sacrifice_flies,0)) + SUM(COALESCE(gb.sacrifice_bunts,0)) as plate_appearances,
            SUM(COALESCE(gb.at_bats,0)) as at_bats,
            SUM(COALESCE(gb.runs,0)) as runs,
            SUM(COALESCE(gb.hits,0)) as hits,
            SUM(COALESCE(gb.doubles,0)) as doubles,
            SUM(COALESCE(gb.triples,0)) as triples,
            SUM(COALESCE(gb.home_runs,0)) as home_runs,
            SUM(COALESCE(gb.rbi,0)) as rbi,
            SUM(COALESCE(gb.walks,0)) as walks,
            SUM(COALESCE(gb.strikeouts,0)) as strikeouts,
            SUM(COALESCE(gb.hit_by_pitch,0)) as hit_by_pitch,
            SUM(COALESCE(gb.sacrifice_flies,0)) as sacrifice_flies,
            SUM(COALESCE(gb.sacrifice_bunts,0)) as sacrifice_bunts,
            SUM(COALESCE(gb.stolen_bases,0)) as stolen_bases,
            SUM(COALESCE(gb.caught_stealing,0)) as caught_stealing,
            0 as grounded_into_dp,
            0 as intentional_walks,
            -- Rate stats
            CASE WHEN SUM(gb.at_bats) > 0
                THEN ROUND(SUM(gb.hits)::numeric / SUM(gb.at_bats), 3) END as batting_avg,
            CASE WHEN (SUM(gb.at_bats) + SUM(COALESCE(gb.walks,0)) + SUM(COALESCE(gb.hit_by_pitch,0)) + SUM(COALESCE(gb.sacrifice_flies,0))) > 0
                THEN ROUND((SUM(gb.hits) + SUM(COALESCE(gb.walks,0)) + SUM(COALESCE(gb.hit_by_pitch,0)))::numeric
                     / (SUM(gb.at_bats) + SUM(COALESCE(gb.walks,0)) + SUM(COALESCE(gb.hit_by_pitch,0)) + SUM(COALESCE(gb.sacrifice_flies,0))), 3) END as on_base_pct,
            CASE WHEN SUM(gb.at_bats) > 0
                THEN ROUND(((SUM(gb.hits) - SUM(COALESCE(gb.doubles,0)) - SUM(COALESCE(gb.triples,0)) - SUM(COALESCE(gb.home_runs,0)))
                     + 2*SUM(COALESCE(gb.doubles,0)) + 3*SUM(COALESCE(gb.triples,0)) + 4*SUM(COALESCE(gb.home_runs,0)))::numeric
                     / SUM(gb.at_bats), 3) END as slugging_pct,
            -- OPS (computed inline since we need OBP + SLG from same row)
            CASE WHEN SUM(gb.at_bats) > 0 AND (SUM(gb.at_bats) + SUM(COALESCE(gb.walks,0)) + SUM(COALESCE(gb.hit_by_pitch,0)) + SUM(COALESCE(gb.sacrifice_flies,0))) > 0
                THEN ROUND(
                    (SUM(gb.hits) + SUM(COALESCE(gb.walks,0)) + SUM(COALESCE(gb.hit_by_pitch,0)))::numeric
                    / (SUM(gb.at_bats) + SUM(COALESCE(gb.walks,0)) + SUM(COALESCE(gb.hit_by_pitch,0)) + SUM(COALESCE(gb.sacrifice_flies,0)))
                    + ((SUM(gb.hits) - SUM(COALESCE(gb.doubles,0)) - SUM(COALESCE(gb.triples,0)) - SUM(COALESCE(gb.home_runs,0))
                       + 2*SUM(COALESCE(gb.doubles,0)) + 3*SUM(COALESCE(gb.triples,0)) + 4*SUM(COALESCE(gb.home_runs,0)))::numeric
                       / SUM(gb.at_bats)), 3) END as ops,
            -- ISO = SLG - AVG
            CASE WHEN SUM(gb.at_bats) > 0
                THEN ROUND(
                    ((SUM(gb.hits) - SUM(COALESCE(gb.doubles,0)) - SUM(COALESCE(gb.triples,0)) - SUM(COALESCE(gb.home_runs,0))
                      + 2*SUM(COALESCE(gb.doubles,0)) + 3*SUM(COALESCE(gb.triples,0)) + 4*SUM(COALESCE(gb.home_runs,0)))::numeric
                     / SUM(gb.at_bats))
                    - (SUM(gb.hits)::numeric / SUM(gb.at_bats)), 3) END as iso,
            -- BABIP = (H - HR) / (AB - K - HR + SF)
            CASE WHEN (SUM(gb.at_bats) - SUM(COALESCE(gb.strikeouts,0)) - SUM(COALESCE(gb.home_runs,0)) + SUM(COALESCE(gb.sacrifice_flies,0))) > 0
                THEN ROUND((SUM(gb.hits) - SUM(COALESCE(gb.home_runs,0)))::numeric
                     / (SUM(gb.at_bats) - SUM(COALESCE(gb.strikeouts,0)) - SUM(COALESCE(gb.home_runs,0)) + SUM(COALESCE(gb.sacrifice_flies,0))), 3) END as babip,
            -- BB pct and K pct
            CASE WHEN (SUM(COALESCE(gb.at_bats,0)) + SUM(COALESCE(gb.walks,0)) + SUM(COALESCE(gb.hit_by_pitch,0)) + SUM(COALESCE(gb.sacrifice_flies,0)) + SUM(COALESCE(gb.sacrifice_bunts,0))) > 0
                THEN ROUND(SUM(COALESCE(gb.walks,0))::numeric * 100
                     / (SUM(COALESCE(gb.at_bats,0)) + SUM(COALESCE(gb.walks,0)) + SUM(COALESCE(gb.hit_by_pitch,0)) + SUM(COALESCE(gb.sacrifice_flies,0)) + SUM(COALESCE(gb.sacrifice_bunts,0))), 1) END as bb_pct,
            CASE WHEN (SUM(COALESCE(gb.at_bats,0)) + SUM(COALESCE(gb.walks,0)) + SUM(COALESCE(gb.hit_by_pitch,0)) + SUM(COALESCE(gb.sacrifice_flies,0)) + SUM(COALESCE(gb.sacrifice_bunts,0))) > 0
                THEN ROUND(SUM(COALESCE(gb.strikeouts,0))::numeric * 100
                     / (SUM(COALESCE(gb.at_bats,0)) + SUM(COALESCE(gb.walks,0)) + SUM(COALESCE(gb.hit_by_pitch,0)) + SUM(COALESCE(gb.sacrifice_flies,0)) + SUM(COALESCE(gb.sacrifice_bunts,0))), 1) END as k_pct,
            -- Advanced stats not available for conference-only splits
            NULL::numeric as woba,
            NULL::numeric as wobacon,
            NULL::numeric as wraa,
            NULL::numeric as wrc,
            NULL::numeric as wrc_plus,
            NULL::numeric as offensive_war
        FROM game_batting gb
        JOIN games g ON gb.game_id = g.id
        WHERE g.season = %s
          AND g.is_conference_game = true
          AND g.status = 'final'
          AND gb.player_id IS NOT NULL
        GROUP BY gb.player_id, gb.team_id, g.season
    )
"""

CONF_PITCHING_CTE = """
    conf_pit AS (
        SELECT
            gp.player_id,
            gp.team_id,
            g.season,
            COUNT(DISTINCT gp.game_id) as games,
            SUM(CASE WHEN gp.is_starter THEN 1 ELSE 0 END) as games_started,
            outs_to_ip(SUM(ip_outs(COALESCE(gp.innings_pitched,0)))) as innings_pitched,
            SUM(COALESCE(gp.hits_allowed,0)) as hits_allowed,
            SUM(COALESCE(gp.runs_allowed,0)) as runs_allowed,
            SUM(COALESCE(gp.earned_runs,0)) as earned_runs,
            SUM(COALESCE(gp.walks,0)) as walks,
            SUM(COALESCE(gp.strikeouts,0)) as strikeouts,
            SUM(COALESCE(gp.home_runs_allowed,0)) as home_runs_allowed,
            SUM(COALESCE(gp.hit_batters,0)) as hit_batters,
            SUM(COALESCE(gp.wild_pitches,0)) as wild_pitches,
            SUM(COALESCE(gp.batters_faced,0)) as batters_faced,
            0 as intentional_walks,
            -- W/L/S from decisions
            SUM(CASE WHEN gp.decision = 'W' THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN gp.decision = 'L' THEN 1 ELSE 0 END) as losses,
            SUM(CASE WHEN gp.decision = 'S' THEN 1 ELSE 0 END) as saves,
            0 as complete_games,
            0 as shutouts,
            SUM(CASE WHEN gp.is_quality_start THEN 1 ELSE 0 END) as quality_starts,
            -- Rate stats
            CASE WHEN SUM(ip_outs(COALESCE(gp.innings_pitched,0))) > 0
                THEN ROUND(9.0 * SUM(COALESCE(gp.earned_runs,0))::numeric / NULLIF(SUM(ip_outs(gp.innings_pitched)) / 3.0, 0)::numeric, 2) END as era,
            CASE WHEN SUM(ip_outs(COALESCE(gp.innings_pitched,0))) > 0
                THEN ROUND((SUM(COALESCE(gp.walks,0)) + SUM(COALESCE(gp.hits_allowed,0)))::numeric / NULLIF(SUM(ip_outs(gp.innings_pitched)) / 3.0, 0)::numeric, 2) END as whip,
            CASE WHEN SUM(ip_outs(COALESCE(gp.innings_pitched,0))) > 0
                THEN ROUND(9.0 * SUM(COALESCE(gp.strikeouts,0))::numeric / NULLIF(SUM(ip_outs(gp.innings_pitched)) / 3.0, 0)::numeric, 1) END as k_per_9,
            CASE WHEN SUM(ip_outs(COALESCE(gp.innings_pitched,0))) > 0
                THEN ROUND(9.0 * SUM(COALESCE(gp.walks,0))::numeric / NULLIF(SUM(ip_outs(gp.innings_pitched)) / 3.0, 0)::numeric, 1) END as bb_per_9,
            CASE WHEN SUM(ip_outs(COALESCE(gp.innings_pitched,0))) > 0
                THEN ROUND(9.0 * SUM(COALESCE(gp.hits_allowed,0))::numeric / NULLIF(SUM(ip_outs(gp.innings_pitched)) / 3.0, 0)::numeric, 1) END as h_per_9,
            CASE WHEN SUM(ip_outs(COALESCE(gp.innings_pitched,0))) > 0
                THEN ROUND(9.0 * SUM(COALESCE(gp.home_runs_allowed,0))::numeric / NULLIF(SUM(ip_outs(gp.innings_pitched)) / 3.0, 0)::numeric, 1) END as hr_per_9,
            CASE WHEN SUM(COALESCE(gp.walks,0)) > 0
                THEN ROUND(SUM(COALESCE(gp.strikeouts,0))::numeric / SUM(gp.walks), 2) END as k_bb_ratio,
            -- K pct and BB pct
            CASE WHEN SUM(COALESCE(gp.batters_faced,0)) > 0
                THEN ROUND(SUM(COALESCE(gp.strikeouts,0))::numeric * 100 / SUM(gp.batters_faced), 1) END as k_pct,
            CASE WHEN SUM(COALESCE(gp.batters_faced,0)) > 0
                THEN ROUND(SUM(COALESCE(gp.walks,0))::numeric * 100 / SUM(gp.batters_faced), 1) END as bb_pct,
            -- BABIP against
            CASE WHEN (SUM(COALESCE(gp.batters_faced,0)) - SUM(COALESCE(gp.strikeouts,0)) - SUM(COALESCE(gp.walks,0))
                       - SUM(COALESCE(gp.hit_batters,0)) - SUM(COALESCE(gp.home_runs_allowed,0))) > 0
                THEN ROUND((SUM(COALESCE(gp.hits_allowed,0)) - SUM(COALESCE(gp.home_runs_allowed,0)))::numeric
                     / (SUM(COALESCE(gp.batters_faced,0)) - SUM(COALESCE(gp.strikeouts,0)) - SUM(COALESCE(gp.walks,0))
                        - SUM(COALESCE(gp.hit_batters,0)) - SUM(COALESCE(gp.home_runs_allowed,0))), 3) END as babip_against,
            -- BAA (batting avg against) = H / (BF - BB - HBP)
            CASE WHEN (SUM(COALESCE(gp.batters_faced,0)) - SUM(COALESCE(gp.walks,0)) - SUM(COALESCE(gp.hit_batters,0))) > 0
                THEN ROUND(SUM(COALESCE(gp.hits_allowed,0))::numeric
                     / (SUM(COALESCE(gp.batters_faced,0)) - SUM(COALESCE(gp.walks,0)) - SUM(COALESCE(gp.hit_batters,0)))::numeric, 3) END as baa,
            -- Advanced stats not available for conference-only splits
            NULL::numeric as fip,
            NULL::numeric as xfip,
            NULL::numeric as siera,
            NULL::numeric as kwera,
            NULL::numeric as lob_pct,
            NULL::numeric as pitching_war,
            NULL::numeric as fip_plus,
            NULL::numeric as era_minus
        FROM game_pitching gp
        JOIN games g ON gp.game_id = g.id
        WHERE g.season = %s
          AND g.is_conference_game = true
          AND g.status = 'final'
          AND gp.player_id IS NOT NULL
        GROUP BY gp.player_id, gp.team_id, g.season
    )
"""


def _add_era_plus(row: dict) -> dict:
    """Convert era_minus to era_plus (higher=better). ERA+ = 10000/ERA-."""
    em = row.get("era_minus")
    if em and float(em) > 0:
        row["era_plus"] = round(10000.0 / float(em))
    else:
        row["era_plus"] = None
    # Also handle avg_era_minus → avg_era_plus for team aggregates
    aem = row.get("avg_era_minus")
    if aem and float(aem) > 0:
        row["avg_era_plus"] = round(10000.0 / float(aem))
    else:
        row.setdefault("avg_era_plus", None)
    return row


def get_team_aggregates(cur, team_id: int, season: int) -> dict:
    """Canonical source of truth for team-level aggregate stats.

    Every team-level page on the site should derive ERA / WHIP / AVG / OPS /
    RS / RA / WAR from THIS function, not from `team_season_stats.team_*`
    columns (which are stored once and go stale within a season).

    Sources:
    - `batting_stats` (cumulative per-player) → AVG, OBP, SLG, OPS, wRC+, oWAR
    - `pitching_stats` (cumulative per-player) → IP (true baseball notation),
      WHIP, FIP weighting, pWAR
    - `game_pitching` (per-box-score) → ER (preferred when available; the
      cumulative pitching_stats can carry stale ER from before official
      scoring corrections). Falls back to pitching_stats ER when no box-score
      coverage exists for an older season.
    - `games` (final scores) → RS, RA, run differential

    Returns a dict with computed stats. Endpoints can pick the fields they
    need by key. Returns empty dict-like values when there's no data.
    """
    result: dict = {}

    # ── Pitching counting + weighted advanced stats from pitching_stats ──
    # `total_true_ip` converts each row's baseball-notation IP (5.2 = 5 2/3)
    # to true decimal innings before summing. `total_ip_decimal` is the
    # naive sum (used only for FIP/xFIP IP-weighting where numerator and
    # denominator share the same convention so the bug cancels).
    cur.execute(
        """SELECT
             (SUM(ip_outs(innings_pitched)) / 3.0)::float8 AS total_ip_decimal,
             SUM(
               FLOOR(innings_pitched) +
               CASE
                 WHEN ROUND((innings_pitched - FLOOR(innings_pitched))::numeric * 10) = 1
                   THEN 1.0/3.0
                 WHEN ROUND((innings_pitched - FLOOR(innings_pitched))::numeric * 10) = 2
                   THEN 2.0/3.0
                 ELSE 0
               END
             ) AS total_true_ip,
             SUM(earned_runs) AS total_er_ps,
             SUM(runs_allowed) AS total_ra_ps,
             SUM(walks) AS total_bb_pit,
             SUM(hits_allowed) AS total_h_allowed,
             SUM(strikeouts) AS total_k_pit,
             SUM(home_runs_allowed) AS total_hr_allowed,
             SUM(hit_batters) AS total_hbp_pit,
             SUM(batters_faced) AS total_bf,
             SUM(pitching_war) AS total_pwar,
             SUM(CASE WHEN innings_pitched >= 3 AND fip IS NOT NULL
                      THEN fip * ip_outs(innings_pitched) ELSE 0 END) AS fip_num,
             SUM(CASE WHEN innings_pitched >= 3 AND fip IS NOT NULL
                      THEN ip_outs(innings_pitched) ELSE 0 END) AS fip_den,
             SUM(CASE WHEN innings_pitched >= 3 AND fip_plus IS NOT NULL
                      THEN fip_plus * ip_outs(innings_pitched) ELSE 0 END) AS fip_plus_num,
             SUM(CASE WHEN innings_pitched >= 3 AND fip_plus IS NOT NULL
                      THEN ip_outs(innings_pitched) ELSE 0 END) AS fip_plus_den,
             SUM(CASE WHEN innings_pitched >= 3 AND xfip IS NOT NULL
                      THEN xfip * ip_outs(innings_pitched) ELSE 0 END) AS xfip_num,
             SUM(CASE WHEN innings_pitched >= 3 AND xfip IS NOT NULL
                      THEN ip_outs(innings_pitched) ELSE 0 END) AS xfip_den,
             SUM(CASE WHEN innings_pitched >= 3 AND era_minus IS NOT NULL
                      THEN era_minus * ip_outs(innings_pitched) ELSE 0 END) AS era_minus_num,
             SUM(CASE WHEN innings_pitched >= 3 AND era_minus IS NOT NULL
                      THEN ip_outs(innings_pitched) ELSE 0 END) AS era_minus_den
           FROM pitching_stats WHERE team_id = %s AND season = %s""",
        (team_id, season),
    )
    pit = cur.fetchone() or {}

    # ── Batting counting + weighted advanced stats from batting_stats ──
    cur.execute(
        """SELECT
             SUM(at_bats) AS total_ab,
             SUM(plate_appearances) AS total_pa,
             SUM(hits) AS total_h,
             SUM(walks) AS total_bb_bat,
             SUM(hit_by_pitch) AS total_hbp,
             SUM(sacrifice_flies) AS total_sf,
             SUM(doubles) AS total_2b,
             SUM(triples) AS total_3b,
             SUM(home_runs) AS total_hr_bat,
             SUM(runs) AS total_runs_bat,
             SUM(rbi) AS total_rbi,
             SUM(stolen_bases) AS total_sb,
             SUM(strikeouts) AS total_k_bat,
             SUM(offensive_war) AS total_owar,
             SUM(woba * plate_appearances) FILTER (WHERE woba IS NOT NULL) AS woba_num,
             SUM(plate_appearances) FILTER (WHERE woba IS NOT NULL) AS woba_den,
             SUM(wrc_plus * plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL) AS wrc_plus_num,
             SUM(plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL) AS wrc_plus_den,
             SUM(iso * plate_appearances) FILTER (WHERE iso IS NOT NULL) AS iso_num,
             SUM(plate_appearances) FILTER (WHERE iso IS NOT NULL) AS iso_den
           FROM batting_stats WHERE team_id = %s AND season = %s""",
        (team_id, season),
    )
    bat = cur.fetchone() or {}

    # ── RS, RA, run_differential from games table (status='final' only) ──
    cur.execute(
        """SELECT
             SUM(CASE WHEN home_team_id = %s THEN home_score
                      WHEN away_team_id = %s THEN away_score ELSE 0 END) AS rs,
             SUM(CASE WHEN home_team_id = %s THEN away_score
                      WHEN away_team_id = %s THEN home_score ELSE 0 END) AS ra,
             COUNT(*) AS games
           FROM games
           WHERE season = %s AND status = 'final'
             AND (home_team_id = %s OR away_team_id = %s)""",
        (team_id, team_id, team_id, team_id, season, team_id, team_id),
    )
    scoring = cur.fetchone() or {}

    # ER must come from the SAME full-season source as the IP denominator
    # (pitching_stats season totals). game_pitching only covers games whose box
    # scores were scraped, which is PARTIAL for many teams (NWAC, JUCO, and even
    # some D1 like Seattle U/UW with few scraped games). Dividing a partial ER by
    # full-season IP produced absurdly low team ERAs (Everett 2025 showed 1.49
    # instead of ~2.69). pitching_stats is the season source of truth and matches
    # the official conference team totals.
    total_er = pit.get("total_er_ps") or 0
    result["er_source"] = "pitching_stats"

    # Convenience locals
    true_ip = float(pit.get("total_true_ip") or 0)
    ip_decimal = float(pit.get("total_ip_decimal") or 0)
    bb_pit = pit.get("total_bb_pit") or 0
    h_allowed = pit.get("total_h_allowed") or 0
    k_pit = pit.get("total_k_pit") or 0
    hr_allowed = pit.get("total_hr_allowed") or 0
    hbp_pit = pit.get("total_hbp_pit") or 0
    bf = pit.get("total_bf") or 0

    ab = bat.get("total_ab") or 0
    pa = bat.get("total_pa") or 0
    h = bat.get("total_h") or 0
    bb_bat = bat.get("total_bb_bat") or 0
    hbp = bat.get("total_hbp") or 0
    sf = bat.get("total_sf") or 0
    d2b = bat.get("total_2b") or 0
    d3b = bat.get("total_3b") or 0
    hr_bat = bat.get("total_hr_bat") or 0

    # ── Pitching rates ──
    result["true_ip"] = round(true_ip, 2)
    result["ip_decimal"] = ip_decimal
    result["er"] = total_er
    result["bb_pit"] = bb_pit
    result["h_allowed"] = h_allowed
    result["k_pit"] = k_pit
    result["hr_allowed"] = hr_allowed
    result["hbp_pit"] = hbp_pit
    result["bf"] = bf
    if true_ip > 0:
        result["team_era"] = round(total_er * 9 / true_ip, 2)
        result["team_whip"] = round((bb_pit + h_allowed) / true_ip, 3)
        result["k_per_9"] = round(k_pit * 9 / true_ip, 1)
        result["bb_per_9"] = round(bb_pit * 9 / true_ip, 1)
        result["h_per_9"] = round(h_allowed * 9 / true_ip, 1)
        result["hr_per_9"] = round(hr_allowed * 9 / true_ip, 2)
    else:
        result["team_era"] = None
        result["team_whip"] = None

    # IP-weighted advanced pitching stats (ratio of decimal-summed numerator
    # to decimal-summed denominator — bug cancels).
    fip_den = float(pit.get("fip_den") or 0)
    result["avg_fip"] = round(float(pit.get("fip_num") or 0) / fip_den, 2) if fip_den > 0 else None
    fip_plus_den = float(pit.get("fip_plus_den") or 0)
    result["avg_fip_plus"] = round(float(pit.get("fip_plus_num") or 0) / fip_plus_den) if fip_plus_den > 0 else None
    xfip_den = float(pit.get("xfip_den") or 0)
    result["avg_xfip"] = round(float(pit.get("xfip_num") or 0) / xfip_den, 2) if xfip_den > 0 else None
    em_den = float(pit.get("era_minus_den") or 0)
    avg_era_minus = float(pit.get("era_minus_num") or 0) / em_den if em_den > 0 else None
    result["avg_era_minus"] = round(avg_era_minus) if avg_era_minus is not None else None
    result["avg_era_plus"] = round(10000.0 / avg_era_minus) if avg_era_minus and avg_era_minus > 0 else None

    # ── Batting rates ──
    result["ab"] = ab
    result["pa"] = pa
    result["hits"] = h
    result["bb_bat"] = bb_bat
    result["hbp_bat"] = hbp
    result["hr_bat"] = hr_bat
    result["doubles"] = d2b
    result["triples"] = d3b
    result["runs_bat"] = bat.get("total_runs_bat") or 0
    result["rbi"] = bat.get("total_rbi") or 0
    result["sb"] = bat.get("total_sb") or 0
    result["k_bat"] = bat.get("total_k_bat") or 0
    if ab > 0:
        result["team_avg"] = round(h / ab, 3)
        singles = h - d2b - d3b - hr_bat
        total_bases = singles + 2 * d2b + 3 * d3b + 4 * hr_bat
        result["team_slg"] = round(total_bases / ab, 3)
        # OBP: NCAA convention uses PA in the denominator (which includes
        # both sac flies AND sac bunts). Matches what college stats portals
        # and school sites report. The FanGraphs convention (AB+BB+HBP+SF
        # only, excluding SH) shifts OBP up by ~.003 for college teams and
        # is the wrong call for this site.
        if pa > 0:
            result["team_obp"] = round((h + bb_bat + hbp) / pa, 3)
        else:
            result["team_obp"] = None
        if result["team_obp"] is not None:
            result["team_ops"] = round(result["team_obp"] + result["team_slg"], 3)
        else:
            result["team_ops"] = None
    else:
        result["team_avg"] = None
        result["team_obp"] = None
        result["team_slg"] = None
        result["team_ops"] = None

    # PA-weighted batting advanced stats
    woba_den = float(bat.get("woba_den") or 0)
    result["avg_woba"] = round(float(bat.get("woba_num") or 0) / woba_den, 3) if woba_den > 0 else None
    wrc_den = float(bat.get("wrc_plus_den") or 0)
    result["avg_wrc_plus"] = round(float(bat.get("wrc_plus_num") or 0) / wrc_den, 1) if wrc_den > 0 else None
    iso_den = float(bat.get("iso_den") or 0)
    result["avg_iso"] = round(float(bat.get("iso_num") or 0) / iso_den, 3) if iso_den > 0 else None

    # ── WAR (sum across players from per-player rows) ──
    result["o_war"] = round(float(bat.get("total_owar") or 0), 1)
    result["p_war"] = round(float(pit.get("total_pwar") or 0), 1)
    result["total_war"] = round(result["o_war"] + result["p_war"], 1)

    # ── Runs scored, runs allowed, run differential from games table ──
    rs = scoring.get("rs") or 0
    ra = scoring.get("ra") or 0
    result["runs_scored"] = rs
    result["runs_allowed"] = ra
    result["run_differential"] = rs - ra
    result["games_played"] = scoring.get("games") or 0

    return result


def _apply_year_filter(query: str, params: list, year_in_school: str, col: str = "p.year_in_school"):
    """Append a year_in_school filter to a SQL query, grouping redshirt with regular."""
    years = _YEAR_GROUPS.get(year_in_school, (year_in_school,))
    placeholders = ",".join(["%s"] * len(years))
    query += f" AND {col} IN ({placeholders})"
    params.extend(years)
    return query


router = APIRouter()

# Include favorites sub-router (requires Supabase auth)
from .favorites import favorites_router
router.include_router(favorites_router)

from .quiz import quiz_router
router.include_router(quiz_router)


# ============================================================
# SITE-WIDE STATS (player/game counts for About page)
# ============================================================

@router.get("/site-stats")
@cached_endpoint(ttl_seconds=21600)  # 6h: heavy full-table aggregations, and the
                                     # "wow number" totals only move after the daily scrape
def site_stats():
    """Return aggregate counts and a random player for the About page."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) AS cnt FROM players")
        total_players = cur.fetchone()["cnt"]
        cur.execute("SELECT COUNT(*) AS cnt FROM games")
        total_games = cur.fetchone()["cnt"]
        cur.execute("SELECT COUNT(DISTINCT team_id) AS cnt FROM batting_stats")
        total_teams = cur.fetchone()["cnt"]

        # Big counting stats from per-game tables (the "wow" numbers)
        cur.execute("""
            SELECT
              COALESCE(SUM(home_runs), 0)        AS total_home_runs,
              COALESCE(SUM(hits), 0)             AS total_hits,
              COALESCE(SUM(doubles), 0)          AS total_doubles,
              COALESCE(SUM(triples), 0)          AS total_triples,
              COALESCE(SUM(at_bats), 0)          AS total_at_bats,
              COALESCE(SUM(walks), 0)            AS total_walks,
              COALESCE(SUM(strikeouts), 0)       AS total_batter_ks,
              COALESCE(SUM(stolen_bases), 0)     AS total_stolen_bases,
              COALESCE(SUM(runs), 0)             AS total_runs_scored
            FROM game_batting
        """)
        bat = cur.fetchone()

        # Innings pitched stored as decimal-baseball notation (6.2 = 6.667 IP).
        # Convert to outs for an honest aggregate, then back to a normal float.
        cur.execute("""
            SELECT
              COALESCE(SUM(FLOOR(innings_pitched) * 3
                           + ((innings_pitched - FLOOR(innings_pitched)) * 10)), 0)
                AS total_outs,
              COALESCE(SUM(strikeouts), 0) AS total_pitcher_ks
            FROM game_pitching
        """)
        pit = cur.fetchone()
        total_outs = int(pit["total_outs"] or 0)
        total_innings = round(total_outs / 3.0, 0)  # whole-IP rounded

        # Play-by-play events (huge differentiating number)
        cur.execute("SELECT COUNT(*) AS cnt FROM game_events")
        total_pbp_events = cur.fetchone()["cnt"]

        # How many distinct seasons we've parsed
        cur.execute("SELECT COUNT(DISTINCT season) AS cnt FROM batting_stats")
        seasons_tracked = cur.fetchone()["cnt"]

        # How many box scores parsed (distinct games with batting rows)
        cur.execute("SELECT COUNT(DISTINCT game_id) AS cnt FROM game_batting")
        box_scores_parsed = cur.fetchone()["cnt"]

        # Random player - pick someone with real stats so the card is interesting
        cur.execute("""
            SELECT p.id, p.first_name, p.last_name, p.position, p.hometown,
                   p.headshot_url, p.year_in_school,
                   t.name AS team, t.short_name AS team_short,
                   d.name AS division,
                   bs.season, bs.batting_avg, bs.on_base_pct, bs.slugging_pct,
                   bs.home_runs, bs.hits, bs.plate_appearances,
                   bs.wrc_plus, bs.offensive_war
            FROM batting_stats bs
            JOIN players p ON p.id = bs.player_id
            JOIN teams t ON t.id = bs.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE bs.plate_appearances >= 30
            ORDER BY RANDOM()
            LIMIT 1
        """)
        random_player = cur.fetchone()

    return {
        "total_players": total_players,
        "total_games": total_games,
        "total_teams": total_teams,
        "total_home_runs": int(bat["total_home_runs"]),
        "total_hits": int(bat["total_hits"]),
        "total_doubles": int(bat["total_doubles"]),
        "total_triples": int(bat["total_triples"]),
        "total_at_bats": int(bat["total_at_bats"]),
        "total_walks": int(bat["total_walks"]),
        "total_strikeouts": int(pit["total_pitcher_ks"] or bat["total_batter_ks"]),
        "total_stolen_bases": int(bat["total_stolen_bases"]),
        "total_runs_scored": int(bat["total_runs_scored"]),
        "total_innings_pitched": int(total_innings),
        "total_pbp_events": int(total_pbp_events),
        "seasons_tracked": int(seasons_tracked),
        "box_scores_parsed": int(box_scores_parsed),
        "random_player": dict(random_player) if random_player else None,
    }


# ── Stats last-updated timestamps ─────────────────────────────────
@router.get("/stats/last-updated")
@cached_endpoint(ttl_seconds=300)
def stats_last_updated_top(season: int = CURRENT_SEASON):
    """Return the most recent updated_at timestamp per division level."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT d.level AS division_level,
                   MAX(GREATEST(
                       COALESCE(bat.max_bat, '1970-01-01'::timestamp),
                       COALESCE(pit.max_pit, '1970-01-01'::timestamp)
                   )) AS last_updated
            FROM divisions d
            JOIN conferences c ON c.division_id = d.id
            JOIN teams t ON t.conference_id = c.id
            LEFT JOIN (
                SELECT bs.team_id, MAX(bs.updated_at) AS max_bat
                FROM batting_stats bs
                WHERE bs.season = %s
                GROUP BY bs.team_id
            ) bat ON bat.team_id = t.id
            LEFT JOIN (
                SELECT ps.team_id, MAX(ps.updated_at) AS max_pit
                FROM pitching_stats ps
                WHERE ps.season = %s
                GROUP BY ps.team_id
            ) pit ON pit.team_id = t.id
            WHERE t.is_active = 1
            GROUP BY d.level
            ORDER BY d.level
        """, (season, season))
        rows = cur.fetchall()

        result = {}
        for row in rows:
            level = row["division_level"]
            ts = row["last_updated"]
            if ts and str(ts) != "1970-01-01 00:00:00":
                # Append UTC indicator so the frontend correctly converts to Pacific
                iso = ts.isoformat() if hasattr(ts, 'isoformat') else str(ts)
                if '+' not in iso and 'Z' not in iso:
                    iso += '+00:00'
                result[level] = iso

        return result


# ============================================================
# HOMETOWN SEARCH
# ============================================================

@router.get("/hometown-search")
def hometown_search(
    q: str = Query("", min_length=0),
    _user: str = Depends(require_tier("premium")),
):
    """Search players by hometown. Returns players whose hometown contains the query string.
    Premium-gated (soft mode = auth-only)."""
    with get_connection() as conn:
        cur = conn.cursor()

        # If no query, return the top 30 most common cities for the browse view
        if not q.strip():
            cur.execute("""
                SELECT hometown, COUNT(*) AS player_count
                FROM players
                WHERE hometown IS NOT NULL AND hometown != ''
                GROUP BY hometown
                ORDER BY COUNT(*) DESC
                LIMIT 30
            """)
            return {"query": "", "cities": [dict(r) for r in cur.fetchall()], "players": []}

        like_q = f"%{q.strip()}%"
        cur.execute("""
            SELECT p.id, p.first_name, p.last_name, p.hometown, p.high_school,
                   p.position, p.year_in_school,
                   t.id AS team_id, t.name AS team,
                   d.name AS division
            FROM players p
            JOIN teams t ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE LOWER(p.hometown) LIKE LOWER(%s)
            ORDER BY t.name, p.last_name, p.first_name
        """, (like_q,))
        players = [dict(r) for r in cur.fetchall()]

        # Also return a grouped summary of teams these players went to
        team_counts = {}
        for p in players:
            key = p["team"]
            if key not in team_counts:
                team_counts[key] = {"team": key, "team_id": p["team_id"], "division": p["division"], "count": 0}
            team_counts[key]["count"] += 1
        teams = sorted(team_counts.values(), key=lambda x: -x["count"])

        return {"query": q.strip(), "cities": [], "players": players, "teams": teams}


# ============================================================
# BROWSE: Divisions, Conferences, Teams
# ============================================================

@router.get("/divisions")
@cached_endpoint(ttl_seconds=3600)
def list_divisions():
    """List all divisions (D1, D2, D3, NAIA, NWAC)."""
    with get_connection() as conn:
        cur = conn.cursor()
        rows = cur.execute("SELECT * FROM divisions ORDER BY id")
        rows = cur.fetchall()
        return [dict(r) for r in rows]


@router.get("/conferences")
@cached_endpoint(ttl_seconds=3600)
def list_conferences(division_id: Optional[int] = None):
    """List conferences, optionally filtered by division."""
    with get_connection() as conn:
        cur = conn.cursor()
        if division_id:
            cur.execute(
                "SELECT c.*, d.name as division_name FROM conferences c "
                "JOIN divisions d ON c.division_id = d.id "
                "WHERE c.division_id = %s ORDER BY c.name",
                (division_id,),
            )
            rows = cur.fetchall()
        else:
            cur.execute(
                "SELECT c.*, d.name as division_name FROM conferences c "
                "JOIN divisions d ON c.division_id = d.id ORDER BY d.id, c.name"
            )
            rows = cur.fetchall()
        return [dict(r) for r in rows]


@router.get("/teams")
@cached_endpoint(ttl_seconds=1800)
def list_teams(
    conference_id: Optional[int] = None,
    division_id: Optional[int] = None,
    state: Optional[str] = None,
):
    """List teams with optional filters."""
    with get_connection() as conn:
        cur = conn.cursor()
        query = """
            SELECT t.*, c.name as conference_name, c.abbreviation as conference_abbrev,
                   d.name as division_name, d.level as division_level
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE t.is_active = 1
              AND t.state IN ('WA', 'OR', 'ID', 'MT', 'BC')
        """
        params = []

        if conference_id:
            query += " AND t.conference_id = %s"
            params.append(conference_id)
        if division_id:
            query += " AND c.division_id = %s"
            params.append(division_id)
        if state:
            query += " AND t.state = %s"
            params.append(state.upper())

        query += " ORDER BY d.id, c.name, t.name"
        rows = cur.execute(query, params)
        rows = cur.fetchall()
        return [dict(r) for r in rows]


@router.get("/teams/summary")
@cached_endpoint(ttl_seconds=1800)
def teams_summary(
    season: int = Query(..., description="Season year"),
    division_id: Optional[int] = None,
    state: Optional[str] = None,
):
    """
    List all teams with their best hitter (by oWAR) and best pitcher (by pWAR).
    Used on the main Teams page to show a preview of each team's top talent.
    """
    with get_connection() as conn:
        cur = conn.cursor()
        # Get all active teams
        team_query = """
            SELECT t.*, c.name as conference_name, c.abbreviation as conference_abbrev,
                   d.name as division_name, d.level as division_level
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE t.is_active = 1
              AND t.state IN ('WA', 'OR', 'ID', 'MT', 'BC')
        """
        team_params = []
        if division_id:
            team_query += " AND c.division_id = %s"
            team_params.append(division_id)
        if state:
            team_query += " AND t.state = %s"
            team_params.append(state.upper())
        team_query += " ORDER BY d.id, c.name, t.name"
        teams = cur.execute(team_query, team_params)
        teams = cur.fetchall()

        # For each team, grab top hitter and top pitcher in one query each
        cur.execute(
            """SELECT bs.team_id,
                      p.first_name, p.last_name, p.position,
                      bs.batting_avg, bs.woba, bs.offensive_war, bs.plate_appearances
               FROM batting_stats bs
               JOIN players p ON bs.player_id = p.id
               WHERE bs.season = %s
                 AND bs.plate_appearances >= 30
               ORDER BY bs.offensive_war DESC""",
            (season,),
        )
        top_hitters = cur.fetchall()

        cur.execute(
            """SELECT ps.team_id,
                      p.first_name, p.last_name,
                      ps.era, ps.fip, ps.pitching_war, ps.innings_pitched
               FROM pitching_stats ps
               JOIN players p ON ps.player_id = p.id
               WHERE ps.season = %s
                 AND ps.innings_pitched >= 10
               ORDER BY ps.pitching_war DESC""",
            (season,),
        )
        top_pitchers = cur.fetchall()

        # Build lookup: team_id → best hitter/pitcher (first one per team wins)
        best_hitter = {}
        for h in top_hitters:
            tid = h["team_id"]
            if tid not in best_hitter:
                best_hitter[tid] = dict(h)

        best_pitcher = {}
        for p in top_pitchers:
            tid = p["team_id"]
            if tid not in best_pitcher:
                best_pitcher[tid] = dict(p)

        # Team total WAR
        cur.execute(
            """SELECT team_id,
                      COALESCE(SUM(offensive_war), 0) as total_owar
               FROM batting_stats WHERE season = %s
               GROUP BY team_id""",
            (season,),
        )
        team_war = cur.fetchall()
        cur.execute(
            """SELECT team_id,
                      COALESCE(SUM(pitching_war), 0) as total_pwar
               FROM pitching_stats WHERE season = %s
               GROUP BY team_id""",
            (season,),
        )
        team_pwar = cur.fetchall()
        owar_map = {r["team_id"]: r["total_owar"] for r in team_war}
        pwar_map = {r["team_id"]: r["total_pwar"] for r in team_pwar}

        # Team W-L records
        cur.execute(
            """SELECT team_id, wins, losses, ties, conference_wins, conference_losses
               FROM team_season_stats WHERE season = %s""",
            (season,),
        )
        team_records = cur.fetchall()
        record_map = {r["team_id"]: dict(r) for r in team_records}

        result = []
        for t in teams:
            team = dict(t)
            tid = t["id"]
            team["top_hitter"] = best_hitter.get(tid)
            team["top_pitcher"] = best_pitcher.get(tid)
            team["team_owar"] = round(owar_map.get(tid, 0), 1)
            team["team_pwar"] = round(pwar_map.get(tid, 0), 1)
            team["team_war"] = round(owar_map.get(tid, 0) + pwar_map.get(tid, 0), 1)
            rec = record_map.get(tid)
            if rec:
                team["wins"] = rec["wins"]
                team["losses"] = rec["losses"]
                team["ties"] = rec["ties"]
                team["conf_wins"] = rec["conference_wins"]
                team["conf_losses"] = rec["conference_losses"]
            result.append(team)

        return result


@router.get("/standings")
@cached_endpoint(ttl_seconds=900)
def standings(
    season: int = Query(..., description="Season year"),
):
    """
    Return standings grouped by conference.
    Each conference includes its teams sorted by conference win %,
    plus an overall PNW standings list sorted by overall win %.
    """
    with get_connection() as conn:
        cur = conn.cursor()
        # COALESCE(sf.*, s.*) makes teams in a frozen conference pull their
        # snapshotted W-L from team_season_stats_frozen while teams in live
        # conferences continue using team_season_stats. A team only has a
        # row in _frozen if its conference's regular season has ended.
        cur.execute("""
            SELECT t.id, t.short_name, t.logo_url, t.city, t.state,
                   c.id as conference_id, c.name as conference_name, c.abbreviation as conference_abbrev,
                   d.id as division_id, d.name as division_name, d.level as division_level,
                   COALESCE(sf.wins, s.wins, 0) as wins,
                   COALESCE(sf.losses, s.losses, 0) as losses,
                   COALESCE(sf.conference_wins, s.conference_wins, 0) as conf_wins,
                   COALESCE(sf.conference_losses, s.conference_losses, 0) as conf_losses,
                   cr.composite_rank as national_rank
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN team_season_stats_frozen sf ON sf.team_id = t.id AND sf.season = %s
            LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
            LEFT JOIN composite_rankings cr ON cr.team_id = t.id AND cr.season = %s
            WHERE t.is_active = 1
            ORDER BY d.id, c.name, t.short_name
        """, (season, season, season))
        rows = cur.fetchall()

        # Fetch CPI ranks for JUCO teams (no national rankings exist for them).
        # CPI gathers its own inputs (games + batting/pitching aggregates).
        cur.execute("""
            SELECT t.id
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE t.is_active = 1 AND d.level = 'JUCO'
        """)
        juco_ids = [r["id"] for r in cur.fetchall()]
        juco_ranked = compute_cpi_for_division(
            cur, juco_ids, season, season_games=SEASON_GAMES_BY_LEVEL["JUCO"])
        cpi_lookup = {t["team_id"]: t["rank"] for t in juco_ranked}

        # Group by conference
        conferences = {}
        all_teams = []
        for r in rows:
            team = dict(r)
            # Flag PNW teams (WA, OR, ID, MT)
            team["is_pnw"] = team.get("state", "") in ("WA", "OR", "ID", "MT", "BC")
            # Compute win percentages
            total_games = team["wins"] + team["losses"]
            team["win_pct"] = round(team["wins"] / total_games, 3) if total_games > 0 else 0
            conf_games = team["conf_wins"] + team["conf_losses"]
            team["conf_win_pct"] = round(team["conf_wins"] / conf_games, 3) if conf_games > 0 else 0
            # Attach ranking: national_rank for D1-NAIA, CPI rank for JUCO
            if team["division_level"] == "JUCO":
                team["rank"] = cpi_lookup.get(team["id"])
                team["rank_label"] = "CPI"
            else:
                team["rank"] = team.get("national_rank")
                team["rank_label"] = "Natl"

            cid = team["conference_id"]
            if cid not in conferences:
                conferences[cid] = {
                    "conference_id": cid,
                    "conference_name": team["conference_name"],
                    "conference_abbrev": team["conference_abbrev"],
                    "division_id": team["division_id"],
                    "division_name": team["division_name"],
                    "division_level": team["division_level"],
                    "teams": [],
                }
            conferences[cid]["teams"].append(team)
            all_teams.append(team)

        # Playoff spots per conference (abbreviation → number of teams that qualify)
        PLAYOFF_SPOTS = {
            "GNAC": 3,       # D2: top 3
            "NWC": 4,        # D3: top 4
            "CCC": 5,        # NAIA: top 5
            "Big Ten": 12,   # Big Ten: top 12
            "MWC": 6,        # Mountain West: top 6
            "WCC": 6,        # West Coast: top 6
        }
        # NWAC divisions: top 4 from each
        for key in ("NWAC North", "NWAC East", "NWAC South", "NWAC West",
                     "NWAC_NORTH", "NWAC_EAST", "NWAC_SOUTH", "NWAC_WEST"):
            PLAYOFF_SPOTS[key] = 4

        # Sort each conference by conf win % primary, then apply head-to-head
        # then overall record as tiebreakers.
        for conf in conferences.values():
            conf["teams"].sort(key=lambda t: t["conf_win_pct"], reverse=True)
            conf["teams"] = apply_head_to_head(
                conf["teams"], get_connection, season,
                primary_key="conf_win_pct",
            )
            # Determine playoff spots for this conference
            abbrev = conf.get("conference_abbrev", "")
            spots = PLAYOFF_SPOTS.get(abbrev, PLAYOFF_SPOTS.get(conf.get("conference_name", ""), 4))
            spots = min(spots, len(conf["teams"]))  # can't exceed team count
            conf["playoff_spots"] = spots
            # Compute Games Behind/Ahead of the playoff cutoff line
            # Positive = games ahead (in playoff position), Negative = games behind
            if conf["teams"] and spots > 0:
                cutoff_team = conf["teams"][spots - 1]  # last team in playoff position
                cutoff_w, cutoff_l = cutoff_team["conf_wins"], cutoff_team["conf_losses"]
                for team in conf["teams"]:
                    # Positive means ahead of cutoff, negative means behind
                    gb = ((team["conf_wins"] - cutoff_w) + (cutoff_l - team["conf_losses"])) / 2
                    team["conf_gb"] = gb

        # Sort overall standings by win % primary, then head-to-head among
        # teams tied on overall win % (wins count is last resort).
        all_teams.sort(key=lambda t: t["win_pct"], reverse=True)
        all_teams = apply_head_to_head(
            all_teams, get_connection, season,
            primary_key="win_pct",
            overall_key="win_pct",
            overall_wins_key="wins",
        )

        # Load frozen-conference metadata so the frontend can show a banner
        # on each frozen conference's section of the standings page.
        cur.execute(
            """
            SELECT conf_key, regular_season_end_date, frozen_at
            FROM conference_freezes
            """
        )
        frozen_rows = cur.fetchall()
        frozen_conferences = [
            {
                "conf_key": r["conf_key"],
                "regular_season_end_date": (
                    r["regular_season_end_date"].isoformat()
                    if r["regular_season_end_date"] else None
                ),
                "frozen_at": r["frozen_at"].isoformat() if r["frozen_at"] else None,
            }
            for r in frozen_rows
        ]

        return {
            "conferences": list(conferences.values()),
            "overall": all_teams,
            "frozen_conferences": frozen_conferences,
        }


@router.get("/conference-standings-graphic")
def conference_standings_graphic(
    season: int = Query(..., description="Season year"),
):
    """
    Return conference standings data enriched with conf games remaining,
    remaining SOS (ranked by opponent power ratings), games back from
    playoff cutoff, and national rank.
    Excludes D1 conferences; includes D2, D3, NAIA, and NWAC divisions.
    """
    from ..stats.projections import load_future_schedules

    future_data = load_future_schedules()
    future_games = future_data.get("games", [])

    with get_connection() as conn:
        cur = conn.cursor()

        # 1. Get team records + national rank.
        # COALESCE pattern: prefer team_season_stats_frozen when a conference
        # has been frozen (regular season ended); fall back to live otherwise.
        cur.execute("""
            SELECT t.id, t.short_name, t.logo_url,
                   c.id as conference_id, c.name as conference_name,
                   c.abbreviation as conference_abbrev,
                   d.id as division_id, d.name as division_name, d.level as division_level,
                   COALESCE(sf.wins, s.wins, 0) as wins,
                   COALESCE(sf.losses, s.losses, 0) as losses,
                   COALESCE(sf.conference_wins, s.conference_wins, 0) as conf_wins,
                   COALESCE(sf.conference_losses, s.conference_losses, 0) as conf_losses,
                   cr.composite_rank as national_rank
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN team_season_stats_frozen sf ON sf.team_id = t.id AND sf.season = %s
            LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
            LEFT JOIN composite_rankings cr ON cr.team_id = t.id AND cr.season = %s
            WHERE t.is_active = 1
              AND d.level != 'D1'
            ORDER BY d.id, c.name, t.short_name
        """, (season, season, season))
        team_rows = cur.fetchall()

        # 2. Get power ratings (same query as playoff-projections)
        cur.execute("""
            SELECT t.id, t.short_name, d.level as division_level,
                   COALESCE(s.wins, 0) as wins, COALESCE(s.losses, 0) as losses,
                   COALESCE(bat.rs, 0) as runs_scored,
                   COALESCE(pit.ra, 0) as runs_allowed,
                   COALESCE(bat.avg_wrc_plus, 100) as avg_wrc_plus,
                   COALESCE(pit.avg_fip, 4.5) as avg_fip,
                   COALESCE(bat.total_owar, 0) + COALESCE(pit.total_pwar, 0) as total_war,
                   cr.national_percentile
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
            LEFT JOIN (
                SELECT team_id,
                    SUM(runs) as rs,
                    SUM(offensive_war) as total_owar,
                    SUM(wrc_plus * plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL)
                      / NULLIF(SUM(plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL), 0) as avg_wrc_plus
                FROM batting_stats WHERE season = %s GROUP BY team_id
            ) bat ON bat.team_id = t.id
            LEFT JOIN (
                SELECT team_id,
                    SUM(runs_allowed) as ra,
                    SUM(pitching_war) as total_pwar,
                    SUM(fip * ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL)
                      / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL), 0) as avg_fip
                FROM pitching_stats WHERE season = %s GROUP BY team_id
            ) pit ON pit.team_id = t.id
            LEFT JOIN composite_rankings cr ON cr.team_id = t.id AND cr.season = %s
            WHERE t.is_active = 1
        """, (season, season, season, season))
        rating_rows = cur.fetchall()

        team_ratings = {}
        for r in rating_rows:
            r = dict(r)
            w = r["wins"] or 0
            l = r["losses"] or 0
            if w + l < 5:
                continue
            rating = _compute_power_rating(
                w, l, r["runs_scored"], r["runs_allowed"],
                r["avg_wrc_plus"], r["avg_fip"], r["total_war"],
                r["division_level"], r["national_percentile"],
            )
            if rating is not None:
                team_ratings[r["id"]] = {
                    "power_rating": rating,
                    "short_name": r["short_name"],
                    "division_level": r["division_level"],
                }

        # Build short_name -> team_id lookup for future schedule matching
        name_to_id = {info["short_name"]: tid for tid, info in team_ratings.items()}

        # 3. Process future games: count conf games remaining + collect opponent ratings
        #    for remaining SOS calculation
        conf_remaining = {}      # team_id -> count of remaining conference games
        opp_ratings_remaining = {}  # team_id -> [list of opponent power ratings for remaining conf games]

        for game in future_games:
            if not game.get("is_conference", False):
                continue

            home_id = game.get("home_team_id") or name_to_id.get(game.get("home_team"))
            away_id = game.get("away_team_id") or name_to_id.get(game.get("away_team"))

            if home_id:
                conf_remaining[home_id] = conf_remaining.get(home_id, 0) + 1
                if away_id and away_id in team_ratings:
                    opp_ratings_remaining.setdefault(home_id, []).append(
                        team_ratings[away_id]["power_rating"])

            if away_id:
                conf_remaining[away_id] = conf_remaining.get(away_id, 0) + 1
                if home_id and home_id in team_ratings:
                    opp_ratings_remaining.setdefault(away_id, []).append(
                        team_ratings[home_id]["power_rating"])

        # 4. For JUCO teams, compute CPI ranks (the adapter gathers its own
        # games + batting/pitching aggregates for the JUCO cohort).
        cur.execute("""
            SELECT t.id
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE t.is_active = 1 AND d.level = 'JUCO'
        """)
        juco_ids = [r["id"] for r in cur.fetchall()]
        juco_ranked = compute_cpi_for_division(
            cur, juco_ids, season, season_games=SEASON_GAMES_BY_LEVEL["JUCO"])
        cpi_lookup = {t["team_id"]: t["rank"] for t in juco_ranked}

        # 5. Build conference groups
        conferences = {}
        for r in team_rows:
            team = dict(r)
            total_games = team["wins"] + team["losses"]
            team["win_pct"] = round(team["wins"] / total_games, 3) if total_games > 0 else 0
            conf_games = team["conf_wins"] + team["conf_losses"]
            team["conf_win_pct"] = round(team["conf_wins"] / conf_games, 3) if conf_games > 0 else 0
            team["conf_games_remaining"] = conf_remaining.get(team["id"], 0)

            # Ranking: national for 4-year, CPI for JUCO
            if team["division_level"] == "JUCO":
                team["rank"] = cpi_lookup.get(team["id"])
                team["rank_label"] = "CPI"
            else:
                team["rank"] = team.get("national_rank")
                team["rank_label"] = "Natl"

            # Avg opponent power rating of remaining conf games (for SOS ranking later)
            opp_list = opp_ratings_remaining.get(team["id"], [])
            team["avg_opp_power"] = (sum(opp_list) / len(opp_list)) if opp_list else None

            cid = team["conference_id"]
            if cid not in conferences:
                conferences[cid] = {
                    "conference_id": cid,
                    "conference_name": team["conference_name"],
                    "conference_abbrev": team["conference_abbrev"],
                    "division_id": team["division_id"],
                    "division_name": team["division_name"],
                    "division_level": team["division_level"],
                    "teams": [],
                }
            conferences[cid]["teams"].append(team)

        # 6. For each conference: sort, compute GB from playoff cutoff, rank SOS remaining
        PLAYOFF_SPOTS = {
            "GNAC": 3, "NWC": 4, "CCC": 5,
        }
        for key in ("NWAC North", "NWAC East", "NWAC South", "NWAC West",
                     "NWAC_NORTH", "NWAC_EAST", "NWAC_SOUTH", "NWAC_WEST"):
            PLAYOFF_SPOTS[key] = 4

        for conf in conferences.values():
            conf["teams"].sort(key=lambda t: (t["conf_win_pct"], t["win_pct"]), reverse=True)

            # Playoff spots + games back from playoff CUTOFF (not from 1st place)
            abbrev = conf.get("conference_abbrev", "")
            spots = PLAYOFF_SPOTS.get(abbrev, PLAYOFF_SPOTS.get(conf.get("conference_name", ""), 4))
            spots = min(spots, len(conf["teams"]))
            conf["playoff_spots"] = spots

            if conf["teams"] and spots > 0:
                cutoff_team = conf["teams"][spots - 1]
                cutoff_w = cutoff_team["conf_wins"]
                cutoff_l = cutoff_team["conf_losses"]
                for team in conf["teams"]:
                    gb = ((cutoff_w - team["conf_wins"])
                          + (team["conf_losses"] - cutoff_l)) / 2
                    team["games_back"] = gb  # positive = behind, negative = ahead

            # Rank SOS remaining within conference by avg opponent power rating
            # Higher avg power = harder schedule = rank 1
            teams_with_sos = [t for t in conf["teams"] if t.get("avg_opp_power") is not None]
            teams_with_sos.sort(key=lambda t: t["avg_opp_power"], reverse=True)
            for i, t in enumerate(teams_with_sos):
                t["sos_remaining_rank"] = i + 1
            for t in conf["teams"]:
                if "sos_remaining_rank" not in t:
                    t["sos_remaining_rank"] = None

        # Frozen conferences metadata for the frontend banner.
        # Empty list means nothing is frozen; otherwise the frontend can
        # show "Frozen as of [date]" per conf_key that appears here.
        cur.execute("""
            SELECT conf_key, regular_season_end_date, frozen_at
            FROM conference_freezes
        """)
        frozen_rows = cur.fetchall()
        frozen_conferences = [
            {
                "conf_key": r["conf_key"],
                "regular_season_end_date": r["regular_season_end_date"].isoformat()
                    if r["regular_season_end_date"] else None,
                "frozen_at": r["frozen_at"].isoformat() if r["frozen_at"] else None,
            }
            for r in frozen_rows
        ]

        return {
            "conferences": sorted(conferences.values(),
                                  key=lambda c: (c["division_level"], c["conference_name"])),
            "frozen_conferences": frozen_conferences,
        }


@router.get("/stat-leaders")
@cached_endpoint(ttl_seconds=1800)
def stat_leaders(
    season: int = Query(..., description="Season year"),
    limit: int = Query(5, description="Number of leaders per category"),
    qualified: bool = Query(False, description="Only qualified players (2 PA/game batting, 0.75 IP/game pitching)"),
    level: str = Query(None, description="Filter by division level (D1, D2, D3, NAIA, JUCO)"),
    split: str = Query(None, description="Filter by split: 'home' or 'road'"),
):
    """
    Return top N players for key batting and pitching categories.
    When split=home or split=road, aggregates from game-level data.
    Batting: wRC+, HR, SB, oWAR, AVG, ISO (or AVG, OBP, SLG, OPS, HR, RBI for splits)
    Pitching: pWAR, FIP+, SIERA, K-BB%, ERA, K (or ERA, WHIP, K, K/9, W, SV for splits)
    """
    with get_connection() as conn:
        cur = conn.cursor()
        min_pa = 30
        min_ip = 20

        level_filter = ""
        level_params = []
        if level:
            level_filter = "AND d.level = %s"
            level_params = [level]

        # ── Split mode: aggregate from game-level data ──
        if split in ("home", "road"):
            is_home = split == "home"
            min_pa_split = 15  # Lower threshold for splits

            # Build a CTE that aggregates game_batting by player, filtered to home or road.
            # Use the player's team from the players table (p2.team_id) since gb.team_id
            # is often NULL. Check if the player's team is the home or away team.
            # When away_team_id is NULL, use: home = player's team IS home_team,
            # road = player's team IS NOT home_team.
            if is_home:
                home_road_condition = "p2.team_id = g.home_team_id"
            else:
                home_road_condition = "(p2.team_id = g.away_team_id OR (g.away_team_id IS NULL AND p2.team_id != g.home_team_id))"

            batting_split_categories = [
                {"key": "batting_avg", "label": "AVG", "col": "agg.avg", "order": "DESC", "format": "avg"},
                {"key": "on_base_pct", "label": "OBP", "col": "agg.obp", "order": "DESC", "format": "avg"},
                {"key": "hits", "label": "H", "col": "agg.h", "order": "DESC", "format": "int"},
                {"key": "runs", "label": "R", "col": "agg.r", "order": "DESC", "format": "int"},
                {"key": "rbi", "label": "RBI", "col": "agg.rbi", "order": "DESC", "format": "int"},
                {"key": "bb", "label": "BB", "col": "agg.bb", "order": "DESC", "format": "int"},
            ]

            def fetch_batting_split_leaders(cat):
                params = [season] + level_params + [min_pa_split, limit]
                cur.execute(f"""
                    WITH agg AS (
                        SELECT gb.player_id,
                            COUNT(DISTINCT (g.game_date, COALESCE(g.game_number, 1))) as games,
                            SUM(COALESCE(gb.at_bats, 0)) as ab,
                            SUM(COALESCE(gb.hits, 0)) as h,
                            SUM(COALESCE(gb.runs, 0)) as r,
                            SUM(COALESCE(gb.rbi, 0)) as rbi,
                            SUM(COALESCE(gb.walks, 0)) as bb,
                            SUM(COALESCE(gb.strikeouts, 0)) as k,
                            SUM(COALESCE(gb.at_bats,0)) + SUM(COALESCE(gb.walks,0)) as pa,
                            CASE WHEN SUM(COALESCE(gb.at_bats,0)) > 0
                                 THEN ROUND(SUM(COALESCE(gb.hits,0))::numeric / SUM(gb.at_bats), 3)
                                 ELSE NULL END as avg,
                            CASE WHEN SUM(COALESCE(gb.at_bats,0)) + SUM(COALESCE(gb.walks,0)) > 0
                                 THEN ROUND((SUM(COALESCE(gb.hits,0)) + SUM(COALESCE(gb.walks,0)))::numeric / (SUM(COALESCE(gb.at_bats,0)) + SUM(COALESCE(gb.walks,0))), 3)
                                 ELSE NULL END as obp
                        FROM game_batting gb
                        JOIN games g ON g.id = gb.game_id
                        JOIN players p2 ON p2.id = gb.player_id
                        WHERE g.season = %s AND g.status = 'final'
                          AND {home_road_condition}
                        GROUP BY gb.player_id
                    )
                    SELECT p.id as player_id, p.first_name, p.last_name, p.position,
                           t.id as team_id, t.short_name, t.logo_url,
                           d.level as division_level,
                           {cat['col']} as value,
                           true as is_qualified
                    FROM agg
                    JOIN players p ON agg.player_id = p.id
                    JOIN teams t ON p.team_id = t.id
                    JOIN conferences c ON t.conference_id = c.id
                    JOIN divisions d ON c.division_id = d.id
                    WHERE agg.pa >= %s
                      AND {cat['col']} IS NOT NULL
                      {level_filter}
                    ORDER BY {cat['col']} {cat['order']}
                    LIMIT %s
                """, params)
                rows = cur.fetchall()
                return {
                    "key": cat["key"],
                    "label": cat["label"],
                    "format": cat["format"],
                    "leaders": [dict(r) for r in rows],
                }

            # Pitching splits - same logic: use player's team from players table
            if is_home:
                pit_home_road_condition = "p2.team_id = g.home_team_id"
            else:
                pit_home_road_condition = "(p2.team_id = g.away_team_id OR (g.away_team_id IS NULL AND p2.team_id != g.home_team_id))"
            min_ip_split = 10

            pitching_split_categories = [
                {"key": "era", "label": "ERA", "col": "agg.era", "order": "ASC", "format": "float2"},
                {"key": "whip", "label": "WHIP", "col": "agg.whip", "order": "ASC", "format": "float2"},
                {"key": "strikeouts", "label": "K", "col": "agg.k", "order": "DESC", "format": "int"},
                {"key": "k_per_9", "label": "K/9", "col": "agg.k_per_9", "order": "DESC", "format": "float1"},
                {"key": "wins", "label": "W", "col": "agg.w", "order": "DESC", "format": "int", "skip_ip_min": True},
                {"key": "saves", "label": "SV", "col": "agg.sv", "order": "DESC", "format": "int", "skip_ip_min": True},
            ]

            def fetch_pitching_split_leaders(cat):
                skip_ip = cat.get("skip_ip_min", False)
                if skip_ip:
                    ip_filter = "agg.real_ip > 0"
                    params = [season] + level_params + [limit]
                else:
                    ip_filter = "agg.real_ip >= %s"
                    params = [season] + level_params + [min_ip_split, limit]
                cur.execute(f"""
                    WITH agg AS (
                        SELECT gp.player_id,
                            COUNT(DISTINCT (g.game_date, COALESCE(g.game_number, 1))) as games,
                            SUM(CASE WHEN gp.is_starter THEN 1 ELSE 0 END) as gs,
                            SUM(CASE WHEN UPPER(gp.decision) = 'W' THEN 1 ELSE 0 END) as w,
                            SUM(CASE WHEN UPPER(gp.decision) = 'L' THEN 1 ELSE 0 END) as l,
                            SUM(CASE WHEN UPPER(gp.decision) IN ('SV', 'S') THEN 1 ELSE 0 END) as sv,
                            outs_to_ip(SUM(ip_outs(COALESCE(gp.innings_pitched, 0)))) as ip_raw,
                            SUM(COALESCE(gp.hits_allowed, 0)) as h,
                            SUM(COALESCE(gp.earned_runs, 0)) as er,
                            SUM(COALESCE(gp.walks, 0)) as bb,
                            SUM(COALESCE(gp.strikeouts, 0)) as k,
                            SUM(COALESCE(gp.home_runs_allowed, 0)) as hr,
                            SUM(COALESCE(gp.batters_faced, 0)) as bf,
                            -- Convert fractional IP (5.1 = 5 1/3) to real innings
                            (SUM(FLOOR(COALESCE(gp.innings_pitched, 0))) + SUM(COALESCE(gp.innings_pitched, 0) - FLOOR(COALESCE(gp.innings_pitched, 0))) * 10.0 / 3.0)::numeric as real_ip,
                            CASE WHEN (SUM(FLOOR(COALESCE(gp.innings_pitched,0))) + SUM(COALESCE(gp.innings_pitched,0) - FLOOR(COALESCE(gp.innings_pitched,0))) * 10.0 / 3.0)::numeric > 0
                                 THEN ROUND(SUM(COALESCE(gp.earned_runs,0))::numeric * 9 / (SUM(FLOOR(COALESCE(gp.innings_pitched,0))) + SUM(COALESCE(gp.innings_pitched,0) - FLOOR(COALESCE(gp.innings_pitched,0))) * 10.0 / 3.0)::numeric, 2)
                                 ELSE NULL END as era,
                            CASE WHEN (SUM(FLOOR(COALESCE(gp.innings_pitched,0))) + SUM(COALESCE(gp.innings_pitched,0) - FLOOR(COALESCE(gp.innings_pitched,0))) * 10.0 / 3.0)::numeric > 0
                                 THEN ROUND((SUM(COALESCE(gp.walks,0)) + SUM(COALESCE(gp.hits_allowed,0)))::numeric / (SUM(FLOOR(COALESCE(gp.innings_pitched,0))) + SUM(COALESCE(gp.innings_pitched,0) - FLOOR(COALESCE(gp.innings_pitched,0))) * 10.0 / 3.0)::numeric, 2)
                                 ELSE NULL END as whip,
                            CASE WHEN (SUM(FLOOR(COALESCE(gp.innings_pitched,0))) + SUM(COALESCE(gp.innings_pitched,0) - FLOOR(COALESCE(gp.innings_pitched,0))) * 10.0 / 3.0)::numeric > 0
                                 THEN ROUND(SUM(COALESCE(gp.strikeouts,0))::numeric * 9 / (SUM(FLOOR(COALESCE(gp.innings_pitched,0))) + SUM(COALESCE(gp.innings_pitched,0) - FLOOR(COALESCE(gp.innings_pitched,0))) * 10.0 / 3.0)::numeric, 1)
                                 ELSE NULL END as k_per_9
                        FROM game_pitching gp
                        JOIN games g ON g.id = gp.game_id
                        JOIN players p2 ON p2.id = gp.player_id
                        WHERE g.season = %s AND g.status = 'final'
                          AND {pit_home_road_condition}
                        GROUP BY gp.player_id
                    )
                    SELECT p.id as player_id, p.first_name, p.last_name,
                           t.id as team_id, t.short_name, t.logo_url,
                           d.level as division_level,
                           {cat['col']} as value,
                           true as is_qualified
                    FROM agg
                    JOIN players p ON agg.player_id = p.id
                    JOIN teams t ON p.team_id = t.id
                    JOIN conferences c ON t.conference_id = c.id
                    JOIN divisions d ON c.division_id = d.id
                    WHERE {ip_filter}
                      AND {cat['col']} IS NOT NULL
                      {level_filter}
                    ORDER BY {cat['col']} {cat['order']}
                    LIMIT %s
                """, params)
                rows = cur.fetchall()
                return {
                    "key": cat["key"],
                    "label": cat["label"],
                    "format": cat["format"],
                    "leaders": [dict(r) for r in rows],
                }

            return {
                "batting": [fetch_batting_split_leaders(c) for c in batting_split_categories],
                "pitching": [fetch_pitching_split_leaders(c) for c in pitching_split_categories],
            }

        # ── Normal mode: use pre-aggregated season stats ──
        batting_categories = [
            {"key": "wrc_plus", "label": "wRC+", "col": "bs.wrc_plus", "order": "DESC", "format": "int"},
            {"key": "offensive_war", "label": "WAR", "col": "bs.offensive_war", "order": "DESC", "format": "float1"},
            {"key": "home_runs", "label": "HR", "col": "bs.home_runs", "order": "DESC", "format": "int"},
            {"key": "xbh", "label": "XBH", "col": "(bs.doubles + bs.triples + bs.home_runs)", "order": "DESC", "format": "int"},
            {"key": "stolen_bases", "label": "SB", "col": "bs.stolen_bases", "order": "DESC", "format": "int"},
            {"key": "batting_avg", "label": "AVG", "col": "bs.batting_avg", "order": "DESC", "format": "avg"},
            {"key": "iso", "label": "ISO", "col": "bs.iso", "order": "DESC", "format": "avg"},
            {"key": "wobacon", "label": "wOBACON", "col": "bs.wobacon", "order": "DESC", "format": "avg"},
            {"key": "bb_pct", "label": "BB%", "col": "bs.bb_pct", "order": "DESC", "format": "pct"},
            {"key": "k_pct_low", "label": "Low K%", "col": "bs.k_pct", "order": "ASC", "format": "pct"},
        ]

        pitching_categories = [
            {"key": "pitching_war", "label": "pWAR", "col": "ps.pitching_war", "order": "DESC", "format": "float1"},
            {"key": "fip_plus", "label": "FIP+", "col": "ps.fip_plus", "order": "DESC", "format": "int"},
            {"key": "quality_starts", "label": "QS", "col": "COALESCE(ps.quality_starts, 0)", "order": "DESC", "format": "int"},
            {"key": "strikeouts", "label": "K", "col": "ps.strikeouts", "order": "DESC", "format": "int"},
            {"key": "k_minus_bb_pct", "label": "K-BB%", "col": "(ps.k_pct - ps.bb_pct)", "order": "DESC", "format": "pct"},
            {"key": "era", "label": "ERA", "col": "ps.era", "order": "ASC", "format": "float2"},
            {"key": "bb_pct_low", "label": "Low BB%", "col": "ps.bb_pct", "order": "ASC", "format": "pct"},
            {"key": "wins", "label": "W", "col": "ps.wins", "order": "DESC", "format": "int", "skip_ip_min": True},
            {"key": "saves", "label": "SV", "col": "ps.saves", "order": "DESC", "format": "int", "skip_ip_min": True},
        ]

        def fetch_batting_leaders(cat):
            q_join = QUALIFIED_BATTING_JOIN if qualified else ""
            q_where = QUALIFIED_BATTING_WHERE if qualified else ""
            params = [season, min_pa] + level_params + [limit]
            cur.execute(f"""
                SELECT p.id as player_id, p.first_name, p.last_name, p.position,
                       t.id as team_id, t.short_name, t.logo_url,
                       d.level as division_level,
                       {cat['col']} as value,
                       CASE WHEN bs.plate_appearances >= {QUALIFIED_PA_PER_GAME} * (COALESCE(tss2.wins,0) + COALESCE(tss2.losses,0) + COALESCE(tss2.ties,0))
                            THEN true ELSE false END as is_qualified
                FROM batting_stats bs
                JOIN players p ON bs.player_id = p.id
                JOIN teams t ON bs.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                LEFT JOIN team_season_stats tss2
                  ON tss2.team_id = bs.team_id AND tss2.season = bs.season
                {q_join}
                WHERE bs.season = %s AND bs.plate_appearances >= %s
                  AND {cat['col']} IS NOT NULL
                  {q_where}
                  {level_filter}
                ORDER BY {cat['col']} {cat['order']}
                LIMIT %s
            """, params)
            rows = cur.fetchall()
            return {
                "key": cat["key"],
                "label": cat["label"],
                "format": cat["format"],
                "leaders": [dict(r) for r in rows],
            }

        def fetch_pitching_leaders(cat):
            # For counting stats (W, SV), skip ALL IP minimums so relievers/closers appear
            skip_ip = cat.get("skip_ip_min", False)
            if skip_ip:
                q_join = ""
                q_where = ""
                ip_condition = "ps.innings_pitched > 0"
                params = [season] + level_params + [limit]
            else:
                q_join = QUALIFIED_PITCHING_JOIN if qualified else ""
                q_where = QUALIFIED_PITCHING_WHERE if qualified else ""
                ip_condition = "ps.innings_pitched >= %s"
                params = [season, min_ip] + level_params + [limit]
            cur.execute(f"""
                SELECT p.id as player_id, p.first_name, p.last_name,
                       t.id as team_id, t.short_name, t.logo_url,
                       d.level as division_level,
                       {cat['col']} as value,
                       CASE WHEN {PITCHING_TRUE_IP_SQL} >= {QUALIFIED_IP_PER_GAME} * (COALESCE(tss2.wins,0) + COALESCE(tss2.losses,0) + COALESCE(tss2.ties,0))
                            THEN true ELSE false END as is_qualified
                FROM pitching_stats ps
                JOIN players p ON ps.player_id = p.id
                JOIN teams t ON ps.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                LEFT JOIN team_season_stats tss2
                  ON tss2.team_id = ps.team_id AND tss2.season = ps.season
                {q_join}
                WHERE ps.season = %s AND {ip_condition}
                  AND {cat['col']} IS NOT NULL
                  {q_where}
                  {level_filter}
                ORDER BY {cat['col']} {cat['order']}
                LIMIT %s
            """, params)
            rows = cur.fetchall()
            return {
                "key": cat["key"],
                "label": cat["label"],
                "format": cat["format"],
                "leaders": [dict(r) for r in rows],
            }

        return {
            "batting": [fetch_batting_leaders(c) for c in batting_categories],
            "pitching": [fetch_pitching_leaders(c) for c in pitching_categories],
        }


# ── Records (single-season, career, team) ─────────────────────

_BATTING_RECORD_STATS = [
    {"key": "avg", "label": "Batting Average", "col": "batting_avg", "order": "DESC", "rate": True, "format": "avg"},
    {"key": "obp", "label": "On-Base Pct", "col": "on_base_pct", "order": "DESC", "rate": True, "format": "avg"},
    {"key": "slg", "label": "Slugging Pct", "col": "slugging_pct", "order": "DESC", "rate": True, "format": "avg"},
    {"key": "ops", "label": "OPS", "col": "ops", "order": "DESC", "rate": True, "format": "avg"},
    {"key": "woba", "label": "wOBA", "col": "woba", "order": "DESC", "rate": True, "format": "avg"},
    {"key": "wobacon", "label": "wOBACON", "col": "wobacon", "order": "DESC", "rate": True, "format": "avg"},
    {"key": "wrc_plus", "label": "wRC+", "col": "wrc_plus", "order": "DESC", "rate": True, "format": "int"},
    {"key": "iso", "label": "ISO", "col": "iso", "order": "DESC", "rate": True, "format": "avg"},
    {"key": "hr", "label": "Home Runs", "col": "home_runs", "order": "DESC", "rate": False, "format": "int"},
    {"key": "rbi", "label": "RBI", "col": "rbi", "order": "DESC", "rate": False, "format": "int"},
    {"key": "sb", "label": "Stolen Bases", "col": "stolen_bases", "order": "DESC", "rate": False, "format": "int"},
    {"key": "runs", "label": "Runs", "col": "runs", "order": "DESC", "rate": False, "format": "int"},
    {"key": "hits", "label": "Hits", "col": "hits", "order": "DESC", "rate": False, "format": "int"},
    {"key": "doubles", "label": "Doubles", "col": "doubles", "order": "DESC", "rate": False, "format": "int"},
    {"key": "triples", "label": "Triples", "col": "triples", "order": "DESC", "rate": False, "format": "int"},
    {"key": "owar", "label": "oWAR", "col": "offensive_war", "order": "DESC", "rate": False, "format": "war"},
]

_PITCHING_RECORD_STATS = [
    {"key": "era", "label": "ERA", "col": "era", "order": "ASC", "rate": True, "format": "era"},
    {"key": "fip", "label": "FIP", "col": "fip", "order": "ASC", "rate": True, "format": "era"},
    {"key": "whip", "label": "WHIP", "col": "whip", "order": "ASC", "rate": True, "format": "era"},
    {"key": "k_per_9", "label": "K/9", "col": "k_per_9", "order": "DESC", "rate": True, "format": "era"},
    {"key": "bb_per_9", "label": "BB/9", "col": "bb_per_9", "order": "ASC", "rate": True, "format": "era"},
    {"key": "k_pct", "label": "K%", "col": "k_pct", "order": "DESC", "rate": True, "format": "pct"},
    {"key": "fip_plus", "label": "FIP+", "col": "fip_plus", "order": "DESC", "rate": True, "format": "int"},
    {"key": "wins", "label": "Wins", "col": "wins", "order": "DESC", "rate": False, "format": "int"},
    {"key": "saves", "label": "Saves", "col": "saves", "order": "DESC", "rate": False, "format": "int"},
    {"key": "strikeouts", "label": "Strikeouts", "col": "strikeouts", "order": "DESC", "rate": False, "format": "int"},
    {"key": "ip", "label": "Innings Pitched", "col": "innings_pitched", "order": "DESC", "rate": False, "format": "ip"},
    {"key": "pwar", "label": "pWAR", "col": "pitching_war", "order": "DESC", "rate": False, "format": "war"},
]

_TEAM_BATTING_STATS = [
    {"key": "team_avg", "label": "Team AVG", "col": "avg", "order": "DESC", "format": "avg"},
    {"key": "team_runs", "label": "Runs Scored", "col": "total_runs", "order": "DESC", "format": "int"},
    {"key": "team_hr", "label": "Team HR", "col": "total_hr", "order": "DESC", "format": "int"},
    {"key": "team_sb", "label": "Team SB", "col": "total_sb", "order": "DESC", "format": "int"},
    {"key": "team_wrc_plus", "label": "Team wRC+", "col": "avg_wrc_plus", "order": "DESC", "format": "int"},
    {"key": "team_owar", "label": "Team oWAR", "col": "total_owar", "order": "DESC", "format": "war"},
    {"key": "team_hbp", "label": "Team HBP", "col": "total_hbp", "order": "DESC", "format": "int"},
    {"key": "team_doubles", "label": "Team Doubles", "col": "total_doubles", "order": "DESC", "format": "int"},
]

_TEAM_PITCHING_STATS = [
    {"key": "team_era", "label": "Team ERA", "col": "team_era", "order": "ASC", "format": "era"},
    {"key": "team_fip", "label": "Team FIP", "col": "avg_fip", "order": "ASC", "format": "era"},
    {"key": "team_whip", "label": "Team WHIP", "col": "team_whip", "order": "ASC", "format": "era"},
    {"key": "team_k", "label": "Team Strikeouts", "col": "total_k", "order": "DESC", "format": "int"},
    {"key": "team_pwar", "label": "Team pWAR", "col": "total_pwar", "order": "DESC", "format": "war"},
    {"key": "team_saves", "label": "Team Saves", "col": "total_saves", "order": "DESC", "format": "int"},
]

LEVELS = ["D1", "D2", "D3", "NAIA", "JUCO"]


@router.get("/records")
@cached_endpoint(ttl_seconds=1800)
def stat_records(
    limit: int = Query(5, description="Number of records per category"),
):
    """Single-season records, career records, and team records across all divisions."""
    with get_connection() as conn:
        cur = conn.cursor()

        # ── Helpers ──

        def _build_leaders(rows, stat_cfg, n):
            """Sort rows by a stat column and return top N."""
            col = stat_cfg["col"]
            desc = stat_cfg["order"] == "DESC"
            valid = [r for r in rows if r.get(col) is not None]
            valid.sort(key=lambda r: r[col], reverse=desc)
            out = []
            for r in valid[:n]:
                out.append({
                    "player_id": r["player_id"],
                    "first_name": r["first_name"],
                    "last_name": r["last_name"],
                    "team_short": r["team_short"],
                    "logo_url": r.get("logo_url"),
                    "division_level": r.get("division_level", ""),
                    "season": r.get("season"),
                    "value": r[col],
                })
            return out

        def _build_team_leaders(rows, stat_cfg, n):
            col = stat_cfg["col"]
            desc = stat_cfg["order"] == "DESC"
            valid = [r for r in rows if r.get(col) is not None]
            valid.sort(key=lambda r: r[col], reverse=desc)
            out = []
            for r in valid[:n]:
                out.append({
                    "team_id": r["team_id"],
                    "team_short": r["team_short"],
                    "logo_url": r.get("logo_url"),
                    "division_level": r.get("division_level", ""),
                    "season": r["season"],
                    "value": r[col],
                })
            return out

        # ── 1) Single-season batting ──
        cur.execute("""
            SELECT bs.player_id, p.first_name, p.last_name,
                   t.short_name as team_short, t.logo_url,
                   d.level as division_level, bs.season,
                   bs.batting_avg, bs.on_base_pct, bs.slugging_pct, bs.ops,
                   bs.woba, bs.wobacon, bs.wrc_plus, bs.iso,
                   bs.home_runs, bs.rbi, bs.stolen_bases, bs.runs,
                   bs.hits, bs.doubles, bs.triples, bs.offensive_war,
                   bs.plate_appearances
            FROM batting_stats bs
            JOIN players p ON bs.player_id = p.id
            JOIN teams t ON bs.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN team_season_stats tss
              ON tss.team_id = bs.team_id AND tss.season = bs.season
            WHERE bs.plate_appearances >= 2.0 * (COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0))
              AND bs.plate_appearances >= 100
        """)
        all_bat_seasons = [dict(r) for r in cur.fetchall()]

        # Also fetch rows for counting stats (same 100 PA minimum)
        cur.execute("""
            SELECT bs.player_id, p.first_name, p.last_name,
                   t.short_name as team_short, t.logo_url,
                   d.level as division_level, bs.season,
                   bs.home_runs, bs.rbi, bs.stolen_bases, bs.runs,
                   bs.hits, bs.doubles, bs.triples, bs.offensive_war,
                   bs.plate_appearances
            FROM batting_stats bs
            JOIN players p ON bs.player_id = p.id
            JOIN teams t ON bs.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE bs.plate_appearances >= 100
        """)
        all_bat_counting = [dict(r) for r in cur.fetchall()]

        # ── 2) Single-season pitching ──
        cur.execute("""
            SELECT ps.player_id, p.first_name, p.last_name,
                   t.short_name as team_short, t.logo_url,
                   d.level as division_level, ps.season,
                   ps.era, ps.fip, ps.whip, ps.k_per_9, ps.bb_per_9,
                   ps.k_pct, ps.fip_plus,
                   ps.wins, ps.saves, ps.strikeouts, ps.innings_pitched,
                   ps.pitching_war
            FROM pitching_stats ps
            JOIN players p ON ps.player_id = p.id
            JOIN teams t ON ps.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN team_season_stats tss
              ON tss.team_id = ps.team_id AND tss.season = ps.season
            WHERE """ + PITCHING_TRUE_IP_SQL + """ >= 0.75 * (COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0))
              AND ps.innings_pitched >= 40
        """)
        all_pit_seasons = [dict(r) for r in cur.fetchall()]

        cur.execute("""
            SELECT ps.player_id, p.first_name, p.last_name,
                   t.short_name as team_short, t.logo_url,
                   d.level as division_level, ps.season,
                   ps.wins, ps.saves, ps.strikeouts, ps.innings_pitched,
                   ps.pitching_war
            FROM pitching_stats ps
            JOIN players p ON ps.player_id = p.id
            JOIN teams t ON ps.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE ps.innings_pitched >= 40
        """)
        all_pit_counting = [dict(r) for r in cur.fetchall()]

        # ── 3) Career batting ──
        cur.execute("""
            SELECT bs.player_id, p.first_name, p.last_name,
                   t.short_name as team_short, t.logo_url,
                   d.level as division_level,
                   SUM(bs.plate_appearances) as plate_appearances,
                   SUM(bs.at_bats) as at_bats,
                   SUM(bs.hits) as hits,
                   SUM(bs.doubles) as doubles,
                   SUM(bs.triples) as triples,
                   SUM(bs.home_runs) as home_runs,
                   SUM(bs.rbi) as rbi,
                   SUM(bs.runs) as runs,
                   SUM(bs.stolen_bases) as stolen_bases,
                   SUM(bs.walks) as walks,
                   SUM(bs.hit_by_pitch) as hbp,
                   SUM(bs.sacrifice_flies) as sf,
                   SUM(bs.offensive_war) as offensive_war
            FROM batting_stats bs
            JOIN players p ON bs.player_id = p.id
            JOIN teams t ON p.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            GROUP BY bs.player_id, p.first_name, p.last_name,
                     t.short_name, t.logo_url, d.level
            HAVING SUM(bs.plate_appearances) >= 250
        """)
        career_bat_rows = []
        for r in cur.fetchall():
            d = dict(r)
            ab = d["at_bats"] or 0
            pa = d["plate_appearances"] or 0
            h = d["hits"] or 0
            bb = d["walks"] or 0
            hbp_v = d["hbp"] or 0
            sf = d["sf"] or 0
            doubles = d["doubles"] or 0
            triples = d["triples"] or 0
            hr = d["home_runs"] or 0
            tb = h + doubles + 2 * triples + 3 * hr
            d["batting_avg"] = round(h / ab, 3) if ab > 0 else None
            d["on_base_pct"] = round((h + bb + hbp_v) / (ab + bb + hbp_v + sf), 3) if (ab + bb + hbp_v + sf) > 0 else None
            d["slugging_pct"] = round(tb / ab, 3) if ab > 0 else None
            d["ops"] = round((d["on_base_pct"] or 0) + (d["slugging_pct"] or 0), 3)
            d["iso"] = round((d["slugging_pct"] or 0) - (d["batting_avg"] or 0), 3)
            d["season"] = None  # career
            career_bat_rows.append(d)

        # ── 4) Career pitching ──
        cur.execute("""
            SELECT ps.player_id, p.first_name, p.last_name,
                   t.short_name as team_short, t.logo_url,
                   d.level as division_level,
                   outs_to_ip(SUM(ip_outs(ps.innings_pitched))) as innings_pitched,
                   (SUM(ip_outs(ps.innings_pitched)) / 3.0)::float8 as ip_true,
                   SUM(ps.earned_runs) as earned_runs,
                   SUM(ps.hits_allowed) as hits_allowed,
                   SUM(ps.walks) as walks,
                   SUM(ps.strikeouts) as strikeouts,
                   SUM(ps.home_runs_allowed) as hr_allowed,
                   SUM(ps.wins) as wins,
                   SUM(ps.saves) as saves,
                   SUM(ps.pitching_war) as pitching_war
            FROM pitching_stats ps
            JOIN players p ON ps.player_id = p.id
            JOIN teams t ON p.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            GROUP BY ps.player_id, p.first_name, p.last_name,
                     t.short_name, t.logo_url, d.level
            HAVING SUM(ip_outs(ps.innings_pitched)) / 3.0 >= 100
        """)
        career_pit_rows = []
        for r in cur.fetchall():
            d = dict(r)
            ip = d.pop("ip_true", None) or 0  # true decimal innings for rate math
            er = d["earned_runs"] or 0
            h_a = d["hits_allowed"] or 0
            bb = d["walks"] or 0
            k = d["strikeouts"] or 0
            hr_a = d["hr_allowed"] or 0
            d["era"] = round((er / ip) * 9, 2) if ip > 0 else None
            d["whip"] = round((bb + h_a) / ip, 2) if ip > 0 else None
            d["k_per_9"] = round((k / ip) * 9, 2) if ip > 0 else None
            d["bb_per_9"] = round((bb / ip) * 9, 2) if ip > 0 else None
            d["season"] = None
            career_pit_rows.append(d)

        # ── 5) Team single-season batting ──
        cur.execute("""
            SELECT bs.team_id, t.short_name as team_short, t.logo_url,
                   d.level as division_level, bs.season,
                   CASE WHEN SUM(bs.at_bats) > 0
                        THEN ROUND(SUM(bs.hits)::numeric / SUM(bs.at_bats)::numeric, 3) END as avg,
                   SUM(bs.runs) as total_runs,
                   SUM(bs.home_runs) as total_hr,
                   SUM(bs.stolen_bases) as total_sb,
                   SUM(bs.doubles) as total_doubles,
                   SUM(bs.hit_by_pitch) as total_hbp,
                   SUM(bs.offensive_war) as total_owar,
                   CASE WHEN SUM(bs.plate_appearances) FILTER (WHERE bs.wrc_plus IS NOT NULL) > 0
                        THEN ROUND(
                          SUM(bs.wrc_plus * bs.plate_appearances) FILTER (WHERE bs.wrc_plus IS NOT NULL)::numeric
                          / SUM(bs.plate_appearances) FILTER (WHERE bs.wrc_plus IS NOT NULL)::numeric, 1)
                        END as avg_wrc_plus
            FROM batting_stats bs
            JOIN teams t ON bs.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE bs.plate_appearances > 0
              AND bs.season != 2020
            GROUP BY bs.team_id, t.short_name, t.logo_url, d.level, bs.season
        """)
        all_team_bat = [dict(r) for r in cur.fetchall()]

        # ── 6) Team single-season pitching ──
        cur.execute("""
            SELECT ps.team_id, t.short_name as team_short, t.logo_url,
                   d.level as division_level, ps.season,
                   CASE WHEN SUM(ip_outs(ps.innings_pitched)) > 0
                        THEN ROUND((SUM(ps.earned_runs)::numeric / (SUM(ip_outs(ps.innings_pitched))/3.0)) * 9, 2) END as team_era,
                   CASE WHEN SUM(ip_outs(ps.innings_pitched)) > 0
                        THEN ROUND(SUM(ps.walks + ps.hits_allowed)::numeric / (SUM(ip_outs(ps.innings_pitched))/3.0), 2) END as team_whip,
                   CASE WHEN SUM(ip_outs(ps.innings_pitched)) FILTER (WHERE ps.fip IS NOT NULL) > 0
                        THEN ROUND(
                          SUM(ps.fip * ip_outs(ps.innings_pitched)) FILTER (WHERE ps.fip IS NOT NULL)::numeric
                          / SUM(ip_outs(ps.innings_pitched)) FILTER (WHERE ps.fip IS NOT NULL)::numeric, 2)
                        END as avg_fip,
                   SUM(ps.strikeouts) as total_k,
                   SUM(ps.saves) as total_saves,
                   SUM(ps.pitching_war) as total_pwar
            FROM pitching_stats ps
            JOIN teams t ON ps.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE ps.innings_pitched > 0
              AND ps.season != 2020
            GROUP BY ps.team_id, t.short_name, t.logo_url, d.level, ps.season
        """)
        all_team_pit = [dict(r) for r in cur.fetchall()]

        # ── Build response per level + PNW ──
        result = {"batting": {}, "pitching": {}, "team": {}}

        for level in LEVELS + ["PNW"]:
            # Filter rows for this level
            if level == "PNW":
                bat_q = all_bat_seasons
                bat_c = all_bat_counting
                pit_q = all_pit_seasons
                pit_c = all_pit_counting
                car_b = career_bat_rows
                car_p = career_pit_rows
                tb = all_team_bat
                tp = all_team_pit
            else:
                bat_q = [r for r in all_bat_seasons if r["division_level"] == level]
                bat_c = [r for r in all_bat_counting if r["division_level"] == level]
                pit_q = [r for r in all_pit_seasons if r["division_level"] == level]
                pit_c = [r for r in all_pit_counting if r["division_level"] == level]
                car_b = [r for r in career_bat_rows if r["division_level"] == level]
                car_p = [r for r in career_pit_rows if r["division_level"] == level]
                tb = [r for r in all_team_bat if r["division_level"] == level]
                tp = [r for r in all_team_pit if r["division_level"] == level]

            # Single-season batting
            ss_bat = {}
            for s in _BATTING_RECORD_STATS:
                source = bat_q if s["rate"] else bat_c
                ss_bat[s["key"]] = {
                    "label": s["label"],
                    "format": s["format"],
                    "order": s["order"],
                    "leaders": _build_leaders(source, s, limit),
                }

            # Single-season pitching
            ss_pit = {}
            for s in _PITCHING_RECORD_STATS:
                source = pit_q if s["rate"] else pit_c
                ss_pit[s["key"]] = {
                    "label": s["label"],
                    "format": s["format"],
                    "order": s["order"],
                    "leaders": _build_leaders(source, s, limit),
                }

            # Career batting
            cr_bat = {}
            for s in _BATTING_RECORD_STATS:
                if s["col"] in ("woba", "wobacon", "wrc_plus"):
                    continue  # can't reliably aggregate league-adjusted career rates
                cr_bat[s["key"]] = {
                    "label": s["label"],
                    "format": s["format"],
                    "order": s["order"],
                    "leaders": _build_leaders(car_b, s, limit),
                }

            # Career pitching
            cr_pit = {}
            for s in _PITCHING_RECORD_STATS:
                if s["col"] in ("fip_plus", "fip", "k_pct"):
                    continue  # can't reliably aggregate league-adjusted career rates
                cr_pit[s["key"]] = {
                    "label": s["label"],
                    "format": s["format"],
                    "order": s["order"],
                    "leaders": _build_leaders(car_p, s, limit),
                }

            # Team single-season
            tm = {}
            for s in _TEAM_BATTING_STATS:
                tm[s["key"]] = {
                    "label": s["label"],
                    "format": s["format"],
                    "order": s["order"],
                    "leaders": _build_team_leaders(tb, s, limit),
                }
            for s in _TEAM_PITCHING_STATS:
                tm[s["key"]] = {
                    "label": s["label"],
                    "format": s["format"],
                    "order": s["order"],
                    "leaders": _build_team_leaders(tp, s, limit),
                }

            result["batting"][level] = {"single_season": ss_bat, "career": cr_bat}
            result["pitching"][level] = {"single_season": ss_pit, "career": cr_pit}
            result["team"][level] = {"single_season": tm}

        return result


@router.get("/team-ratings")
@cached_endpoint(ttl_seconds=1800)
def team_ratings(
    season: int = Query(..., description="Season year"),
):
    """
    Composite Power Index (CPI) ratings for all teams, grouped by division.

    CPI is a predictive, SoS-adjusted power rating centered at 100 (division
    average), higher = better. Engine in app.stats.cpi (same engine as the
    summer /summer/cpi endpoint); rankings are within-division. The query
    also keeps the raw team aggregates (team_war / team_wrc_plus / team_fip
    and W-L) that graphics pages read alongside the rating.
    """
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT t.id, t.short_name, t.logo_url, t.city, t.state,
                   c.id as conference_id, c.name as conference_name,
                   c.abbreviation as conference_abbrev,
                   d.id as division_id, d.name as division_name, d.level as division_level,
                   COALESCE(s.wins, 0) as wins, COALESCE(s.losses, 0) as losses,
                   COALESCE(s.conference_wins, 0) as conf_wins,
                   COALESCE(s.conference_losses, 0) as conf_losses,
                   COALESCE(bat.total_owar, 0) as team_owar,
                   COALESCE(pit.total_pwar, 0) as team_pwar,
                   COALESCE(bat.total_owar, 0) + COALESCE(pit.total_pwar, 0) as team_war,
                   COALESCE(bat.team_wrc_plus, 100) as team_wrc_plus,
                   COALESCE(pit.team_fip, 4.5) as team_fip
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
            LEFT JOIN (
                SELECT team_id,
                    SUM(offensive_war) as total_owar,
                    SUM(wrc_plus * plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL)
                      / NULLIF(SUM(plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL), 0) as team_wrc_plus
                FROM batting_stats WHERE season = %s
                GROUP BY team_id
            ) bat ON bat.team_id = t.id
            LEFT JOIN (
                SELECT team_id,
                    SUM(pitching_war) as total_pwar,
                    SUM(fip * ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL)
                      / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL), 0) as team_fip
                FROM pitching_stats WHERE season = %s
                GROUP BY team_id
            ) pit ON pit.team_id = t.id
            WHERE t.is_active = 1
              AND t.state IN ('WA', 'OR', 'ID', 'MT', 'BC')
            ORDER BY d.id, t.short_name
        """, (season, season, season))
        rows = cur.fetchall()

        # Group by division
        divisions = {}
        for r in rows:
            did = r["division_id"]
            if did not in divisions:
                divisions[did] = {
                    "division_id": did,
                    "division_name": r["division_name"],
                    "division_level": r["division_level"],
                    "teams": [],
                }
            team = dict(r)
            total = team["wins"] + team["losses"]
            team["win_pct"] = round(team["wins"] / total, 3) if total > 0 else 0.0
            conf_total = team["conf_wins"] + team["conf_losses"]
            team["conf_win_pct"] = round(team["conf_wins"] / conf_total, 3) if conf_total > 0 else 0.0
            divisions[did]["teams"].append(team)

        # Compute CPI per division (within-division power rankings)
        for div in divisions.values():
            season_games = SEASON_GAMES_BY_LEVEL.get(div["division_level"], 50)
            cpi_rows = compute_cpi_for_division(
                cur, [t["id"] for t in div["teams"]], season,
                season_games=season_games)
            cpi_by_id = {r["team_id"]: r for r in cpi_rows}
            for t in div["teams"]:
                extra = dict(cpi_by_id.get(t["id"], {}))
                extra.pop("team_id", None)
                t.update(extra)
            div["teams"].sort(key=lambda t: t.get("rank") or 10**6)

        return list(divisions.values())


@router.get("/national-rankings")
@cached_endpoint(ttl_seconds=1800)
def national_rankings(
    season: int = Query(..., description="Season year"),
):
    """
    National rankings for PNW teams using composite data from
    Pear Ratings, Massey Ratings, and CollegeBaseballRatings.

    Returns teams grouped by division with:
    - Composite rank (average of available sources)
    - Individual source ranks (Pear, Massey, CBR)
    - Strength of schedule (composite + per-source)
    - National percentile (within their division)
    - Cross-division comparison score
    """
    with get_connection() as conn:
        cur = conn.cursor()
        # Get composite rankings joined with team/division info
        cur.execute("""
            SELECT cr.*,
                   t.short_name, t.logo_url, t.school_name,
                   c.name as conference_name, c.abbreviation as conference_abbrev,
                   d.id as division_id, d.name as division_name, d.level as division_level,
                   COALESCE(s.wins, 0) as wins, COALESCE(s.losses, 0) as losses,
                   COALESCE(s.conference_wins, 0) as conf_wins,
                   COALESCE(s.conference_losses, 0) as conf_losses
            FROM composite_rankings cr
            JOIN teams t ON cr.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
            WHERE cr.season = %s
            ORDER BY d.id, cr.composite_rank
        """, (season, season))
        rows = cur.fetchall()

        # Also get individual source ratings for detail
        cur.execute("""
            SELECT nr.team_id, nr.source, nr.national_rank, nr.total_teams,
                   nr.rating, nr.sos, nr.sos_rank, nr.tsr, nr.rqi, nr.power_rating, nr.sor, nr.wab
            FROM national_ratings nr
            WHERE nr.season = %s
        """, (season,))
        source_ratings = cur.fetchall()

        # Build source lookup: team_id -> {source: data}
        source_map = {}
        for sr in source_ratings:
            tid = sr["team_id"]
            if tid not in source_map:
                source_map[tid] = {}
            source_map[tid][sr["source"]] = dict(sr)

        # Group by division
        divisions = {}
        for r in rows:
            did = r["division_id"]
            if did not in divisions:
                divisions[did] = {
                    "division_id": did,
                    "division_name": r["division_name"],
                    "division_level": r["division_level"],
                    "teams": [],
                }

            team = dict(r)
            team["sources"] = source_map.get(r["team_id"], {})

            # Compute record string
            total = team["wins"] + team["losses"]
            team["win_pct"] = round(team["wins"] / total, 3) if total > 0 else 0.0
            team["record"] = f"{team['wins']}-{team['losses']}"

            divisions[did]["teams"].append(team)

        # For teams without composite rankings (JUCO), include CPI data
        cur.execute("""
            SELECT t.id as team_id, t.short_name, t.logo_url, t.school_name,
                   c.name as conference_name, c.abbreviation as conference_abbrev,
                   d.id as division_id, d.name as division_name, d.level as division_level,
                   COALESCE(s.wins, 0) as wins, COALESCE(s.losses, 0) as losses,
                   COALESCE(s.conference_wins, 0) as conf_wins,
                   COALESCE(s.conference_losses, 0) as conf_losses
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
            WHERE d.level = 'JUCO' AND t.is_active = 1
            ORDER BY s.wins DESC
        """, (season,))
        juco_teams = cur.fetchall()

        if juco_teams:
            juco_div = {
                "division_id": juco_teams[0]["division_id"],
                "division_name": juco_teams[0]["division_name"],
                "division_level": "JUCO",
                "teams": [],
                "note": "NWAC teams use CPI (internal rating) - no external national rankings available for JUCO"
            }
            for r in juco_teams:
                team = dict(r)
                total = team["wins"] + team["losses"]
                team["win_pct"] = round(team["wins"] / total, 3) if total > 0 else 0.0
                team["record"] = f"{team['wins']}-{team['losses']}"
                team["composite_rank"] = None
                team["national_percentile"] = None
                team["sources"] = {}
                juco_div["teams"].append(team)
            divisions[juco_div["division_id"]] = juco_div

        # Build cross-division comparison (all non-JUCO teams ranked by percentile)
        all_ranked = []
        for div in divisions.values():
            for t in div["teams"]:
                if t.get("national_percentile"):
                    all_ranked.append({
                        "team_id": t["team_id"],
                        "short_name": t["short_name"],
                        "logo_url": t.get("logo_url"),
                        "division_level": div["division_level"],
                        "composite_rank": t.get("composite_rank"),
                        "national_percentile": t.get("national_percentile"),
                        "record": t.get("record"),
                        "num_sources": t.get("num_sources", 0),
                    })

        all_ranked.sort(key=lambda x: x["national_percentile"] or 0, reverse=True)

        return {
            "divisions": list(divisions.values()),
            "cross_division": all_ranked,
        }


# NOTE: /teams/compare and /teams/scatter MUST be declared before /teams/{team_id}
# so FastAPI doesn't try to parse "compare"/"scatter" as an int team_id.

@router.get("/teams/compare")
def compare_teams(
    season: int = Query(..., description="Season year"),
    team_ids: str = Query("", description="Comma-separated team IDs"),
):
    """
    Compare aggregate batting/pitching stats for selected teams.
    Returns one row per team with averaged and summed stats.
    """
    if not team_ids:
        return []

    ids = [int(x.strip()) for x in team_ids.split(",") if x.strip().isdigit()]
    if not ids or len(ids) > 10:
        return []

    with get_connection() as conn:
        cur = conn.cursor()
        results = []
        for tid in ids:
            cur.execute(
                """SELECT t.id, t.name, t.short_name, t.logo_url, t.city, t.state,
                          c.abbreviation as conference_abbrev,
                          d.level as division_level
                   FROM teams t
                   JOIN conferences c ON t.conference_id = c.id
                   JOIN divisions d ON c.division_id = d.id
                   WHERE t.id = %s""",
                (tid,),
            )
            team = cur.fetchone()
            if not team:
                continue

            cur.execute(
                """SELECT
                       COUNT(*) as num_batters,
                       SUM(plate_appearances) as total_pa,
                       SUM(at_bats) as total_ab,
                       SUM(hits) as total_h,
                       SUM(doubles) as total_2b,
                       SUM(triples) as total_3b,
                       SUM(home_runs) as total_hr,
                       SUM(runs) as total_r,
                       SUM(rbi) as total_rbi,
                       SUM(walks) as total_bb,
                       SUM(strikeouts) as total_k,
                       SUM(stolen_bases) as total_sb,
                       CASE WHEN SUM(at_bats) > 0
                            THEN ROUND((SUM(hits)::numeric / SUM(at_bats))::numeric, 3) ELSE 0 END as team_avg,
                       CASE WHEN SUM(plate_appearances) > 0
                            THEN ROUND(((SUM(hits) + SUM(walks) + SUM(hit_by_pitch))::numeric / SUM(plate_appearances))::numeric, 3) ELSE 0 END as team_obp,
                       CASE WHEN SUM(at_bats) > 0
                            THEN ROUND(((SUM(hits) - SUM(doubles) - SUM(triples) - SUM(home_runs) + 2*SUM(doubles) + 3*SUM(triples) + 4*SUM(home_runs))::numeric / SUM(at_bats))::numeric, 3) ELSE 0 END as team_slg,
                       -- Rate stats: PA-weighted with NULL guards. ISO is PA-weighted.
                       -- bb_pct/k_pct rebuilt from raw totals (truer than avg of rates).
                       ROUND((SUM(woba * plate_appearances) FILTER (WHERE woba IS NOT NULL)
                              / NULLIF(SUM(plate_appearances) FILTER (WHERE woba IS NOT NULL), 0))::numeric, 3) as avg_woba,
                       ROUND((SUM(wrc_plus * plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL)
                              / NULLIF(SUM(plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL), 0))::numeric, 0) as avg_wrc_plus,
                       ROUND((SUM(iso * plate_appearances) FILTER (WHERE iso IS NOT NULL)
                              / NULLIF(SUM(plate_appearances) FILTER (WHERE iso IS NOT NULL), 0))::numeric, 3) as avg_iso,
                       ROUND((SUM(walks)::numeric / NULLIF(SUM(plate_appearances), 0))::numeric, 3) as avg_bb_pct,
                       ROUND((SUM(strikeouts)::numeric / NULLIF(SUM(plate_appearances), 0))::numeric, 3) as avg_k_pct,
                       ROUND(SUM(offensive_war)::numeric, 1) as total_owar
                   FROM batting_stats
                   WHERE team_id = %s AND season = %s AND plate_appearances >= 10""",
                (tid, season),
            )
            batting_agg = cur.fetchone()

            cur.execute(
                """SELECT
                       COUNT(*) as num_pitchers,
                       outs_to_ip(SUM(ip_outs(innings_pitched))) as total_ip,
                       SUM(strikeouts) as total_k,
                       SUM(walks) as total_bb,
                       SUM(hits_allowed) as total_h,
                       SUM(earned_runs) as total_er,
                       SUM(home_runs_allowed) as total_hr,
                       SUM(hit_batters) as total_hbp,
                       CASE WHEN SUM(ip_outs(innings_pitched)) > 0
                            THEN ROUND((SUM(earned_runs) * 9.0 / NULLIF(SUM(ip_outs(innings_pitched)) / 3.0, 0))::numeric, 2) ELSE 0 END as team_era,
                       CASE WHEN SUM(ip_outs(innings_pitched)) > 0
                            THEN ROUND(((SUM(walks) + SUM(hits_allowed)) / NULLIF(SUM(ip_outs(innings_pitched)) / 3.0, 0))::numeric, 2) ELSE 0 END as team_whip,
                       -- Rate stats: IP-weighted with NULL guards.
                       -- k_pct/bb_pct rebuilt from raw totals over batters_faced.
                       ROUND((SUM(fip * ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL)
                              / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL), 0))::numeric, 2) as avg_fip,
                       ROUND((SUM(fip_plus * ip_outs(innings_pitched)) FILTER (WHERE fip_plus IS NOT NULL)
                              / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE fip_plus IS NOT NULL), 0))::numeric, 0) as avg_fip_plus,
                       ROUND((SUM(era_minus * ip_outs(innings_pitched)) FILTER (WHERE era_minus IS NOT NULL)
                              / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE era_minus IS NOT NULL), 0))::numeric, 0) as avg_era_minus,
                       ROUND((SUM(xfip * ip_outs(innings_pitched)) FILTER (WHERE xfip IS NOT NULL)
                              / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE xfip IS NOT NULL), 0))::numeric, 2) as avg_xfip,
                       ROUND((SUM(strikeouts)::numeric / NULLIF(SUM(batters_faced), 0))::numeric, 3) as avg_k_pct,
                       ROUND((SUM(walks)::numeric / NULLIF(SUM(batters_faced), 0))::numeric, 3) as avg_bb_pct,
                       ROUND(SUM(pitching_war)::numeric, 1) as total_pwar
                   FROM pitching_stats
                   WHERE team_id = %s AND season = %s AND innings_pitched >= 3""",
                (tid, season),
            )
            pitching_agg = cur.fetchone()

            # Team record
            cur.execute(
                """SELECT wins, losses, ties
                   FROM team_season_stats
                   WHERE team_id = %s AND season = %s""",
                (tid, season),
            )
            record = cur.fetchone()

            # Top 3 hitters by oWAR
            cur.execute(
                """SELECT p.id as player_id, p.first_name, p.last_name, p.position,
                          bs.batting_avg, bs.on_base_pct, bs.slugging_pct,
                          bs.home_runs, bs.rbi, bs.stolen_bases,
                          bs.wrc_plus, bs.woba, bs.offensive_war,
                          bs.plate_appearances, bs.hits, bs.iso
                   FROM batting_stats bs
                   JOIN players p ON bs.player_id = p.id
                   WHERE bs.team_id = %s AND bs.season = %s AND bs.plate_appearances >= 10
                   ORDER BY bs.offensive_war DESC NULLS LAST
                   LIMIT 3""",
                (tid, season),
            )
            top_hitters = [dict(r) for r in cur.fetchall()]

            # Top 3 pitchers by pWAR
            cur.execute(
                """SELECT p.id as player_id, p.first_name, p.last_name, p.position,
                          ps.era, ps.innings_pitched, ps.strikeouts, ps.walks,
                          ps.fip, ps.fip_plus, ps.pitching_war, ps.whip,
                          ps.k_pct, ps.bb_pct, ps.era_minus
                   FROM pitching_stats ps
                   JOIN players p ON ps.player_id = p.id
                   WHERE ps.team_id = %s AND ps.season = %s AND ps.innings_pitched >= 3
                   ORDER BY ps.pitching_war DESC NULLS LAST
                   LIMIT 3""",
                (tid, season),
            )
            top_pitchers = [_add_era_plus(dict(r)) for r in cur.fetchall()]

            # Override stale/buggy fields with canonical team aggregates so
            # team_era / team_whip / team_avg etc. match the team page and
            # the school's site. (See get_team_aggregates docstring.)
            canonical = get_team_aggregates(cur, tid, season)
            batting_dict = dict(batting_agg) if batting_agg else {}
            pitching_dict = dict(pitching_agg) if pitching_agg else {}
            if canonical:
                if canonical.get("team_era") is not None:
                    pitching_dict["team_era"] = canonical["team_era"]
                if canonical.get("team_whip") is not None:
                    pitching_dict["team_whip"] = canonical["team_whip"]
                if canonical.get("team_avg") is not None:
                    batting_dict["team_avg"] = canonical["team_avg"]
                if canonical.get("team_obp") is not None:
                    batting_dict["team_obp"] = canonical["team_obp"]
                if canonical.get("team_slg") is not None:
                    batting_dict["team_slg"] = canonical["team_slg"]
                if canonical.get("team_ops") is not None:
                    batting_dict["team_ops"] = canonical["team_ops"]

            row = dict(team)
            row["record"] = dict(record) if record else {"wins": 0, "losses": 0, "ties": 0}
            row["batting"] = batting_dict
            row["pitching"] = _add_era_plus(pitching_dict)
            row["top_hitters"] = top_hitters
            row["top_pitchers"] = top_pitchers
            row["total_war"] = round(
                float(batting_agg["total_owar"] or 0) + float(pitching_agg["total_pwar"] or 0), 1
            ) if batting_agg and pitching_agg else 0
            results.append(row)

        return results


# ── Matchup Predictor ───────────────────────────────────────
# Cross-division power rating + neutral-site win probability + run spread
#
# Research basis for division strength calibration:
#   - D2 teams win only 23.1% vs D1 (Hardball Times, 2008, 143 games)
#   - D1 produces 96.4% of NCAA draft picks; D2 3.2%; D3 0.5% (NCAA 2023)
#   - NAIA averages ~42 draft picks/year; scout consensus = D2-equivalent+
#   - Scholarship counts: D1=34, NAIA=12, D2=9, D3=0
#   - Top NAIA programs (Lewis-Clark State) compete at D2/low-D1 level
#   - Top JUCO players transfer to D1 annually; best programs rival mid-D1
#
# Architecture: DIVISION BANDS + ELO WIN PROBABILITY
# Each division has a rating floor and ceiling on the 0-100 scale.
# A team's within-division rank (from stats + national rankings) maps
# into that band. Overlapping bands create realistic cross-division
# matchups where top lower-division teams can beat bottom higher-division.
#
# Calibration targets (from PNW baseball knowledge):
#   - Avg D1 vs Avg D2:           ~85-90% D1 win rate
#   - #1 NAIA vs worst PNW D1:    ~75% NAIA win rate
#   - Best JUCO vs worst D2/D3:   ~75-80% JUCO win rate

# Division rating bands: (floor, ceiling)
# Overlapping ranges allow cross-division upsets
_DIV_BANDS = {
    "D1":   (60, 100),  # 40 pts spread; floor above NAIA/D2 ceiling
    "NAIA": (15, 75),   # 60 pts spread; same as D2, stats differentiate teams
    "D2":   (15, 75),   # 60 pts spread; same as NAIA, rankings do the work
    "D3":   (5, 60),    # 55 pts spread; top D3 overlaps mid NAIA/D2
    "JUCO": (5, 50),    # 45 pts spread; similar tier to D3
}

# Runs-per-game baseline by division (adjusts run spread in matchups)
_RPG = {"D1": 5.2, "D2": 5.6, "D3": 5.8, "NAIA": 5.6, "JUCO": 6.0}


def _compute_power_rating(
    wins, losses, runs_scored, runs_allowed,
    avg_wrc_plus, avg_fip, team_war,
    division_level, national_percentile,
):
    """
    Compute a 0-100 cross-division power rating for a team.

    Step 1: Compute on-field performance (0-1 scale)
      50% Pythagorean win% (run environment, exponent=1.83)
      15% wRC+ normalized (offensive quality)
      15% FIP inverted (pitching quality)
      20% WAR per game (talent depth)

    Step 2: Blend with national ranking percentile
      Teams WITH national rankings: 50% on-field + 50% national
      Teams WITHOUT (JUCO):         on-field only, 15% penalty

    Step 3: Apply power curve to spread top/bottom teams apart
      rank^1.5 curve means elite teams separate more from the pack,
      and bad teams separate more from mediocre. Matches how team
      quality actually distributes (not linearly).

    Step 4: Map into wide division band (floor to ceiling)
    """
    total_games = wins + losses
    if total_games < 5:
        return None

    # --- On-field performance components ---
    rs = max(float(runs_scored or 0), 1)
    ra = max(float(runs_allowed or 0), 1)
    pyth_exp = 1.83
    pyth_win = rs ** pyth_exp / (rs ** pyth_exp + ra ** pyth_exp)

    off_factor = min(max(float(avg_wrc_plus or 100) / 100.0, 0.5), 1.5)

    fip_val = float(avg_fip or 4.5)
    pit_factor = min(max((9.0 - fip_val) / 9.0, 0.2), 1.0)

    war_pg = float(team_war or 0) / total_games
    war_factor = min(max(0.5 + war_pg * 2.0, 0.3), 1.5)

    # --- Composite on-field score (0-1 raw) ---
    # Pythagorean gets 50% because run differential is the single best
    # predictor of true team quality and already reflects SOS implicitly
    on_field = (
        0.50 * pyth_win +
        0.15 * off_factor +
        0.15 * pit_factor +
        0.20 * war_factor
    )
    # Normalize: empirical range ~0.35 (terrible) to ~0.85 (dominant)
    on_field_norm = min(max((on_field - 0.35) / 0.50, 0.0), 1.0)

    # --- Blend with national percentile for within-division rank ---
    if national_percentile is not None:
        natl_norm = float(national_percentile) / 100.0
        # 50/50 blend: on-field tells us how good they actually are,
        # national rankings add SOS context and cross-division calibration
        rank = 0.50 * on_field_norm + 0.50 * natl_norm
    else:
        # JUCO teams: no national rankings available, use on-field only
        # with a 15% penalty reflecting lack of external validation
        rank = on_field_norm * 0.85

    rank = min(max(rank, 0.0), 1.0)

    # --- Apply power curve to spread elite/bad teams apart ---
    # Without this, the gap between #1 and #50 is too small.
    # rank^1.5 on a 0-1 scale stretches differences at both ends:
    #   0.95 -> 0.93 (elite stays near top)
    #   0.75 -> 0.65 (mediocre drops more)
    #   0.50 -> 0.35 (bad teams drop significantly)
    #   0.30 -> 0.16 (terrible teams crater)
    rank = rank ** 1.5

    # --- Map into division band ---
    floor, ceiling = _DIV_BANDS.get(division_level, (15, 75))
    rating = floor + rank * (ceiling - floor)

    return round(rating, 1)


def _elo_win_prob(rating_a, rating_b, scale=30.0):
    """
    Elo-style win probability from two power ratings.

    P(A wins) = 1 / (1 + 10^((rB - rA) / scale))

    Calibrated with scale=30 for NAIA/D2 bands (15-75).
    Produces realistic upset rates:
      - 5-point gap:  ~59% favorite
      - 10-point gap: ~68% favorite
      - 15-point gap: ~76% favorite
      - 23-point gap: ~86% favorite (LCSC vs Bushnell range)
    Benchmarked against PEAR ratings for NAIA matchups.
    """
    return 1.0 / (1.0 + math.pow(10, (rating_b - rating_a) / scale))


@router.get("/teams/matchup")
def team_matchup(
    season: int = Query(..., description="Season year"),
    team_ids: str = Query("", description="Comma-separated team IDs (2+)"),
):
    """
    Compute cross-division power ratings and neutral-site matchup predictions.

    For each pair of selected teams, returns:
    - power_rating (0-100, cross-division comparable)
    - projected win% for each side
    - projected run spread
    - component breakdown (pyth, offense, pitching, WAR, national rank)
    """
    if not team_ids:
        return {"teams": [], "matchups": []}

    ids = [int(x.strip()) for x in team_ids.split(",") if x.strip().isdigit()]
    if len(ids) < 2 or len(ids) > 10:
        return {"teams": [], "matchups": []}

    with get_connection() as conn:
        cur = conn.cursor()

        team_ratings = []

        for tid in ids:
            # Team info + division
            cur.execute("""
                SELECT t.id, t.name, t.short_name, t.logo_url,
                       d.level as division_level
                FROM teams t
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                WHERE t.id = %s
            """, (tid,))
            team = cur.fetchone()
            if not team:
                continue

            # Record + runs
            cur.execute("""
                SELECT wins, losses
                FROM team_season_stats
                WHERE team_id = %s AND season = %s
            """, (tid, season))
            rec = cur.fetchone()
            if not rec or (rec["wins"] or 0) + (rec["losses"] or 0) < 5:
                continue

            # Total runs scored (from batting_stats) - PA-weighted wRC+ w/ NULL guard
            cur.execute("""
                SELECT SUM(runs) as rs,
                       SUM(wrc_plus * plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL)
                         / NULLIF(SUM(plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL), 0) as avg_wrc_plus,
                       SUM(offensive_war) as total_owar
                FROM batting_stats
                WHERE team_id = %s AND season = %s AND plate_appearances >= 10
            """, (tid, season))
            bat = cur.fetchone()

            # Total runs allowed + pitching stats - IP-weighted FIP/FIP+ w/ NULL guard
            cur.execute("""
                SELECT SUM(earned_runs) as er, SUM(runs_allowed) as ra,
                       SUM(fip * ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL)
                         / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL), 0) as avg_fip,
                       SUM(fip_plus * ip_outs(innings_pitched)) FILTER (WHERE fip_plus IS NOT NULL)
                         / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE fip_plus IS NOT NULL), 0) as avg_fip_plus,
                       SUM(pitching_war) as total_pwar,
                       outs_to_ip(SUM(ip_outs(innings_pitched))) as total_ip,
                       CASE WHEN SUM(ip_outs(innings_pitched)) > 0
                            THEN ROUND((SUM(earned_runs) * 9.0 / NULLIF(SUM(ip_outs(innings_pitched)) / 3.0, 0))::numeric, 2)
                            ELSE 0 END as team_era
                FROM pitching_stats
                WHERE team_id = %s AND season = %s AND innings_pitched >= 3
            """, (tid, season))
            pit = cur.fetchone()

            if not bat or not pit:
                continue

            # Canonical aggregates: RS/RA from games table and team_era from
            # game_pitching ER + true (baseball-notation) IP. Override the
            # buggy inline values so power-rating + components match what
            # the team page reports.
            canonical = get_team_aggregates(cur, tid, season)

            # National rating (composite percentile)
            cur.execute("""
                SELECT national_percentile, composite_rank, num_sources
                FROM composite_rankings
                WHERE team_id = %s AND season = %s
            """, (tid, season))
            comp = cur.fetchone()
            natl_pct = comp["national_percentile"] if comp else None

            wins = rec["wins"] or 0
            losses = rec["losses"] or 0
            total_games = wins + losses
            # Prefer canonical RS/RA from games table; fall back to the inline
            # batting_stats / pitching_stats aggregations only if games has
            # no rows yet for this team-season.
            rs = float(canonical.get("runs_scored") or bat["rs"] or 0)
            ra = float(canonical.get("runs_allowed") or pit["ra"] or pit["er"] or 0)
            total_war = float(bat["total_owar"] or 0) + float(pit["total_pwar"] or 0)

            rating = _compute_power_rating(
                wins, losses, rs, ra,
                bat["avg_wrc_plus"], pit["avg_fip"], total_war,
                team["division_level"], natl_pct,
            )
            if rating is None:
                continue

            # Component breakdown for display
            pyth_exp = 1.83
            rs_c = max(rs, 1)
            ra_c = max(ra, 1)
            pyth_win = rs_c ** pyth_exp / (rs_c ** pyth_exp + ra_c ** pyth_exp)
            run_diff_pg = (rs - ra) / total_games

            team_ratings.append({
                "team_id": team["id"],
                "name": team["name"],
                "short_name": team["short_name"],
                "logo_url": team["logo_url"],
                "division_level": team["division_level"],
                "record": f"{wins}-{losses}",
                "win_pct": round(wins / total_games, 3),
                "power_rating": rating,
                "components": {
                    "pyth_win_pct": round(pyth_win, 3),
                    "run_diff_per_game": round(run_diff_pg, 2),
                    "wrc_plus": round(float(bat["avg_wrc_plus"] or 100)),
                    "team_era": float(canonical.get("team_era") or pit["team_era"] or 0),
                    "fip": round(float(pit["avg_fip"] or 4.5), 2),
                    "total_war": round(total_war, 1),
                    "war_per_game": round(total_war / total_games, 2),
                    "national_percentile": round(float(natl_pct), 1) if natl_pct else None,
                    "national_rank": comp["composite_rank"] if comp else None,
                    "rating_sources": comp["num_sources"] if comp else 0,
                },
            })

        # Sort by power rating descending
        team_ratings.sort(key=lambda t: t["power_rating"], reverse=True)

        # --- Compute pairwise matchups ---
        matchups = []
        for i in range(len(team_ratings)):
            for j in range(i + 1, len(team_ratings)):
                a = team_ratings[i]
                b = team_ratings[j]

                # Elo-style win probability (scale=30 calibrated to research)
                win_prob_a = _elo_win_prob(a["power_rating"], b["power_rating"])
                win_prob_b = 1.0 - win_prob_a

                # --- Projected run total (over/under) ---
                # Base: league-average RPG for the combined division environment
                # Adjust by each team's offensive quality (wRC+) and
                # opponent's pitching quality (FIP), dampened with sqrt
                # to prevent extreme compounding.
                rpg_a = _RPG.get(a["division_level"], 5.5)
                rpg_b = _RPG.get(b["division_level"], 5.5)
                avg_rpg = (rpg_a + rpg_b) / 2.0

                wrc_a = a["components"]["wrc_plus"] or 100
                wrc_b = b["components"]["wrc_plus"] or 100
                fip_a = a["components"]["fip"] or 4.5
                fip_b = b["components"]["fip"] or 4.5

                off_a = math.sqrt(wrc_a / 100.0)
                off_b = math.sqrt(wrc_b / 100.0)
                pit_a = math.sqrt(fip_a / 4.5)   # >1 = worse pitching
                pit_b = math.sqrt(fip_b / 4.5)

                # Raw projected runs per team
                raw_runs_a = avg_rpg * off_a * pit_b
                raw_runs_b = avg_rpg * off_b * pit_a
                proj_total = round((raw_runs_a + raw_runs_b) * 2) / 2  # nearest 0.5

                # --- Run spread from win probability (logit-based) ---
                # logit(p) * 3.0 produces:
                #   90% favorite -> +6.5 runs, 75% -> +3.2, 60% -> +1.2
                wp_clamped = max(0.005, min(0.995, win_prob_a))
                logit = math.log(wp_clamped / (1.0 - wp_clamped))
                spread = round(logit * 3.0 * (avg_rpg / 5.5), 1)

                # --- Derive per-team runs from total + spread ---
                # This ensures projected runs are mathematically consistent:
                #   proj_runs_a = (total + spread) / 2
                #   proj_runs_b = (total - spread) / 2
                proj_runs_a = round((proj_total + spread) / 2, 1)
                proj_runs_b = round((proj_total - spread) / 2, 1)
                # Floor at 0 (a team can't score negative runs)
                if proj_runs_b < 0:
                    proj_runs_b = 0.0
                    proj_runs_a = proj_total

                matchups.append({
                    "team_a": a["team_id"],
                    "team_b": b["team_id"],
                    "win_prob_a": round(win_prob_a, 3),
                    "win_prob_b": round(win_prob_b, 3),
                    "spread": spread,  # positive = team_a favored
                    "favored": a["team_id"] if spread >= 0 else b["team_id"],
                    "proj_runs_a": proj_runs_a,
                    "proj_runs_b": proj_runs_b,
                    "proj_total": proj_total,
                })

        return {
            "teams": team_ratings,
            "matchups": matchups,
        }


# ── Win Probabilities for Games ─────────────────────────────
# Bulk-compute projected win% for all PNW-vs-PNW games on a date.
# Uses the same power rating + Elo formula as the matchup predictor.

def _bulk_power_ratings(cur, season):
    """
    Compute power ratings for ALL active PNW teams in one pass.
    Returns dict: team_id -> power_rating (float 0-100).
    Caches across a single request to avoid repeated DB hits.
    """
    # Fetch all active teams with division
    cur.execute("""
        SELECT t.id, t.short_name, d.level as division_level
        FROM teams t
        JOIN conferences c ON t.conference_id = c.id
        JOIN divisions d ON c.division_id = d.id
        WHERE t.is_active = 1
    """)
    teams = cur.fetchall()

    # Batch fetch all records
    cur.execute("""
        SELECT team_id, wins, losses
        FROM team_season_stats WHERE season = %s
    """, (season,))
    records = {r["team_id"]: r for r in cur.fetchall()}

    # Batch fetch batting stats - PA-weighted wRC+ w/ NULL guard
    cur.execute("""
        SELECT team_id, SUM(runs) as rs,
               SUM(wrc_plus * plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL)
                 / NULLIF(SUM(plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL), 0) as avg_wrc_plus,
               SUM(offensive_war) as total_owar
        FROM batting_stats
        WHERE season = %s AND plate_appearances >= 10
        GROUP BY team_id
    """, (season,))
    batting = {r["team_id"]: r for r in cur.fetchall()}

    # Batch fetch pitching stats - IP-weighted FIP w/ NULL guard
    cur.execute("""
        SELECT team_id, SUM(runs_allowed) as ra, SUM(earned_runs) as er,
               SUM(fip * ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL)
                 / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL), 0) as avg_fip,
               SUM(pitching_war) as total_pwar
        FROM pitching_stats
        WHERE season = %s AND innings_pitched >= 3
        GROUP BY team_id
    """, (season,))
    pitching = {r["team_id"]: r for r in cur.fetchall()}

    # Batch fetch national rankings
    cur.execute("""
        SELECT team_id, national_percentile
        FROM composite_rankings WHERE season = %s
    """, (season,))
    rankings = {r["team_id"]: r["national_percentile"] for r in cur.fetchall()}

    ratings = {}
    for team in teams:
        tid = team["id"]
        rec = records.get(tid)
        bat = batting.get(tid)
        pit = pitching.get(tid)

        if not rec or (rec["wins"] or 0) + (rec["losses"] or 0) < 5:
            continue
        if not bat or not pit:
            continue

        wins = rec["wins"] or 0
        losses = rec["losses"] or 0
        rs = float(bat["rs"] or 0)
        ra = float(pit["ra"] or pit["er"] or 0)
        total_war = float(bat["total_owar"] or 0) + float(pit["total_pwar"] or 0)

        rating = _compute_power_rating(
            wins, losses, rs, ra,
            bat["avg_wrc_plus"], pit["avg_fip"], total_war,
            team["division_level"], rankings.get(tid),
        )
        if rating is not None:
            ratings[tid] = rating

    return ratings


@router.get("/games/win-probabilities")
def game_win_probabilities(
    date: str = Query(..., description="Date (YYYY-MM-DD)"),
    season: int = Query(CURRENT_SEASON, description="Season year"),
):
    """
    Compute projected win probabilities for all PNW-vs-PNW games on a date.
    Returns probabilities only when BOTH teams are in our database with ratings.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # Get all power ratings (one batch)
        ratings = _bulk_power_ratings(cur, season)

        # Fetch games for this date
        cur.execute("""
            SELECT id, home_team_id, away_team_id
            FROM games
            WHERE game_date = %s AND season = %s
        """, (date, season))
        games = cur.fetchall()

        probabilities = {}
        for game in games:
            home_id = game["home_team_id"]
            away_id = game["away_team_id"]

            if not home_id or not away_id:
                continue
            if home_id not in ratings or away_id not in ratings:
                continue

            home_wp = _elo_win_prob(ratings[home_id], ratings[away_id])

            probabilities[str(game["id"])] = {
                "home_win_prob": round(home_wp, 3),
                "away_win_prob": round(1.0 - home_wp, 3),
                "home_rating": ratings[home_id],
                "away_rating": ratings[away_id],
            }

        return {"date": date, "probabilities": probabilities}


@router.get("/games/upset-of-the-day")
def upset_of_the_day(
    season: int = Query(CURRENT_SEASON, description="Season year"),
):
    """
    Find the biggest upset from the most recent day with completed PNW-vs-PNW games.
    Priority: today first, then yesterday, then search back up to 7 days.
    An upset = a team with <40% projected win probability winning the game.
    Returns the single biggest upset (largest pre-game probability gap).
    """
    import pytz
    pacific = pytz.timezone("US/Pacific")
    today = datetime.now(pacific).date()

    with get_connection() as conn:
        cur = conn.cursor()

        # Get power ratings
        ratings = _bulk_power_ratings(cur, season)

        # Search: today first, then yesterday, then back up to 7 days
        for days_back in range(0, 8):
            check_date = today - timedelta(days=days_back)

            cur.execute("""
                SELECT g.id, g.game_date, g.home_team_id, g.away_team_id,
                       g.home_score, g.away_score, g.innings,
                       g.is_conference_game,
                       ht.short_name as home_short, ht.logo_url as home_logo,
                       at.short_name as away_short, at.logo_url as away_logo,
                       hd.level as home_division, ad.level as away_division
                FROM games g
                JOIN teams ht ON g.home_team_id = ht.id
                JOIN teams at ON g.away_team_id = at.id
                JOIN conferences hc ON ht.conference_id = hc.id
                JOIN divisions hd ON hc.division_id = hd.id
                JOIN conferences ac ON at.conference_id = ac.id
                JOIN divisions ad ON ac.division_id = ad.id
                WHERE g.game_date = %s AND g.season = %s
                  AND g.status = 'final'
                  AND g.home_score IS NOT NULL
                  AND g.away_score IS NOT NULL
                  AND (g.home_score + g.away_score) > 0
            """, (check_date.isoformat(), season))
            games = cur.fetchall()

            if not games:
                continue

            # Find upsets among PNW-vs-PNW games
            biggest_upset = None
            biggest_upset_margin = 0

            for game in games:
                home_id = game["home_team_id"]
                away_id = game["away_team_id"]

                if home_id not in ratings or away_id not in ratings:
                    continue

                home_wp = _elo_win_prob(ratings[home_id], ratings[away_id])
                away_wp = 1.0 - home_wp

                # Determine who was favored and who won
                home_won = game["home_score"] > game["away_score"]

                if home_won:
                    winner_wp = home_wp
                else:
                    winner_wp = away_wp

                # It's an upset if the winner had <40% projected win probability
                if winner_wp < 0.40:
                    upset_margin = 0.40 - winner_wp  # How unlikely the upset was

                    if upset_margin > biggest_upset_margin:
                        biggest_upset_margin = upset_margin
                        biggest_upset = {
                            "game_id": game["id"],
                            "game_date": check_date.isoformat(),
                            "home_team": game["home_short"],
                            "away_team": game["away_short"],
                            "home_logo": game["home_logo"],
                            "away_logo": game["away_logo"],
                            "home_score": game["home_score"],
                            "away_score": game["away_score"],
                            "home_division": game["home_division"],
                            "away_division": game["away_division"],
                            "innings": game["innings"],
                            "is_conference": game["is_conference_game"],
                            "home_win_prob": round(home_wp, 3),
                            "away_win_prob": round(away_wp, 3),
                            "winner": game["home_short"] if home_won else game["away_short"],
                            "winner_logo": game["home_logo"] if home_won else game["away_logo"],
                            "loser": game["away_short"] if home_won else game["home_short"],
                            "loser_logo": game["away_logo"] if home_won else game["home_logo"],
                            "winner_score": game["home_score"] if home_won else game["away_score"],
                            "loser_score": game["away_score"] if home_won else game["home_score"],
                            "winner_win_prob": round(winner_wp, 3),
                            "loser_win_prob": round(1.0 - winner_wp, 3),
                        }

            if biggest_upset:
                return {"upset": biggest_upset}

        # No upsets found in last 7 days
        return {"upset": None}


# ── Playoff Projections ─────────────────────────────────────
# Projects end-of-season records and playoff fields using power ratings
# and future scheduled games.

@router.get("/playoff-projections")
@cached_endpoint(ttl_seconds=1800)
def playoff_projections(
    season: int = Query(..., description="Season year"),
):
    """
    Project end-of-season standings and playoff fields for all PNW conferences.

    Uses current records, power ratings, and remaining schedule to project:
    - Final overall and conference records for each team
    - Conference standings based on projected conference win%
    - Playoff fields and seeding based on each league's format
    """
    # Load future schedules
    future_data = load_future_schedules()
    future_games = future_data.get("games", [])

    with get_connection() as conn:
        cur = conn.cursor()

        # Get current standings data (same query as /standings)
        cur.execute("""
            SELECT t.id, t.short_name, t.logo_url, t.city, t.state,
                   c.id as conference_id, c.name as conference_name, c.abbreviation as conference_abbrev,
                   d.id as division_id, d.name as division_name, d.level as division_level,
                   COALESCE(s.wins, 0) as wins, COALESCE(s.losses, 0) as losses,
                   COALESCE(s.conference_wins, 0) as conf_wins,
                   COALESCE(s.conference_losses, 0) as conf_losses
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
            WHERE t.is_active = 1
            ORDER BY d.id, c.name, t.short_name
        """, (season,))
        standings_rows = [dict(r) for r in cur.fetchall()]

        # Get power rating data for all teams
        cur.execute("""
            SELECT t.id, t.short_name, d.level as division_level,
                   COALESCE(s.wins, 0) as wins, COALESCE(s.losses, 0) as losses,
                   COALESCE(bat.rs, 0) as runs_scored,
                   COALESCE(pit.ra, 0) as runs_allowed,
                   COALESCE(bat.avg_wrc_plus, 100) as avg_wrc_plus,
                   COALESCE(pit.avg_fip, 4.5) as avg_fip,
                   COALESCE(bat.total_owar, 0) + COALESCE(pit.total_pwar, 0) as total_war,
                   cr.national_percentile
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
            LEFT JOIN (
                SELECT team_id,
                    SUM(runs) as rs,
                    SUM(offensive_war) as total_owar,
                    SUM(wrc_plus * plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL)
                      / NULLIF(SUM(plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL), 0) as avg_wrc_plus
                FROM batting_stats WHERE season = %s
                GROUP BY team_id
            ) bat ON bat.team_id = t.id
            LEFT JOIN (
                SELECT team_id,
                    SUM(runs_allowed) as ra,
                    SUM(pitching_war) as total_pwar,
                    SUM(fip * ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL)
                      / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL), 0) as avg_fip
                FROM pitching_stats WHERE season = %s
                GROUP BY team_id
            ) pit ON pit.team_id = t.id
            LEFT JOIN composite_rankings cr ON cr.team_id = t.id AND cr.season = %s
            WHERE t.is_active = 1
        """, (season, season, season, season))
        rating_rows = cur.fetchall()

        # Compute power ratings
        team_ratings = {}
        for r in rating_rows:
            r = dict(r)
            wins = r["wins"] or 0
            losses = r["losses"] or 0
            if wins + losses < 5:
                continue

            rating = _compute_power_rating(
                wins, losses,
                r["runs_scored"], r["runs_allowed"],
                r["avg_wrc_plus"], r["avg_fip"], r["total_war"],
                r["division_level"], r["national_percentile"],
            )
            if rating is not None:
                team_ratings[r["id"]] = {
                    "power_rating": rating,
                    "short_name": r["short_name"],
                    "division_level": r["division_level"],
                }

        # Project remaining games (expected value projections)
        projections = project_remaining_games(future_games, team_ratings)

        # Run Monte Carlo simulation for playoff odds
        mc_results = run_monte_carlo(
            future_games, team_ratings, standings_rows, n_simulations=5000
        )

        # Build projected standings
        projected_conferences = build_projected_standings(
            standings_rows, projections, team_ratings
        )

        # Inject Monte Carlo odds into each team in standings
        for conf in projected_conferences:
            for team in conf["teams"]:
                tid = team["team_id"]
                mc = mc_results.get(tid, {})
                team["playoff_pct"] = mc.get("playoff_pct", 0)
                team["tourney_win_pct"] = mc.get("tourney_win_pct", 0)
                team["seed_probabilities"] = mc.get("seed_probabilities", {})

        # Determine playoff fields
        playoff_brackets = determine_playoff_fields(projected_conferences)

        # Inject odds into bracket teams too
        for bracket in playoff_brackets:
            for team in bracket["teams"]:
                tid = team["team_id"]
                mc = mc_results.get(tid, {})
                team["playoff_pct"] = mc.get("playoff_pct", 0)
                team["tourney_win_pct"] = mc.get("tourney_win_pct", 0)
                team["seed_probabilities"] = mc.get("seed_probabilities", {})

        # ── Overlay any frozen-conference snapshots ──────────────
        # For conferences whose regular season has ended (and whose
        # /playoff-projections output was snapshotted at freeze time), we
        # replace the live-computed entries with the snapshot so the page
        # shows the "frozen at end of regular season" view. This is how
        # the user sees stable standings/odds for a frozen conference
        # even if power ratings drift from post-season game data.
        cur.execute(
            """
            SELECT ps.conf_key, ps.snapshot_json, cf.regular_season_end_date, cf.frozen_at
            FROM projection_snapshots ps
            JOIN conference_freezes cf ON cf.conf_key = ps.conf_key
            WHERE ps.season = %s
            """,
            (season,),
        )
        snapshot_rows = cur.fetchall()

        frozen_conferences_meta = []
        for row in snapshot_rows:
            snap = row["snapshot_json"] or {}
            response_abbrev = snap.get("response_abbrev")
            if not response_abbrev:
                continue

            frozen_at = row["frozen_at"]
            end_date = row["regular_season_end_date"]
            frozen_conferences_meta.append({
                "conf_key": row["conf_key"],
                "conference_abbrev": response_abbrev,
                "frozen_at": frozen_at.isoformat() if frozen_at else None,
                "regular_season_end_date": end_date.isoformat() if end_date else None,
            })

            # Swap the matching conference entry
            conf_section = snap.get("conference_section")
            if conf_section:
                for i, c in enumerate(projected_conferences):
                    if c.get("conference_abbrev") == response_abbrev:
                        projected_conferences[i] = conf_section
                        break

            # Swap the matching bracket entry (if one was captured)
            bracket_section = snap.get("bracket_section")
            if bracket_section:
                for i, b in enumerate(playoff_brackets):
                    if b.get("conference_abbrev") == response_abbrev:
                        playoff_brackets[i] = bracket_section
                        break

        return {
            "season": season,
            "schedule_last_updated": future_data.get("last_updated"),
            "total_future_games": len(future_games),
            "conferences": projected_conferences,
            "playoffs": playoff_brackets,
            "frozen_conferences": frozen_conferences_meta,
        }


@router.get("/nwac-championship-odds")
@cached_endpoint(ttl_seconds=180)  # short TTL so odds move with each result during the tournament
def nwac_championship_odds(season: int = Query(2026)):
    """
    Monte Carlo odds for each team to win the 8-team NWAC Championship.

    Strength = CPI (Composite Power Index) computed within the JUCO pool,
    a predictive SoS-adjusted rating from team wRC+/FIP blended with
    regressed game results. Home-field advantage is applied to the host
    (Lower Columbia). Returns teams sorted by championship probability.
    """
    seeds = NWAC_2026_CHAMP_SEEDS
    team_ids = list(seeds.values())
    seed_by_team = {tid: s for s, tid in seeds.items()}

    with get_connection() as conn:
        cur = conn.cursor()
        # CPI is computed WITHIN the JUCO pool, so it spreads NWAC teams
        # across the full strength range (the cross-division power rating
        # compresses them against a shared floor/ceiling). Compute CPI over
        # every JUCO team, then pull the 8 championship teams. The CPI scale
        # (100-centered, roughly 70-135 in-season) feeds elo_win_prob with a
        # spread comparable to the old PPI's 20-80 band.
        cur.execute("""
            SELECT t.id, t.short_name, t.name, t.logo_url,
                   COALESCE(s.wins, 0) as wins,
                   COALESCE(s.losses, 0) as losses
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
            WHERE t.is_active = 1 AND d.level = 'JUCO'
        """, (season,))
        juco_rows = [dict(r) for r in cur.fetchall()]
        juco_ranked = compute_cpi_for_division(
            cur, [t["id"] for t in juco_rows], season,
            season_games=SEASON_GAMES_BY_LEVEL["JUCO"])

    cpi_by_id = {t["team_id"]: t for t in juco_ranked}
    meta_by_id = {t["id"]: t for t in juco_rows}

    team_ratings = {}
    meta = {}
    for tid in team_ids:
        t = meta_by_id.get(tid)
        c = cpi_by_id.get(tid)
        if not t or not c:
            continue
        cpi = c.get("cpi_raw")
        team_ratings[tid] = {"power_rating": cpi, "short_name": t["short_name"]}
        meta[tid] = {
            "team_id": tid,
            "name": t["name"],
            "short_name": t["short_name"],
            "logo_url": t["logo_url"],
            "seed": seed_by_team.get(tid),
            "wins": t["wins"],
            "losses": t["losses"],
            "cpi": cpi,
            "cpi_rank": c.get("rank"),
        }

    # ── Live conditioning: feed completed championship games into the sim ──
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT home_team_id, away_team_id, home_score, away_score, status
            FROM games
            WHERE season = %s
              AND home_team_id = ANY(%s) AND away_team_id = ANY(%s)
              AND game_date BETWEEN '2026-05-21' AND '2026-05-26'
        """, (season, team_ids, team_ids))
        champ_games = []
        for r in cur.fetchall():
            r = dict(r)
            winner = None
            if r["status"] == "final" and r["home_score"] is not None and r["away_score"] is not None:
                if r["home_score"] > r["away_score"]:
                    winner = r["home_team_id"]
                elif r["away_score"] > r["home_score"]:
                    winner = r["away_team_id"]
            champ_games.append({
                "home_team_id": r["home_team_id"],
                "away_team_id": r["away_team_id"],
                "winner_id": winner,
            })

    known_results, eliminated = resolve_known_nwac_results(champ_games)
    games_played = len(known_results)

    odds = simulate_nwac_championship_odds(
        team_ratings, n_simulations=50000, known_results=known_results,
    )

    teams_out = []
    for tid in team_ids:
        m = meta.get(tid, {"team_id": tid, "seed": seed_by_team.get(tid)})
        o = odds.get(tid, {"champ_pct": 0, "final_pct": 0})
        champ_pct = round(o["champ_pct"], 4)
        teams_out.append({
            **m,
            "champ_pct": champ_pct,
            "reach_final_pct": round(o["final_pct"], 4),
            "american_odds": pct_to_american(o["champ_pct"]),
            "eliminated": tid in eliminated,
            "is_host": tid == NWAC_2026_CHAMP_HOST_ID,
        })
    teams_out.sort(key=lambda x: -x["champ_pct"])

    return {
        "season": season,
        "venue": "Lower Columbia College, Longview WA",
        "host_team_id": NWAC_2026_CHAMP_HOST_ID,
        "n_simulations": 50000,
        "games_played": games_played,
        "teams": teams_out,
    }


def _ip_to_real(ip):
    """Convert baseball IP notation (6.2 = 6 and 2/3) to a real number."""
    if ip is None:
        return 0.0
    whole = int(ip)
    frac = round((float(ip) - whole) * 10)
    if frac >= 3:  # already decimal, not notation
        return float(ip)
    return whole + frac / 3.0


@router.get("/nwac-mvp-tracker")
@cached_endpoint(ttl_seconds=180)  # short TTL so the tracker reflects tournament games promptly
def nwac_mvp_tracker(season: int = Query(2026)):
    """
    Tournament MVP Watch — ranks players by their actual NWAC Championship
    performance (Thu–Mon), not season stats.

    Only box scores from championship-window games (May 21–26) between the
    8 championship teams count. Each performance earns box-score points,
    summed across the weekend, and we return the top 10 hitters and top 10
    pitchers by total points.

    HITTER points (per game, summed):
      1B +1, 2B +2, 3B +3, HR +4, BB +1, HBP +1, RBI +1, R +1, SB +1, CS -1

    PITCHER points (per appearance, summed):
      out +1 (so a K = +2: out plus the strikeout), K +1, ER -2,
      H -0.5, BB/HBP -0.5, HR -1.5, plus bonuses: quality start +2,
      win +2, save +2
    """
    team_ids = list(NWAC_2026_CHAMP_SEEDS.values())
    TOURNEY_START = "2026-05-21"  # Thursday
    TOURNEY_END = "2026-05-26"    # buffer past the Monday (May 25) finale

    # Shared WHERE for "final championship-window games between the 8 teams".
    # The team_id IN (home,away) clause is the mandatory ghost-row guard for
    # game_batting / game_pitching (orphan rows from past scraping bugs).
    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute("""
            SELECT gb.player_id, p.first_name, p.last_name, p.position,
                   gb.team_id, t.short_name, t.logo_url,
                   COUNT(DISTINCT gb.game_id) AS games,
                   COALESCE(SUM(gb.at_bats),0)       AS ab,
                   COALESCE(SUM(gb.runs),0)          AS r,
                   COALESCE(SUM(gb.hits),0)          AS h,
                   COALESCE(SUM(gb.doubles),0)       AS doubles,
                   COALESCE(SUM(gb.triples),0)       AS triples,
                   COALESCE(SUM(gb.home_runs),0)     AS hr,
                   COALESCE(SUM(gb.rbi),0)           AS rbi,
                   COALESCE(SUM(gb.walks),0)         AS bb,
                   COALESCE(SUM(gb.hit_by_pitch),0)  AS hbp,
                   COALESCE(SUM(gb.strikeouts),0)    AS k,
                   COALESCE(SUM(gb.stolen_bases),0)  AS sb,
                   COALESCE(SUM(gb.caught_stealing),0) AS cs
            FROM game_batting gb
            JOIN games g   ON g.id = gb.game_id
            JOIN players p ON p.id = gb.player_id
            JOIN teams t   ON t.id = gb.team_id
            WHERE g.season = %s
              AND g.game_date BETWEEN %s AND %s
              AND g.status = 'final'
              AND g.home_team_id = ANY(%s) AND g.away_team_id = ANY(%s)
              AND gb.team_id = ANY(%s)
              AND gb.team_id IN (g.home_team_id, g.away_team_id)
              AND gb.player_id IS NOT NULL
            GROUP BY gb.player_id, p.first_name, p.last_name, p.position,
                     gb.team_id, t.short_name, t.logo_url
        """, (season, TOURNEY_START, TOURNEY_END, team_ids, team_ids, team_ids))
        bat_rows = [dict(r) for r in cur.fetchall()]

        # Pitchers: one row per appearance so we can convert each game's IP
        # (baseball notation) to outs and tally per-game bonuses correctly.
        cur.execute("""
            SELECT gp.player_id, p.first_name, p.last_name,
                   gp.team_id, t.short_name, t.logo_url,
                   gp.innings_pitched, gp.strikeouts, gp.earned_runs,
                   gp.hits_allowed, gp.walks, gp.hit_batters,
                   gp.home_runs_allowed, gp.decision, gp.is_quality_start
            FROM game_pitching gp
            JOIN games g   ON g.id = gp.game_id
            JOIN players p ON p.id = gp.player_id
            JOIN teams t   ON t.id = gp.team_id
            WHERE g.season = %s
              AND g.game_date BETWEEN %s AND %s
              AND g.status = 'final'
              AND g.home_team_id = ANY(%s) AND g.away_team_id = ANY(%s)
              AND gp.team_id = ANY(%s)
              AND gp.team_id IN (g.home_team_id, g.away_team_id)
              AND gp.player_id IS NOT NULL
        """, (season, TOURNEY_START, TOURNEY_END, team_ids, team_ids, team_ids))
        pit_appearances = [dict(r) for r in cur.fetchall()]

    # ── Hitters: box-score points ──
    hitters = []
    for r in bat_rows:
        singles = max(0, (r["h"] or 0) - (r["doubles"] or 0) - (r["triples"] or 0) - (r["hr"] or 0))
        pts = (
            1 * singles + 2 * r["doubles"] + 3 * r["triples"] + 4 * r["hr"]
            + 1 * r["bb"] + 1 * r["hbp"] + 1 * r["rbi"] + 1 * r["r"]
            + 1 * r["sb"] - 1 * r["cs"]
        )
        ab = r["ab"] or 0
        avg = (r["h"] / ab) if ab else None
        hitters.append({
            "player_id": r["player_id"],
            "name": f"{r['first_name']} {r['last_name']}",
            "position": r.get("position") or "—",
            "team_id": r["team_id"], "team_short": r["short_name"], "team_logo": r["logo_url"],
            "points": round(float(pts), 1),
            "games": r["games"], "ab": ab, "h": r["h"], "hr": r["hr"], "rbi": r["rbi"],
            "r": r["r"], "sb": r["sb"], "bb": r["bb"], "avg": round(avg, 3) if avg is not None else None,
            "stat_line": (
                f"{r['h']}-{ab}, {r['hr']} HR, {r['rbi']} RBI"
                + (f", {r['sb']} SB" if r["sb"] else "")
            ),
        })

    # ── Pitchers: aggregate appearances, then box-score points ──
    pit_agg = {}
    for a in pit_appearances:
        pid = a["player_id"]
        agg = pit_agg.get(pid)
        if agg is None:
            agg = {
                "player_id": pid,
                "name": f"{a['first_name']} {a['last_name']}",
                "team_id": a["team_id"], "team_short": a["short_name"], "team_logo": a["logo_url"],
                "games": 0, "outs": 0, "k": 0, "er": 0, "h": 0, "bb": 0, "hbp": 0,
                "hr": 0, "qs": 0, "wins": 0, "saves": 0,
            }
            pit_agg[pid] = agg
        agg["games"] += 1
        agg["outs"] += int(round(_ip_to_real(a["innings_pitched"]) * 3))
        agg["k"]   += a["strikeouts"] or 0
        agg["er"]  += a["earned_runs"] or 0
        agg["h"]   += a["hits_allowed"] or 0
        agg["bb"]  += a["walks"] or 0
        agg["hbp"] += a["hit_batters"] or 0
        agg["hr"]  += a["home_runs_allowed"] or 0
        if a["is_quality_start"]:
            agg["qs"] += 1
        dec = (a["decision"] or "").strip().upper()
        if dec in ("W", "WIN"):
            agg["wins"] += 1
        elif dec in ("S", "SV", "SAVE", "SVO"):
            agg["saves"] += 1

    pitchers = []
    for agg in pit_agg.values():
        outs = agg["outs"]
        pts = (
            1 * outs + 1 * agg["k"] - 2 * agg["er"]
            - 0.5 * agg["h"] - 0.5 * (agg["bb"] + agg["hbp"]) - 1.5 * agg["hr"]
            + 2 * agg["qs"] + 2 * agg["wins"] + 2 * agg["saves"]
        )
        innings = outs / 3.0
        era = (agg["er"] * 9.0 / innings) if innings else None
        # Display innings in baseball notation (e.g. 6.2 = 6 2/3).
        ip_disp = (outs // 3) + (outs % 3) / 10.0
        pitchers.append({
            "player_id": agg["player_id"],
            "name": agg["name"],
            "position": "P",
            "team_id": agg["team_id"], "team_short": agg["team_short"], "team_logo": agg["team_logo"],
            "points": round(float(pts), 1),
            "games": agg["games"], "ip": round(ip_disp, 1), "k": agg["k"],
            "er": agg["er"], "h": agg["h"], "bb": agg["bb"],
            "era": round(era, 2) if era is not None else None,
            "stat_line": (
                f"{ip_disp:.1f} IP, {agg['k']} K"
                + (f", {era:.2f} ERA" if era is not None else "")
            ),
        })

    hitters.sort(key=lambda x: (-x["points"], -(x["hr"] or 0)))
    pitchers.sort(key=lambda x: (-x["points"], -x["k"]))
    for i, h in enumerate(hitters[:10]):
        h["rank"] = i + 1
    for i, p in enumerate(pitchers[:10]):
        p["rank"] = i + 1

    return {
        "season": season,
        "window": {"start": TOURNEY_START, "end": TOURNEY_END},
        "hitters": hitters[:10],
        "pitchers": pitchers[:10],
    }


@router.get("/teams/scatter")
@cached_endpoint(ttl_seconds=21600)  # all-teams fan-out (~340 queries); team aggregates
                                     # only change on the daily scrape, so cache 6h.
def team_scatter(
    season: int = Query(..., description="Season year"),
    x_stat: str = Query("team_avg", description="X-axis stat"),
    y_stat: str = Query("team_era", description="Y-axis stat"),
    division_id: Optional[int] = Query(None, description="Filter by division"),
):
    """
    Get team-level aggregate stats for scatter plot visualization.
    Returns one point per team with x/y values plus metadata.
    """
    all_allowed = {
        "team_avg", "team_obp", "team_slg", "team_ops",
        "total_hr", "total_sb", "total_runs", "total_rbi",
        "avg_woba", "avg_wrc_plus", "avg_iso", "total_owar",
        "avg_bb_pct", "avg_k_pct",
        "team_era", "team_whip", "avg_fip", "avg_fip_plus", "avg_era_plus", "avg_xfip",
        "total_k", "total_pwar", "pitching_k_pct", "pitching_bb_pct",
        "pitching_k_bb_pct",
        "total_ip", "total_war",
        "win_pct", "conf_win_pct", "run_diff",
    }

    if x_stat not in all_allowed or y_stat not in all_allowed:
        return []

    with get_connection() as conn:
        cur = conn.cursor()
        team_query = """
            SELECT t.id, t.name, t.short_name, t.logo_url,
                   c.abbreviation as conference_abbrev,
                   d.level as division_level
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE t.is_active = 1
        """
        team_params = []
        if division_id:
            team_query += " AND c.division_id = %s"
            team_params.append(division_id)
        team_query += " ORDER BY t.name"
        teams = cur.execute(team_query, team_params)
        teams = cur.fetchall()

        # Pre-fetch team records for win%
        cur.execute(
            """SELECT team_id, wins, losses, conference_wins, conference_losses
               FROM team_season_stats WHERE season = %s""",
            (season,),
        )
        record_map = {r["team_id"]: dict(r) for r in cur.fetchall()}

        results = []
        for team in teams:
            tid = team["id"]

            cur.execute(
                """SELECT COUNT(*) as n,
                       SUM(plate_appearances) as pa, SUM(at_bats) as ab,
                       SUM(hits) as h, SUM(doubles) as d2b, SUM(triples) as d3b,
                       SUM(home_runs) as hr, SUM(runs) as r, SUM(rbi) as rbi,
                       SUM(walks) as bb, SUM(strikeouts) as k, SUM(stolen_bases) as sb,
                       SUM(hit_by_pitch) as hbp,
                       -- Rate stats: PA-weighted with NULL guards.
                       -- bb_pct/k_pct rebuilt from raw totals.
                       SUM(woba * plate_appearances) FILTER (WHERE woba IS NOT NULL)
                         / NULLIF(SUM(plate_appearances) FILTER (WHERE woba IS NOT NULL), 0) as avg_woba,
                       SUM(wrc_plus * plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL)
                         / NULLIF(SUM(plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL), 0) as avg_wrc_plus,
                       SUM(iso * plate_appearances) FILTER (WHERE iso IS NOT NULL)
                         / NULLIF(SUM(plate_appearances) FILTER (WHERE iso IS NOT NULL), 0) as avg_iso,
                       SUM(walks)::numeric / NULLIF(SUM(plate_appearances), 0) as avg_bb_pct,
                       SUM(strikeouts)::numeric / NULLIF(SUM(plate_appearances), 0) as avg_k_pct,
                       SUM(offensive_war) as total_owar
                   FROM batting_stats bs
                   WHERE bs.team_id = %s AND bs.season = %s AND bs.plate_appearances >= 10""",
                (tid, season),
            )
            bat_row = cur.fetchone()

            cur.execute(
                """SELECT COUNT(*) as n,
                       outs_to_ip(SUM(ip_outs(innings_pitched))) as ip, SUM(earned_runs) as er,
                       SUM(runs_allowed) as ra,
                       SUM(walks) as bb, SUM(hits_allowed) as h,
                       SUM(strikeouts) as k, SUM(home_runs_allowed) as hr,
                       -- Rate stats: IP-weighted with NULL guards.
                       -- k_pct/bb_pct rebuilt from raw totals over batters_faced.
                       SUM(fip * ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL)
                         / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL), 0) as avg_fip,
                       SUM(fip_plus * ip_outs(innings_pitched)) FILTER (WHERE fip_plus IS NOT NULL)
                         / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE fip_plus IS NOT NULL), 0) as avg_fip_plus,
                       SUM(era_minus * ip_outs(innings_pitched)) FILTER (WHERE era_minus IS NOT NULL)
                         / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE era_minus IS NOT NULL), 0) as avg_era_minus,
                       SUM(xfip * ip_outs(innings_pitched)) FILTER (WHERE xfip IS NOT NULL)
                         / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE xfip IS NOT NULL), 0) as avg_xfip,
                       SUM(strikeouts)::numeric / NULLIF(SUM(batters_faced), 0) as avg_k_pct,
                       SUM(walks)::numeric / NULLIF(SUM(batters_faced), 0) as avg_bb_pct,
                       SUM(pitching_war) as total_pwar
                   FROM pitching_stats ps
                   WHERE ps.team_id = %s AND ps.season = %s AND ps.innings_pitched >= 3""",
                (tid, season),
            )
            pit_row = cur.fetchone()

            if not bat_row or (bat_row["n"] or 0) == 0:
                continue

            # Canonical team aggregates (single source of truth). Used to
            # compute team_era / team_whip / team_avg correctly with
            # baseball-notation IP and game_pitching ER.
            canonical = get_team_aggregates(cur, tid, season)

            def _compute(stat_name, b=bat_row, p=pit_row, c=canonical):
                if stat_name == "team_avg":
                    return c.get("team_avg")
                elif stat_name == "team_obp":
                    return c.get("team_obp")
                elif stat_name == "team_slg":
                    return c.get("team_slg")
                elif stat_name == "team_ops":
                    return c.get("team_ops")
                elif stat_name == "total_hr": return b["hr"]
                elif stat_name == "total_sb": return b["sb"]
                elif stat_name == "total_runs": return b["r"]
                elif stat_name == "total_rbi": return b["rbi"]
                elif stat_name == "avg_woba":
                    return round(b["avg_woba"], 3) if b["avg_woba"] else None
                elif stat_name == "avg_wrc_plus":
                    return round(b["avg_wrc_plus"]) if b["avg_wrc_plus"] else None
                elif stat_name == "avg_iso":
                    return round(b["avg_iso"], 3) if b["avg_iso"] else None
                elif stat_name == "total_owar":
                    return round(b["total_owar"], 1) if b["total_owar"] else 0
                elif stat_name == "avg_bb_pct":
                    return round(b["avg_bb_pct"], 3) if b["avg_bb_pct"] else None
                elif stat_name == "avg_k_pct":
                    return round(b["avg_k_pct"], 3) if b["avg_k_pct"] else None
                elif stat_name == "team_era":
                    return c.get("team_era")
                elif stat_name == "team_whip":
                    return c.get("team_whip")
                elif stat_name == "avg_fip":
                    return round(p["avg_fip"], 2) if p and p["avg_fip"] else None
                elif stat_name == "avg_fip_plus":
                    return round(p["avg_fip_plus"]) if p and p["avg_fip_plus"] else None
                elif stat_name == "avg_era_minus":
                    return round(p["avg_era_minus"]) if p and p["avg_era_minus"] else None
                elif stat_name == "avg_era_plus":
                    em = p["avg_era_minus"] if p else None
                    return round(10000.0 / em) if em and em > 0 else None
                elif stat_name == "avg_xfip":
                    return round(p["avg_xfip"], 2) if p and p["avg_xfip"] else None
                elif stat_name == "total_k":
                    return p["k"] if p else None
                elif stat_name == "total_pwar":
                    return round(p["total_pwar"], 1) if p and p["total_pwar"] else 0
                elif stat_name == "pitching_k_pct":
                    return round(p["avg_k_pct"], 3) if p and p["avg_k_pct"] else None
                elif stat_name == "pitching_bb_pct":
                    return round(p["avg_bb_pct"], 3) if p and p["avg_bb_pct"] else None
                elif stat_name == "total_ip":
                    return round(p["ip"], 1) if p and p["ip"] else None
                elif stat_name == "total_war":
                    owar = b["total_owar"] or 0
                    pwar = (p["total_pwar"] or 0) if p else 0
                    return round(owar + pwar, 1)
                elif stat_name == "pitching_k_bb_pct":
                    kp = (p["avg_k_pct"] or 0) if p else 0
                    bp = (p["avg_bb_pct"] or 0) if p else 0
                    return round(kp - bp, 3) if p else None
                elif stat_name == "win_pct":
                    rec = record_map.get(tid)
                    if not rec:
                        return None
                    total = (rec["wins"] or 0) + (rec["losses"] or 0)
                    return round(rec["wins"] / total, 3) if total > 0 else None
                elif stat_name == "conf_win_pct":
                    rec = record_map.get(tid)
                    if not rec:
                        return None
                    total = (rec["conference_wins"] or 0) + (rec["conference_losses"] or 0)
                    return round(rec["conference_wins"] / total, 3) if total > 0 else None
                elif stat_name == "run_diff":
                    runs_scored = b["r"] or 0
                    ra = (p["ra"] or p["er"] or 0) if p else 0
                    return int(runs_scored - ra)
                return None

            x_val = _compute(x_stat)
            y_val = _compute(y_stat)

            if x_val is None or y_val is None:
                continue

            results.append({
                "team_id": tid,
                "name": team["name"],
                "short_name": team["short_name"],
                "logo_url": team["logo_url"],
                "division_level": team["division_level"],
                "conference_abbrev": team["conference_abbrev"],
                "x": x_val,
                "y": y_val,
            })

        return results


@router.get("/teams/correlations")
@cached_endpoint(ttl_seconds=21600)  # all-teams fan-out; 6h (daily-scrape cadence)
def team_correlations(
    season: int = Query(..., description="Season year"),
    division_id: Optional[int] = Query(None, description="Filter by division"),
):
    """
    Compute Pearson r between every stat and win% for a correlation table.
    Returns a list of {stat, label, group, r, abs_r, n} sorted by |r| descending.
    """
    import math as _math

    stat_meta = [
        ("team_avg", "Team AVG", "Batting"),
        ("team_obp", "Team OBP", "Batting"),
        ("team_slg", "Team SLG", "Batting"),
        ("team_ops", "Team OPS", "Batting"),
        ("avg_woba", "Avg wOBA", "Batting"),
        ("avg_wrc_plus", "Avg wRC+", "Batting"),
        ("avg_iso", "Avg ISO", "Batting"),
        ("total_hr", "Total HR", "Batting"),
        ("total_runs", "Total Runs", "Batting"),
        ("total_sb", "Total SB", "Batting"),
        ("avg_bb_pct", "BB% (Batting)", "Batting"),
        ("avg_k_pct", "K% (Batting)", "Batting"),
        ("total_owar", "Offensive WAR", "Batting"),
        ("team_era", "Team ERA", "Pitching"),
        ("team_whip", "Team WHIP", "Pitching"),
        ("avg_fip", "Avg FIP", "Pitching"),
        ("avg_xfip", "Avg xFIP", "Pitching"),
        ("total_k", "Total K (Pitching)", "Pitching"),
        ("pitching_k_pct", "K% (Pitching)", "Pitching"),
        ("pitching_bb_pct", "BB% (Pitching)", "Pitching"),
        ("pitching_k_bb_pct", "K-BB% (Pitching)", "Pitching"),
        ("total_pwar", "Pitching WAR", "Pitching"),
        ("total_war", "Total WAR", "Overall"),
        ("run_diff", "Run Differential", "Overall"),
    ]

    with get_connection() as conn:
        cur = conn.cursor()

        # Get teams
        team_q = """
            SELECT t.id, t.short_name, d.level as division_level
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE t.is_active = 1
        """
        t_params = []
        if division_id:
            team_q += " AND c.division_id = %s"
            t_params.append(division_id)
        cur.execute(team_q, t_params)
        teams = cur.fetchall()

        # Get records
        cur.execute(
            "SELECT team_id, wins, losses FROM team_season_stats WHERE season = %s",
            (season,),
        )
        rec_map = {r["team_id"]: r for r in cur.fetchall()}

        # For each team, compute all stats + win%
        team_data = []
        for team in teams:
            tid = team["id"]
            rec = rec_map.get(tid)
            if not rec:
                continue
            total_games = (rec["wins"] or 0) + (rec["losses"] or 0)
            if total_games < 5:
                continue
            win_pct = rec["wins"] / total_games

            cur.execute(
                """SELECT SUM(plate_appearances) as pa, SUM(at_bats) as ab,
                       SUM(hits) as h, SUM(doubles) as d2b, SUM(triples) as d3b,
                       SUM(home_runs) as hr, SUM(runs) as r, SUM(walks) as bb,
                       SUM(hit_by_pitch) as hbp, SUM(strikeouts) as k,
                       SUM(stolen_bases) as sb,
                       -- Rate stats: PA-weighted with NULL guards.
                       -- bb_pct/k_pct rebuilt from raw totals.
                       SUM(woba * plate_appearances) FILTER (WHERE woba IS NOT NULL)
                         / NULLIF(SUM(plate_appearances) FILTER (WHERE woba IS NOT NULL), 0) as avg_woba,
                       SUM(wrc_plus * plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL)
                         / NULLIF(SUM(plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL), 0) as avg_wrc_plus,
                       SUM(iso * plate_appearances) FILTER (WHERE iso IS NOT NULL)
                         / NULLIF(SUM(plate_appearances) FILTER (WHERE iso IS NOT NULL), 0) as avg_iso,
                       SUM(walks)::numeric / NULLIF(SUM(plate_appearances), 0) as avg_bb_pct,
                       SUM(strikeouts)::numeric / NULLIF(SUM(plate_appearances), 0) as avg_k_pct,
                       SUM(offensive_war) as total_owar
                   FROM batting_stats
                   WHERE team_id = %s AND season = %s AND plate_appearances >= 10""",
                (tid, season),
            )
            b = cur.fetchone()
            if not b or not b["ab"]:
                continue

            cur.execute(
                """SELECT outs_to_ip(SUM(ip_outs(innings_pitched))) as ip,
                       (SUM(ip_outs(innings_pitched)) / 3.0)::float8 as ip_true,
                       SUM(earned_runs) as er,
                       SUM(runs_allowed) as ra,
                       SUM(walks) as bb, SUM(hits_allowed) as h,
                       SUM(strikeouts) as k, SUM(home_runs_allowed) as hr,
                       -- Rate stats: IP-weighted with NULL guards.
                       -- k_pct/bb_pct rebuilt from raw totals over batters_faced.
                       SUM(fip * ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL)
                         / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL), 0) as avg_fip,
                       SUM(xfip * ip_outs(innings_pitched)) FILTER (WHERE xfip IS NOT NULL)
                         / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE xfip IS NOT NULL), 0) as avg_xfip,
                       SUM(strikeouts)::numeric / NULLIF(SUM(batters_faced), 0) as avg_k_pct,
                       SUM(walks)::numeric / NULLIF(SUM(batters_faced), 0) as avg_bb_pct,
                       SUM(pitching_war) as total_pwar
                   FROM pitching_stats
                   WHERE team_id = %s AND season = %s AND innings_pitched >= 3""",
                (tid, season),
            )
            p = cur.fetchone()

            ab = b["ab"] or 1
            pa = b["pa"] or 1
            ip = (p["ip_true"] or 0) if p else 0

            vals = {"win_pct": win_pct}
            vals["team_avg"] = b["h"] / ab if ab else None
            vals["team_obp"] = (b["h"] + b["bb"] + b["hbp"]) / pa if pa else None
            tb = (b["h"] - b["d2b"] - b["d3b"] - b["hr"]) + 2 * b["d2b"] + 3 * b["d3b"] + 4 * b["hr"]
            vals["team_slg"] = tb / ab if ab else None
            vals["team_ops"] = (vals["team_obp"] or 0) + (vals["team_slg"] or 0) if vals["team_obp"] and vals["team_slg"] else None
            vals["avg_woba"] = float(b["avg_woba"]) if b["avg_woba"] else None
            vals["avg_wrc_plus"] = float(b["avg_wrc_plus"]) if b["avg_wrc_plus"] else None
            vals["avg_iso"] = float(b["avg_iso"]) if b["avg_iso"] else None
            vals["total_hr"] = b["hr"]
            vals["total_runs"] = b["r"]
            vals["total_sb"] = b["sb"]
            vals["avg_bb_pct"] = float(b["avg_bb_pct"]) if b["avg_bb_pct"] else None
            vals["avg_k_pct"] = float(b["avg_k_pct"]) if b["avg_k_pct"] else None
            vals["total_owar"] = float(b["total_owar"]) if b["total_owar"] else 0

            vals["team_era"] = (p["er"] * 9 / ip) if p and ip > 0 else None
            vals["team_whip"] = ((p["bb"] + p["h"]) / ip) if p and ip > 0 else None
            vals["avg_fip"] = float(p["avg_fip"]) if p and p["avg_fip"] else None
            vals["avg_xfip"] = float(p["avg_xfip"]) if p and p["avg_xfip"] else None
            vals["total_k"] = p["k"] if p else None
            vals["pitching_k_pct"] = float(p["avg_k_pct"]) if p and p["avg_k_pct"] else None
            vals["pitching_bb_pct"] = float(p["avg_bb_pct"]) if p and p["avg_bb_pct"] else None
            vals["pitching_k_bb_pct"] = (float(p["avg_k_pct"]) - float(p["avg_bb_pct"])) if p and p["avg_k_pct"] and p["avg_bb_pct"] else None
            vals["total_pwar"] = float(p["total_pwar"]) if p and p["total_pwar"] else 0
            vals["total_war"] = vals["total_owar"] + vals["total_pwar"]
            ra = (p["ra"] or p["er"] or 0) if p else 0
            vals["run_diff"] = (b["r"] or 0) - ra

            team_data.append(vals)

        # Compute Pearson r for each stat vs win%
        def _pearson(xs, ys):
            n = len(xs)
            if n < 3:
                return None
            sx = sum(xs)
            sy = sum(ys)
            sxy = sum(x * y for x, y in zip(xs, ys))
            sx2 = sum(x * x for x in xs)
            sy2 = sum(y * y for y in ys)
            num = n * sxy - sx * sy
            den = _math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy))
            return num / den if den > 0 else 0

        results = []
        win_pcts = [d["win_pct"] for d in team_data]

        for stat_key, label, group in stat_meta:
            pairs = [(d[stat_key], d["win_pct"]) for d in team_data if d.get(stat_key) is not None]
            if len(pairs) < 5:
                continue
            xs = [p[0] for p in pairs]
            ys = [p[1] for p in pairs]
            r_val = _pearson(xs, ys)
            if r_val is None:
                continue
            results.append({
                "stat": stat_key,
                "label": label,
                "group": group,
                "r": round(r_val, 3),
                "abs_r": round(abs(r_val), 3),
                "n": len(pairs),
            })

        results.sort(key=lambda x: x["abs_r"], reverse=True)
        return results


@router.get("/teams/{team_id}")
@cached_endpoint(ttl_seconds=3600)
def get_team(team_id: int):
    """Get detailed info for a single team."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT t.*, c.name as conference_name, c.abbreviation as conference_abbrev,
                      d.name as division_name, d.level as division_level
               FROM teams t
               JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id
               WHERE t.id = %s""",
            (team_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Team not found")
        return dict(row)


@router.get("/teams/{team_id}/rankings")
@cached_endpoint(ttl_seconds=1800)
def get_team_rankings(
    team_id: int,
    season: int = Query(CURRENT_SEASON, description="Season year"),
):
    """Get national rankings, conference rank, and SOS for a single team."""
    with get_connection() as conn:
        cur = conn.cursor()
        # 1. Get composite ranking data
        cur.execute("""
            SELECT cr.*, d.level as division_level
            FROM composite_rankings cr
            JOIN teams t ON cr.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE cr.team_id = %s AND cr.season = %s
        """, (team_id, season))
        composite = cur.fetchone()

        # 2. Get individual source ratings
        cur.execute("""
            SELECT source, national_rank, total_teams, rating, sos, sos_rank,
                   tsr, rqi, power_rating, sor, wab
            FROM national_ratings
            WHERE team_id = %s AND season = %s
        """, (team_id, season))
        sources = cur.fetchall()

        source_data = {row["source"]: dict(row) for row in sources}

        # 3. Compute conference rank from standings
        cur.execute("""
            SELECT t.conference_id, c.name as conference_name, c.abbreviation as conference_abbrev,
                   d.level as division_level
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE t.id = %s
        """, (team_id,))
        team_info = cur.fetchone()

        conf_rank = None
        conf_total = None
        conf_standings = []
        if team_info:
            cur.execute("""
                SELECT t.id, t.short_name,
                       COALESCE(s.wins, 0) as wins, COALESCE(s.losses, 0) as losses,
                       COALESCE(s.conference_wins, 0) as conf_wins,
                       COALESCE(s.conference_losses, 0) as conf_losses
                FROM teams t
                LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
                WHERE t.conference_id = %s AND t.is_active = 1
                ORDER BY
                    CASE WHEN (COALESCE(s.conference_wins, 0) + COALESCE(s.conference_losses, 0)) > 0
                         THEN CAST(COALESCE(s.conference_wins, 0) AS numeric) /
                              (COALESCE(s.conference_wins, 0) + COALESCE(s.conference_losses, 0))
                         ELSE CAST(COALESCE(s.wins, 0) AS numeric) /
                              NULLIF(COALESCE(s.wins, 0) + COALESCE(s.losses, 0), 0)
                    END DESC,
                    COALESCE(s.wins, 0) DESC
            """, (season, team_info["conference_id"]))
            conf_teams = cur.fetchall()

            conf_total = len(conf_teams)
            for i, ct in enumerate(conf_teams):
                entry = {
                    "team_id": ct["id"],
                    "short_name": ct["short_name"],
                    "wins": ct["wins"],
                    "losses": ct["losses"],
                    "conf_wins": ct["conf_wins"],
                    "conf_losses": ct["conf_losses"],
                    "rank": i + 1,
                }
                conf_standings.append(entry)
                if ct["id"] == team_id:
                    conf_rank = i + 1

        result = {
            "team_id": team_id,
            "season": season,
            "division_level": team_info["division_level"] if team_info else None,
            "conference_name": team_info["conference_name"] if team_info else None,
            "conference_abbrev": team_info["conference_abbrev"] if team_info else None,
            "composite": dict(composite) if composite else None,
            "sources": source_data,
            "conference_rank": conf_rank,
            "conference_total": conf_total,
            "conference_standings": conf_standings,
        }

        return result


# ============================================================
# TEAM INFO GRAPHIC (single-payload data for the social card)
# ============================================================

# ============================================================
# TEAM SEASON RECAP (end-of-year, positive-only social graphic)
# ============================================================

def _recap_ordinal(n):
    if n is None:
        return None
    if 10 <= (n % 100) <= 20:
        suf = "th"
    else:
        suf = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suf}"


def _recap_fmt_val(v, fmt):
    if v is None:
        return ""
    if fmt == "avg3":
        s = f"{v:.3f}"
        return s[1:] if 0 < v < 1 else s   # .812, not 0.812
    if fmt == "era":
        return f"{v:.2f}"
    if fmt == "plusint":
        return f"+{int(round(v))}" if v > 0 else f"{int(round(v))}"
    if fmt == "int":
        return f"{int(round(v))}"
    if fmt == "pct":
        return f"{v * 100:.1f}%"
    if fmt == "ratio":
        return f"{v:.2f}"
    return str(v)


def _scope_player_rank(cur, season, where_sql, where_param, table, stat, value, higher_better, min_col, min_val):
    """Rank a player's stat within a scope (conference or division), 1 = best.
    `table`, `stat`, `min_col`, `where_sql` are trusted constants."""
    if value is None:
        return None, None
    op = ">" if higher_better else "<"
    cur.execute(f"""
        SELECT
          (SELECT COUNT(*) FROM {table} s
             JOIN teams t ON t.id = s.team_id
             JOIN conferences c ON c.id = t.conference_id
             JOIN divisions d ON d.id = c.division_id
           WHERE s.season = %s AND {where_sql} AND s.{min_col} >= %s
             AND s.{stat} IS NOT NULL AND s.{stat} {op} %s) AS better,
          (SELECT COUNT(*) FROM {table} s
             JOIN teams t ON t.id = s.team_id
             JOIN conferences c ON c.id = t.conference_id
             JOIN divisions d ON d.id = c.division_id
           WHERE s.season = %s AND {where_sql} AND s.{min_col} >= %s
             AND s.{stat} IS NOT NULL) AS total
    """, (season, where_param, min_val, value, season, where_param, min_val))
    r = cur.fetchone()
    return (r["better"] or 0) + 1, (r["total"] or 0)


def _team_scope_metrics(cur, season, where_sql, where_param):
    """Deep per-team metric dict for every team in a scope (conference or
    division), aggregating team_season_stats + batting + pitching +
    fielding. `where_sql` is a trusted fragment over aliases t / c / d
    (e.g. "c.id = %s" or "d.level = %s")."""
    metrics = {}

    def ensure(tid):
        return metrics.setdefault(tid, {})

    cur.execute(f"""
        SELECT s.team_id, s.team_ops::float AS team_ops,
               s.team_batting_avg::float AS team_batting_avg,
               s.team_era::float AS team_era, s.team_whip::float AS team_whip,
               s.team_fielding_pct::float AS team_fielding_pct,
               s.run_differential::float AS run_diff
        FROM team_season_stats s
          JOIN teams t ON t.id = s.team_id
          JOIN conferences c ON c.id = t.conference_id
          JOIN divisions d ON d.id = c.division_id
        WHERE s.season = %s AND t.is_active = 1 AND {where_sql}
    """, (season, where_param))
    for r in cur.fetchall():
        m = ensure(r["team_id"])
        for k in ("team_ops", "team_batting_avg", "team_era", "team_whip",
                  "team_fielding_pct", "run_diff"):
            m[k] = r[k]

    cur.execute(f"""
        SELECT bs.team_id,
               SUM(bs.runs) AS runs,
               SUM(bs.home_runs) AS hr, SUM(bs.doubles) AS dbl, SUM(bs.triples) AS tpl,
               SUM(bs.stolen_bases) AS sb, SUM(bs.caught_stealing) AS cs,
               SUM(bs.walks) AS bb, SUM(bs.hit_by_pitch) AS hbp,
               SUM(bs.sacrifice_flies) AS sf, SUM(bs.sacrifice_bunts) AS sh,
               SUM(bs.rbi) AS rbi, SUM(bs.intentional_walks) AS ibb,
               SUM(bs.strikeouts) AS so,
               SUM(bs.at_bats) AS ab, SUM(bs.plate_appearances) AS pa,
               SUM(bs.woba * bs.plate_appearances) FILTER (WHERE bs.woba IS NOT NULL) AS wsum,
               SUM(bs.plate_appearances) FILTER (WHERE bs.woba IS NOT NULL) AS wpa,
               SUM(bs.wrc_plus * bs.plate_appearances) FILTER (WHERE bs.wrc_plus IS NOT NULL) AS rcsum,
               SUM(bs.plate_appearances) FILTER (WHERE bs.wrc_plus IS NOT NULL) AS rcpa,
               SUM(bs.on_base_pct * bs.plate_appearances) FILTER (WHERE bs.on_base_pct IS NOT NULL) AS obsum,
               SUM(bs.plate_appearances) FILTER (WHERE bs.on_base_pct IS NOT NULL) AS obpa,
               SUM(bs.slugging_pct * bs.plate_appearances) FILTER (WHERE bs.slugging_pct IS NOT NULL) AS slsum,
               SUM(bs.plate_appearances) FILTER (WHERE bs.slugging_pct IS NOT NULL) AS slpa
        FROM batting_stats bs
          JOIN teams t ON t.id = bs.team_id
          JOIN conferences c ON c.id = t.conference_id
          JOIN divisions d ON d.id = c.division_id
        WHERE bs.season = %s AND {where_sql} GROUP BY bs.team_id
    """, (season, where_param))
    for r in cur.fetchall():
        m = ensure(r["team_id"])
        gv = lambda k: (r[k] or 0)
        pa, ab = gv("pa"), gv("ab")
        m["hr"], m["doubles"], m["triples"] = gv("hr"), gv("dbl"), gv("tpl")
        m["sb"], m["bb"], m["hbp"] = gv("sb"), gv("bb"), gv("hbp")
        m["sf"], m["sh"], m["rbi"], m["ibb"] = gv("sf"), gv("sh"), gv("rbi"), gv("ibb")
        m["runs_scored"] = gv("runs")   # reliable across divisions (team_season_stats is sparse for D1)
        m["xbh"] = gv("dbl") + gv("tpl") + gv("hr")
        m["bb_rate"] = (gv("bb") / pa) if pa else None
        m["h_k_rate"] = (gv("so") / pa) if pa else None   # hitter K rate — LOWER is better
        m["sb_rate"] = (gv("sb") / pa) if pa else None
        m["iso"] = ((gv("dbl") + 2 * gv("tpl") + 3 * gv("hr")) / ab) if ab else None
        att = gv("sb") + gv("cs")
        m["sb_success"] = (gv("sb") / att) if att >= 10 else None
        m["woba"] = (r["wsum"] / r["wpa"]) if r["wpa"] else None
        m["wrc_plus"] = (r["rcsum"] / r["rcpa"]) if r["rcpa"] else None
        m["obp"] = (r["obsum"] / r["obpa"]) if r["obpa"] else None
        m["slg"] = (r["slsum"] / r["slpa"]) if r["slpa"] else None

    cur.execute(f"""
        SELECT ps.team_id,
               SUM(ps.strikeouts) AS k, SUM(ps.saves) AS sv, SUM(ps.complete_games) AS cg,
               SUM(ps.shutouts) AS sho, SUM(ps.quality_starts) AS qs,
               SUM(ps.walks) AS bb, SUM(ps.batters_faced) AS bf
        FROM pitching_stats ps
          JOIN teams t ON t.id = ps.team_id
          JOIN conferences c ON c.id = t.conference_id
          JOIN divisions d ON d.id = c.division_id
        WHERE ps.season = %s AND {where_sql} GROUP BY ps.team_id
    """, (season, where_param))
    for r in cur.fetchall():
        m = ensure(r["team_id"])
        gv = lambda k: (r[k] or 0)
        bf = gv("bf")
        m["p_k"], m["sv"], m["cg"] = gv("k"), gv("sv"), gv("cg")
        m["sho"], m["qs"] = gv("sho"), gv("qs")
        m["p_k_rate"] = (gv("k") / bf) if bf else None
        m["p_bb_rate"] = (gv("bb") / bf) if bf else None   # pitcher walk rate — LOWER is better
        m["k_bb"] = (gv("k") / gv("bb")) if gv("bb") else None

    cur.execute(f"""
        SELECT fs.team_id, SUM(fs.caught_stealing_by) AS csb,
               SUM(fs.stolen_bases_against) AS sba
        FROM fielding_stats fs
          JOIN teams t ON t.id = fs.team_id
          JOIN conferences c ON c.id = t.conference_id
          JOIN divisions d ON d.id = c.division_id
        WHERE fs.season = %s AND {where_sql} GROUP BY fs.team_id
    """, (season, where_param))
    for r in cur.fetchall():
        m = ensure(r["team_id"])
        gv = lambda k: (r[k] or 0)
        m["cs_caught"] = gv("csb")
        catt = gv("csb") + gv("sba")
        m["cs_rate"] = (gv("csb") / catt) if catt >= 10 else None

    return metrics


# (metric, label, higher_is_better, tier, fmt). tier 1 = headline,
# 2 = solid, 3 = quirky. Deep + quirky so even a weak team leads in
# SOMETHING within its conference. All framed positively.
_SUPERLATIVE_CATALOG = [
    ("team_ops",          "OPS",                        True,  1, "avg3"),
    ("team_batting_avg",  "batting average",            True,  1, "avg3"),
    ("obp",               "on-base percentage",         True,  1, "avg3"),
    ("slg",               "slugging percentage",        True,  1, "avg3"),
    ("woba",              "wOBA",                       True,  1, "avg3"),
    ("wrc_plus",          "wRC+",                       True,  1, "int"),
    ("team_era",          "team ERA",                   False, 1, "era"),
    ("team_whip",         "WHIP",                       False, 1, "era"),
    ("runs_scored",       "runs scored",                True,  2, "int"),
    ("hr",                "home runs",                  True,  2, "int"),
    ("sb",                "stolen bases",               True,  2, "int"),
    ("p_k",               "strikeouts",                 True,  2, "int"),
    ("p_k_rate",          "pitching strikeout rate",    True,  2, "pct"),
    ("p_bb_rate",         "pitching walk rate",         False, 2, "pct"),   # fewer walks = better
    ("k_bb",              "strikeout-to-walk ratio",    True,  2, "ratio"),
    ("qs",                "quality starts",             True,  2, "int"),
    ("team_fielding_pct", "fielding percentage",        True,  2, "avg3"),
    ("iso",               "isolated power",             True,  2, "avg3"),
    ("bb_rate",           "walk rate",                  True,  2, "pct"),
    ("h_k_rate",          "strikeout rate",             False, 2, "pct"),   # hitters: fewer Ks = better
    ("run_diff",          "run differential",           True,  2, "plusint"),  # gated > 0
    ("xbh",               "extra-base hits",            True,  3, "int"),
    ("doubles",           "doubles",                    True,  3, "int"),
    ("triples",           "triples",                    True,  3, "int"),
    ("rbi",               "RBI",                        True,  3, "int"),
    ("bb",                "walks drawn",                True,  3, "int"),
    ("hbp",               "times hit by pitch",         True,  3, "int"),
    ("sf",                "sacrifice flies",            True,  3, "int"),
    ("sh",                "sacrifice bunts",            True,  3, "int"),
    ("ibb",               "intentional walks drawn",    True,  3, "int"),
    ("sb_success",        "stolen-base success rate",   True,  3, "pct"),
    ("sb_rate",           "stolen-base rate",           True,  3, "pct"),
    ("sv",                "saves",                      True,  3, "int"),
    ("cg",                "complete games",             True,  3, "int"),
    ("sho",               "shutouts",                   True,  3, "int"),
    ("cs_caught",         "runners thrown out",         True,  3, "int"),
    ("cs_rate",           "caught-stealing rate",       True,  3, "pct"),
]


def _compute_superlative(cur, team, season, conf_rows, best_hitter, best_pitcher):
    """Find the most flattering, genuinely-positive 'they excelled at'
    line. Ranks the team within its conference across ~35 categories
    (headline rate stats down to quirky counting stats) plus the standout
    player's conference ranks, and surfaces the team's best finish so
    even a weak team leads in something. Returns None only if the
    conference is too small to rank."""
    conf_id = team["conference_id"]
    team_id = team["id"]
    cands = []  # (rank, tier, kind_priority, text)  kind: 0=player, 1=team

    # Prefer conference scope; fall back to division-wide ranking when the
    # conference is too small to rank meaningfully (independents, sparse D1
    # conferences we only partially track).
    # Count teams with DEEP (rankable batting/pitching) data — not the
    # shallow run-differential-only shells we create for out-of-region
    # opponents. A conference where we only deeply track one member (e.g.
    # a PNW D1 team in a mostly out-of-region conference like the MWC)
    # can't rank team stats meaningfully, so fall back to the division-wide
    # PNW pool instead of defaulting to a standout-player line.
    def _deep(m):
        return sum(1 for mm in m.values()
                   if mm.get("runs_scored") is not None or mm.get("p_k") is not None)

    metrics = _team_scope_metrics(cur, season, "c.id = %s", conf_id)
    if _deep(metrics) >= 3:
        where_sql, where_param = "c.id = %s", conf_id
        scope = team.get("conference_abbrev") or team.get("conference_name") or "their conference"
    else:
        lvl = team.get("division_level")
        where_sql, where_param = "d.level = %s", lvl
        metrics = _team_scope_metrics(cur, season, where_sql, where_param)
        # We only deeply track PNW teams, so this pool is the PNW members of
        # the division. Label it "PNW D1" etc. rather than "NCAA D1" so the
        # graphic never overclaims a national rank.
        scope = {"D1": "PNW D1", "D2": "PNW D2", "D3": "PNW D3",
                 "NAIA": "PNW NAIA", "JUCO": "the NWAC"}.get(str(lvl), str(lvl) or "their division")

    for metric, label, higher, tier, fmt in _SUPERLATIVE_CATALOG:
        vals = [(tid, mm[metric]) for tid, mm in metrics.items() if mm.get(metric) is not None]
        if len(vals) < 3:
            continue
        if metric == "run_diff":
            mine = next((v for tid, v in vals if tid == team_id), None)
            if mine is None or mine <= 0:
                continue
        vals.sort(key=lambda x: x[1], reverse=higher)
        rank = next((i + 1 for i, (tid, _) in enumerate(vals) if tid == team_id), None)
        if rank is None:
            continue
        my_val = next(v for tid, v in vals if tid == team_id)
        # Never surface a zero/empty "strength" (e.g. a sparse-data column
        # where every team reads 0) — leading in 0-of-something is meaningless.
        if not my_val:
            continue
        vs = _recap_fmt_val(my_val, fmt)
        if higher:
            text = (f"Led the {scope} in {label} ({vs})" if rank == 1
                    else f"{_recap_ordinal(rank)} in the {scope} in {label} ({vs})")
        else:
            text = (f"Had the {scope}'s lowest {label} ({vs})" if rank == 1
                    else f"{_recap_ordinal(rank)}-lowest {label} in the {scope} ({vs})")
        cands.append((rank, tier, 1, text))

    # ── Standout-player candidates (top-3 in conference) ──
    def add_player(player, value, stat_col, label, higher, table, min_col, min_val, fmt, floor=None):
        if not player or value is None or (floor is not None and value < floor):
            return
        rank, total = _scope_player_rank(cur, season, where_sql, where_param, table, stat_col,
                                         value, higher, min_col, min_val)
        if not rank or total < 3 or rank > 3:
            return
        nm = f"{player['first_name']} {player['last_name']}"
        vs = _recap_fmt_val(value, fmt)
        text = (f"{nm} led the {scope} in {label} ({vs})" if rank == 1
                else f"{nm} ranked {_recap_ordinal(rank)} in the {scope} in {label} ({vs})")
        cands.append((rank, 1, 0, text))

    if best_hitter:
        add_player(best_hitter, best_hitter.get("wrc_plus"), "wrc_plus", "wRC+", True,
                   "batting_stats", "plate_appearances", 50, "int")
        add_player(best_hitter, best_hitter.get("sb"), "stolen_bases", "stolen bases", True,
                   "batting_stats", "plate_appearances", 50, "int", floor=8)
        add_player(best_hitter, best_hitter.get("hr"), "home_runs", "home runs", True,
                   "batting_stats", "plate_appearances", 50, "int", floor=5)
    if best_pitcher:
        add_player(best_pitcher, best_pitcher.get("era"), "era", "ERA", False,
                   "pitching_stats", "innings_pitched", 20, "era")

    if not cands:
        return None
    # "THEY EXCELLED AT" describes the TEAM, so always prefer a team-stat
    # line (kind_priority 1) over a standout-player line (kind_priority 0).
    # A player line is only a last resort for teams with no rankable team
    # stat at all (the standout already has their own Best Hitter/Pitcher
    # card, so we never duplicate a player here when a team stat exists).
    # Within the chosen kind: best finish first, then headline tiers.
    cands.sort(key=lambda c: (0 if c[2] == 1 else 1, c[0], c[1]))
    rank, tier, kind_priority, text = cands[0]
    return {"text": text, "rank": rank, "kind": "player" if kind_priority == 0 else "team"}


@router.get("/teams/{team_id}/season-recap")
@cached_endpoint(ttl_seconds=1800)
def team_season_recap(
    team_id: int,
    season: int = Query(CURRENT_SEASON, description="Season year"),
):
    """Positive-only end-of-year team snapshot for the season-recap social
    graphic: record + conference standing, longest win streak, best hitter
    & best pitcher (by WAR), freshman of the year, a team superlative (best
    conference rank in a team stat), and the most clutch moment (highest
    hitter WPA play of the season)."""
    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute("""
            SELECT t.id, t.name, t.short_name, t.logo_url, t.mascot, t.city, t.state,
                   t.conference_id, c.name AS conference_name, c.abbreviation AS conference_abbrev,
                   d.id AS division_id, d.level AS division_level, d.name AS division_name
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE t.id = %s
        """, (team_id,))
        team = cur.fetchone()
        if not team:
            raise HTTPException(status_code=404, detail="Team not found")
        team = dict(team)

        cur.execute("""
            SELECT wins, losses, ties, conference_wins, conference_losses,
                   team_ops, team_batting_avg, team_era, team_whip, team_fielding_pct,
                   run_differential, runs_scored, runs_allowed
            FROM team_season_stats WHERE team_id = %s AND season = %s
        """, (team_id, season))
        rec = dict(cur.fetchone() or {})

        # Conference standing place (same ordering as /teams/{id}/rankings)
        cur.execute("""
            SELECT t.id FROM teams t
            LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
            WHERE t.conference_id = %s AND t.is_active = 1
            ORDER BY
                CASE WHEN (COALESCE(s.conference_wins,0) + COALESCE(s.conference_losses,0)) > 0
                     THEN CAST(COALESCE(s.conference_wins,0) AS numeric) /
                          (COALESCE(s.conference_wins,0) + COALESCE(s.conference_losses,0))
                     ELSE CAST(COALESCE(s.wins,0) AS numeric) /
                          NULLIF(COALESCE(s.wins,0) + COALESCE(s.losses,0), 0) END DESC,
                COALESCE(s.wins,0) DESC
        """, (season, team["conference_id"]))
        conf_ids = [r["id"] for r in cur.fetchall()]
        conf_total = len(conf_ids)
        conf_place = conf_ids.index(team_id) + 1 if team_id in conf_ids else None

        # Longest win streak (chronological)
        cur.execute("""
            SELECT g.home_team_id, g.home_score, g.away_score
            FROM games g
            WHERE g.season = %s AND g.status = 'final'
              AND (g.home_team_id = %s OR g.away_team_id = %s)
              AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
            ORDER BY g.game_date, g.id
        """, (season, team_id, team_id))
        streak = longest = 0
        for g in cur.fetchall():
            is_home = g["home_team_id"] == team_id
            ts = g["home_score"] if is_home else g["away_score"]
            os_ = g["away_score"] if is_home else g["home_score"]
            if ts > os_:
                streak += 1
                longest = max(longest, streak)
            elif ts < os_:
                streak = 0
        longest_win_streak = longest

        # Best hitter by oWAR (qualified)
        cur.execute(f"""
            SELECT p.id, p.first_name, p.last_name, p.position, p.year_in_school, p.headshot_url,
                   bs.woba::float AS woba, bs.wrc_plus::float AS wrc_plus,
                   bs.offensive_war::float AS war, bs.plate_appearances AS pa,
                   bs.home_runs AS hr, bs.rbi AS rbi, bs.stolen_bases AS sb,
                   bs.batting_avg::float AS avg, bs.on_base_pct::float AS obp,
                   bs.slugging_pct::float AS slg
            FROM batting_stats bs JOIN players p ON bs.player_id = p.id
            LEFT JOIN team_season_stats tss ON tss.team_id = bs.team_id AND tss.season = bs.season
            WHERE bs.team_id = %s AND bs.season = %s AND bs.offensive_war IS NOT NULL
              AND bs.plate_appearances >= {QUALIFIED_PA_PER_GAME}
                  * (COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0))
            ORDER BY bs.offensive_war DESC NULLS LAST LIMIT 1
        """, (team_id, season))
        r = cur.fetchone()
        best_hitter = dict(r) if r else None

        # Best pitcher by pWAR (min 5 IP)
        cur.execute("""
            SELECT p.id, p.first_name, p.last_name, p.position, p.year_in_school, p.headshot_url,
                   ps.siera::float AS siera, ps.era::float AS era,
                   ps.fip::float AS fip, ps.whip::float AS whip,
                   ps.walks AS bb, ps.strikeouts AS k,
                   (COALESCE(ps.k_pct,0) * 100)::float AS k_pct,
                   ps.pitching_war::float AS war, ps.innings_pitched::float AS ip,
                   CASE WHEN (COALESCE(ps.batters_faced,0) - COALESCE(ps.walks,0) - COALESCE(ps.hit_batters,0)) > 0
                        THEN COALESCE(ps.hits_allowed,0)::float
                             / (ps.batters_faced - COALESCE(ps.walks,0) - COALESCE(ps.hit_batters,0))
                        END AS baa
            FROM pitching_stats ps JOIN players p ON ps.player_id = p.id
            WHERE ps.team_id = %s AND ps.season = %s
              AND COALESCE(ps.innings_pitched,0) >= 5 AND ps.pitching_war IS NOT NULL
            ORDER BY ps.pitching_war DESC NULLS LAST LIMIT 1
        """, (team_id, season))
        r = cur.fetchone()
        best_pitcher = dict(r) if r else None

        # Freshman of the year (Fr / R-Fr; best WAR, hitter or pitcher).
        # Exclude the Best Hitter / Best Pitcher so it's always a 3rd player.
        exclude_ids = [pid for pid in [(best_hitter or {}).get("id"),
                                       (best_pitcher or {}).get("id")] if pid]
        cur.execute("""
            SELECT p.id, p.first_name, p.last_name, p.position, p.year_in_school, p.headshot_url,
                   bs.woba::float AS woba, bs.wrc_plus::float AS wrc_plus,
                   bs.offensive_war::float AS war, bs.plate_appearances AS pa,
                   bs.home_runs AS hr, bs.rbi AS rbi, bs.stolen_bases AS sb,
                   bs.batting_avg::float AS avg, bs.on_base_pct::float AS obp,
                   bs.slugging_pct::float AS slg
            FROM batting_stats bs JOIN players p ON bs.player_id = p.id
            WHERE bs.team_id = %s AND bs.season = %s AND p.year_in_school ILIKE '%%fr'
              AND bs.offensive_war IS NOT NULL AND bs.plate_appearances >= 20
              AND p.id <> ALL(%s::int[])
            ORDER BY bs.offensive_war DESC NULLS LAST LIMIT 1
        """, (team_id, season, exclude_ids))
        fr_h = cur.fetchone()
        fr_h = dict(fr_h) if fr_h else None
        cur.execute("""
            SELECT p.id, p.first_name, p.last_name, p.position, p.year_in_school, p.headshot_url,
                   ps.siera::float AS siera, ps.era::float AS era,
                   ps.fip::float AS fip, ps.whip::float AS whip,
                   ps.walks AS bb, ps.strikeouts AS k,
                   (COALESCE(ps.k_pct,0) * 100)::float AS k_pct,
                   ps.pitching_war::float AS war, ps.innings_pitched::float AS ip,
                   CASE WHEN (COALESCE(ps.batters_faced,0) - COALESCE(ps.walks,0) - COALESCE(ps.hit_batters,0)) > 0
                        THEN COALESCE(ps.hits_allowed,0)::float
                             / (ps.batters_faced - COALESCE(ps.walks,0) - COALESCE(ps.hit_batters,0))
                        END AS baa
            FROM pitching_stats ps JOIN players p ON ps.player_id = p.id
            WHERE ps.team_id = %s AND ps.season = %s AND p.year_in_school ILIKE '%%fr'
              AND ps.pitching_war IS NOT NULL AND COALESCE(ps.innings_pitched,0) >= 10
              AND p.id <> ALL(%s::int[])
            ORDER BY ps.pitching_war DESC NULLS LAST LIMIT 1
        """, (team_id, season, exclude_ids))
        fr_p = cur.fetchone()
        fr_p = dict(fr_p) if fr_p else None
        freshman = None
        hw = fr_h["war"] if fr_h and fr_h.get("war") is not None else -999
        pw = fr_p["war"] if fr_p and fr_p.get("war") is not None else -999
        if fr_h and hw >= pw:
            freshman = {"kind": "hitter", **fr_h}
        elif fr_p:
            freshman = {"kind": "pitcher", **fr_p}

        # Transfer of the year — fallback when no freshman qualified.
        # A transfer is a non-freshman whose first season with THIS team is
        # the current season (no prior-season batting/pitching rows for this
        # team). Excludes best hitter / best pitcher so it's a distinct player.
        transfer = None
        if freshman is None:
            cur.execute("""
                SELECT p.id, p.first_name, p.last_name, p.position, p.year_in_school, p.headshot_url,
                       bs.woba::float AS woba, bs.wrc_plus::float AS wrc_plus,
                       bs.offensive_war::float AS war, bs.plate_appearances AS pa,
                       bs.home_runs AS hr, bs.rbi AS rbi, bs.stolen_bases AS sb,
                       bs.batting_avg::float AS avg, bs.on_base_pct::float AS obp,
                       bs.slugging_pct::float AS slg
                FROM batting_stats bs JOIN players p ON bs.player_id = p.id
                WHERE bs.team_id = %s AND bs.season = %s
                  AND (p.year_in_school IS NULL OR p.year_in_school NOT ILIKE '%%fr')
                  AND bs.offensive_war IS NOT NULL AND bs.plate_appearances >= 20
                  AND p.id <> ALL(%s::int[])
                  AND NOT EXISTS (SELECT 1 FROM batting_stats b2
                                  WHERE b2.player_id = p.id AND b2.team_id = %s AND b2.season < %s)
                  AND NOT EXISTS (SELECT 1 FROM pitching_stats p2
                                  WHERE p2.player_id = p.id AND p2.team_id = %s AND p2.season < %s)
                ORDER BY bs.offensive_war DESC NULLS LAST LIMIT 1
            """, (team_id, season, exclude_ids, team_id, season, team_id, season))
            tr_h = cur.fetchone()
            tr_h = dict(tr_h) if tr_h else None
            cur.execute("""
                SELECT p.id, p.first_name, p.last_name, p.position, p.year_in_school, p.headshot_url,
                       ps.siera::float AS siera, ps.era::float AS era,
                       ps.fip::float AS fip, ps.whip::float AS whip,
                       ps.walks AS bb, ps.strikeouts AS k,
                       (COALESCE(ps.k_pct,0) * 100)::float AS k_pct,
                       ps.pitching_war::float AS war, ps.innings_pitched::float AS ip,
                       CASE WHEN (COALESCE(ps.batters_faced,0) - COALESCE(ps.walks,0) - COALESCE(ps.hit_batters,0)) > 0
                            THEN COALESCE(ps.hits_allowed,0)::float
                                 / (ps.batters_faced - COALESCE(ps.walks,0) - COALESCE(ps.hit_batters,0))
                            END AS baa
                FROM pitching_stats ps JOIN players p ON ps.player_id = p.id
                WHERE ps.team_id = %s AND ps.season = %s
                  AND (p.year_in_school IS NULL OR p.year_in_school NOT ILIKE '%%fr')
                  AND ps.pitching_war IS NOT NULL AND COALESCE(ps.innings_pitched,0) >= 10
                  AND p.id <> ALL(%s::int[])
                  AND NOT EXISTS (SELECT 1 FROM batting_stats b2
                                  WHERE b2.player_id = p.id AND b2.team_id = %s AND b2.season < %s)
                  AND NOT EXISTS (SELECT 1 FROM pitching_stats p2
                                  WHERE p2.player_id = p.id AND p2.team_id = %s AND p2.season < %s)
                ORDER BY ps.pitching_war DESC NULLS LAST LIMIT 1
            """, (team_id, season, exclude_ids, team_id, season, team_id, season))
            tr_p = cur.fetchone()
            tr_p = dict(tr_p) if tr_p else None
            thw = tr_h["war"] if tr_h and tr_h.get("war") is not None else -999
            tpw = tr_p["war"] if tr_p and tr_p.get("war") is not None else -999
            if tr_h and thw >= tpw:
                transfer = {"kind": "hitter", **tr_h}
            elif tr_p:
                transfer = {"kind": "pitcher", **tr_p}

        # Team superlative (best conference rank in a team stat)
        cur.execute("""
            SELECT s.team_id,
                   s.team_ops::float AS team_ops, s.team_batting_avg::float AS team_batting_avg,
                   s.team_era::float AS team_era, s.team_whip::float AS team_whip,
                   s.team_fielding_pct::float AS team_fielding_pct,
                   s.run_differential::float AS run_differential, s.runs_scored::float AS runs_scored
            FROM team_season_stats s JOIN teams t ON t.id = s.team_id
            WHERE t.conference_id = %s AND s.season = %s AND t.is_active = 1
        """, (team["conference_id"], season))
        conf_rows = [dict(r2) for r2 in cur.fetchall()]
        superlative = _compute_superlative(cur, team, season, conf_rows, best_hitter, best_pitcher)

        # Most clutch moment (top hitter WPA, audit-clean games only)
        cur.execute("""
            WITH game_audit AS (
                SELECT g.id AS game_id
                FROM games g LEFT JOIN game_events e ON e.game_id = g.id
                WHERE g.season = %s AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
                GROUP BY g.id, g.home_score, g.away_score
                HAVING ABS((g.home_score + g.away_score) - COALESCE(SUM(e.runs_on_play), 0)) = 0
            )
            SELECT ge.batter_name, ge.pitcher_name, ge.result_type, ge.result_text,
                   ge.inning, ge.half, ge.bases_before, ge.outs_before,
                   ge.balls_before, ge.strikes_before,
                   ge.bat_score_before, ge.fld_score_before,
                   ge.wpa_batter::float AS wpa,
                   ge.wp_before::float AS wp_before, ge.wp_after::float AS wp_after,
                   g.game_date, g.home_team_id,
                   ht.short_name AS home_short, at2.short_name AS away_short
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            JOIN game_audit ga ON ga.game_id = ge.game_id
            LEFT JOIN teams ht ON ht.id = g.home_team_id
            LEFT JOIN teams at2 ON at2.id = g.away_team_id
            WHERE g.season = %s AND ge.wpa_batter IS NOT NULL
              AND ge.batter_player_id IS NOT NULL
              AND ge.batter_name IS NOT NULL
              AND ge.result_type NOT IN (
                  'stolen_base', 'caught_stealing', 'wild_pitch',
                  'passed_ball', 'balk', 'pickoff', 'runner_other'
              )
              AND ((ge.half = 'bottom' AND g.home_team_id = %s)
                   OR (ge.half = 'top' AND g.away_team_id = %s))
            ORDER BY ge.wpa_batter DESC LIMIT 1
        """, (season, season, team_id, team_id))
        cm = cur.fetchone()
        clutch = None
        if cm:
            cm = dict(cm)
            is_home = cm["half"] == "bottom"
            clutch = {
                "batter_name": cm["batter_name"], "pitcher_name": cm["pitcher_name"],
                "result_type": cm["result_type"], "result_text": cm["result_text"],
                "inning": cm["inning"], "half": cm["half"],
                "bases_before": cm["bases_before"], "outs_before": cm["outs_before"],
                "balls_before": cm["balls_before"], "strikes_before": cm["strikes_before"],
                "bat_score_before": cm["bat_score_before"], "fld_score_before": cm["fld_score_before"],
                "wpa": cm["wpa"], "wp_before": cm["wp_before"], "wp_after": cm["wp_after"],
                "game_date": cm["game_date"].isoformat() if cm["game_date"] else None,
                "home_away": "vs" if is_home else "@",
                "opponent_short": cm["away_short"] if is_home else cm["home_short"],
            }

        # Signature win: the win over the highest-ranked opponent (by
        # national composite rank), else the biggest-margin win.
        cur.execute("""
            SELECT g.game_date, g.home_team_id, g.home_score, g.away_score,
                   ht.short_name AS home_short, ht.name AS home_name,
                   at2.short_name AS away_short, at2.name AS away_name,
                   crh.composite_rank AS home_rank, cra.composite_rank AS away_rank
            FROM games g
            LEFT JOIN teams ht ON ht.id = g.home_team_id
            LEFT JOIN teams at2 ON at2.id = g.away_team_id
            LEFT JOIN composite_rankings crh ON crh.team_id = g.home_team_id AND crh.season = %s
            LEFT JOIN composite_rankings cra ON cra.team_id = g.away_team_id AND cra.season = %s
            WHERE g.season = %s AND g.status = 'final'
              AND (g.home_team_id = %s OR g.away_team_id = %s)
              AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
        """, (season, season, season, team_id, team_id))
        wins = []
        for g in cur.fetchall():
            g = dict(g)
            is_home = g["home_team_id"] == team_id
            ts = g["home_score"] if is_home else g["away_score"]
            os_ = g["away_score"] if is_home else g["home_score"]
            if ts is None or os_ is None or ts <= os_:
                continue
            wins.append({
                "game_date": g["game_date"].isoformat() if g["game_date"] else None,
                "home_away": "vs" if is_home else "@",
                "opponent_short": g["away_short"] if is_home else g["home_short"],
                "opponent_name": g["away_name"] if is_home else g["home_name"],
                "opponent_rank": g["away_rank"] if is_home else g["home_rank"],
                "team_score": ts, "opp_score": os_, "margin": ts - os_,
            })
        signature_win = None
        if wins:
            wins.sort(key=lambda w: (w["opponent_rank"] if w["opponent_rank"] is not None else 99999,
                                     -w["margin"]))
            signature_win = wins[0]

        # Team leaders. table / stat / min_col are trusted constants.
        def _leader(table, stat, lower=False, min_col=None, min_val=0, fmt="int"):
            direction = "ASC" if lower else "DESC"
            wm = f" AND s.{min_col} >= {min_val}" if min_col else ""
            cur.execute(f"""
                SELECT p.first_name, p.last_name, s.{stat} AS val
                FROM {table} s JOIN players p ON p.id = s.player_id
                WHERE s.team_id = %s AND s.season = %s AND s.{stat} IS NOT NULL{wm}
                ORDER BY s.{stat} {direction} NULLS LAST LIMIT 1
            """, (team_id, season))
            rr = cur.fetchone()
            if not rr or rr["val"] is None:
                return None
            v = float(rr["val"])
            if not lower and fmt == "int" and v <= 0:
                return None
            if fmt == "avg":
                disp = f"{v:.3f}"; disp = disp[1:] if disp.startswith("0.") else disp
            elif fmt == "era":
                disp = f"{v:.2f}"
            else:
                disp = str(int(round(v)))
            return {"name": f"{rr['first_name']} {rr['last_name']}", "display": disp}

        team_leaders = {
            "avg": _leader("batting_stats", "batting_avg", min_col="plate_appearances", min_val=40, fmt="avg"),
            "hr":  _leader("batting_stats", "home_runs"),
            "rbi": _leader("batting_stats", "rbi"),
            "sb":  _leader("batting_stats", "stolen_bases"),
            "r":   _leader("batting_stats", "runs"),
            "w":   _leader("pitching_stats", "wins"),
            "k":   _leader("pitching_stats", "strikeouts"),
            "sv":  _leader("pitching_stats", "saves"),
            "era": _leader("pitching_stats", "era", lower=True, min_col="innings_pitched", min_val=20, fmt="era"),
        }

    return {
        "team": team,
        "season": season,
        "record": {
            "wins": rec.get("wins"), "losses": rec.get("losses"), "ties": rec.get("ties"),
            "conference_wins": rec.get("conference_wins"),
            "conference_losses": rec.get("conference_losses"),
            "conference_place": conf_place, "conference_total": conf_total,
            "conference_place_ordinal": _recap_ordinal(conf_place),
        },
        "longest_win_streak": longest_win_streak,
        "best_hitter": best_hitter,
        "best_pitcher": best_pitcher,
        "freshman_of_year": freshman,
        "transfer_of_year": transfer,
        "superlative": superlative,
        "signature_win": signature_win,
        "team_leaders": team_leaders,
        "clutch_moment": clutch,
    }


@router.get("/teams/{team_id}/info-graphic")
def team_info_graphic(
    team_id: int,
    season: int = Query(CURRENT_SEASON, description="Season year"),
):
    """
    Single-payload data for the Team Info social graphic.

    Bundles team profile, head coach, record splits (overall / conf /
    home / away), run differential, Pythagorean expected wins,
    national + conference + power ratings, top 3 hitters and pitchers
    by WAR, last 5 games, and a Baseball Savant-style 8-stat
    percentile ranking vs other teams in the same division.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # ── 1. Team profile ──
        cur.execute("""
            SELECT t.id, t.name, t.short_name, t.logo_url, t.mascot,
                   t.city, t.state, t.conference_id,
                   c.name as conference_name,
                   c.abbreviation as conference_abbrev,
                   d.id as division_id,
                   d.level as division_level,
                   d.name as division_name
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE t.id = %s
        """, (team_id,))
        team = cur.fetchone()
        if not team:
            raise HTTPException(status_code=404, detail="Team not found")
        team = dict(team)

        # ── 2. Head coach ──
        cur.execute("""
            SELECT name FROM coaches
            WHERE team_id = %s AND role = 'head_coach'
            ORDER BY id LIMIT 1
        """, (team_id,))
        coach_row = cur.fetchone()
        head_coach = coach_row["name"] if coach_row else None

        # ── 3. Overall + conference record ──
        cur.execute("""
            SELECT wins, losses, ties,
                   conference_wins, conference_losses
            FROM team_season_stats
            WHERE team_id = %s AND season = %s
        """, (team_id, season))
        rec_row = cur.fetchone()
        rec = dict(rec_row) if rec_row else {}

        # ── 4. Home/away splits + runs for/against ──
        cur.execute("""
            SELECT
                COALESCE(SUM(CASE WHEN home_team_id = %s
                                  AND home_score > away_score THEN 1 ELSE 0 END), 0) AS home_wins,
                COALESCE(SUM(CASE WHEN home_team_id = %s
                                  AND home_score < away_score THEN 1 ELSE 0 END), 0) AS home_losses,
                COALESCE(SUM(CASE WHEN away_team_id = %s
                                  AND away_score > home_score THEN 1 ELSE 0 END), 0) AS away_wins,
                COALESCE(SUM(CASE WHEN away_team_id = %s
                                  AND away_score < home_score THEN 1 ELSE 0 END), 0) AS away_losses,
                COALESCE(SUM(CASE WHEN home_team_id = %s THEN home_score ELSE 0 END), 0) +
                COALESCE(SUM(CASE WHEN away_team_id = %s THEN away_score ELSE 0 END), 0) AS runs_for,
                COALESCE(SUM(CASE WHEN home_team_id = %s THEN away_score ELSE 0 END), 0) +
                COALESCE(SUM(CASE WHEN away_team_id = %s THEN home_score ELSE 0 END), 0) AS runs_against
            FROM games
            WHERE season = %s
              AND status = 'final'
              AND (home_team_id = %s OR away_team_id = %s)
        """, (team_id, team_id, team_id, team_id, team_id, team_id,
              team_id, team_id, season, team_id, team_id))
        splits = dict(cur.fetchone() or {})
        runs_for = int(splits.get("runs_for") or 0)
        runs_against = int(splits.get("runs_against") or 0)
        run_diff = runs_for - runs_against

        # Pythagorean expected wins (exponent 1.83, same as power-rating engine)
        wins = int(rec.get("wins") or 0)
        losses = int(rec.get("losses") or 0)
        total_games = wins + losses
        if total_games > 0 and (runs_for + runs_against) > 0:
            rs_c = max(float(runs_for), 1)
            ra_c = max(float(runs_against), 1)
            pyth_pct = rs_c ** 1.83 / (rs_c ** 1.83 + ra_c ** 1.83)
            pyth_wins = round(pyth_pct * total_games)
            pyth_losses = total_games - pyth_wins
        else:
            pyth_wins = None
            pyth_losses = None

        # ── 5. National rank (composite) + percentile ──
        cur.execute("""
            SELECT composite_rank, national_percentile, num_sources
            FROM composite_rankings
            WHERE team_id = %s AND season = %s
        """, (team_id, season))
        comp = cur.fetchone()
        national_rank = comp["composite_rank"] if comp else None
        natl_pct = float(comp["national_percentile"]) if comp and comp["national_percentile"] is not None else None

        # ── 6. SOS (averaged across rating sources) ──
        cur.execute("""
            SELECT AVG(sos) as avg_sos, AVG(sos_rank) as avg_sos_rank
            FROM national_ratings
            WHERE team_id = %s AND season = %s AND sos IS NOT NULL
        """, (team_id, season))
        sos_row = dict(cur.fetchone() or {})
        avg_sos = float(sos_row["avg_sos"]) if sos_row.get("avg_sos") is not None else None
        avg_sos_rank = int(sos_row["avg_sos_rank"]) if sos_row.get("avg_sos_rank") is not None else None

        # ── 7. Power rating (uses PA-weighted wRC+ and IP-weighted FIP to match playoff-projections) ──
        cur.execute("""
            SELECT SUM(runs) as rs,
                   SUM(offensive_war) as total_owar,
                   SUM(wrc_plus * plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL)
                     / NULLIF(SUM(plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL), 0) as avg_wrc_plus
            FROM batting_stats
            WHERE team_id = %s AND season = %s
        """, (team_id, season))
        bat_agg = dict(cur.fetchone() or {})
        cur.execute("""
            SELECT SUM(runs_allowed) as ra,
                   SUM(pitching_war) as total_pwar,
                   SUM(fip * ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL)
                     / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL), 0) as avg_fip
            FROM pitching_stats
            WHERE team_id = %s AND season = %s
        """, (team_id, season))
        pit_agg = dict(cur.fetchone() or {})
        total_war = float(bat_agg.get("total_owar") or 0) + float(pit_agg.get("total_pwar") or 0)
        pr_runs_for = int(bat_agg.get("rs") or runs_for)
        pr_runs_against = int(pit_agg.get("ra") or runs_against)
        power_rating = _compute_power_rating(
            wins, losses, pr_runs_for, pr_runs_against,
            bat_agg.get("avg_wrc_plus"), pit_agg.get("avg_fip"),
            total_war, team["division_level"], natl_pct,
        )

        # Power-rating ranks within conference AND within division
        # (rebuild ratings for all division teams, then filter for conf)
        power_rating_conf_rank = None
        power_rating_conf_total = None
        power_rating_div_rank = None
        power_rating_div_total = None
        try:
            cur.execute("""
                SELECT t.id, t.conference_id, t.division_level,
                       COALESCE(s.wins, 0) as wins,
                       COALESCE(s.losses, 0) as losses,
                       bat.rs, bat.total_owar, bat.avg_wrc_plus,
                       pit.ra, pit.total_pwar, pit.avg_fip,
                       nr.national_percentile
                FROM teams t
                JOIN conferences c ON t.conference_id = c.id
                LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
                LEFT JOIN (
                    SELECT team_id,
                           SUM(runs) as rs,
                           SUM(offensive_war) as total_owar,
                           SUM(wrc_plus * plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL)
                             / NULLIF(SUM(plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL), 0) as avg_wrc_plus
                    FROM batting_stats WHERE season = %s GROUP BY team_id
                ) bat ON bat.team_id = t.id
                LEFT JOIN (
                    SELECT team_id,
                           SUM(runs_allowed) as ra,
                           SUM(pitching_war) as total_pwar,
                           SUM(fip * ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL)
                             / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL), 0) as avg_fip
                    FROM pitching_stats WHERE season = %s GROUP BY team_id
                ) pit ON pit.team_id = t.id
                LEFT JOIN composite_rankings nr ON nr.team_id = t.id AND nr.season = %s
                WHERE c.division_id = %s AND t.is_active = 1
            """, (season, season, season, season, team["division_id"]))
            div_rows = [dict(r) for r in cur.fetchall()]
            div_ratings = []  # (team_id, conference_id, rating)
            for r in div_rows:
                twar = float(r.get("total_owar") or 0) + float(r.get("total_pwar") or 0)
                rating = _compute_power_rating(
                    r["wins"], r["losses"],
                    int(r["rs"] or 0), int(r["ra"] or 0),
                    r.get("avg_wrc_plus"), r.get("avg_fip"),
                    twar, r.get("division_level"), r.get("national_percentile"),
                )
                if rating is not None:
                    div_ratings.append((r["id"], r["conference_id"], rating))
            div_ratings.sort(key=lambda x: x[2], reverse=True)

            # Division rank = rank among all teams in this division
            power_rating_div_total = len(div_ratings)
            for idx, (tid, _, _) in enumerate(div_ratings):
                if tid == team_id:
                    power_rating_div_rank = idx + 1
                    break

            # Conference rank = rank among teams sharing this team's conference
            conf_subset = [row for row in div_ratings if row[1] == team["conference_id"]]
            power_rating_conf_total = len(conf_subset)
            for idx, (tid, _, _) in enumerate(conf_subset):
                if tid == team_id:
                    power_rating_conf_rank = idx + 1
                    break
        except Exception:
            # Rollback so the aborted transaction doesn't poison later queries
            try:
                conn.rollback()
            except Exception:
                pass

        # ── 8. Conference rank (same logic as /teams/{id}/rankings) ──
        cur.execute("""
            SELECT t.id
            FROM teams t
            LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
            WHERE t.conference_id = %s AND t.is_active = 1
            ORDER BY
                CASE WHEN (COALESCE(s.conference_wins, 0) + COALESCE(s.conference_losses, 0)) > 0
                     THEN CAST(COALESCE(s.conference_wins, 0) AS numeric) /
                          (COALESCE(s.conference_wins, 0) + COALESCE(s.conference_losses, 0))
                     ELSE CAST(COALESCE(s.wins, 0) AS numeric) /
                          NULLIF(COALESCE(s.wins, 0) + COALESCE(s.losses, 0), 0)
                END DESC,
                COALESCE(s.wins, 0) DESC
        """, (season, team["conference_id"]))
        conf_teams = cur.fetchall()
        conf_total = len(conf_teams)
        conf_rank = None
        for i, ct in enumerate(conf_teams):
            if ct["id"] == team_id:
                conf_rank = i + 1
                break

        # ── 9. Top 5 hitters by WAR (qualified) ──
        cur.execute(f"""
            SELECT p.id, p.first_name, p.last_name, p.position, p.year_in_school,
                   p.headshot_url,
                   bs.batting_avg::float as batting_avg,
                   bs.woba::float as woba,
                   bs.wrc_plus::float as wrc_plus,
                   bs.offensive_war::float as offensive_war,
                   bs.plate_appearances as plate_appearances,
                   bs.home_runs as home_runs,
                   bs.rbi as rbi,
                   bs.stolen_bases as stolen_bases
            FROM batting_stats bs
            JOIN players p ON bs.player_id = p.id
            LEFT JOIN team_season_stats tss ON tss.team_id = bs.team_id AND tss.season = bs.season
            WHERE bs.team_id = %s AND bs.season = %s
              AND bs.plate_appearances >= {QUALIFIED_PA_PER_GAME}
                  * (COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0))
              AND bs.offensive_war IS NOT NULL
            ORDER BY bs.offensive_war DESC NULLS LAST
            LIMIT 5
        """, (team_id, season))
        top_hitters = [dict(r) for r in cur.fetchall()]

        # ── 10. Top 5 pitchers by WAR (min 5 IP, includes non-qualified arms) ──
        # innings_pitched is baseball notation (5.2 = 5 2/3); leave as-is, the
        # frontend formats it for display. BAA = hits / (BF - BB - HBP).
        cur.execute("""
            SELECT p.id, p.first_name, p.last_name, p.position, p.year_in_school,
                   p.headshot_url,
                   ps.era::float as era,
                   ps.siera::float as siera,
                   (COALESCE(ps.k_pct, 0) * 100)::float as k_pct,
                   (COALESCE(ps.bb_pct, 0) * 100)::float as bb_pct,
                   ps.pitching_war::float as pitching_war,
                   ps.innings_pitched::float as innings_pitched,
                   CASE WHEN (COALESCE(ps.batters_faced, 0)
                              - COALESCE(ps.walks, 0)
                              - COALESCE(ps.hit_batters, 0)) > 0
                        THEN COALESCE(ps.hits_allowed, 0)::float
                             / (ps.batters_faced - COALESCE(ps.walks,0) - COALESCE(ps.hit_batters,0))
                        ELSE NULL END as baa
            FROM pitching_stats ps
            JOIN players p ON ps.player_id = p.id
            WHERE ps.team_id = %s AND ps.season = %s
              AND COALESCE(ps.innings_pitched, 0) >= 5
              AND ps.pitching_war IS NOT NULL
            ORDER BY ps.pitching_war DESC NULLS LAST
            LIMIT 5
        """, (team_id, season))
        top_pitchers = [dict(r) for r in cur.fetchall()]

        # ── 11. Last 5 games (most recent first; we'll reverse for left-to-right display) ──
        cur.execute("""
            SELECT g.id, g.game_date, g.home_team_id, g.away_team_id,
                   g.home_score, g.away_score,
                   ht.short_name AS home_short, ht.logo_url AS home_logo,
                   at2.short_name AS away_short, at2.logo_url AS away_logo
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at2 ON g.away_team_id = at2.id
            WHERE g.season = %s AND g.status = 'final'
              AND (g.home_team_id = %s OR g.away_team_id = %s)
            ORDER BY g.game_date DESC, g.id DESC
            LIMIT 5
        """, (season, team_id, team_id))
        last_5 = []
        for g in cur.fetchall():
            g = dict(g)
            is_home = g["home_team_id"] == team_id
            team_score = g["home_score"] if is_home else g["away_score"]
            opp_score = g["away_score"] if is_home else g["home_score"]
            opp_short = g["away_short"] if is_home else g["home_short"]
            opp_logo = g["away_logo"] if is_home else g["home_logo"]
            if team_score is None or opp_score is None:
                result = None
            elif team_score > opp_score:
                result = "W"
            elif team_score < opp_score:
                result = "L"
            else:
                result = "T"
            last_5.append({
                "date": g["game_date"].isoformat() if g["game_date"] else None,
                "home_away": "vs" if is_home else "@",
                "opponent_short": opp_short,
                "opponent_logo": opp_logo,
                "team_score": team_score,
                "opp_score": opp_score,
                "result": result,
            })
        last_5.reverse()  # oldest of the 5 on the left

        # ── 12. Team-level division ranks ──
        # Aggregate every team in the same division, then rank ours.
        # Hitter stats: AVG, wOBA, HR/PA, oWAR, wRC+
        #
        # wOBA and wRC+ are RATE stats — a player's value must be
        # weighted by his plate appearances so a 10-PA bench guy with
        # a 60 wRC+ doesn't drag the team down as much as a 180-PA
        # regular with a 130. This matches the PA-weighted formula
        # used by power-rating, team-ratings, and playoff-projections.
        # NULL guards: wOBA and wRC+ filter their own denominator to
        # rows where that stat is populated. Without this, a player
        # with PA >= 10 but a NULL advanced stat (e.g. two-way guys,
        # roster rows the advanced-stats job skipped) adds PA to
        # SUM(plate_appearances) while contributing 0 to the numerator
        # (NULL * PA = NULL, ignored by SUM). Net effect: the weighted
        # average gets silently deflated. Observed live: Bushnell team
        # wRC+ came back as 88 when the real value is 108.
        cur.execute("""
            SELECT t.id as team_id,
                   SUM(bs.hits)::float / NULLIF(SUM(bs.at_bats), 0) as batting_avg,
                   (SUM(bs.woba * bs.plate_appearances)
                      FILTER (WHERE bs.woba IS NOT NULL))::float
                     / NULLIF(SUM(bs.plate_appearances)
                              FILTER (WHERE bs.woba IS NOT NULL), 0) as woba,
                   SUM(bs.home_runs)::float / NULLIF(SUM(bs.plate_appearances), 0) as hr_per_pa,
                   SUM(bs.offensive_war)::float as owar,
                   (SUM(bs.wrc_plus * bs.plate_appearances)
                      FILTER (WHERE bs.wrc_plus IS NOT NULL))::float
                     / NULLIF(SUM(bs.plate_appearances)
                              FILTER (WHERE bs.wrc_plus IS NOT NULL), 0) as wrc_plus
            FROM teams t
            JOIN batting_stats bs ON bs.team_id = t.id AND bs.season = %s
                  AND bs.plate_appearances >= 10
            WHERE t.conference_id IN (
                SELECT id FROM conferences WHERE division_id = %s
            )
            GROUP BY t.id
        """, (season, team["division_id"]))
        bat_div = [dict(r) for r in cur.fetchall()]

        # Pitcher stats: ERA, SIERA, K%, BAA, pWAR
        #
        # SIERA is IP-weighted for the same reason wRC+ is PA-weighted:
        # a 1-IP mop-up arm shouldn't count as much as the ace. K% is
        # rebuilt from raw totals (SUM(K) / SUM(BF)) so it reflects
        # the team's actual strikeout rate, not an unweighted average
        # of per-pitcher rates.
        # BAA = hits_allowed / (batters_faced - walks - hit_batters)
        # SIERA uses a FILTER guard for the same reason wRC+/wOBA do
        # above: a NULL SIERA must not pull its IP into the denominator.
        cur.execute("""
            SELECT t.id as team_id,
                   (SUM(ps.earned_runs) * 9.0 / NULLIF(SUM(ip_outs(ps.innings_pitched)) / 3.0, 0))::float as era,
                   (SUM(ps.siera * ip_outs(ps.innings_pitched))
                      FILTER (WHERE ps.siera IS NOT NULL))::float
                     / NULLIF(SUM(ip_outs(ps.innings_pitched))
                              FILTER (WHERE ps.siera IS NOT NULL), 0) as siera,
                   (SUM(ps.strikeouts)::float * 100
                     / NULLIF(SUM(ps.batters_faced), 0))::float as k_pct,
                   (SUM(ps.hits_allowed)::float
                     / NULLIF(SUM(ps.batters_faced) - SUM(COALESCE(ps.walks,0)) - SUM(COALESCE(ps.hit_batters,0)), 0))::float as baa,
                   SUM(ps.pitching_war)::float as pwar
            FROM teams t
            JOIN pitching_stats ps ON ps.team_id = t.id AND ps.season = %s
                  AND ps.innings_pitched >= 3
            WHERE t.conference_id IN (
                SELECT id FROM conferences WHERE division_id = %s
            )
            GROUP BY t.id
        """, (season, team["division_id"]))
        pit_div = [dict(r) for r in cur.fetchall()]

        def _rank_block(values, my_val, higher_is_better=True):
            """Return {percentile, rank, total} for my_val against division peers.

            Percentile is rank-based so the #1 team gets 99 (top) and the last
            team gets 1 (bottom). Using a value-based percentile that includes
            the team itself in the denominator caps a #1-of-28 at ~98, which
            reads as "not actually #1" on the graphic.
            """
            if my_val is None:
                return {"percentile": None, "rank": None, "total": None}
            vals = [v for v in values if v is not None]
            total = len(vals)
            if total < 1:
                return {"percentile": None, "rank": None, "total": None}
            # rank: how many peers are strictly better than me, + 1
            if higher_is_better:
                rank = sum(1 for v in vals if v > my_val) + 1
            else:
                rank = sum(1 for v in vals if v < my_val) + 1
            # percentile for color — rank 1 → 99, rank N → 1 (linearly interpolated)
            if total < 3:
                pct = None
            else:
                # Map rank → percentile: rank 1 of N gets 99, rank N gets 1.
                pct = round(((total - rank) / (total - 1)) * 100)
                pct = max(1, min(99, pct))
            return {"percentile": pct, "rank": rank, "total": total}

        my_bat = next((b for b in bat_div if b["team_id"] == team_id), {}) or {}
        my_pit = next((p for p in pit_div if p["team_id"] == team_id), {}) or {}

        def _to_f(v):
            return float(v) if v is not None else None

        def _league_avg(values):
            """Mean of non-null values in the peer set, or None."""
            vals = [v for v in values if v is not None]
            return (sum(vals) / len(vals)) if vals else None

        def _pack(value, rb, comparison="division", league_avg=None):
            # `comparison` records the peer set used for the percentile —
            # either "division" (40+ teams, granular) or "conference"
            # (6-12 teams, coach-meaningful). Frontend reads this field
            # to render the rank text correctly ("#3 / 24 div" vs
            # "#2 / 8 conf").
            return {
                "value": _to_f(value),
                "league_avg": _to_f(league_avg),
                "comparison": comparison,
                **rb,
            }

        def _make_stat(my_val, values, higher_is_better=True, comparison="division"):
            return _pack(
                my_val,
                _rank_block(values, my_val, higher_is_better),
                comparison=comparison,
                league_avg=_league_avg(values),
            )

        batting_percentiles = {
            "batting_avg": _make_stat(my_bat.get("batting_avg"), [b.get("batting_avg") for b in bat_div], True),
            "woba":        _make_stat(my_bat.get("woba"),        [b.get("woba")        for b in bat_div], True),
            "hr_per_pa":   _make_stat(my_bat.get("hr_per_pa"),   [b.get("hr_per_pa")   for b in bat_div], True),
            "owar":        _make_stat(my_bat.get("owar"),        [b.get("owar")        for b in bat_div], True),
            "wrc_plus":    _make_stat(my_bat.get("wrc_plus"),    [b.get("wrc_plus")    for b in bat_div], True),
        }
        pitching_percentiles = {
            "era":   _make_stat(my_pit.get("era"),   [p.get("era")   for p in pit_div], False),
            "siera": _make_stat(my_pit.get("siera"), [p.get("siera") for p in pit_div], False),
            "k_pct": _make_stat(my_pit.get("k_pct"), [p.get("k_pct") for p in pit_div], True),
            "baa":   _make_stat(my_pit.get("baa"),   [p.get("baa")   for p in pit_div], False),
            "pwar":  _make_stat(my_pit.get("pwar"),  [p.get("pwar")  for p in pit_div], True),
        }

        # ── 12b. Conference-relative pitch-level metrics ──
        # Six additional Savant-style stats coaches asked for:
        #   Hitters:  contact%, swing%, air-pull% (LD/FB pulled / all BIP)
        #   Pitchers: strike%, first-pitch-strike%, whiff%
        # Computed from game_events.pitch_sequence character counts and
        # bb_type/field_zone, mirroring the formulas used on player
        # profile cards (/players/{id}/pitch-level-stats and
        # /players/{id}/pitch-level-stats-pitcher). Comparison group is
        # the team's CONFERENCE — that's the peer set coaches actually
        # care about.
        #
        # Pitch-sequence character legend (verified empirically — looking
        # strikeouts end in K, swinging strikeouts end in S):
        #   B = ball, K = called strike, S = swinging strike, F = foul,
        #   H = hit by pitch.  An empty pitch_sequence with was_in_play
        #   counts as a 1-pitch swing/contact (0-0 BIP).
        try:
            cur.execute("""
                SELECT id FROM teams
                WHERE conference_id = %s AND is_active = 1
            """, (team["conference_id"],))
            conf_team_ids = [r["id"] for r in cur.fetchall()]
        except Exception:
            conf_team_ids = [team_id]

        def _rates_from_counts(rows, kind):
            """Convert a list of per-team count rows into per-team
            rate dicts. kind = 'bat' or 'pit'."""
            out = []
            for r in rows:
                pitches = int(r.get("pitches") or 0)
                in_play = int(r.get("in_play") or 0)
                k = int(r.get("k_count") or 0)
                f = int(r.get("f_count") or 0)
                s = int(r.get("s_count") or 0)
                if kind == "bat":
                    swings = s + f + in_play
                    contact = f + in_play
                    bb_total = int(r.get("bb_total") or 0)
                    air_pull = int(r.get("air_pull") or 0)
                    out.append({
                        "team_id": r["team_id"],
                        "contact_pct":  (contact / swings) if swings > 0 else None,
                        "swing_pct":    (swings / pitches) if pitches > 0 else None,
                        "air_pull_pct": (air_pull / bb_total) if bb_total > 0 else None,
                    })
                else:  # pit
                    swings = s + f + in_play
                    strikes = k + s + f + in_play
                    tracked_pa = int(r.get("tracked_pa") or 0)
                    f1_strikes = int(r.get("f1_strikes") or 0)
                    out.append({
                        "team_id":    r["team_id"],
                        "strike_pct": (strikes / pitches) if pitches > 0 else None,
                        "fps_pct":    (f1_strikes / tracked_pa) if tracked_pa > 0 else None,
                        "whiff_pct":  (s / swings) if swings > 0 else None,
                    })
            return out

        bat_conf_rates = []
        pit_conf_rates = []
        try:
            # ── Hitting pitch metrics, grouped by batting team ──
            cur.execute("""
                SELECT
                    ge.batting_team_id AS team_id,
                    SUM(LENGTH(ge.pitch_sequence) - LENGTH(REPLACE(ge.pitch_sequence, 'K', ''))) AS k_count,
                    SUM(LENGTH(ge.pitch_sequence) - LENGTH(REPLACE(ge.pitch_sequence, 'F', ''))) AS f_count,
                    SUM(LENGTH(ge.pitch_sequence) - LENGTH(REPLACE(ge.pitch_sequence, 'S', ''))) AS s_count,
                    SUM(COALESCE(ge.pitches_thrown, 0)) AS pitches,
                    COUNT(*) FILTER (WHERE ge.was_in_play AND ge.pitches_thrown IS NOT NULL) AS in_play,
                    COUNT(*) FILTER (WHERE ge.bb_type IS NOT NULL AND UPPER(p.bats) IN ('L','R')) AS bb_total,
                    COUNT(*) FILTER (WHERE ge.bb_type IN ('LD','FB')
                        AND ((UPPER(p.bats) = 'R' AND ge.field_zone = 'LEFT')
                          OR (UPPER(p.bats) = 'L' AND ge.field_zone = 'RIGHT'))) AS air_pull
                FROM game_events ge
                JOIN games g ON g.id = ge.game_id
                LEFT JOIN players p ON p.id = ge.batter_player_id
                WHERE g.season = %s
                  AND ge.batting_team_id = ANY(%s)
                GROUP BY ge.batting_team_id
            """, (season, conf_team_ids))
            bat_conf_rates = _rates_from_counts([dict(r) for r in cur.fetchall()], "bat")

            # ── Pitching pitch metrics, grouped by pitcher's team ──
            cur.execute("""
                SELECT
                    pp.team_id AS team_id,
                    SUM(LENGTH(ge.pitch_sequence) - LENGTH(REPLACE(ge.pitch_sequence, 'K', ''))) AS k_count,
                    SUM(LENGTH(ge.pitch_sequence) - LENGTH(REPLACE(ge.pitch_sequence, 'F', ''))) AS f_count,
                    SUM(LENGTH(ge.pitch_sequence) - LENGTH(REPLACE(ge.pitch_sequence, 'S', ''))) AS s_count,
                    SUM(COALESCE(ge.pitches_thrown, 0)) AS pitches,
                    COUNT(*) FILTER (WHERE ge.was_in_play AND ge.pitches_thrown IS NOT NULL) AS in_play,
                    -- pitches_thrown >= 1 (not just IS NOT NULL): the parser
                    -- emits pitches_thrown=0 for untracked PAs that have a
                    -- "(0-0)" count notation but no actual pitch sequence
                    -- (common from Presto / non-Sidearm sources). Those
                    -- rows can never satisfy the FPS numerator, so leaving
                    -- them in the denominator silently deflates first-
                    -- pitch-strike rate.
                    COUNT(*) FILTER (WHERE ge.pitches_thrown >= 1) AS tracked_pa,
                    COUNT(*) FILTER (WHERE ge.pitches_thrown >= 1
                        AND (LEFT(ge.pitch_sequence, 1) IN ('K','S','F')
                             OR (ge.pitch_sequence = '' AND ge.was_in_play))) AS f1_strikes
                FROM game_events ge
                JOIN games g ON g.id = ge.game_id
                JOIN players pp ON pp.id = ge.pitcher_player_id
                WHERE g.season = %s
                  AND pp.team_id = ANY(%s)
                GROUP BY pp.team_id
            """, (season, conf_team_ids))
            pit_conf_rates = _rates_from_counts([dict(r) for r in cur.fetchall()], "pit")
        except Exception as _conf_pitch_err:
            # Print to stderr so it shows up in the FastAPI service log,
            # but still let the endpoint return — these conf metrics are
            # nice-to-have, not load-bearing.
            import traceback
            print(f"[info-graphic] conf pitch metric query FAILED for "
                  f"team_id={team_id}: {type(_conf_pitch_err).__name__}: "
                  f"{_conf_pitch_err}", flush=True)
            traceback.print_exc()
            try:
                conn.rollback()
            except Exception:
                pass

        # Bring our team's rates into scope (default empty dict if our
        # team had no tracked PAs — happens early in the season).
        my_bat_pitch = next((b for b in bat_conf_rates if b["team_id"] == team_id), {}) or {}
        my_pit_pitch = next((p for p in pit_conf_rates if p["team_id"] == team_id), {}) or {}

        # All six new metrics are higher-is-better:
        #   contact% — putting bat on ball is a good thing
        #   swing% — neutral but treated as positive (more aggressive offense)
        #   air-pull% — pull power on balls in air (XBH driver)
        #   strike% — staff filling up the zone
        #   FPS% — ahead-in-count rate is one of the strongest pitcher signals
        #   whiff% — bat-missing rate
        for key in ("contact_pct", "swing_pct", "air_pull_pct"):
            batting_percentiles[key] = _pack(
                my_bat_pitch.get(key),
                _rank_block([b.get(key) for b in bat_conf_rates],
                            my_bat_pitch.get(key), True),
                comparison="conference",
            )
        for key in ("strike_pct", "fps_pct", "whiff_pct"):
            pitching_percentiles[key] = _pack(
                my_pit_pitch.get(key),
                _rank_block([p.get(key) for p in pit_conf_rates],
                            my_pit_pitch.get(key), True),
                comparison="conference",
            )

        # Inject convenience "name" into top performers
        for h in top_hitters:
            h["name"] = f'{h.get("first_name","")} {h.get("last_name","")}'.strip()
        for p in top_pitchers:
            p["name"] = f'{p.get("first_name","")} {p.get("last_name","")}'.strip()

        # ── Canonical team aggregates (single source of truth) ──
        # Used to render the basic team stats panel on the graphic. Pulls from
        # get_team_aggregates() so these numbers always match the team page,
        # leaderboards, and team comparison views.
        agg = get_team_aggregates(cur, team_id, season)
        team_stats = {
            # Batting
            "avg": agg.get("team_avg"),
            "obp": agg.get("team_obp"),
            "slg": agg.get("team_slg"),
            "ops": agg.get("team_ops"),
            "hr": agg.get("hr_bat"),
            "sb": agg.get("sb"),
            "runs_scored": agg.get("runs_scored"),
            "rbi": agg.get("rbi"),
            # Pitching
            "era": agg.get("team_era"),
            "whip": agg.get("team_whip"),
            "ip": agg.get("true_ip"),
            "k": agg.get("k_pit"),
            "bb": agg.get("bb_pit"),
            "k_per_9": agg.get("k_per_9"),
            "bb_per_9": agg.get("bb_per_9"),
            "hr_allowed": agg.get("hr_allowed"),
        }

        return {
            "season": season,
            "team": team,
            "head_coach": {"name": head_coach} if head_coach else None,
            "record": {
                "wins": wins,
                "losses": losses,
                "ties": int(rec.get("ties") or 0),
                "conf_wins": int(rec.get("conference_wins") or 0),
                "conf_losses": int(rec.get("conference_losses") or 0),
                "home_wins": int(splits.get("home_wins") or 0),
                "home_losses": int(splits.get("home_losses") or 0),
                "away_wins": int(splits.get("away_wins") or 0),
                "away_losses": int(splits.get("away_losses") or 0),
                "runs_for": runs_for,
                "runs_against": runs_against,
                "run_diff": run_diff,
                "pythagorean_wins": pyth_wins,
                "pythagorean_losses": pyth_losses,
            },
            "rankings": {
                "national_rank": national_rank,
                "national_percentile": natl_pct,
                "conference_rank": conf_rank,
                "conference_total": conf_total,
                "power_rating": power_rating,
                "power_rating_conf_rank": power_rating_conf_rank,
                "power_rating_conf_total": power_rating_conf_total,
                "power_rating_div_rank": power_rating_div_rank,
                "power_rating_div_total": power_rating_div_total,
                "division_name": team.get("division_name"),
                "conference_abbrev": team.get("conference_abbrev"),
                "sos": avg_sos,
                "sos_rank": avg_sos_rank,
            },
            "team_stats": team_stats,
            "top_hitters": top_hitters,
            "top_pitchers": top_pitchers,
            "batting_percentiles": batting_percentiles,
            "pitching_percentiles": pitching_percentiles,
            "last_5_games": last_5,
        }


# ============================================================
# LEADERBOARDS: Batting
# ============================================================

@router.get("/leaderboards/batting")
@cached_endpoint(ttl_seconds=1800)
def batting_leaderboard(
    season: int = Query(..., description="Season year"),
    division_id: Optional[int] = Query(None, description="Filter by division"),
    conference_id: Optional[int] = Query(None, description="Filter by conference"),
    state: Optional[str] = Query(None, description="Filter by state (WA, OR, ID, MT, BC)"),
    team_id: Optional[int] = Query(None, description="Filter by team"),
    min_pa: int = Query(0, description="Minimum plate appearances"),
    min_ab: int = Query(0, description="Minimum at-bats"),
    qualified: bool = Query(False, description="Only qualified players (2 PA per team game)"),
    sort_by: str = Query("batting_avg", description="Sort column"),
    sort_dir: str = Query("desc", description="Sort direction (asc/desc)"),
    limit: int = Query(50, description="Results per page"),
    offset: int = Query(0, description="Pagination offset"),
    year_in_school: Optional[str] = Query(None, description="Filter by class year (Fr., So., Jr., Sr.)"),
    position_group: Optional[str] = Query(None, description="Filter by position group (IF, OF, C, P, UT)"),
    conference_only: bool = Query(False, description="Only count stats from conference games"),
):
    """
    Batting stat leaders with comprehensive filtering.
    Includes both traditional and advanced stats.
    When conference_only=true, aggregates from individual game box scores for conference games only.
    """
    allowed_sort = {
        "batting_avg", "on_base_pct", "slugging_pct", "ops", "woba", "wobacon", "wrc_plus",
        "home_runs", "rbi", "hits", "runs", "stolen_bases", "walks",
        "strikeouts", "doubles", "triples", "plate_appearances", "iso",
        "babip", "bb_pct", "k_pct", "offensive_war",
    }
    if sort_by not in allowed_sort:
        sort_by = "batting_avg"
    # If conference_only, advanced stats aren't available — fall back to batting_avg
    if conference_only and sort_by in ("woba", "wobacon", "wrc_plus", "offensive_war"):
        sort_by = "batting_avg"
    sort_direction = "DESC" if sort_dir.lower() == "desc" else "ASC"

    with get_connection() as conn:
        cur = conn.cursor()

        if conference_only:
            # Use CTE that aggregates game-level box scores for conference games
            cte_prefix = f"WITH {CONF_BATTING_CTE}"
            cte_params: list = [season]  # season param for the CTE WHERE clause
            query = cte_prefix + f"""
                SELECT bs.*,
                       p.first_name, p.last_name, p.position, p.year_in_school,
                       p.bats, p.throws, p.hometown, p.previous_school,
                       p.is_committed, p.committed_to,
                       t.name as team_name, t.short_name as team_short, t.logo_url,
                       t.state as team_state,
                       c.name as conference_name, c.abbreviation as conference_abbrev,
                       d.name as division_name, d.level as division_level,
                       false as is_qualified
                FROM conf_bat bs
                JOIN players p ON bs.player_id = p.id
                JOIN teams t ON bs.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                WHERE bs.plate_appearances >= %s
                  AND bs.at_bats >= %s
            """
            params: list = cte_params + [min_pa, min_ab]
        else:
            q_where = QUALIFIED_BATTING_WHERE if qualified else ""
            query = f"""
                SELECT bs.*,
                       p.first_name, p.last_name, p.position, p.year_in_school,
                       p.bats, p.throws, p.hometown, p.previous_school,
                       p.is_committed, p.committed_to,
                       t.name as team_name, t.short_name as team_short, t.logo_url,
                       t.state as team_state,
                       c.name as conference_name, c.abbreviation as conference_abbrev,
                       d.name as division_name, d.level as division_level,
                       CASE WHEN bs.plate_appearances >= {QUALIFIED_PA_PER_GAME} * (COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0))
                            THEN true ELSE false END as is_qualified
                FROM batting_stats bs
                JOIN players p ON bs.player_id = p.id
                JOIN teams t ON bs.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                {QUALIFIED_BATTING_JOIN}
                WHERE bs.season = %s
                  AND bs.plate_appearances >= %s
                  AND bs.at_bats >= %s
                  {q_where}
            """
            params: list = [season, min_pa, min_ab]

        if division_id:
            query += " AND c.division_id = %s"
            params.append(division_id)
        if conference_id:
            query += " AND t.conference_id = %s"
            params.append(conference_id)
        if state:
            query += " AND t.state = %s"
            params.append(state.upper())
        if team_id:
            query += " AND bs.team_id = %s"
            params.append(team_id)
        if year_in_school:
            query = _apply_year_filter(query, params, year_in_school)
        if position_group:
            pg = position_group.upper()
            pos_groups = {
                "IF": ("IF", "SS", "2B", "3B", "1B"),
                "OF": ("OF", "CF", "LF", "RF"),
                "C": ("C",),
                "P": ("P",),
                "UT": ("UT", "DH"),
            }
            positions = pos_groups.get(pg, (pg,))
            placeholders_pg = ",".join(["%s"] * len(positions))
            query += f" AND p.position IN ({placeholders_pg})"
            params.extend(positions)

        query += f" ORDER BY bs.{sort_by} {sort_direction} NULLS LAST"
        query += " LIMIT %s OFFSET %s"
        params.extend([limit, offset])

        rows = cur.execute(query, params)
        rows = cur.fetchall()

        # Count total matching rows for pagination
        if conference_only:
            count_q = f"WITH {CONF_BATTING_CTE}" + f"""
                SELECT COUNT(*) as total
                FROM conf_bat bs
                JOIN players p ON bs.player_id = p.id
                JOIN teams t ON bs.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                WHERE bs.plate_appearances >= %s
                  AND bs.at_bats >= %s
            """
            count_params: list = [season, min_pa, min_ab]
        else:
            q_where = QUALIFIED_BATTING_WHERE if qualified else ""
            count_q = f"""
                SELECT COUNT(*) as total
                FROM batting_stats bs
                JOIN players p ON bs.player_id = p.id
                JOIN teams t ON bs.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                {QUALIFIED_BATTING_JOIN}
                WHERE bs.season = %s
                  AND bs.plate_appearances >= %s
                  AND bs.at_bats >= %s
                  {q_where}
            """
            count_params: list = [season, min_pa, min_ab]
        if division_id:
            count_q += " AND c.division_id = %s"
            count_params.append(division_id)
        if conference_id:
            count_q += " AND t.conference_id = %s"
            count_params.append(conference_id)
        if state:
            count_q += " AND t.state = %s"
            count_params.append(state.upper())
        if team_id:
            count_q += " AND bs.team_id = %s"
            count_params.append(team_id)
        if year_in_school:
            count_q = _apply_year_filter(count_q, count_params, year_in_school)
        if position_group:
            pg = position_group.upper()
            pos_groups = {
                "IF": ("IF", "SS", "2B", "3B", "1B"),
                "OF": ("OF", "CF", "LF", "RF"),
                "C": ("C",),
                "P": ("P",),
                "UT": ("UT", "DH"),
            }
            positions = pos_groups.get(pg, (pg,))
            placeholders_pg = ",".join(["%s"] * len(positions))
            count_q += f" AND p.position IN ({placeholders_pg})"
            count_params.extend(positions)

        cur.execute(count_q, count_params)
        total_row = cur.fetchone()
        total = total_row["total"] if total_row else 0

        return {
            "data": [dict(r) for r in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
            "season": season,
            "filters": {
                "division_id": division_id,
                "conference_id": conference_id,
                "state": state,
                "team_id": team_id,
                "min_pa": min_pa,
                "min_ab": min_ab,
                "year_in_school": year_in_school,
                "conference_only": conference_only,
            },
        }


# ============================================================
# LEADERBOARDS: Clubs / Milestones (membership boards)
# ============================================================
#
# Unlike the ranked leaderboards above, these return EVERY player who
# meets a membership rule (not a top-N cut), so a social graphic can
# show the full club. Same row shape as /leaderboards/batting so the
# Social Graphics card renders them with no special-casing.
#
#   club=hr_sb   → the "10/10 Club": hitters with >= hr_min HR AND
#                  >= sb_min SB (defaults 10/10). Ordered by HR+SB.
#   club=ironman → "Baseball Ironmen": hitters whose games played
#                  (bs.games) is >= their team's total games for the
#                  season. Team games comes from team_season_stats
#                  (wins+losses+ties) — the same official total the
#                  qualified-player math uses. We use >= (not =) so a
#                  player credited an extra game (doubleheader / box
#                  quirk) still counts, and we never miss a true iron
#                  man when team_season_stats undercounts a tie. The
#                  `games` table is NOT used as the denominator: it
#                  undercounts NWAC (schedule-scrape gaps) and would
#                  falsely flag near-iron-men.

@router.get("/leaderboards/clubs")
@cached_endpoint(ttl_seconds=1800)
def clubs_leaderboard(
    season: int = Query(..., description="Season year"),
    club: str = Query("hr_sb", description="Club: hr_sb | ironman"),
    division_id: Optional[int] = Query(None, description="Filter by division"),
    conference_id: Optional[int] = Query(None, description="Filter by conference"),
    state: Optional[str] = Query(None, description="Filter by state (WA, OR, ID, MT, BC)"),
    team_id: Optional[int] = Query(None, description="Filter by team"),
    year_in_school: Optional[str] = Query(None, description="Filter by class year"),
    hr_min: int = Query(10, description="Min HR for hr_sb club"),
    sb_min: int = Query(10, description="Min SB for hr_sb club"),
    min_team_games: int = Query(20, description="Min team games for ironman club (drops tiny-sample teams)"),
    limit: int = Query(200, description="Max members returned"),
):
    """Membership boards (10/10 Club, Baseball Ironmen). Returns every
    qualifying hitter, not a top-N cut, in the same shape as the batting
    leaderboard."""
    club = (club or "hr_sb").lower()
    if club not in ("hr_sb", "ironman"):
        club = "hr_sb"

    select_cols = """
        SELECT bs.*,
               p.first_name, p.last_name, p.position, p.year_in_school,
               p.bats, p.throws, p.hometown, p.previous_school,
               p.is_committed, p.committed_to,
               t.name as team_name, t.short_name as team_short, t.logo_url,
               t.state as team_state,
               c.name as conference_name, c.abbreviation as conference_abbrev,
               d.name as division_name, d.level as division_level,
               (COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0)) as team_games
        FROM batting_stats bs
        JOIN players p ON bs.player_id = p.id
        JOIN teams t ON bs.team_id = t.id
        JOIN conferences c ON t.conference_id = c.id
        JOIN divisions d ON c.division_id = d.id
        LEFT JOIN team_season_stats tss
          ON tss.team_id = bs.team_id AND tss.season = bs.season
        WHERE bs.season = %s
    """
    params: list = [season]

    if club == "ironman":
        # Played in (at least) every team game. Guard tiny-sample teams.
        select_cols += (
            " AND (COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0)) >= %s"
            " AND COALESCE(bs.games,0) >= (COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0))"
        )
        params.append(max(min_team_games, 1))
        order_by = (
            " ORDER BY (COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0)) DESC,"
            " bs.batting_avg DESC NULLS LAST"
        )
    else:  # hr_sb
        select_cols += " AND COALESCE(bs.home_runs,0) >= %s AND COALESCE(bs.stolen_bases,0) >= %s"
        params.extend([max(hr_min, 0), max(sb_min, 0)])
        order_by = (
            " ORDER BY (COALESCE(bs.home_runs,0) + COALESCE(bs.stolen_bases,0)) DESC,"
            " bs.home_runs DESC, bs.stolen_bases DESC"
        )

    if division_id:
        select_cols += " AND c.division_id = %s"
        params.append(division_id)
    if conference_id:
        select_cols += " AND t.conference_id = %s"
        params.append(conference_id)
    if state:
        select_cols += " AND t.state = %s"
        params.append(state.upper())
    if team_id:
        select_cols += " AND bs.team_id = %s"
        params.append(team_id)
    if year_in_school:
        select_cols = _apply_year_filter(select_cols, params, year_in_school)

    select_cols += order_by + " LIMIT %s"
    params.append(limit)

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(select_cols, params)
        rows = [dict(r) for r in cur.fetchall()]

    return {
        "data": rows,
        "total": len(rows),
        "season": season,
        "club": club,
        "filters": {
            "division_id": division_id,
            "conference_id": conference_id,
            "state": state,
            "team_id": team_id,
            "year_in_school": year_in_school,
            "hr_min": hr_min,
            "sb_min": sb_min,
            "min_team_games": min_team_games,
        },
    }


# ============================================================
# LEADERBOARDS: Pitching
# ============================================================

@router.get("/leaderboards/pitching")
@cached_endpoint(ttl_seconds=1800)
def pitching_leaderboard(
    season: int = Query(..., description="Season year"),
    division_id: Optional[int] = Query(None, description="Filter by division"),
    conference_id: Optional[int] = Query(None, description="Filter by conference"),
    state: Optional[str] = Query(None, description="Filter by state"),
    team_id: Optional[int] = Query(None, description="Filter by team"),
    min_ip: float = Query(0, description="Minimum innings pitched"),
    qualified: bool = Query(False, description="Only qualified players (0.75 IP per team game)"),
    max_gs: Optional[int] = Query(None, description="Maximum games started (0 for relievers only)"),
    sort_by: str = Query("era", description="Sort column"),
    sort_dir: str = Query("asc", description="Sort direction"),
    limit: int = Query(50, description="Results per page"),
    offset: int = Query(0, description="Pagination offset"),
    year_in_school: Optional[str] = Query(None, description="Filter by class year"),
    conference_only: bool = Query(False, description="Only count stats from conference games"),
):
    """
    Pitching stat leaders with comprehensive filtering.
    Includes traditional and advanced metrics (FIP, xFIP, SIERA, WAR).
    When conference_only=true, aggregates from individual game box scores for conference games only.
    """
    allowed_sort = {
        "era", "whip", "fip", "xfip", "siera", "kwera",
        "wins", "losses", "saves", "strikeouts", "innings_pitched",
        "k_per_9", "bb_per_9", "hr_per_9", "k_bb_ratio",
        "k_pct", "bb_pct", "k_bb_pct",
        "babip_against", "baa", "lob_pct", "pitching_war",
        "fip_plus", "era_minus", "era_plus",
        "quality_starts",
    }
    # Computed column aliases that can't use ps.{name} in ORDER BY
    computed_sort_expressions = {
        "k_bb_pct": "(COALESCE(ps.k_pct, 0) - COALESCE(ps.bb_pct, 0))",
        "era_plus": "CASE WHEN ps.era_minus > 0 THEN 10000.0 / ps.era_minus END",
        "quality_starts": "COALESCE(ps.quality_starts, 0)",
        "baa": ("CASE WHEN (COALESCE(ps.batters_faced,0) - COALESCE(ps.walks,0) - COALESCE(ps.hit_batters,0)) > 0 "
                "THEN COALESCE(ps.hits_allowed,0)::numeric "
                "/ (COALESCE(ps.batters_faced,0) - COALESCE(ps.walks,0) - COALESCE(ps.hit_batters,0))::numeric END"),
    }
    if sort_by not in allowed_sort:
        sort_by = "era"
    # If conference_only, advanced stats aren't available — fall back to era
    if conference_only and sort_by in ("fip", "xfip", "siera", "kwera", "lob_pct", "pitching_war", "fip_plus", "era_minus", "era_plus"):
        sort_by = "era"
    # For ERA/FIP/xFIP, ascending is better; for K/9, WAR, descending is better
    ascending_stats = {"era", "whip", "fip", "xfip", "siera", "kwera", "bb_per_9", "bb_pct", "hr_per_9", "losses", "baa"}
    default_dir = "ASC" if sort_by in ascending_stats else "DESC"
    sort_direction = sort_dir.upper() if sort_dir.upper() in ("ASC", "DESC") else default_dir

    with get_connection() as conn:
        cur = conn.cursor()

        if conference_only:
            cte_prefix = f"WITH {CONF_PITCHING_CTE}"
            cte_params: list = [season]
            query = cte_prefix + f"""
                SELECT ps.*,
                       COALESCE(ps.k_pct, 0) - COALESCE(ps.bb_pct, 0) as k_bb_pct,
                       p.first_name, p.last_name, p.position, p.year_in_school,
                       p.bats, p.throws, p.hometown, p.previous_school,
                       p.is_committed, p.committed_to,
                       t.name as team_name, t.short_name as team_short, t.logo_url,
                       t.state as team_state,
                       c.name as conference_name, c.abbreviation as conference_abbrev,
                       d.name as division_name, d.level as division_level
                FROM conf_pit ps
                JOIN players p ON ps.player_id = p.id
                JOIN teams t ON ps.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                WHERE ps.innings_pitched >= %s
            """
            params: list = cte_params + [min_ip]
        else:
            q_join = QUALIFIED_PITCHING_JOIN if qualified else ""
            q_where = QUALIFIED_PITCHING_WHERE if qualified else ""
            query = f"""
                SELECT ps.*,
                       COALESCE(ps.k_pct, 0) - COALESCE(ps.bb_pct, 0) as k_bb_pct,
                       CASE WHEN (COALESCE(ps.batters_faced,0) - COALESCE(ps.walks,0) - COALESCE(ps.hit_batters,0)) > 0
                            THEN ROUND(COALESCE(ps.hits_allowed,0)::numeric
                                 / (COALESCE(ps.batters_faced,0) - COALESCE(ps.walks,0) - COALESCE(ps.hit_batters,0))::numeric, 3)
                       END as baa,
                       p.first_name, p.last_name, p.position, p.year_in_school,
                       p.bats, p.throws, p.hometown, p.previous_school,
                       p.is_committed, p.committed_to,
                       t.name as team_name, t.short_name as team_short, t.logo_url,
                       t.state as team_state,
                       c.name as conference_name, c.abbreviation as conference_abbrev,
                       d.name as division_name, d.level as division_level
                FROM pitching_stats ps
                JOIN players p ON ps.player_id = p.id
                JOIN teams t ON ps.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                {q_join}
                WHERE ps.season = %s
                  AND ps.innings_pitched >= %s
                  {q_where}
            """
            params: list = [season, min_ip]

        if division_id:
            query += " AND c.division_id = %s"
            params.append(division_id)
        if conference_id:
            query += " AND t.conference_id = %s"
            params.append(conference_id)
        if state:
            query += " AND t.state = %s"
            params.append(state.upper())
        if team_id:
            query += " AND ps.team_id = %s"
            params.append(team_id)
        if year_in_school:
            query = _apply_year_filter(query, params, year_in_school)
        if max_gs is not None:
            query += " AND COALESCE(ps.games_started, 0) <= %s"
            params.append(max_gs)

        # Use computed expression for aliases, otherwise use ps.{column}
        order_expr = computed_sort_expressions.get(sort_by, f"ps.{sort_by}")
        query += f" ORDER BY {order_expr} {sort_direction} NULLS LAST"
        query += " LIMIT %s OFFSET %s"
        params.extend([limit, offset])

        rows = cur.execute(query, params)
        rows = cur.fetchall()
        return {
            "data": [_add_era_plus(dict(r)) for r in rows],
            "total": len(rows),
            "limit": limit,
            "offset": offset,
            "season": season,
        }


# ============================================================
# PBP LEADERBOARDS (plate discipline / pitch-level stats)
# ============================================================
#
# These mirror /leaderboards/batting and /leaderboards/pitching but
# aggregate game_events rows (per-PA play-by-play) instead of the
# season-level batting_stats / pitching_stats tables. They power
# the "PBP" preset on the Hitting and Pitching leaderboards.
#
# Source feeds: every PA we have a pitch_sequence string for. Many
# Sidearm narrative feeds publish PAs WITHOUT a pitch sequence
# (e.g., "Smith walked." with no 4-pitch breakdown), and those PAs
# are excluded from the denominator — we report tracked_pa
# alongside total_pa so a coach can see sample coverage.
#
# Pitch sequence alphabet (per scrape_pbp):
#   B = ball, K = swinging strike, S = called strike, F = foul,
#   X = ball in play (also indicated by was_in_play=true)
# An empty pitch_sequence with was_in_play=true counts as a
# 1-pitch swing+contact (0-0 ball-in-play).

# The five states (+ BC for UBC) that define our tracked PNW universe.
# PBP-derived boards read from game_events, which also contains OOC
# opponents' players (e.g. Santa Clara, San Diego — California teams that
# are is_active=1 because PNW D1 teams played them). is_active alone is NOT
# enough to exclude them; scoping by team state is. The season-stat boards
# don't need this since they read *_stats, which are PNW-roster-only.
PNW_STATES = ('WA', 'OR', 'ID', 'MT', 'BC')


def _pbp_filter_clauses(filters):
    """Build the WHERE-clause fragment + params list shared by the PBP /
    reliever leaderboards. `filters` is a dict with optional keys:
    division_id, conference_id, state, team_id, year_in_school.
    Always restricts to PNW-state teams so OOC opponents pulled in via
    game_events never appear. Returns (sql, params); sql starts with ' AND'.
    Assumes the query aliases teams t, conferences c, divisions d, players p."""
    sql = " AND t.state IN ('WA','OR','ID','MT','BC')"
    params = []
    if filters.get("division_id"):
        sql += " AND d.id = %s"
        params.append(filters["division_id"])
    if filters.get("conference_id"):
        sql += " AND c.id = %s"
        params.append(filters["conference_id"])
    if filters.get("state"):
        sql += " AND t.state = %s"
        params.append(filters["state"])
    if filters.get("team_id"):
        sql += " AND t.id = %s"
        params.append(filters["team_id"])
    if filters.get("year_in_school"):
        sql += " AND p.year_in_school = %s"
        params.append(filters["year_in_school"])
    return sql, params


def _team_pbp_filter_clauses(division_id, conference_id, state, team_id):
    """Optional filters for the team-level PBP boards. Assumes the query
    aliases teams t, conferences c, divisions d. PNW-state scope is added
    separately in each query (teams are grouped, not joined via players)."""
    sql = ""
    params = []
    if division_id:
        sql += " AND d.id = %s"; params.append(division_id)
    if conference_id:
        sql += " AND c.id = %s"; params.append(conference_id)
    if state:
        sql += " AND t.state = %s"; params.append(state)
    if team_id:
        sql += " AND t.id = %s"; params.append(team_id)
    return sql, params


@router.get("/leaderboards/batting-pbp")
@cached_endpoint(ttl_seconds=1800)
def batting_pbp_leaderboard(
    season: int = Query(..., description="Season year"),
    division_id: Optional[int] = Query(None),
    conference_id: Optional[int] = Query(None),
    state: Optional[str] = Query(None),
    team_id: Optional[int] = Query(None),
    year_in_school: Optional[str] = Query(None),
    min_pa: int = Query(30, description="Minimum tracked plate appearances"),
    sort_by: str = Query("whiff_pct", description="Sort column"),
    sort_dir: str = Query("asc", description="Sort direction (asc/desc)"),
    limit: int = Query(50),
    offset: int = Query(0),
):
    """Hitter plate-discipline leaderboard, aggregated from game_events.

    Returns per-player: swing rate, whiff rate, contact rate, FB rate,
    air-pull rate, putaway rate, P/PA — plus sample-size fields
    (tracked_pa, pitches, swings, bb_total, bb_total_pull).
    """
    allowed_sort = {
        "tracked_pa", "pitches", "swings",
        "swing_pct", "whiff_pct", "contact_pct",
        "fb_pct", "air_pull_pct",
        "putaway_pct", "pitches_per_pa",
    }
    if sort_by not in allowed_sort:
        sort_by = "whiff_pct"
    direction = "ASC" if sort_dir.lower() == "asc" else "DESC"

    where_sql, where_params = _pbp_filter_clauses({
        "division_id": division_id,
        "conference_id": conference_id,
        "state": state,
        "team_id": team_id,
        "year_in_school": year_in_school,
    })

    with get_connection() as conn:
        cur = conn.cursor()
        query = f"""
            WITH pbp AS (
                SELECT
                    ge.batter_player_id AS player_id,
                    COUNT(*) AS total_pa,
                    COUNT(*) FILTER (WHERE ge.pitches_thrown >= 1) AS tracked_pa,
                    COALESCE(SUM(ge.pitches_thrown) FILTER (WHERE ge.pitches_thrown >= 1), 0) AS pitches,
                    COALESCE(SUM(LENGTH(ge.pitch_sequence)
                        - LENGTH(REPLACE(ge.pitch_sequence, 'K', '')))
                        FILTER (WHERE ge.pitches_thrown >= 1), 0) AS k_pitches,
                    COALESCE(SUM(LENGTH(ge.pitch_sequence)
                        - LENGTH(REPLACE(ge.pitch_sequence, 'S', '')))
                        FILTER (WHERE ge.pitches_thrown >= 1), 0) AS s_pitches,
                    COALESCE(SUM(LENGTH(ge.pitch_sequence)
                        - LENGTH(REPLACE(ge.pitch_sequence, 'F', '')))
                        FILTER (WHERE ge.pitches_thrown >= 1), 0) AS f_pitches,
                    COALESCE(SUM(CASE WHEN ge.was_in_play THEN 1 ELSE 0 END)
                        FILTER (WHERE ge.pitches_thrown >= 1), 0) AS in_play,
                    COUNT(*) FILTER (WHERE ge.pitches_thrown >= 1
                                       AND ge.strikes_before = 2) AS two_strike_pa,
                    COUNT(*) FILTER (WHERE ge.pitches_thrown >= 1
                                       AND ge.strikes_before = 2
                                       AND ge.result_type IN ('strikeout_swinging','strikeout_looking')) AS two_strike_k,
                    -- Batted-ball mix. bb_total is BIPs with a known
                    -- batted-ball type (GB/LD/FB/PU). FB rate is FB / bb_total.
                    COUNT(*) FILTER (WHERE ge.bb_type IS NOT NULL) AS bb_total,
                    COUNT(*) FILTER (WHERE ge.bb_type = 'FB') AS fb_count,
                    -- Air-pull = LD or FB pulled to the batter's pull side.
                    -- Needs handedness, so we join players. Switch-hitters
                    -- (bats='S') and unknowns are excluded from the
                    -- denominator and numerator (bb_total_pull).
                    COUNT(*) FILTER (WHERE ge.bb_type IS NOT NULL
                                       AND UPPER(plyr.bats) IN ('L','R')) AS bb_total_pull,
                    COUNT(*) FILTER (WHERE ge.bb_type IN ('LD','FB')
                        AND ((UPPER(plyr.bats) = 'R' AND ge.field_zone = 'LEFT')
                          OR (UPPER(plyr.bats) = 'L' AND ge.field_zone = 'RIGHT'))) AS air_pull_count
                FROM game_events ge
                JOIN games g ON g.id = ge.game_id
                LEFT JOIN players plyr ON plyr.id = ge.batter_player_id
                WHERE g.season = %s AND ge.batter_player_id IS NOT NULL
                GROUP BY ge.batter_player_id
            ),
            -- swings = whiffs + fouls + in_play; expand inline for clarity
            scored AS (
                SELECT
                    pbp.*,
                    (pbp.s_pitches + pbp.f_pitches + pbp.in_play) AS swings,
                    -- swing rate = swings / pitches
                    CASE WHEN pbp.pitches > 0
                        THEN (pbp.s_pitches + pbp.f_pitches + pbp.in_play)::numeric / pbp.pitches
                    END AS swing_pct,
                    -- whiff rate = whiffs / swings
                    CASE WHEN (pbp.s_pitches + pbp.f_pitches + pbp.in_play) > 0
                        THEN pbp.s_pitches::numeric / (pbp.s_pitches + pbp.f_pitches + pbp.in_play)
                    END AS whiff_pct,
                    -- contact rate = contact / swings (contact = foul + in_play)
                    CASE WHEN (pbp.s_pitches + pbp.f_pitches + pbp.in_play) > 0
                        THEN (pbp.f_pitches + pbp.in_play)::numeric / (pbp.s_pitches + pbp.f_pitches + pbp.in_play)
                    END AS contact_pct,
                    -- pitches per PA
                    CASE WHEN pbp.tracked_pa > 0 THEN pbp.pitches::numeric / pbp.tracked_pa END AS pitches_per_pa,
                    -- putaway rate (lower is better for hitter)
                    CASE WHEN pbp.two_strike_pa > 0
                        THEN pbp.two_strike_k::numeric / pbp.two_strike_pa
                    END AS putaway_pct,
                    -- FB rate = FB / total bb-tracked
                    CASE WHEN pbp.bb_total > 0
                        THEN pbp.fb_count::numeric / pbp.bb_total
                    END AS fb_pct,
                    -- Air-pull rate = LD or FB pulled / bb-tracked-with-known-handedness
                    CASE WHEN pbp.bb_total_pull > 0
                        THEN pbp.air_pull_count::numeric / pbp.bb_total_pull
                    END AS air_pull_pct
                FROM pbp
            )
            SELECT
                p.id AS player_id,
                p.first_name, p.last_name, p.year_in_school, p.position,
                t.id AS team_id, t.short_name AS team_short,
                t.school_name AS team_name, t.logo_url, t.state,
                d.level AS division_level,
                c.id AS conference_id, c.abbreviation AS conference_abbrev,
                s.total_pa, s.tracked_pa, s.pitches, s.swings,
                s.bb_total, s.bb_total_pull,
                s.swing_pct, s.whiff_pct, s.contact_pct,
                s.fb_pct, s.air_pull_pct,
                s.putaway_pct, s.pitches_per_pa
            FROM scored s
            JOIN players p ON p.id = s.player_id
            JOIN teams t ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE s.tracked_pa >= %s
              AND COALESCE(t.is_active, 1) = 1
              {where_sql}
            ORDER BY {sort_by} {direction} NULLS LAST, s.tracked_pa DESC
            LIMIT %s OFFSET %s
        """
        params = [season, min_pa] + where_params + [limit, offset]
        cur.execute(query, params)
        rows = [dict(r) for r in cur.fetchall()]

        # Count total — same WHERE, no LIMIT
        count_query = f"""
            WITH pbp AS (
                SELECT ge.batter_player_id AS player_id,
                       COUNT(*) FILTER (WHERE ge.pitches_thrown >= 1) AS tracked_pa
                FROM game_events ge
                JOIN games g ON g.id = ge.game_id
                WHERE g.season = %s AND ge.batter_player_id IS NOT NULL
                GROUP BY ge.batter_player_id
            )
            SELECT COUNT(*) AS total
            FROM pbp s
            JOIN players p ON p.id = s.player_id
            JOIN teams t ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE s.tracked_pa >= %s
              AND COALESCE(t.is_active, 1) = 1
              {where_sql}
        """
        cur.execute(count_query, [season, min_pa] + where_params)
        total = (cur.fetchone() or {}).get("total", 0) or 0

        return {
            "data": rows,
            "total": total,
            "limit": limit,
            "offset": offset,
            "season": season,
        }


@router.get("/leaderboards/pitching-pbp")
@cached_endpoint(ttl_seconds=1800)
def pitching_pbp_leaderboard(
    season: int = Query(..., description="Season year"),
    division_id: Optional[int] = Query(None),
    conference_id: Optional[int] = Query(None),
    state: Optional[str] = Query(None),
    team_id: Optional[int] = Query(None),
    year_in_school: Optional[str] = Query(None),
    min_bf: int = Query(40, description="Minimum tracked batters faced"),
    sort_by: str = Query("strike_pct", description="Sort column"),
    sort_dir: str = Query("desc", description="Sort direction (asc/desc)"),
    limit: int = Query(50),
    offset: int = Query(0),
):
    """Pitcher pitch-level leaderboard, aggregated from game_events.

    Returns per-player: strike rate, first-pitch strike rate,
    called-strike rate, whiff rate, contact rate, putaway rate,
    pitches per BF, on-or-out-in-3 rate, GB rate, plus sample-size
    fields (tracked_pa, pitches, swings, bb_total).
    """
    allowed_sort = {
        "tracked_pa", "pitches", "swings",
        "strike_pct", "called_strike_pct", "whiff_pct", "contact_pct",
        "first_pitch_strike_pct", "putaway_pct",
        "pitches_per_pa", "on_or_out_3_pct", "gb_pct",
    }
    if sort_by not in allowed_sort:
        sort_by = "strike_pct"
    direction = "DESC" if sort_dir.lower() == "desc" else "ASC"

    where_sql, where_params = _pbp_filter_clauses({
        "division_id": division_id,
        "conference_id": conference_id,
        "state": state,
        "team_id": team_id,
        "year_in_school": year_in_school,
    })

    with get_connection() as conn:
        cur = conn.cursor()
        query = f"""
            WITH pbp AS (
                SELECT
                    ge.pitcher_player_id AS player_id,
                    COUNT(*) AS total_pa,
                    COUNT(*) FILTER (WHERE ge.pitches_thrown >= 1) AS tracked_pa,
                    COALESCE(SUM(ge.pitches_thrown) FILTER (WHERE ge.pitches_thrown >= 1), 0) AS pitches,
                    COALESCE(SUM(LENGTH(ge.pitch_sequence)
                        - LENGTH(REPLACE(ge.pitch_sequence, 'K', '')))
                        FILTER (WHERE ge.pitches_thrown >= 1), 0) AS k_pitches,
                    COALESCE(SUM(LENGTH(ge.pitch_sequence)
                        - LENGTH(REPLACE(ge.pitch_sequence, 'S', '')))
                        FILTER (WHERE ge.pitches_thrown >= 1), 0) AS s_pitches,
                    COALESCE(SUM(LENGTH(ge.pitch_sequence)
                        - LENGTH(REPLACE(ge.pitch_sequence, 'F', '')))
                        FILTER (WHERE ge.pitches_thrown >= 1), 0) AS f_pitches,
                    COALESCE(SUM(CASE WHEN ge.was_in_play THEN 1 ELSE 0 END)
                        FILTER (WHERE ge.pitches_thrown >= 1), 0) AS in_play,
                    COALESCE(SUM(CASE
                        WHEN LEFT(ge.pitch_sequence, 1) IN ('K', 'S', 'F') THEN 1
                        WHEN ge.pitch_sequence = '' AND ge.was_in_play THEN 1
                        ELSE 0 END)
                        FILTER (WHERE ge.pitches_thrown >= 1), 0) AS f1_strikes,
                    COUNT(*) FILTER (WHERE ge.pitches_thrown >= 1
                                       AND ge.strikes_before = 2) AS two_strike_pa,
                    COUNT(*) FILTER (WHERE ge.pitches_thrown >= 1
                                       AND ge.strikes_before = 2
                                       AND ge.result_type IN ('strikeout_swinging','strikeout_looking')) AS two_strike_k,
                    -- on/out in 3: tracked PAs that resolved in 1-3 pitches via hit-or-out
                    -- (walks/HBP/IBB/CI excluded, those are catcher / batter outcomes).
                    COUNT(*) FILTER (
                        WHERE ge.pitches_thrown BETWEEN 1 AND 3
                          AND ge.result_type NOT IN
                              ('walk','intentional_walk','hbp','catcher_interference')
                    ) AS on_or_out_3,
                    -- Batted-ball mix allowed. bb_total = BIPs with a
                    -- known type (GB/LD/FB/PU). GB rate is GB / bb_total.
                    COUNT(*) FILTER (WHERE ge.bb_type IS NOT NULL) AS bb_total,
                    COUNT(*) FILTER (WHERE ge.bb_type = 'GB') AS gb_count
                FROM game_events ge
                JOIN games g ON g.id = ge.game_id
                WHERE g.season = %s AND ge.pitcher_player_id IS NOT NULL
                GROUP BY ge.pitcher_player_id
            ),
            scored AS (
                SELECT
                    pbp.*,
                    (pbp.s_pitches + pbp.f_pitches + pbp.in_play) AS swings,
                    -- strike rate = (called + swing + foul + in_play) / pitches
                    CASE WHEN pbp.pitches > 0
                        THEN (pbp.k_pitches + pbp.s_pitches + pbp.f_pitches + pbp.in_play)::numeric / pbp.pitches
                    END AS strike_pct,
                    CASE WHEN pbp.pitches > 0
                        THEN pbp.k_pitches::numeric / pbp.pitches
                    END AS called_strike_pct,
                    CASE WHEN (pbp.s_pitches + pbp.f_pitches + pbp.in_play) > 0
                        THEN pbp.s_pitches::numeric / (pbp.s_pitches + pbp.f_pitches + pbp.in_play)
                    END AS whiff_pct,
                    CASE WHEN (pbp.s_pitches + pbp.f_pitches + pbp.in_play) > 0
                        THEN (pbp.f_pitches + pbp.in_play)::numeric / (pbp.s_pitches + pbp.f_pitches + pbp.in_play)
                    END AS contact_pct,
                    CASE WHEN pbp.tracked_pa > 0
                        THEN pbp.f1_strikes::numeric / pbp.tracked_pa
                    END AS first_pitch_strike_pct,
                    CASE WHEN pbp.two_strike_pa > 0
                        THEN pbp.two_strike_k::numeric / pbp.two_strike_pa
                    END AS putaway_pct,
                    CASE WHEN pbp.tracked_pa > 0
                        THEN pbp.pitches::numeric / pbp.tracked_pa
                    END AS pitches_per_pa,
                    CASE WHEN pbp.tracked_pa > 0
                        THEN pbp.on_or_out_3::numeric / pbp.tracked_pa
                    END AS on_or_out_3_pct,
                    -- ground-ball rate = GB / total bb-tracked
                    CASE WHEN pbp.bb_total > 0
                        THEN pbp.gb_count::numeric / pbp.bb_total
                    END AS gb_pct
                FROM pbp
            )
            SELECT
                p.id AS player_id,
                p.first_name, p.last_name, p.year_in_school, p.position,
                t.id AS team_id, t.short_name AS team_short,
                t.school_name AS team_name, t.logo_url, t.state,
                d.level AS division_level,
                c.id AS conference_id, c.abbreviation AS conference_abbrev,
                s.total_pa, s.tracked_pa, s.pitches, s.swings, s.bb_total,
                s.strike_pct, s.called_strike_pct, s.whiff_pct, s.contact_pct,
                s.first_pitch_strike_pct, s.putaway_pct,
                s.pitches_per_pa, s.on_or_out_3_pct, s.gb_pct
            FROM scored s
            JOIN players p ON p.id = s.player_id
            JOIN teams t ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE s.tracked_pa >= %s
              AND COALESCE(t.is_active, 1) = 1
              {where_sql}
            ORDER BY {sort_by} {direction} NULLS LAST, s.tracked_pa DESC
            LIMIT %s OFFSET %s
        """
        params = [season, min_bf] + where_params + [limit, offset]
        cur.execute(query, params)
        rows = [dict(r) for r in cur.fetchall()]

        count_query = f"""
            WITH pbp AS (
                SELECT ge.pitcher_player_id AS player_id,
                       COUNT(*) FILTER (WHERE ge.pitches_thrown >= 1) AS tracked_pa
                FROM game_events ge
                JOIN games g ON g.id = ge.game_id
                WHERE g.season = %s AND ge.pitcher_player_id IS NOT NULL
                GROUP BY ge.pitcher_player_id
            )
            SELECT COUNT(*) AS total
            FROM pbp s
            JOIN players p ON p.id = s.player_id
            JOIN teams t ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE s.tracked_pa >= %s
              AND COALESCE(t.is_active, 1) = 1
              {where_sql}
        """
        cur.execute(count_query, [season, min_bf] + where_params)
        total = (cur.fetchone() or {}).get("total", 0) or 0

        return {
            "data": rows,
            "total": total,
            "limit": limit,
            "offset": offset,
            "season": season,
        }


@router.get("/leaderboards/team-batting-pbp")
@cached_endpoint(ttl_seconds=1800)
def team_batting_pbp_leaderboard(
    season: int = Query(..., description="Season year"),
    division_id: Optional[int] = Query(None),
    conference_id: Optional[int] = Query(None),
    state: Optional[str] = Query(None),
    team_id: Optional[int] = Query(None),
    min_pa: int = Query(200, description="Minimum tracked plate appearances (team)"),
    sort_by: str = Query("whiff_pct", description="Sort column"),
    sort_dir: str = Query("asc", description="Sort direction (asc/desc)"),
    limit: int = Query(50),
    offset: int = Query(0),
):
    """Team hitting pitch-level board: a club's collective plate discipline
    (Swing%, Whiff%, Contact%, FB%, AirPull%, Putaway%, P/PA), aggregated
    over every tracked PA its batters took. Same formulas as the per-hitter
    board, grouped by batting team. PNW teams only."""
    allowed_sort = {
        "tracked_pa", "pitches", "swings", "swing_pct", "whiff_pct",
        "contact_pct", "fb_pct", "air_pull_pct", "putaway_pct", "pitches_per_pa",
    }
    if sort_by not in allowed_sort:
        sort_by = "whiff_pct"
    direction = "ASC" if sort_dir.lower() == "asc" else "DESC"
    tf, tp = _team_pbp_filter_clauses(division_id, conference_id, state, team_id)

    with get_connection() as conn:
        cur = conn.cursor()
        query = f"""
            WITH pbp AS (
                SELECT
                    ge.batting_team_id AS team_id,
                    COUNT(*) FILTER (WHERE ge.pitches_thrown >= 1) AS tracked_pa,
                    COALESCE(SUM(ge.pitches_thrown) FILTER (WHERE ge.pitches_thrown >= 1), 0) AS pitches,
                    COALESCE(SUM(LENGTH(ge.pitch_sequence) - LENGTH(REPLACE(ge.pitch_sequence, 'K', '')))
                        FILTER (WHERE ge.pitches_thrown >= 1), 0) AS k_pitches,
                    COALESCE(SUM(LENGTH(ge.pitch_sequence) - LENGTH(REPLACE(ge.pitch_sequence, 'F', '')))
                        FILTER (WHERE ge.pitches_thrown >= 1), 0) AS f_pitches,
                    COALESCE(SUM(CASE WHEN ge.was_in_play THEN 1 ELSE 0 END)
                        FILTER (WHERE ge.pitches_thrown >= 1), 0) AS in_play,
                    COUNT(*) FILTER (WHERE ge.pitches_thrown >= 1 AND ge.strikes_before = 2) AS two_strike_pa,
                    COUNT(*) FILTER (WHERE ge.pitches_thrown >= 1 AND ge.strikes_before = 2
                                       AND ge.result_type IN ('strikeout_swinging','strikeout_looking')) AS two_strike_k,
                    COUNT(*) FILTER (WHERE ge.bb_type IS NOT NULL) AS bb_total,
                    COUNT(*) FILTER (WHERE ge.bb_type = 'FB') AS fb_count,
                    COUNT(*) FILTER (WHERE ge.bb_type IS NOT NULL AND UPPER(plyr.bats) IN ('L','R')) AS bb_total_pull,
                    COUNT(*) FILTER (WHERE ge.bb_type IN ('LD','FB')
                        AND ((UPPER(plyr.bats) = 'R' AND ge.field_zone = 'LEFT')
                          OR (UPPER(plyr.bats) = 'L' AND ge.field_zone = 'RIGHT'))) AS air_pull_count
                FROM game_events ge
                JOIN games g ON g.id = ge.game_id
                LEFT JOIN players plyr ON plyr.id = ge.batter_player_id
                WHERE g.season = %s AND ge.batting_team_id IS NOT NULL
                GROUP BY ge.batting_team_id
            ),
            scored AS (
                SELECT pbp.*,
                    (pbp.s_pitches + pbp.f_pitches + pbp.in_play) AS swings,
                    CASE WHEN pbp.pitches > 0 THEN (pbp.s_pitches + pbp.f_pitches + pbp.in_play)::numeric / pbp.pitches END AS swing_pct,
                    CASE WHEN (pbp.s_pitches + pbp.f_pitches + pbp.in_play) > 0 THEN pbp.k_pitches::numeric / (pbp.s_pitches + pbp.f_pitches + pbp.in_play) END AS whiff_pct,
                    CASE WHEN (pbp.s_pitches + pbp.f_pitches + pbp.in_play) > 0 THEN (pbp.f_pitches + pbp.in_play)::numeric / (pbp.s_pitches + pbp.f_pitches + pbp.in_play) END AS contact_pct,
                    CASE WHEN pbp.tracked_pa > 0 THEN pbp.pitches::numeric / pbp.tracked_pa END AS pitches_per_pa,
                    CASE WHEN pbp.two_strike_pa > 0 THEN pbp.two_strike_k::numeric / pbp.two_strike_pa END AS putaway_pct,
                    CASE WHEN pbp.bb_total > 0 THEN pbp.fb_count::numeric / pbp.bb_total END AS fb_pct,
                    CASE WHEN pbp.bb_total_pull > 0 THEN pbp.air_pull_count::numeric / pbp.bb_total_pull END AS air_pull_pct
                FROM pbp
            )
            SELECT
                t.id AS team_id, t.short_name, t.school_name AS team_name, t.logo_url, t.state,
                d.level AS division_level, c.id AS conference_id, c.abbreviation AS conference_abbrev,
                s.tracked_pa, s.pitches, s.swings,
                s.swing_pct, s.whiff_pct, s.contact_pct, s.fb_pct, s.air_pull_pct,
                s.putaway_pct, s.pitches_per_pa
            FROM scored s
            JOIN teams t ON t.id = s.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE s.tracked_pa >= %s
              AND t.state IN ('WA','OR','ID','MT','BC')
              {tf}
            ORDER BY {sort_by} {direction} NULLS LAST, s.tracked_pa DESC
            LIMIT %s OFFSET %s
        """
        cur.execute(query, [season, min_pa] + tp + [limit, offset])
        rows = [dict(r) for r in cur.fetchall()]
        return {"data": rows, "total": len(rows), "limit": limit, "offset": offset, "season": season}


@router.get("/leaderboards/team-pitching-pbp")
@cached_endpoint(ttl_seconds=1800)
def team_pitching_pbp_leaderboard(
    season: int = Query(..., description="Season year"),
    division_id: Optional[int] = Query(None),
    conference_id: Optional[int] = Query(None),
    state: Optional[str] = Query(None),
    team_id: Optional[int] = Query(None),
    min_bf: int = Query(200, description="Minimum tracked batters faced (team)"),
    sort_by: str = Query("strike_pct", description="Sort column"),
    sort_dir: str = Query("desc", description="Sort direction (asc/desc)"),
    limit: int = Query(50),
    offset: int = Query(0),
):
    """Team pitching pitch-level board: a staff's collective strike-throwing
    and swing-and-miss (Strike%, First-Pitch Strike%, Called-Strike%, Whiff%,
    Contact%, GB%, Putaway%, OO3%, P/BF). The pitching team is the opponent of
    the batting team on each event, so this captures every pitch the staff
    threw (no pitcher-ID resolution needed). PNW teams only."""
    allowed_sort = {
        "tracked_pa", "pitches", "swings", "strike_pct", "called_strike_pct",
        "whiff_pct", "contact_pct", "first_pitch_strike_pct", "putaway_pct",
        "pitches_per_pa", "on_or_out_3_pct", "gb_pct",
    }
    if sort_by not in allowed_sort:
        sort_by = "strike_pct"
    direction = "DESC" if sort_dir.lower() == "desc" else "ASC"
    tf, tp = _team_pbp_filter_clauses(division_id, conference_id, state, team_id)

    with get_connection() as conn:
        cur = conn.cursor()
        query = f"""
            WITH ev AS (
                SELECT ge.*,
                    (CASE WHEN ge.batting_team_id = g.home_team_id THEN g.away_team_id ELSE g.home_team_id END) AS pitch_team_id
                FROM game_events ge
                JOIN games g ON g.id = ge.game_id
                WHERE g.season = %s
            ),
            pbp AS (
                SELECT
                    ev.pitch_team_id AS team_id,
                    COUNT(*) FILTER (WHERE ev.pitches_thrown >= 1) AS tracked_pa,
                    COALESCE(SUM(ev.pitches_thrown) FILTER (WHERE ev.pitches_thrown >= 1), 0) AS pitches,
                    COALESCE(SUM(LENGTH(ev.pitch_sequence) - LENGTH(REPLACE(ev.pitch_sequence, 'K', '')))
                        FILTER (WHERE ev.pitches_thrown >= 1), 0) AS k_pitches,
                    COALESCE(SUM(LENGTH(ev.pitch_sequence) - LENGTH(REPLACE(ev.pitch_sequence, 'S', '')))
                        FILTER (WHERE ev.pitches_thrown >= 1), 0) AS s_pitches,
                    COALESCE(SUM(LENGTH(ev.pitch_sequence) - LENGTH(REPLACE(ev.pitch_sequence, 'F', '')))
                        FILTER (WHERE ev.pitches_thrown >= 1), 0) AS f_pitches,
                    COALESCE(SUM(CASE WHEN ev.was_in_play THEN 1 ELSE 0 END)
                        FILTER (WHERE ev.pitches_thrown >= 1), 0) AS in_play,
                    COALESCE(SUM(CASE
                        WHEN LEFT(ev.pitch_sequence, 1) IN ('K','S','F') THEN 1
                        WHEN ev.pitch_sequence = '' AND ev.was_in_play THEN 1
                        ELSE 0 END) FILTER (WHERE ev.pitches_thrown >= 1), 0) AS f1_strikes,
                    COUNT(*) FILTER (WHERE ev.pitches_thrown >= 1 AND ev.strikes_before = 2) AS two_strike_pa,
                    COUNT(*) FILTER (WHERE ev.pitches_thrown >= 1 AND ev.strikes_before = 2
                                       AND ev.result_type IN ('strikeout_swinging','strikeout_looking')) AS two_strike_k,
                    COUNT(*) FILTER (WHERE ev.pitches_thrown BETWEEN 1 AND 3
                          AND ev.result_type NOT IN ('walk','intentional_walk','hbp','catcher_interference')) AS on_or_out_3,
                    COUNT(*) FILTER (WHERE ev.bb_type IS NOT NULL) AS bb_total,
                    COUNT(*) FILTER (WHERE ev.bb_type = 'GB') AS gb_count
                FROM ev
                WHERE ev.pitch_team_id IS NOT NULL
                GROUP BY ev.pitch_team_id
            ),
            scored AS (
                SELECT pbp.*,
                    (pbp.s_pitches + pbp.f_pitches + pbp.in_play) AS swings,
                    CASE WHEN pbp.pitches > 0 THEN (pbp.k_pitches + pbp.s_pitches + pbp.f_pitches + pbp.in_play)::numeric / pbp.pitches END AS strike_pct,
                    CASE WHEN pbp.pitches > 0 THEN pbp.s_pitches::numeric / pbp.pitches END AS called_strike_pct,
                    CASE WHEN (pbp.s_pitches + pbp.f_pitches + pbp.in_play) > 0 THEN pbp.k_pitches::numeric / (pbp.s_pitches + pbp.f_pitches + pbp.in_play) END AS whiff_pct,
                    CASE WHEN (pbp.s_pitches + pbp.f_pitches + pbp.in_play) > 0 THEN (pbp.f_pitches + pbp.in_play)::numeric / (pbp.s_pitches + pbp.f_pitches + pbp.in_play) END AS contact_pct,
                    CASE WHEN pbp.tracked_pa > 0 THEN pbp.f1_strikes::numeric / pbp.tracked_pa END AS first_pitch_strike_pct,
                    CASE WHEN pbp.two_strike_pa > 0 THEN pbp.two_strike_k::numeric / pbp.two_strike_pa END AS putaway_pct,
                    CASE WHEN pbp.tracked_pa > 0 THEN pbp.pitches::numeric / pbp.tracked_pa END AS pitches_per_pa,
                    CASE WHEN pbp.tracked_pa > 0 THEN pbp.on_or_out_3::numeric / pbp.tracked_pa END AS on_or_out_3_pct,
                    CASE WHEN pbp.bb_total > 0 THEN pbp.gb_count::numeric / pbp.bb_total END AS gb_pct
                FROM pbp
            )
            SELECT
                t.id AS team_id, t.short_name, t.school_name AS team_name, t.logo_url, t.state,
                d.level AS division_level, c.id AS conference_id, c.abbreviation AS conference_abbrev,
                s.tracked_pa, s.pitches, s.swings,
                s.strike_pct, s.called_strike_pct, s.whiff_pct, s.contact_pct,
                s.first_pitch_strike_pct, s.putaway_pct, s.pitches_per_pa,
                s.on_or_out_3_pct, s.gb_pct
            FROM scored s
            JOIN teams t ON t.id = s.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE s.tracked_pa >= %s
              AND t.state IN ('WA','OR','ID','MT','BC')
              {tf}
            ORDER BY {sort_by} {direction} NULLS LAST, s.tracked_pa DESC
            LIMIT %s OFFSET %s
        """
        cur.execute(query, [season, min_bf] + tp + [limit, offset])
        rows = [dict(r) for r in cur.fetchall()]
        return {"data": rows, "total": len(rows), "limit": limit, "offset": offset, "season": season}


# ============================================================
# RELIEVER LEADERBOARD (Goose Eggs + reliever WPA, from game_events)
# ============================================================
#
# Spring only (D1-NAIA): needs the base/out/score state + WPA that
# game_events carries. Summer (summer_game_events) has no state yet.
#
# Reliever isolation: the starter of each (game, half) is the pitcher
# with the earliest (inning, sequence_idx); every other pitcher in that
# half is relieving. We aggregate ONLY non-starter events, so a
# swingman's starts never pollute his relief line.
#
# Goose Eggs (per Tom Tango, adapted to the high-scoring PNW college
# environment with a default 3-run lead threshold):
#   A relief "goose window" inning is the 7th or later where, when the
#   reliever enters, his team is NOT trailing (lead >= 0) AND either the
#   lead is <= threshold OR the tying run is on base/at bat
#   (lead <= runners_on_base + 1). NOTE the lead >= 0 floor: you cannot
#   earn a goose egg while losing (this fixes the intern script, which
#   credited mop-up innings in blowout losses).
#   - GEG  = goose window + no runs scored during the stint + the pitcher
#            finished the inning (3 outs) OR escaped a jam (>=1 out and
#            outs + inherited runners >= 3).
#   - BRK  = "broken egg": goose window where a run scored during the stint.
#   - OPP  = goose opportunities (windows). Goose% = GEG / (GEG + BRK),
#            so the board rewards quality, not just usage.

@router.get("/leaderboards/relievers")
@cached_endpoint(ttl_seconds=1800)
def reliever_leaderboard(
    season: int = Query(..., description="Season year"),
    division_id: Optional[int] = Query(None),
    conference_id: Optional[int] = Query(None),
    state: Optional[str] = Query(None),
    team_id: Optional[int] = Query(None),
    year_in_school: Optional[str] = Query(None),
    lead_threshold: int = Query(3, description="Max lead for a goose window (PNW college default 3)"),
    min_bf: int = Query(20, description="Minimum relief batters faced"),
    sort_by: str = Query("wpa", description="Sort column"),
    sort_dir: str = Query("desc", description="Sort direction (asc/desc)"),
    limit: int = Query(50),
    offset: int = Query(0),
):
    """Reliever leaderboard from play-by-play: Goose Eggs, broken eggs,
    reliever WPA, and relief rate stats (IP, K%, BB%, RA9, WHIP)."""
    allowed_sort = {
        "wpa", "geg", "brk", "opp", "goose_pct",
        "app", "ip", "bf", "k", "bb", "h", "r",
        "k_pct", "bb_pct", "ra9", "whip",
        "holds", "blown_saves", "saves",
    }
    if sort_by not in allowed_sort:
        sort_by = "wpa"
    # Lower-is-better stats default ascending
    ascending_stats = {"ra9", "bb_pct", "whip", "r", "brk"}
    default_dir = "ASC" if sort_by in ascending_stats else "DESC"
    direction = sort_dir.upper() if sort_dir.upper() in ("ASC", "DESC") else default_dir

    where_sql, where_params = _pbp_filter_clauses({
        "division_id": division_id,
        "conference_id": conference_id,
        "state": state,
        "team_id": team_id,
        "year_in_school": year_in_school,
    })

    # PA-ending result types (for batters-faced / K / BB / H counting)
    pa_types = (
        "'single','double','triple','home_run','walk','intentional_walk','hbp',"
        "'strikeout_swinging','strikeout_looking','ground_out','fly_out','line_out',"
        "'pop_out','sac_fly','sac_bunt','fielders_choice','error','double_play','other'"
    )

    with get_connection() as conn:
        cur = conn.cursor()
        query = f"""
            WITH starters AS (
                SELECT DISTINCT ON (ge.game_id, ge.half)
                       ge.game_id, ge.half, ge.pitcher_player_id AS starter_id
                FROM game_events ge
                JOIN games g ON g.id = ge.game_id
                WHERE g.season = %s
                ORDER BY ge.game_id, ge.half, ge.inning, ge.sequence_idx
            ),
            relief_ev AS (
                SELECT ge.*
                FROM game_events ge
                JOIN games g ON g.id = ge.game_id
                JOIN starters st ON st.game_id = ge.game_id AND st.half = ge.half
                WHERE g.season = %s
                  AND ge.pitcher_player_id IS NOT NULL
                  AND ge.pitcher_player_id <> st.starter_id
            ),
            agg AS (
                SELECT pitcher_player_id AS player_id,
                       COUNT(DISTINCT game_id) AS app,
                       SUM(GREATEST(outs_after - outs_before, 0)) AS outs,
                       COUNT(*) FILTER (WHERE result_type IN ({pa_types})) AS bf,
                       COUNT(*) FILTER (WHERE result_type IN ('strikeout_swinging','strikeout_looking')) AS k,
                       COUNT(*) FILTER (WHERE result_type IN ('walk','intentional_walk')) AS bb,
                       COUNT(*) FILTER (WHERE result_type IN ('single','double','triple','home_run')) AS h,
                       COALESCE(SUM(runs_on_play), 0) AS r,
                       COALESCE(SUM(wpa_pitcher), 0) AS wpa
                FROM relief_ev
                GROUP BY pitcher_player_id
            ),
            stint AS (
                SELECT game_id, inning, half, pitcher_player_id,
                       MIN(sequence_idx) AS first_seq,
                       COALESCE(SUM(runs_on_play), 0) AS runs_allowed,
                       SUM(GREATEST(outs_after - outs_before, 0)) AS outs_recorded
                FROM relief_ev
                GROUP BY game_id, inning, half, pitcher_player_id
            ),
            entry AS (
                SELECT s.pitcher_player_id, s.inning, s.runs_allowed, s.outs_recorded,
                       e.bat_score_before, e.fld_score_before,
                       (LENGTH(e.bases_before) - LENGTH(REPLACE(e.bases_before, '1', ''))) AS runners_on
                FROM stint s
                JOIN relief_ev e
                  ON e.game_id = s.game_id AND e.inning = s.inning AND e.half = s.half
                 AND e.pitcher_player_id = s.pitcher_player_id AND e.sequence_idx = s.first_seq
            ),
            goose AS (
                SELECT player_id,
                       COUNT(*) FILTER (WHERE window_ok) AS opp,
                       COUNT(*) FILTER (
                           WHERE window_ok AND runs_allowed = 0
                             AND (outs_recorded = 3
                                  OR (outs_recorded >= 1 AND outs_recorded + runners_on >= 3))
                       ) AS geg,
                       COUNT(*) FILTER (WHERE window_ok AND runs_allowed > 0) AS brk
                FROM (
                    SELECT pitcher_player_id AS player_id, runs_allowed, outs_recorded, runners_on,
                           (inning >= 7
                            AND (fld_score_before - bat_score_before) >= 0
                            AND ((fld_score_before - bat_score_before) <= %s
                                 OR (fld_score_before - bat_score_before) <= runners_on + 1)
                           ) AS window_ok
                    FROM entry
                ) w
                GROUP BY player_id
            )
            SELECT
                p.id AS player_id, p.first_name, p.last_name, p.year_in_school,
                p.position, p.throws,
                t.id AS team_id, t.short_name AS team_short,
                t.school_name AS team_name, t.logo_url, t.state,
                d.level AS division_level,
                c.id AS conference_id, c.abbreviation AS conference_abbrev,
                a.app, a.outs, a.bf, a.k, a.bb, a.h, a.r, a.wpa,
                COALESCE(pst.holds, 0) AS holds,
                COALESCE(pst.blown_saves, 0) AS blown_saves,
                COALESCE(pst.saves, 0) AS saves,
                COALESCE(gz.geg, 0) AS geg,
                COALESCE(gz.brk, 0) AS brk,
                COALESCE(gz.opp, 0) AS opp,
                a.outs / 3.0 AS ip,
                CASE WHEN a.bf > 0 THEN a.k::numeric / a.bf END AS k_pct,
                CASE WHEN a.bf > 0 THEN a.bb::numeric / a.bf END AS bb_pct,
                CASE WHEN a.outs > 0 THEN a.r * 27.0 / a.outs END AS ra9,
                CASE WHEN a.outs > 0 THEN (a.h + a.bb) * 3.0 / a.outs END AS whip,
                CASE WHEN COALESCE(gz.geg, 0) + COALESCE(gz.brk, 0) > 0
                     THEN gz.geg::numeric / (gz.geg + gz.brk) END AS goose_pct
            FROM agg a
            JOIN players p ON p.id = a.player_id
            JOIN teams t ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            LEFT JOIN goose gz ON gz.player_id = a.player_id
            LEFT JOIN pitching_stats pst
                   ON pst.player_id = p.id AND pst.team_id = t.id AND pst.season = %s
            WHERE a.bf >= %s
              AND COALESCE(t.is_active, 1) = 1
              {where_sql}
            ORDER BY {sort_by} {direction} NULLS LAST, a.wpa DESC
            LIMIT %s OFFSET %s
        """
        params = [season, season, lead_threshold] + [season, min_bf] + where_params + [limit, offset]
        cur.execute(query, params)
        rows = [dict(r) for r in cur.fetchall()]

        return {
            "data": rows,
            "total": len(rows),
            "limit": limit,
            "offset": offset,
            "season": season,
            "lead_threshold": lead_threshold,
        }


@router.get("/players/{player_id}/goose-eggs")
def player_goose_eggs(player_id: int, season: int = Query(CURRENT_SEASON)):
    """One reliever's Goose Egg line (GEG / BRK / OPP / Goose%) from PBP.

    Uses the SAME goose-window rules as /leaderboards/relievers (7th+, team
    not trailing, lead <= 3 or tying run on/at bat) but scoped to a single
    player with no minimum-batters-faced cutoff. Spring (D1-NAIA) only;
    relief events only (the player's own starts never count)."""
    LEAD_THRESHOLD = 3
    with get_connection() as conn:
        cur = conn.cursor()
        # Follow transfer links so a multi-school season aggregates correctly.
        cur.execute("SELECT canonical_id FROM player_links WHERE linked_id = %s", (player_id,))
        link = cur.fetchone()
        if link:
            player_id = link["canonical_id"]
        cur.execute("SELECT linked_id FROM player_links WHERE canonical_id = %s", (player_id,))
        ids = [player_id] + [r["linked_id"] for r in cur.fetchall()]

        query = """
            WITH pgames AS (
                SELECT DISTINCT ge.game_id
                FROM game_events ge JOIN games g ON g.id = ge.game_id
                WHERE g.season = %s AND ge.pitcher_player_id = ANY(%s)
            ),
            starters AS (
                SELECT DISTINCT ON (ge.game_id, ge.half)
                       ge.game_id, ge.half, ge.pitcher_player_id AS starter_id
                FROM game_events ge
                WHERE ge.game_id IN (SELECT game_id FROM pgames)
                ORDER BY ge.game_id, ge.half, ge.inning, ge.sequence_idx
            ),
            relief_ev AS (
                SELECT ge.*
                FROM game_events ge
                JOIN starters st ON st.game_id = ge.game_id AND st.half = ge.half
                WHERE ge.pitcher_player_id = ANY(%s)
                  AND ge.pitcher_player_id <> st.starter_id
            ),
            stint AS (
                SELECT game_id, inning, half, pitcher_player_id,
                       MIN(sequence_idx) AS first_seq,
                       COALESCE(SUM(runs_on_play), 0) AS runs_allowed,
                       SUM(GREATEST(outs_after - outs_before, 0)) AS outs_recorded
                FROM relief_ev
                GROUP BY game_id, inning, half, pitcher_player_id
            ),
            entry AS (
                SELECT s.runs_allowed, s.outs_recorded, s.inning,
                       e.bat_score_before, e.fld_score_before,
                       (LENGTH(e.bases_before) - LENGTH(REPLACE(e.bases_before, '1', ''))) AS runners_on
                FROM stint s
                JOIN relief_ev e
                  ON e.game_id = s.game_id AND e.inning = s.inning AND e.half = s.half
                 AND e.pitcher_player_id = s.pitcher_player_id AND e.sequence_idx = s.first_seq
            ),
            w AS (
                SELECT runs_allowed, outs_recorded, runners_on,
                       (inning >= 7
                        AND (fld_score_before - bat_score_before) >= 0
                        AND ((fld_score_before - bat_score_before) <= %s
                             OR (fld_score_before - bat_score_before) <= runners_on + 1)
                       ) AS window_ok
                FROM entry
            )
            SELECT
                COUNT(*) FILTER (WHERE window_ok) AS opp,
                COUNT(*) FILTER (
                    WHERE window_ok AND runs_allowed = 0
                      AND (outs_recorded = 3
                           OR (outs_recorded >= 1 AND outs_recorded + runners_on >= 3))
                ) AS geg,
                COUNT(*) FILTER (WHERE window_ok AND runs_allowed > 0) AS brk,
                (SELECT COUNT(DISTINCT game_id) FROM relief_ev) AS relief_app,
                (SELECT COALESCE(SUM(GREATEST(outs_after - outs_before, 0)), 0) FROM relief_ev) AS relief_outs
            FROM w
        """
        cur.execute(query, (season, ids, ids, LEAD_THRESHOLD))
        r = cur.fetchone() or {}
        geg = r.get("geg") or 0
        brk = r.get("brk") or 0
        opp = r.get("opp") or 0
        relief_outs = r.get("relief_outs") or 0
        return {
            "season": season,
            "geg": geg,
            "brk": brk,
            "opp": opp,
            "goose_pct": round(geg / (geg + brk), 3) if (geg + brk) > 0 else None,
            "relief_app": r.get("relief_app") or 0,
            "relief_ip": round(relief_outs / 3.0, 1),
            "lead_threshold": LEAD_THRESHOLD,
        }


# ============================================================
# FIELDING LEADERBOARD
# ============================================================
#
# Two modes depending on the `position` query parameter:
#
# 1. `position` not set (or "ANY") — returns one row per
#    (player, team) using the OFFICIAL season-total row when the
#    season scraper populated one (position='ALL' in fielding_stats),
#    and falling back to a SUM of the PBP-derived per-position rows
#    when no 'ALL' row exists (e.g., D1 players, who only have
#    box-score-sourced per-position rows).
#
# 2. `position` set to P/C/1B/2B/3B/SS/LF/CF/RF — returns one row
#    per (player, team) at exactly that position. This is what the
#    "best catchers in NAIA" or "top SS by FLD%" views render.
#
# fielding_pct, range_factor, and cs_pct are recomputed in the SELECT
# so the COALESCEd "Any" totals stay consistent. Catcher-only stats
# (PB / SBA / CS / CS%) are always returned; the frontend dashes
# them out for non-catcher rows.

@router.get("/leaderboards/fielding")
@cached_endpoint(ttl_seconds=1800)
def fielding_leaderboard(
    season: int = Query(..., description="Season year"),
    position: Optional[str] = Query(
        None,
        description="Filter by defensive position (P/C/1B/2B/3B/SS/LF/CF/RF). Omit for all-positions view.",
    ),
    division_id: Optional[int] = Query(None),
    conference_id: Optional[int] = Query(None),
    state: Optional[str] = Query(None),
    team_id: Optional[int] = Query(None),
    min_games: int = Query(0, description="Min games at position"),
    min_chances: int = Query(0, description="Min total chances (PO+A+E)"),
    sort_by: str = Query("fielding_pct", description="Sort column"),
    sort_dir: str = Query("desc", description="Sort direction (asc/desc)"),
    year_in_school: Optional[str] = Query(None),
    limit: int = Query(50, description="Results per page"),
    offset: int = Query(0, description="Pagination offset"),
):
    allowed_sort = {
        "fielding_pct", "putouts", "assists", "errors", "double_plays",
        "triple_plays", "total_chances", "range_factor",
        "games", "games_started", "innings",
        "passed_balls", "stolen_bases_against", "caught_stealing_by",
        "cs_pct", "pickoffs",
    }
    if sort_by not in allowed_sort:
        sort_by = "fielding_pct"
    ascending = {"errors"}  # lower-is-better stats
    default_dir = "ASC" if sort_by in ascending else "DESC"
    sort_direction = sort_dir.upper() if sort_dir.upper() in ("ASC", "DESC") else default_dir

    # Normalize position. "ANY" / "" / None all mean "no filter".
    pos = (position or "").strip().upper()
    if pos in ("", "ANY", "ALL_POS"):
        pos = None
    elif pos not in {"P", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"}:
        # Bad input — fall back to no filter rather than 400.
        pos = None

    with get_connection() as conn:
        cur = conn.cursor()
        params: list = []

        if pos is None:
            # ── All-positions view: prefer 'ALL' row, fall back to
            #    per-position aggregate via FULL OUTER JOIN + COALESCE.
            query = """
                WITH agg AS (
                    SELECT player_id, team_id, season,
                           MAX(games) AS games,
                           MAX(games_started) AS games_started,
                           SUM(innings) AS innings,
                           SUM(putouts) AS putouts,
                           SUM(assists) AS assists,
                           SUM(errors) AS errors,
                           SUM(double_plays) AS double_plays,
                           SUM(triple_plays) AS triple_plays,
                           SUM(passed_balls) AS passed_balls,
                           SUM(stolen_bases_against) AS stolen_bases_against,
                           SUM(caught_stealing_by) AS caught_stealing_by,
                           SUM(pickoffs) AS pickoffs,
                           SUM(catchers_interference) AS catchers_interference
                    FROM fielding_stats
                    WHERE season = %s AND position != 'ALL'
                    GROUP BY player_id, team_id, season
                ),
                all_rows AS (
                    SELECT * FROM fielding_stats
                    WHERE season = %s AND position = 'ALL'
                ),
                combined AS (
                    SELECT
                        COALESCE(ar.player_id, agg.player_id) AS player_id,
                        COALESCE(ar.team_id, agg.team_id) AS team_id,
                        COALESCE(ar.season, agg.season) AS season,
                        'ALL'::varchar AS position,
                        COALESCE(ar.games, agg.games) AS games,
                        COALESCE(ar.games_started, agg.games_started) AS games_started,
                        COALESCE(ar.innings, agg.innings) AS innings,
                        COALESCE(ar.putouts, agg.putouts) AS putouts,
                        COALESCE(ar.assists, agg.assists) AS assists,
                        COALESCE(ar.errors, agg.errors) AS errors,
                        COALESCE(ar.double_plays, agg.double_plays) AS double_plays,
                        COALESCE(ar.triple_plays, agg.triple_plays) AS triple_plays,
                        COALESCE(ar.passed_balls, agg.passed_balls) AS passed_balls,
                        COALESCE(ar.stolen_bases_against, agg.stolen_bases_against) AS stolen_bases_against,
                        COALESCE(ar.caught_stealing_by, agg.caught_stealing_by) AS caught_stealing_by,
                        COALESCE(ar.pickoffs, agg.pickoffs) AS pickoffs,
                        COALESCE(ar.catchers_interference, agg.catchers_interference) AS catchers_interference
                    FROM all_rows ar
                    FULL OUTER JOIN agg USING (player_id, team_id, season)
                )
                SELECT
                    fs.player_id, fs.team_id, fs.season, fs.position,
                    fs.games, fs.games_started, fs.innings,
                    fs.putouts, fs.assists, fs.errors,
                    fs.double_plays, fs.triple_plays,
                    fs.passed_balls, fs.stolen_bases_against,
                    fs.caught_stealing_by, fs.pickoffs,
                    fs.catchers_interference,
                    (COALESCE(fs.putouts,0) + COALESCE(fs.assists,0) + COALESCE(fs.errors,0)) AS total_chances,
                    CASE WHEN (COALESCE(fs.putouts,0) + COALESCE(fs.assists,0) + COALESCE(fs.errors,0)) > 0
                         THEN ROUND((COALESCE(fs.putouts,0) + COALESCE(fs.assists,0))::numeric
                                    / (COALESCE(fs.putouts,0) + COALESCE(fs.assists,0) + COALESCE(fs.errors,0)), 4)
                    END AS fielding_pct,
                    CASE WHEN fs.innings IS NOT NULL AND fs.innings > 0
                         THEN ROUND((COALESCE(fs.putouts,0) + COALESCE(fs.assists,0))::numeric / fs.innings * 9, 2)
                    END AS range_factor,
                    CASE WHEN (COALESCE(fs.stolen_bases_against,0) + COALESCE(fs.caught_stealing_by,0)) > 0
                         THEN ROUND(COALESCE(fs.caught_stealing_by,0)::numeric
                                    / (COALESCE(fs.stolen_bases_against,0) + COALESCE(fs.caught_stealing_by,0)), 4)
                    END AS cs_pct,
                    p.first_name, p.last_name, p.position AS primary_position,
                    p.year_in_school, p.bats, p.throws, p.hometown,
                    t.name AS team_name, t.short_name AS team_short, t.logo_url,
                    t.state AS team_state,
                    conf.name AS conference_name, conf.abbreviation AS conference_abbrev,
                    d.name AS division_name, d.level AS division_level
                FROM combined fs
                JOIN players p ON fs.player_id = p.id
                JOIN teams t ON fs.team_id = t.id
                JOIN conferences conf ON t.conference_id = conf.id
                JOIN divisions d ON conf.division_id = d.id
                WHERE COALESCE(fs.games, 0) >= %s
                  AND (COALESCE(fs.putouts,0) + COALESCE(fs.assists,0) + COALESCE(fs.errors,0)) >= %s
            """
            params = [season, season, min_games, min_chances]
        else:
            # ── Position-specific view: simple lookup against
            #    fielding_stats with position = %s.
            query = """
                SELECT
                    fs.player_id, fs.team_id, fs.season, fs.position,
                    fs.games, fs.games_started, fs.innings,
                    fs.putouts, fs.assists, fs.errors,
                    fs.double_plays, fs.triple_plays,
                    fs.passed_balls, fs.stolen_bases_against,
                    fs.caught_stealing_by, fs.pickoffs,
                    fs.catchers_interference,
                    (COALESCE(fs.putouts,0) + COALESCE(fs.assists,0) + COALESCE(fs.errors,0)) AS total_chances,
                    fs.fielding_pct, fs.range_factor, fs.cs_pct,
                    p.first_name, p.last_name, p.position AS primary_position,
                    p.year_in_school, p.bats, p.throws, p.hometown,
                    t.name AS team_name, t.short_name AS team_short, t.logo_url,
                    t.state AS team_state,
                    conf.name AS conference_name, conf.abbreviation AS conference_abbrev,
                    d.name AS division_name, d.level AS division_level
                FROM fielding_stats fs
                JOIN players p ON fs.player_id = p.id
                JOIN teams t ON fs.team_id = t.id
                JOIN conferences conf ON t.conference_id = conf.id
                JOIN divisions d ON conf.division_id = d.id
                WHERE fs.season = %s AND fs.position = %s
                  AND COALESCE(fs.games, 0) >= %s
                  AND (COALESCE(fs.putouts,0) + COALESCE(fs.assists,0) + COALESCE(fs.errors,0)) >= %s
            """
            params = [season, pos, min_games, min_chances]

        # Shared filter clauses.
        if division_id:
            query += " AND conf.division_id = %s"
            params.append(division_id)
        if conference_id:
            query += " AND t.conference_id = %s"
            params.append(conference_id)
        if state:
            query += " AND t.state = %s"
            params.append(state.upper())
        if team_id:
            query += " AND fs.team_id = %s"
            params.append(team_id)
        if year_in_school:
            query += " AND p.year_in_school = %s"
            params.append(year_in_school)

        # ORDER BY uses the SELECT aliases (range_factor, cs_pct,
        # total_chances, fielding_pct) — Postgres accepts those.
        query += f" ORDER BY {sort_by} {sort_direction} NULLS LAST"
        # Secondary sort to keep the order stable across reloads.
        query += ", total_chances DESC NULLS LAST, fs.player_id ASC"
        query += " LIMIT %s OFFSET %s"
        params.extend([limit, offset])

        cur.execute(query, params)
        rows = cur.fetchall()
        return {
            "data": [dict(r) for r in rows],
            "total": len(rows),
            "limit": limit,
            "offset": offset,
            "season": season,
            "position": pos or "ALL_POS",
        }


# ============================================================
# WAR LEADERBOARD
# ============================================================

@router.get("/leaderboards/war")
@cached_endpoint(ttl_seconds=1800)
def war_leaderboard(
    season: int = Query(..., description="Season year"),
    division_id: Optional[int] = Query(None),
    conference_id: Optional[int] = Query(None),
    min_pa: int = Query(30, description="Min PA for position players"),
    min_ip: float = Query(10, description="Min IP for pitchers"),
    qualified: bool = Query(False, description="Only qualified players (2 PA/game batting, 0.75 IP/game pitching)"),
    position_group: Optional[str] = Query(None, description="Filter by position group (IF, OF, C, P, UT)"),
    sort_by: str = Query("total_war", description="Sort column"),
    sort_dir: str = Query("desc", description="Sort direction (asc/desc)"),
    limit: int = Query(50),
    offset: int = Query(0),
    conference_only: bool = Query(False, description="Only count stats from conference games"),
):
    """
    Combined WAR leaderboard for all players (hitters + pitchers).
    Two-way players have both components summed.
    When conference_only=true, WAR/wOBA/wRC+ are unavailable; sort by batting_avg or era instead.
    """
    allowed_sort = {
        "total_war", "offensive_war", "pitching_war", "war_per_pa", "war_per_ip",
        "plate_appearances", "batting_avg", "woba", "wobacon", "wrc_plus",
        "innings_pitched", "era", "whip", "fip", "fip_plus", "era_minus", "era_plus", "k_per_9", "wins",
    }
    if sort_by not in allowed_sort:
        sort_by = "total_war"
    # If conference_only, WAR and advanced stats aren't available
    if conference_only and sort_by in ("total_war", "offensive_war", "pitching_war", "war_per_pa", "war_per_ip", "woba", "wobacon", "wrc_plus", "fip", "fip_plus", "era_minus", "era_plus"):
        sort_by = "batting_avg"
    # For ERA/WHIP/FIP lower is better, so flip the default direction
    sort_direction = "DESC" if sort_dir.lower() == "desc" else "ASC"

    with get_connection() as conn:
        cur = conn.cursor()

        if conference_only:
            # Use CTEs for conference-only game data
            cte_prefix = f"WITH {CONF_BATTING_CTE}, {CONF_PITCHING_CTE}"
            # CONF_BATTING_CTE needs season param, CONF_PITCHING_CTE needs season param
            batting_query = f"""
                SELECT p.id as player_id, p.first_name, p.last_name, p.position,
                       p.year_in_school, t.id as team_id, t.name as team_name, t.short_name as team_short, t.logo_url,
                       d.name as division_name, d.level as division_level,
                       c.abbreviation as conference_abbrev,
                       p.is_committed, p.committed_to,
                       0.0 as offensive_war, bs.plate_appearances,
                       bs.batting_avg, bs.on_base_pct, bs.slugging_pct, NULL::numeric as woba, NULL::numeric as wrc_plus,
                       0.0 as pitching_war, 0.0 as innings_pitched,
                       NULL as era, NULL as whip, NULL as fip, NULL as fip_plus, NULL as era_minus, NULL as k_per_9,
                       NULL as wins, NULL as losses, 0 as strikeouts_p, 0 as walks_p,
                       0 as is_qualified_batting
                FROM conf_bat bs
                JOIN players p ON bs.player_id = p.id
                JOIN teams t ON bs.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                WHERE bs.plate_appearances >= %s
            """
            params_b: list = [season, season, min_pa]  # two season params for two CTEs, then min_pa

            pitching_query = f"""
                SELECT p.id as player_id, p.first_name, p.last_name, p.position,
                       p.year_in_school, t.id as team_id, t.name as team_name, t.short_name as team_short, t.logo_url,
                       d.name as division_name, d.level as division_level,
                       c.abbreviation as conference_abbrev,
                       p.is_committed, p.committed_to,
                       0.0 as offensive_war, 0 as plate_appearances,
                       NULL as batting_avg, NULL as on_base_pct, NULL as slugging_pct,
                       NULL::numeric as woba, NULL::numeric as wrc_plus,
                       0.0 as pitching_war, ps.innings_pitched,
                       ps.era, ps.whip, NULL as fip, NULL as fip_plus, NULL as era_minus, ps.k_per_9,
                       ps.wins, ps.losses, ps.strikeouts as strikeouts_p, ps.walks as walks_p,
                       0 as is_qualified_batting
                FROM conf_pit ps
                JOIN players p ON ps.player_id = p.id
                JOIN teams t ON ps.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                WHERE ps.innings_pitched >= %s
            """
            params_p: list = [min_ip]
        else:
            cte_prefix = ""
            qb_where = QUALIFIED_BATTING_WHERE if qualified else ""
            qp_where = QUALIFIED_PITCHING_WHERE if qualified else ""
            batting_query = f"""
                SELECT p.id as player_id, p.first_name, p.last_name, p.position,
                       p.year_in_school, t.id as team_id, t.name as team_name, t.short_name as team_short, t.logo_url,
                       d.name as division_name, d.level as division_level,
                       c.abbreviation as conference_abbrev,
                       p.is_committed, p.committed_to,
                       bs.offensive_war, bs.plate_appearances,
                       bs.batting_avg, bs.on_base_pct, bs.slugging_pct, bs.woba, bs.wrc_plus,
                       0.0 as pitching_war, 0.0 as innings_pitched,
                       NULL as era, NULL as whip, NULL as fip, NULL as fip_plus, NULL as era_minus, NULL as k_per_9,
                       NULL as wins, NULL as losses, 0 as strikeouts_p, 0 as walks_p,
                       CASE WHEN bs.plate_appearances >= {QUALIFIED_PA_PER_GAME} * (COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0))
                            THEN 1 ELSE 0 END as is_qualified_batting
                FROM batting_stats bs
                JOIN players p ON bs.player_id = p.id
                JOIN teams t ON bs.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                {QUALIFIED_BATTING_JOIN}
                WHERE bs.season = %s AND bs.plate_appearances >= %s
                {qb_where}
            """
            params_b: list = [season, min_pa]

            pitching_query = f"""
                SELECT p.id as player_id, p.first_name, p.last_name, p.position,
                       p.year_in_school, t.id as team_id, t.name as team_name, t.short_name as team_short, t.logo_url,
                       d.name as division_name, d.level as division_level,
                       c.abbreviation as conference_abbrev,
                       p.is_committed, p.committed_to,
                       0.0 as offensive_war, 0 as plate_appearances,
                       NULL as batting_avg, NULL as on_base_pct, NULL as slugging_pct,
                       NULL as woba, NULL as wrc_plus,
                       ps.pitching_war, ps.innings_pitched,
                       ps.era, ps.whip, ps.fip, ps.fip_plus, ps.era_minus, ps.k_per_9,
                       ps.wins, ps.losses, ps.strikeouts as strikeouts_p, ps.walks as walks_p,
                       0 as is_qualified_batting
                FROM pitching_stats ps
                JOIN players p ON ps.player_id = p.id
                JOIN teams t ON ps.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                {QUALIFIED_PITCHING_JOIN}
                WHERE ps.season = %s AND ps.innings_pitched >= %s
                {qp_where}
            """
            params_p: list = [season, min_ip]

        if division_id:
            batting_query += " AND c.division_id = %s"
            params_b.append(division_id)
        if conference_id:
            batting_query += " AND t.conference_id = %s"
            params_b.append(conference_id)
        if position_group:
            pg = position_group.upper()
            pos_groups = {
                "IF": ("IF", "SS", "2B", "3B", "1B"),
                "OF": ("OF", "CF", "LF", "RF"),
                "C": ("C",),
                "P": ("P",),
                "UT": ("UT", "DH"),
            }
            positions = pos_groups.get(pg, (pg,))
            placeholders_pg = ",".join(["%s"] * len(positions))
            batting_query += f" AND p.position IN ({placeholders_pg})"
            params_b.extend(positions)

        if division_id:
            pitching_query += " AND c.division_id = %s"
            params_p.append(division_id)
        if conference_id:
            pitching_query += " AND t.conference_id = %s"
            params_p.append(conference_id)
        if position_group:
            pg = position_group.upper()
            positions = pos_groups.get(pg, (pg,))
            placeholders_pg = ",".join(["%s"] * len(positions))
            pitching_query += f" AND p.position IN ({placeholders_pg})"
            params_p.extend(positions)

        # Combine using UNION and group by player to sum two-way WAR
        combined_query = f"""{cte_prefix}
            SELECT player_id, first_name, last_name, position, year_in_school,
                   team_id, team_name, team_short, logo_url, division_name, division_level, conference_abbrev,
                   MAX(is_committed) as is_committed,
                   MAX(committed_to) as committed_to,
                   SUM(offensive_war) as offensive_war,
                   SUM(pitching_war) as pitching_war,
                   SUM(offensive_war) + SUM(pitching_war) as total_war,
                   MAX(plate_appearances) as plate_appearances,
                   MAX(innings_pitched) as innings_pitched,
                   MAX(batting_avg) as batting_avg,
                   MAX(woba) as woba, MAX(wrc_plus) as wrc_plus,
                   MAX(era) as era, MAX(whip) as whip, MAX(fip) as fip,
                   MAX(fip_plus) as fip_plus, MAX(era_minus) as era_minus,
                   MAX(k_per_9) as k_per_9,
                   MAX(wins) as wins, MAX(losses) as losses,
                   MAX(strikeouts_p) as strikeouts_p, MAX(walks_p) as walks_p,
                   CASE WHEN MAX(plate_appearances) > 0
                        THEN ROUND((SUM(offensive_war) / MAX(plate_appearances))::numeric, 4)
                        ELSE NULL END as war_per_pa,
                   CASE WHEN MAX(innings_pitched) > 0
                        THEN ROUND((SUM(pitching_war) / MAX(innings_pitched))::numeric, 4)
                        ELSE NULL END as war_per_ip,
                   CASE WHEN MAX(is_qualified_batting) = 1 THEN true ELSE false END as is_qualified
            FROM (
                {batting_query}
                UNION ALL
                {pitching_query}
            ) AS combined_stats
            GROUP BY player_id, first_name, last_name, position, year_in_school,
                     team_id, team_name, team_short, logo_url, division_name, division_level, conference_abbrev
            ORDER BY {sort_by} {sort_direction} NULLS LAST
            LIMIT %s OFFSET %s
        """
        params_combined = params_b + params_p + [limit, offset]

        cur.execute(combined_query, params_combined)
        rows = cur.fetchall()
        return {
            "data": [_add_era_plus(dict(r)) for r in rows],
            "season": season,
            "limit": limit,
            "offset": offset,
        }


# ============================================================
# PERCENTILES (Baseball Savant-style)
# ============================================================

def _compute_percentile(value, sorted_values, higher_is_better):
    """
    Return a 0-100 percentile for ``value`` within ``sorted_values``
    (ascending). 0 = worst qualified player at this stat, 100 = best.

    Ties use the midpoint of the tied rank range.
    """
    if value is None or not sorted_values:
        return None
    n = len(sorted_values)
    if n <= 1:
        return 100
    lo = bisect_left(sorted_values, value)
    hi = bisect_right(sorted_values, value)
    mid_rank = (lo + hi - 1) / 2.0          # 0-indexed rank within sorted list
    low_to_high = mid_rank / (n - 1)        # 0 = lowest value, 1 = highest value
    pct_best = low_to_high if higher_is_better else (1 - low_to_high)
    return int(round(pct_best * 100))


# Stat definitions: (response_key, display_label, raw_field, higher_is_better)
HITTER_PERCENTILE_STATS = [
    ("war",      "WAR",     "war",        True),
    ("woba",     "wOBA",    "woba",       True),
    ("wobacon",  "wOBACON", "wobacon",    True),
    ("wrc_plus", "wRC+",    "wrc_plus",   True),
    ("iso",      "ISO",     "iso",        True),
    ("bb_pct",   "BB%",     "bb_pct",     True),
    ("k_pct",    "K%",      "k_pct",      False),   # lower = better
    ("hr_per_pa","HR/PA",   "hr_per_pa",  True),
    ("sb_per_pa","SB/PA",   "sb_per_pa",  True),
]

PITCHER_PERCENTILE_STATS = [
    ("war",       "WAR",    "war",        True),
    ("fip",       "FIP",    "fip",        False),   # lower = better
    ("xfip",      "xFIP",   "xfip",       False),
    ("siera",     "SIERA",  "siera",      False),
    ("k_bb_pct",  "K-BB%",  "k_bb_pct",   True),
    ("hr_per_pa", "HR/PA",  "hr_per_pa",  False),
    ("baa",       "BAA",    "baa",        False),   # lower = better
]


@router.get("/leaderboards/percentiles")
@cached_endpoint(ttl_seconds=1800)
def percentile_leaderboard(
    season: int = Query(..., description="Season year"),
    level: str = Query("D1", description="Division level: D1, D2, D3, NAIA, JUCO"),
    type: str = Query("hitter", description="Either 'hitter' or 'pitcher'"),
):
    """
    Baseball Savant-style percentile rankings.

    For every qualified player at the given division ``level``, return a
    0-100 percentile rank for each scoreboard stat, plus an ``avg_pct``
    field that averages all of that player's non-null percentiles
    (a rough "well-roundedness" score).

    Qualification thresholds match the leaderboards:
      - hitters: 2.0 PA per team game
      - pitchers: 0.75 IP per team game

    Benchmarks (the sorted list each player is ranked against) are built
    **only from qualified players at that level**, so a reliever with 2
    IP and a 0.00 ERA never distorts the percentile scale.
    """
    level = (level or "D1").upper().strip()
    ptype = (type or "hitter").lower().strip()
    if ptype not in ("hitter", "pitcher"):
        ptype = "hitter"

    with get_connection() as conn:
        cur = conn.cursor()

        if ptype == "hitter":
            cur.execute(
                f"""
                SELECT bs.player_id,
                       bs.team_id,
                       p.first_name, p.last_name, p.position, p.year_in_school,
                       p.bats, p.throws, p.is_committed, p.committed_to,
                       t.name as team_name, t.short_name as team_short, t.logo_url,
                       c.abbreviation as conference_abbrev,
                       d.level as division_level,
                       bs.plate_appearances,
                       COALESCE(bs.offensive_war, 0)::float as war,
                       bs.woba::float as woba,
                       bs.wobacon::float as wobacon,
                       bs.wrc_plus::float as wrc_plus,
                       bs.iso::float as iso,
                       bs.bb_pct::float as bb_pct,
                       bs.k_pct::float as k_pct,
                       CASE WHEN bs.plate_appearances > 0
                            THEN (bs.home_runs::numeric / bs.plate_appearances)::float
                            END as hr_per_pa,
                       CASE WHEN bs.plate_appearances > 0
                            THEN (bs.stolen_bases::numeric / bs.plate_appearances)::float
                            END as sb_per_pa
                FROM batting_stats bs
                JOIN players p ON bs.player_id = p.id
                JOIN teams t ON bs.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                LEFT JOIN team_season_stats tss
                    ON tss.team_id = bs.team_id AND tss.season = bs.season
                WHERE bs.season = %s
                  AND d.level = %s
                  AND bs.plate_appearances >= {QUALIFIED_PA_PER_GAME}
                        * (COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0))
                """,
                (season, level),
            )
            stat_defs = HITTER_PERCENTILE_STATS
        else:
            cur.execute(
                f"""
                SELECT ps.player_id,
                       ps.team_id,
                       p.first_name, p.last_name, p.position, p.year_in_school,
                       p.bats, p.throws, p.is_committed, p.committed_to,
                       t.name as team_name, t.short_name as team_short, t.logo_url,
                       c.abbreviation as conference_abbrev,
                       d.level as division_level,
                       ps.innings_pitched,
                       COALESCE(ps.pitching_war, 0)::float as war,
                       ps.fip::float as fip,
                       ps.xfip::float as xfip,
                       ps.siera::float as siera,
                       (COALESCE(ps.k_pct, 0) - COALESCE(ps.bb_pct, 0))::float as k_bb_pct,
                       CASE WHEN ps.batters_faced > 0
                            THEN (ps.home_runs_allowed::numeric / ps.batters_faced)::float
                            END as hr_per_pa,
                       CASE WHEN (COALESCE(ps.batters_faced,0) - COALESCE(ps.walks,0) - COALESCE(ps.hit_batters,0)) > 0
                            THEN (COALESCE(ps.hits_allowed,0)::numeric
                                  / (COALESCE(ps.batters_faced,0) - COALESCE(ps.walks,0) - COALESCE(ps.hit_batters,0)))::float
                            END as baa
                FROM pitching_stats ps
                JOIN players p ON ps.player_id = p.id
                JOIN teams t ON ps.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                LEFT JOIN team_season_stats tss
                    ON tss.team_id = ps.team_id AND tss.season = ps.season
                WHERE ps.season = %s
                  AND d.level = %s
                  AND ps.innings_pitched >= {QUALIFIED_IP_PER_GAME}
                        * (COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0))
                """,
                (season, level),
            )
            stat_defs = PITCHER_PERCENTILE_STATS

        players = [dict(r) for r in cur.fetchall()]

    # Build sorted benchmark arrays from qualified players only (nulls dropped)
    benchmarks = {}
    for key, _label, field, _hib in stat_defs:
        vals = [p[field] for p in players if p.get(field) is not None]
        vals.sort()
        benchmarks[key] = vals

    # Compute percentiles per player and the average
    results = []
    for p in players:
        pcts = {}
        pct_values = []
        for key, _label, field, hib in stat_defs:
            pct = _compute_percentile(p.get(field), benchmarks[key], hib)
            pcts[key] = pct
            if pct is not None:
                pct_values.append(pct)
        avg_pct = int(round(sum(pct_values) / len(pct_values))) if pct_values else None

        results.append({
            "player_id": p["player_id"],
            "team_id": p["team_id"],
            "first_name": p["first_name"],
            "last_name": p["last_name"],
            "position": p["position"],
            "year_in_school": p["year_in_school"],
            "bats": p.get("bats"),
            "throws": p.get("throws"),
            "is_committed": p.get("is_committed"),
            "committed_to": p.get("committed_to"),
            "team_name": p["team_name"],
            "team_short": p["team_short"],
            "logo_url": p["logo_url"],
            "conference_abbrev": p["conference_abbrev"],
            "division_level": p["division_level"],
            "plate_appearances": p.get("plate_appearances"),
            "innings_pitched": p.get("innings_pitched"),
            "avg_pct": avg_pct,
            "stats": {key: p.get(field) for key, _l, field, _h in stat_defs},
            "percentiles": pcts,
        })

    # Sort by average percentile descending (well-roundedness), nulls last
    results.sort(key=lambda r: (r["avg_pct"] is None, -(r["avg_pct"] or 0)))

    return {
        "season": season,
        "level": level,
        "type": ptype,
        "qualified_count": len(results),
        "stat_order": [
            {"key": key, "label": label, "higher_is_better": hib}
            for key, label, _f, hib in stat_defs
        ],
        "data": results,
    }


# ============================================================
# TEAM LEADERBOARD
# ============================================================

@router.get("/leaderboards/teams")
@cached_endpoint(ttl_seconds=21600)  # all-teams fan-out (get_team_aggregates per team);
                                     # team aggregates change only on the daily scrape.
def team_leaderboard(
    season: int = Query(..., description="Season year"),
    sort_by: str = Query("total_hr", description="Stat to rank by"),
    sort_dir: str = Query("desc", description="asc or desc"),
    division_id: Optional[int] = Query(None),
    limit: int = Query(10),
):
    """
    Rank teams by any aggregate stat.  Returns team info + all computed
    batting / pitching aggregates so the frontend can pick extra columns.
    """
    # ── allowed stats (same set as /teams/scatter) ──
    LOWER_IS_BETTER = {"team_era", "team_whip", "avg_fip", "avg_xfip",
                        "avg_era_minus", "avg_k_pct_bat", "pitching_bb_pct"}

    all_allowed = {
        # batting
        "team_avg", "team_obp", "team_slg", "team_ops",
        "total_hr", "total_sb", "total_runs", "total_rbi", "total_hits",
        "avg_woba", "avg_wrc_plus", "avg_iso", "total_owar",
        "avg_bb_pct", "avg_k_pct",
        # pitching
        "team_era", "team_whip", "avg_fip", "avg_fip_plus", "avg_era_plus",
        "avg_xfip", "total_k", "total_pwar", "pitching_k_pct",
        "pitching_bb_pct", "total_ip",
        # combined
        "total_war",
    }

    if sort_by not in all_allowed:
        sort_by = "total_hr"
    if sort_dir not in ("asc", "desc"):
        sort_dir = "desc"

    with get_connection() as conn:
        cur = conn.cursor()

        # ── fetch active teams (optionally filtered by division) ──
        q = """SELECT t.id, t.name, t.short_name, t.logo_url, t.city, t.state,
                      c.abbreviation as conference_abbrev,
                      d.level as division_level, d.id as division_id
               FROM teams t
               JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id
               WHERE t.is_active = 1"""
        params = []
        if division_id:
            q += " AND c.division_id = %s"
            params.append(division_id)
        q += " ORDER BY t.name"
        cur.execute(q, params)
        teams = cur.fetchall()

        results = []
        for team in teams:
            tid = team["id"]

            # ── batting aggregates ──
            cur.execute("""
                SELECT COUNT(*) as n,
                       SUM(plate_appearances) as pa, SUM(at_bats) as ab,
                       SUM(hits) as h, SUM(doubles) as d2b, SUM(triples) as d3b,
                       SUM(home_runs) as hr, SUM(runs) as r, SUM(rbi) as rbi,
                       SUM(walks) as bb, SUM(strikeouts) as k,
                       SUM(stolen_bases) as sb, SUM(hit_by_pitch) as hbp,
                       -- Rate stats: PA-weighted w/ NULL guards; bb and k rates raw totals.
                       SUM(woba * plate_appearances) FILTER (WHERE woba IS NOT NULL)
                         / NULLIF(SUM(plate_appearances) FILTER (WHERE woba IS NOT NULL), 0) as avg_woba,
                       SUM(wrc_plus * plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL)
                         / NULLIF(SUM(plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL), 0) as avg_wrc_plus,
                       SUM(iso * plate_appearances) FILTER (WHERE iso IS NOT NULL)
                         / NULLIF(SUM(plate_appearances) FILTER (WHERE iso IS NOT NULL), 0) as avg_iso,
                       SUM(walks)::numeric / NULLIF(SUM(plate_appearances), 0) as avg_bb_pct,
                       SUM(strikeouts)::numeric / NULLIF(SUM(plate_appearances), 0) as avg_k_pct,
                       SUM(offensive_war) as total_owar
                FROM batting_stats
                WHERE team_id = %s AND season = %s AND plate_appearances >= 10
            """, (tid, season))
            b = cur.fetchone()

            # ── pitching aggregates ──
            cur.execute("""
                SELECT COUNT(*) as n,
                       outs_to_ip(SUM(ip_outs(innings_pitched))) as ip, SUM(earned_runs) as er,
                       SUM(walks) as bb, SUM(hits_allowed) as h,
                       SUM(strikeouts) as k, SUM(home_runs_allowed) as hr,
                       SUM(batters_faced) as bf,
                       -- Rate stats: IP-weighted w/ NULL guards; k and bb rates raw totals.
                       SUM(fip * ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL)
                         / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE fip IS NOT NULL), 0) as avg_fip,
                       SUM(fip_plus * ip_outs(innings_pitched)) FILTER (WHERE fip_plus IS NOT NULL)
                         / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE fip_plus IS NOT NULL), 0) as avg_fip_plus,
                       SUM(era_minus * ip_outs(innings_pitched)) FILTER (WHERE era_minus IS NOT NULL)
                         / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE era_minus IS NOT NULL), 0) as avg_era_minus,
                       SUM(xfip * ip_outs(innings_pitched)) FILTER (WHERE xfip IS NOT NULL)
                         / NULLIF(SUM(ip_outs(innings_pitched)) FILTER (WHERE xfip IS NOT NULL), 0) as avg_xfip,
                       SUM(strikeouts)::numeric / NULLIF(SUM(batters_faced), 0) as avg_k_pct,
                       SUM(walks)::numeric / NULLIF(SUM(batters_faced), 0) as avg_bb_pct,
                       SUM(pitching_war) as total_pwar
                FROM pitching_stats
                WHERE team_id = %s AND season = %s AND innings_pitched >= 3
            """, (tid, season))
            p = cur.fetchone()

            if not b or (b["n"] or 0) == 0:
                continue

            # ── team record ──
            cur.execute(
                "SELECT wins, losses FROM team_season_stats WHERE team_id = %s AND season = %s",
                (tid, season),
            )
            rec = cur.fetchone()

            # ── compute all stats into a flat dict ──
            ab = b["ab"] or 0
            pa = b["pa"] or 0
            ip = (p["ip"] or 0) if p else 0

            # Canonical team aggregates: team_era/team_whip/team_avg/team_ops
            # come from here so the leaderboard matches the team page and
            # the school's site (correct baseball-notation IP, game_pitching ER).
            canonical = get_team_aggregates(cur, tid, season)

            row = {
                "team_id": tid,
                "name": team["name"],
                "short_name": team["short_name"],
                "logo_url": team["logo_url"],
                "city": team["city"],
                "state": team["state"],
                "conference_abbrev": team["conference_abbrev"],
                "division_level": team["division_level"],
                "division_id": team["division_id"],
                "wins": rec["wins"] if rec else 0,
                "losses": rec["losses"] if rec else 0,
                # batting (canonical for AVG/OBP/SLG/OPS)
                "team_avg": canonical.get("team_avg"),
                "team_obp": canonical.get("team_obp"),
                "team_slg": canonical.get("team_slg"),
                "team_ops": canonical.get("team_ops"),
                "total_hits": b["h"],
                "total_hr": b["hr"],
                "total_sb": b["sb"],
                "total_runs": b["r"],
                "total_rbi": b["rbi"],
                "avg_woba": round(float(b["avg_woba"]), 3) if b["avg_woba"] else None,
                "avg_wrc_plus": round(float(b["avg_wrc_plus"])) if b["avg_wrc_plus"] else None,
                "avg_iso": round(float(b["avg_iso"]), 3) if b["avg_iso"] else None,
                "avg_bb_pct": round(float(b["avg_bb_pct"]), 3) if b["avg_bb_pct"] else None,
                "avg_k_pct": round(float(b["avg_k_pct"]), 3) if b["avg_k_pct"] else None,
                "total_owar": round(float(b["total_owar"]), 1) if b["total_owar"] else 0,
                # pitching (canonical for ERA/WHIP)
                "team_era": canonical.get("team_era"),
                "team_whip": canonical.get("team_whip"),
                "avg_fip": round(float(p["avg_fip"]), 2) if p and p["avg_fip"] else None,
                "avg_fip_plus": round(float(p["avg_fip_plus"])) if p and p["avg_fip_plus"] else None,
                "avg_era_plus": round(10000.0 / float(p["avg_era_minus"])) if p and p["avg_era_minus"] and float(p["avg_era_minus"]) > 0 else None,
                "avg_xfip": round(float(p["avg_xfip"]), 2) if p and p["avg_xfip"] else None,
                "total_k": p["k"] if p else None,
                "total_pwar": round(float(p["total_pwar"]), 1) if p and p["total_pwar"] else 0,
                "pitching_k_pct": round(float(p["avg_k_pct"]), 3) if p and p["avg_k_pct"] else None,
                "pitching_bb_pct": round(float(p["avg_bb_pct"]), 3) if p and p["avg_bb_pct"] else None,
                "total_ip": round(float(p["ip"]), 1) if p and p["ip"] else None,
                # combined
                "total_war": round(float(b["total_owar"] or 0) + float(p["total_pwar"] or 0 if p else 0), 1),
            }

            results.append(row)

        # ── sort ──
        reverse = sort_dir == "desc"
        results.sort(key=lambda r: (r.get(sort_by) is not None, r.get(sort_by) or 0), reverse=reverse)

        return {
            "data": results[:limit],
            "total": len(results),
            "sort_by": sort_by,
            "sort_dir": sort_dir,
        }


# ============================================================
# QUICK SEARCH (players + teams)
# ============================================================

@router.get("/search")
@cached_endpoint(ttl_seconds=300)  # fires on every keystroke; leading-wildcard ILIKE is costly
def quick_search(q: str = Query(..., min_length=2), limit: int = Query(8)):
    """
    Combined search across players and teams for the header search bar.
    Returns up to `limit` results of each type.
    """
    with get_connection() as conn:
        cur = conn.cursor()
        search = f"%{q.strip()}%"

        # Search teams
        cur.execute("""
            SELECT t.id, t.name, t.short_name, t.logo_url, t.city, t.state,
                   d.level as division_level, c.abbreviation as conference_abbrev
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE t.is_active = 1
              AND (t.name ILIKE %s OR t.short_name ILIKE %s OR t.mascot ILIKE %s)
            ORDER BY t.short_name
            LIMIT %s
        """, (search, search, search, limit))
        teams = cur.fetchall()

        # Search players (exclude linked/non-canonical duplicates)
        cur.execute("""
            SELECT p.id, p.first_name, p.last_name, p.position, p.year_in_school,
                   t.short_name as team_short, t.logo_url, t.id as team_id,
                   d.level as division_level
            FROM players p
            JOIN teams t ON p.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN player_links pl ON p.id = pl.linked_id
            WHERE pl.linked_id IS NULL
              AND COALESCE(p.is_phantom, FALSE) = FALSE
              AND p.id IN (
                  -- OFFSET 0 optimizer fence: run the name match via the pg_trgm
                  -- GIN indexes first, instead of the outer ORDER BY tricking the
                  -- planner into a full name-index scan + filter. Same rows.
                  SELECT id FROM players
                  WHERE first_name ILIKE %s OR last_name ILIKE %s
                     OR (first_name || ' ' || last_name) ILIKE %s
                  OFFSET 0
              )
            ORDER BY p.last_name, p.first_name
            LIMIT %s
        """, (search, search, search, limit))
        players = cur.fetchall()

        # Summer-only players (no spring-school row in our DB) — e.g. a WCL
        # player whose college is back east. They live only in summer_players,
        # so the spring query above misses them. Surface them with their summer
        # team logo + a 'summer' kind so the frontend routes to /summer/players.
        cur.execute("""
            SELECT sp.id, sp.first_name, sp.last_name, sp.position, sp.year_in_school,
                   st.short_name AS team_short, st.logo_url, st.id AS team_id,
                   l.abbreviation AS division_level, 'summer' AS kind
            FROM summer_players sp
            JOIN summer_teams st ON sp.team_id = st.id
            JOIN summer_leagues l ON l.id = st.league_id
            LEFT JOIN summer_player_links spl ON spl.summer_player_id = sp.id
            WHERE spl.summer_player_id IS NULL
              AND sp.id IN (
                  -- OFFSET 0 fence → use the sp_*_trgm GIN indexes (see players above)
                  SELECT id FROM summer_players
                  WHERE first_name ILIKE %s OR last_name ILIKE %s
                     OR (first_name || ' ' || last_name) ILIKE %s
                  OFFSET 0
              )
            ORDER BY sp.last_name, sp.first_name
            LIMIT %s
        """, (search, search, search, limit))
        summer = cur.fetchall()

        return {
            "teams": [dict(r) for r in teams],
            "players": [dict(r) for r in players] + [dict(r) for r in summer],
        }


# ============================================================
# PLAYERS
# ============================================================

@router.get("/players/search")
@cached_endpoint(ttl_seconds=300)
def search_players(
    q: str = Query(..., min_length=2, description="Search by name"),
    division_id: Optional[int] = None,
    team_id: Optional[int] = None,
    position: Optional[str] = None,
    year_in_school: Optional[str] = None,
    uncommitted_only: bool = False,
    juco_only: bool = False,
    limit: int = Query(25),
):
    """
    Search players by name with optional filters.
    Particularly useful for finding uncommitted JUCO players.
    """
    with get_connection() as conn:
        cur = conn.cursor()
        query = """
            SELECT p.*, t.name as team_name, t.short_name as team_short, t.logo_url,
                   t.state as team_state,
                   c.abbreviation as conference_abbrev,
                   d.name as division_name, d.level as division_level
            FROM players p
            JOIN teams t ON p.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN player_links pl ON p.id = pl.linked_id
            WHERE pl.linked_id IS NULL
              AND COALESCE(p.is_phantom, FALSE) = FALSE
              AND (p.first_name ILIKE %s OR p.last_name ILIKE %s
                   OR (p.first_name || ' ' || p.last_name) ILIKE %s)
        """
        search = f"%{q.strip()}%"
        params: list = [search, search, search]

        if division_id:
            query += " AND c.division_id = %s"
            params.append(division_id)
        if team_id:
            query += " AND p.team_id = %s"
            params.append(team_id)
        if position:
            query += " AND p.position = %s"
            params.append(position)
        if year_in_school:
            query = _apply_year_filter(query, params, year_in_school)
        if uncommitted_only:
            query += " AND p.is_committed = 0"
        if juco_only:
            query += " AND d.level = 'JUCO'"

        query += " ORDER BY p.last_name, p.first_name LIMIT %s"
        params.append(limit)

        rows = cur.execute(query, params)
        rows = cur.fetchall()
        return [dict(r) for r in rows]


def _pct_from_deciles(value, deciles, higher_better=True):
    """Estimate percentile rank (1-99) from 9 decile thresholds.
    `deciles` should be a list of 9 numbers (10th, 20th, ..., 90th).
    Linear interpolation within each decile bucket.
    """
    if value is None or not deciles or len(deciles) < 9:
        return None
    pct = None
    for i, d in enumerate(deciles):
        if value <= d:
            if i == 0:
                pct = max(1.0, ((value / d) * 10.0)) if d > 0 else 5.0
            else:
                prev = deciles[i - 1]
                if d > prev:
                    frac = (value - prev) / (d - prev)
                else:
                    frac = 0.5
                pct = (i * 10) + (frac * 10)
            break
    if pct is None:
        # Above 90th percentile
        last = deciles[-1]
        prev = deciles[-2] if len(deciles) >= 2 else last
        if last > prev:
            frac = min(1.0, (value - last) / max(last - prev, 1e-9))
        else:
            frac = 0.5
        pct = 90 + frac * 10
    pct = round(pct)
    if not higher_better:
        pct = 100 - pct
    return max(1, min(99, pct))


# WPA decile cache. Keyed by (season, division_level, side='batter'|'pitcher').
# Each entry is the 9 decile thresholds for total WPA among qualified
# players in that division. 6-hour TTL matches the pitch-level baseline
# cache. Cleared whenever scrape_pbp / compute_wpa runs (next page load
# rebuilds it).
_WPA_DECILES_CACHE = {}
_WPA_DECILES_TTL = 6 * 3600


def _get_wpa_deciles(cur, season: int, division_level: str, side: str):
    """Return 9 decile thresholds (10th-90th) for total WPA among
    qualified players in this division/season. Used by percentile bars.

    side: 'batter' or 'pitcher'.
    Qualification: 50+ PAs (batter) or 50+ batters faced (pitcher) so
    bench bats / mop-up arms don't crowd the distribution near zero.
    """
    import time as _pl_time  # lazy: helper module split out June 2026
    key = (season, division_level, side)
    now = _pl_time.time()
    cached = _WPA_DECILES_CACHE.get(key)
    if cached and (now - cached["ts"]) < _WPA_DECILES_TTL:
        return cached["data"]

    if side == "batter":
        col = "wpa_batter"
        pid_col = "batter_player_id"
    else:
        col = "wpa_pitcher"
        pid_col = "pitcher_player_id"

    cur.execute(f"""
        WITH per_player AS (
            SELECT ge.{pid_col} AS pid,
                   SUM(ge.{col}) AS total_wpa,
                   COUNT(*)      AS n
            FROM game_events ge
            JOIN games g       ON g.id = ge.game_id
            JOIN players p     ON p.id = ge.{pid_col}
            JOIN teams t       ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d   ON d.id = c.division_id
            WHERE g.season = %s AND d.level = %s
              AND ge.{pid_col} IS NOT NULL
              AND ge.{col}     IS NOT NULL
            GROUP BY ge.{pid_col}
            HAVING COUNT(*) >= 50
        )
        SELECT total_wpa FROM per_player ORDER BY total_wpa
    """, (season, division_level))
    values = [float(r["total_wpa"]) for r in cur.fetchall()
              if r["total_wpa"] is not None]
    if len(values) < 10:
        deciles = []
    else:
        deciles = [values[int(len(values) * i / 10)] for i in range(1, 10)]

    _WPA_DECILES_CACHE[key] = {"ts": now, "data": deciles}
    return deciles


def _compute_2026_pbp_batting_percentiles(conn, division_level, season, player_id, weights):
    """Compute percentiles for batter metrics that come from game_events
    (Contact%, AIRPULL%, WPA) — only available for 2026+ since they
    require the Phase A/E + D.5 enrichment.
    """
    from psycopg2.extras import RealDictCursor as _RDC
    cur = conn.cursor(cursor_factory=_RDC)

    cur.execute("""
        SELECT
          COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))), 0) AS f_k,
          COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS f_f,
          COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS f_in_play,
          COUNT(*) FILTER (WHERE bb_type IS NOT NULL) AS bb_total,
          COUNT(*) FILTER (WHERE bb_type = 'FB') AS fb_n,
          COUNT(*) FILTER (
            WHERE bb_type IN ('LD','FB')
              AND ((UPPER(p.bats) = 'R' AND field_zone = 'LEFT')
                OR (UPPER(p.bats) = 'L' AND field_zone = 'RIGHT'))
          ) AS air_pull,
          -- 2-strike contact: swings + contact within 2-strike PAs only.
          COALESCE(SUM(CASE WHEN strikes_before = 2 THEN LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', '')) ELSE 0 END), 0) AS ts_f_k,
          COALESCE(SUM(CASE WHEN strikes_before = 2 THEN LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', '')) ELSE 0 END), 0) AS ts_f_f,
          COUNT(*) FILTER (WHERE strikes_before = 2 AND was_in_play AND pitches_thrown IS NOT NULL) AS ts_in_play,
          COUNT(*) AS pa
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        JOIN players p ON p.id = ge.batter_player_id
        WHERE ge.batter_player_id = %s AND g.season = %s
    """, (player_id, season))
    r = cur.fetchone() or {}
    swings = (r.get("f_k") or 0) + (r.get("f_f") or 0) + (r.get("f_in_play") or 0)
    contact = (r.get("f_f") or 0) + (r.get("f_in_play") or 0)
    bb_total = r.get("bb_total") or 0
    contact_pct = (contact / swings) if swings > 0 else None
    air_pull_pct = (r.get("air_pull", 0) / bb_total) if bb_total > 0 else None
    fb_pct = ((r.get("fb_n") or 0) / bb_total) if bb_total > 0 else None
    ts_swings = (r.get("ts_f_k") or 0) + (r.get("ts_f_f") or 0) + (r.get("ts_in_play") or 0)
    ts_contact = (r.get("ts_f_f") or 0) + (r.get("ts_in_play") or 0)
    two_strike_contact_pct = (ts_contact / ts_swings) if ts_swings > 0 else None

    from .pitch_level import _get_pitch_level_baselines  # lazy: avoids circular import
    baselines = _get_pitch_level_baselines(cur, season, division_level, weights)
    overall = baselines.get("overall") or {}
    deciles = overall.get("deciles") or {}
    two_strike_deciles = (baselines.get("two_strike") or {}).get("deciles") or {}

    out = {}
    if contact_pct is not None:
        p = _pct_from_deciles(contact_pct, deciles.get("contact_pct"), higher_better=True)
        if p is not None:
            out["contact_pct"] = {"value": contact_pct, "percentile": p}
    if air_pull_pct is not None:
        p = _pct_from_deciles(air_pull_pct, deciles.get("air_pull_pct"), higher_better=True)
        if p is not None:
            out["air_pull_pct"] = {"value": air_pull_pct, "percentile": p}
    if fb_pct is not None:
        p = _pct_from_deciles(fb_pct, deciles.get("fb_pct"), higher_better=True)
        if p is not None:
            out["fb_pct"] = {"value": fb_pct, "percentile": p}
    if two_strike_contact_pct is not None:
        p = _pct_from_deciles(two_strike_contact_pct, two_strike_deciles.get("contact_pct"), higher_better=True)
        if p is not None:
            out["two_strike_contact_pct"] = {"value": two_strike_contact_pct, "percentile": p}

    # WPA — total Win Probability Added across the season. Phase D.5.
    cur.execute("""
        SELECT SUM(wpa_batter) AS total_wpa, COUNT(*) AS n
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        WHERE ge.batter_player_id = %s AND g.season = %s
          AND ge.wpa_batter IS NOT NULL
    """, (player_id, season))
    wr = cur.fetchone() or {}
    total_wpa = wr.get("total_wpa")
    if total_wpa is not None and (wr.get("n") or 0) >= 1:
        wpa_deciles = _get_wpa_deciles(cur, season, division_level, "batter")
        if wpa_deciles:
            p = _pct_from_deciles(float(total_wpa), wpa_deciles, higher_better=True)
            if p is not None:
                out["wpa"] = {"value": float(total_wpa), "percentile": p}
    return out


def _compute_2026_pbp_pitching_percentiles(conn, division_level, season, player_id, weights):
    """Pitcher metrics from game_events: Strike%, FPS%, Whiff%, opp wOBA,
    Opp AIRPULL%, HR/PA.
    """
    from psycopg2.extras import RealDictCursor as _RDC
    cur = conn.cursor(cursor_factory=_RDC)

    cur.execute("""
        SELECT
          COUNT(*) AS pa,
          -- pitches_thrown >= 1 (not just IS NOT NULL): excludes "(0-0)"
          -- untracked PAs that the parser stamps with pitches_thrown=0.
          -- Those rows can never satisfy the FPS numerator, so leaving
          -- them in tracked_pa silently deflates first-pitch-strike rate.
          COUNT(*) FILTER (WHERE pitches_thrown >= 1) AS tracked_pa,
          COALESCE(SUM(pitches_thrown), 0) AS pitches,
          COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))), 0) AS pK,
          COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'S', ''))), 0) AS pS,
          COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS pF,
          COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS p_inplay,
          COUNT(*) FILTER (
              WHERE pitches_thrown >= 1 AND
                    (LEFT(pitch_sequence, 1) IN ('K', 'S', 'F')
                     OR (pitch_sequence = '' AND was_in_play))
          ) AS f1_strikes,
          COUNT(*) FILTER (WHERE result_type = 'home_run') AS hr,
          SUM(CASE WHEN result_type IN ('walk','intentional_walk','hbp','sac_bunt') THEN 0 ELSE 1 END) AS ab,
          SUM(CASE WHEN result_type IN ('single','double','triple','home_run') THEN 1 ELSE 0 END) AS h,
          SUM(CASE WHEN result_type = 'double' THEN 1 ELSE 0 END) AS d,
          SUM(CASE WHEN result_type = 'triple' THEN 1 ELSE 0 END) AS t,
          SUM(CASE WHEN result_type = 'walk' THEN 1 ELSE 0 END) AS ubb,
          SUM(CASE WHEN result_type IN ('walk','intentional_walk') THEN 1 ELSE 0 END) AS bb,
          SUM(CASE WHEN result_type = 'hbp' THEN 1 ELSE 0 END) AS hbp,
          SUM(CASE WHEN result_type = 'sac_fly' THEN 1 ELSE 0 END) AS sf,
          COUNT(*) FILTER (WHERE bb_type IS NOT NULL) AS bb_total,
          COUNT(*) FILTER (
            WHERE bb_type IN ('LD','FB')
              AND ((UPPER(b.bats) = 'R' AND field_zone = 'LEFT')
                OR (UPPER(b.bats) = 'L' AND field_zone = 'RIGHT'))
          ) AS opp_air_pull
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        LEFT JOIN players b ON b.id = ge.batter_player_id
        WHERE ge.pitcher_player_id = %s AND g.season = %s
    """, (player_id, season))
    r = cur.fetchone() or {}
    pa = r.get("pa") or 0
    tracked = r.get("tracked_pa") or 0
    pitches = r.get("pitches") or 0
    pK = r.get("pk") or 0
    pS = r.get("ps") or 0
    pF = r.get("pf") or 0
    in_play = r.get("p_inplay") or 0
    swings = pS + pF + in_play
    strikes = pK + pS + pF + in_play
    bb_total = r.get("bb_total") or 0

    strike_pct = (strikes / pitches) if pitches > 0 else None
    whiff_pct = (pS / swings) if swings > 0 else None
    fps_pct = ((r.get("f1_strikes") or 0) / tracked) if tracked > 0 else None
    hr_pa_pct = ((r.get("hr") or 0) / pa) if pa > 0 else None
    opp_air_pull_pct = ((r.get("opp_air_pull") or 0) / bb_total) if bb_total > 0 else None

    ab = r.get("ab") or 0
    h = r.get("h") or 0
    d_ = r.get("d") or 0
    tr = r.get("t") or 0
    hr = r.get("hr") or 0
    ubb = r.get("ubb") or 0
    hbp = r.get("hbp") or 0
    sf = r.get("sf") or 0
    singles = h - d_ - tr - hr
    woba_num = (weights.w_bb * ubb + weights.w_hbp * hbp +
                weights.w_1b * singles + weights.w_2b * d_ +
                weights.w_3b * tr + weights.w_hr * hr)
    woba_denom = ab + ubb + sf + hbp
    opp_woba = (woba_num / woba_denom) if woba_denom > 0 else None

    from .pitch_level import _get_pitcher_pitch_level_baselines  # lazy: avoids circular import
    baselines = _get_pitcher_pitch_level_baselines(cur, season, division_level, weights)
    overall = baselines.get("overall") or {}
    deciles = overall.get("deciles") or {}

    out = {}
    def add(key, value, hb):
        if value is None: return
        p = _pct_from_deciles(value, deciles.get(key), higher_better=hb)
        if p is not None:
            out[key] = {"value": value, "percentile": p}

    add("strike_pct", strike_pct, True)
    add("whiff_pct",  whiff_pct,  True)
    add("first_pitch_strike_pct", fps_pct, True)
    add("opp_woba",   opp_woba,   False)   # low is good for pitcher
    add("opp_air_pull_pct", opp_air_pull_pct, False)
    add("hr_pa_pct",  hr_pa_pct,  False)   # low is good for pitcher

    # WPA — total Win Probability Added across the season. Phase D.5.
    cur.execute("""
        SELECT SUM(wpa_pitcher) AS total_wpa, COUNT(*) AS n
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        WHERE ge.pitcher_player_id = %s AND g.season = %s
          AND ge.wpa_pitcher IS NOT NULL
    """, (player_id, season))
    wr = cur.fetchone() or {}
    total_wpa = wr.get("total_wpa")
    if total_wpa is not None and (wr.get("n") or 0) >= 1:
        wpa_deciles = _get_wpa_deciles(cur, season, division_level, "pitcher")
        if wpa_deciles:
            p = _pct_from_deciles(float(total_wpa), wpa_deciles, higher_better=True)
            if p is not None:
                out["wpa"] = {"value": float(total_wpa), "percentile": p}
    return out


def _league_rate_avgs(conn, division_level: str, season):
    """Average rate stats across the qualified division pool (batters
    PA>=10, pitchers IP>=20) for a season. Powers the reference lines on
    the rolling wOBA / FIP charts so they reflect the real league average
    for the player's division, not a hardcoded guess. Matches the same
    qualified pool used for the savant percentiles."""
    out = {"woba": None, "era": None, "fip": None}
    if not division_level or not season:
        return out
    # innings_pitched is baseball notation (6.2 = 6 and 2/3); convert to
    # true innings for run-environment weighting.
    true_ip = "(FLOOR(ps.innings_pitched) + (ps.innings_pitched - FLOOR(ps.innings_pitched)) * (10.0/3.0))"
    try:
        cur = conn.cursor()
        # PA-weighted league wOBA (the offensive run environment).
        cur.execute(
            """
            SELECT SUM(bs.woba * bs.plate_appearances) / NULLIF(SUM(bs.plate_appearances), 0) AS woba
            FROM batting_stats bs
            JOIN players p ON bs.player_id = p.id
            JOIN teams t ON bs.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE d.level = %s AND bs.season = %s
              AND bs.plate_appearances >= 1 AND bs.woba IS NOT NULL
            """,
            (division_level, season),
        )
        r = cur.fetchone()
        if r and r["woba"] is not None:
            out["woba"] = round(float(r["woba"]), 3)
        # True league ERA (total ER*9 / total IP) and IP-weighted league FIP.
        cur.execute(
            f"""
            SELECT
              SUM(ps.earned_runs) * 9.0 / NULLIF(SUM({true_ip}), 0) AS era,
              SUM(ps.fip * {true_ip}) FILTER (WHERE ps.fip IS NOT NULL)
                / NULLIF(SUM({true_ip}) FILTER (WHERE ps.fip IS NOT NULL), 0) AS fip
            FROM pitching_stats ps
            JOIN players p ON ps.player_id = p.id
            JOIN teams t ON ps.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE d.level = %s AND ps.season = %s AND ps.innings_pitched >= 1
            """,
            (division_level, season),
        )
        r = cur.fetchone()
        if r:
            if r["era"] is not None:
                out["era"] = round(float(r["era"]), 2)
            if r["fip"] is not None:
                out["fip"] = round(float(r["fip"]), 2)
    except Exception:
        pass
    return out


def _compute_percentiles(conn, division_level: str, season: int, player_stats: dict, stat_type: str):
    """
    Compute Baseball Savant-style percentiles for a player within their division.
    Player must have 10+ PA (batters) or 5+ IP (pitchers) to get percentiles.
    Comparison pool: 10+ PA for batters, 5+ IP for pitchers.
    Returns dict of { stat_key: { value, percentile } }.
    """
    # Player qualification thresholds — kept very low so small-sample
    # players still see their bars (the comparison pool below uses a
    # stricter qualified set, so percentile rank vs LEAGUE is still
    # apples-to-apples). The footer text on the bars card explains
    # qualified-pool minimums.
    if stat_type == "batting" and (player_stats.get("plate_appearances") or 0) < 1:
        return {}
    if stat_type == "pitching" and (player_stats.get("innings_pitched") or 0) < 1:
        return {}

    if stat_type == "batting":
        metrics = {
            "woba":          {"col": "bs.woba",          "higher_better": True},
            "wobacon":       {"col": "bs.wobacon",       "higher_better": True},
            "wrc_plus":      {"col": "bs.wrc_plus",      "higher_better": True},
            "iso":           {"col": "bs.iso",           "higher_better": True},
            "bb_pct":        {"col": "bs.bb_pct",        "higher_better": True},
            "k_pct":         {"col": "bs.k_pct",         "higher_better": False},
            "offensive_war":  {"col": "bs.offensive_war", "higher_better": True},
            "sb_per_pa":     {"col": "CASE WHEN bs.plate_appearances > 0 THEN bs.stolen_bases::float / bs.plate_appearances ELSE NULL END", "higher_better": True},
            "hr_pa_pct":     {"col": "CASE WHEN bs.plate_appearances > 0 THEN bs.home_runs::float / bs.plate_appearances ELSE NULL END", "higher_better": True},
        }
        base_query = """
            SELECT {col} as val
            FROM batting_stats bs
            JOIN players p ON bs.player_id = p.id
            JOIN teams t ON bs.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE d.level = %s AND bs.season = %s
              AND bs.plate_appearances >= 10
              AND {col} IS NOT NULL
            ORDER BY {col}
        """
    else:
        metrics = {
            "k_pct":         {"col": "ps.k_pct",         "higher_better": True},
            "bb_pct":        {"col": "ps.bb_pct",        "higher_better": False},
            "fip":           {"col": "ps.fip",           "higher_better": False},
            "xfip":          {"col": "ps.xfip",          "higher_better": False},
            "siera":         {"col": "ps.siera",         "higher_better": False},
            "lob_pct":       {"col": "ps.lob_pct",       "higher_better": True},
            "h_per_9":       {"col": "ps.h_per_9",       "higher_better": False},
            "hr_per_9":      {"col": "ps.hr_per_9",      "higher_better": False},
            "pitching_war":  {"col": "ps.pitching_war",  "higher_better": True},
            "k_bb_pct":      {"col": "COALESCE(ps.k_pct, 0) - COALESCE(ps.bb_pct, 0)", "higher_better": True},
            "baa":           {"col": "CASE WHEN (COALESCE(ps.batters_faced,0) - COALESCE(ps.walks,0) - COALESCE(ps.hit_batters,0)) > 0 "
                                      "THEN COALESCE(ps.hits_allowed,0)::numeric "
                                      "/ (COALESCE(ps.batters_faced,0) - COALESCE(ps.walks,0) - COALESCE(ps.hit_batters,0))::numeric END",
                              "higher_better": False},
        }
        base_query = """
            SELECT {col} as val
            FROM pitching_stats ps
            JOIN players p ON ps.player_id = p.id
            JOIN teams t ON ps.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE d.level = %s AND ps.season = %s
              AND ps.innings_pitched >= 20
              AND {col} IS NOT NULL
            ORDER BY {col}
        """

    result = {}
    cur = conn.cursor()
    for stat_key, meta in metrics.items():
        player_val = player_stats.get(stat_key)
        if stat_key == "k_bb_pct" and player_val is None:
            # Compute K-BB% from component stats
            k = player_stats.get("k_pct")
            bb = player_stats.get("bb_pct")
            if k is not None and bb is not None:
                player_val = k - bb
        if stat_key == "hr_pa_pct" and player_val is None:
            hr = player_stats.get("home_runs") or 0
            pa = player_stats.get("plate_appearances") or 0
            if pa > 0:
                player_val = hr / pa
        if stat_key == "sb_per_pa" and player_val is None:
            sb = player_stats.get("stolen_bases") or 0
            pa = player_stats.get("plate_appearances") or 0
            if pa > 0:
                player_val = sb / pa

        if player_val is None:
            continue

        q = base_query.format(col=meta["col"])
        cur.execute(q, (division_level, season))
        all_vals = [row["val"] for row in cur.fetchall()]

        if len(all_vals) < 5:
            continue

        # Count how many league values this player is better than
        count_below = sum(1 for v in all_vals if v < player_val)
        count_equal = sum(1 for v in all_vals if v == player_val)
        # Percentile rank using midpoint method
        pctile = round(((count_below + count_equal * 0.5) / len(all_vals)) * 100)

        # If lower is better (K% for batters, ERA-family for pitchers), invert
        if not meta["higher_better"]:
            pctile = 100 - pctile

        # Clamp to 1-99
        pctile = max(1, min(99, pctile))

        result[stat_key] = {"value": player_val, "percentile": pctile}

    return result


def _aggregate_career_batting(seasons):
    """Aggregate multiple batting seasons into a single career stat line."""
    totals = {}
    sum_keys = [
        "games", "plate_appearances", "at_bats", "runs", "hits",
        "doubles", "triples", "home_runs", "rbi", "walks", "strikeouts",
        "hit_by_pitch", "sacrifice_flies", "sacrifice_bunts", "stolen_bases",
        "caught_stealing", "grounded_into_dp",
    ]
    for k in sum_keys:
        totals[k] = sum(s.get(k, 0) or 0 for s in seasons)

    ab = totals["at_bats"]
    h = totals["hits"]
    bb = totals["walks"]
    hbp = totals["hit_by_pitch"]
    sf = totals["sacrifice_flies"]
    pa = totals["plate_appearances"]
    d2 = totals["doubles"]
    d3 = totals["triples"]
    hr = totals["home_runs"]

    totals["batting_avg"] = h / ab if ab > 0 else None
    totals["on_base_pct"] = (h + bb + hbp) / (ab + bb + hbp + sf) if (ab + bb + hbp + sf) > 0 else None
    tb = h + d2 + 2 * d3 + 3 * hr
    totals["slugging_pct"] = tb / ab if ab > 0 else None
    totals["ops"] = (totals["on_base_pct"] or 0) + (totals["slugging_pct"] or 0)
    totals["iso"] = (totals["slugging_pct"] or 0) - (totals["batting_avg"] or 0) if ab > 0 else None
    totals["bb_pct"] = bb / pa if pa > 0 else None
    totals["k_pct"] = totals["strikeouts"] / pa if pa > 0 else None
    totals["sb_per_pa"] = totals["stolen_bases"] / pa if pa > 0 else None
    totals["hr_pa_pct"] = hr / pa if pa > 0 else None
    totals["offensive_war"] = sum(s.get("offensive_war", 0) or 0 for s in seasons)

    # wOBA / wRC+ are complex league-adjusted - use PA-weighted average as approximation
    total_pa = sum((s.get("plate_appearances", 0) or 0) for s in seasons)
    if total_pa > 0:
        totals["woba"] = sum((s.get("woba", 0) or 0) * (s.get("plate_appearances", 0) or 0) for s in seasons) / total_pa
        totals["wrc_plus"] = sum((s.get("wrc_plus", 0) or 0) * (s.get("plate_appearances", 0) or 0) for s in seasons) / total_pa
    else:
        totals["woba"] = None
        totals["wrc_plus"] = None

    return totals


def _aggregate_career_pitching(seasons):
    """Aggregate multiple pitching seasons into a single career stat line."""
    totals = {}
    sum_keys = [
        "games", "games_started", "wins", "losses", "saves",
        "innings_pitched", "hits_allowed", "runs_allowed", "earned_runs",
        "walks", "strikeouts", "home_runs_allowed", "hit_batters",
        "wild_pitches", "batters_faced",
    ]
    for k in sum_keys:
        totals[k] = sum(s.get(k, 0) or 0 for s in seasons)

    ip = totals["innings_pitched"]
    er = totals["earned_runs"]
    bb = totals["walks"]
    h = totals["hits_allowed"]
    k = totals["strikeouts"]
    bf = totals["batters_faced"]

    totals["era"] = (er / ip) * 9 if ip > 0 else None
    totals["whip"] = (bb + h) / ip if ip > 0 else None
    totals["k_pct"] = k / bf if bf > 0 else None
    totals["bb_pct"] = bb / bf if bf > 0 else None
    totals["k_bb_pct"] = (totals["k_pct"] or 0) - (totals["bb_pct"] or 0)
    # BAA = H / (BF - BB - HBP)
    hbp = totals["hit_batters"]
    baa_denom = bf - bb - hbp
    totals["baa"] = h / baa_denom if baa_denom > 0 else None
    totals["pitching_war"] = sum(s.get("pitching_war", 0) or 0 for s in seasons)

    # IP-weighted averages for complex metrics
    total_ip = sum((s.get("innings_pitched", 0) or 0) for s in seasons)
    for metric in ["fip", "xfip", "siera"]:
        if total_ip > 0:
            totals[metric] = sum(
                (s.get(metric, 0) or 0) * (s.get("innings_pitched", 0) or 0) for s in seasons
            ) / total_ip
        else:
            totals[metric] = None

    # BF-weighted for rate stats
    total_bf = sum((s.get("batters_faced", 0) or 0) for s in seasons)
    if total_bf > 0:
        totals["lob_pct"] = sum(
            (s.get("lob_pct", 0) or 0) * (s.get("batters_faced", 0) or 0) for s in seasons
        ) / total_bf
    else:
        totals["lob_pct"] = None

    # FIP+ / ERA+ - IP-weighted
    for metric in ["fip_plus", "era_plus"]:
        if total_ip > 0:
            totals[metric] = sum(
                (s.get(metric, 0) or 0) * (s.get("innings_pitched", 0) or 0) for s in seasons
            ) / total_ip
        else:
            totals[metric] = None

    return totals


def _compute_career_percentiles(conn, division_level: str, career_stats: dict, stat_type: str):
    """
    Compute percentiles for career aggregates by comparing against all players'
    career aggregates within the same division who have 2+ seasons.
    """
    cur = conn.cursor()
    if stat_type == "batting":
        metrics = {
            "woba":          {"higher_better": True},
            "wrc_plus":      {"higher_better": True},
            "iso":           {"higher_better": True},
            "bb_pct":        {"higher_better": True},
            "k_pct":         {"higher_better": False},
            "offensive_war": {"higher_better": True},
            "sb_per_pa":     {"higher_better": True},
            "hr_pa_pct":     {"higher_better": True},
        }
        # Get all players in this division with 2+ batting seasons and 100+ career PA
        cur.execute(
            """SELECT bs.player_id,
                      SUM(bs.plate_appearances) as pa, SUM(bs.at_bats) as ab,
                      SUM(bs.hits) as h, SUM(bs.doubles) as d2, SUM(bs.triples) as d3,
                      SUM(bs.home_runs) as hr, SUM(bs.walks) as bb,
                      SUM(bs.hit_by_pitch) as hbp, SUM(bs.sacrifice_flies) as sf,
                      SUM(bs.strikeouts) as k, SUM(bs.stolen_bases) as sb,
                      SUM(bs.offensive_war) as offensive_war,
                      COUNT(DISTINCT bs.season) as num_seasons
               FROM batting_stats bs
               JOIN teams t ON bs.team_id = t.id
               JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id
               WHERE d.level = %s
               GROUP BY bs.player_id
               HAVING COUNT(DISTINCT bs.season) >= 2
                  AND SUM(bs.plate_appearances) >= 100""",
            (division_level,),
        )
        all_players = cur.fetchall()

        # Compute career stats for each player
        league_stats = []
        for p in all_players:
            pd = dict(p)
            ab, h, bb, hbp, sf = pd["ab"], pd["h"], pd["bb"], pd["hbp"], pd["sf"]
            pa, hr, d2, d3 = pd["pa"], pd["hr"], pd["d2"], pd["d3"]
            k, sb = pd["k"], pd["sb"]
            denom = ab + bb + hbp + sf
            obp = (h + bb + hbp) / denom if denom > 0 else 0
            slg = (h + d2 + 2*d3 + 3*hr) / ab if ab > 0 else 0
            avg = h / ab if ab > 0 else 0
            league_stats.append({
                "woba": None,  # Can't easily recompute wOBA from aggregates
                "wrc_plus": None,
                "iso": slg - avg if ab > 0 else None,
                "bb_pct": bb / pa if pa > 0 else None,
                "k_pct": k / pa if pa > 0 else None,
                "offensive_war": pd["offensive_war"],
                "sb_per_pa": sb / pa if pa > 0 else None,
                "hr_pa_pct": hr / pa if pa > 0 else None,
            })

    else:
        metrics = {
            "k_pct":         {"higher_better": True},
            "bb_pct":        {"higher_better": False},
            "fip":           {"higher_better": False},
            "xfip":          {"higher_better": False},
            "siera":         {"higher_better": False},
            "lob_pct":       {"higher_better": True},
            "h_per_9":       {"higher_better": False},
            "hr_per_9":      {"higher_better": False},
            "pitching_war":  {"higher_better": True},
            "k_bb_pct":      {"higher_better": True},
            "baa":           {"higher_better": False},
        }
        cur.execute(
            """SELECT ps.player_id,
                      outs_to_ip(SUM(ip_outs(ps.innings_pitched))) as ip,
                      (SUM(ip_outs(ps.innings_pitched)) / 3.0)::float8 as ip_true,
                      SUM(ps.earned_runs) as er,
                      SUM(ps.walks) as bb, SUM(ps.hits_allowed) as h,
                      SUM(ps.home_runs_allowed) as hra,
                      SUM(ps.hit_batters) as hbp,
                      SUM(ps.strikeouts) as k, SUM(ps.batters_faced) as bf,
                      SUM(ps.pitching_war) as pitching_war,
                      COUNT(DISTINCT ps.season) as num_seasons
               FROM pitching_stats ps
               JOIN teams t ON ps.team_id = t.id
               JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id
               WHERE d.level = %s
               GROUP BY ps.player_id
               HAVING COUNT(DISTINCT ps.season) >= 2
                  AND SUM(ip_outs(ps.innings_pitched)) / 3.0 >= 20""",
            (division_level,),
        )
        all_players = cur.fetchall()

        league_stats = []
        for p in all_players:
            pd = dict(p)
            ip, bb, k, bf = pd["ip_true"], pd["bb"], pd["k"], pd["bf"]
            h_a, hra, hbp = pd["h"], pd["hra"], pd["hbp"] or 0
            k_pct = k / bf if bf > 0 else None
            bb_pct = bb / bf if bf > 0 else None
            baa_denom = (bf or 0) - (bb or 0) - hbp
            league_stats.append({
                "k_pct": k_pct,
                "bb_pct": bb_pct,
                "fip": None,  # Complex to recompute from aggregates
                "xfip": None,
                "siera": None,
                "lob_pct": None,
                "h_per_9": (h_a / ip) * 9 if ip > 0 else None,
                "hr_per_9": (hra / ip) * 9 if ip > 0 else None,
                "pitching_war": pd["pitching_war"],
                "k_bb_pct": (k_pct or 0) - (bb_pct or 0),
                "baa": (h_a / baa_denom) if baa_denom > 0 else None,
            })

    result = {}
    for stat_key, meta in metrics.items():
        player_val = career_stats.get(stat_key)
        if player_val is None:
            continue

        # Collect league values for this stat
        league_vals = sorted([s[stat_key] for s in league_stats if s.get(stat_key) is not None])
        if len(league_vals) < 5:
            continue

        count_below = sum(1 for v in league_vals if v < player_val)
        count_equal = sum(1 for v in league_vals if v == player_val)
        pctile = round(((count_below + count_equal * 0.5) / len(league_vals)) * 100)

        if not meta["higher_better"]:
            pctile = 100 - pctile

        pctile = max(1, min(99, pctile))
        result[stat_key] = {"value": player_val, "percentile": pctile}

    return result


def _compute_player_awards(conn, player_id, team_id, batting_list, pitching_list,
                            all_player_ids=None):
    """
    Check each season to see if this player led their team in any category.
    all_player_ids: list of IDs that all belong to this person (for transfers).
    Returns a list of award dicts: {season, category, value, type}.
    """
    if all_player_ids is None:
        all_player_ids = [player_id]
    player_id_set = set(all_player_ids)

    cur = conn.cursor()
    # Look up team info for this team_id
    cur.execute(
        "SELECT short_name, logo_url FROM teams WHERE id = %s", (team_id,)
    )
    team_info = cur.fetchone()
    team_short = team_info["short_name"] if team_info else ""
    team_logo = team_info["logo_url"] if team_info else ""

    awards = []

    # Categories: (db_column, display_label, min_threshold, direction, stat_type)
    bat_categories = [
        ("batting_avg", "AVG", 50, "DESC", "batting"),
        ("home_runs", "HR", 1, "DESC", "batting"),
        ("rbi", "RBI", 1, "DESC", "batting"),
        ("hits", "H", 1, "DESC", "batting"),
        ("stolen_bases", "SB", 1, "DESC", "batting"),
        ("wrc_plus", "wRC+", 75, "DESC", "batting"),
        ("offensive_war", "oWAR", 50, "DESC", "batting"),
    ]
    pit_categories = [
        ("era", "ERA", 20, "ASC", "pitching"),
        ("strikeouts", "K", 10, "DESC", "pitching"),
        ("fip", "FIP", 20, "ASC", "pitching"),
        ("wins", "W", 1, "DESC", "pitching"),
        ("saves", "SV", 1, "DESC", "pitching"),
        ("pitching_war", "pWAR", 20, "DESC", "pitching"),
    ]

    # Check batting awards per season
    bat_seasons = set(r["season"] for r in batting_list)
    for season in bat_seasons:
        for col, label, min_pa, direction, stype in bat_categories:
            cur.execute(
                f"""SELECT bs.player_id, bs.{col} as value
                    FROM batting_stats bs
                    WHERE bs.team_id = %s AND bs.season = %s
                          AND bs.plate_appearances >= %s
                          AND bs.{col} IS NOT NULL
                    ORDER BY bs.{col} {direction}
                    LIMIT 1""",
                (team_id, season, min_pa),
            )
            leader = cur.fetchone()
            if leader and leader["player_id"] in player_id_set:
                awards.append({
                    "season": season,
                    "category": label,
                    "value": leader["value"],
                    "type": stype,
                    "team_id": team_id,
                    "team_short": team_short,
                    "team_logo": team_logo,
                })

    # Check pitching awards per season
    pit_seasons = set(r["season"] for r in pitching_list)
    for season in pit_seasons:
        for col, label, min_ip, direction, stype in pit_categories:
            cur.execute(
                f"""SELECT ps.player_id, ps.{col} as value
                    FROM pitching_stats ps
                    WHERE ps.team_id = %s AND ps.season = %s
                          AND ps.innings_pitched >= %s
                          AND ps.{col} IS NOT NULL
                    ORDER BY ps.{col} {direction}
                    LIMIT 1""",
                (team_id, season, min_ip),
            )
            leader = cur.fetchone()
            if leader and leader["player_id"] in player_id_set:
                awards.append({
                    "season": season,
                    "category": label,
                    "value": leader["value"],
                    "type": stype,
                    "team_id": team_id,
                    "team_short": team_short,
                    "team_logo": team_logo,
                })

    # Sort by season descending, then category
    awards.sort(key=lambda a: (-a["season"], a["category"]))

    # ── Career rankings: where does this player rank all-time on their team? ──
    career_rankings = []

    # Batting career rankings (min 50 career PA)
    bat_career_cats = [
        ("offensive_war", "oWAR", True),
        ("batting_avg", "AVG", True),
        ("home_runs", "HR", True),
        ("rbi", "RBI", True),
        ("hits", "H", True),
        ("stolen_bases", "SB", True),
        ("runs", "R", True),
    ]
    if batting_list:
        for col, label, desc in bat_career_cats:
            # AVG needs special handling (can't just SUM it)
            if col == "batting_avg":
                agg_expr = "ROUND(CAST(SUM(bs.hits) AS numeric) / NULLIF(SUM(bs.at_bats), 0), 3)"
            elif col == "offensive_war":
                agg_expr = "ROUND(SUM(bs.offensive_war)::numeric, 1)"
            else:
                agg_expr = f"SUM(bs.{col})"

            direction = "DESC" if desc else "ASC"
            cur.execute(
                f"""SELECT bs.player_id, {agg_expr} as career_val
                    FROM batting_stats bs
                    WHERE bs.team_id = %s
                    GROUP BY bs.player_id
                    HAVING SUM(bs.plate_appearances) >= 50
                       AND {agg_expr} IS NOT NULL
                    ORDER BY career_val {direction}""",
                (team_id,),
            )
            rows = cur.fetchall()

            total = len(rows)
            for rank, row in enumerate(rows, 1):
                if row["player_id"] in player_id_set:
                    if rank <= 5 and total >= 3:
                        career_rankings.append({
                            "category": label,
                            "rank": rank,
                            "total": total,
                            "value": row["career_val"],
                            "type": "batting",
                            "team_id": team_id,
                            "team_short": team_short,
                            "team_logo": team_logo,
                        })
                    break

    # Pitching career rankings (min 20 career IP)
    pit_career_cats = [
        ("pitching_war", "pWAR", True),
        ("era", "ERA", False),
        ("strikeouts", "K", True),
        ("wins", "W", True),
        ("saves", "SV", True),
        ("innings_pitched", "IP", True),
    ]
    if pitching_list:
        for col, label, desc in pit_career_cats:
            if col == "era":
                agg_expr = "ROUND((9.0 * SUM(ps.earned_runs) / NULLIF(SUM(ip_outs(ps.innings_pitched)) / 3.0, 0))::numeric, 2)"
            elif col == "pitching_war":
                agg_expr = "ROUND(SUM(ps.pitching_war)::numeric, 1)"
            elif col == "innings_pitched":
                agg_expr = "ROUND(outs_to_ip(SUM(ip_outs(ps.innings_pitched)))::numeric, 1)"
            else:
                agg_expr = f"SUM(ps.{col})"

            direction = "DESC" if desc else "ASC"
            cur.execute(
                f"""SELECT ps.player_id, {agg_expr} as career_val
                    FROM pitching_stats ps
                    WHERE ps.team_id = %s
                    GROUP BY ps.player_id
                    HAVING SUM(ip_outs(ps.innings_pitched)) / 3.0 >= 20
                       AND {agg_expr} IS NOT NULL
                    ORDER BY career_val {direction}""",
                (team_id,),
            )
            rows = cur.fetchall()

            total = len(rows)
            for rank, row in enumerate(rows, 1):
                if row["player_id"] in player_id_set:
                    if rank <= 5 and total >= 3:
                        career_rankings.append({
                            "category": label,
                            "rank": rank,
                            "total": total,
                            "value": row["career_val"],
                            "type": "pitching",
                            "team_id": team_id,
                            "team_short": team_short,
                            "team_logo": team_logo,
                        })
                    break

    # Sort career rankings by rank
    career_rankings.sort(key=lambda r: (r["rank"], r["category"]))

    return {"season_awards": awards, "career_rankings": career_rankings}


@router.get("/players/{player_id}")
@cached_endpoint(ttl_seconds=1800)
def get_player(player_id: int, percentile_season: Optional[str] = Query(None)):
    """
    Get full player profile with career stats and percentiles.

    If this player is linked to a canonical record (transfer), redirect to canonical.
    If this player IS the canonical record, merge stats from all linked records.

    percentile_season controls which season the Savant-style percentile bars show:
      - None / omitted  → most recent season (default)
      - "2025", "2024"  → that specific season
      - "career"        → aggregate career stats ranked against other careers
    """
    with get_connection() as conn:
        cur = conn.cursor()
        # ── Check if this player is a linked (non-canonical) record ──
        cur.execute(
            "SELECT canonical_id FROM player_links WHERE linked_id = %s",
            (player_id,),
        )
        canonical_link = cur.fetchone()
        if canonical_link:
            # Use the canonical player ID instead of redirecting
            player_id = canonical_link['canonical_id']

        cur.execute(
            """SELECT p.*, t.name as team_name, t.short_name as team_short, t.logo_url,
                      c.abbreviation as conference_abbrev,
                      d.name as division_name, d.level as division_level,
                      d.id as division_id
               FROM players p
               JOIN teams t ON p.team_id = t.id
               JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id
               WHERE p.id = %s""",
            (player_id,),
        )
        player = cur.fetchone()

        if not player:
            raise HTTPException(status_code=404, detail="Player not found")

        player_dict = dict(player)

        # ── Gather all player IDs (canonical + any linked transfers) ──
        cur.execute(
            "SELECT linked_id FROM player_links WHERE canonical_id = %s",
            (player_id,),
        )
        linked_ids = cur.fetchall()
        all_player_ids = [player_id] + [r["linked_id"] for r in linked_ids]
        id_placeholders = ",".join(["%s"] * len(all_player_ids))

        # ── Build linked_players info for frontend (team badges per school) ──
        linked_players = []
        if len(all_player_ids) > 1:
            for lid in all_player_ids:
                cur.execute(
                    """SELECT p.id, p.first_name, p.last_name, p.position,
                              t.id as team_id, t.short_name as team_short, t.name as team_name,
                              t.logo_url, d.level as division_level
                       FROM players p
                       JOIN teams t ON p.team_id = t.id
                       JOIN conferences c ON t.conference_id = c.id
                       JOIN divisions d ON c.division_id = d.id
                       WHERE p.id = %s""",
                    (lid,),
                )
                lp = cur.fetchone()
                if lp:
                    lp_dict = dict(lp)
                    # Get this player's earliest season for sorting
                    cur.execute(
                        """SELECT MIN(season) as min_season, MAX(season) as max_season FROM (
                               SELECT season FROM batting_stats WHERE player_id = %s
                               UNION
                               SELECT season FROM pitching_stats WHERE player_id = %s
                           ) s""",
                        (lid, lid),
                    )
                    seasons = cur.fetchone()
                    lp_dict["_min_season"] = seasons["min_season"] or 9999
                    lp_dict["_max_season"] = seasons["max_season"] or 0
                    linked_players.append(lp_dict)

            # Sort oldest → newest by earliest season at each school
            linked_players.sort(key=lambda x: x["_min_season"])

            # Use the most recent school's info for the page header
            most_recent = max(linked_players, key=lambda x: x["_max_season"])
            player_dict["team_name"] = most_recent["team_name"]
            player_dict["team_short"] = most_recent["team_short"]
            player_dict["logo_url"] = most_recent["logo_url"]
            player_dict["division_level"] = most_recent["division_level"]
            player_dict["team_id"] = most_recent["team_id"]

            # Clean up internal keys before sending to frontend
            for lp in linked_players:
                del lp["_min_season"]
                del lp["_max_season"]

        # Get all batting seasons (across all linked IDs)
        cur.execute(
            f"""SELECT bs.*, t.short_name as team_short, t.logo_url,
                      d.level as division_level, c.abbreviation as conference_abbrev
               FROM batting_stats bs
               JOIN teams t ON bs.team_id = t.id
               JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id
               WHERE bs.player_id IN ({id_placeholders})
                 AND (COALESCE(bs.at_bats, 0) > 0 OR COALESCE(bs.games, 0) > 0)
               ORDER BY bs.season""",
            all_player_ids,
        )
        batting = cur.fetchall()

        # Get all pitching seasons (across all linked IDs)
        cur.execute(
            f"""SELECT ps.*,
                      COALESCE(ps.k_pct, 0) - COALESCE(ps.bb_pct, 0) as k_bb_pct,
                      CASE WHEN (COALESCE(ps.batters_faced,0) - COALESCE(ps.walks,0) - COALESCE(ps.hit_batters,0)) > 0
                           THEN ROUND(COALESCE(ps.hits_allowed,0)::numeric
                                / (COALESCE(ps.batters_faced,0) - COALESCE(ps.walks,0) - COALESCE(ps.hit_batters,0))::numeric, 3)
                      END as baa,
                      t.short_name as team_short, t.logo_url,
                      d.level as division_level, c.abbreviation as conference_abbrev
               FROM pitching_stats ps
               JOIN teams t ON ps.team_id = t.id
               JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id
               WHERE ps.player_id IN ({id_placeholders})
                 AND (COALESCE(ps.innings_pitched, 0) > 0 OR COALESCE(ps.games, 0) > 0)
               ORDER BY ps.season""",
            all_player_ids,
        )
        pitching = cur.fetchall()

        # Get team history (across all linked IDs)
        cur.execute(
            f"""SELECT ps.*, t.name as team_name, t.short_name as team_short, t.logo_url,
                      d.level as division_level
               FROM player_seasons ps
               JOIN teams t ON ps.team_id = t.id
               JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id
               WHERE ps.player_id IN ({id_placeholders}) ORDER BY ps.season""",
            all_player_ids,
        )
        history = cur.fetchall()

        batting_list = [dict(r) for r in batting]
        pitching_list = [dict(r) for r in pitching]

        # Determine which season to compute percentiles for.
        # target_season is shared with the position-breakdown query below;
        # None means "all seasons" (used in career mode).
        target_season = None
        batting_percentiles = {}
        pitching_percentiles = {}
        percentile_label = None  # Tells frontend what's being shown

        if percentile_season == "career":
            # Career mode: aggregate stats across all seasons, rank against career aggregates
            percentile_label = "career"
            if batting_list:
                career_bat = _aggregate_career_batting(batting_list)
                batting_percentiles = _compute_career_percentiles(
                    conn, player_dict["division_level"], career_bat, "batting"
                )
            if pitching_list:
                career_pit = _aggregate_career_pitching(pitching_list)
                pitching_percentiles = _compute_career_percentiles(
                    conn, player_dict["division_level"], career_pit, "pitching"
                )
        else:
            # Single season mode
            if percentile_season and percentile_season.isdigit():
                target_season = int(percentile_season)

            # Default to the most recent season across BOTH batting and
            # pitching. Without this, a player like a 2026 pitcher who
            # had a tiny 2025 batting line would default to 2025 batting
            # (since batting_list[-1] was used independently of pitching).
            if not target_season:
                all_seasons = (
                    [r["season"] for r in batting_list] +
                    [r["season"] for r in pitching_list]
                )
                if all_seasons:
                    target_season = max(all_seasons)

            # Compute percentiles only for the side(s) that actually have
            # stats in target_season. A pitcher with no batting in 2026
            # gets pitching_percentiles only and no stale 2025 batting bars.
            if batting_list and target_season:
                bat_row = next(
                    (r for r in batting_list if r["season"] == target_season),
                    None,
                )
                if bat_row:
                    percentile_label = str(bat_row["season"])
                    batting_percentiles = _compute_percentiles(
                        conn, player_dict["division_level"], bat_row["season"],
                        bat_row, "batting"
                    )
                    # Phase J: 2026+ adds Contact% + AIRPULL% from PBP data
                    if bat_row["season"] >= 2026:
                        weights = DEFAULT_WEIGHTS.get(player_dict["division_level"],
                                                      DEFAULT_WEIGHTS["D1"])
                        pbp_pct = _compute_2026_pbp_batting_percentiles(
                            conn, player_dict["division_level"],
                            bat_row["season"], bat_row.get("player_id") or player_id,
                            weights,
                        )
                        batting_percentiles.update(pbp_pct)

            if pitching_list and target_season:
                pit_row = next(
                    (r for r in pitching_list if r["season"] == target_season),
                    None,
                )
                if pit_row:
                    if not percentile_label:
                        percentile_label = str(pit_row["season"])
                    pitching_percentiles = _compute_percentiles(
                        conn, player_dict["division_level"], pit_row["season"],
                        pit_row, "pitching"
                    )
                    # Phase J: 2026+ adds Strike%, FPS%, Whiff%, opp wOBA,
                    # opp AIRPULL%, HR/PA from PBP data
                    if pit_row["season"] >= 2026:
                        weights = DEFAULT_WEIGHTS.get(player_dict["division_level"],
                                                      DEFAULT_WEIGHTS["D1"])
                        pbp_pct = _compute_2026_pbp_pitching_percentiles(
                            conn, player_dict["division_level"],
                            pit_row["season"], pit_row.get("player_id") or player_id,
                            weights,
                        )
                        pitching_percentiles.update(pbp_pct)

        # ── Team awards: check awards for each team the player was on ──
        all_awards = {"season_awards": [], "career_rankings": []}
        teams_played_for = set()
        for row in batting_list + pitching_list:
            teams_played_for.add(row["team_id"])
        if not teams_played_for:
            teams_played_for.add(player_dict["team_id"])
        for tid in teams_played_for:
            # Filter stats to just this team for award computation
            team_bat = [r for r in batting_list if r["team_id"] == tid]
            team_pit = [r for r in pitching_list if r["team_id"] == tid]
            awards_data = _compute_player_awards(conn, player_id, tid,
                                                  team_bat, team_pit,
                                                  all_player_ids=all_player_ids)
            all_awards["season_awards"].extend(awards_data["season_awards"])
            all_awards["career_rankings"].extend(awards_data["career_rankings"])
        # Deduplicate and sort
        all_awards["season_awards"].sort(key=lambda a: (-a["season"], a["category"]))
        all_awards["career_rankings"].sort(key=lambda r: (r["rank"], r["category"]))

        # ── PNW Top 10 rankings (qualified, current season) ──
        pnw_rankings = []
        current_season = CURRENT_SEASON
        min_pa = 30
        min_ip = 10

        batting_cats = [
            {"key": "wrc_plus", "label": "wRC+", "col": "bs.wrc_plus", "order": "DESC", "format": "int"},
            {"key": "home_runs", "label": "HR", "col": "bs.home_runs", "order": "DESC", "format": "int"},
            {"key": "stolen_bases", "label": "SB", "col": "bs.stolen_bases", "order": "DESC", "format": "int"},
            {"key": "offensive_war", "label": "oWAR", "col": "bs.offensive_war", "order": "DESC", "format": "float1"},
            {"key": "batting_avg", "label": "AVG", "col": "bs.batting_avg", "order": "DESC", "format": "avg"},
            {"key": "iso", "label": "ISO", "col": "bs.iso", "order": "DESC", "format": "avg"},
        ]

        pitching_cats = [
            {"key": "pitching_war", "label": "pWAR", "col": "ps.pitching_war", "order": "DESC", "format": "float1"},
            {"key": "fip_plus", "label": "FIP+", "col": "ps.fip_plus", "order": "DESC", "format": "int"},
            {"key": "siera", "label": "SIERA", "col": "ps.siera", "order": "ASC", "format": "float2"},
            {"key": "k_minus_bb_pct", "label": "K-BB%", "col": "(ps.k_pct - ps.bb_pct)", "order": "DESC", "format": "pct"},
            {"key": "era", "label": "ERA", "col": "ps.era", "order": "ASC", "format": "float2"},
            {"key": "strikeouts", "label": "K", "col": "ps.strikeouts", "order": "DESC", "format": "int"},
        ]

        # Check batting categories
        for cat in batting_cats:
            cur.execute(f"""
                SELECT ranked.player_id, ranked.rank, ranked.value
                FROM (
                    SELECT bs.player_id,
                           RANK() OVER (ORDER BY {cat['col']} {cat['order']}) as rank,
                           {cat['col']} as value
                    FROM batting_stats bs
                    JOIN players p ON bs.player_id = p.id
                    JOIN teams t ON bs.team_id = t.id
                    {QUALIFIED_BATTING_JOIN}
                    WHERE bs.season = %s AND bs.plate_appearances >= %s
                      AND {cat['col']} IS NOT NULL
                      {QUALIFIED_BATTING_WHERE}
                ) ranked
                WHERE ranked.player_id IN ({id_placeholders}) AND ranked.rank <= 10
            """, [current_season, min_pa] + all_player_ids)
            row = cur.fetchone()
            if row:
                pnw_rankings.append({
                    "category": cat["label"],
                    "rank": row["rank"],
                    "value": row["value"],
                    "format": cat["format"],
                    "type": "batting",
                })

        # Check pitching categories
        for cat in pitching_cats:
            cur.execute(f"""
                SELECT ranked.player_id, ranked.rank, ranked.value
                FROM (
                    SELECT ps.player_id,
                           RANK() OVER (ORDER BY {cat['col']} {cat['order']}) as rank,
                           {cat['col']} as value
                    FROM pitching_stats ps
                    JOIN players p ON ps.player_id = p.id
                    JOIN teams t ON ps.team_id = t.id
                    {QUALIFIED_PITCHING_JOIN}
                    WHERE ps.season = %s AND ps.innings_pitched >= %s
                      AND {cat['col']} IS NOT NULL
                      {QUALIFIED_PITCHING_WHERE}
                ) ranked
                WHERE ranked.player_id IN ({id_placeholders}) AND ranked.rank <= 10
            """, [current_season, min_ip] + all_player_ids)
            row = cur.fetchone()
            if row:
                pnw_rankings.append({
                    "category": cat["label"],
                    "rank": row["rank"],
                    "value": row["value"],
                    "format": cat["format"],
                    "type": "pitching",
                })

        pnw_rankings.sort(key=lambda r: (r["rank"], r["category"]))

        # ── Position breakdown from game logs ──
        # Shows what % of games the player played at each position.
        # Use COUNT(DISTINCT game_date) to avoid double-counting when the
        # same real-world game was scraped from both teams' box scores.
        # Include ALL games (even those without position data) so totals
        # match the player's actual game count.
        # Filter to target_season when one is selected (matches the bars/cards
        # the rest of the page shows); fall through unfiltered for career mode.
        if target_season is not None:
            cur.execute("""
                SELECT gb.position, COUNT(DISTINCT (g.game_date, COALESCE(g.game_number, 1))) as games
                FROM game_batting gb
                JOIN games g ON g.id = gb.game_id
                WHERE gb.player_id IN %s
                  AND g.season = %s
                GROUP BY gb.position
                ORDER BY games DESC
            """, (tuple(all_player_ids), target_season))
        else:
            cur.execute("""
                SELECT gb.position, COUNT(DISTINCT (g.game_date, COALESCE(g.game_number, 1))) as games
                FROM game_batting gb
                JOIN games g ON g.id = gb.game_id
                WHERE gb.player_id IN %s
                GROUP BY gb.position
                ORDER BY games DESC
            """, (tuple(all_player_ids),))
        pos_rows = cur.fetchall()
        position_breakdown = []
        total_all_games = sum(r["games"] for r in pos_rows)
        if total_all_games > 0:
            unknown_games = 0
            for r in pos_rows:
                raw_pos = r["position"]
                # Count games with no position data
                if not raw_pos or not raw_pos.strip() or raw_pos.strip() == '-':
                    unknown_games += r["games"]
                    continue
                norm = normalize_position(raw_pos)
                if not norm or norm == "P":
                    continue
                # Merge rows that normalize to the same position
                existing = next((p for p in position_breakdown if p["position"] == norm), None)
                if existing:
                    existing["games"] += r["games"]
                else:
                    position_breakdown.append({
                        "position": norm,
                        "games": r["games"],
                    })
            # Calculate percentages based on total games (including unknown)
            for p in position_breakdown:
                p["percentage"] = round(p["games"] / total_all_games * 100, 1)
            # If there are games with no position data, add an "Unknown" entry
            if unknown_games > 0:
                position_breakdown.append({
                    "position": "N/A",
                    "games": unknown_games,
                    "percentage": round(unknown_games / total_all_games * 100, 1),
                })
            position_breakdown.sort(key=lambda x: -x["games"])

        # ── Summer ball stats (via summer_player_links) ──
        summer_batting = []
        summer_pitching = []
        cur.execute(
            """SELECT spl.summer_player_id, spl.confidence
               FROM summer_player_links spl
               WHERE spl.spring_player_id IN ({ids})""".format(
                ids=",".join(["%s"] * len(all_player_ids))
            ),
            all_player_ids,
        )
        summer_links = cur.fetchall()
        if summer_links:
            summer_player_ids = [r["summer_player_id"] for r in summer_links]
            sp_placeholders = ",".join(["%s"] * len(summer_player_ids))

            cur.execute(
                f"""SELECT sbs.*,
                           sp.first_name, sp.last_name, sp.college,
                           st.name as team_name, st.short_name as team_short,
                           st.logo_url as team_logo,
                           sl.name as league_name, sl.abbreviation as league_abbrev
                    FROM summer_batting_stats sbs
                    JOIN summer_players sp ON sbs.player_id = sp.id
                    JOIN summer_teams st ON sbs.team_id = st.id
                    JOIN summer_leagues sl ON st.league_id = sl.id
                    WHERE sbs.player_id IN ({sp_placeholders})
                    ORDER BY sbs.season""",
                summer_player_ids,
            )
            summer_batting = [dict(r) for r in cur.fetchall()]

            cur.execute(
                f"""SELECT sps.*,
                           sp.first_name, sp.last_name, sp.college,
                           st.name as team_name, st.short_name as team_short,
                           st.logo_url as team_logo,
                           sl.name as league_name, sl.abbreviation as league_abbrev
                    FROM summer_pitching_stats sps
                    JOIN summer_players sp ON sps.player_id = sp.id
                    JOIN summer_teams st ON sps.team_id = st.id
                    JOIN summer_leagues sl ON st.league_id = sl.id
                    WHERE sps.player_id IN ({sp_placeholders})
                    ORDER BY sps.season""",
                summer_player_ids,
            )
            summer_pitching = [dict(r) for r in cur.fetchall()]

        # ── Current summer assignment ──
        # "Summer 2026: Yakima Pippins" badge for the spring player page.
        # Only surface it for players who ACTUALLY appeared in a 2026 WCL
        # game (i.e. have a 2026 WCL stat line) — WCL is the only current
        # summer data we have. We derive it from the same summer rows shown
        # in the stat tables rather than from summer_players, because that
        # roster table holds entries from multiple past seasons (so a guy
        # who last played WCL in 2023 was wrongly getting a 2026 button).
        CURRENT_SUMMER_SEASON = CURRENT_SEASON
        current_summer_assignment = None
        for _sr in (summer_batting + summer_pitching):
            if _sr.get("season") == CURRENT_SUMMER_SEASON and _sr.get("league_abbrev") == "WCL":
                current_summer_assignment = {
                    "summer_player_id": _sr.get("player_id"),
                    "team_id": _sr.get("team_id"),
                    "team_name": _sr.get("team_name"),
                    "team_short": _sr.get("team_short"),
                    "team_logo": _sr.get("team_logo"),
                    "league_abbrev": _sr.get("league_abbrev"),
                    "league_name": _sr.get("league_name"),
                }
                break

        # ── Fielding (per-position per-season) ──
        # One row per (season, position) at each team the player has
        # been on. Frontend groups by season and renders each position
        # as a separate line so a SS/RF utility player shows two
        # distinct fielding pcts.
        cur.execute(
            """
            SELECT fs.season, fs.position, fs.team_id,
                   t.short_name AS team_short, t.school_name AS team_name,
                   t.logo_url, d.level AS division_level,
                   fs.games, fs.games_started, fs.innings,
                   fs.putouts, fs.assists, fs.errors,
                   fs.total_chances, fs.double_plays, fs.triple_plays,
                   fs.passed_balls, fs.stolen_bases_against,
                   fs.caught_stealing_by, fs.pickoffs,
                   fs.fielding_pct, fs.range_factor, fs.cs_pct
            FROM fielding_stats fs
            JOIN teams t ON t.id = fs.team_id
            LEFT JOIN conferences c ON c.id = t.conference_id
            LEFT JOIN divisions d ON d.id = c.division_id
            WHERE fs.player_id = ANY(%s)
            ORDER BY fs.season DESC,
                     -- Order positions by typical defensive spectrum
                     -- so the most-played position usually renders
                     -- first. Within a season, secondary positions
                     -- follow primary.
                     fs.games DESC, fs.position
            """,
            (all_player_ids,),
        )
        fielding_list = [dict(r) for r in cur.fetchall()]

        # League reference averages for the rolling-chart reference lines,
        # over the qualified division pool for the displayed season.
        _all_seasons = [r["season"] for r in batting_list] + [r["season"] for r in pitching_list]
        _lg_season = (
            int(percentile_label) if (percentile_label and percentile_label.isdigit())
            else (max(_all_seasons) if _all_seasons else None)
        )
        league_context = _league_rate_avgs(conn, player_dict.get("division_level"), _lg_season)

        return {
            "player": player_dict,
            "batting_stats": batting_list,
            "pitching_stats": [_add_era_plus(r) for r in pitching_list],
            "fielding_stats": fielding_list,
            "team_history": [dict(r) for r in history],
            "batting_percentiles": batting_percentiles,
            "pitching_percentiles": pitching_percentiles,
            "percentile_season": percentile_label,
            "league_context": league_context,
            "awards": all_awards["season_awards"],
            "career_rankings": all_awards["career_rankings"],
            "pnw_rankings": pnw_rankings,
            "position_breakdown": position_breakdown,
            "linked_players": linked_players,
            "summer_batting": summer_batting,
            "summer_pitching": summer_pitching,
            "current_summer_assignment": current_summer_assignment,
        }


# ── Shared PBP stat columns for the JUCO + Transfer trackers ──────
# Per-player season aggregates from game_events: discipline (Contact%,
# Swing%, Whiff%, Strike%, FPS%), AIRPULL%, and WPA. Built as CTEs so
# both tracker endpoints render the same extra columns. Each CTE takes a
# season %s placeholder first, then whatever params its filter predicate
# needs (none for the JUCO subquery, an ANY(%s) id list for transfers).
_PLAYER_PBP_SELECT = """
                   CASE WHEN (COALESCE(ps2.batters_faced,0)-COALESCE(ps2.walks,0)-COALESCE(ps2.hit_batters,0)) > 0
                        THEN COALESCE(ps2.hits_allowed,0)::numeric
                             / (COALESCE(ps2.batters_faced,0)-COALESCE(ps2.walks,0)-COALESCE(ps2.hit_batters,0)) END AS baa,
                   CASE WHEN bpbp.pitches > 0 THEN (bpbp.kp+bpbp.fp+bpbp.inp)::numeric/bpbp.pitches END AS swing_pct,
                   CASE WHEN (bpbp.kp+bpbp.fp+bpbp.inp) > 0 THEN (bpbp.fp+bpbp.inp)::numeric/(bpbp.kp+bpbp.fp+bpbp.inp) END AS contact_pct,
                   CASE WHEN bpbp.bbtp > 0 THEN bpbp.apc::numeric/bpbp.bbtp END AS air_pull_pct,
                   bpbp.wpa AS batter_wpa,
                   CASE WHEN ppbp.pitches > 0 THEN (ppbp.kp+ppbp.sp+ppbp.fp+ppbp.inp)::numeric/ppbp.pitches END AS strike_pct,
                   CASE WHEN (ppbp.kp+ppbp.fp+ppbp.inp) > 0 THEN ppbp.kp::numeric/(ppbp.kp+ppbp.fp+ppbp.inp) END AS whiff_pct,
                   CASE WHEN ppbp.tpa > 0 THEN ppbp.f1::numeric/ppbp.tpa END AS first_pitch_strike_pct,
                   ppbp.wpa AS pitcher_wpa,
"""


def _PLAYER_PBP_CTES(batter_pred: str, pitcher_pred: str, with_juco_ids: bool = False) -> str:
    juco_cte = """
            juco_ids AS (
                SELECT p.id FROM players p
                JOIN teams t ON p.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                WHERE d.level = 'JUCO'
            ),
    """ if with_juco_ids else ""
    return f"""
        WITH {juco_cte}
            bpbp AS (
                SELECT ge.batter_player_id AS pid,
                    COALESCE(SUM(ge.pitches_thrown) FILTER (WHERE ge.pitches_thrown>=1),0) AS pitches,
                    COALESCE(SUM(LENGTH(ge.pitch_sequence)-LENGTH(REPLACE(ge.pitch_sequence,'K',''))) FILTER (WHERE ge.pitches_thrown>=1),0) AS kp,
                    COALESCE(SUM(LENGTH(ge.pitch_sequence)-LENGTH(REPLACE(ge.pitch_sequence,'F',''))) FILTER (WHERE ge.pitches_thrown>=1),0) AS fp,
                    COALESCE(SUM(CASE WHEN ge.was_in_play THEN 1 ELSE 0 END) FILTER (WHERE ge.pitches_thrown>=1),0) AS inp,
                    COUNT(*) FILTER (WHERE ge.bb_type IS NOT NULL AND UPPER(plyr.bats) IN ('L','R')) AS bbtp,
                    COUNT(*) FILTER (WHERE ge.bb_type IN ('LD','FB')
                        AND ((UPPER(plyr.bats)='R' AND ge.field_zone='LEFT')
                          OR (UPPER(plyr.bats)='L' AND ge.field_zone='RIGHT'))) AS apc,
                    SUM(ge.wpa_batter) AS wpa
                FROM game_events ge
                JOIN games g ON g.id = ge.game_id
                LEFT JOIN players plyr ON plyr.id = ge.batter_player_id
                WHERE g.season = %s AND {batter_pred}
                GROUP BY ge.batter_player_id
            ),
            ppbp AS (
                SELECT ge.pitcher_player_id AS pid,
                    COUNT(*) FILTER (WHERE ge.pitches_thrown>=1) AS tpa,
                    COALESCE(SUM(ge.pitches_thrown) FILTER (WHERE ge.pitches_thrown>=1),0) AS pitches,
                    COALESCE(SUM(LENGTH(ge.pitch_sequence)-LENGTH(REPLACE(ge.pitch_sequence,'K',''))) FILTER (WHERE ge.pitches_thrown>=1),0) AS kp,
                    COALESCE(SUM(LENGTH(ge.pitch_sequence)-LENGTH(REPLACE(ge.pitch_sequence,'S',''))) FILTER (WHERE ge.pitches_thrown>=1),0) AS sp,
                    COALESCE(SUM(LENGTH(ge.pitch_sequence)-LENGTH(REPLACE(ge.pitch_sequence,'F',''))) FILTER (WHERE ge.pitches_thrown>=1),0) AS fp,
                    COALESCE(SUM(CASE WHEN ge.was_in_play THEN 1 ELSE 0 END) FILTER (WHERE ge.pitches_thrown>=1),0) AS inp,
                    COUNT(*) FILTER (WHERE ge.pitches_thrown>=1
                        AND (LEFT(ge.pitch_sequence,1) IN ('K','S','F') OR (ge.pitch_sequence='' AND ge.was_in_play))) AS f1,
                    SUM(ge.wpa_pitcher) AS wpa
                FROM game_events ge
                JOIN games g ON g.id = ge.game_id
                WHERE g.season = %s AND {pitcher_pred}
                GROUP BY ge.pitcher_player_id
            )
    """


# Every stat column the JUCO + Transfer Portal trackers display, keyed by
# the SELECT output alias used in the shared query (main SELECT +
# _PLAYER_PBP_SELECT + the computed total_war). The tracker tables let you
# sort by any of these; because each is a SELECT output alias, ORDER BY can
# reference it directly (Postgres resolves a bare name to the output column).
# "era_plus" is computed in Python after fetch, so it is handled specially in
# the ORDER BY logic rather than referenced as an alias.
_TRACKER_SORT_COLUMNS = {
    # batting
    "batting_avg", "on_base_pct", "slugging_pct", "ops", "woba", "wrc_plus",
    "offensive_war", "home_runs", "rbi", "stolen_bases", "plate_appearances",
    "bat_k_pct", "bat_bb_pct", "contact_pct", "swing_pct", "air_pull_pct", "batter_wpa",
    # pitching
    "era", "fip", "fip_plus", "era_minus", "era_plus", "xfip", "siera", "baa",
    "pitch_k_pct", "pitch_bb_pct", "whiff_pct", "strike_pct", "first_pitch_strike_pct",
    "innings_pitched", "pitcher_wpa", "pitching_war",
    # combined
    "total_war",
}


@router.get("/players/juco/uncommitted")
def uncommitted_juco_players(
    season: int = Query(...),
    position: Optional[str] = None,
    year_in_school: Optional[str] = Query("So", description="Class year group: 'So' includes R-So, 'Fr' includes R-Fr"),
    sort_by: str = Query("total_war", description="Sort column"),
    sort_dir: str = Query("desc", description="Sort direction (asc/desc)"),
    min_ab: int = Query(0, description="Minimum at-bats (batting filter)"),
    min_ip: float = Query(0, description="Minimum innings pitched (pitching filter)"),
    bats: Optional[str] = Query(None, description="Filter by batting hand: L, R, or S"),
    throws: Optional[str] = Query(None, description="Filter by throwing hand: L or R"),
    limit: int = Query(500),
    _user: str = Depends(require_tier("recruiting")),
):
    """
    Find uncommitted JUCO players - the primary recruiting tool.
    Premium-tier gated (the JUCO tracker lives in the Coaching tab).
    Shows sophomores (or specified class) who haven't committed to a 4-year school.
    Year filter groups: 'So' matches So and R-So, 'Fr' matches Fr and R-Fr.
    """
    allowed_sort = _TRACKER_SORT_COLUMNS
    if sort_by not in allowed_sort:
        sort_by = "total_war"
    direction = "ASC" if sort_dir.lower() == "asc" else "DESC"
    # For ERA/FIP, ascending is better
    if sort_by in ("era", "fip") and sort_dir.lower() not in ("asc", "desc"):
        direction = "ASC"

    with get_connection() as conn:
        cur = conn.cursor()
        query = _PLAYER_PBP_CTES(
            "ge.batter_player_id IN (SELECT id FROM juco_ids)",
            "ge.pitcher_player_id IN (SELECT id FROM juco_ids)",
            with_juco_ids=True,
        ) + """
            SELECT p.*, t.name as team_name, t.short_name as team_short, t.logo_url,
                   bs.batting_avg, bs.on_base_pct, bs.slugging_pct, bs.ops,
                   bs.woba, bs.wrc_plus, bs.offensive_war,
                   bs.home_runs, bs.rbi, bs.stolen_bases, bs.plate_appearances,
                   bs.k_pct as bat_k_pct, bs.bb_pct as bat_bb_pct,
                   ps2.era, ps2.fip, ps2.fip_plus, ps2.era_minus, ps2.xfip, ps2.siera, ps2.strikeouts as pitch_k,
                   ps2.k_pct as pitch_k_pct, ps2.bb_pct as pitch_bb_pct,
                   ps2.innings_pitched, ps2.pitching_war,
                   """ + _PLAYER_PBP_SELECT + """
                   COALESCE(bs.offensive_war, 0) + COALESCE(ps2.pitching_war, 0) as total_war
            FROM players p
            JOIN teams t ON p.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN batting_stats bs ON p.id = bs.player_id AND bs.season = %s
            LEFT JOIN pitching_stats ps2 ON p.id = ps2.player_id AND ps2.season = %s
            LEFT JOIN bpbp ON bpbp.pid = p.id
            LEFT JOIN ppbp ON ppbp.pid = p.id
            WHERE d.level = 'JUCO'
              AND (bs.player_id IS NOT NULL OR ps2.player_id IS NOT NULL)
        """
        # PBP CTE season params first (batter, then pitcher), then the
        # batting_stats + pitching_stats join seasons.
        params: list = [season, season, season, season]

        if year_in_school:
            query = _apply_year_filter(query, params, year_in_school)
        if position:
            # Position group filters using standardized positions
            # Note: %% escapes the % for psycopg2 when not using params
            if position == 'P':
                query += " AND (p.position IN ('RHP','LHP') OR p.position LIKE 'RHP/%%' OR p.position LIKE 'LHP/%%')"
            elif position == 'OF':
                query += " AND (p.position IN ('OF','LF','CF','RF') OR p.position LIKE '%%/OF' OR p.position LIKE '%%/LF' OR p.position LIKE '%%/CF' OR p.position LIKE '%%/RF')"
            elif position == 'IF':
                query += " AND (p.position IN ('IF','1B','2B','3B','SS') OR p.position LIKE '%%/IF' OR p.position LIKE '%%/1B' OR p.position LIKE '%%/2B' OR p.position LIKE '%%/3B' OR p.position LIKE '%%/SS')"
            else:
                query += " AND (p.position = %s OR p.position LIKE %s OR p.position LIKE %s)"
                params.extend([position, f"{position}/%", f"%/{position}"])
        if min_ab > 0:
            query += " AND COALESCE(bs.at_bats, 0) >= %s"
            params.append(min_ab)
        if min_ip > 0:
            query += " AND COALESCE(ps2.innings_pitched, 0) >= %s"
            params.append(min_ip)
        if bats:
            query += " AND p.bats = %s"
            params.append(bats)
        if throws:
            query += " AND p.throws = %s"
            params.append(throws)

        if sort_by == "era_plus":
            # era_plus is computed in Python (not a SELECT column), so derive it here.
            query += f" ORDER BY CASE WHEN ps2.era_minus > 0 THEN 10000.0 / ps2.era_minus END {direction} NULLS LAST"
        else:
            # sort_by is whitelisted to a SELECT output alias above, so it is safe to
            # interpolate. A bare name in ORDER BY resolves to the output column, which
            # works for the PBP-derived stats too. NULLS LAST keeps players who are
            # missing that stat at the bottom regardless of direction.
            query += f" ORDER BY {sort_by} {direction} NULLS LAST"
        query += " LIMIT %s"
        params.append(limit)

        rows = cur.execute(query, params)
        rows = cur.fetchall()
        out = [_add_era_plus(dict(r)) for r in rows]
        # Tag each committed player's destination with its division level, using
        # the same resolver as the NWAC advancement graphic so the level shown on
        # the tracker matches the graphic and updates with every new commitment.
        names = [r["committed_to"] for r in out if r.get("committed_to")]
        if names:
            from .recruiting import _resolve_committed_levels  # lazy: avoids circular import
            levels = _resolve_committed_levels(cur, names)
            for r in out:
                if r.get("committed_to"):
                    r["committed_level"] = levels.get(r["committed_to"].strip().lower())
        return out


# NOTE: top-level path (not /players/transfer-portal) to avoid being
# shadowed by the /players/{player_id} route, which would try to parse
# "transfer-portal" as an int player id (422).
@router.get("/transfer-portal")
def transfer_portal_players(
    season: int = Query(CURRENT_SEASON),
    position: Optional[str] = None,
    sort_by: str = Query("total_war", description="Sort column"),
    sort_dir: str = Query("desc", description="Sort direction (asc/desc)"),
    bats: Optional[str] = Query(None),
    throws: Optional[str] = Query(None),
    _user: str = Depends(require_tier("recruiting")),
):
    """
    Transfer Portal Tracker — PNW four-year (non-JUCO) players who have
    entered the transfer portal. Curated list lives in
    backend/data/transfer_portal.json; this enriches each with the same
    stat row shape the JUCO tracker uses so the two pages share a table.
    Premium-tier gated (Coaching tab).
    """
    import json as _json
    from pathlib import Path as _Path
    data_path = _Path(__file__).parent.parent.parent / "data" / "transfer_portal.json"
    try:
        with open(data_path) as f:
            payload = _json.load(f)
        entries = payload.get("players", [])
    except Exception:
        entries = []
    ids = [int(e["player_id"]) for e in entries if e.get("player_id")]
    committed_map = {int(e["player_id"]): e.get("committed_to") for e in entries if e.get("player_id")}
    # Optional per-entry position override from the JSON. Used for placeholder
    # players who have no stats and no position in the DB, so the frontend can
    # still file them on the correct Hitters/Pitchers list.
    position_map = {int(e["player_id"]): e.get("position") for e in entries if e.get("player_id") and e.get("position")}
    if not ids:
        return []

    allowed_sort = _TRACKER_SORT_COLUMNS
    if sort_by not in allowed_sort:
        sort_by = "total_war"
    direction = "ASC" if sort_dir.lower() == "asc" else "DESC"

    with get_connection() as conn:
        cur = conn.cursor()
        query = _PLAYER_PBP_CTES(
            "ge.batter_player_id = ANY(%s)",
            "ge.pitcher_player_id = ANY(%s)",
        ) + """
            SELECT p.*, t.name as team_name, t.short_name as team_short, t.logo_url,
                   d.level as division_level,
                   bs.batting_avg, bs.on_base_pct, bs.slugging_pct, bs.ops,
                   bs.woba, bs.wrc_plus, bs.offensive_war,
                   bs.home_runs, bs.rbi, bs.stolen_bases, bs.plate_appearances,
                   bs.k_pct as bat_k_pct, bs.bb_pct as bat_bb_pct,
                   ps2.era, ps2.fip, ps2.fip_plus, ps2.era_minus, ps2.xfip, ps2.siera, ps2.strikeouts as pitch_k,
                   ps2.k_pct as pitch_k_pct, ps2.bb_pct as pitch_bb_pct,
                   ps2.innings_pitched, ps2.pitching_war,
                   """ + _PLAYER_PBP_SELECT + """
                   COALESCE(bs.offensive_war, 0) + COALESCE(ps2.pitching_war, 0) as total_war
            FROM players p
            JOIN teams t ON p.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN batting_stats bs ON p.id = bs.player_id AND bs.season = %s
            LEFT JOIN pitching_stats ps2 ON p.id = ps2.player_id AND ps2.season = %s
            LEFT JOIN bpbp ON bpbp.pid = p.id
            LEFT JOIN ppbp ON ppbp.pid = p.id
            WHERE p.id = ANY(%s)
        """
        # CTE params (bpbp season+ids, ppbp season+ids), then bs/ps2 seasons,
        # then the main id filter.
        params: list = [season, ids, season, ids, season, season, ids]
        if position:
            if position == 'P':
                query += " AND (p.position IN ('RHP','LHP') OR p.position LIKE 'RHP/%%' OR p.position LIKE 'LHP/%%')"
            elif position == 'OF':
                query += " AND (p.position IN ('OF','LF','CF','RF') OR p.position LIKE '%%/OF' OR p.position LIKE '%%/LF' OR p.position LIKE '%%/CF' OR p.position LIKE '%%/RF')"
            elif position == 'IF':
                query += " AND (p.position IN ('IF','1B','2B','3B','SS') OR p.position LIKE '%%/IF' OR p.position LIKE '%%/1B' OR p.position LIKE '%%/2B' OR p.position LIKE '%%/3B' OR p.position LIKE '%%/SS')"
            else:
                query += " AND (p.position = %s OR p.position LIKE %s OR p.position LIKE %s)"
                params.extend([position, f"{position}/%", f"%/{position}"])
        if bats:
            query += " AND p.bats = %s"
            params.append(bats)
        if throws:
            query += " AND p.throws = %s"
            params.append(throws)

        if sort_by == "era_plus":
            # era_plus is computed in Python (not a SELECT column), so derive it here.
            query += f" ORDER BY CASE WHEN ps2.era_minus > 0 THEN 10000.0 / ps2.era_minus END {direction} NULLS LAST"
        else:
            # sort_by is whitelisted to a SELECT output alias above, so it is safe to
            # interpolate. A bare name in ORDER BY resolves to the output column, which
            # works for the PBP-derived stats too. NULLS LAST keeps players who are
            # missing that stat at the bottom regardless of direction.
            query += f" ORDER BY {sort_by} {direction} NULLS LAST"

        cur.execute(query, params)
        rows = cur.fetchall()
        out = []
        for r in rows:
            d = _add_era_plus(dict(r))
            # "Committed To" reflects the portal destination we track in the
            # JSON, not the players-table commitment column.
            d["committed_to"] = committed_map.get(d["id"])
            # Position override from the JSON (for placeholders missing a DB position).
            if position_map.get(d["id"]):
                d["position"] = position_map[d["id"]]
            out.append(d)
        return out


# ============================================================
# PLAYER PROJECTIONS (2027) — dev-gated
# ============================================================

@router.get("/projections/teams")
@cached_endpoint(ttl_seconds=1800)
def projections_teams(season: int = Query(2027),
                      _user: str = Depends(require_tier("dev"))):
    """Teams that have projections for the season, for the page's team picker."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT t.id, t.short_name, t.school_name, t.logo_url, d.level,
                   COUNT(*) AS n, COUNT(*) FILTER (WHERE pp.is_incoming) AS n_incoming
            FROM player_projections pp
            JOIN teams t ON t.id = pp.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE pp.season = %s
              -- PNW teams only; drops out-of-region D1 schools that only appear
              -- because a transfer committed there (LMU, San Diego, New Mexico…)
              AND t.state IN ('WA', 'OR', 'ID', 'MT', 'BC')
            GROUP BY t.id, t.short_name, t.school_name, t.logo_url, d.level
            ORDER BY d.level, t.short_name
        """, (season,))
        return [dict(r) for r in cur.fetchall()]


@router.get("/teams/{team_id}/projections")
@cached_endpoint(ttl_seconds=1800)
def team_projections(team_id: int, season: int = Query(2027),
                     _user: str = Depends(require_tier("dev"))):
    """2027 projected hitters + pitchers for a team (returning + incoming
    transfers). Each row's `proj` holds the full projected stat line."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""SELECT id, short_name, school_name, logo_url FROM teams WHERE id = %s""", (team_id,))
        team = cur.fetchone()
        if not team:
            raise HTTPException(status_code=404, detail="Team not found")
        cur.execute("""
            SELECT pp.player_id, pp.canonical_id, pp.side, pp.name, pp.pos,
                   pp.class_last, pp.is_incoming, pp.from_team_id, pp.proj,
                   ft.short_name AS from_team
            FROM player_projections pp
            LEFT JOIN teams ft ON ft.id = pp.from_team_id
            WHERE pp.season = %s AND pp.team_id = %s
            ORDER BY pp.sort_val DESC
        """, (season, team_id))
        rows = [dict(r) for r in cur.fetchall()]
        # attach each player's 2026 actuals (by canonical id, summed across teams)
        # so the detail view can show 2026 -> 2027 (projected) and the change.
        cids = [r["canonical_id"] for r in rows] or [0]
        cur.execute("""
            WITH canon AS (SELECT linked_id AS pid, canonical_id AS cid FROM player_links)
            SELECT COALESCE(c.cid, b.player_id) AS cid,
                   SUM(b.plate_appearances) AS pa, SUM(b.at_bats) AS ab, SUM(b.hits) AS h,
                   SUM(b.doubles) AS d2, SUM(b.triples) AS d3, SUM(b.home_runs) AS hr,
                   SUM(b.walks) AS bb, SUM(b.strikeouts) AS so, SUM(b.runs) AS r, SUM(b.rbi) AS rbi,
                   ROUND(AVG(b.batting_avg)::numeric,3) AS avg, ROUND(AVG(b.on_base_pct)::numeric,3) AS obp,
                   ROUND(AVG(b.slugging_pct)::numeric,3) AS slg, ROUND(AVG(b.woba)::numeric,3) AS woba
            FROM batting_stats b LEFT JOIN canon c ON c.pid = b.player_id
            WHERE b.season = 2026 AND COALESCE(c.cid, b.player_id) = ANY(%s)
            GROUP BY 1
        """, (cids,))
        bat26 = {r["cid"]: dict(r) for r in cur.fetchall()}
        cur.execute("""
            WITH canon AS (SELECT linked_id AS pid, canonical_id AS cid FROM player_links)
            SELECT COALESCE(c.cid, p.player_id) AS cid,
                   SUM(p.batters_faced) AS bf, SUM(p.innings_pitched) AS ip,
                   ROUND(AVG(p.era)::numeric,2) AS era, ROUND(AVG(p.fip)::numeric,2) AS fip,
                   ROUND(AVG(p.k_pct)::numeric,3) AS k_pct, ROUND(AVG(p.bb_pct)::numeric,3) AS bb_pct,
                   ROUND(AVG(p.whip)::numeric,2) AS whip,
                   ROUND(SUM(p.hits_allowed)::numeric
                         / NULLIF(SUM(p.batters_faced) - SUM(p.walks) - SUM(p.hit_batters), 0), 3) AS opp_avg,
                   ROUND(SUM(p.home_runs_allowed) * 9.0
                         / NULLIF(SUM(FLOOR(p.innings_pitched) + (p.innings_pitched - FLOOR(p.innings_pitched)) * 10/3.0), 0), 2) AS hr9
            FROM pitching_stats p LEFT JOIN canon c ON c.pid = p.player_id
            WHERE p.season = 2026 AND COALESCE(c.cid, p.player_id) = ANY(%s)
            GROUP BY 1
        """, (cids,))
        pit26 = {r["cid"]: dict(r) for r in cur.fetchall()}
        hitters, pitchers = [], []
        for row in rows:
            cid = row["canonical_id"]
            row["actual_2026"] = (bat26 if row["side"] == "bat" else pit26).get(cid)
            (hitters if row["side"] == "bat" else pitchers).append(row)
        return {"team": dict(team), "season": season,
                "hitters": hitters, "pitchers": pitchers}


# ============================================================
# TEAM STATS
# ============================================================

@router.get("/teams/{team_id}/roster")
@cached_endpoint(ttl_seconds=1800)
def team_roster(team_id: int, season: Optional[int] = None):
    """Get the roster for a team."""
    with get_connection() as conn:
        cur = conn.cursor()
        query = """
            SELECT p.*
            FROM players p
            WHERE p.team_id = %s
            ORDER BY p.jersey_number, p.last_name
        """
        rows = cur.execute(query, (team_id,))
        rows = cur.fetchall()
        return [dict(r) for r in rows]


@router.get("/teams/{team_id}/active-roster")
@cached_endpoint(ttl_seconds=1800)
def team_active_roster(team_id: int, season: int = Query(..., description="Season year")):
    """Hitters (any player with at least one PA) for this team in `season`.
    Used by Lineup Helper's build-from-scratch mode. Pure pitchers without
    a single PA are excluded; two-way players show up because they have
    batting stats."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT
                p.id, p.first_name, p.last_name, p.bats, p.throws,
                p.jersey_number, p.position, p.headshot_url,
                bs.plate_appearances AS pa
            FROM players p
            JOIN batting_stats bs
              ON bs.player_id = p.id AND bs.season = %s
            WHERE p.team_id = %s
              AND COALESCE(p.is_phantom, FALSE) = FALSE
              AND bs.plate_appearances > 0
            ORDER BY p.last_name, p.first_name
            """,
            (season, team_id),
        )
        return [dict(r) for r in cur.fetchall()]


@router.get("/teams/{team_id}/stats")
@cached_endpoint(ttl_seconds=1800)
def team_stats(team_id: int, season: int = Query(...)):
    """Get team info plus full batting and pitching stat tables for a season."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT t.*, c.name as conference_name, c.abbreviation as conference_abbrev,
                      d.name as division_name, d.level as division_level
               FROM teams t
               JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id
               WHERE t.id = %s""",
            (team_id,),
        )
        team_info = cur.fetchone()

        if not team_info:
            raise HTTPException(status_code=404, detail="Team not found")

        cur.execute(
            "SELECT * FROM team_season_stats WHERE team_id = %s AND season = %s",
            (team_id, season),
        )
        team_stats_row = cur.fetchone()

        # Override every stored aggregate in team_season_stats with the
        # canonical helper's fresh values. The stored columns aren't
        # maintained by any script and go stale (Bushnell 2026 example:
        # stored RS=282 vs reality 365, stored team_era=5.80 vs ~5.20).
        # See get_team_aggregates() for source-of-truth details.
        if team_stats_row:
            team_stats_row = dict(team_stats_row)
            canonical = get_team_aggregates(cur, team_id, season)
            # Map canonical keys → team_season_stats column names
            field_map = {
                "team_era":          "team_era",
                "team_whip":         "team_whip",
                "team_avg":          "team_batting_avg",
                "team_ops":          "team_ops",
                "runs_scored":       "runs_scored",
                "runs_allowed":      "runs_allowed",
                "run_differential":  "run_differential",
            }
            for canon_key, ts_key in field_map.items():
                v = canonical.get(canon_key)
                if v is not None:
                    team_stats_row[ts_key] = v

        cur.execute(
            """SELECT bs.*, p.first_name, p.last_name, p.position, p.year_in_school,
                      p.jersey_number
               FROM batting_stats bs
               JOIN players p ON bs.player_id = p.id
               WHERE bs.team_id = %s AND bs.season = %s
               ORDER BY bs.plate_appearances DESC""",
            (team_id, season),
        )
        batting = cur.fetchall()

        # Compute is_qualified for each batter based on team games played
        team_games = 0
        if team_stats_row:
            team_games = (
                (team_stats_row.get("wins") or 0)
                + (team_stats_row.get("losses") or 0)
                + (team_stats_row.get("ties") or 0)
            )
        qualified_pa = QUALIFIED_PA_PER_GAME * team_games
        batting_list = []
        for r in batting:
            d = dict(r)
            d["is_qualified"] = (d.get("plate_appearances") or 0) >= qualified_pa
            batting_list.append(d)

        cur.execute(
            """SELECT ps.*,
                      COALESCE(ps.k_pct, 0) - COALESCE(ps.bb_pct, 0) as k_bb_pct,
                      p.first_name, p.last_name, p.position, p.year_in_school,
                      p.jersey_number
               FROM pitching_stats ps
               JOIN players p ON ps.player_id = p.id
               WHERE ps.team_id = %s AND ps.season = %s
               ORDER BY ps.innings_pitched DESC""",
            (team_id, season),
        )
        pitching = cur.fetchall()

        return {
            "team": dict(team_info),
            "team_stats": dict(team_stats_row) if team_stats_row else None,
            "batting": batting_list,
            "pitching": [_add_era_plus(dict(r)) for r in pitching],
        }



# ============================================================
# LEAGUE RUN ENVIRONMENTS
# ============================================================

@router.get("/league-environments")
@cached_endpoint(ttl_seconds=3600)
def league_environments(
    season: int = Query(..., description="Season year"),
):
    """
    Compute runs-per-game and other league-level stats by division level.
    Used for cross-level comparisons and adjusted stats.
    """
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT d.level as division_level,
                      COUNT(DISTINCT bs.team_id) as num_teams,
                      SUM(bs.plate_appearances) as total_pa,
                      SUM(bs.at_bats) as total_ab,
                      SUM(bs.hits) as total_h,
                      SUM(bs.doubles) as total_2b,
                      SUM(bs.triples) as total_3b,
                      SUM(bs.home_runs) as total_hr,
                      SUM(bs.runs) as total_r,
                      SUM(bs.walks) as total_bb,
                      SUM(bs.strikeouts) as total_k,
                      SUM(bs.stolen_bases) as total_sb,
                      SUM(bs.hit_by_pitch) as total_hbp,
                      SUM(bs.games) as total_games
               FROM batting_stats bs
               JOIN teams t ON bs.team_id = t.id
               JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id
               WHERE bs.season = %s AND bs.plate_appearances >= 10
               GROUP BY d.level
               ORDER BY d.id""",
            (season,),
        )
        rows = cur.fetchall()

        cur.execute(
            """SELECT d.level as division_level,
                      outs_to_ip(SUM(ip_outs(ps.innings_pitched))) as total_ip,
                      (SUM(ip_outs(ps.innings_pitched)) / 3.0)::float8 as total_ip_true,
                      SUM(ps.earned_runs) as total_er,
                      SUM(ps.strikeouts) as total_k,
                      SUM(ps.walks) as total_bb,
                      SUM(ps.hits_allowed) as total_h,
                      SUM(ps.home_runs_allowed) as total_hr,
                      SUM(ps.hit_batters) as total_hbp
               FROM pitching_stats ps
               JOIN teams t ON ps.team_id = t.id
               JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id
               WHERE ps.season = %s AND ps.innings_pitched >= 3
               GROUP BY d.level
               ORDER BY d.id""",
            (season,),
        )
        pitching_rows = cur.fetchall()

        pit_map = {r["division_level"]: dict(r) for r in pitching_rows}

        results = []
        for r in rows:
            level = r["division_level"]
            pit = pit_map.get(level, {})

            total_ab = r["total_ab"] or 1
            total_pa = r["total_pa"] or 1
            total_games = r["total_games"] or 1
            total_ip = pit.get("total_ip") or 1
            total_ip_calc = pit.get("total_ip_true") or 1

            # Estimate total team-games (each player's games summed / ~9 starters)
            # Better: use total_runs / (total_games / num_teams) but we'll estimate
            num_teams = r["num_teams"] or 1
            # Rough runs per game: total_runs / (total_games / 2) since each game has 2 teams
            # But total_games is sum of player games, not team games
            # Best estimate: total_runs / num_teams gives runs per team, then / (games per team)
            avg_games_per_team = total_games / (r["num_teams"] or 1) / 9  # ~9 batters
            if avg_games_per_team < 1:
                avg_games_per_team = 1
            runs_per_team = r["total_r"] / num_teams
            runs_per_game = round(runs_per_team / avg_games_per_team, 2)

            league_avg = round(r["total_h"] / total_ab, 3)
            league_obp = round((r["total_h"] + r["total_bb"] + r["total_hbp"]) / total_pa, 3)
            tb = (r["total_h"] - r["total_2b"] - r["total_3b"] - r["total_hr"]) + 2*r["total_2b"] + 3*r["total_3b"] + 4*r["total_hr"]
            league_slg = round(tb / total_ab, 3)

            league_era = round(pit.get("total_er", 0) * 9 / total_ip_calc, 2) if total_ip_calc > 0 else 0
            league_whip = round((pit.get("total_bb", 0) + pit.get("total_h", 0)) / total_ip_calc, 2) if total_ip_calc > 0 else 0

            k_pct = round(r["total_k"] / total_pa, 3)
            bb_pct = round(r["total_bb"] / total_pa, 3)

            results.append({
                "division_level": level,
                "num_teams": num_teams,
                "runs_per_game": runs_per_game,
                "league_avg": league_avg,
                "league_obp": league_obp,
                "league_slg": league_slg,
                "league_ops": round(league_obp + league_slg, 3),
                "league_era": league_era,
                "league_whip": league_whip,
                "k_pct": k_pct,
                "bb_pct": bb_pct,
                "total_hr": r["total_hr"],
                "total_sb": r["total_sb"],
                "total_ip": round(total_ip, 1),
            })

        return results


# ============================================================
# AVAILABLE SEASONS
# ============================================================

@router.get("/seasons")
@cached_endpoint(ttl_seconds=3600)
def available_seasons():
    """List all seasons with data."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT DISTINCT season FROM batting_stats ORDER BY season DESC"
        )
        batting_seasons = cur.fetchall()
        cur.execute(
            "SELECT DISTINCT season FROM pitching_stats ORDER BY season DESC"
        )
        pitching_seasons = cur.fetchall()
        all_seasons = sorted(
            set(r["season"] for r in batting_seasons) | set(r["season"] for r in pitching_seasons),
            reverse=True,
        )
        return all_seasons


# ============================================================
# ADMIN: Recalculate WAR
# ============================================================

@router.post("/admin/recalculate-war")
def recalculate_war(
    season: int = Query(..., description="Season to recalculate"),
    _admin: str = Depends(require_admin),
):
    """
    Recalculate offensive WAR for all batters in a given season using
    the current formula (with positional adjustments and replacement level).

    Also recalculates pitching WAR from the stored counting stats.

    This lets us tweak the WAR formula and re-run it without re-scraping.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # ── Build game-log position weights for every player ──
        # {player_id: {"2B": 0.9, "SS": 0.1, ...}}
        from collections import defaultdict
        _pos_counts = defaultdict(lambda: defaultdict(int))
        cur.execute("""
            SELECT gb.player_id, gb.position, COUNT(DISTINCT (g.game_date, COALESCE(g.game_number, 1))) as cnt
            FROM game_batting gb
            JOIN games g ON g.id = gb.game_id
            WHERE g.season = %s
              AND gb.player_id IS NOT NULL
              AND gb.position IS NOT NULL
              AND TRIM(gb.position) != ''
            GROUP BY gb.player_id, gb.position
        """, (season,))
        for r in cur.fetchall():
            norm = normalize_position(r["position"])
            if norm and norm != "P":
                _pos_counts[r["player_id"]][norm] += r["cnt"]

        # Convert counts to fractions
        player_position_weights = {}
        for pid, counts in _pos_counts.items():
            total = sum(counts.values())
            if total > 0:
                player_position_weights[pid] = {
                    pos: cnt / total for pos, cnt in counts.items()
                }

        # ── Recalculate batting WAR ──
        cur.execute(
            """SELECT bs.id, bs.player_id, bs.plate_appearances, bs.at_bats,
                      bs.hits, bs.doubles, bs.triples, bs.home_runs, bs.walks,
                      bs.intentional_walks, bs.hit_by_pitch, bs.sacrifice_flies,
                      bs.sacrifice_bunts, bs.strikeouts, bs.stolen_bases,
                      bs.caught_stealing, bs.grounded_into_dp, bs.wraa,
                      p.position, d.level as division_level
               FROM batting_stats bs
               JOIN players p ON bs.player_id = p.id
               JOIN teams t ON bs.team_id = t.id
               JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id
               WHERE bs.season = %s""",
            (season,),
        )
        batters = cur.fetchall()

        batting_updated = 0
        gamelog_used = 0
        roster_fallback = 0
        for b in batters:
            pos = normalize_position(b["position"]) or "UT"
            pa = b["plate_appearances"] or 0
            pid = b["player_id"]

            # Use stored wRAA to avoid recomputing everything
            class _MinBatting:
                wraa = b["wraa"] or 0.0
                off_war = 0.0  # will be overwritten

            # Check if we have game-log position weights for this player
            pw = player_position_weights.get(pid)
            if pw:
                gamelog_used += 1
            else:
                roster_fallback += 1

            div_level = b.get("division_level", "NWAC")
            war = compute_college_war(
                batting=_MinBatting(),
                position=pos,
                plate_appearances=pa,
                division_level=div_level,
                position_weights=pw,  # None = roster fallback
            )

            cur.execute(
                "UPDATE batting_stats SET offensive_war = %s WHERE id = %s",
                (war.offensive_war, b["id"]),
            )
            batting_updated += 1

        # ── Recalculate pitching WAR ──
        cur.execute(
            """SELECT ps.id, ps.innings_pitched, ps.earned_runs, ps.hits_allowed,
                      ps.walks, ps.intentional_walks, ps.strikeouts,
                      ps.home_runs_allowed, ps.hit_batters, ps.batters_faced,
                      ps.wild_pitches, ps.wins, ps.losses, ps.saves,
                      ps.games, ps.games_started, ps.runs_allowed,
                      d.level as division_level
               FROM pitching_stats ps
               JOIN teams t ON ps.team_id = t.id
               JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id
               WHERE ps.season = %s""",
            (season,),
        )
        pitchers = cur.fetchall()

        pitching_updated = 0
        for p in pitchers:
            ip = p["innings_pitched"] or 0
            if ip <= 0:
                continue

            line = PitchingLine(
                ip=ip,
                hits=p["hits_allowed"] or 0,
                er=p["earned_runs"] or 0,
                runs=p["runs_allowed"] or 0,
                bb=p["walks"] or 0,
                ibb=p["intentional_walks"] or 0,
                k=p["strikeouts"] or 0,
                hr=p["home_runs_allowed"] or 0,
                hbp=p["hit_batters"] or 0,
                bf=p["batters_faced"] or 0,
                wp=p["wild_pitches"] or 0,
                wins=p["wins"] or 0,
                losses=p["losses"] or 0,
                saves=p["saves"] or 0,
                games=p["games"] or 0,
                gs=p["games_started"] or 0,
            )
            pit_div_level = p.get("division_level", "NWAC")
            adv = compute_pitching_advanced(line, division_level=pit_div_level)

            cur.execute(
                "UPDATE pitching_stats SET pitching_war = %s, fip = %s, xfip = %s, siera = %s, "
                "k_pct = %s, bb_pct = %s WHERE id = %s",
                (adv.pitching_war, adv.fip, adv.xfip, adv.siera,
                 adv.k_pct, adv.bb_pct, p["id"]),
            )
            pitching_updated += 1

        conn.commit()

    return {
        "status": "ok",
        "season": season,
        "batting_updated": batting_updated,
        "pitching_updated": pitching_updated,
        "gamelog_positions_used": gamelog_used,
        "roster_fallback_used": roster_fallback,
    }


@router.get("/admin/unmatched-game-batting")
def unmatched_game_batting(
    limit: int = Query(50),
    _admin: str = Depends(require_admin),
):
    """Show unmatched game_batting rows to debug name matching."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT gb.player_name, gb.team_id, gb.position, t.short_name,
                   COUNT(*) as games
            FROM game_batting gb
            LEFT JOIN teams t ON gb.team_id = t.id
            WHERE gb.player_id IS NULL
              AND gb.team_id IS NOT NULL
            GROUP BY gb.player_name, gb.team_id, gb.position, t.short_name
            ORDER BY games DESC
            LIMIT %s
        """, (limit,))
        rows = cur.fetchall()

        # Also get total counts
        cur.execute("SELECT COUNT(*) as cnt FROM game_batting WHERE player_id IS NULL AND team_id IS NOT NULL")
        unmatched_with_team = cur.fetchone()["cnt"]
        cur.execute("SELECT COUNT(*) as cnt FROM game_batting WHERE player_id IS NULL AND team_id IS NULL")
        unmatched_no_team = cur.fetchone()["cnt"]
        cur.execute("SELECT COUNT(*) as cnt FROM game_batting WHERE player_id IS NOT NULL")
        matched = cur.fetchone()["cnt"]

        return {
            "matched": matched,
            "unmatched_with_team": unmatched_with_team,
            "unmatched_no_team": unmatched_no_team,
            "sample_unmatched": [dict(r) for r in rows],
        }


@router.get("/admin/debug-player-games/{player_id}")
def debug_player_games(
    player_id: int,
    season: int = Query(CURRENT_SEASON),
    _admin: str = Depends(require_admin),
):
    """Debug: show all game_batting rows for a player + unmatched rows for their team."""
    with get_connection() as conn:
        cur = conn.cursor()

        # Get player info
        cur.execute("SELECT first_name, last_name, team_id, position FROM players WHERE id = %s", (player_id,))
        player = cur.fetchone()
        if not player:
            return {"error": "player not found"}

        team_id = player["team_id"]
        full_name = f"{player['first_name']} {player['last_name']}"

        # Matched game_batting rows for this player
        cur.execute("""
            SELECT gb.player_name, gb.position, g.game_date, g.home_team_name, g.away_team_name
            FROM game_batting gb
            JOIN games g ON g.id = gb.game_id
            WHERE gb.player_id = %s AND g.season = %s
            ORDER BY g.game_date
        """, (player_id, season))
        matched = [dict(r) for r in cur.fetchall()]

        # Unmatched rows on this team that might be this player
        cur.execute("""
            SELECT gb.player_name, gb.position, g.game_date, g.home_team_name, g.away_team_name
            FROM game_batting gb
            JOIN games g ON g.id = gb.game_id
            WHERE gb.player_id IS NULL
              AND gb.team_id = %s
              AND g.season = %s
              AND (
                LOWER(gb.player_name) LIKE %s
                OR LOWER(gb.player_name) LIKE %s
              )
            ORDER BY g.game_date
        """, (team_id, season, f"%{player['last_name'].lower()}%", f"%{player['first_name'].lower()}%"))
        unmatched_maybe = [dict(r) for r in cur.fetchall()]

        # Also show ALL distinct player names for this team that are unmatched
        cur.execute("""
            SELECT gb.player_name, COUNT(*) as rows
            FROM game_batting gb
            JOIN games g ON g.id = gb.game_id
            WHERE gb.player_id IS NULL
              AND gb.team_id = %s
              AND g.season = %s
            GROUP BY gb.player_name
            ORDER BY rows DESC
        """, (team_id, season))
        all_unmatched_names = [dict(r) for r in cur.fetchall()]

        # How many total games does this team have?
        cur.execute("""
            SELECT COUNT(*) as cnt FROM games
            WHERE season = %s AND (home_team_id = %s OR away_team_id = %s)
        """, (season, team_id, team_id))
        team_games = cur.fetchone()["cnt"]

        # How many of those games have ANY game_batting data?
        cur.execute("""
            SELECT COUNT(DISTINCT g.id) as cnt
            FROM games g
            JOIN game_batting gb ON gb.game_id = g.id
            WHERE g.season = %s AND (g.home_team_id = %s OR g.away_team_id = %s)
        """, (season, team_id, team_id))
        games_with_batting = cur.fetchone()["cnt"]

        # Distinct game dates with batting data for this team
        cur.execute("""
            SELECT COUNT(DISTINCT (g.game_date, COALESCE(g.game_number, 1))) as cnt
            FROM games g
            JOIN game_batting gb ON gb.game_id = g.id
            WHERE g.season = %s AND (g.home_team_id = %s OR g.away_team_id = %s)
        """, (season, team_id, team_id))
        distinct_dates_with_batting = cur.fetchone()["cnt"]

        # For each game, show whether this player appears (matched or unmatched)
        cur.execute("""
            SELECT g.game_date, g.game_number, g.source_url,
                   g.home_team_name, g.away_team_name,
                   EXISTS(
                       SELECT 1 FROM game_batting gb2
                       WHERE gb2.game_id = g.id AND gb2.player_id = %s
                   ) as player_matched,
                   EXISTS(
                       SELECT 1 FROM game_batting gb2
                       WHERE gb2.game_id = g.id AND gb2.player_id IS NULL
                         AND gb2.team_id = %s
                         AND (LOWER(gb2.player_name) LIKE %s OR LOWER(gb2.player_name) LIKE %s)
                   ) as player_unmatched_maybe,
                   (SELECT COUNT(*) FROM game_batting gb2
                    WHERE gb2.game_id = g.id AND gb2.team_id = %s) as team_batting_rows
            FROM games g
            WHERE g.season = %s
              AND (g.home_team_id = %s OR g.away_team_id = %s)
            ORDER BY g.game_date, g.game_number
        """, (player_id, team_id,
              f"%{player['last_name'].lower()}%", f"%{player['first_name'].lower()}%",
              team_id, season, team_id, team_id))
        game_coverage = [dict(r) for r in cur.fetchall()]

        return {
            "player": full_name,
            "team_id": team_id,
            "team_total_games_in_db": team_games,
            "team_games_with_batting_data": games_with_batting,
            "team_distinct_dates_with_batting": distinct_dates_with_batting,
            "player_matched_rows": len(matched),
            "player_distinct_dates": len(set(r["game_date"].isoformat() if r["game_date"] else "" for r in matched)),
            "unmatched_maybe_rows": len(unmatched_maybe),
            "all_unmatched_names_on_team": all_unmatched_names[:30],
            "game_by_game": game_coverage,
        }


@router.get("/admin/team-game-coverage/{team_id}")
def team_game_coverage(
    team_id: int,
    season: int = Query(CURRENT_SEASON),
    _admin: str = Depends(require_admin),
):
    """Show which games have box score data and which don't."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT g.id, g.game_date, g.game_number, g.source_url,
                   g.home_team_name, g.away_team_name, g.home_score, g.away_score,
                   (SELECT COUNT(*) FROM game_batting gb WHERE gb.game_id = g.id) as batting_rows
            FROM games g
            WHERE g.season = %s
              AND (g.home_team_id = %s OR g.away_team_id = %s)
            ORDER BY g.game_date, g.game_number
        """, (season, team_id, team_id))
        rows = cur.fetchall()

        with_data = [dict(r) for r in rows if r["batting_rows"] > 0]
        without_data = [dict(r) for r in rows if r["batting_rows"] == 0]

        return {
            "team_id": team_id,
            "total_game_records": len(rows),
            "games_with_batting_data": len(with_data),
            "games_without_batting_data": len(without_data),
            "without_data": without_data,
        }


# ============================================================
# ADMIN: Derive primary positions from game logs
# ============================================================

@router.post("/admin/derive-positions")
def derive_positions(
    season: int = Query(..., description="Season to analyse"),
    threshold: float = Query(0.6, description="Min fraction to assign a single position (default 0.6 = 60%)"),
    _admin: str = Depends(require_admin),
):
    """
    Look at game_batting to see what position each player actually played
    in each game. If one position accounts for >= threshold of their games,
    set that as the player's position. Otherwise label them UT (utility).

    Pitchers (players who appear in game_pitching but NOT game_batting,
    or whose roster position is already P with no batting game logs)
    are left untouched.

    Returns a summary of how many players were updated and a sample of changes.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # Get every player's game-by-game position from box scores
        cur.execute("""
            SELECT gb.player_id,
                   gb.position,
                   COUNT(DISTINCT (g.game_date, COALESCE(g.game_number, 1))) as games_at_pos
            FROM game_batting gb
            JOIN games g ON g.id = gb.game_id
            WHERE g.season = %s
              AND gb.player_id IS NOT NULL
              AND gb.position IS NOT NULL
              AND TRIM(gb.position) != ''
            GROUP BY gb.player_id, gb.position
            ORDER BY gb.player_id, games_at_pos DESC
        """, (season,))
        rows = cur.fetchall()

        # Build a dict: player_id -> {position: count, ...}
        from collections import defaultdict
        player_pos_counts = defaultdict(dict)
        for r in rows:
            pid = r["player_id"]
            raw_pos = r["position"]
            # Normalize the game-log position the same way we do roster positions
            norm = normalize_position(raw_pos)
            if norm and norm != "P":
                # Accumulate (game logs may have slightly different raw strings
                # that normalize to the same thing, e.g. "SS" and "ss")
                player_pos_counts[pid][norm] = player_pos_counts[pid].get(norm, 0) + r["games_at_pos"]

        updated = 0
        skipped = 0
        changes = []  # sample of changes for the response

        for pid, pos_dict in player_pos_counts.items():
            total_games = sum(pos_dict.values())
            if total_games == 0:
                skipped += 1
                continue

            # Sort positions by games played descending
            sorted_positions = sorted(pos_dict.items(), key=lambda x: -x[1])
            top_pos, top_count = sorted_positions[0]
            fraction = top_count / total_games

            if fraction >= threshold:
                new_position = top_pos
            else:
                new_position = "UT"

            # Get current position to see if it changed
            cur.execute("SELECT position FROM players WHERE id = %s", (pid,))
            current = cur.fetchone()
            if not current:
                skipped += 1
                continue

            old_position = current["position"]
            old_norm = normalize_position(old_position) if old_position else None

            # Only update if position actually changed
            if old_norm != new_position:
                cur.execute(
                    "UPDATE players SET position = %s WHERE id = %s",
                    (new_position, pid),
                )
                updated += 1
                if len(changes) < 25:  # keep first 25 changes as sample
                    changes.append({
                        "player_id": pid,
                        "old": old_position,
                        "old_normalized": old_norm,
                        "new": new_position,
                        "games": total_games,
                        "breakdown": {k: v for k, v in sorted_positions},
                    })
            else:
                skipped += 1

        conn.commit()

    return {
        "status": "ok",
        "season": season,
        "threshold": threshold,
        "players_with_gamelogs": len(player_pos_counts),
        "positions_updated": updated,
        "unchanged": skipped,
        "sample_changes": changes,
    }


# ── Park Factors ──────────────────────────────────────────────

_PARK_FACTORS_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "data", "park_factors.json"
)


@router.get("/park-factors")
@cached_endpoint(ttl_seconds=3600)
def get_park_factors(
    state: Optional[str] = Query(None),
    division_id: Optional[int] = Query(None),
    conference_id: Optional[int] = Query(None),
    _user: str = Depends(require_tier("premium")),
):
    """
    Return park factor data for all PNW teams.
    Optionally filter by state, division, or conference.
    Enriches each entry with division/conference info from the DB.
    """
    # Load the JSON data
    try:
        with open(os.path.normpath(_PARK_FACTORS_PATH), "r") as f:
            park_data = json.load(f)
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="Park factors data file not found")

    teams = park_data.get("teams", [])

    # Enrich with division/conference from DB and apply filters
    with get_connection() as conn:
        cur = conn.cursor()

        # Get team → division/conference mapping
        team_info = {}
        cur.execute("""
            SELECT t.id as team_id, t.name as team_name, t.short_name,
                   t.mascot, t.state, t.city,
                   c.id as conference_id, c.name as conference_name,
                   d.id as division_id, d.name as division_name
            FROM teams t
            LEFT JOIN conferences c ON t.conference_id = c.id
            LEFT JOIN divisions d ON c.division_id = d.id
        """)
        rows = cur.fetchall()
        for r in rows:
            team_info[r["team_id"]] = r

    # Merge DB info into park data and apply filters
    result = []
    for park in teams:
        tid = park.get("team_id")
        info = team_info.get(tid, {})

        # Apply filters
        if state and info.get("state") != state:
            continue
        if division_id and info.get("division_id") != division_id:
            continue
        if conference_id and info.get("conference_id") != conference_id:
            continue

        # Merge
        park["team_name"] = info.get("team_name", park.get("short_name", ""))
        park["mascot"] = info.get("mascot", "")
        park["conference_name"] = info.get("conference_name", "")
        park["division_name"] = info.get("division_name", "")
        park["division_id"] = info.get("division_id")
        park["conference_id"] = info.get("conference_id")
        result.append(park)

    # Sort by park factor (highest first) as default
    result.sort(key=lambda x: x.get("park_factor_pct", 0), reverse=True)

    return {
        "teams": result,
        "methodology": park_data.get("methodology", ""),
        "baseline_dimensions": park_data.get("baseline_dimensions", ""),
        "baseline_temperature_f": park_data.get("baseline_temperature_f", 60),
        "last_updated": park_data.get("last_updated", ""),
        "total": len(result),
    }


# ============================================================
# CONFERENCE CHAMPIONS
# ============================================================

@router.get("/teams/{team_id}/championships")
@cached_endpoint(ttl_seconds=3600)
def team_championships(team_id: int):
    """Get all conference championships won by a team."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT cc.season, cc.conference, cc.championship_type, cc.team_name
            FROM conference_champions cc
            WHERE cc.team_id = %s
            ORDER BY cc.season DESC, cc.championship_type
        """, (team_id,))
        titles = [dict(r) for r in cur.fetchall()]
        return {"team_id": team_id, "championships": titles, "total": len(titles)}


# ============================================================
# TEAM HISTORY
# ============================================================

@router.get("/teams/{team_id}/history")
@cached_endpoint(ttl_seconds=3600)
def team_history(team_id: int):
    """
    Comprehensive team history: year-by-year records, season stat leaders,
    all-time career leaders, and trend data.
    """
    with get_connection() as conn:
        cur = conn.cursor()
        # ---- Team info ----
        cur.execute(
            """SELECT t.*, c.name as conference_name, c.abbreviation as conference_abbrev,
                      d.name as division_name, d.level as division_level
               FROM teams t
               JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id
               WHERE t.id = %s""",
            (team_id,),
        )
        team_info = cur.fetchone()
        if not team_info:
            raise HTTPException(status_code=404, detail="Team not found")

        # ---- Year-by-year team season stats ----
        cur.execute(
            """SELECT s.*,
                      cr.composite_rank, cr.national_percentile, cr.composite_sos_rank,
                      cr.pear_rank, cr.cbr_rank
               FROM team_season_stats s
               LEFT JOIN composite_rankings cr ON cr.team_id = s.team_id AND cr.season = s.season
               WHERE s.team_id = %s
               ORDER BY s.season DESC""",
            (team_id,),
        )
        seasons_rows = cur.fetchall()
        seasons = [dict(r) for r in seasons_rows]

        # Compute team-level aggregate stats per season (total oWAR, pWAR, wRC+, ERA)
        for s in seasons:
            yr = s["season"]
            cur.execute(
                """SELECT COUNT(*) as num_batters,
                          SUM(plate_appearances) as total_pa,
                          SUM(at_bats) as total_ab,
                          SUM(hits) as total_h,
                          SUM(home_runs) as total_hr,
                          SUM(runs) as total_r,
                          SUM(rbi) as total_rbi,
                          SUM(stolen_bases) as total_sb,
                          SUM(offensive_war) as total_owar,
                          -- Both numerator and denominator must require wrc_plus IS NOT NULL,
                          -- otherwise NULL-wRC+ rows add PA to the denominator only and silently
                          -- deflate the weighted average.
                          SUM(CASE WHEN plate_appearances >= 50 AND wrc_plus IS NOT NULL
                                   THEN wrc_plus * plate_appearances ELSE 0 END) as weighted_wrc,
                          SUM(CASE WHEN plate_appearances >= 50 AND wrc_plus IS NOT NULL
                                   THEN plate_appearances ELSE 0 END) as qualified_pa
                   FROM batting_stats WHERE team_id = %s AND season = %s""",
                (team_id, yr),
            )
            bat_agg = cur.fetchone()
            # Note: innings_pitched is stored in baseball notation (5.2 = 5 2/3),
            # so naive SUM treats 5.2 as a decimal and undercounts. The
            # `total_true_ip` expression converts each row's notation to a
            # true decimal innings count before summing. `total_ip` is the
            # baseball-notation display total via outs_to_ip(SUM(ip_outs(...))).
            # FIP weighting weights by outs (ip_outs) in both numerator and
            # denominator so the /3 conversion cancels.
            cur.execute(
                """SELECT COUNT(*) as num_pitchers,
                          outs_to_ip(SUM(ip_outs(innings_pitched))) as total_ip,
                          SUM(
                            FLOOR(innings_pitched) +
                            CASE
                              WHEN ROUND((innings_pitched - FLOOR(innings_pitched))::numeric * 10) = 1
                                THEN 1.0/3.0
                              WHEN ROUND((innings_pitched - FLOOR(innings_pitched))::numeric * 10) = 2
                                THEN 2.0/3.0
                              ELSE 0
                            END
                          ) as total_true_ip,
                          SUM(earned_runs) as total_er_ps,
                          SUM(walks) as total_bb_pit,
                          SUM(hits_allowed) as total_h_allowed,
                          SUM(strikeouts) as total_k,
                          SUM(wins) as total_w,
                          SUM(losses) as total_l,
                          SUM(saves) as total_sv,
                          SUM(pitching_war) as total_pwar,
                          SUM(CASE WHEN innings_pitched >= 10 AND fip IS NOT NULL
                                   THEN fip * ip_outs(innings_pitched) ELSE 0 END) as weighted_fip,
                          SUM(CASE WHEN innings_pitched >= 10 AND fip IS NOT NULL
                                   THEN ip_outs(innings_pitched) ELSE 0 END) as qualified_ip
                   FROM pitching_stats WHERE team_id = %s AND season = %s""",
                (team_id, yr),
            )
            pit_agg = cur.fetchone()
            # Batting aggregates for team_batting_avg + team_ops recompute.
            cur.execute(
                """SELECT
                     SUM(at_bats) AS total_ab,
                     SUM(hits) AS total_h_bat,
                     SUM(walks) AS total_bb_bat,
                     SUM(hit_by_pitch) AS total_hbp,
                     SUM(sacrifice_flies) AS total_sf,
                     SUM(doubles) AS total_2b,
                     SUM(triples) AS total_3b,
                     SUM(home_runs) AS total_hr_bat
                   FROM batting_stats WHERE team_id = %s AND season = %s""",
                (team_id, yr),
            )
            bat_team = cur.fetchone()

            # ER comes from game_pitching (per-game truth) when we have any
            # box-score coverage for this team-season; the cumulative
            # pitching_stats can carry stale ER from before scoring
            # corrections. For older seasons where game_pitching is empty
            # (we only started per-game scraping recently), fall back to
            # pitching_stats — those past-season totals don't drift since
            # the season is closed.
            cur.execute(
                """SELECT SUM(gp.earned_runs) AS total_er, COUNT(*) AS n
                   FROM game_pitching gp
                   JOIN games g ON g.id = gp.game_id
                   WHERE gp.team_id = %s
                     AND g.season = %s
                     AND gp.team_id IN (g.home_team_id, g.away_team_id)""",
                (team_id, yr),
            )
            er_agg = cur.fetchone()

            s["total_owar"] = round(bat_agg["total_owar"] or 0, 1)
            s["total_pwar"] = round(pit_agg["total_pwar"] or 0, 1)
            s["total_war"] = round((bat_agg["total_owar"] or 0) + (pit_agg["total_pwar"] or 0), 1)
            s["total_hr"] = bat_agg["total_hr"] or 0
            s["total_sb"] = bat_agg["total_sb"] or 0
            s["total_k_pitching"] = pit_agg["total_k"] or 0
            s["total_sv"] = pit_agg["total_sv"] or 0
            qpa = bat_agg["qualified_pa"] or 0
            s["team_wrc_plus"] = round(bat_agg["weighted_wrc"] / qpa, 1) if qpa > 0 else None
            qip = pit_agg["qualified_ip"] or 0
            s["team_fip"] = round(pit_agg["weighted_fip"] / qip, 2) if qip > 0 else None
            # ── Override every stored team_season_stats aggregate with
            # the canonical helper's fresh values. The stored columns
            # aren't maintained by any script and go stale during the
            # season. See get_team_aggregates() for source-of-truth
            # details (game_pitching ER, true baseball-notation IP,
            # NCAA OBP convention, RS/RA from games table, etc.).
            canonical = get_team_aggregates(cur, team_id, yr)
            # team_era/whip/avg/ops always overridden — those come from per-
            # player tables (batting_stats / pitching_stats) which are
            # populated for all seasons.
            for canon_key, ts_key in [
                ("team_era",  "team_era"),
                ("team_whip", "team_whip"),
                ("team_avg",  "team_batting_avg"),
                ("team_ops",  "team_ops"),
            ]:
                v = canonical.get(canon_key)
                if v is not None:
                    s[ts_key] = v
            # RS/RA/run_diff come from the games table. For older seasons
            # pre-games-table population, canonical returns 0 — fall back to
            # the stored team_season_stats values in that case. Compute
            # run_differential from whichever RS/RA we end up using so it
            # always matches the displayed numbers (rather than being
            # overridden to 0 separately).
            canon_rs = canonical.get("runs_scored") or 0
            canon_ra = canonical.get("runs_allowed") or 0
            if canon_rs > 0 or canon_ra > 0:
                s["runs_scored"] = canon_rs
                s["runs_allowed"] = canon_ra
                s["run_differential"] = canon_rs - canon_ra
            else:
                # Older season — keep stored RS/RA, recompute run_diff from them
                rs = s.get("runs_scored") or 0
                ra = s.get("runs_allowed") or 0
                s["run_differential"] = rs - ra

        # ---- Season stat leaders (top player per category per season) ----
        available_seasons = [s["season"] for s in seasons]
        season_leaders = {}
        for yr in available_seasons:
            leaders = {}

            # Batting leaders
            bat_categories = [
                ("batting_avg", "AVG", 50, "DESC"),
                ("home_runs", "HR", 1, "DESC"),
                ("rbi", "RBI", 1, "DESC"),
                ("hits", "H", 1, "DESC"),
                ("stolen_bases", "SB", 1, "DESC"),
                ("wrc_plus", "wRC+", 75, "DESC"),
                ("offensive_war", "oWAR", 50, "DESC"),
            ]
            for col, label, min_pa, direction in bat_categories:
                cur.execute(
                    f"""SELECT bs.{col} as value, bs.plate_appearances as pa,
                               p.first_name, p.last_name, p.id as player_id, p.position
                        FROM batting_stats bs
                        JOIN players p ON bs.player_id = p.id
                        WHERE bs.team_id = %s AND bs.season = %s
                              AND bs.plate_appearances >= %s
                              AND bs.{col} IS NOT NULL
                        ORDER BY bs.{col} {direction}
                        LIMIT 1""",
                    (team_id, yr, min_pa),
                )
                row = cur.fetchone()
                if row:
                    leaders[label] = {
                        "player_id": row["player_id"],
                        "name": f"{row['first_name']} {row['last_name']}",
                        "position": row["position"],
                        "value": row["value"],
                    }

            # Pitching leaders
            pit_categories = [
                ("era", "ERA", 20, "ASC"),
                ("strikeouts", "K", 10, "DESC"),
                ("fip", "FIP", 20, "ASC"),
                ("wins", "W", 1, "DESC"),
                ("saves", "SV", 1, "DESC"),
                ("pitching_war", "pWAR", 20, "DESC"),
            ]
            for col, label, min_ip, direction in pit_categories:
                ip_col = "innings_pitched"
                cur.execute(
                    f"""SELECT ps.{col} as value, ps.innings_pitched as ip,
                               p.first_name, p.last_name, p.id as player_id, p.position
                        FROM pitching_stats ps
                        JOIN players p ON ps.player_id = p.id
                        WHERE ps.team_id = %s AND ps.season = %s
                              AND ps.{ip_col} >= %s
                              AND ps.{col} IS NOT NULL
                        ORDER BY ps.{col} {direction}
                        LIMIT 1""",
                    (team_id, yr, min_ip),
                )
                row = cur.fetchone()
                if row:
                    leaders[label] = {
                        "player_id": row["player_id"],
                        "name": f"{row['first_name']} {row['last_name']}",
                        "position": row["position"],
                        "value": row["value"],
                    }

            season_leaders[str(yr)] = leaders

        # ---- All-time career stat leaders (aggregate across seasons) ----
        # Batting career leaders
        cur.execute(
            """SELECT p.id as player_id, p.first_name, p.last_name, p.position,
                      COUNT(DISTINCT bs.season) as num_seasons,
                      STRING_AGG(DISTINCT bs.season::text, ', ') as seasons_played,
                      SUM(bs.plate_appearances) as career_pa,
                      SUM(bs.at_bats) as career_ab,
                      SUM(bs.hits) as career_h,
                      SUM(bs.doubles) as career_2b,
                      SUM(bs.triples) as career_3b,
                      SUM(bs.home_runs) as career_hr,
                      SUM(bs.runs) as career_r,
                      SUM(bs.rbi) as career_rbi,
                      SUM(bs.walks) as career_bb,
                      SUM(bs.strikeouts) as career_k,
                      SUM(bs.stolen_bases) as career_sb,
                      SUM(bs.offensive_war) as career_owar,
                      CASE WHEN SUM(bs.at_bats) > 0
                           THEN ROUND(CAST(SUM(bs.hits) AS numeric) / SUM(bs.at_bats), 3)
                           ELSE NULL END as career_avg,
                      CASE WHEN SUM(bs.at_bats) > 0
                           THEN ROUND(CAST(SUM(bs.home_runs) AS numeric) / SUM(bs.at_bats) +
                                      CAST(SUM(bs.hits) - SUM(bs.home_runs) - SUM(bs.triples) -
                                           SUM(bs.doubles) AS numeric) / SUM(bs.at_bats) +
                                      2.0 * CAST(SUM(bs.doubles) AS numeric) / SUM(bs.at_bats) +
                                      3.0 * CAST(SUM(bs.triples) AS numeric) / SUM(bs.at_bats) +
                                      4.0 * CAST(SUM(bs.home_runs) AS numeric) / SUM(bs.at_bats), 3)
                           ELSE NULL END as career_slg,
                      CASE WHEN (SUM(bs.at_bats) + SUM(bs.walks) + COALESCE(SUM(bs.hit_by_pitch), 0) + COALESCE(SUM(bs.sacrifice_flies), 0)) > 0
                           THEN ROUND(CAST(SUM(bs.hits) + SUM(bs.walks) + COALESCE(SUM(bs.hit_by_pitch), 0) AS numeric) /
                                (SUM(bs.at_bats) + SUM(bs.walks) + COALESCE(SUM(bs.hit_by_pitch), 0) + COALESCE(SUM(bs.sacrifice_flies), 0)), 3)
                           ELSE NULL END as career_obp
               FROM batting_stats bs
               JOIN players p ON bs.player_id = p.id
               WHERE bs.team_id = %s
               GROUP BY p.id
               HAVING SUM(bs.plate_appearances) >= 50
               ORDER BY career_owar DESC""",
            (team_id,),
        )
        career_batting = cur.fetchall()

        # Build career batting leader lists for multiple categories
        career_bat_leaders = {}
        bat_career_cats = [
            ("career_owar", "oWAR", True),
            ("career_avg", "AVG", True),
            ("career_hr", "HR", True),
            ("career_rbi", "RBI", True),
            ("career_h", "H", True),
            ("career_sb", "SB", True),
            ("career_r", "R", True),
            ("career_bb", "BB", True),
        ]
        for col, label, desc in bat_career_cats:
            sorted_rows = sorted(
                [dict(r) for r in career_batting],
                key=lambda x: x.get(col) or -999,
                reverse=desc,
            )
            career_bat_leaders[label] = [
                {
                    "player_id": r["player_id"],
                    "name": f"{r['first_name']} {r['last_name']}",
                    "position": r["position"],
                    "value": r[col],
                    "seasons": r["num_seasons"],
                    "seasons_played": r["seasons_played"],
                }
                for r in sorted_rows[:10]
                if r.get(col) is not None
            ]

        # Pitching career leaders
        cur.execute(
            """SELECT p.id as player_id, p.first_name, p.last_name, p.position,
                      COUNT(DISTINCT ps.season) as num_seasons,
                      STRING_AGG(DISTINCT ps.season::text, ', ') as seasons_played,
                      outs_to_ip(SUM(ip_outs(ps.innings_pitched))) as career_ip,
                      SUM(ps.strikeouts) as career_k,
                      SUM(ps.wins) as career_w,
                      SUM(ps.losses) as career_l,
                      SUM(ps.saves) as career_sv,
                      SUM(ps.earned_runs) as career_er,
                      SUM(ps.walks) as career_bb,
                      SUM(ps.hits_allowed) as career_ha,
                      SUM(ps.pitching_war) as career_pwar,
                      CASE WHEN SUM(ip_outs(ps.innings_pitched)) > 0
                           THEN ROUND((9.0 * SUM(ps.earned_runs)::numeric / NULLIF(SUM(ip_outs(ps.innings_pitched)) / 3.0, 0))::numeric, 2)
                           ELSE NULL END as career_era,
                      CASE WHEN SUM(ip_outs(ps.innings_pitched)) > 0
                           THEN ROUND(((SUM(ps.walks) + SUM(ps.hits_allowed))::numeric / NULLIF(SUM(ip_outs(ps.innings_pitched)) / 3.0, 0))::numeric, 2)
                           ELSE NULL END as career_whip
               FROM pitching_stats ps
               JOIN players p ON ps.player_id = p.id
               WHERE ps.team_id = %s
               GROUP BY p.id
               HAVING SUM(ip_outs(ps.innings_pitched)) / 3.0 >= 20
               ORDER BY career_pwar DESC""",
            (team_id,),
        )
        career_pitching = cur.fetchall()

        career_pit_leaders = {}
        pit_career_cats = [
            ("career_pwar", "pWAR", True),
            ("career_era", "ERA", False),
            ("career_k", "K", True),
            ("career_w", "W", True),
            ("career_sv", "SV", True),
            ("career_ip", "IP", True),
            ("career_whip", "WHIP", False),
        ]
        for col, label, desc in pit_career_cats:
            sorted_rows = sorted(
                [dict(r) for r in career_pitching],
                key=lambda x: x.get(col) if x.get(col) is not None else (999 if not desc else -999),
                reverse=desc,
            )
            career_pit_leaders[label] = [
                {
                    "player_id": r["player_id"],
                    "name": f"{r['first_name']} {r['last_name']}",
                    "position": r["position"],
                    "value": r[col],
                    "seasons": r["num_seasons"],
                    "seasons_played": r["seasons_played"],
                }
                for r in sorted_rows[:10]
                if r.get(col) is not None
            ]

        # ---- Single-season records (top 5 per category) ----
        # Mirrors career leaders but aggregates to (player, season) rows
        # rather than career-totaled. Qualifiers: 50 PA for batting,
        # 20 IP for pitching (rate-stat exclusions still applied via the
        # underlying NULL guards).
        cur.execute(
            """SELECT p.id AS player_id, p.first_name, p.last_name, p.position,
                      bs.season,
                      bs.plate_appearances AS pa,
                      bs.batting_avg AS avg,
                      bs.on_base_pct AS obp,
                      bs.slugging_pct AS slg,
                      bs.ops,
                      bs.wrc_plus,
                      bs.home_runs AS hr,
                      bs.rbi,
                      bs.hits AS h,
                      bs.runs AS r,
                      bs.walks AS bb,
                      bs.stolen_bases AS sb,
                      bs.offensive_war AS owar
               FROM batting_stats bs
               JOIN players p ON p.id = bs.player_id
               WHERE bs.team_id = %s
                 AND bs.plate_appearances >= 50""",
            (team_id,),
        )
        season_batting = [dict(r) for r in cur.fetchall()]

        season_bat_records = {}
        bat_season_cats = [
            ("owar", "oWAR", True),
            ("avg",  "AVG",  True),
            ("ops",  "OPS",  True),
            ("wrc_plus", "wRC+", True),
            ("hr",   "HR",   True),
            ("rbi",  "RBI",  True),
            ("h",    "H",    True),
            ("sb",   "SB",   True),
            ("r",    "R",    True),
            ("bb",   "BB",   True),
        ]
        for col, label, desc in bat_season_cats:
            sorted_rows = sorted(
                [r for r in season_batting if r.get(col) is not None],
                key=lambda x: x[col],
                reverse=desc,
            )
            season_bat_records[label] = [
                {
                    "player_id": r["player_id"],
                    "name": f"{r['first_name']} {r['last_name']}",
                    "position": r["position"],
                    "season": r["season"],
                    "value": r[col],
                    "pa": r["pa"],
                }
                for r in sorted_rows[:5]
            ]

        cur.execute(
            """SELECT p.id AS player_id, p.first_name, p.last_name, p.position,
                      ps.season,
                      ps.innings_pitched AS ip,
                      ps.era,
                      ps.whip,
                      ps.fip,
                      ps.strikeouts AS k,
                      ps.wins AS w,
                      ps.saves AS sv,
                      ps.pitching_war AS pwar
               FROM pitching_stats ps
               JOIN players p ON p.id = ps.player_id
               WHERE ps.team_id = %s
                 AND ps.innings_pitched >= 20""",
            (team_id,),
        )
        season_pitching = [dict(r) for r in cur.fetchall()]

        season_pit_records = {}
        pit_season_cats = [
            ("pwar", "pWAR", True),
            ("era",  "ERA",  False),
            ("whip", "WHIP", False),
            ("fip",  "FIP",  False),
            ("k",    "K",    True),
            ("w",    "W",    True),
            ("sv",   "SV",   True),
            ("ip",   "IP",   True),
        ]
        for col, label, desc in pit_season_cats:
            sorted_rows = sorted(
                [r for r in season_pitching if r.get(col) is not None],
                key=lambda x: x[col],
                reverse=desc,
            )
            season_pit_records[label] = [
                {
                    "player_id": r["player_id"],
                    "name": f"{r['first_name']} {r['last_name']}",
                    "position": r["position"],
                    "season": r["season"],
                    "value": r[col],
                    "ip": float(r["ip"]) if r["ip"] is not None else None,
                }
                for r in sorted_rows[:5]
            ]

        # ---- All-time totals summary ----
        cur.execute(
            """SELECT SUM(wins) as total_wins, SUM(losses) as total_losses,
                      SUM(ties) as total_ties,
                      SUM(conference_wins) as total_conf_wins,
                      SUM(conference_losses) as total_conf_losses,
                      SUM(runs_scored) as total_rs, SUM(runs_allowed) as total_ra,
                      COUNT(*) as num_seasons
               FROM team_season_stats WHERE team_id = %s""",
            (team_id,),
        )
        all_time = cur.fetchone()

        all_time_summary = dict(all_time) if all_time else {}
        tw = all_time_summary.get("total_wins") or 0
        tl = all_time_summary.get("total_losses") or 0
        if tw + tl > 0:
            all_time_summary["win_pct"] = round(tw / (tw + tl), 3)
        else:
            all_time_summary["win_pct"] = None

        cw = all_time_summary.get("total_conf_wins") or 0
        cl = all_time_summary.get("total_conf_losses") or 0
        if cw + cl > 0:
            all_time_summary["conf_win_pct"] = round(cw / (cw + cl), 3)
        else:
            all_time_summary["conf_win_pct"] = None

        return {
            "team": dict(team_info),
            "seasons": seasons,
            "season_leaders": season_leaders,
            "career_batting_leaders": career_bat_leaders,
            "career_pitching_leaders": career_pit_leaders,
            "single_season_batting_records": season_bat_records,
            "single_season_pitching_records": season_pit_records,
            "all_time_summary": all_time_summary,
        }


# ============================================================
# GAME RESULTS & BOX SCORES
# ============================================================

import re as _re

def _game_words(game):
    """Extract lowercase words (3+ chars) from both team display names."""
    home = game.get("home_name") or game.get("home_short") or game.get("home_team_name") or ""
    away = game.get("away_name") or game.get("away_short") or game.get("away_team_name") or ""
    return set(_re.findall(r"[a-z]{3,}", (home + " " + away).lower()))


def _is_duplicate(a, b):
    """True if b is a duplicate of a (same real-world game)."""
    # Must be on the same date
    if str(a.get("game_date")) != str(b.get("game_date")):
        return False
    # Scores must match (possibly swapped home/away)
    if not (
        (a.get("home_score") == b.get("away_score") and a.get("away_score") == b.get("home_score"))
        or (a.get("home_score") == b.get("home_score") and a.get("away_score") == b.get("away_score"))
    ):
        return False
    # Check 1: team ID overlap (reliable when IDs are resolved)
    ids_a = {a.get("home_team_id"), a.get("away_team_id")} - {None}
    ids_b = {b.get("home_team_id"), b.get("away_team_id")} - {None}
    if ids_a & ids_b:
        return True
    # Check 2: at least 2 common name-words (catches unresolved team names
    # like "Lewis-Clark State College (Idaho)" vs "LCSC" + "College of Idaho")
    if len(_game_words(a) & _game_words(b)) >= 2:
        return True
    return False


def _dedup_games(games, limit):
    """Remove duplicate game records, keeping the first (lower id) version."""
    deduped = []
    for g in games:
        if not any(_is_duplicate(prev, g) for prev in deduped):
            deduped.append(g)
    return deduped[:limit]


@router.get("/games/recent")
def recent_games(
    season: int = CURRENT_SEASON,
    limit: int = 20,
    team_id: Optional[int] = None,
    division: Optional[str] = None,
):
    """
    Get recent game results, newest first.
    Used for the homepage ticker and results page.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        conditions = ["g.season = %s", "g.status = 'final'"]
        params = [season]

        if team_id:
            conditions.append("(g.home_team_id = %s OR g.away_team_id = %s)")
            params.extend([team_id, team_id])

        if division:
            conditions.append("""
                (g.home_team_id IN (
                    SELECT t.id FROM teams t
                    JOIN conferences c ON t.conference_id = c.id
                    JOIN divisions d ON c.division_id = d.id
                    WHERE d.level = %s
                ) OR g.away_team_id IN (
                    SELECT t.id FROM teams t
                    JOIN conferences c ON t.conference_id = c.id
                    JOIN divisions d ON c.division_id = d.id
                    WHERE d.level = %s
                ))
            """)
            params.extend([division, division])

        where = " AND ".join(conditions)

        # Fetch extra rows so we have room after dedup
        cur.execute(f"""
            SELECT
                g.id, g.season, g.game_date, g.game_time,
                g.home_team_id, g.away_team_id,
                g.home_team_name, g.away_team_name,
                g.home_score, g.away_score,
                g.innings, g.is_conference_game,
                g.home_hits, g.home_errors,
                g.away_hits, g.away_errors,
                g.home_line_score, g.away_line_score,
                g.game_score, g.status,
                ht.short_name AS home_short,
                ht.logo_url AS home_logo,
                at2.short_name AS away_short,
                at2.logo_url AS away_logo,
                hd.level AS home_division,
                ad.level AS away_division
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at2 ON g.away_team_id = at2.id
            LEFT JOIN conferences hc ON ht.conference_id = hc.id
            LEFT JOIN divisions hd ON hc.division_id = hd.id
            LEFT JOIN conferences ac ON at2.conference_id = ac.id
            LEFT JOIN divisions ad ON ac.division_id = ad.id
            WHERE {where}
            ORDER BY g.game_date DESC, g.id DESC
            LIMIT %s
        """, params + [limit * 3])

        games = [dict(g) for g in cur.fetchall()]
        return _dedup_games(games, limit)


@router.get("/games/by-date")
def games_by_date(
    date: str = Query(..., description="Date in YYYY-MM-DD format"),
    division: Optional[str] = None,
):
    """
    Get all games for a specific date. Used by the scoreboard date picker.
    Returns games ordered by status (live first, then final, then scheduled).
    """
    with get_connection() as conn:
        cur = conn.cursor()

        conditions = ["g.game_date = %s", "g.home_team_id != g.away_team_id"]
        params: list = [date]

        if division:
            conditions.append("""
                (g.home_team_id IN (
                    SELECT t.id FROM teams t
                    JOIN conferences c ON t.conference_id = c.id
                    JOIN divisions d ON c.division_id = d.id
                    WHERE d.level = %s
                ) OR g.away_team_id IN (
                    SELECT t.id FROM teams t
                    JOIN conferences c ON t.conference_id = c.id
                    JOIN divisions d ON c.division_id = d.id
                    WHERE d.level = %s
                ))
            """)
            params.extend([division, division])

        where = " AND ".join(conditions)

        cur.execute(f"""
            SELECT
                g.id, g.season, g.game_date, g.game_time,
                g.home_team_id, g.away_team_id,
                g.home_team_name, g.away_team_name, g.source_url,
                g.home_score, g.away_score,
                g.innings, g.is_conference_game,
                g.home_hits, g.home_errors,
                g.away_hits, g.away_errors,
                g.home_line_score, g.away_line_score,
                g.game_score, g.status,
                ht.short_name AS home_short,
                ht.logo_url AS home_logo,
                at2.short_name AS away_short,
                at2.logo_url AS away_logo,
                hd.level AS home_division,
                ad.level AS away_division,
                ht.stats_url AS home_stats_url,
                at2.stats_url AS away_stats_url
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at2 ON g.away_team_id = at2.id
            LEFT JOIN conferences hc ON ht.conference_id = hc.id
            LEFT JOIN divisions hd ON hc.division_id = hd.id
            LEFT JOIN conferences ac ON at2.conference_id = ac.id
            LEFT JOIN divisions ad ON ac.division_id = ad.id
            WHERE {where}
            ORDER BY
                CASE g.status
                    WHEN 'live' THEN 0
                    WHEN 'final' THEN 1
                    ELSE 2
                END,
                g.game_time ASC NULLS LAST,
                g.id
        """, params)

        games = _dedup_games([dict(g) for g in cur.fetchall()], limit=500)

        # ── W/L/S pitchers for each game ──
        final_ids = [g["id"] for g in games if g.get("status") == "final"]
        if final_ids:
            ph = ",".join(["%s"] * len(final_ids))
            cur.execute(f"""
                SELECT gp.game_id, gp.player_name, gp.decision,
                       p.first_name, p.last_name
                FROM game_pitching gp
                LEFT JOIN players p ON gp.player_id = p.id
                WHERE gp.game_id IN ({ph}) AND gp.decision IN ('W', 'L', 'S')
                ORDER BY gp.game_id
            """, final_ids)
            decisions = {}
            for r in cur.fetchall():
                gid = r["game_id"]
                if gid not in decisions:
                    decisions[gid] = {}
                name = r["last_name"] or r["player_name"].split(",")[0].strip() if r["player_name"] else "Unknown"
                decisions[gid][r["decision"]] = name
            for g in games:
                d = decisions.get(g["id"], {})
                g["win_pitcher"] = d.get("W")
                g["loss_pitcher"] = d.get("L")
                g["save_pitcher"] = d.get("S")

            # ── Backfill hits/errors from batting data when games table is NULL ──
            missing_he = [g["id"] for g in games
                          if g.get("status") == "final" and g.get("home_hits") is None]
            if missing_he:
                ph2 = ",".join(["%s"] * len(missing_he))
                cur.execute(f"""
                    SELECT gb.game_id, gb.team_id,
                           SUM(gb.hits) AS hits
                    FROM game_batting gb
                    WHERE gb.game_id IN ({ph2})
                    GROUP BY gb.game_id, gb.team_id
                """, missing_he)
                he_map = {}
                for r in cur.fetchall():
                    he_map.setdefault(r["game_id"], {})[r["team_id"]] = r["hits"] or 0
                for g in games:
                    if g["id"] not in he_map:
                        continue
                    teams = he_map[g["id"]]
                    home_id = g.get("home_team_id")
                    away_id = g.get("away_team_id")
                    # Assign hits by team_id; NULL team_id = non-PNW opponent
                    for tid, hits in teams.items():
                        if tid == home_id:
                            g["home_hits"] = hits
                        elif tid == away_id:
                            g["away_hits"] = hits
                        elif tid is None and not home_id:
                            g["home_hits"] = hits
                        elif tid is None and not away_id:
                            g["away_hits"] = hits

        # For future dates, merge in games from future_schedules.json
        # that aren't already in the database
        from pathlib import Path
        import json as _json
        from datetime import date as _date_type

        try:
            req_date = _date_type.fromisoformat(date)
            today = _date_type.today()
        except ValueError:
            req_date = None
            today = None

        if req_date and req_date >= today:
            fs_path = Path(__file__).parent.parent.parent / "data" / "future_schedules.json"
            if fs_path.exists():
                try:
                    with open(fs_path) as _f:
                        fs_data = _json.load(_f)
                    fs_games = [g for g in fs_data.get("games", []) if g.get("game_date") == date]

                    if division:
                        fs_games = [g for g in fs_games if g.get("division", "").upper() == division.upper()]

                    # Build set of existing game keys (home_id, away_id, date) to avoid dupes
                    existing_keys = set()
                    for g in games:
                        h = g.get("home_team_id")
                        a = g.get("away_team_id")
                        if h and a:
                            existing_keys.add((h, a))
                            existing_keys.add((a, h))

                    for fg in fs_games:
                        h = fg.get("home_team_id")
                        a = fg.get("away_team_id")
                        if h and a and (h, a) not in existing_keys:
                            existing_keys.add((h, a))
                            existing_keys.add((a, h))
                            # Build a DB-game-shaped dict from the future schedule entry
                            games.append({
                                "id": None,
                                "season": CURRENT_SEASON,
                                "game_date": fg["game_date"],
                                "game_time": None,
                                "home_team_id": h,
                                "away_team_id": a,
                                "home_team_name": fg.get("home_team", ""),
                                "away_team_name": fg.get("away_team", ""),
                                "source_url": None,
                                "home_score": None,
                                "away_score": None,
                                "innings": None,
                                "is_conference_game": fg.get("is_conference", False),
                                "home_hits": None, "home_errors": None,
                                "away_hits": None, "away_errors": None,
                                "home_line_score": None, "away_line_score": None,
                                "game_score": None,
                                "status": "scheduled",
                                "home_short": fg.get("home_team", ""),
                                "home_logo": None,
                                "away_short": fg.get("away_team", ""),
                                "away_logo": None,
                                "home_division": fg.get("division"),
                                "away_division": fg.get("division"),
                                "home_stats_url": None,
                                "away_stats_url": None,
                            })
                except Exception:
                    pass

            # Enrich any future-schedule games that are missing logos
            if games:
                try:
                    team_logos = {}
                    cur.execute("SELECT id, short_name, logo_url, stats_url FROM teams WHERE is_active = 1")
                    for row in cur.fetchall():
                        team_logos[row["id"]] = (row["short_name"], row["logo_url"], row.get("stats_url"))
                    for g in games:
                        if not g.get("home_logo") and g.get("home_team_id"):
                            info = team_logos.get(g["home_team_id"])
                            if info:
                                g["home_short"] = info[0]
                                g["home_logo"] = info[1]
                                if not g.get("home_stats_url"):
                                    g["home_stats_url"] = info[2]
                        if not g.get("away_logo") and g.get("away_team_id"):
                            info = team_logos.get(g["away_team_id"])
                            if info:
                                g["away_short"] = info[0]
                                g["away_logo"] = info[1]
                                if not g.get("away_stats_url"):
                                    g["away_stats_url"] = info[2]
                except Exception:
                    pass

        # Attach win probabilities for PNW-vs-PNW games
        try:
            season_val = games[0]["season"] if games else CURRENT_SEASON
            ratings = _bulk_power_ratings(cur, season_val)
            for g in games:
                h = g.get("home_team_id")
                a = g.get("away_team_id")
                if h and a and h in ratings and a in ratings:
                    hwp = _elo_win_prob(ratings[h], ratings[a])
                    g["home_win_prob"] = round(hwp, 3)
                    g["away_win_prob"] = round(1.0 - hwp, 3)
        except Exception:
            pass

        return {"games": games, "date": date, "count": len(games)}


@router.get("/games/daily-performers")
def daily_performers(
    date: str = Query(..., description="Date in YYYY-MM-DD format"),
    season: int = Query(CURRENT_SEASON),
):
    """
    Return enhanced game data + top performers for the daily scores graphic.
    Includes: games with H/E/W-L-S pitcher/team records, top hitters, top pitchers, bomb squad.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # ── 1. Get all final games for this date with H/E ──
        # Use COALESCE chain: short_name -> team.name -> games.raw_team_name
        cur.execute("""
            SELECT
                g.id, g.game_date, g.game_time, g.status,
                g.home_team_id, g.away_team_id,
                g.home_score, g.away_score,
                g.home_hits, g.home_errors, g.away_hits, g.away_errors,
                g.innings, g.is_conference_game, g.source_url,
                COALESCE(ht.short_name, ht.name, g.home_team_name) AS home_short,
                ht.logo_url AS home_logo,
                COALESCE(at2.short_name, at2.name, g.away_team_name) AS away_short,
                at2.logo_url AS away_logo,
                COALESCE(ht.name, g.home_team_name) AS home_team_name,
                COALESCE(at2.name, g.away_team_name) AS away_team_name,
                hd.level AS home_division, ad.level AS away_division
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at2 ON g.away_team_id = at2.id
            LEFT JOIN conferences hc ON ht.conference_id = hc.id
            LEFT JOIN divisions hd ON hc.division_id = hd.id
            LEFT JOIN conferences ac ON at2.conference_id = ac.id
            LEFT JOIN divisions ad ON ac.division_id = ad.id
            WHERE g.game_date = %s AND g.status = 'final'
            ORDER BY g.id
        """, (date,))
        games = [dict(r) for r in cur.fetchall()]
        game_ids = [g["id"] for g in games]

        if not game_ids:
            return {"games": [], "top_hitters": [], "top_pitchers": [], "date": date}

        # ── 2. Team records (PNW teams only, from team_season_stats) ──
        # Use the same source as the standings page so records always match.
        # Only include teams in PNW states (WA, OR, ID, MT, BC).
        cur.execute("""
            SELECT s.team_id, s.wins, s.losses
            FROM team_season_stats s
            JOIN teams t ON t.id = s.team_id
            WHERE s.season = %s
              AND t.state IN ('WA', 'OR', 'ID', 'MT', 'BC')
        """, (season,))
        records = {r["team_id"]: (r["wins"], r["losses"]) for r in cur.fetchall()}

        # Attach records to games (only for PNW teams — non-PNW get None)
        for g in games:
            hw, hl = records.get(g["home_team_id"], (0, 0))
            aw, al = records.get(g["away_team_id"], (0, 0))
            g["home_record"] = f"{hw}-{hl}" if g["home_team_id"] in records else None
            g["away_record"] = f"{aw}-{al}" if g["away_team_id"] in records else None

        # ── 3. W/L/S pitchers for each game ──
        placeholders = ",".join(["%s"] * len(game_ids))
        cur.execute(f"""
            SELECT gp.game_id, gp.team_id, gp.player_name, gp.decision,
                   p.first_name, p.last_name
            FROM game_pitching gp
            LEFT JOIN players p ON gp.player_id = p.id
            WHERE gp.game_id IN ({placeholders}) AND gp.decision IN ('W', 'L', 'S')
            ORDER BY gp.game_id
        """, game_ids)
        decisions = {}
        for r in cur.fetchall():
            gid = r["game_id"]
            if gid not in decisions:
                decisions[gid] = {}
            name = r["last_name"] or r["player_name"].split(",")[0].strip() if r["player_name"] else "Unknown"
            decisions[gid][r["decision"]] = {"name": name, "team_id": r["team_id"]}

        for g in games:
            d = decisions.get(g["id"], {})
            g["win_pitcher"] = d.get("W", {}).get("name")
            g["loss_pitcher"] = d.get("L", {}).get("name")
            g["save_pitcher"] = d.get("S", {}).get("name")

        # ── 4. Batting lines — PNW teams only (division IS NOT NULL) ──
        # Ghost-row guard: only return rows where gb.team_id is actually one of
        # the game's two teams. Prevents stray batting rows with mismatched
        # team_ids (a known scraper artifact) from polluting the widget.
        cur.execute(f"""
            SELECT gb.game_id, gb.team_id, gb.player_name, gb.player_id,
                   gb.at_bats, gb.runs, gb.hits, gb.doubles, gb.triples,
                   gb.home_runs, gb.rbi, gb.walks, gb.strikeouts,
                   gb.hit_by_pitch, gb.stolen_bases, gb.sacrifice_flies,
                   COALESCE(t.short_name, t.name) AS team_short,
                   t.logo_url AS team_logo,
                   p.first_name, p.last_name, p.headshot_url,
                   d.level AS division
            FROM game_batting gb
            JOIN games g ON g.id = gb.game_id
            JOIN teams t ON gb.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN players p ON gb.player_id = p.id
            WHERE gb.game_id IN ({placeholders})
              AND gb.team_id IN (g.home_team_id, g.away_team_id)
            ORDER BY gb.game_id
        """, game_ids)
        batting_rows = [dict(r) for r in cur.fetchall()]

        # ── 5. Pitching lines — PNW teams only ──
        # Same ghost-row guard as above: only rows whose team_id matches the
        # game's home or away team.
        cur.execute(f"""
            SELECT gp.game_id, gp.team_id, gp.player_name, gp.player_id,
                   gp.innings_pitched, gp.hits_allowed, gp.runs_allowed,
                   gp.earned_runs, gp.walks, gp.strikeouts,
                   gp.home_runs_allowed, gp.game_score, gp.decision,
                   gp.is_starter, gp.pitches_thrown,
                   COALESCE(t.short_name, t.name) AS team_short,
                   t.logo_url AS team_logo,
                   p.first_name, p.last_name, p.headshot_url,
                   d.level AS division
            FROM game_pitching gp
            JOIN games g ON g.id = gp.game_id
            JOIN teams t ON gp.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN players p ON gp.player_id = p.id
            WHERE gp.game_id IN ({placeholders})
              AND gp.team_id IN (g.home_team_id, g.away_team_id)
            ORDER BY gp.game_id
        """, game_ids)
        pitching_rows = [dict(r) for r in cur.fetchall()]

        # ── 5b. Filter out non-PNW D1 teams ──
        # D2/D3/NAIA/JUCO conferences are all PNW, but D1 conferences
        # (Big Ten, MWC, WCC) include many non-PNW schools.
        PNW_D1_TEAMS = {
            'Oregon', 'Oregon St.', 'UW', 'Wash. St.',
            'Gonzaga', 'Portland', 'Seattle U',
        }
        batting_rows = [
            b for b in batting_rows
            if b.get('division') != 'D1'
            or b.get('team_short') in PNW_D1_TEAMS
        ]
        pitching_rows = [
            p for p in pitching_rows
            if p.get('division') != 'D1'
            or p.get('team_short') in PNW_D1_TEAMS
        ]

        # ── 6. Rank hitters by performance score ──
        def _display_name(row):
            name = row.get("player_name") or ""
            if row.get("last_name") and row.get("first_name"):
                return f"{row['first_name']} {row['last_name']}"
            elif "," in name:
                parts = name.split(",", 1)
                return f"{parts[1].strip()} {parts[0].strip()}"
            return name

        def hitting_score(b):
            hr = b.get("home_runs") or 0
            trip = b.get("triples") or 0
            dbl = b.get("doubles") or 0
            h = b.get("hits") or 0
            rbi = b.get("rbi") or 0
            r = b.get("runs") or 0
            bb = b.get("walks") or 0
            sb = b.get("stolen_bases") or 0
            hbp = b.get("hit_by_pitch") or 0
            singles = h - dbl - trip - hr
            return (hr * 6) + (trip * 4) + (dbl * 3) + (singles * 1.5) + (rbi * 2) + (r * 1) + (bb * 0.5) + (sb * 1.5) + (hbp * 0.3)

        # Aggregate hitter stats per player across games (doubleheaders combined)
        # Track seen (game_id, player_key) to avoid counting duplicate DB rows
        hitter_agg = {}
        seen_bat_rows = set()
        bat_sum_keys = ["at_bats", "runs", "hits", "doubles", "triples",
                        "home_runs", "rbi", "walks", "strikeouts",
                        "hit_by_pitch", "stolen_bases", "sacrifice_flies"]
        for b in batting_rows:
            pid = b.get("player_id")
            player_key = pid if pid else f"{b.get('player_name','')}-{b.get('team_id','')}"
            # Dedup: skip if we already counted this exact game+player combo
            row_key = (b.get("game_id"), player_key)
            if row_key in seen_bat_rows:
                continue
            seen_bat_rows.add(row_key)

            if player_key not in hitter_agg:
                hitter_agg[player_key] = {
                    "player_id": pid,
                    "player_name": b.get("player_name"),
                    "first_name": b.get("first_name"),
                    "last_name": b.get("last_name"),
                    "team_id": b.get("team_id"),
                    "team_short": b.get("team_short"),
                    "team_logo": b.get("team_logo"),
                    "headshot_url": b.get("headshot_url"),
                    "division": b.get("division"),
                    "max_hr_in_game": 0,
                    "max_2b_in_game": 0,
                    "max_3b_in_game": 0,
                    "max_sb_in_game": 0,
                    "max_xbh_in_game": 0,
                }
                for sk in bat_sum_keys:
                    hitter_agg[player_key][sk] = 0
            for sk in bat_sum_keys:
                hitter_agg[player_key][sk] += (b.get(sk) or 0)
            # Track the highest single-game totals so the frontend can flag
            # multi-event games with a "(n)" notation next to the aggregate.
            g_hr = b.get("home_runs") or 0
            g_2b = b.get("doubles") or 0
            g_3b = b.get("triples") or 0
            g_sb = b.get("stolen_bases") or 0
            g_xbh = g_hr + g_2b + g_3b
            agg = hitter_agg[player_key]
            if g_hr  > agg["max_hr_in_game"]:  agg["max_hr_in_game"]  = g_hr
            if g_2b  > agg["max_2b_in_game"]:  agg["max_2b_in_game"]  = g_2b
            if g_3b  > agg["max_3b_in_game"]:  agg["max_3b_in_game"]  = g_3b
            if g_sb  > agg["max_sb_in_game"]:  agg["max_sb_in_game"]  = g_sb
            if g_xbh > agg["max_xbh_in_game"]: agg["max_xbh_in_game"] = g_xbh

        qualified_hitters = [b for b in hitter_agg.values() if b.get("at_bats", 0) >= 1]
        for b in qualified_hitters:
            b["perf_score"] = hitting_score(b)
            b["display_name"] = _display_name(b)
            # Compute XBH for display
            b["xbh"] = (b.get("doubles") or 0) + (b.get("triples") or 0) + (b.get("home_runs") or 0)

        # Return ALL qualified hitters — frontend filters by division and picks top 5
        top_hitters = sorted(qualified_hitters, key=lambda b: b["perf_score"], reverse=True)

        # ── 7. Rank pitchers — best SINGLE game performance (no aggregation) ──
        # Custom performance score: rewards dominance (K's, clean innings)
        # and penalises runs heavily so a 4-5 IP shutout outing can outrank
        # a 7+ IP start that gave up 4 runs.
        def pitching_perf_score(p):
            ip  = p.get("innings_pitched") or 0
            k   = p.get("strikeouts") or 0
            h   = p.get("hits_allowed") or 0
            er  = p.get("earned_runs") or 0
            bb  = p.get("walks") or 0
            hra = p.get("home_runs_allowed") or 0
            return (k * 3.5) + (ip * 3.5) - (h * 1.5) - (er * 6) - (bb * 1.5) - (hra * 2.5)

        # Keep each pitcher's best individual game to avoid double-counting
        seen_pitch_rows = set()
        pitcher_best = {}
        for p in pitching_rows:
            pid = p.get("player_id")
            player_key = pid if pid else f"{p.get('player_name','')}-{p.get('team_id','')}"
            # Dedup within same game
            row_key = (p.get("game_id"), player_key)
            if row_key in seen_pitch_rows:
                continue
            seen_pitch_rows.add(row_key)

            perf = pitching_perf_score(p)

            if player_key not in pitcher_best or perf > pitcher_best[player_key]["perf_score"]:
                pitcher_best[player_key] = {
                    "player_id": pid,
                    "player_name": p.get("player_name"),
                    "first_name": p.get("first_name"),
                    "last_name": p.get("last_name"),
                    "team_id": p.get("team_id"),
                    "team_short": p.get("team_short"),
                    "team_logo": p.get("team_logo"),
                    "headshot_url": p.get("headshot_url"),
                    "division": p.get("division"),
                    "innings_pitched": p.get("innings_pitched") or 0,
                    "hits_allowed": p.get("hits_allowed"),
                    "earned_runs": p.get("earned_runs"),
                    "walks": p.get("walks"),
                    "strikeouts": p.get("strikeouts"),
                    "home_runs_allowed": p.get("home_runs_allowed"),
                    "decision": p.get("decision"),
                    "perf_score": perf,
                }

        qualified_pitchers = [p for p in pitcher_best.values()
                              if (p.get("innings_pitched") or 0) >= 2.0]
        for p in qualified_pitchers:
            p["display_name"] = _display_name(p)

        # Return ALL qualified pitchers — frontend filters by division and picks top 5
        top_pitchers = sorted(qualified_pitchers, key=lambda p: p.get("perf_score", 0), reverse=True)

        return {
            "games": games,
            "top_hitters": top_hitters,
            "top_pitchers": top_pitchers,
            "date": date,
        }


@router.get("/games/top-performer-weeks")
def top_performer_weeks(
    season: int = Query(CURRENT_SEASON),
):
    """
    Return list of Monday-to-Sunday week ranges that have at least one final game.
    Used to populate the dropdown in the weekly top performers graphic.
    """
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT MIN(game_date) as first_date, MAX(game_date) as last_date
            FROM games
            WHERE season = %s AND status = 'final'
        """, (season,))
        row = cur.fetchone()
        if not row or not row["first_date"]:
            return {"weeks": []}

        first = row["first_date"]
        last = row["last_date"]

        # Find the first Monday on or before the first game date
        # weekday(): Monday=0
        days_since_monday = first.weekday()
        week_start = first - timedelta(days=days_since_monday)

        import pytz
        pacific = pytz.timezone("US/Pacific")
        today = datetime.now(pacific).date()

        weeks = []
        while week_start <= last:
            week_end = week_start + timedelta(days=6)
            label = f"{week_start.strftime('%b %d')} - {week_end.strftime('%b %d')}"
            is_current = week_start <= today <= week_end
            weeks.append({
                "week_start": str(week_start),
                "week_end": str(week_end),
                "label": label,
                "is_current": is_current,
            })
            week_start += timedelta(days=7)

        # Return most recent weeks first for dropdown UX
        weeks.reverse()
        return {"weeks": weeks}


@router.get("/games/weekly-top-performers")
@cached_endpoint(ttl_seconds=1800)  # heavy multi-game aggregation; edge cache is the first line, this is origin insurance
def weekly_top_performers(
    week_start: str = Query(..., description="Monday start date (YYYY-MM-DD)"),
    season: int = Query(CURRENT_SEASON),
):
    """
    Aggregate all PNW batting/pitching lines across a Monday-to-Sunday week,
    rank by perf_score, return top 10 hitters and top 10 pitchers (all divisions).
    Frontend filters by division and slices.
    """
    ws = datetime.strptime(week_start, "%Y-%m-%d").date()
    we = ws + timedelta(days=6)

    with get_connection() as conn:
        cur = conn.cursor()

        # ── 1. Get all final game IDs in this week ──
        cur.execute("""
            SELECT g.id
            FROM games g
            WHERE g.game_date BETWEEN %s AND %s
              AND g.season = %s
              AND g.status = 'final'
        """, (ws, we, season))
        game_ids = [r["id"] for r in cur.fetchall()]

        if not game_ids:
            return {
                "week_start": str(ws),
                "week_end": str(we),
                "top_hitters": [],
                "top_pitchers": [],
                "game_count": 0,
            }

        placeholders = ",".join(["%s"] * len(game_ids))

        # ── 2. Batting lines (PNW teams only, D1 filtered to PNW schools) ──
        cur.execute(f"""
            SELECT gb.game_id, gb.team_id, gb.player_name, gb.player_id,
                   gb.at_bats, gb.runs, gb.hits, gb.doubles, gb.triples,
                   gb.home_runs, gb.rbi, gb.walks, gb.strikeouts,
                   gb.hit_by_pitch, gb.stolen_bases, gb.sacrifice_flies,
                   COALESCE(t.short_name, t.name) AS team_short,
                   t.logo_url AS team_logo,
                   p.first_name, p.last_name, p.headshot_url,
                   d.level AS division
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            JOIN teams t ON gb.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN players p ON gb.player_id = p.id
            WHERE gb.game_id IN ({placeholders})
              AND gb.team_id IN (g.home_team_id, g.away_team_id)
        """, game_ids)
        batting_rows = [dict(r) for r in cur.fetchall()]

        # ── 3. Pitching lines ──
        cur.execute(f"""
            SELECT gp.game_id, gp.team_id, gp.player_name, gp.player_id,
                   gp.innings_pitched, gp.hits_allowed, gp.runs_allowed,
                   gp.earned_runs, gp.walks, gp.strikeouts,
                   gp.home_runs_allowed, gp.game_score, gp.decision,
                   gp.is_starter, gp.pitches_thrown,
                   COALESCE(t.short_name, t.name) AS team_short,
                   t.logo_url AS team_logo,
                   p.first_name, p.last_name, p.headshot_url,
                   d.level AS division
            FROM game_pitching gp
            JOIN games g ON gp.game_id = g.id
            JOIN teams t ON gp.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN players p ON gp.player_id = p.id
            WHERE gp.game_id IN ({placeholders})
              AND gp.team_id IN (g.home_team_id, g.away_team_id)
        """, game_ids)
        pitching_rows = [dict(r) for r in cur.fetchall()]

        # ── 4. D1 filter: only PNW-based D1 schools ──
        PNW_D1_TEAMS = {
            'Oregon', 'Oregon St.', 'UW', 'Wash. St.',
            'Gonzaga', 'Portland', 'Seattle U',
        }
        batting_rows = [
            b for b in batting_rows
            if b.get('division') != 'D1'
            or b.get('team_short') in PNW_D1_TEAMS
        ]
        pitching_rows = [
            p for p in pitching_rows
            if p.get('division') != 'D1'
            or p.get('team_short') in PNW_D1_TEAMS
        ]

        def _display_name(row):
            name = row.get("player_name") or ""
            if row.get("last_name") and row.get("first_name"):
                return f"{row['first_name']} {row['last_name']}"
            elif "," in name:
                parts = name.split(",", 1)
                return f"{parts[1].strip()} {parts[0].strip()}"
            return name

        # ── 5. Aggregate hitter stats across the week ──
        bat_sum_keys = ["at_bats", "runs", "hits", "doubles", "triples",
                        "home_runs", "rbi", "walks", "strikeouts",
                        "hit_by_pitch", "stolen_bases", "sacrifice_flies"]
        hitter_agg = {}
        seen_bat_rows = set()
        for b in batting_rows:
            pid = b.get("player_id")
            player_key = pid if pid else f"{b.get('player_name','')}-{b.get('team_id','')}"
            row_key = (b.get("game_id"), player_key)
            if row_key in seen_bat_rows:
                continue
            seen_bat_rows.add(row_key)
            if player_key not in hitter_agg:
                hitter_agg[player_key] = {
                    "player_id": pid,
                    "player_name": b.get("player_name"),
                    "first_name": b.get("first_name"),
                    "last_name": b.get("last_name"),
                    "team_id": b.get("team_id"),
                    "team_short": b.get("team_short"),
                    "team_logo": b.get("team_logo"),
                    "headshot_url": b.get("headshot_url"),
                    "division": b.get("division"),
                    "games": 0,
                }
                for sk in bat_sum_keys:
                    hitter_agg[player_key][sk] = 0
            for sk in bat_sum_keys:
                hitter_agg[player_key][sk] += (b.get(sk) or 0)
            hitter_agg[player_key]["games"] += 1

        def hitting_score(b):
            hr = b.get("home_runs") or 0
            trip = b.get("triples") or 0
            dbl = b.get("doubles") or 0
            h = b.get("hits") or 0
            rbi = b.get("rbi") or 0
            r = b.get("runs") or 0
            bb = b.get("walks") or 0
            sb = b.get("stolen_bases") or 0
            hbp = b.get("hit_by_pitch") or 0
            singles = h - dbl - trip - hr
            return (hr * 6) + (trip * 4) + (dbl * 3) + (singles * 1.5) + (rbi * 2) + (r * 1) + (bb * 0.5) + (sb * 1.5) + (hbp * 0.3)

        hitters = []
        for h in hitter_agg.values():
            ab = h.get("at_bats") or 0
            bb = h.get("walks") or 0
            hbp = h.get("hit_by_pitch") or 0
            sf = h.get("sacrifice_flies") or 0
            hits = h.get("hits") or 0
            dbl = h.get("doubles") or 0
            trip = h.get("triples") or 0
            hr = h.get("home_runs") or 0
            pa = ab + bb + hbp + sf
            if pa < 8:
                continue
            singles = hits - dbl - trip - hr
            total_bases = singles + (dbl * 2) + (trip * 3) + (hr * 4)
            avg = (hits / ab) if ab > 0 else 0.0
            obp = ((hits + bb + hbp) / pa) if pa > 0 else 0.0
            slg = (total_bases / ab) if ab > 0 else 0.0
            ops = obp + slg
            xbh = dbl + trip + hr
            h["pa"] = pa
            h["xbh"] = xbh
            h["avg"] = round(avg, 3)
            h["obp"] = round(obp, 3)
            h["slg"] = round(slg, 3)
            h["ops"] = round(ops, 3)
            h["perf_score"] = hitting_score(h)
            h["display_name"] = _display_name(h)
            hitters.append(h)

        top_hitters = sorted(hitters, key=lambda b: b["perf_score"], reverse=True)

        # ── 6. Aggregate pitcher stats across the week ──
        def ip_to_outs(ip):
            if ip is None:
                return 0
            whole = int(ip)
            frac = round((float(ip) - whole) * 10)
            # IP is stored as e.g. 6.1 = 6 and 1/3 innings, 6.2 = 6 and 2/3
            if frac not in (0, 1, 2):
                frac = 0
            return whole * 3 + frac

        def outs_to_ip(outs):
            whole = outs // 3
            frac = outs % 3
            return float(f"{whole}.{frac}")

        pit_sum_keys = ["hits_allowed", "runs_allowed", "earned_runs", "walks",
                        "strikeouts", "home_runs_allowed", "pitches_thrown"]
        pitcher_agg = {}
        seen_pitch_rows = set()
        for p in pitching_rows:
            pid = p.get("player_id")
            player_key = pid if pid else f"{p.get('player_name','')}-{p.get('team_id','')}"
            row_key = (p.get("game_id"), player_key)
            if row_key in seen_pitch_rows:
                continue
            seen_pitch_rows.add(row_key)
            if player_key not in pitcher_agg:
                pitcher_agg[player_key] = {
                    "player_id": pid,
                    "player_name": p.get("player_name"),
                    "first_name": p.get("first_name"),
                    "last_name": p.get("last_name"),
                    "team_id": p.get("team_id"),
                    "team_short": p.get("team_short"),
                    "team_logo": p.get("team_logo"),
                    "headshot_url": p.get("headshot_url"),
                    "division": p.get("division"),
                    "outs": 0,
                    "appearances": 0,
                    "starts": 0,
                    "wins": 0,
                    "losses": 0,
                    "saves": 0,
                }
                for sk in pit_sum_keys:
                    pitcher_agg[player_key][sk] = 0
            agg = pitcher_agg[player_key]
            agg["outs"] += ip_to_outs(p.get("innings_pitched"))
            agg["appearances"] += 1
            if p.get("is_starter"):
                agg["starts"] += 1
            dec = p.get("decision")
            if dec == "W":
                agg["wins"] += 1
            elif dec == "L":
                agg["losses"] += 1
            elif dec == "S":
                agg["saves"] += 1
            for sk in pit_sum_keys:
                agg[sk] += (p.get(sk) or 0)

        def pitching_perf_score(p):
            ip_val = p.get("innings_pitched") or 0
            k = p.get("strikeouts") or 0
            h_a = p.get("hits_allowed") or 0
            er = p.get("earned_runs") or 0
            bb = p.get("walks") or 0
            hra = p.get("home_runs_allowed") or 0
            return (k * 3.5) + (ip_val * 3.5) - (h_a * 1.5) - (er * 6) - (bb * 1.5) - (hra * 2.5)

        pitchers = []
        for p in pitcher_agg.values():
            outs = p.get("outs") or 0
            if outs < 6:  # need at least 2 IP across the week
                continue
            ip_val = outs_to_ip(outs)
            ip_float = outs / 3.0
            er = p.get("earned_runs") or 0
            era = (er * 9 / ip_float) if ip_float > 0 else 0.0
            p["innings_pitched"] = ip_val
            p["era"] = round(era, 2)
            p["perf_score"] = pitching_perf_score(p)
            p["display_name"] = _display_name(p)
            pitchers.append(p)

        top_pitchers = sorted(pitchers, key=lambda p: p["perf_score"], reverse=True)

        # ── 7. Weekly wRC+ per hitter (by division) ──
        # Compute each division's weekly league wOBA from ALL PNW hitters this week,
        # then calculate each qualified hitter's wRC+ relative to their division's
        # weekly average. This intentionally uses weekly, not season, context.
        from collections import defaultdict

        div_bat_totals = defaultdict(lambda: {
            "ab": 0, "bb": 0, "hbp": 0, "sf": 0, "hits": 0,
            "doubles": 0, "triples": 0, "hr": 0, "pa": 0,
        })
        for h in hitter_agg.values():
            div = h.get("division") or "D1"
            ab = h.get("at_bats") or 0
            bb = h.get("walks") or 0
            hbp = h.get("hit_by_pitch") or 0
            sf = h.get("sacrifice_flies") or 0
            hits = h.get("hits") or 0
            dbl = h.get("doubles") or 0
            trip = h.get("triples") or 0
            hr = h.get("home_runs") or 0
            pa = ab + bb + hbp + sf
            t = div_bat_totals[div]
            t["ab"] += ab
            t["bb"] += bb
            t["hbp"] += hbp
            t["sf"] += sf
            t["hits"] += hits
            t["doubles"] += dbl
            t["triples"] += trip
            t["hr"] += hr
            t["pa"] += pa

        div_league_woba = {}
        for div, t in div_bat_totals.items():
            w = DEFAULT_WEIGHTS.get(div, DEFAULT_WEIGHTS["D1"])
            singles = t["hits"] - t["doubles"] - t["triples"] - t["hr"]
            num = (
                w.w_bb * t["bb"]
                + w.w_hbp * t["hbp"]
                + w.w_1b * singles
                + w.w_2b * t["doubles"]
                + w.w_3b * t["triples"]
                + w.w_hr * t["hr"]
            )
            denom = t["ab"] + t["bb"] + t["sf"] + t["hbp"]
            div_league_woba[div] = (num / denom) if denom > 0 else 0.320

        for h in top_hitters:
            div = h.get("division") or "D1"
            lg_woba = div_league_woba.get(div, 0.320)
            line = BattingLine(
                pa=h.get("pa") or 0,
                ab=h.get("at_bats") or 0,
                hits=h.get("hits") or 0,
                doubles=h.get("doubles") or 0,
                triples=h.get("triples") or 0,
                hr=h.get("home_runs") or 0,
                bb=h.get("walks") or 0,
                hbp=h.get("hit_by_pitch") or 0,
                sf=h.get("sacrifice_flies") or 0,
                k=h.get("strikeouts") or 0,
                sb=h.get("stolen_bases") or 0,
            )
            adv = compute_batting_advanced(
                line,
                league_woba=lg_woba,
                division_level=div,
            )
            h["wrc_plus"] = round(adv.wrc_plus) if adv.wrc_plus else None

        # ── 8. Weekly FIP+ per pitcher (by division) ──
        # FIP constant is chosen so that each division's weekly league FIP equals
        # that division's weekly league ERA. FIP+ = lgFIP / playerFIP × 100.
        div_pit_totals = defaultdict(lambda: {
            "outs": 0, "er": 0, "bb": 0, "k": 0, "hr": 0,
        })
        for p in pitcher_agg.values():
            div = p.get("division") or "D1"
            t = div_pit_totals[div]
            t["outs"] += p.get("outs") or 0
            t["er"] += p.get("earned_runs") or 0
            t["bb"] += p.get("walks") or 0
            t["k"] += p.get("strikeouts") or 0
            t["hr"] += p.get("home_runs_allowed") or 0

        div_league_fip = {}
        div_fip_const = {}
        for div, t in div_pit_totals.items():
            ip_dec = t["outs"] / 3.0 if t["outs"] else 0
            if ip_dec <= 0:
                div_league_fip[div] = 4.20
                div_fip_const[div] = 3.10
                continue
            lg_era = (t["er"] * 9) / ip_dec
            lg_fip_core = (13 * t["hr"] + 3 * t["bb"] - 2 * t["k"]) / ip_dec
            div_fip_const[div] = lg_era - lg_fip_core
            div_league_fip[div] = lg_era  # league FIP equals league ERA by construction

        for p in top_pitchers:
            div = p.get("division") or "D1"
            outs = p.get("outs") or 0
            ip_dec = outs / 3.0 if outs else 0
            if ip_dec <= 0:
                p["fip_plus"] = None
                continue
            fip_core = (
                13 * (p.get("home_runs_allowed") or 0)
                + 3 * (p.get("walks") or 0)
                - 2 * (p.get("strikeouts") or 0)
            ) / ip_dec
            fip = fip_core + div_fip_const.get(div, 3.10)
            lg_fip = div_league_fip.get(div, 4.20)
            p["fip"] = round(fip, 2)
            # No cap/floor — weekly samples can produce negative or extreme FIP+
            # Only guard against exact division by zero
            if fip == 0:
                p["fip_plus"] = None
            else:
                p["fip_plus"] = round((lg_fip / fip) * 100)

        return {
            "week_start": str(ws),
            "week_end": str(we),
            "top_hitters": top_hitters,
            "top_pitchers": top_pitchers,
            "game_count": len(game_ids),
        }


@router.get("/games/series-weeks")
def series_weeks(
    season: int = Query(CURRENT_SEASON),
):
    """
    Return list of week ranges (Tuesday-Monday) that have series data.
    Used to populate the dropdown in the series recap graphic.
    """
    with get_connection() as conn:
        cur = conn.cursor()
        # Get the date range of all final games this season
        cur.execute("""
            SELECT MIN(game_date) as first_date, MAX(game_date) as last_date
            FROM games
            WHERE season = %s AND status = 'final'
        """, (season,))
        row = cur.fetchone()
        if not row or not row["first_date"]:
            return {"weeks": []}

        first = row["first_date"]
        last = row["last_date"]

        # Find the first Tuesday on or before the first game date
        # weekday(): Monday=0, Tuesday=1
        days_since_tuesday = (first.weekday() - 1) % 7
        week_start = first - timedelta(days=days_since_tuesday)

        # Find today's week (for the "current" label)
        import pytz
        pacific = pytz.timezone("US/Pacific")
        today = datetime.now(pacific).date()

        weeks = []
        while week_start <= last:
            week_end = week_start + timedelta(days=6)
            label = f"{week_start.strftime('%b %d')} - {week_end.strftime('%b %d')}"
            is_current = week_start <= today <= week_end
            weeks.append({
                "week_start": str(week_start),
                "week_end": str(week_end),
                "label": label,
                "is_current": is_current,
            })
            week_start += timedelta(days=7)

        return {"weeks": weeks}


@router.get("/games/series-recap")
@cached_endpoint(ttl_seconds=1800)
def series_recap(
    week_start: str = Query(..., description="Tuesday start date (YYYY-MM-DD)"),
    season: int = Query(CURRENT_SEASON),
):
    """
    Detect and return series recaps for a given week (Tuesday-Monday).
    A series is 3+ games between the same two teams within 4 days.
    Returns rich data: scorebugs, per-team top performers, team batting/pitching
    stats, national rankings, venue/park info.
    """
    import json as _json
    from collections import defaultdict
    from pathlib import Path as _Path

    week_start_date = datetime.strptime(week_start, "%Y-%m-%d").date()
    week_end_date = week_start_date + timedelta(days=6)

    with get_connection() as conn:
        cur = conn.cursor()

        # ── 1. All final games in this week ──
        cur.execute("""
            SELECT
                g.id, g.game_date, g.game_number, g.status,
                g.home_team_id, g.away_team_id,
                g.home_score, g.away_score,
                g.home_hits, g.home_errors, g.away_hits, g.away_errors,
                g.innings, g.is_conference_game, g.location,
                COALESCE(ht.short_name, ht.name, g.home_team_name) AS home_short,
                ht.logo_url AS home_logo,
                COALESCE(at2.short_name, at2.name, g.away_team_name) AS away_short,
                at2.logo_url AS away_logo,
                hd.level AS home_division, ad.level AS away_division
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at2 ON g.away_team_id = at2.id
            LEFT JOIN conferences hc ON ht.conference_id = hc.id
            LEFT JOIN divisions hd ON hc.division_id = hd.id
            LEFT JOIN conferences ac ON at2.conference_id = ac.id
            LEFT JOIN divisions ad ON ac.division_id = ad.id
            WHERE g.game_date BETWEEN %s AND %s
              AND g.season = %s AND g.status = 'final'
            ORDER BY g.game_date ASC, g.id ASC
        """, (week_start_date, week_end_date, season))
        all_games = [dict(r) for r in cur.fetchall()]

        if not all_games:
            return {"series": [], "week_start": week_start, "week_end": str(week_end_date)}

        # ── 2. Group into series (3+ games, same teams, <=4 day gap) ──
        matchup_games = defaultdict(list)
        for g in all_games:
            hid, aid = g["home_team_id"], g["away_team_id"]
            if not hid or not aid:
                continue
            matchup_games[tuple(sorted([hid, aid]))].append(g)

        # Dedupe same-game duplicates within each matchup. When MSUB and WOU
        # each scrape the same game from their own site, we get two rows:
        # one with home=MSUB/away=WOU and one with home=WOU/away=MSUB. Both
        # should collapse to a single scorebug. Real doubleheader games are
        # preserved because they have either a distinct game_number (1 vs 2)
        # or different scores.
        def _dedupe_matchup_games(glist):
            seen = {}
            for g in glist:
                # Canonicalize: sort the two (team_id, score) pairs so that
                # swapped home/away rows produce the same key.
                try:
                    score_pair = tuple(sorted([
                        (g.get("home_team_id") or 0, g.get("home_score") or 0),
                        (g.get("away_team_id") or 0, g.get("away_score") or 0),
                    ]))
                except TypeError:
                    score_pair = (g.get("home_team_id"), g.get("away_team_id"))
                # Drop game_number from the key: when two scrapers disagree on
                # which game of a doubleheader this is (one says game 1, the
                # other game 2) we still want to collapse them. Real DHs
                # practically never produce identical scores.
                key = (g["game_date"], score_pair)
                if key not in seen:
                    seen[key] = g
                else:
                    # Prefer the row with more filled-in stat fields.
                    existing = seen[key]
                    def _fill(row):
                        return sum(
                            1
                            for f in ("home_hits", "away_hits",
                                      "home_errors", "away_errors", "innings")
                            if row.get(f) is not None
                        )
                    if _fill(g) > _fill(existing):
                        seen[key] = g
            return list(seen.values())

        for key in list(matchup_games.keys()):
            matchup_games[key] = _dedupe_matchup_games(matchup_games[key])

        series_list = []
        for (t1, t2), games in matchup_games.items():
            games.sort(key=lambda g: (g["game_date"], g["id"]))
            if len(games) < 3:
                continue
            current = [games[0]]
            for i in range(1, len(games)):
                if (games[i]["game_date"] - current[-1]["game_date"]).days > 4:
                    if len(current) >= 3:
                        series_list.append(current)
                    current = [games[i]]
                else:
                    current.append(games[i])
            if len(current) >= 3:
                series_list.append(current)

        if not series_list:
            return {"series": [], "week_start": week_start, "week_end": str(week_end_date)}

        # ── 3. Bulk data: records, rankings, ratings, conf records, park factors ──
        cur.execute("SELECT team_id, wins, losses FROM team_season_stats WHERE season = %s", (season,))
        records = {r["team_id"]: (r["wins"], r["losses"]) for r in cur.fetchall()}

        cur.execute("""
            SELECT s.team_id, s.conference_wins, s.conference_losses
            FROM team_season_stats s WHERE s.season = %s
        """, (season,))
        conf_records = {r["team_id"]: (r["conference_wins"] or 0, r["conference_losses"] or 0)
                        for r in cur.fetchall()}

        cur.execute("""
            SELECT team_id, composite_rank, national_percentile
            FROM composite_rankings WHERE season = %s
        """, (season,))
        rankings = {r["team_id"]: {"rank": r["composite_rank"], "pctile": r["national_percentile"]}
                    for r in cur.fetchall()}

        ratings = _bulk_power_ratings(cur, season)

        # Load park factors
        pf_path = _Path(__file__).resolve().parent.parent.parent.parent / "data" / "park_factors.json"
        park_factors = {}
        try:
            with open(pf_path) as f:
                pf_data = _json.load(f)
            for t in pf_data.get("teams", []):
                park_factors[t["team_id"]] = t
        except Exception:
            pass

        # ── Helpers ──
        def _display_name(row):
            if row.get("last_name") and row.get("first_name"):
                return f"{row['first_name']} {row['last_name']}"
            name = row.get("player_name") or ""
            if "," in name:
                parts = name.split(",", 1)
                return f"{parts[1].strip()} {parts[0].strip()}"
            return name

        def hitting_score(b):
            hr = b.get("home_runs") or 0
            trip = b.get("triples") or 0
            dbl = b.get("doubles") or 0
            h = b.get("hits") or 0
            rbi = b.get("rbi") or 0
            r = b.get("runs") or 0
            bb = b.get("walks") or 0
            sb = b.get("stolen_bases") or 0
            hbp = b.get("hit_by_pitch") or 0
            singles = h - dbl - trip - hr
            return (hr*6)+(trip*4)+(dbl*3)+(singles*1.5)+(rbi*2)+(r*1)+(bb*0.5)+(sb*1.5)+(hbp*0.3)

        def pitching_perf_score(p):
            ip = p.get("innings_pitched") or 0
            k = p.get("strikeouts") or 0
            h = p.get("hits_allowed") or 0
            er = p.get("earned_runs") or 0
            bb = p.get("walks") or 0
            hra = p.get("home_runs_allowed") or 0
            return (k*3.5)+(ip*3.5)-(h*1.5)-(er*6)-(bb*1.5)-(hra*2.5)

        def _team_info(tid, short, logo):
            """Build rich team object."""
            w, l = records.get(tid, (0, 0))
            cw, cl = conf_records.get(tid, (0, 0))
            rank_data = rankings.get(tid, {})
            pf = park_factors.get(tid, {})
            return {
                "team_id": tid,
                "short_name": short,
                "logo_url": logo,
                "record": f"{w}-{l}" if tid in records else None,
                "conf_record": f"{cw}-{cl}" if (cw + cl) > 0 else None,
                "national_rank": rank_data.get("rank"),
                "national_pctile": rank_data.get("pctile"),
                "power_rating": ratings.get(tid),
                "venue": {
                    "stadium": pf.get("stadium"),
                    "city": pf.get("city"),
                    "state": pf.get("state"),
                    "elevation_ft": pf.get("elevation_ft"),
                    "park_factor_pct": pf.get("park_factor_pct"),
                    "dimensions": pf.get("dimensions"),
                    "surface": pf.get("surface"),
                } if pf else None,
            }

        def _compute_team_batting(rows, team_id):
            """Compute aggregate batting stats for one team from game_batting rows."""
            ab = h = doubles = triples = hr = rbi = bb = k = hbp = sb = sf = r = 0
            seen = set()
            for b in rows:
                if b.get("team_id") != team_id:
                    continue
                pid = b.get("player_id")
                pk = pid if pid else f"{b.get('player_name','')}-{b.get('team_id','')}"
                rk = (b.get("game_id"), pk)
                if rk in seen:
                    continue
                seen.add(rk)
                ab += (b.get("at_bats") or 0)
                h += (b.get("hits") or 0)
                doubles += (b.get("doubles") or 0)
                triples += (b.get("triples") or 0)
                hr += (b.get("home_runs") or 0)
                rbi += (b.get("rbi") or 0)
                bb += (b.get("walks") or 0)
                k += (b.get("strikeouts") or 0)
                hbp += (b.get("hit_by_pitch") or 0)
                sb += (b.get("stolen_bases") or 0)
                sf += (b.get("sacrifice_flies") or 0)
                r += (b.get("runs") or 0)
            avg = round(h / ab, 3) if ab else 0
            obp_denom = ab + bb + hbp + sf
            obp = round((h + bb + hbp) / obp_denom, 3) if obp_denom else 0
            tb = h + doubles + triples * 2 + hr * 3
            slg = round(tb / ab, 3) if ab else 0
            k_rate = round(k / ab * 100, 1) if ab else 0
            bb_rate = round(bb / ab * 100, 1) if ab else 0
            xbh = doubles + triples + hr
            singles = h - xbh
            # wOBA = (0.69*BB + 0.72*HBP + 0.89*1B + 1.27*2B + 1.62*3B + 2.10*HR) / (AB+BB+SF+HBP)
            woba_denom = ab + bb + sf + hbp
            woba = round((0.69*bb + 0.72*hbp + 0.89*singles + 1.27*doubles + 1.62*triples + 2.10*hr) / woba_denom, 3) if woba_denom else 0
            return {
                "ab": ab, "r": r, "h": h, "doubles": doubles, "triples": triples,
                "hr": hr, "rbi": rbi, "bb": bb, "k": k, "hbp": hbp, "sb": sb,
                "xbh": xbh,
                "avg": avg, "obp": obp, "slg": slg, "ops": round(obp + slg, 3),
                "k_rate": k_rate, "bb_rate": bb_rate, "woba": woba,
            }

        def _compute_team_pitching(rows, team_id):
            """Compute aggregate pitching stats for one team from game_pitching rows."""
            ip = h = er = bb = k = hra = ra = 0
            total_bf = 0  # approximate batters faced
            seen = set()
            for p in rows:
                if p.get("team_id") != team_id:
                    continue
                pid = p.get("player_id")
                pk = pid if pid else f"{p.get('player_name','')}-{p.get('team_id','')}"
                rk = (p.get("game_id"), pk)
                if rk in seen:
                    continue
                seen.add(rk)
                p_ip = p.get("innings_pitched") or 0
                p_h = p.get("hits_allowed") or 0
                p_bb = p.get("walks") or 0
                p_k = p.get("strikeouts") or 0
                ip += p_ip
                h += p_h
                er += (p.get("earned_runs") or 0)
                bb += p_bb
                k += p_k
                hra += (p.get("home_runs_allowed") or 0)
                ra += (p.get("runs_allowed") or 0)
                # Approximate BF: IP*3 + H + BB (rough estimate)
                total_bf += int(p_ip) * 3 + p_h + p_bb
            era = round(er * 9 / ip, 2) if ip else 0
            whip = round((bb + h) / ip, 2) if ip else 0
            k_per_9 = round(k * 9 / ip, 1) if ip else 0
            bb_per_9 = round(bb * 9 / ip, 1) if ip else 0
            h_per_9 = round(h * 9 / ip, 1) if ip else 0
            hr_per_9 = round(hra * 9 / ip, 1) if ip else 0
            k_rate = round(k / total_bf * 100, 1) if total_bf else 0
            bb_rate = round(bb / total_bf * 100, 1) if total_bf else 0
            # FIP = ((13*HR + 3*BB - 2*K) / IP) + 3.10
            fip = round(((13 * hra + 3 * bb - 2 * k) / ip) + 3.10, 2) if ip else 0
            return {
                "ip": round(ip, 1), "h": h, "er": er, "ra": ra, "bb": bb, "k": k,
                "hra": hra, "era": era, "whip": whip, "fip": fip,
                "k_per_9": k_per_9, "bb_per_9": bb_per_9, "h_per_9": h_per_9,
                "hr_per_9": hr_per_9, "k_rate": k_rate, "bb_rate": bb_rate,
            }

        # ── 4. Build each series ──
        result_series = []
        for series_games in series_list:
            game_ids = [g["id"] for g in series_games]
            placeholders = ",".join(["%s"] * len(game_ids))

            first_game = series_games[0]
            team_a_id = first_game["away_team_id"]
            team_b_id = first_game["home_team_id"]

            team_a = _team_info(team_a_id, first_game["away_short"], first_game["away_logo"])
            team_b = _team_info(team_b_id, first_game["home_short"], first_game["home_logo"])

            # Series wins
            a_wins = b_wins = 0
            a_runs = b_runs = a_hits = b_hits = a_errs = b_errs = 0
            venue = None
            for g in series_games:
                hs, aws = (g["home_score"] or 0), (g["away_score"] or 0)
                winner = g["home_team_id"] if hs > aws else (g["away_team_id"] if aws > hs else None)
                if winner == team_a_id:
                    a_wins += 1
                elif winner == team_b_id:
                    b_wins += 1
                if g["home_team_id"] == team_a_id:
                    a_runs += hs; b_runs += aws
                    a_hits += (g["home_hits"] or 0); b_hits += (g["away_hits"] or 0)
                    a_errs += (g["home_errors"] or 0); b_errs += (g["away_errors"] or 0)
                else:
                    a_runs += aws; b_runs += hs
                    a_hits += (g["away_hits"] or 0); b_hits += (g["home_hits"] or 0)
                    a_errs += (g["away_errors"] or 0); b_errs += (g["home_errors"] or 0)
                if not venue and g.get("location"):
                    venue = g["location"]

            team_a["series_wins"] = a_wins
            team_a["series_runs"] = a_runs
            team_a["series_hits"] = a_hits
            team_a["series_errors"] = a_errs
            team_b["series_wins"] = b_wins
            team_b["series_runs"] = b_runs
            team_b["series_hits"] = b_hits
            team_b["series_errors"] = b_errs

            total_games = len(series_games)
            if a_wins > b_wins:
                result_text = f"{team_a['short_name']} wins {a_wins}-{b_wins}"
            elif b_wins > a_wins:
                result_text = f"{team_b['short_name']} wins {b_wins}-{a_wins}"
            else:
                result_text = f"Split {a_wins}-{b_wins}"

            div_a = first_game.get("away_division")
            div_b = first_game.get("home_division")

            # W/L/S pitchers
            cur.execute(f"""
                SELECT gp.game_id, gp.team_id, gp.player_name, gp.decision,
                       p.first_name, p.last_name
                FROM game_pitching gp
                LEFT JOIN players p ON gp.player_id = p.id
                WHERE gp.game_id IN ({placeholders}) AND gp.decision IN ('W','L','S')
            """, game_ids)
            decisions = {}
            for r in cur.fetchall():
                gid = r["game_id"]
                if gid not in decisions:
                    decisions[gid] = {}
                name = r["last_name"] or (r["player_name"].split(",")[0].strip() if r["player_name"] else "?")
                decisions[gid][r["decision"]] = {"name": name, "team_id": r["team_id"]}

            scorebugs = []
            for g in series_games:
                d = decisions.get(g["id"], {})
                scorebugs.append({
                    "game_id": g["id"],
                    "game_date": str(g["game_date"]),
                    "home_short": g["home_short"], "away_short": g["away_short"],
                    "home_logo": g["home_logo"], "away_logo": g["away_logo"],
                    "home_score": g["home_score"], "away_score": g["away_score"],
                    "home_hits": g["home_hits"], "away_hits": g["away_hits"],
                    "home_errors": g["home_errors"], "away_errors": g["away_errors"],
                    "innings": g["innings"],
                    "win_pitcher": d.get("W", {}).get("name"),
                    "loss_pitcher": d.get("L", {}).get("name"),
                    "save_pitcher": d.get("S", {}).get("name"),
                })

            # ── Batting data ──
            cur.execute(f"""
                SELECT gb.game_id, gb.team_id, gb.player_name, gb.player_id,
                       gb.at_bats, gb.runs, gb.hits, gb.doubles, gb.triples,
                       gb.home_runs, gb.rbi, gb.walks, gb.strikeouts,
                       gb.hit_by_pitch, gb.stolen_bases, gb.sacrifice_flies,
                       COALESCE(t.short_name, t.name) AS team_short,
                       t.logo_url AS team_logo,
                       p.first_name, p.last_name, p.headshot_url,
                       d.level AS division
                FROM game_batting gb
                JOIN teams t ON gb.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                LEFT JOIN players p ON gb.player_id = p.id
                WHERE gb.game_id IN ({placeholders})
                  AND gb.team_id IN (%s, %s)
            """, (*game_ids, team_a_id, team_b_id))
            batting_rows = [dict(r) for r in cur.fetchall()]

            # ── Pitching data ──
            cur.execute(f"""
                SELECT gp.game_id, gp.team_id, gp.player_name, gp.player_id,
                       gp.innings_pitched, gp.hits_allowed, gp.runs_allowed,
                       gp.earned_runs, gp.walks, gp.strikeouts,
                       gp.home_runs_allowed, gp.decision, gp.is_starter,
                       COALESCE(t.short_name, t.name) AS team_short,
                       t.logo_url AS team_logo,
                       p.first_name, p.last_name, p.headshot_url,
                       d.level AS division
                FROM game_pitching gp
                JOIN teams t ON gp.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                LEFT JOIN players p ON gp.player_id = p.id
                WHERE gp.game_id IN ({placeholders})
                  AND gp.team_id IN (%s, %s)
            """, (*game_ids, team_a_id, team_b_id))
            pitching_rows = [dict(r) for r in cur.fetchall()]

            # ── Team batting/pitching aggregates for the series ──
            team_a["series_batting"] = _compute_team_batting(batting_rows, team_a_id)
            team_b["series_batting"] = _compute_team_batting(batting_rows, team_b_id)
            team_a["series_pitching"] = _compute_team_pitching(pitching_rows, team_a_id)
            team_b["series_pitching"] = _compute_team_pitching(pitching_rows, team_b_id)
            # Derive pitching stats from opponent batting for accuracy
            # (pitching rows often missing HR allowed, and K%/BB% denominators differ)
            for pitcher_team, opp_batting in [
                (team_a["series_pitching"], team_b["series_batting"]),
                (team_b["series_pitching"], team_a["series_batting"]),
            ]:
                pitcher_team["xbh_allowed"] = opp_batting.get("xbh", 0)
                pitcher_team["hr_allowed"] = opp_batting.get("hr", 0)
                opp_ab = opp_batting.get("ab", 0)
                # Use opponent AB for K% and BB% so they match batting card
                pitcher_team["k_rate"] = round(pitcher_team.get("k", 0) / opp_ab * 100, 1) if opp_ab else 0
                pitcher_team["bb_rate"] = round(pitcher_team.get("bb", 0) / opp_ab * 100, 1) if opp_ab else 0
                # Recalculate HR/9 from opponent batting HR
                ip = pitcher_team.get("ip", 0)
                pitcher_team["hr_per_9"] = round(opp_batting.get("hr", 0) * 9 / ip, 1) if ip else 0
                # Recalculate FIP with accurate HR
                hr_for_fip = opp_batting.get("hr", 0)
                pitcher_team["fip"] = round(((13 * hr_for_fip + 3 * pitcher_team.get("bb", 0) - 2 * pitcher_team.get("k", 0)) / ip) + 3.10, 2) if ip else 0

            # ── Top performers SPLIT BY TEAM ──
            def _agg_hitters(rows, tid):
                agg = {}
                seen = set()
                bat_keys = ["at_bats","runs","hits","doubles","triples","home_runs",
                            "rbi","walks","strikeouts","hit_by_pitch","stolen_bases","sacrifice_flies"]
                for b in rows:
                    if b.get("team_id") != tid:
                        continue
                    pid = b.get("player_id")
                    pk = pid if pid else f"{b.get('player_name','')}-{b.get('team_id','')}"
                    rk = (b.get("game_id"), pk)
                    if rk in seen:
                        continue
                    seen.add(rk)
                    if pk not in agg:
                        agg[pk] = {
                            "player_id": pid, "player_name": b.get("player_name"),
                            "first_name": b.get("first_name"), "last_name": b.get("last_name"),
                            "team_id": tid, "team_short": b.get("team_short"),
                            "team_logo": b.get("team_logo"), "headshot_url": b.get("headshot_url"),
                            "division": b.get("division"),
                        }
                        for k in bat_keys:
                            agg[pk][k] = 0
                    for k in bat_keys:
                        agg[pk][k] += (b.get(k) or 0)
                result = [b for b in agg.values() if b.get("at_bats", 0) >= 3]
                for b in result:
                    b["perf_score"] = hitting_score(b)
                    b["display_name"] = _display_name(b)
                    b["xbh"] = (b.get("doubles") or 0) + (b.get("triples") or 0) + (b.get("home_runs") or 0)
                    b["bb_hbp"] = (b.get("walks") or 0) + (b.get("hit_by_pitch") or 0)
                    ab = b.get("at_bats") or 1
                    b["avg"] = round((b.get("hits") or 0) / ab, 3)
                return sorted(result, key=lambda x: x["perf_score"], reverse=True)[:4]

            def _agg_pitchers(rows, tid):
                agg = {}
                seen = set()
                pitch_keys = ["innings_pitched","hits_allowed","earned_runs",
                              "walks","strikeouts","home_runs_allowed","runs_allowed"]
                for p in rows:
                    if p.get("team_id") != tid:
                        continue
                    pid = p.get("player_id")
                    pk = pid if pid else f"{p.get('player_name','')}-{p.get('team_id','')}"
                    rk = (p.get("game_id"), pk)
                    if rk in seen:
                        continue
                    seen.add(rk)
                    if pk not in agg:
                        agg[pk] = {
                            "player_id": pid, "player_name": p.get("player_name"),
                            "first_name": p.get("first_name"), "last_name": p.get("last_name"),
                            "team_id": tid, "team_short": p.get("team_short"),
                            "team_logo": p.get("team_logo"), "headshot_url": p.get("headshot_url"),
                            "division": p.get("division"), "decisions": [],
                        }
                        for k in pitch_keys:
                            agg[pk][k] = 0
                    for k in pitch_keys:
                        agg[pk][k] += (p.get(k) or 0)
                    if p.get("decision"):
                        agg[pk]["decisions"].append(p["decision"])
                result = [p for p in agg.values() if (p.get("innings_pitched") or 0) >= 2.0]
                for p in result:
                    p["perf_score"] = pitching_perf_score(p)
                    p["display_name"] = _display_name(p)
                    decs = p.pop("decisions", [])
                    p["decision_summary"] = ", ".join(decs) if decs else None
                    p["bb_hbp"] = (p.get("walks") or 0)  # HBP not tracked in pitching lines
                    # FIP: ((13*HR + 3*BB - 2*K) / IP) + 3.10
                    ip = p.get("innings_pitched") or 0
                    if ip > 0:
                        hra = p.get("home_runs_allowed") or 0
                        bb = p.get("walks") or 0
                        k = p.get("strikeouts") or 0
                        p["fip"] = round(((13 * hra + 3 * bb - 2 * k) / ip) + 3.10, 2)
                    else:
                        p["fip"] = None
                return sorted(result, key=lambda x: x["perf_score"], reverse=True)[:4]

            team_a["top_hitters"] = _agg_hitters(batting_rows, team_a_id)
            team_b["top_hitters"] = _agg_hitters(batting_rows, team_b_id)
            team_a["top_pitchers"] = _agg_pitchers(pitching_rows, team_a_id)
            team_b["top_pitchers"] = _agg_pitchers(pitching_rows, team_b_id)

            # ── Venue / park factors (use home team's park) ──
            home_pf = park_factors.get(team_b_id, {})
            venue_info = None
            if home_pf or venue:
                venue_info = {
                    "name": venue or home_pf.get("stadium"),
                    "stadium": home_pf.get("stadium"),
                    "city": home_pf.get("city"),
                    "state": home_pf.get("state"),
                    "elevation_ft": home_pf.get("elevation_ft"),
                    "park_factor_pct": home_pf.get("park_factor_pct"),
                    "dimensions": home_pf.get("dimensions"),
                    "surface": home_pf.get("surface"),
                }

            result_series.append({
                "team_a": team_a,
                "team_b": team_b,
                "result_text": result_text,
                "total_games": total_games,
                "division": div_a or div_b,
                "scorebugs": scorebugs,
                "venue": venue_info,
                "date_range": f"{series_games[0]['game_date']} to {series_games[-1]['game_date']}",
            })

        div_order = {"D1": 0, "D2": 1, "D3": 2, "NAIA": 3, "JUCO": 4}
        result_series.sort(key=lambda s: (div_order.get(s["division"], 9), s["team_a"]["short_name"]))

        return {
            "series": result_series,
            "week_start": week_start,
            "week_end": str(week_end_date),
        }


@router.get("/games/daily-recap")
@cached_endpoint(ttl_seconds=1800)
def daily_recap(
    date: str = Query(..., description="Date in YYYY-MM-DD format"),
    home_team_id: int = Query(...),
    away_team_id: int = Query(...),
    season: int = Query(CURRENT_SEASON),
):
    """
    Return all games between two teams on a given date (could be doubleheader).
    Includes full box score data, top performers, and team records.
    """
    import json as _json
    from pathlib import Path as _Path
    from datetime import date as _date_type

    recap_date = datetime.strptime(date, "%Y-%m-%d").date()

    with get_connection() as conn:
        cur = conn.cursor()

        # ── 1. Get all games between these two teams on this date ──
        cur.execute("""
            SELECT
                g.id, g.game_date, g.game_number, g.status,
                g.home_team_id, g.away_team_id,
                g.home_score, g.away_score,
                g.home_hits, g.home_errors, g.away_hits, g.away_errors,
                g.innings, g.home_line_score, g.away_line_score,
                COALESCE(ht.short_name, ht.name) AS home_short,
                COALESCE(at2.short_name, at2.name) AS away_short,
                ht.logo_url AS home_logo,
                at2.logo_url AS away_logo
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at2 ON g.away_team_id = at2.id
            WHERE g.game_date = %s
              AND g.season = %s
              AND g.status = 'final'
              AND (
                (g.home_team_id = %s AND g.away_team_id = %s) OR
                (g.home_team_id = %s AND g.away_team_id = %s)
              )
            ORDER BY g.game_number ASC
        """, (recap_date, season, home_team_id, away_team_id, away_team_id, home_team_id))
        games = [dict(r) for r in cur.fetchall()]

        if not games:
            return {
                "date": date,
                "team_a": None,
                "team_b": None,
                "games": [],
                "is_doubleheader": False,
                "total_games": 0,
                "available_matchups": [],
            }

        # ── 2. Determine which team is home/away (using first game) ──
        first_game = games[0]
        h_id = first_game["home_team_id"]
        a_id = first_game["away_team_id"]

        # Fetch team records
        cur.execute("SELECT team_id, wins, losses FROM team_season_stats WHERE season = %s", (season,))
        records = {r["team_id"]: {"wins": r["wins"], "losses": r["losses"]} for r in cur.fetchall()}

        # Fetch team info
        cur.execute("""
            SELECT id, name, short_name, logo_url, conference_id
            FROM teams
            WHERE id IN (%s, %s)
        """, (h_id, a_id))
        teams_info = {r["id"]: dict(r) for r in cur.fetchall()}

        # Get conference info
        cur.execute("""
            SELECT c.id, c.name as conference_name, d.level
            FROM conferences c
            LEFT JOIN divisions d ON c.division_id = d.id
        """)
        conf_map = {r["id"]: {"name": r["conference_name"], "division": r["level"]}
                    for r in cur.fetchall()}

        def _team_obj(tid):
            t = teams_info.get(tid, {})
            c = conf_map.get(t.get("conference_id"), {})
            rec = records.get(tid, {"wins": 0, "losses": 0})
            return {
                "team_id": tid,
                "short_name": t.get("short_name") or t.get("name"),
                "school_name": t.get("name"),
                "logo_url": t.get("logo_url"),
                "record": rec,
                "division": c.get("division"),
                "conference": c.get("name"),
            }

        team_a = _team_obj(h_id)
        team_b = _team_obj(a_id)

        # ── 3. Helper functions for scoring ──
        def hitting_score(b):
            hr = b.get("home_runs") or 0
            trip = b.get("triples") or 0
            dbl = b.get("doubles") or 0
            h = b.get("hits") or 0
            rbi = b.get("rbi") or 0
            r = b.get("runs") or 0
            bb = b.get("walks") or 0
            sb = b.get("stolen_bases") or 0
            hbp = b.get("hit_by_pitch") or 0
            singles = h - dbl - trip - hr
            return (hr*6)+(trip*4)+(dbl*3)+(singles*1.5)+(rbi*2)+(r*1)+(bb*0.5)+(sb*1.5)+(hbp*0.3)

        def pitching_perf_score(p):
            ip = p.get("innings_pitched") or 0
            k = p.get("strikeouts") or 0
            h = p.get("hits_allowed") or 0
            er = p.get("earned_runs") or 0
            bb = p.get("walks") or 0
            hra = p.get("home_runs_allowed") or 0
            return (k*3.5)+(ip*3.5)-(h*1.5)-(er*6)-(bb*1.5)-(hra*2.5)

        def _display_name(row):
            if row.get("last_name") and row.get("first_name"):
                return f"{row['first_name']} {row['last_name']}"
            name = row.get("player_name") or ""
            if "," in name:
                parts = name.split(",", 1)
                return f"{parts[1].strip()} {parts[0].strip()}"
            return name

        def _format_hitter_line(b):
            """Generate human-readable stat line for a hitter."""
            ab = b.get("at_bats") or 0
            h = b.get("hits") or 0
            dbl = b.get("doubles") or 0
            trip = b.get("triples") or 0
            hr = b.get("home_runs") or 0
            rbi = b.get("rbi") or 0
            r = b.get("runs") or 0
            bb = b.get("walks") or 0
            sb = b.get("stolen_bases") or 0

            parts = [f"{h}-for-{ab}"]
            if hr:
                parts.append(f"{hr} HR" if hr > 1 else "HR")
            if trip:
                parts.append(f"{trip} 3B" if trip > 1 else "3B")
            if dbl:
                parts.append(f"{dbl} 2B" if dbl > 1 else "2B")
            if rbi:
                parts.append(f"{rbi} RBI")
            if r:
                parts.append(f"{r} R")
            if bb:
                parts.append(f"{bb} BB" if bb > 1 else "BB")
            if sb:
                parts.append(f"{sb} SB" if sb > 1 else "SB")
            return ", ".join(parts)

        def _fmt_ip(ip):
            """Format innings pitched: 6.333->6.1, 6.667->6.2, 7.0->7.0"""
            if ip is None:
                return "0.0"
            whole = int(ip)
            frac = ip - whole
            if frac < 0.1:
                return f"{whole}.0"
            elif frac < 0.5:
                return f"{whole}.1"
            else:
                return f"{whole}.2"

        def _format_pitcher_line(p):
            """Generate human-readable stat line for a pitcher."""
            ip = p.get("innings_pitched") or 0
            h = p.get("hits_allowed") or 0
            er = p.get("earned_runs") or 0
            bb = p.get("walks") or 0
            k = p.get("strikeouts") or 0
            hra = p.get("home_runs_allowed") or 0
            decision = p.get("decision")

            parts = [f"{_fmt_ip(ip)} IP"]
            if k:
                parts.append(f"{k} K")
            if er is not None:
                parts.append(f"{er} ER")
            if bb:
                parts.append(f"{bb} BB")
            if hra:
                parts.append(f"{hra} HR" if hra > 1 else "HR")
            if decision:
                parts.append(decision)
            return ", ".join(parts)

        # ── 4. Process each game ──
        game_ids = [g["id"] for g in games]
        placeholders = ",".join(["%s"] * len(game_ids))

        # Get W/L/S decisions
        cur.execute(f"""
            SELECT gp.game_id, gp.team_id, gp.player_name, gp.decision,
                   p.first_name, p.last_name
            FROM game_pitching gp
            LEFT JOIN players p ON gp.player_id = p.id
            WHERE gp.game_id IN ({placeholders}) AND gp.decision IN ('W','L','S')
        """, game_ids)
        decisions = {}
        for r in cur.fetchall():
            gid = r["game_id"]
            if gid not in decisions:
                decisions[gid] = {}
            name = r["last_name"] or (r["player_name"].split(",")[0].strip() if r["player_name"] else "?")
            decisions[gid][r["decision"]] = name

        # Get batting data (with player info: year, position, commitment)
        cur.execute(f"""
            SELECT gb.game_id, gb.team_id, gb.player_name, gb.player_id,
                   gb.position AS game_position,
                   gb.at_bats, gb.runs, gb.hits, gb.doubles, gb.triples,
                   gb.home_runs, gb.rbi, gb.walks, gb.strikeouts,
                   gb.hit_by_pitch, gb.stolen_bases,
                   COALESCE(t.short_name, t.name) AS team_short,
                   t.logo_url AS team_logo,
                   p.first_name, p.last_name,
                   p.year_in_school, p.position AS roster_position,
                   p.is_committed, p.committed_to
            FROM game_batting gb
            JOIN games gg ON gb.game_id = gg.id
            JOIN teams t ON gb.team_id = t.id
            LEFT JOIN players p ON gb.player_id = p.id
            WHERE gb.game_id IN ({placeholders})
              AND gb.team_id IN (gg.home_team_id, gg.away_team_id)
        """, game_ids)
        batting_rows = [dict(r) for r in cur.fetchall()]

        # Get pitching data (with player info)
        cur.execute(f"""
            SELECT gp.game_id, gp.team_id, gp.player_name, gp.player_id,
                   gp.innings_pitched, gp.hits_allowed, gp.runs_allowed,
                   gp.earned_runs, gp.walks, gp.strikeouts,
                   gp.home_runs_allowed, gp.decision,
                   COALESCE(t.short_name, t.name) AS team_short,
                   t.logo_url AS team_logo,
                   p.first_name, p.last_name,
                   p.year_in_school, p.position AS roster_position,
                   p.is_committed, p.committed_to
            FROM game_pitching gp
            JOIN games gg ON gp.game_id = gg.id
            JOIN teams t ON gp.team_id = t.id
            LEFT JOIN players p ON gp.player_id = p.id
            WHERE gp.game_id IN ({placeholders})
              AND gp.team_id IN (gg.home_team_id, gg.away_team_id)
        """, game_ids)
        pitching_rows = [dict(r) for r in cur.fetchall()]

        # Determine if teams are JUCO (NWAC)
        juco_team_ids = set()
        for tid in [h_id, a_id]:
            ti = teams_info.get(tid, {})
            ci = conf_map.get(ti.get("conference_id"), {})
            if ci.get("division") == "JUCO":
                juco_team_ids.add(tid)

        # ── 5. Build game objects with top performers ──
        result_games = []
        for g in games:
            gid = g["id"]
            d = decisions.get(gid, {})

            # Get batting and pitching rows for this game
            g_batting = [b for b in batting_rows if b["game_id"] == gid]
            g_pitching = [p for p in pitching_rows if p["game_id"] == gid]

            # Calculate top performers for this game
            all_performers = []

            # Hitters
            hitter_agg = {}
            for b in g_batting:
                pid = b.get("player_id")
                pk = pid if pid else f"{b.get('player_name','')}-{b.get('team_id','')}"
                if pk not in hitter_agg:
                    hitter_agg[pk] = {
                        "player_name": b.get("player_name"),
                        "first_name": b.get("first_name"),
                        "last_name": b.get("last_name"),
                        "team_id": b.get("team_id"),
                        "team_short": b.get("team_short"),
                        "team_logo": b.get("team_logo"),
                        "type": "hitter",
                        "game_position": b.get("game_position") or b.get("roster_position") or "",
                        "year_in_school": b.get("year_in_school") or "",
                        "is_committed": b.get("is_committed"),
                        "committed_to": b.get("committed_to"),
                        "at_bats": 0, "runs": 0, "hits": 0, "doubles": 0,
                        "triples": 0, "home_runs": 0, "rbi": 0, "walks": 0,
                        "strikeouts": 0, "hit_by_pitch": 0, "stolen_bases": 0,
                    }
                for k in ["at_bats", "runs", "hits", "doubles", "triples", "home_runs",
                          "rbi", "walks", "strikeouts", "hit_by_pitch", "stolen_bases"]:
                    hitter_agg[pk][k] += (b.get(k) or 0)

            for pk, h in hitter_agg.items():
                score = hitting_score(h)
                if score > 0:
                    display_name = _display_name(h)
                    is_juco = h["team_id"] in juco_team_ids
                    commitment = None
                    if is_juco:
                        if h.get("is_committed") and h.get("committed_to"):
                            commitment = f"Committed: {h['committed_to']}"
                        else:
                            commitment = "Uncommitted"

                    all_performers.append({
                        "player_name": display_name,
                        "team_id": h["team_id"],
                        "team_short": h["team_short"],
                        "team_logo": h["team_logo"],
                        "type": "hitter",
                        "position": h["game_position"],
                        "year": h["year_in_school"],
                        "commitment": commitment,
                        "perf_score": score,
                        "stats": {
                            "at_bats": h["at_bats"],
                            "hits": h["hits"],
                            "doubles": h["doubles"],
                            "triples": h["triples"],
                            "home_runs": h["home_runs"],
                            "rbi": h["rbi"],
                            "runs": h["runs"],
                            "walks": h["walks"],
                            "strikeouts": h["strikeouts"],
                            "hit_by_pitch": h["hit_by_pitch"],
                            "stolen_bases": h["stolen_bases"],
                        },
                        "stat_line": _format_hitter_line(h),
                    })

            # Pitchers
            pitcher_agg = {}
            for p in g_pitching:
                pid = p.get("player_id")
                pk = pid if pid else f"{p.get('player_name','')}-{p.get('team_id','')}"
                if pk not in pitcher_agg:
                    pitcher_agg[pk] = {
                        "player_name": p.get("player_name"),
                        "first_name": p.get("first_name"),
                        "last_name": p.get("last_name"),
                        "team_id": p.get("team_id"),
                        "team_short": p.get("team_short"),
                        "team_logo": p.get("team_logo"),
                        "type": "pitcher",
                        "year_in_school": p.get("year_in_school") or "",
                        "roster_position": p.get("roster_position") or "P",
                        "is_committed": p.get("is_committed"),
                        "committed_to": p.get("committed_to"),
                        "innings_pitched": 0, "hits_allowed": 0, "earned_runs": 0,
                        "walks": 0, "strikeouts": 0, "home_runs_allowed": 0,
                        "decision": None,
                    }
                for k in ["innings_pitched", "hits_allowed", "earned_runs", "walks",
                          "strikeouts", "home_runs_allowed"]:
                    pitcher_agg[pk][k] += (p.get(k) or 0)
                if p.get("decision") and not pitcher_agg[pk]["decision"]:
                    pitcher_agg[pk]["decision"] = p["decision"]

            for pk, p in pitcher_agg.items():
                score = pitching_perf_score(p)
                if score > 0:
                    display_name = _display_name(p)
                    is_juco = p["team_id"] in juco_team_ids
                    commitment = None
                    if is_juco:
                        if p.get("is_committed") and p.get("committed_to"):
                            commitment = f"Committed: {p['committed_to']}"
                        else:
                            commitment = "Uncommitted"

                    all_performers.append({
                        "player_name": display_name,
                        "team_id": p["team_id"],
                        "team_short": p["team_short"],
                        "team_logo": p["team_logo"],
                        "type": "pitcher",
                        "position": p["roster_position"],
                        "year": p["year_in_school"],
                        "commitment": commitment,
                        "perf_score": score,
                        "stats": {
                            "innings_pitched": p["innings_pitched"],
                            "hits_allowed": p["hits_allowed"],
                            "earned_runs": p["earned_runs"],
                            "walks": p["walks"],
                            "strikeouts": p["strikeouts"],
                            "home_runs_allowed": p["home_runs_allowed"],
                            "decision": p.get("decision"),
                        },
                        "stat_line": _format_pitcher_line(p),
                    })

            # Sort by score, send all performers (frontend handles filtering/limits)
            all_performers.sort(key=lambda x: x["perf_score"], reverse=True)
            top_performers = all_performers

            # Parse line scores
            home_line_str = g.get("home_line_score") or "[]"
            away_line_str = g.get("away_line_score") or "[]"
            try:
                home_line = json.loads(home_line_str) if isinstance(home_line_str, str) else home_line_str
                away_line = json.loads(away_line_str) if isinstance(away_line_str, str) else away_line_str
            except Exception:
                # Narrowed from bare `except:` so KeyboardInterrupt/SystemExit
                # can propagate. Covers JSONDecodeError, TypeError, etc.
                home_line = []
                away_line = []

            result_games.append({
                "game_id": gid,
                "game_number": g.get("game_number") or 1,
                "home_team_id": h_id,
                "away_team_id": a_id,
                "home_score": g["home_score"],
                "away_score": g["away_score"],
                "home_hits": g["home_hits"],
                "away_hits": g["away_hits"],
                "home_errors": g["home_errors"],
                "away_errors": g["away_errors"],
                "home_line_score": home_line,
                "away_line_score": away_line,
                "innings": g.get("innings") or 9,
                "status": g["status"],
                "win_pitcher": d.get("W"),
                "loss_pitcher": d.get("L"),
                "save_pitcher": d.get("S"),
                "top_performers": top_performers,
            })

        # ── 6. Available matchups for date picker ──
        cur.execute("""
            SELECT DISTINCT
                g.home_team_id, g.away_team_id,
                COALESCE(ht.short_name, ht.name) AS home_short,
                COALESCE(at2.short_name, at2.name) AS away_short,
                COUNT(*) AS game_count
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at2 ON g.away_team_id = at2.id
            WHERE g.game_date = %s AND g.season = %s AND g.status = 'final'
            GROUP BY g.home_team_id, g.away_team_id, home_short, away_short
            ORDER BY home_short, away_short
        """, (recap_date, season))
        available_matchups = [dict(r) for r in cur.fetchall()]

        return {
            "date": date,
            "team_a": team_a,
            "team_b": team_b,
            "games": result_games,
            "is_doubleheader": len(result_games) > 1,
            "total_games": len(result_games),
            "available_matchups": available_matchups,
        }


@router.get("/games/daily-recap-dates")
def daily_recap_dates(
    season: int = Query(CURRENT_SEASON),
):
    """
    Return a list of dates that have completed games, for a date picker.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute("""
            SELECT DISTINCT DATE(game_date) as game_date
            FROM games
            WHERE season = %s AND status = 'final'
            ORDER BY game_date DESC
        """, (season,))

        dates = [str(r["game_date"]) for r in cur.fetchall()]

        return {
            "season": season,
            "dates": dates,
            "total_dates": len(dates),
        }


@router.get("/games/daily-recap-matchups")
def daily_recap_matchups(
    date: str = Query(..., description="Date in YYYY-MM-DD format"),
    season: int = Query(CURRENT_SEASON),
):
    """Return all distinct matchups on a given date for the matchup picker."""
    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute("""
            SELECT DISTINCT
                g.home_team_id, g.away_team_id,
                COALESCE(ht.short_name, g.home_team_name) AS home_short,
                COALESCE(at2.short_name, g.away_team_name) AS away_short,
                ht.logo_url AS home_logo,
                at2.logo_url AS away_logo,
                COUNT(*) AS game_count
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at2 ON g.away_team_id = at2.id
            WHERE g.game_date = %s AND g.season = %s AND g.status = 'final'
              AND g.home_team_id IS NOT NULL AND g.away_team_id IS NOT NULL
            GROUP BY g.home_team_id, g.away_team_id,
                     ht.short_name, g.home_team_name,
                     at2.short_name, g.away_team_name,
                     ht.logo_url, at2.logo_url
            ORDER BY home_short
        """, (date, season))

        matchups = []
        for r in cur.fetchall():
            row = dict(r)
            matchups.append({
                "home_team_id": row["home_team_id"],
                "away_team_id": row["away_team_id"],
                "home_short": row["home_short"],
                "away_short": row["away_short"],
                "home_logo": row["home_logo"],
                "away_logo": row["away_logo"],
                "game_count": row["game_count"],
            })

        return {"date": date, "matchups": matchups}


@router.get("/games/key-matchup")
def key_matchup(
    date: str = Query(..., description="Date in YYYY-MM-DD format"),
    season: int = Query(CURRENT_SEASON),
    game_id: Optional[str] = None,
):
    """
    Return the key matchup of the day for social media graphic.
    Auto-picks the most playoff-impactful game, or uses game_id override.
    Returns both teams' stats, top 3 hitters (by wRC+, 50+ PA),
    top 3 pitchers (by FIP, 15+ IP), and team aggregate comparison.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # ── 1. Get all games for this date involving PNW teams ──
        # Both teams must be PNW-state (WA/OR/ID/MT/BC) so that the
        # homepage "matchup of the day" never features a non-PNW opponent.
        cur.execute("""
            SELECT g.id, g.game_date, g.status, g.is_conference_game,
                   g.home_team_id, g.away_team_id,
                   g.home_score, g.away_score, g.game_time,
                   ht.short_name AS home_short, ht.logo_url AS home_logo,
                   at2.short_name AS away_short, at2.logo_url AS away_logo,
                   hd.level AS home_division, ad.level AS away_division,
                   hc.abbreviation AS home_conf, ac.abbreviation AS away_conf
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at2 ON g.away_team_id = at2.id
            LEFT JOIN conferences hc ON ht.conference_id = hc.id
            LEFT JOIN divisions hd ON hc.division_id = hd.id
            LEFT JOIN conferences ac ON at2.conference_id = ac.id
            LEFT JOIN divisions ad ON ac.division_id = ad.id
            WHERE g.game_date = %s AND g.season = %s
              AND ht.state IN ('WA','OR','ID','MT','BC')
              AND at2.state IN ('WA','OR','ID','MT','BC')
            ORDER BY g.id
        """, (date, season))
        games = [dict(r) for r in cur.fetchall()]

        # ── 1b. Merge future scheduled games if date >= today ──
        from pathlib import Path
        import json as _json
        from datetime import date as _date_type
        try:
            req_date = _date_type.fromisoformat(date)
            today = _date_type.today()
        except ValueError:
            req_date = None
            today = None

        if req_date and req_date >= today:
            fs_path = Path(__file__).parent.parent.parent / "data" / "future_schedules.json"
            if fs_path.exists():
                try:
                    with open(fs_path) as _f:
                        fs_data = _json.load(_f)
                    fs_games = [g for g in fs_data.get("games", []) if g.get("game_date") == date]

                    # Build set of existing game keys to avoid dupes
                    existing_keys = set()
                    for g in games:
                        h = g.get("home_team_id")
                        a = g.get("away_team_id")
                        if h and a:
                            existing_keys.add((h, a))
                            existing_keys.add((a, h))

                    # Look up team info for enrichment
                    fs_team_ids = set()
                    for fg in fs_games:
                        if fg.get("home_team_id"): fs_team_ids.add(fg["home_team_id"])
                        if fg.get("away_team_id"): fs_team_ids.add(fg["away_team_id"])

                    fs_team_info = {}
                    if fs_team_ids:
                        ph2 = ",".join(["%s"] * len(fs_team_ids))
                        cur.execute(f"""
                            SELECT t.id, t.short_name, t.logo_url, t.state,
                                   c.abbreviation AS conf_abbrev,
                                   d.level AS div_level
                            FROM teams t
                            LEFT JOIN conferences c ON t.conference_id = c.id
                            LEFT JOIN divisions d ON c.division_id = d.id
                            WHERE t.id IN ({ph2})
                        """, list(fs_team_ids))
                        for r in cur.fetchall():
                            fs_team_info[r["id"]] = dict(r)

                    PNW_STATES = {"WA", "OR", "ID", "MT", "BC"}
                    for idx, fg in enumerate(fs_games):
                        h = fg.get("home_team_id")
                        a = fg.get("away_team_id")
                        if h and a and (h, a) not in existing_keys:
                            hi = fs_team_info.get(h, {})
                            ai = fs_team_info.get(a, {})
                            # Same PNW-both-teams filter as the SQL above:
                            # skip any game where either side isn't PNW-state.
                            if hi.get("state") not in PNW_STATES or ai.get("state") not in PNW_STATES:
                                continue
                            games.append({
                                "id": f"future_{h}_{a}_{idx}",
                                "game_date": fg["game_date"],
                                "status": "scheduled",
                                "is_conference_game": fg.get("is_conference", False),
                                "home_team_id": h,
                                "away_team_id": a,
                                "home_score": None,
                                "away_score": None,
                                "game_time": None,
                                "home_short": hi.get("short_name", fg.get("home_team", "")),
                                "home_logo": hi.get("logo_url"),
                                "away_short": ai.get("short_name", fg.get("away_team", "")),
                                "away_logo": ai.get("logo_url"),
                                "home_division": hi.get("div_level", fg.get("division")),
                                "away_division": ai.get("div_level", fg.get("division")),
                                "home_conf": hi.get("conf_abbrev", ""),
                                "away_conf": ai.get("conf_abbrev", ""),
                            })
                except Exception:
                    pass

        if not games:
            return {"matchup": None, "games": [], "date": date}

        # ── 2. Pick the best matchup ──
        # Resolution order:
        #   1. Explicit game_id override (never cached).
        #   2. Cached pick for this date (stable once chosen so the homepage
        #      widget doesn't flip to a different game when records update
        #      midway through the day).
        #   3. Score each game and pick the best.
        cache_path = Path(__file__).parent.parent.parent / "data" / "key_matchup_cache.json"
        cache = {}
        if cache_path.exists():
            try:
                with open(cache_path) as _cf:
                    cache = _json.load(_cf) or {}
            except Exception:
                cache = {}

        chosen = None
        if game_id:
            chosen = next((g for g in games if str(g["id"]) == str(game_id)), None)
        elif date in cache:
            entry = cache[date] or {}
            cached_id = entry.get("game_id")
            cached_h = entry.get("home_team_id")
            cached_a = entry.get("away_team_id")
            # Prefer id match. Fall back to (home, away) pair so the cache
            # survives a future_H_A_IDX placeholder being replaced by a real
            # DB id once the game is scraped.
            chosen = next((g for g in games if str(g["id"]) == str(cached_id)), None)
            if chosen is None and cached_h and cached_a:
                chosen = next(
                    (g for g in games
                     if g.get("home_team_id") == cached_h
                     and g.get("away_team_id") == cached_a),
                    None,
                )

        if not chosen:
            # Score games: prioritize quality of teams first, then closeness.
            # A 60/40 game between two good teams beats a 50/50 game
            # between two bad teams. Division level matters (D1 > NWAC).
            team_ids = set()
            for g in games:
                if g["home_team_id"]:
                    team_ids.add(g["home_team_id"])
                if g["away_team_id"]:
                    team_ids.add(g["away_team_id"])

            if team_ids:
                ph = ",".join(["%s"] * len(team_ids))
                cur.execute(f"""
                    SELECT team_id, wins, losses
                    FROM team_season_stats
                    WHERE season = %s AND team_id IN ({ph})
                """, [season] + list(team_ids))
                recs = {r["team_id"]: (r["wins"], r["losses"]) for r in cur.fetchall()}
            else:
                recs = {}

            # Division tier bonus (4-year schools prioritized over NWAC)
            div_bonus = {"D1": 15, "D2": 15, "D3": 15, "NAIA": 15, "JUCO": 5}

            best_score = -1
            for g in games:
                score = 0
                hw, hl = recs.get(g["home_team_id"], (0, 0))
                aw, al = recs.get(g["away_team_id"], (0, 0))
                h_total = hw + hl
                a_total = aw + al

                # Division tier bonus (use higher of the two teams)
                h_div = g.get("home_division") or ""
                a_div = g.get("away_division") or ""
                score += max(div_bonus.get(h_div, 0), div_bonus.get(a_div, 0))

                if h_total >= 10 and a_total >= 10:
                    h_pct = hw / h_total
                    a_pct = aw / a_total

                    # Quality bonus (heavily weighted - best teams matter most)
                    # Combined win% scaled to 0-30 points
                    avg_pct = (h_pct + a_pct) / 2
                    score += 30 * avg_pct

                    # Closeness bonus (moderate weight)
                    # 0 difference = +10, 0.5 difference = +0
                    closeness = 1 - abs(h_pct - a_pct)
                    score += 10 * closeness

                if score > best_score:
                    best_score = score
                    chosen = g

        if not chosen:
            chosen = games[0]

        # Persist the pick so subsequent calls on the same date stay stable.
        # Only cache real (non-override) selections so manual overrides via
        # ?game_id=... don't get baked in.
        if not game_id and chosen:
            cache[date] = {
                "game_id": chosen.get("id"),
                "home_team_id": chosen.get("home_team_id"),
                "away_team_id": chosen.get("away_team_id"),
            }
            try:
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                with open(cache_path, "w") as _cf:
                    _json.dump(cache, _cf, indent=2)
            except Exception:
                pass

        # ── 3. Fetch team stats for both teams ──
        matchup_teams = []
        for side in ("home", "away"):
            tid = chosen[f"{side}_team_id"]
            if not tid:
                continue

            # Team info
            cur.execute("""
                SELECT t.id, t.name, t.short_name, t.logo_url, t.city, t.state,
                       c.abbreviation as conference_abbrev,
                       d.level as division_level
                FROM teams t
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                WHERE t.id = %s
            """, (tid,))
            team = cur.fetchone()
            if not team:
                continue
            team = dict(team)

            # Record + conference record
            cur.execute("""
                SELECT wins, losses, ties,
                       conference_wins, conference_losses
                FROM team_season_stats
                WHERE team_id = %s AND season = %s
            """, (tid, season))
            record = cur.fetchone()
            team["record"] = dict(record) if record else {
                "wins": 0, "losses": 0, "ties": 0,
                "conference_wins": 0, "conference_losses": 0
            }

            # National ranking
            cur.execute("""
                SELECT composite_rank, num_sources
                FROM composite_rankings
                WHERE team_id = %s AND season = %s
            """, (tid, season))
            ranking = cur.fetchone()
            team["national_rank"] = dict(ranking) if ranking else None

            # Team batting aggregates (expanded)
            cur.execute("""
                SELECT
                    CASE WHEN SUM(at_bats) > 0
                         THEN ROUND((SUM(hits)::numeric / SUM(at_bats))::numeric, 3) ELSE 0 END as team_avg,
                    CASE WHEN SUM(plate_appearances) > 0
                         THEN ROUND(((SUM(hits) + SUM(walks) + SUM(hit_by_pitch))::numeric / SUM(plate_appearances))::numeric, 3) ELSE 0 END as team_obp,
                    CASE WHEN SUM(at_bats) > 0
                         THEN ROUND(((SUM(hits) - SUM(doubles) - SUM(triples) - SUM(home_runs) + 2*SUM(doubles) + 3*SUM(triples) + 4*SUM(home_runs))::numeric / SUM(at_bats))::numeric, 3) ELSE 0 END as team_slg,
                    CASE WHEN SUM(plate_appearances) > 0
                         THEN ROUND((SUM(home_runs)::numeric / SUM(plate_appearances))::numeric, 4) ELSE 0 END as hr_per_pa,
                    -- bb and k rates raw totals; wRC+ PA-weighted w/ NULL guard.
                    ROUND((SUM(walks)::numeric / NULLIF(SUM(plate_appearances), 0))::numeric, 3) as avg_bb_pct,
                    ROUND((SUM(strikeouts)::numeric / NULLIF(SUM(plate_appearances), 0))::numeric, 3) as avg_k_pct,
                    ROUND((SUM(wrc_plus * plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL)
                           / NULLIF(SUM(plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL), 0))::numeric, 0) as avg_wrc_plus,
                    SUM(home_runs) as total_hr,
                    SUM(stolen_bases) as total_sb,
                    SUM(runs) as total_runs,
                    ROUND(SUM(offensive_war)::numeric, 1) as total_owar
                FROM batting_stats
                WHERE team_id = %s AND season = %s AND plate_appearances >= 10
            """, (tid, season))
            batting = cur.fetchone()
            team["batting"] = dict(batting) if batting else {}

            # Team pitching aggregates (expanded).
            # Team totals are a straight SUM(pitching_stats) for this team and
            # season. No box-score reconciliation: the box-score sum can
            # double-count (orphan rows where player_id is NULL get added on
            # top of the resolved rows) which was inflating team ERA/WHIP/BAA.
            # pitching_stats is the canonical per-pitcher season table and is
            # the same source the team's own official site uses, so summing it
            # matches their published team ERA exactly.
            cur.execute("""
                SELECT
                    ROUND(SUM(COALESCE(pitching_war, 0))::numeric, 1) AS total_pwar,
                    ROUND((SUM(fip * ip_outs(innings_pitched))
                             FILTER (WHERE fip IS NOT NULL AND innings_pitched >= 3)
                           / NULLIF(SUM(ip_outs(innings_pitched))
                             FILTER (WHERE fip IS NOT NULL AND innings_pitched >= 3), 0))::numeric, 2) AS avg_fip,
                    ROUND(SUM(COALESCE(strikeouts, 0))::numeric
                          / NULLIF(SUM(COALESCE(batters_faced, 0)), 0), 3) AS avg_k_pct,
                    ROUND(SUM(COALESCE(walks, 0))::numeric
                          / NULLIF(SUM(COALESCE(batters_faced, 0)), 0), 3) AS avg_bb_pct,
                    CASE WHEN SUM(ip_outs(COALESCE(innings_pitched, 0))) > 0
                         THEN ROUND((SUM(COALESCE(earned_runs, 0)) * 9.0
                                     / NULLIF(SUM(ip_outs(COALESCE(innings_pitched, 0))) / 3.0, 0))::numeric, 2)
                         ELSE 0 END AS team_era,
                    CASE WHEN SUM(ip_outs(COALESCE(innings_pitched, 0))) > 0
                         THEN ROUND(((SUM(COALESCE(walks, 0))
                                      + SUM(COALESCE(hits_allowed, 0)))::numeric
                                     / NULLIF(SUM(ip_outs(COALESCE(innings_pitched, 0))) / 3.0, 0))::numeric, 2)
                         ELSE 0 END AS team_whip,
                    CASE WHEN (SUM(COALESCE(batters_faced, 0))
                               - SUM(COALESCE(walks, 0))
                               - SUM(COALESCE(hit_batters, 0))) > 0
                         THEN ROUND((SUM(COALESCE(hits_allowed, 0))::numeric
                              / (SUM(COALESCE(batters_faced, 0))
                                 - SUM(COALESCE(walks, 0))
                                 - SUM(COALESCE(hit_batters, 0))))::numeric, 3)
                         ELSE 0 END AS opp_avg,
                    CASE WHEN SUM(COALESCE(batters_faced, 0)) > 0
                         THEN ROUND((SUM(COALESCE(home_runs_allowed, 0))::numeric
                                     / SUM(COALESCE(batters_faced, 0)))::numeric, 4)
                         ELSE 0 END AS opp_hr_per_pa,
                    SUM(COALESCE(runs_allowed, 0)) AS total_runs_allowed
                FROM pitching_stats
                WHERE team_id = %s AND season = %s
            """, (tid, season))
            pitching = cur.fetchone()
            team["pitching"] = dict(pitching) if pitching else {}

            # Top 5 hitters by wRC+ (50+ PA)
            cur.execute("""
                SELECT p.id as player_id, p.first_name, p.last_name, p.position,
                       bs.wrc_plus, bs.batting_avg, bs.on_base_pct, bs.slugging_pct,
                       bs.home_runs, bs.rbi, bs.stolen_bases,
                       bs.plate_appearances, bs.offensive_war, bs.k_pct, bs.bb_pct
                FROM batting_stats bs
                JOIN players p ON bs.player_id = p.id
                WHERE bs.team_id = %s AND bs.season = %s AND bs.plate_appearances >= 50
                ORDER BY bs.wrc_plus DESC NULLS LAST
                LIMIT 5
            """, (tid, season))
            team["top_hitters"] = [dict(r) for r in cur.fetchall()]

            # Top 3 starters by FIP (5+ GS)
            cur.execute("""
                SELECT p.id as player_id, p.first_name, p.last_name, p.position,
                       ps.fip, ps.era, ps.innings_pitched, ps.strikeouts,
                       ps.walks, ps.k_pct, ps.bb_pct, ps.whip,
                       ps.pitching_war, ps.games_started,
                       COALESCE(ps.k_pct, 0) - COALESCE(ps.bb_pct, 0) as k_bb_pct
                FROM pitching_stats ps
                JOIN players p ON ps.player_id = p.id
                WHERE ps.team_id = %s AND ps.season = %s
                  AND COALESCE(ps.games_started, 0) >= 5
                ORDER BY ps.fip ASC NULLS LAST
                LIMIT 3
            """, (tid, season))
            team["top_starters"] = [dict(r) for r in cur.fetchall()]

            # Top 2 relievers by blended FIP + K-BB% (10+ IP, fewer than 5 GS)
            # Score: high K-BB% is good, low FIP is good
            cur.execute("""
                SELECT p.id as player_id, p.first_name, p.last_name, p.position,
                       ps.fip, ps.era, ps.innings_pitched, ps.strikeouts,
                       ps.walks, ps.k_pct, ps.bb_pct, ps.whip,
                       ps.pitching_war, ps.games_started,
                       COALESCE(ps.k_pct, 0) - COALESCE(ps.bb_pct, 0) as k_bb_pct
                FROM pitching_stats ps
                JOIN players p ON ps.player_id = p.id
                WHERE ps.team_id = %s AND ps.season = %s
                  AND ps.innings_pitched >= 10
                  AND COALESCE(ps.games_started, 0) < 5
                ORDER BY (
                    (COALESCE(ps.k_pct, 0) - COALESCE(ps.bb_pct, 0)) * 100
                    - COALESCE(ps.fip, 5) * 3
                ) DESC NULLS LAST
                LIMIT 2
            """, (tid, season))
            team["top_relievers"] = [dict(r) for r in cur.fetchall()]

            team["side"] = side
            matchup_teams.append(team)

        # Build game list for dropdown
        game_list = []
        for g in games:
            game_list.append({
                "id": g["id"],
                "home_short": g["home_short"],
                "away_short": g["away_short"],
                "home_logo": g["home_logo"],
                "away_logo": g["away_logo"],
                "status": g["status"],
                "game_time": g.get("game_time"),
                "is_conference_game": g.get("is_conference_game"),
                "home_division": g.get("home_division"),
                "away_division": g.get("away_division"),
            })

        # ── Compute win probability for the chosen matchup ──
        home_wp = None
        away_wp = None
        h_id = chosen.get("home_team_id")
        a_id = chosen.get("away_team_id")
        if h_id and a_id:
            ratings = _bulk_power_ratings(cur, season)
            if h_id in ratings and a_id in ratings:
                home_wp = round(_elo_win_prob(ratings[h_id], ratings[a_id]), 3)
                away_wp = round(1.0 - home_wp, 3)

        return {
            "matchup": {
                "game_id": chosen["id"],
                "date": chosen["game_date"],
                "status": chosen.get("status"),
                "is_conference_game": chosen.get("is_conference_game"),
                "teams": matchup_teams,
                "home_win_prob": home_wp,
                "away_win_prob": away_wp,
            },
            "games": game_list,
            "date": date,
        }


@router.get("/games/future")
def games_future(
    team_id: Optional[int] = None,
    division: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    limit: int = Query(100),
):
    """
    Get future scheduled games from the pre-scraped future_schedules.json.
    Supports filtering by team_id, division, and date range.
    """
    from pathlib import Path
    import json

    path = Path(__file__).parent.parent.parent / "data" / "future_schedules.json"
    if not path.exists():
        return {"games": [], "total": 0, "last_updated": None}

    with open(path) as f:
        data = json.load(f)

    games = data.get("games", [])
    last_updated = data.get("last_updated")

    # Filter by team
    if team_id:
        games = [g for g in games if g.get("home_team_id") == team_id or g.get("away_team_id") == team_id]

    # Filter by division
    if division:
        games = [g for g in games if g.get("division", "").upper() == division.upper()]

    # Filter by date range
    if start_date:
        games = [g for g in games if g.get("game_date", "") >= start_date]
    if end_date:
        games = [g for g in games if g.get("game_date", "") <= end_date]

    # Build a team info lookup for logos / names / conference. We
    # also pull conference_abbrev so we can flag CCC-vs-CCC games as
    # POSTSEASON on the fly (the JSON future-schedules feed doesn't
    # know about the playoff bracket — we compute it here).
    team_info = {}
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT t.id, t.short_name, t.logo_url,
                       c.abbreviation AS conference_abbrev
                FROM teams t
                LEFT JOIN conferences c ON c.id = t.conference_id
                WHERE t.is_active = 1
            """)
            for row in cur.fetchall():
                team_info[row["id"]] = {
                    "short_name": row["short_name"],
                    "logo_url": row["logo_url"],
                    "conference_abbrev": row["conference_abbrev"],
                }
    except Exception:
        pass

    # Enrich games with team logos / names / postseason flag.
    # Postseason rule (per coach decision 2026-04-30): any game
    # involving a CCC team from today onwards is a playoff game —
    # CCC tournament starts tomorrow and CCC teams play out-of-CCC
    # opponents in NAIA regionals starting next week.
    from datetime import date as _date
    today_iso = _date.today().isoformat()
    enriched = []
    for g in games[:limit]:
        home_id = g.get("home_team_id")
        away_id = g.get("away_team_id")
        home_conf = team_info.get(home_id, {}).get("conference_abbrev")
        away_conf = team_info.get(away_id, {}).get("conference_abbrev")
        is_postseason = (
            (home_conf == 'CCC' or away_conf == 'CCC')
            and (g.get("game_date") or '') >= today_iso
        )
        enriched.append({
            **g,
            "home_logo": team_info.get(home_id, {}).get("logo_url") if home_id else None,
            "away_logo": team_info.get(away_id, {}).get("logo_url") if away_id else None,
            "home_short": team_info.get(home_id, {}).get("short_name", g.get("home_team", "")),
            "away_short": team_info.get(away_id, {}).get("short_name", g.get("away_team", "")),
            "status": "scheduled",
            "is_postseason": is_postseason,
            # If marked as postseason, suppress the conference flag.
            "is_conference": False if is_postseason else g.get("is_conference", False),
        })

    return {"games": enriched, "total": len(games), "last_updated": last_updated}


def _dedup_live_games(games):
    """Remove duplicate live-score entries.

    The live_scores.json has one row per *team* per game, so CWU-at-MSUB
    appears twice (CWU's row and MSUB's row).  We keep whichever row
    comes first and drop the mirror.  Two rows are duplicates when:
      • same date
      • one's team matches the other's opponent (name overlap)
      • scores match (possibly swapped)
    When keeping one, prefer the row that has a box_score_url.
    """
    # ── Team-name normalization & lookup ──────────────────────────
    # Different sources spell the same team many ways:
    #   "MSUB" / "MSU-Billings Yellowjackets" / "Montana State University-Billings"
    #   / "Montana State University Billings" / "MSU Billings"
    # We build a cache that maps every reasonable spelling to the team id.
    import re as _re

    _ABBREV_MAP = {
        "wash.": "washington", "ore.": "oregon", "mont.": "montana",
        "so.": "southern", "no.": "northern",
        "e.": "eastern", "w.": "western", "cen.": "central",
        "s.": "southern", "n.": "northern",
        "u.": "university", "univ.": "university", "univ": "university",
        "coll.": "college", "coll": "college",
    }
    _TRAILING_SUFFIX = ("university", "college", "institute", "academy")
    _LEADING_PREFIX = ("university of ", "college of ", "the ")

    # Hardcoded aliases for PNW teams whose short/long spellings don't
    # share enough tokens for the generic normalizer to bridge.
    _HARD_ALIASES = {
        # Montana State Billings ↔ MSU-Billings
        "montana state billings": "msu billings",
        "montana state university billings": "msu billings",
    }

    def _team_name_normalize(s):
        """Lowercase + strip punctuation/rank/parens and expand abbreviations."""
        if not s:
            return ""
        s = s.strip().lower()
        # Hyphens / en-dash / em-dash → space
        s = _re.sub(r"[-\u2013\u2014]", " ", s)
        # Smart/straight apostrophes gone
        s = s.replace("\u2019", "").replace("\u2018", "").replace("'", "")
        # Strip trailing parenthetical: "pacific (ore.)" → "pacific"
        s = _re.sub(r"\s*\([^)]*\)\s*$", "", s).strip()
        # Strip leading rank: "#7 oregon" / "no. 7 oregon"
        s = _re.sub(r"^(?:no\.\s*\d+|#\d+)\s+", "", s).strip()
        # Strip trailing score digits: "gonzaga 8" → "gonzaga"
        s = _re.sub(r"\s*\d+$", "", s).strip()
        # "St." handling: leading = Saint, elsewhere = State
        # ("St. Martin's" → "saint martins", "Oregon St." → "oregon state")
        if s.startswith("st. "):
            s = "saint " + s[4:]
        elif s.startswith("st "):
            s = "saint " + s[3:]
        # Any remaining "st." / "st" tokens → "state"
        s = _re.sub(r"\bst\.", "state", s)
        # Expand token-level abbreviations
        s = " ".join(_ABBREV_MAP.get(w, w) for w in s.split())
        # Collapse whitespace
        s = _re.sub(r"\s+", " ", s).strip()
        # Apply hardcoded aliases last
        return _HARD_ALIASES.get(s, s)

    def _strip_trailing_suffix(s):
        for w in _TRAILING_SUFFIX:
            if s.endswith(" " + w):
                return s[: -len(w) - 1].strip()
        return s

    def _strip_leading_prefix(s):
        for p in _LEADING_PREFIX:
            if s.startswith(p):
                return s[len(p):].strip()
        return s

    _team_id_cache = {}

    def _register(key, tid):
        if key and key not in _team_id_cache:
            _team_id_cache[key] = tid

    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT id, short_name, name, school_name FROM teams")
            for row in cur.fetchall():
                tid = row["id"]
                for field in ("short_name", "name", "school_name"):
                    val = row[field]
                    if not val:
                        continue
                    n = _team_name_normalize(val)
                    _register(n, tid)
                    # Mascot variant: strip the last word of the full name
                    # ("Seattle U Redhawks" → "seattle u",
                    #  "MSU-Billings Yellowjackets" → "msu billings")
                    if field == "name":
                        parts = n.split()
                        if len(parts) >= 2:
                            _register(" ".join(parts[:-1]), tid)
                    # Trailing "University"/"College" stripped
                    _register(_strip_trailing_suffix(n), tid)
                    # Leading "University of " / "The " stripped
                    _register(_strip_leading_prefix(n), tid)
                    # Both: leading and trailing
                    _register(
                        _strip_trailing_suffix(_strip_leading_prefix(n)), tid
                    )
    except Exception:
        pass

    # Back-compat helper used further down for string-only comparisons
    def _expand_abbrevs(s):
        """Normalize a raw name for string-equality fallback."""
        return _team_name_normalize(s)

    def _resolve(name):
        """Return team id for any reasonable spelling, or None."""
        if not name:
            return None
        n = _team_name_normalize(name)
        tid = _team_id_cache.get(n)
        if tid:
            return tid
        # Fallback: try stripping trailing suffix or leading prefix
        for variant in (
            _strip_trailing_suffix(n),
            _strip_leading_prefix(n),
            _strip_trailing_suffix(_strip_leading_prefix(n)),
        ):
            if variant != n:
                tid = _team_id_cache.get(variant)
                if tid:
                    return tid
        return None

    def _is_live_dup(a, b):
        if str(a.get("date", ""))[:10] != str(b.get("date", ""))[:10]:
            return False
        # Resolve team ids via the lookup
        a_team_id = _resolve(a.get("team"))
        a_opp_id = _resolve(a.get("opponent"))
        b_team_id = _resolve(b.get("team"))
        b_opp_id = _resolve(b.get("opponent"))

        # Check same perspective (a.team ≈ b.team AND a.opponent ≈ b.opponent)
        # This catches DB "final" entries replacing stale live "scheduled" entries
        # where the same game appears twice with different name spellings (EOU vs Eastern Oregon University)
        teams_match = False
        if a_team_id and b_team_id and a_team_id == b_team_id:
            if a_opp_id and b_opp_id and a_opp_id == b_opp_id:
                teams_match = True
            elif not a_opp_id or not b_opp_id:
                teams_match = True  # one side unresolved, trust the other

        # Check if teams are swapped (a.team ≈ b.opponent AND a.opponent ≈ b.team)
        teams_swapped = False
        if not teams_match:
            # ID-based match (most reliable)
            if a_team_id and b_opp_id and a_team_id == b_opp_id:
                if a_opp_id and b_team_id and a_opp_id == b_team_id:
                    teams_swapped = True
                elif not a_opp_id or not b_team_id:
                    teams_swapped = True  # one side unresolved, trust the other
            # Fallback: string match with abbreviation expansion (handles non-DB teams)
            if not teams_swapped:
                a_team_s = _expand_abbrevs(str(a.get("team", "")).strip().lower())
                b_opp_s = _expand_abbrevs(str(b.get("opponent", "")).strip().lower())
                b_team_s = _expand_abbrevs(str(b.get("team", "")).strip().lower())
                a_opp_s = _expand_abbrevs(str(a.get("opponent", "")).strip().lower())
                teams_swapped = (a_team_s == b_opp_s and b_team_s == a_opp_s)

        if not teams_match and not teams_swapped:
            return False

        # Scores must match
        a_ts = a.get("team_score")
        a_os = a.get("opponent_score")
        b_ts = b.get("team_score")
        b_os = b.get("opponent_score")
        # Both scheduled (no scores yet):
        # - teams_swapped → same game from two perspectives → dedup
        # - teams_match → might be a doubleheader OR a cross-source duplicate.
        #   Differentiate by game time: two same-perspective scheduled entries
        #   with different game times are a real doubleheader (keep both);
        #   otherwise they're the same game seen via multiple sources (dedup).
        if a_ts is None and b_ts is None:
            if teams_swapped:
                return True
            # Same perspective: use time to tell DH from duplicate.
            def _norm_time(t):
                if not t:
                    return None
                s = str(t).strip().lower()
                # "12 p.m." and "12:00 PM" → "12pm"
                s = s.replace(" ", "").replace(".", "").replace(":00", "")
                return s or None
            a_time = _norm_time(a.get("time"))
            b_time = _norm_time(b.get("time"))
            # Both times present and different → real doubleheader, keep both
            if a_time and b_time and a_time != b_time:
                return False
            # Missing time on either side, or matching times → duplicate
            return True
        # One scheduled, one final — same game, DB has the updated result
        if a_ts is None or b_ts is None:
            return True
        try:
            if teams_match:
                # Same perspective: scores should match directly
                return int(a_ts) == int(b_ts) and int(a_os) == int(b_os)
            else:
                # Swapped perspective: scores should be swapped
                return int(a_ts) == int(b_os) and int(a_os) == int(b_ts)
        except (TypeError, ValueError):
            return False

    def _richness(entry):
        """Score how much useful data an entry has — higher is better."""
        score = 0
        if entry.get("status") == "final":
            score += 10
        if entry.get("box_score_url"):
            score += 5
        if entry.get("win_pitcher"):
            score += 3
        if entry.get("home_hits") is not None:
            score += 2
        if entry.get("away_hits") is not None:
            score += 2
        # Scheduled entries with a game time are more useful than ones without
        if str(entry.get("time", "")).strip():
            score += 2
        # Entries with a team logo beat ones with a missing logo
        if entry.get("team_logo"):
            score += 1
        if entry.get("opponent_logo"):
            score += 1
        # DB-merged entries (id starts with "db_") have enriched data
        if str(entry.get("id", "")).startswith("db_"):
            score += 1
        return score

    deduped = []
    for g in games:
        dup_idx = None
        for i, prev in enumerate(deduped):
            if _is_live_dup(prev, g):
                dup_idx = i
                break
        if dup_idx is not None:
            prev = deduped[dup_idx]
            # Keep whichever entry has richer data
            if _richness(g) > _richness(prev):
                deduped[dup_idx] = g
        else:
            deduped.append(g)
    return deduped


@router.get("/games/live")
def games_live():
    """
    Get live scores, today's games, recent results, and upcoming games.
    Reads from the live_scores.json file generated by scrape_live_scores.py,
    then merges in NWAC (JUCO) games from the database since those can't
    be scraped by the live scores scraper (WAF blocks server IPs).
    """
    import json as _json
    from pathlib import Path as _Path
    from datetime import date as _date, timedelta as _timedelta

    live_scores_path = _Path(__file__).parent.parent.parent / "data" / "live_scores.json"

    data = {
        "today": [],
        "recent": [],
        "upcoming": [],
        "last_updated": None,
        "date": None,
    }

    if live_scores_path.exists():
        try:
            with open(live_scores_path) as f:
                data = _json.load(f)

            # Dedup live-score entries - the JSON has one entry per team per game,
            # so CWU-vs-MSUB appears twice (once from each team's schedule).
            for section in ("today", "recent", "upcoming"):
                data[section] = _dedup_live_games(data.get(section, []))

            # ── Move stale games out of "today" ──
            # If the JSON was generated hours ago, some games in "today" may
            # actually belong to yesterday.  Relocate them to "recent".
            from datetime import datetime as _dt_cls
            from zoneinfo import ZoneInfo as _ZI
            _today_str = _dt_cls.now(_ZI("America/Los_Angeles")).strftime("%Y-%m-%d")
            still_today = []
            for g in data.get("today", []):
                gd = str(g.get("date", ""))[:10]
                if gd == _today_str or not gd:
                    still_today.append(g)
                else:
                    data.setdefault("recent", []).append(g)
            data["today"] = still_today
        except (ValueError, OSError):
            pass

    # ── Merge games from database ──
    # live_scores.json covers D1/D2/D3 games from Sidearm/PrestoSports but can
    # miss games. NAIA and JUCO come from separate scrapers. Merge all divisions
    # from the DB so the scoreboard shows every game (final + scheduled).
    try:
        from datetime import datetime as _datetime
        from zoneinfo import ZoneInfo
        _pacific = ZoneInfo("America/Los_Angeles")
        today = _datetime.now(_pacific).date()
        recent_start = today - _timedelta(days=2)
        upcoming_end = today + _timedelta(days=1)

        with get_connection() as conn:
            cur = conn.cursor()
            # Fetch all games in range (final + scheduled); seen_db dedup
            # below handles duplicate scrape entries (same date + teams + score).
            # We include scheduled games so NWAC (and any other DB-only division)
            # shows upcoming games on the scoreboard.
            cur.execute("""
                SELECT g.id, g.game_date, g.game_time,
                    g.home_score, g.away_score,
                    g.home_hits, g.home_errors,
                    g.away_hits, g.away_errors,
                    g.home_team_id, g.away_team_id,
                    g.innings, g.is_conference_game, g.status,
                    g.source_url,
                    COALESCE(ht.short_name, g.home_team_name) AS home_name,
                    ht.logo_url AS home_logo,
                    COALESCE(at2.short_name, g.away_team_name) AS away_name,
                    at2.logo_url AS away_logo,
                    hd.level AS home_div,
                    ad.level AS away_div
                FROM games g
                LEFT JOIN teams ht ON g.home_team_id = ht.id
                LEFT JOIN teams at2 ON g.away_team_id = at2.id
                LEFT JOIN conferences hc ON ht.conference_id = hc.id
                LEFT JOIN divisions hd ON hc.division_id = hd.id
                LEFT JOIN conferences ac ON at2.conference_id = ac.id
                LEFT JOIN divisions ad ON ac.division_id = ad.id
                WHERE g.game_date >= %s
                  AND g.game_date <= %s
                  AND (g.status = 'final' OR g.game_date >= %s)
                  AND g.home_team_id IS DISTINCT FROM g.away_team_id
                ORDER BY g.game_date, g.id DESC
            """, (recent_start, upcoming_end, today))

            db_rows = []
            seen_db = set()
            for row in cur.fetchall():
                game_date_str = str(row["game_date"])
                dedup_key = (
                    game_date_str,
                    (row["home_name"] or "").lower(),
                    (row["away_name"] or "").lower(),
                    row["home_score"],
                    row["away_score"],
                )
                if dedup_key in seen_db:
                    continue
                seen_db.add(dedup_key)
                db_rows.append(row)

            # Fetch W/L/S pitcher decisions for all merged games
            decisions = {}
            db_game_ids = [r["id"] for r in db_rows]
            if db_game_ids:
                ph = ",".join(["%s"] * len(db_game_ids))
                cur.execute(f"""
                    SELECT gp.game_id, gp.player_name, gp.decision,
                           p.first_name, p.last_name
                    FROM game_pitching gp
                    LEFT JOIN players p ON gp.player_id = p.id
                    WHERE gp.game_id IN ({ph}) AND gp.decision IN ('W', 'L', 'S')
                """, db_game_ids)
                for r in cur.fetchall():
                    gid = r["game_id"]
                    if gid not in decisions:
                        decisions[gid] = {}
                    name = r["last_name"] or r["player_name"].split(",")[0].strip() if r["player_name"] else None
                    decisions[gid][r["decision"]] = name

            # Backfill hits from game_batting for games missing them
            hits_backfill = {}
            needs_hits = [r["id"] for r in db_rows if r["home_hits"] is None]
            if needs_hits:
                ph2 = ",".join(["%s"] * len(needs_hits))
                cur.execute(f"""
                    SELECT gb.game_id, gb.team_id, SUM(gb.hits) AS h
                    FROM game_batting gb
                    WHERE gb.game_id IN ({ph2})
                    GROUP BY gb.game_id, gb.team_id
                """, needs_hits)
                for r in cur.fetchall():
                    hits_backfill.setdefault(r["game_id"], {})[r["team_id"]] = r["h"]

            for row in db_rows:
                game_date_str = str(row["game_date"])
                division = row["home_div"] or row["away_div"] or ""
                d = decisions.get(row["id"], {})

                # Resolve hits: prefer games table, fall back to game_batting
                hb = hits_backfill.get(row["id"], {})
                home_hits = row["home_hits"]
                away_hits = row["away_hits"]
                if home_hits is None and hb:
                    # home_team_id may be None for non-PNW opponents
                    htid = row.get("home_team_id")
                    atid = row.get("away_team_id")
                    home_hits = hb.get(htid) if htid else None
                    away_hits = hb.get(atid) if atid else None

                # Format as live-scores-style object (home team perspective)
                nwac_game = {
                    "id": f"db_{row['id']}",
                    "team": row["home_name"] or "TBD",
                    "team_division": division,
                    "team_logo": row["home_logo"] or "",
                    "opponent": row["away_name"] or "TBD",
                    "opponent_display": row["away_name"] or "TBD",
                    "opponent_logo": row["away_logo"] or "",
                    "date": game_date_str,
                    "time": row["game_time"] or "",
                    "status": row["status"] or "final",
                    "game_state_display": "FINAL" if row["status"] == "final" else (row["game_time"] or "Scheduled"),
                    "location": "home",
                    "team_score": str(row["home_score"]) if row["home_score"] is not None else None,
                    "opponent_score": str(row["away_score"]) if row["away_score"] is not None else None,
                    "home_hits": home_hits,
                    "home_errors": row["home_errors"],
                    "away_hits": away_hits,
                    "away_errors": row["away_errors"],
                    "win_pitcher": d.get("W"),
                    "loss_pitcher": d.get("L"),
                    "save_pitcher": d.get("S"),
                    "result_status": None,
                    "is_conference": row["is_conference_game"] or False,
                    "box_score_url": row["source_url"] or "",
                }

                # Determine which section this game belongs to
                if row["game_date"] == today:
                    data["today"].append(nwac_game)
                elif row["game_date"] > today:
                    data["upcoming"].append(nwac_game)
                else:
                    data["recent"].append(nwac_game)

    except Exception:
        # Don't break the live endpoint if DB merge fails
        pass

    # ── Merge future_schedules.json for today/upcoming ──
    # These are scraped schedule entries that haven't been played yet
    # (e.g. NWAC games that aren't in the games table until box scores exist).
    try:
        fs_path = _Path(__file__).parent.parent.parent / "data" / "future_schedules.json"
        if fs_path.exists():
            with open(fs_path) as _fs:
                fs_data = _json.load(_fs)

            # Build dedup keys from existing today/upcoming games
            existing_keys = set()
            for section in ("today", "upcoming"):
                for g in data.get(section, []):
                    t = (g.get("team", "")).lower()
                    o = (g.get("opponent", "")).lower()
                    if t and o:
                        existing_keys.add((t, o))
                        existing_keys.add((o, t))

            today_str = today.isoformat() if today else ""
            upcoming_str = (today + _timedelta(days=1)).isoformat() if today else ""

            for fg in fs_data.get("games", []):
                gd = fg.get("game_date", "")
                if gd not in (today_str, upcoming_str):
                    continue

                ht = (fg.get("home_team", "")).lower()
                at_ = (fg.get("away_team", "")).lower()
                if not ht or not at_:
                    continue
                if (ht, at_) in existing_keys or (at_, ht) in existing_keys:
                    continue

                htid = fg.get("home_team_id")
                atid = fg.get("away_team_id")

                # Look up team info
                with get_connection() as conn2:
                    cur2 = conn2.cursor()
                    team_info = {}
                    for tid in [htid, atid]:
                        if tid:
                            cur2.execute("""
                                SELECT t.short_name, t.logo_url, d.level
                                FROM teams t
                                LEFT JOIN conferences c ON t.conference_id = c.id
                                LEFT JOIN divisions d ON c.division_id = d.id
                                WHERE t.id = %s
                            """, (tid,))
                            r = cur2.fetchone()
                            if r:
                                team_info[tid] = dict(r)

                hi = team_info.get(htid, {})
                ai = team_info.get(atid, {})
                div = hi.get("level") or ai.get("level") or fg.get("division", "")

                fs_game = {
                    "id": f"fs_{htid}_{atid}",
                    "team": hi.get("short_name") or fg.get("home_team", "TBD"),
                    "team_division": div,
                    "team_logo": hi.get("logo_url", ""),
                    "opponent": ai.get("short_name") or fg.get("away_team", "TBD"),
                    "opponent_display": ai.get("short_name") or fg.get("away_team", "TBD"),
                    "opponent_logo": ai.get("logo_url", ""),
                    "date": gd,
                    "time": fg.get("time", ""),
                    "status": "scheduled",
                    "game_state_display": "Scheduled",
                    "location": "home",
                    "team_score": None,
                    "opponent_score": None,
                    "is_conference": fg.get("is_conference", False),
                }

                if gd == today_str:
                    data["today"].append(fs_game)
                else:
                    data["upcoming"].append(fs_game)

    except Exception:
        pass

    # Dedup again after DB games and future schedules are merged in
    for section in ("today", "recent", "upcoming"):
        data[section] = _dedup_live_games(data.get(section, []))

    return data


@router.get("/games/ticker")
def games_ticker(
    season: int = CURRENT_SEASON,
    limit: int = 12,
):
    """
    Get the most recent games for the homepage ticker.
    Returns a compact format optimized for the ticker display.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # Fetch more than needed so we have room after dedup
        cur.execute("""
            SELECT
                g.id, g.game_date,
                g.home_score, g.away_score,
                g.innings,
                g.home_team_id, g.away_team_id,
                COALESCE(ht.short_name, g.home_team_name) AS home_name,
                ht.logo_url AS home_logo,
                COALESCE(at2.short_name, g.away_team_name) AS away_name,
                at2.logo_url AS away_logo,
                g.is_conference_game
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at2 ON g.away_team_id = at2.id
            WHERE g.season = %s AND g.status = 'final'
            ORDER BY g.game_date DESC, g.id DESC
            LIMIT %s
        """, (season, limit * 3))

        rows = [dict(g) for g in cur.fetchall()]
        deduped = _dedup_games(rows, limit)

        # Strip internal team IDs before returning
        for g in deduped:
            g.pop("home_team_id", None)
            g.pop("away_team_id", None)

        return deduped


@router.get("/games/quality-starts")
@cached_endpoint(ttl_seconds=1800)
def quality_starts_leaderboard(
    season: int = CURRENT_SEASON,
    limit: int = 25,
):
    """
    Quality starts leaderboard - pitchers ranked by QS count.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute("""
            SELECT
                gp.player_id,
                COALESCE(p.first_name || ' ' || p.last_name, gp.player_name) AS player_name,
                t.short_name AS team_name,
                t.logo_url,
                d.level AS division_level,
                COUNT(*) FILTER (WHERE gp.is_quality_start = TRUE) AS quality_starts,
                COUNT(*) FILTER (WHERE gp.is_starter = TRUE) AS games_started,
                ROUND(AVG(gp.game_score)::numeric, 1) AS avg_game_score,
                MAX(gp.game_score) AS best_game_score,
                ROUND(AVG(gp.innings_pitched)::numeric, 1) AS avg_ip,
                ROUND(AVG(gp.earned_runs)::numeric, 2) AS avg_er
            FROM game_pitching gp
            JOIN games g ON gp.game_id = g.id
            LEFT JOIN players p ON gp.player_id = p.id
            LEFT JOIN teams t ON gp.team_id = t.id
            LEFT JOIN conferences c ON t.conference_id = c.id
            LEFT JOIN divisions d ON c.division_id = d.id
            WHERE g.season = %s
              AND gp.is_starter = TRUE
              AND gp.team_id IN (g.home_team_id, g.away_team_id)
            GROUP BY gp.player_id, p.first_name, p.last_name, gp.player_name,
                     t.short_name, t.logo_url, d.level
            HAVING COUNT(*) FILTER (WHERE gp.is_starter = TRUE) >= 3
            ORDER BY quality_starts DESC, avg_game_score DESC
            LIMIT %s
        """, (season, limit))

        return [dict(r) for r in cur.fetchall()]


@router.get("/games/game-scores")
@cached_endpoint(ttl_seconds=1800)
def game_score_leaderboard(
    season: int = CURRENT_SEASON,
    limit: int = 25,
):
    """
    Top individual game scores (Bill James Game Score) for the season.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute("""
            SELECT
                gp.game_id,
                gp.player_id,
                COALESCE(p.first_name || ' ' || p.last_name, gp.player_name) AS player_name,
                t.short_name AS team_name,
                t.logo_url,
                d.level AS division_level,
                g.game_date,
                gp.game_score,
                gp.innings_pitched,
                gp.hits_allowed,
                gp.earned_runs,
                gp.walks,
                gp.strikeouts,
                gp.is_quality_start,
                gp.decision,
                g.home_score, g.away_score,
                COALESCE(opp.short_name, g.away_team_name) AS opponent
            FROM game_pitching gp
            JOIN games g ON gp.game_id = g.id
            LEFT JOIN players p ON gp.player_id = p.id
            LEFT JOIN teams t ON gp.team_id = t.id
            LEFT JOIN conferences c ON t.conference_id = c.id
            LEFT JOIN divisions d ON c.division_id = d.id
            LEFT JOIN teams opp ON (
                CASE WHEN g.home_team_id = gp.team_id THEN g.away_team_id
                     ELSE g.home_team_id END
            ) = opp.id
            WHERE g.season = %s
              AND gp.game_score IS NOT NULL
              AND gp.is_starter = TRUE
              AND gp.team_id IN (g.home_team_id, g.away_team_id)
            ORDER BY gp.game_score DESC
            LIMIT %s
        """, (season, limit))

        return [dict(r) for r in cur.fetchall()]


@router.get("/games/{game_id}")
def game_detail(game_id: int):
    """
    Get full box score for a single game.
    Includes line score, batting lines, and pitching lines.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # Game info
        cur.execute("""
            SELECT
                g.*,
                ht.short_name AS home_short,
                ht.logo_url AS home_logo,
                ht.school_name AS home_school,
                at2.short_name AS away_short,
                at2.logo_url AS away_logo,
                at2.school_name AS away_school,
                hd.level AS home_division,
                ad.level AS away_division
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at2 ON g.away_team_id = at2.id
            LEFT JOIN conferences hc ON ht.conference_id = hc.id
            LEFT JOIN divisions hd ON hc.division_id = hd.id
            LEFT JOIN conferences ac ON at2.conference_id = ac.id
            LEFT JOIN divisions ad ON ac.division_id = ad.id
            WHERE g.id = %s
        """, (game_id,))

        game = cur.fetchone()
        if not game:
            raise HTTPException(status_code=404, detail="Game not found")

        # Batting lines
        cur.execute("""
            SELECT
                gb.*,
                p.first_name, p.last_name
            FROM game_batting gb
            LEFT JOIN players p ON gb.player_id = p.id
            WHERE gb.game_id = %s
            ORDER BY gb.team_id, gb.batting_order
        """, (game_id,))
        batting_lines = cur.fetchall()

        # Pitching lines
        cur.execute("""
            SELECT
                gp.*,
                p.first_name, p.last_name
            FROM game_pitching gp
            LEFT JOIN players p ON gp.player_id = p.id
            WHERE gp.game_id = %s
            ORDER BY gp.team_id, gp.pitch_order
        """, (game_id,))
        pitching_lines = cur.fetchall()

        # Group by team
        home_id = game["home_team_id"]
        away_id = game["away_team_id"]

        home_batting = [dict(b) for b in batting_lines if b["team_id"] == home_id]
        away_batting = [dict(b) for b in batting_lines if b["team_id"] == away_id]
        home_pitching = [dict(p) for p in pitching_lines if p["team_id"] == home_id]
        away_pitching = [dict(p) for p in pitching_lines if p["team_id"] == away_id]

        return {
            "game": dict(game),
            "home_batting": home_batting,
            "away_batting": away_batting,
            "home_pitching": home_pitching,
            "away_pitching": away_pitching,
        }


@router.get("/teams/{team_id}/games")
def team_games(
    team_id: int,
    season: int = CURRENT_SEASON,
):
    """Get all games for a specific team in a season."""
    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute("""
            SELECT
                g.id, g.season, g.game_date, g.game_time,
                g.home_team_id, g.away_team_id,
                g.home_team_name, g.away_team_name,
                g.home_score, g.away_score,
                g.innings, g.is_conference_game,
                g.home_hits, g.home_errors,
                g.away_hits, g.away_errors,
                g.game_score, g.status,
                ht.short_name AS home_short,
                ht.logo_url AS home_logo,
                at2.short_name AS away_short,
                at2.logo_url AS away_logo
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at2 ON g.away_team_id = at2.id
            WHERE g.season = %s
              AND (g.home_team_id = %s OR g.away_team_id = %s)
              AND g.status = 'final'
            ORDER BY g.game_date ASC, g.id ASC
        """, (season, team_id, team_id))

        games = cur.fetchall()
        return [dict(g) for g in games]


# ── Player Streaks (current + season-best hit and on-base streaks) ──

@router.get("/players/{player_id}/streaks")
def get_player_streaks(
    player_id: int,
    season: int = Query(CURRENT_SEASON),
):
    """
    Per-player hit and on-base streaks for a single season.

    Returns the active (current) streak as of the most-recent final game,
    plus the season's longest streak. MLB convention is used for the hit
    streak: a game where the batter went 0-for-0 (all walks/HBP, no
    official AB) preserves the streak — it does NOT break it. The on-base
    streak follows the simpler rule: any final game with at least 1 PA
    that ended without reaching base breaks the streak.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # Resolve canonical (transfer-aware) player id and gather every
        # linked id so we don't miss games stored under a prior school's
        # roster row.
        cur.execute(
            "SELECT canonical_id FROM player_links WHERE linked_id = %s",
            (player_id,),
        )
        link = cur.fetchone()
        if link:
            player_id = link["canonical_id"]
        cur.execute(
            "SELECT linked_id FROM player_links WHERE canonical_id = %s",
            (player_id,),
        )
        linked = cur.fetchall()
        all_ids = [player_id] + [r["linked_id"] for r in linked]
        ph = ",".join(["%s"] * len(all_ids))

        cur.execute(
            f"""
            SELECT g.game_date,
                   g.id AS game_id,
                   COALESCE(gb.at_bats, 0)         AS ab,
                   COALESCE(gb.hits, 0)            AS h,
                   COALESCE(gb.walks, 0)           AS bb,
                   COALESCE(gb.hit_by_pitch, 0)    AS hbp,
                   COALESCE(gb.sacrifice_flies, 0) AS sf
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            WHERE gb.player_id IN ({ph})
              AND g.season = %s
              AND g.status = 'final'
              AND gb.team_id IN (g.home_team_id, g.away_team_id)
            ORDER BY g.game_date ASC, g.id ASC
            """,
            (*all_ids, season),
        )
        rows = cur.fetchall()

        cur_hit = best_hit = 0
        cur_ob  = best_ob  = 0

        for r in rows:
            ab  = int(r["ab"]  or 0)
            h   = int(r["h"]   or 0)
            bb  = int(r["bb"]  or 0)
            hbp = int(r["hbp"] or 0)
            sf  = int(r["sf"]  or 0)
            pa  = ab + bb + hbp + sf  # close enough; ignores sac bunts

            # Hit streak — MLB rule: only games with an official AB affect
            # the streak. A 0-AB walks/HBP-only game leaves it intact.
            if ab >= 1:
                if h >= 1:
                    cur_hit += 1
                    if cur_hit > best_hit:
                        best_hit = cur_hit
                else:
                    cur_hit = 0

            # On-base streak — every game with at least 1 PA either extends
            # the streak (any time on base) or breaks it.
            if pa >= 1:
                on_base = h + bb + hbp
                if on_base >= 1:
                    cur_ob += 1
                    if cur_ob > best_ob:
                        best_ob = cur_ob
                else:
                    cur_ob = 0

        return {
            "season": season,
            "player_id": player_id,
            "current_hit_streak": cur_hit,
            "current_ob_streak":  cur_ob,
            "best_hit_streak":    best_hit,
            "best_ob_streak":     best_ob,
            "games_counted":      len(rows),
        }


# ── Player Game Logs ──────────────────────────────────────────────────

# ── Per-outing Grade (role-normalized, 0-100) ──────────────────────
# The stored game_score is Bill James v1, which rewards length (bonus
# points for innings after the 4th) and so compresses relief outings near
# ~50 — relievers can never post a "high" score. To compare starters and
# relievers fairly, we grade each outing on a 0-100 curve WITHIN ITS ROLE
# at the same level + season: the grade is the percentile of that outing's
# game_score among same-role (starter vs reliever) outings. 50 = a median
# outing for that role; ~90+ = elite for that role. Distributions are
# cached per (level, season) since they only shift as new games land.
_OUTING_DIST_CACHE: dict = {}    # (level, season) -> (built_at, {True:[...], False:[...]})
_OUTING_DIST_TTL = 1800          # 30 min


def _james_game_score(ip, h, er, bb, k, runs=None):
    """Bill James Game Score from a line. Computed here (not read from the
    stored column) so the grade works at every level, including NWAC where
    game_score is not precomputed. IP is baseball notation (6.2 = 6 2/3)."""
    if ip is None:
        return None
    ip = float(ip)
    if ip <= 0:
        return None
    outs = int(ip) * 3 + round((ip % 1) * 10)
    innings_completed = int(ip)
    unearned = max(0, (runs or 0) - (er or 0)) if runs is not None else 0
    return (50 + outs + max(0, innings_completed - 4) * 2 + (k or 0)
            - (h or 0) * 2 - (er or 0) * 4 - unearned * 2 - (bb or 0))


def _outing_score_distributions(cur, level, season):
    import time
    key = (level, season)
    hit = _OUTING_DIST_CACHE.get(key)
    if hit and (time.time() - hit[0]) < _OUTING_DIST_TTL:
        return hit[1]
    cur.execute("""
        SELECT gp.is_starter, gp.innings_pitched, gp.hits_allowed,
               gp.runs_allowed, gp.earned_runs, gp.walks, gp.strikeouts
        FROM game_pitching gp
        JOIN games g ON g.id = gp.game_id
        JOIN teams t ON t.id = gp.team_id
        JOIN conferences c ON c.id = t.conference_id
        JOIN divisions d ON d.id = c.division_id
        WHERE g.season = %s AND g.status = 'final' AND d.level = %s
          AND gp.innings_pitched IS NOT NULL AND gp.innings_pitched > 0
    """, (season, level))
    starters, relievers = [], []
    for r in cur.fetchall():
        sc = _james_game_score(r["innings_pitched"], r["hits_allowed"],
                               r["earned_runs"], r["walks"], r["strikeouts"],
                               r["runs_allowed"])
        if sc is None:
            continue
        (starters if r["is_starter"] else relievers).append(sc)
    starters.sort()
    relievers.sort()
    dist = {True: starters, False: relievers}
    _OUTING_DIST_CACHE[key] = (time.time(), dist)
    return dist


def _outing_grade(dist, row):
    """Percentile (1-100) of this outing among same-role outings at its level."""
    sc = _james_game_score(row["innings_pitched"], row["hits_allowed"],
                           row["earned_runs"], row["walks"], row["strikeouts"],
                           row["runs_allowed"])
    if sc is None:
        return None
    import bisect
    arr = dist.get(bool(row["is_starter"])) or []
    if len(arr) < 10:            # too few same-role outings to grade fairly
        return None
    rank = bisect.bisect_right(arr, sc)
    return round(100 * rank / len(arr))


@router.get("/players/{player_id}/gamelogs")
def get_player_gamelogs(
    player_id: int,
    season: int = Query(CURRENT_SEASON),
):
    """
    Return game-by-game batting and pitching lines for a player,
    including opponent, score, and date context.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # Resolve canonical player (follow transfer links)
        cur.execute(
            "SELECT canonical_id FROM player_links WHERE linked_id = %s",
            (player_id,),
        )
        canonical_link = cur.fetchone()
        if canonical_link:
            player_id = canonical_link["canonical_id"]

        # Gather all player IDs (canonical + linked)
        cur.execute(
            "SELECT linked_id FROM player_links WHERE canonical_id = %s",
            (player_id,),
        )
        linked_ids = cur.fetchall()
        all_player_ids = [player_id] + [r["linked_id"] for r in linked_ids]
        id_placeholders = ",".join(["%s"] * len(all_player_ids))

        # Get all team IDs this player has been on (for home/away detection)
        player_team_ids = set()
        for pid in all_player_ids:
            cur.execute("SELECT team_id FROM players WHERE id = %s", (pid,))
            row = cur.fetchone()
            if row and row["team_id"]:
                player_team_ids.add(row["team_id"])

        # Helper: resolve opponent info from a game row.
        # Uses the player's known team IDs to determine home/away,
        # falling back to gb.team_id, then to game name fields.
        def resolve_game_context(r):
            home_tid = r["home_team_id"]
            away_tid = r["away_team_id"]
            row_team_id = r["team_id"]

            # Determine if player's team is home or away.
            # Use multiple signals for robustness:
            #   1. row's team_id matches a game side directly
            #   2. player's known team IDs match a game side
            #   3. fallback: row_team_id vs home_team_id
            if row_team_id == home_tid:
                is_home = True
            elif row_team_id == away_tid:
                is_home = False
            elif row_team_id in player_team_ids and home_tid and row_team_id != home_tid:
                # row's team is the player's team but it's not the home team
                is_home = False
            elif home_tid in player_team_ids:
                is_home = True
            elif away_tid in player_team_ids:
                is_home = False
            else:
                # Last resort: if away_team_id is NULL (opponent not in DB),
                # and row_team_id doesn't match home, assume road
                is_home = (row_team_id == home_tid) if home_tid else True

            if is_home:
                team_score = r["home_score"]
                opp_score = r["away_score"]
                opp_short = r["away_team_short"] or r["away_team_name"] or "?"
                opp_logo = r["away_team_logo"]
                home_away = "vs"
            else:
                team_score = r["away_score"]
                opp_score = r["home_score"]
                opp_short = r["home_team_short"] or r["home_team_name"] or "?"
                opp_logo = r["home_team_logo"]
                home_away = "@"

            return {
                "team_score": team_score,
                "opp_score": opp_score,
                "opponent_short": opp_short,
                "opponent_logo": opp_logo,
                "home_away": home_away,
            }

        # ── Batting game logs ──
        cur.execute(f"""
            SELECT
                g.game_date, g.game_number, g.home_team_id, g.away_team_id,
                g.home_score, g.away_score, g.innings,
                g.home_team_name, g.away_team_name,
                g.is_conference_game,
                gb.team_id,
                gb.position,
                gb.at_bats, gb.runs, gb.hits,
                gb.doubles, gb.triples, gb.home_runs,
                gb.rbi, gb.walks, gb.strikeouts,
                gb.hit_by_pitch, gb.stolen_bases, gb.caught_stealing,
                gb.sacrifice_flies, gb.sacrifice_bunts,
                ht.short_name AS home_team_short, ht.logo_url AS home_team_logo,
                at2.short_name AS away_team_short, at2.logo_url AS away_team_logo
            FROM game_batting gb
            JOIN games g ON g.id = gb.game_id
            LEFT JOIN teams ht ON ht.id = g.home_team_id
            LEFT JOIN teams at2 ON at2.id = g.away_team_id
            WHERE gb.player_id IN ({id_placeholders})
              AND g.season = %s
              AND g.status = 'final'
            ORDER BY g.game_date ASC, g.id ASC
        """, (*all_player_ids, season))
        batting_rows = cur.fetchall()

        # Deduplicate: same real-world game may be scraped from both teams' sites.
        # Key on (date, game_number) to keep one row per actual game.
        batting_logs = []
        seen_batting = set()
        for r in batting_rows:
            dedup_key = (str(r["game_date"]), r["game_number"] or 1)
            if dedup_key in seen_batting:
                continue
            seen_batting.add(dedup_key)

            ctx = resolve_game_context(r)
            batting_logs.append({
                "game_date": str(r["game_date"]),
                "opponent_short": ctx["opponent_short"],
                "opponent_logo": ctx["opponent_logo"],
                "home_away": ctx["home_away"],
                "team_score": ctx["team_score"],
                "opp_score": ctx["opp_score"],
                "innings": r["innings"],
                "is_conference": r["is_conference_game"],
                "position": r["position"],
                "ab": r["at_bats"],
                "r": r["runs"],
                "h": r["hits"],
                "2b": r["doubles"],
                "3b": r["triples"],
                "hr": r["home_runs"],
                "rbi": r["rbi"],
                "bb": r["walks"],
                "k": r["strikeouts"],
                "hbp": r["hit_by_pitch"],
                "sb": r["stolen_bases"],
                "cs": r["caught_stealing"],
                "sf": r["sacrifice_flies"],
                "sh": r["sacrifice_bunts"],
            })

        # Role-normalized outing-grade distribution for this player's
        # level + season (cached). Used to grade each outing 0-100 on its
        # own role's curve so starters and relievers are comparable.
        cur.execute("""
            SELECT d.level FROM players p
            JOIN teams t ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE p.id = %s
        """, (player_id,))
        _lvl_row = cur.fetchone()
        player_level = _lvl_row["level"] if _lvl_row else None
        outing_dist = (
            _outing_score_distributions(cur, player_level, season)
            if player_level else {True: [], False: []}
        )

        # ── Pitching game logs ──
        cur.execute(f"""
            SELECT
                g.game_date, g.game_number, g.home_team_id, g.away_team_id,
                g.home_score, g.away_score, g.innings,
                g.home_team_name, g.away_team_name,
                g.is_conference_game,
                gp.team_id,
                gp.is_starter, gp.decision,
                gp.innings_pitched, gp.hits_allowed, gp.runs_allowed,
                gp.earned_runs, gp.walks, gp.strikeouts,
                gp.home_runs_allowed, gp.hit_batters,
                gp.wild_pitches, gp.batters_faced,
                gp.pitches_thrown, gp.strikes,
                gp.game_score, gp.is_quality_start,
                ht.short_name AS home_team_short, ht.logo_url AS home_team_logo,
                at2.short_name AS away_team_short, at2.logo_url AS away_team_logo
            FROM game_pitching gp
            JOIN games g ON g.id = gp.game_id
            LEFT JOIN teams ht ON ht.id = g.home_team_id
            LEFT JOIN teams at2 ON at2.id = g.away_team_id
            WHERE gp.player_id IN ({id_placeholders})
              AND g.season = %s
              AND g.status = 'final'
            ORDER BY g.game_date ASC, g.id ASC
        """, (*all_player_ids, season))
        pitching_rows = cur.fetchall()

        pitching_logs = []
        seen_pitching = set()
        for r in pitching_rows:
            dedup_key = (str(r["game_date"]), r["game_number"] or 1)
            if dedup_key in seen_pitching:
                continue
            seen_pitching.add(dedup_key)
            ctx = resolve_game_context(r)
            pitching_logs.append({
                "game_date": str(r["game_date"]),
                "opponent_short": ctx["opponent_short"],
                "opponent_logo": ctx["opponent_logo"],
                "home_away": ctx["home_away"],
                "team_score": ctx["team_score"],
                "opp_score": ctx["opp_score"],
                "innings": r["innings"],
                "is_conference": r["is_conference_game"],
                "is_starter": r["is_starter"],
                "decision": r["decision"],
                "ip": float(r["innings_pitched"]) if r["innings_pitched"] else None,
                "h": r["hits_allowed"],
                "r": r["runs_allowed"],
                "er": r["earned_runs"],
                "bb": r["walks"],
                "k": r["strikeouts"],
                "hr": r["home_runs_allowed"],
                "hbp": r["hit_batters"],
                "wp": r["wild_pitches"],
                "bf": r["batters_faced"],
                "pitches": r["pitches_thrown"],
                "strikes": r["strikes"],
                "game_score": r["game_score"],
                "outing_grade": _outing_grade(outing_dist, r),
                "is_quality_start": r["is_quality_start"],
            })

        return {
            "batting": batting_logs,
            "pitching": pitching_logs,
        }


@router.get("/players/{player_id}/recent-ks")
def get_player_recent_ks(
    player_id: int,
    season: int = Query(CURRENT_SEASON, description="Season year"),
    side: str = Query('batting', description="'batting' or 'pitching'"),
    limit: int = Query(20, ge=1, le=50),
    team_id: int | None = Query(None, description="Filter to strikeouts where the opponent is on this team"),
):
    """Strikeout events involving this player.

    For batters (side='batting'): the pitchers who struck them out.
    For pitchers (side='pitching'): the batters they struck out.

    When `team_id` is set (e.g. the user's portal team), only K's
    against players from that team are returned. That powers the
    Player Card PDF's "Strikeouts vs <my team>" panel.

    Without team_id, returns the most recent N strikeouts league-wide.

    Each entry: { game_date, opponent_name, opponent_team_short,
    result_type, inning, half, balls_before, strikes_before,
    pitch_sequence }.
    """
    if side not in ('batting', 'pitching'):
        raise HTTPException(status_code=400, detail="side must be 'batting' or 'pitching'")
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT canonical_id FROM player_links WHERE linked_id = %s", (player_id,))
        canon = cur.fetchone()
        if canon:
            player_id = canon["canonical_id"]
        cur.execute("SELECT linked_id FROM player_links WHERE canonical_id = %s", (player_id,))
        all_pids = [player_id] + [r["linked_id"] for r in cur.fetchall()]

        if side == 'batting':
            self_filter = "ge.batter_player_id = ANY(%s)"
            opp_id_col = "ge.pitcher_player_id"
            opp_team_col = "ge.defending_team_id"
        else:
            self_filter = "ge.pitcher_player_id = ANY(%s)"
            opp_id_col = "ge.batter_player_id"
            opp_team_col = "ge.batting_team_id"

        params = [all_pids, season]
        team_clause = ""
        if team_id is not None:
            team_clause = f" AND {opp_team_col} = %s"
            params.append(team_id)
        params.append(limit)

        cur.execute(f"""
            SELECT
              ge.result_type, ge.inning, ge.half,
              ge.balls_before, ge.strikes_before, ge.pitch_sequence,
              g.game_date,
              p.id AS opp_id, p.first_name, p.last_name,
              t.short_name AS opp_team_short
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            LEFT JOIN players p ON p.id = {opp_id_col}
            LEFT JOIN teams t ON t.id = {opp_team_col}
            WHERE {self_filter}
              AND g.season = %s
              AND ge.result_type IN ('strikeout_swinging', 'strikeout_looking')
              {team_clause}
            ORDER BY g.game_date DESC, ge.id DESC
            LIMIT %s
        """, params)

        rows = []
        for r in cur.fetchall():
            rows.append({
                "game_date": r["game_date"].isoformat() if r["game_date"] else None,
                "opponent_id": r["opp_id"],
                "opponent_name": (
                    f"{r['first_name'] or ''} {r['last_name'] or ''}".strip()
                    or "Unknown"
                ),
                "opponent_team_short": r["opp_team_short"],
                "result_type": r["result_type"],
                "inning": r["inning"],
                "half": r["half"],
                "balls_before": r["balls_before"],
                "strikes_before": r["strikes_before"],
                "pitch_sequence": r["pitch_sequence"],
            })
        return {"strikeouts": rows, "season": season, "side": side}


@router.get("/players/{player_id}/vs-team/{team_id}")
def get_player_vs_team(
    player_id: int,
    team_id: int,
    season: int = Query(CURRENT_SEASON, description="Season year"),
    side: str = Query('batting', description="'batting' or 'pitching'"),
):
    """How this player has performed against a specific opposing team.

    Used by the Player Card PDF when the user has a portal team set —
    e.g. a Bushnell coach views an OIT player's card and immediately
    sees how that player did vs Bushnell pitchers (or how that
    pitcher did vs Bushnell hitters).

    Returns:
      {
        "overall": { pa, ab, h, hr, bb, k, avg, obp, slg, ops, woba,
                     iso, k_pct, bb_pct },
        "matchups": [   # per-opponent-pitcher (or per-opponent-batter)
          { player_id, name, pa, ab, h, hr, bb, k, avg, woba, ... }
        ],
        "games": int,   # how many games this matchup happened in
      }
    """
    if side not in ('batting', 'pitching'):
        raise HTTPException(status_code=400, detail="side must be 'batting' or 'pitching'")
    with get_connection() as conn:
        cur = conn.cursor()
        # Resolve canonical/linked
        cur.execute("SELECT canonical_id FROM player_links WHERE linked_id = %s", (player_id,))
        canon = cur.fetchone()
        if canon:
            player_id = canon["canonical_id"]
        cur.execute("SELECT linked_id FROM player_links WHERE canonical_id = %s", (player_id,))
        all_pids = [player_id] + [r["linked_id"] for r in cur.fetchall()]

        # Pull every PA between this player and that team's roster
        if side == 'batting':
            self_filter = "ge.batter_player_id = ANY(%s)"
            opp_filter = "ge.defending_team_id = %s"
            opp_id_col = "ge.pitcher_player_id"
        else:
            self_filter = "ge.pitcher_player_id = ANY(%s)"
            opp_filter = "ge.batting_team_id = %s"
            opp_id_col = "ge.batter_player_id"

        cur.execute(f"""
            SELECT ge.result_type, {opp_id_col} AS opp_pid, ge.game_id
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE {self_filter}
              AND g.season = %s
              AND {opp_filter}
              AND ge.result_type IS NOT NULL
        """, (all_pids, season, team_id))
        events = list(cur.fetchall())

        if not events:
            return {"overall": None, "matchups": [], "games": 0,
                    "team_id": team_id, "season": season, "side": side}

        # Aggregate the slash line + advanced rate stats
        def _slash_from_events(rows):
            singles = sum(1 for r in rows if r["result_type"] == "single")
            doubles = sum(1 for r in rows if r["result_type"] == "double")
            triples = sum(1 for r in rows if r["result_type"] == "triple")
            hr = sum(1 for r in rows if r["result_type"] == "home_run")
            bb = sum(1 for r in rows if r["result_type"] in ("walk", "intentional_walk"))
            hbp = sum(1 for r in rows if r["result_type"] == "hbp")
            sf = sum(1 for r in rows if r["result_type"] == "sac_fly")
            k = sum(1 for r in rows if r["result_type"] in ("strikeout_swinging", "strikeout_looking"))
            ab_types = {"single", "double", "triple", "home_run",
                        "strikeout_swinging", "strikeout_looking",
                        "ground_out", "fly_out", "line_out", "pop_out",
                        "fielders_choice", "error", "double_play", "other"}
            ab = sum(1 for r in rows if r["result_type"] in ab_types)
            h = singles + doubles + triples + hr
            tb = singles + 2 * doubles + 3 * triples + 4 * hr
            pa = len(rows)
            avg = (h / ab) if ab else 0
            obp_denom = ab + bb + hbp + sf
            obp = ((h + bb + hbp) / obp_denom) if obp_denom else 0
            slg = (tb / ab) if ab else 0
            iso = slg - avg
            # D3/NAIA-ish wOBA weights (same as elsewhere in the codebase)
            woba_num = (0.69 * bb + 0.72 * hbp + 0.88 * singles +
                        1.24 * doubles + 1.56 * triples + 2.0 * hr)
            woba_denom = ab + bb + sf + hbp
            woba = (woba_num / woba_denom) if woba_denom else 0
            return {
                "pa": pa, "ab": ab, "h": h, "hr": hr, "bb": bb, "k": k,
                "avg": avg, "obp": obp, "slg": slg, "ops": obp + slg,
                "woba": woba, "iso": iso,
                "k_pct": (k / pa) if pa else 0,
                "bb_pct": (bb / pa) if pa else 0,
            }

        overall = _slash_from_events(events)
        overall["games"] = len(set(e["game_id"] for e in events))

        # Per-opponent-player breakdown
        by_opp = {}
        for e in events:
            opp_pid = e["opp_pid"]
            by_opp.setdefault(opp_pid, []).append(e)
        matchup_rows = []
        for opp_pid, rows in by_opp.items():
            if not opp_pid:
                continue
            cur.execute("SELECT id, first_name, last_name FROM players WHERE id = %s", (opp_pid,))
            p = cur.fetchone()
            if not p:
                continue
            stats = _slash_from_events(rows)
            matchup_rows.append({
                "player_id": p["id"],
                "name": f"{p['first_name']} {p['last_name']}".strip(),
                **stats,
            })
        # Sort by sample size desc — coach cares about real exposure first
        matchup_rows.sort(key=lambda r: r["pa"], reverse=True)

        return {
            "overall": overall,
            "matchups": matchup_rows,
            "games": overall["games"],
            "team_id": team_id,
            "season": season,
            "side": side,
        }


@router.get("/players/{player_id}/splits")
def get_player_splits(
    player_id: int,
    season: int = Query(None, description="Season year; omit for career splits"),
):
    """
    Return home / road batting and pitching splits for a player.
    Aggregates from game_batting / game_pitching + games tables.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # Resolve canonical player (follow transfer links)
        cur.execute(
            "SELECT canonical_id FROM player_links WHERE linked_id = %s",
            (player_id,),
        )
        canonical_link = cur.fetchone()
        if canonical_link:
            player_id = canonical_link["canonical_id"]

        # Gather all player IDs (canonical + linked)
        cur.execute(
            "SELECT linked_id FROM player_links WHERE canonical_id = %s",
            (player_id,),
        )
        linked_ids = cur.fetchall()
        all_player_ids = [player_id] + [r["linked_id"] for r in linked_ids]
        id_placeholders = ",".join(["%s"] * len(all_player_ids))

        # Get all team IDs this player has been on (for home/away detection)
        # Check players table AND batting/pitching stats for full history
        player_team_ids = set()
        for pid in all_player_ids:
            cur.execute("SELECT team_id FROM players WHERE id = %s", (pid,))
            row = cur.fetchone()
            if row and row["team_id"]:
                player_team_ids.add(row["team_id"])
        cur.execute(f"""
            SELECT DISTINCT team_id FROM batting_stats WHERE player_id IN ({id_placeholders})
            UNION
            SELECT DISTINCT team_id FROM pitching_stats WHERE player_id IN ({id_placeholders})
        """, (*all_player_ids, *all_player_ids))
        for row in cur.fetchall():
            if row["team_id"]:
                player_team_ids.add(row["team_id"])

        def resolve_home_away(home_tid, away_tid, row_team_id):
            """Determine if a game was home or away for this player.
            Returns True for home, False for away."""
            if home_tid in player_team_ids:
                return True
            if away_tid and away_tid in player_team_ids:
                return False
            # Neither matched by ID. If home_team_id is set but NOT the player's
            # team, the player must be the away team (common when away_team_id is NULL).
            if home_tid and home_tid not in player_team_ids:
                return False
            # Last resort: use gb/gp.team_id
            if row_team_id:
                return row_team_id == home_tid
            return True  # Unknown, default to home

        season_filter = ""
        season_params = []
        if season:
            season_filter = "AND g.season = %s"
            season_params = [season]

        # ── Batting splits ──
        cur.execute(f"""
            SELECT
                g.home_team_id, g.away_team_id,
                gb.team_id,
                gb.at_bats, gb.hits,
                gb.runs, gb.rbi, gb.walks, gb.strikeouts,
                g.game_date, g.game_number
            FROM game_batting gb
            JOIN games g ON g.id = gb.game_id
            WHERE gb.player_id IN ({id_placeholders})
              AND g.status = 'final'
              {season_filter}
            ORDER BY g.game_date
        """, (*all_player_ids, *season_params))
        batting_rows = cur.fetchall()

        def make_bat_split():
            return {
                "g": 0, "ab": 0, "h": 0,
                "r": 0, "rbi": 0, "bb": 0, "k": 0,
            }

        bat_home = make_bat_split()
        bat_away = make_bat_split()

        def dedup_score(home_tid, away_tid):
            """Score how confidently we can determine home/away.
            Higher = better. Prefer rows where BOTH teams are identified
            and the player's team is clearly one of them."""
            score = 0
            both_set = home_tid is not None and away_tid is not None
            if both_set:
                score += 10  # Strongly prefer rows with both teams identified
            if away_tid and away_tid in player_team_ids:
                score += 5  # Player is clearly away
            elif home_tid in player_team_ids and both_set:
                score += 5  # Player is clearly home (and we know the opponent)
            elif home_tid in player_team_ids:
                score += 2  # Player might be home, but away_team unknown
            elif home_tid and home_tid not in player_team_ids:
                score += 3  # Player is likely away (home is someone else)
            return score

        # Group rows by game, then pick the best row per game.
        bat_by_game = {}
        for r in batting_rows:
            dedup_key = (str(r["game_date"]), r["game_number"] or 1)
            score = dedup_score(r["home_team_id"], r["away_team_id"])
            if dedup_key not in bat_by_game or score > bat_by_game[dedup_key][1]:
                bat_by_game[dedup_key] = (r, score)

        for (r, _) in bat_by_game.values():
            is_home = resolve_home_away(r["home_team_id"], r["away_team_id"], r["team_id"])

            bucket = bat_home if is_home else bat_away
            bucket["g"] += 1
            bucket["ab"] += r["at_bats"] or 0
            bucket["h"] += r["hits"] or 0
            bucket["r"] += r["runs"] or 0
            bucket["rbi"] += r["rbi"] or 0
            bucket["bb"] += r["walks"] or 0
            bucket["k"] += r["strikeouts"] or 0

        def calc_bat_rates(s):
            ab = s["ab"]
            h = s["h"]
            bb = s["bb"]
            pa = ab + bb
            s["pa"] = pa
            s["avg"] = round(h / ab, 3) if ab > 0 else None
            s["obp"] = round((h + bb) / pa, 3) if pa > 0 else None
            return s

        calc_bat_rates(bat_home)
        calc_bat_rates(bat_away)

        # ── Pitching splits ──
        cur.execute(f"""
            SELECT
                g.home_team_id, g.away_team_id,
                gp.team_id,
                gp.innings_pitched, gp.hits_allowed, gp.earned_runs, gp.runs_allowed,
                gp.walks, gp.strikeouts, gp.home_runs_allowed,
                gp.hit_batters, gp.batters_faced,
                gp.is_starter, gp.decision,
                g.game_date, g.game_number
            FROM game_pitching gp
            JOIN games g ON g.id = gp.game_id
            WHERE gp.player_id IN ({id_placeholders})
              AND g.status = 'final'
              {season_filter}
            ORDER BY g.game_date
        """, (*all_player_ids, *season_params))
        pitching_rows = cur.fetchall()

        def make_pit_split():
            return {
                "g": 0, "gs": 0, "w": 0, "l": 0, "sv": 0,
                "ip": 0.0, "h": 0, "er": 0, "r": 0,
                "bb": 0, "k": 0, "hr": 0, "hbp": 0, "bf": 0,
            }

        pit_home = make_pit_split()
        pit_away = make_pit_split()

        # Group by game, pick best row (same dedup_score logic as batting)
        pit_by_game = {}
        for r in pitching_rows:
            dedup_key = (str(r["game_date"]), r["game_number"] or 1)
            score = dedup_score(r["home_team_id"], r["away_team_id"])
            if dedup_key not in pit_by_game or score > pit_by_game[dedup_key][1]:
                pit_by_game[dedup_key] = (r, score)

        for (r, _) in pit_by_game.values():
            is_home = resolve_home_away(r["home_team_id"], r["away_team_id"], r["team_id"])

            bucket = pit_home if is_home else pit_away
            bucket["g"] += 1
            if r["is_starter"]:
                bucket["gs"] += 1
            dec = (r["decision"] or "").upper()
            if dec == "W":
                bucket["w"] += 1
            elif dec == "L":
                bucket["l"] += 1
            elif dec == "SV" or dec == "S":
                bucket["sv"] += 1
            bucket["ip"] += float(r["innings_pitched"] or 0)
            bucket["h"] += r["hits_allowed"] or 0
            bucket["er"] += r["earned_runs"] or 0
            bucket["r"] += r["runs_allowed"] or 0
            bucket["bb"] += r["walks"] or 0
            bucket["k"] += r["strikeouts"] or 0
            bucket["hr"] += r["home_runs_allowed"] or 0
            bucket["hbp"] += r["hit_batters"] or 0
            bucket["bf"] += r["batters_faced"] or 0

        def calc_pit_rates(s):
            ip = s["ip"]
            # Convert fractional innings (e.g. 5.1 → 5.333)
            whole = int(ip)
            frac = ip - whole
            real_ip = whole + (frac * 10) / 3.0
            s["ip_display"] = round(ip, 1)
            s["era"] = round(s["er"] * 9 / real_ip, 2) if real_ip > 0 else None
            s["whip"] = round((s["bb"] + s["h"]) / real_ip, 2) if real_ip > 0 else None
            s["k_per_9"] = round(s["k"] * 9 / real_ip, 1) if real_ip > 0 else None
            s["bb_per_9"] = round(s["bb"] * 9 / real_ip, 1) if real_ip > 0 else None
            s["k_pct"] = round(s["k"] / s["bf"], 3) if s["bf"] > 0 else None
            s["bb_pct"] = round(s["bb"] / s["bf"], 3) if s["bf"] > 0 else None
            return s

        calc_pit_rates(pit_home)
        calc_pit_rates(pit_away)

        has_batting = bat_home["pa"] + bat_away["pa"] > 0
        has_pitching = pit_home["g"] + pit_away["g"] > 0

        return {
            "batting": {
                "home": bat_home,
                "away": bat_away,
            } if has_batting else None,
            "pitching": {
                "home": pit_home,
                "away": pit_away,
            } if has_pitching else None,
        }


# ── moved to pitch_level.py (June 2026 routes split) ──
# ── moved to grid.py (June 2026 routes split) ──
# ── moved to summer_leaderboards.py (June 2026 routes split) ──
# ── moved to feature_requests.py (June 2026 routes split) ──
# ── moved to recruiting.py (June 2026 routes split) ──
# ── moved to team_stats.py (June 2026 routes split) ──
# ── moved to all_conference.py (June 2026 routes split) ──
# ── moved to coaching_tools.py (June 2026 routes split) ──
