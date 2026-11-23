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
from .auth import require_admin
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
    PLAYOFF_FORMATS,
    CONFERENCE_TO_FORMAT,
)

router = APIRouter()

# ============================================================
# SUMMER LEADERBOARDS
# ============================================================







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




# ════════════════════════════════════════════════════════════════
