"""
Summer-league leaderboards and stat leaders.

Extracted from routes.py (June 2026 split). Shared helpers that still
live in routes.py are imported as `from .routes import ...` — routes.py
never imports this module, so there is no circular import.
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

router = APIRouter()

# ============================================================
# SUMMER LEADERBOARDS
# ============================================================

@router.get("/leaderboards/summer/batting")
@cached_endpoint(ttl_seconds=3600)
def summer_batting_leaderboard(
    season: int = Query(..., description="Season year"),
    league: Optional[str] = Query(None, description="Filter by league abbreviation (WCL, PIL)"),
    team_id: Optional[int] = Query(None, description="Filter by summer team"),
    min_pa: int = Query(0, description="Minimum plate appearances"),
    min_ab: int = Query(0, description="Minimum at-bats"),
    sort_by: str = Query("batting_avg", description="Sort column"),
    sort_dir: str = Query("desc", description="Sort direction (asc/desc)"),
    limit: int = Query(50, description="Results per page"),
    offset: int = Query(0, description="Pagination offset"),
):
    """Summer league batting leaderboard - WCL, PIL, or all."""
    allowed_sort = {
        "batting_avg", "on_base_pct", "slugging_pct", "ops",
        "home_runs", "rbi", "hits", "runs", "stolen_bases", "walks",
        "strikeouts", "doubles", "triples", "plate_appearances", "iso",
        "babip", "bb_pct", "k_pct", "at_bats", "games",
        "hit_by_pitch", "sacrifice_flies", "caught_stealing",
        "grounded_into_dp", "wrc_plus", "woba", "offensive_war",
    }
    if sort_by not in allowed_sort:
        sort_by = "batting_avg"
    sort_direction = "DESC" if sort_dir.lower() == "desc" else "ASC"

    with get_connection() as conn:
        cur = conn.cursor()
        query = """
            SELECT sbs.*,
                   sp.first_name, sp.last_name, sp.position, COALESCE(sp.assigned_school, sp.college) AS college,
                   sp.year_in_school,
                   st.name as team_name, st.short_name as team_short,
                   st.logo_url, st.city as team_city,
                   sl.name as league_name, sl.abbreviation as league_abbrev,
                   spl.spring_player_id
            FROM summer_batting_stats sbs
            JOIN summer_players sp ON sbs.player_id = sp.id
            JOIN summer_teams st ON sbs.team_id = st.id
            JOIN summer_leagues sl ON st.league_id = sl.id
            LEFT JOIN summer_player_links spl ON spl.summer_player_id = sp.id
            WHERE sbs.season = %s
              AND sbs.plate_appearances >= %s
              AND sbs.at_bats >= %s
              AND sp.first_name NOT ILIKE '%%total%%'
              AND sp.first_name NOT ILIKE '%%total%%'
              AND sp.last_name NOT ILIKE '%%total%%'
        """
        params: list = [season, min_pa, min_ab]

        if league:
            query += " AND sl.abbreviation = %s"
            params.append(league.upper())
        if team_id:
            query += " AND sbs.team_id = %s"
            params.append(team_id)

        # Count total
        count_q = """
            SELECT COUNT(*) as total
            FROM summer_batting_stats sbs
            JOIN summer_players sp ON sbs.player_id = sp.id
            JOIN summer_teams st ON sbs.team_id = st.id
            JOIN summer_leagues sl ON st.league_id = sl.id
            WHERE sbs.season = %s
              AND sbs.plate_appearances >= %s
              AND sbs.at_bats >= %s
              AND sp.first_name NOT ILIKE '%%total%%'
              AND sp.first_name NOT ILIKE '%%total%%'
              AND sp.last_name NOT ILIKE '%%total%%'
        """
        count_params: list = [season, min_pa, min_ab]
        if league:
            count_q += " AND sl.abbreviation = %s"
            count_params.append(league.upper())
        if team_id:
            count_q += " AND sbs.team_id = %s"
            count_params.append(team_id)

        cur.execute(count_q, count_params)
        total = cur.fetchone()["total"]

        query += f" ORDER BY sbs.{sort_by} {sort_direction} NULLS LAST"
        query += " LIMIT %s OFFSET %s"
        params.extend([limit, offset])

        cur.execute(query, params)
        rows = cur.fetchall()

        return {
            "data": [dict(r) for r in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
            "season": season,
            "filters": {
                "league": league,
                "team_id": team_id,
                "min_pa": min_pa,
                "min_ab": min_ab,
            },
        }


@router.get("/leaderboards/summer/pitching")
@cached_endpoint(ttl_seconds=3600)
def summer_pitching_leaderboard(
    season: int = Query(..., description="Season year"),
    league: Optional[str] = Query(None, description="Filter by league abbreviation (WCL, PIL)"),
    team_id: Optional[int] = Query(None, description="Filter by summer team"),
    min_ip: float = Query(0, description="Minimum innings pitched"),
    sort_by: str = Query("era", description="Sort column"),
    sort_dir: str = Query("asc", description="Sort direction"),
    limit: int = Query(50, description="Results per page"),
    offset: int = Query(0, description="Pagination offset"),
):
    """Summer league pitching leaderboard - WCL, PIL, or all."""
    allowed_sort = {
        "era", "whip", "wins", "losses", "saves", "strikeouts",
        "innings_pitched", "k_per_9", "bb_per_9", "hr_per_9",
        "k_bb_ratio", "k_pct", "bb_pct", "games", "games_started",
        "complete_games", "hits_allowed", "earned_runs", "walks",
        "fip", "pitching_war",
    }
    if sort_by not in allowed_sort:
        sort_by = "era"
    ascending_stats = {"era", "whip", "fip", "bb_per_9", "bb_pct", "hr_per_9", "losses"}
    default_dir = "ASC" if sort_by in ascending_stats else "DESC"
    sort_direction = sort_dir.upper() if sort_dir.upper() in ("ASC", "DESC") else default_dir

    with get_connection() as conn:
        cur = conn.cursor()
        query = """
            SELECT sps.*,
                   sp.first_name, sp.last_name, sp.position, COALESCE(sp.assigned_school, sp.college) AS college,
                   sp.year_in_school,
                   st.name as team_name, st.short_name as team_short,
                   st.logo_url, st.city as team_city,
                   sl.name as league_name, sl.abbreviation as league_abbrev,
                   spl.spring_player_id
            FROM summer_pitching_stats sps
            JOIN summer_players sp ON sps.player_id = sp.id
            JOIN summer_teams st ON sps.team_id = st.id
            JOIN summer_leagues sl ON st.league_id = sl.id
            LEFT JOIN summer_player_links spl ON spl.summer_player_id = sp.id
            WHERE sps.season = %s
              AND sps.innings_pitched >= %s
              AND sp.first_name NOT ILIKE '%%total%%'
              AND sp.last_name NOT ILIKE '%%total%%'
        """
        params: list = [season, min_ip]

        if league:
            query += " AND sl.abbreviation = %s"
            params.append(league.upper())
        if team_id:
            query += " AND sps.team_id = %s"
            params.append(team_id)

        # Count total
        count_q = """
            SELECT COUNT(*) as total
            FROM summer_pitching_stats sps
            JOIN summer_players sp ON sps.player_id = sp.id
            JOIN summer_teams st ON sps.team_id = st.id
            JOIN summer_leagues sl ON st.league_id = sl.id
            WHERE sps.season = %s
              AND sps.innings_pitched >= %s
              AND sp.first_name NOT ILIKE '%%total%%'
              AND sp.last_name NOT ILIKE '%%total%%'
        """
        count_params: list = [season, min_ip]
        if league:
            count_q += " AND sl.abbreviation = %s"
            count_params.append(league.upper())
        if team_id:
            count_q += " AND sps.team_id = %s"
            count_params.append(team_id)

        cur.execute(count_q, count_params)
        total = cur.fetchone()["total"]

        query += f" ORDER BY sps.{sort_by} {sort_direction} NULLS LAST"
        query += " LIMIT %s OFFSET %s"
        params.extend([limit, offset])

        cur.execute(query, params)
        rows = cur.fetchall()

        return {
            "data": [dict(r) for r in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
            "season": season,
            "filters": {
                "league": league,
                "team_id": team_id,
                "min_ip": min_ip,
            },
        }


@router.get("/summer/stat-leaders")
def summer_stat_leaders(
    season: int = Query(..., description="Season year"),
    league: str = Query("WCL", description="League abbreviation"),
    limit: int = Query(3, description="Leaders per category"),
):
    """Compact summer league stat leaders for homepage widget."""
    with get_connection() as conn:
        cur = conn.cursor()

        batting_cats = [
            {"key": "batting_avg", "label": "AVG", "col": "sbs.batting_avg", "order": "DESC", "format": "avg", "min_pa": 50},
            {"key": "home_runs", "label": "HR", "col": "sbs.home_runs", "order": "DESC", "format": "int", "min_pa": 30},
            {"key": "stolen_bases", "label": "SB", "col": "sbs.stolen_bases", "order": "DESC", "format": "int", "min_pa": 30},
            {"key": "iso", "label": "ISO", "col": "sbs.iso", "order": "DESC", "format": "avg", "min_pa": 50},
        ]
        pitching_cats = [
            {"key": "era", "label": "ERA", "col": "sps.era", "order": "ASC", "format": "float2", "min_ip": 20},
            {"key": "strikeouts", "label": "K", "col": "sps.strikeouts", "order": "DESC", "format": "int", "min_ip": 10},
            {"key": "fip", "label": "FIP", "col": "sps.fip", "order": "ASC", "format": "float2", "min_ip": 20},
            {"key": "k_pct", "label": "K%", "col": "sps.k_pct", "order": "DESC", "format": "pct", "min_ip": 20},
        ]

        results = {"batting": [], "pitching": [], "season": season, "league": league}

        for cat in batting_cats:
            cur.execute(f"""
                SELECT sp.id as player_id, sp.first_name, sp.last_name,
                       st.short_name as team_short, st.logo_url,
                       {cat['col']} as value,
                       spl.spring_player_id
                FROM summer_batting_stats sbs
                JOIN summer_players sp ON sbs.player_id = sp.id
                JOIN summer_teams st ON sbs.team_id = st.id
                JOIN summer_leagues sl ON st.league_id = sl.id
                LEFT JOIN summer_player_links spl ON spl.summer_player_id = sp.id
                WHERE sbs.season = %s
                  AND sl.abbreviation = %s
                  AND sbs.plate_appearances >= %s
                  AND {cat['col']} IS NOT NULL
                  AND sp.first_name NOT ILIKE '%%total%%'
                ORDER BY {cat['col']} {cat['order']}
                LIMIT %s
            """, (season, league.upper(), cat['min_pa'], limit))
            rows = cur.fetchall()
            results["batting"].append({
                "key": cat["key"],
                "label": cat["label"],
                "format": cat["format"],
                "leaders": [dict(r) for r in rows],
            })

        for cat in pitching_cats:
            cur.execute(f"""
                SELECT sp.id as player_id, sp.first_name, sp.last_name,
                       st.short_name as team_short, st.logo_url,
                       {cat['col']} as value,
                       spl.spring_player_id
                FROM summer_pitching_stats sps
                JOIN summer_players sp ON sps.player_id = sp.id
                JOIN summer_teams st ON sps.team_id = st.id
                JOIN summer_leagues sl ON st.league_id = sl.id
                LEFT JOIN summer_player_links spl ON spl.summer_player_id = sp.id
                WHERE sps.season = %s
                  AND sl.abbreviation = %s
                  AND sps.innings_pitched >= %s
                  AND {cat['col']} IS NOT NULL
                  AND sp.first_name NOT ILIKE '%%total%%'
                ORDER BY {cat['col']} {cat['order']}
                LIMIT %s
            """, (season, league.upper(), cat['min_ip'], limit))
            rows = cur.fetchall()
            results["pitching"].append({
                "key": cat["key"],
                "label": cat["label"],
                "format": cat["format"],
                "leaders": [dict(r) for r in rows],
            })

        return results


@router.get("/summer/leagues")
def summer_leagues_list():
    """List all summer leagues."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM summer_leagues WHERE is_active = TRUE ORDER BY name")
        return [dict(r) for r in cur.fetchall()]


@router.get("/summer/teams")
def summer_teams_list(
    league: Optional[str] = Query(None, description="Filter by league abbreviation"),
):
    """List summer teams, optionally filtered by league."""
    with get_connection() as conn:
        cur = conn.cursor()
        query = """
            SELECT st.*, sl.abbreviation as league_abbrev, sl.name as league_name
            FROM summer_teams st
            JOIN summer_leagues sl ON st.league_id = sl.id
            WHERE st.is_active = TRUE
        """
        params = []
        if league:
            query += " AND sl.abbreviation = %s"
            params.append(league.upper())
        query += " ORDER BY sl.name, st.name"
        cur.execute(query, params)
        return [dict(r) for r in cur.fetchall()]


@router.get("/summer/seasons")
def summer_available_seasons():
    """Return available seasons for summer stats."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT DISTINCT sbs.season, sl.abbreviation as league
            FROM summer_batting_stats sbs
            JOIN summer_teams st ON sbs.team_id = st.id
            JOIN summer_leagues sl ON st.league_id = sl.id
            UNION
            SELECT DISTINCT sps.season, sl.abbreviation as league
            FROM summer_pitching_stats sps
            JOIN summer_teams st ON sps.team_id = st.id
            JOIN summer_leagues sl ON st.league_id = sl.id
            ORDER BY season DESC, league
        """)
        return [dict(r) for r in cur.fetchall()]


# ════════════════════════════════════════════════════════════════
