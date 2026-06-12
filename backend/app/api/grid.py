"""
Image proxy + PNW Grid (immaculate-grid game).

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
# ============================================================
# IMAGE PROXY - for canvas export (avoids CORS issues)
# ============================================================
import httpx as _httpx
import ipaddress as _ipaddress
import socket as _socket
from urllib.parse import urlparse as _img_urlparse
from fastapi.responses import Response as _ImgResponse

_PROXY_MAX_BYTES = 10 * 1024 * 1024  # 10 MB cap — logos/headshots are far smaller
_PROXY_MAX_REDIRECTS = 3


def _proxy_target_blocked(target_url: str) -> bool:
    """SSRF guard: only plain http(s) to PUBLIC addresses.

    The endpoint used to fetch ANY caller-supplied URL, which let an attacker
    relay requests to internal services (localhost:8000, cloud metadata at
    169.254.169.254, the droplet's private network). Resolve the hostname and
    reject every non-global address. Redirects are followed manually so each
    hop gets re-checked.
    """
    try:
        parsed = _img_urlparse(target_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return True
        infos = _socket.getaddrinfo(parsed.hostname, None)
        for info in infos:
            ip = _ipaddress.ip_address(info[4][0])
            if (ip.is_private or ip.is_loopback or ip.is_link_local
                    or ip.is_multicast or ip.is_reserved or ip.is_unspecified):
                return True
        return False
    except Exception:
        return True  # unresolvable / malformed → refuse


@router.get("/proxy-image")
async def proxy_image(url: str = Query(...)):
    """Proxy an external image to avoid CORS issues in canvas exports."""
    try:
        async with _httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            current = url
            resp = None
            for _ in range(_PROXY_MAX_REDIRECTS + 1):
                if _proxy_target_blocked(current):
                    raise HTTPException(400, "Invalid URL")
                resp = await client.get(current)
                if resp.status_code in (301, 302, 303, 307, 308) and resp.headers.get("location"):
                    current = str(resp.next_request.url) if resp.next_request else resp.headers["location"]
                    continue
                break
        if resp is None or resp.status_code != 200:
            raise HTTPException(resp.status_code if resp is not None else 502, "Upstream error")
        if len(resp.content) > _PROXY_MAX_BYTES:
            raise HTTPException(400, "Image too large")
        ct = resp.headers.get("content-type", "image/png")
        if not ct.startswith("image/"):
            raise HTTPException(400, "Not an image")
        return _ImgResponse(content=resp.content, media_type=ct,
                            headers={"Cache-Control": "public, max-age=86400"})
    except _httpx.RequestError:
        raise HTTPException(502, "Failed to fetch image")


# PNW GRID - Immaculate Grid for PNW College Baseball
# ============================================================

import json as _grid_json
import random as _grid_random
from pathlib import Path as _GridPath
from fastapi import Body

_GRID_CONFIG_PATH = _GridPath(__file__).resolve().parent.parent.parent / "data" / "pnw_grid.json"

# --------------- Grid Category Pools ---------------

_TEAM_POOL = [
    # Conference / division categories
    {"type": "conference", "label": "NWAC North (NWAC)", "value": "NWAC-N", "group": "nwac"},
    {"type": "conference", "label": "NWAC South (NWAC)", "value": "NWAC-S", "group": "nwac"},
    {"type": "conference", "label": "NWAC East (NWAC)", "value": "NWAC-E", "group": "nwac"},
    {"type": "conference", "label": "NWAC West (NWAC)", "value": "NWAC-W", "group": "nwac"},
    {"type": "conference", "label": "CCC (NAIA)", "value": "CCC", "group": "4yr"},
    {"type": "conference", "label": "GNAC (D2)", "value": "GNAC", "group": "4yr"},
    {"type": "conference", "label": "NWC (D3)", "value": "NWC", "group": "4yr"},
    {"type": "division", "label": "PNW D1", "value": "D1", "group": "d1"},
    {"type": "division", "label": "NWAC", "value": "JUCO", "group": "nwac"},
    {"type": "division", "label": "Non-D1 4-Year", "value": "non_d1_4yr", "group": "4yr"},
    # Individual teams - D1
    {"type": "team", "label": "Gonzaga (D1)", "value": "Gonzaga", "group": "team"},
    {"type": "team", "label": "Oregon (D1)", "value": "Oregon", "group": "team"},
    {"type": "team", "label": "Oregon St. (D1)", "value": "Oregon St.", "group": "team"},
    {"type": "team", "label": "UW (D1)", "value": "UW", "group": "team"},
    {"type": "team", "label": "Wash. St. (D1)", "value": "Wash. St.", "group": "team"},
    {"type": "team", "label": "Portland (D1)", "value": "Portland", "group": "team"},
    {"type": "team", "label": "Seattle U (D1)", "value": "Seattle U", "group": "team"},
    # Individual teams - D2
    {"type": "team", "label": "CWU (D2)", "value": "CWU", "group": "team"},
    {"type": "team", "label": "WOU (D2)", "value": "WOU", "group": "team"},
    {"type": "team", "label": "NNU (D2)", "value": "NNU", "group": "team"},
    {"type": "team", "label": "MSUB (D2)", "value": "MSUB", "group": "team"},
    {"type": "team", "label": "SMU (D2)", "value": "SMU", "group": "team"},
    # Individual teams - D3
    {"type": "team", "label": "Linfield (D3)", "value": "Linfield", "group": "team"},
    {"type": "team", "label": "GFU (D3)", "value": "GFU", "group": "team"},
    {"type": "team", "label": "PLU (D3)", "value": "PLU", "group": "team"},
    {"type": "team", "label": "UPS (D3)", "value": "UPS", "group": "team"},
    {"type": "team", "label": "L&C (D3)", "value": "L&C", "group": "team"},
    {"type": "team", "label": "Whitworth (D3)", "value": "Whitworth", "group": "team"},
    {"type": "team", "label": "Whitman (D3)", "value": "Whitman", "group": "team"},
    {"type": "team", "label": "Willamette (D3)", "value": "Willamette", "group": "team"},
    {"type": "team", "label": "Pacific (D3)", "value": "Pacific", "group": "team"},
    # Individual teams - NAIA
    {"type": "team", "label": "Bushnell (NAIA)", "value": "Bushnell", "group": "team"},
    {"type": "team", "label": "Corban (NAIA)", "value": "Corban", "group": "team"},
    {"type": "team", "label": "C of I (NAIA)", "value": "C of I", "group": "team"},
    {"type": "team", "label": "EOU (NAIA)", "value": "EOU", "group": "team"},
    {"type": "team", "label": "LCSC (NAIA)", "value": "LCSC", "group": "team"},
    {"type": "team", "label": "OIT (NAIA)", "value": "OIT", "group": "team"},
    {"type": "team", "label": "Warner Pacific (NAIA)", "value": "Warner Pacific", "group": "team"},
    {"type": "team", "label": "UBC (NAIA)", "value": "UBC", "group": "team"},
    # Individual teams - NWAC
    {"type": "team", "label": "Lower Columbia (NWAC)", "value": "Lower Columbia", "group": "team"},
    {"type": "team", "label": "Edmonds (NWAC)", "value": "Edmonds", "group": "team"},
    {"type": "team", "label": "Everett (NWAC)", "value": "Everett", "group": "team"},
    {"type": "team", "label": "Bellevue (NWAC)", "value": "Bellevue", "group": "team"},
    {"type": "team", "label": "Spokane (NWAC)", "value": "Spokane", "group": "team"},
    {"type": "team", "label": "Walla Walla (NWAC)", "value": "Walla Walla", "group": "team"},
    {"type": "team", "label": "Mt. Hood (NWAC)", "value": "Mt. Hood", "group": "team"},
    {"type": "team", "label": "Centralia (NWAC)", "value": "Centralia", "group": "team"},
    {"type": "team", "label": "Columbia Basin (NWAC)", "value": "Columbia Basin", "group": "team"},
    {"type": "team", "label": "Yakima Valley (NWAC)", "value": "Yakima Valley", "group": "team"},
    {"type": "team", "label": "Clackamas (NWAC)", "value": "Clackamas", "group": "team"},
    {"type": "team", "label": "Linn-Benton (NWAC)", "value": "Linn-Benton", "group": "team"},
    {"type": "team", "label": "Lane (NWAC)", "value": "Lane", "group": "team"},
    {"type": "team", "label": "Pierce (NWAC)", "value": "Pierce", "group": "team"},
    {"type": "team", "label": "Chemeketa (NWAC)", "value": "Chemeketa", "group": "team"},
    {"type": "team", "label": "Clark (NWAC)", "value": "Clark", "group": "team"},
    {"type": "team", "label": "Big Bend (NWAC)", "value": "Big Bend", "group": "team"},
    {"type": "team", "label": "Wenatchee Valley (NWAC)", "value": "Wenatchee Valley", "group": "team"},
    {"type": "team", "label": "Skagit (NWAC)", "value": "Skagit", "group": "team"},
    {"type": "team", "label": "Tacoma (NWAC)", "value": "Tacoma", "group": "team"},
    {"type": "team", "label": "Shoreline (NWAC)", "value": "Shoreline", "group": "team"},
    {"type": "team", "label": "Olympic (NWAC)", "value": "Olympic", "group": "team"},
    {"type": "team", "label": "Treasure Valley (NWAC)", "value": "Treasure Valley", "group": "team"},
    {"type": "team", "label": "Grays Harbor (NWAC)", "value": "Grays Harbor", "group": "team"},
    {"type": "team", "label": "Douglas (NWAC)", "value": "Douglas", "group": "team"},
    {"type": "team", "label": "SW Oregon (NWAC)", "value": "SW Oregon", "group": "team"},
    {"type": "team", "label": "Umpqua (NWAC)", "value": "Umpqua", "group": "team"},
    {"type": "team", "label": "Blue Mountain (NWAC)", "value": "Blue Mountain", "group": "team"},
]

_NWAC_CATS = [c for c in _TEAM_POOL if c["group"] == "nwac"]
_4YR_CATS = [c for c in _TEAM_POOL if c["group"] in ("4yr", "d1")]

_SEASON_BATTING_POOL = [
    {"type": "season_batting", "label": "40+ Games", "category": "Season Batting", "stat": "games", "operator": ">=", "threshold": 40},
    {"type": "season_batting", "label": "40+ Hits", "category": "Season Batting", "stat": "hits", "operator": ">=", "threshold": 40},
    {"type": "season_batting", "label": "10+ Doubles", "category": "Season Batting", "stat": "doubles", "operator": ">=", "threshold": 10},
    {"type": "season_batting", "label": "5+ HR", "category": "Season Batting", "stat": "home_runs", "operator": ">=", "threshold": 5},
    {"type": "season_batting", "label": "10+ HR", "category": "Season Batting", "stat": "home_runs", "operator": ">=", "threshold": 10},
    {"type": "season_batting", "label": "30+ RBI", "category": "Season Batting", "stat": "rbi", "operator": ">=", "threshold": 30},
    {"type": "season_batting", "label": "10+ SB", "category": "Season Batting", "stat": "stolen_bases", "operator": ">=", "threshold": 10},
    {"type": "season_batting", "label": ".350+ AVG", "category": "Season Batting", "stat": "batting_avg", "operator": ">=", "threshold": 0.350, "qualified": True, "q_stat": "plate_appearances", "q_min": 50},
    {"type": "season_batting", "label": "1.000+ OPS", "category": "Season Batting", "stat": "ops", "operator": ">=", "threshold": 1.000, "qualified": True, "q_stat": "plate_appearances", "q_min": 50},
    {"type": "season_batting", "label": "150+ wRC+", "category": "Season Batting", "stat": "wrc_plus", "operator": ">=", "threshold": 150, "qualified": True, "q_stat": "plate_appearances", "q_min": 50},
    {"type": "season_batting", "label": "1.5+ WAR", "category": "Season Batting", "stat": "offensive_war", "operator": ">=", "threshold": 1.5},
]

_CAREER_BATTING_POOL = [
    {"type": "career_batting", "label": "100+ Career G", "category": "Career Batting", "stat": "games", "operator": ">=", "threshold": 100},
    {"type": "career_batting", "label": "100+ Career H", "category": "Career Batting", "stat": "hits", "operator": ">=", "threshold": 100},
    {"type": "career_batting", "label": "25+ Career 2B", "category": "Career Batting", "stat": "doubles", "operator": ">=", "threshold": 25},
    {"type": "career_batting", "label": "8+ Career HR", "category": "Career Batting", "stat": "home_runs", "operator": ">=", "threshold": 8},
    {"type": "career_batting", "label": "15+ Career HR", "category": "Career Batting", "stat": "home_runs", "operator": ">=", "threshold": 15},
    {"type": "career_batting", "label": "50+ Career RBI", "category": "Career Batting", "stat": "rbi", "operator": ">=", "threshold": 50},
    {"type": "career_batting", "label": "25+ Career SB", "category": "Career Batting", "stat": "stolen_bases", "operator": ">=", "threshold": 25},
    {"type": "career_batting", "label": "3+ Career WAR", "category": "Career Batting", "stat": "offensive_war", "operator": ">=", "threshold": 3},
]

_SEASON_PITCHING_POOL = [
    {"type": "season_pitching", "label": "4+ Wins", "category": "Season Pitching", "stat": "wins", "operator": ">=", "threshold": 4},
    {"type": "season_pitching", "label": "4+ Losses", "category": "Season Pitching", "stat": "losses", "operator": ">=", "threshold": 4},
    {"type": "season_pitching", "label": "2+ Saves", "category": "Season Pitching", "stat": "saves", "operator": ">=", "threshold": 2},
    {"type": "season_pitching", "label": "40+ IP", "category": "Season Pitching", "stat": "innings_pitched", "operator": ">=", "threshold": 40},
    {"type": "season_pitching", "label": "Sub-3.00 ERA", "category": "Season Pitching", "stat": "era", "operator": "<", "threshold": 3.00, "qualified": True, "q_stat": "innings_pitched", "q_min": 20},
    {"type": "season_pitching", "label": "50+ K", "category": "Season Pitching", "stat": "strikeouts", "operator": ">=", "threshold": 50},
    {"type": "season_pitching", "label": "0.75+ WAR", "category": "Season Pitching", "stat": "pitching_war", "operator": ">=", "threshold": 0.75},
]

_CAREER_PITCHING_POOL = [
    {"type": "career_pitching", "label": "8+ Career W", "category": "Career Pitching", "stat": "wins", "operator": ">=", "threshold": 8},
    {"type": "career_pitching", "label": "8+ Career L", "category": "Career Pitching", "stat": "losses", "operator": ">=", "threshold": 8},
    {"type": "career_pitching", "label": "5+ Career SV", "category": "Career Pitching", "stat": "saves", "operator": ">=", "threshold": 5},
    {"type": "career_pitching", "label": "75+ Career IP", "category": "Career Pitching", "stat": "innings_pitched", "operator": ">=", "threshold": 75},
    {"type": "career_pitching", "label": "Sub-4.00 Career ERA", "category": "Career Pitching", "stat": "era", "operator": "<", "threshold": 4.00,
     "career_rate": True, "numerator": "earned_runs", "denominator": "innings_pitched", "multiplier": 9,
     "qualified": True, "q_stat": "innings_pitched", "q_min": 75},
    {"type": "career_pitching", "label": "75+ Career K", "category": "Career Pitching", "stat": "strikeouts", "operator": ">=", "threshold": 75},
    {"type": "career_pitching", "label": "40+ Career BB", "category": "Career Pitching", "stat": "walks", "operator": ">=", "threshold": 40},
    {"type": "career_pitching", "label": "1.5+ Career WAR", "category": "Career Pitching", "stat": "pitching_war", "operator": ">=", "threshold": 1.5},
]


# --------------- Grid Validation ---------------

def _count_players_for_cell(cur, team_criteria, stat_criteria):
    """
    Count distinct players matching both a team criteria and stat criteria.
    Returns the count (capped at 4 for efficiency - we only need to know if >= 3).
    """
    tc_type = team_criteria["type"]
    tc_value = team_criteria.get("value", "")

    sc_type = stat_criteria["type"]
    sc_stat = stat_criteria["stat"]
    sc_op = {">=": ">=", ">": ">", "<=": "<=", "<": "<", "=": "="}.get(
        stat_criteria.get("operator", ">="), ">="
    )
    sc_threshold = stat_criteria["threshold"]
    sc_qualified = stat_criteria.get("qualified", False)
    sc_q_stat = stat_criteria.get("q_stat", "")
    sc_q_min = stat_criteria.get("q_min", 0)

    # Build team join/filter
    if tc_type == "division" and tc_value == "ALL":
        team_join = ""
        team_where = ""
        team_params = []
    elif tc_type == "team":
        team_join = "JOIN teams t ON p.team_id = t.id"
        team_where = "AND t.short_name = %s"
        team_params = [tc_value]
    elif tc_type == "conference":
        team_join = "JOIN teams t ON p.team_id = t.id JOIN conferences c ON t.conference_id = c.id"
        team_where = "AND (c.abbreviation ILIKE %s OR c.name ILIKE %s)"
        team_params = [tc_value, f"%{tc_value}%"]
    elif tc_type == "division":
        if tc_value == "non_d1_4yr":
            team_join = "JOIN teams t ON p.team_id = t.id JOIN conferences c ON t.conference_id = c.id JOIN divisions d ON c.division_id = d.id"
            team_where = "AND d.level IN ('D2', 'D3', 'NAIA')"
            team_params = []
        else:
            team_join = "JOIN teams t ON p.team_id = t.id JOIN conferences c ON t.conference_id = c.id JOIN divisions d ON c.division_id = d.id"
            team_where = "AND d.level = %s"
            team_params = [tc_value]
    else:
        return 0

    # Build stat filter
    q_clause = ""
    q_params = []
    if sc_qualified and sc_q_stat and sc_q_min:
        tbl = "bs" if "batting" in sc_type else "ps"
        q_clause = f" AND {tbl}.{sc_q_stat} >= %s"
        q_params = [sc_q_min]

    if sc_type in ("season_batting", "career_batting"):
        stat_table = "batting_stats"
        stat_alias = "bs"
    else:
        stat_table = "pitching_stats"
        stat_alias = "ps"

    # For career counting stats, we need SUM; for season stats or rate stats, direct comparison
    is_career = sc_type.startswith("career_")
    career_rate = stat_criteria.get("career_rate", False)

    if is_career and career_rate:
        # Career rate stat (e.g., career ERA)
        num_col = stat_criteria["numerator"]
        den_col = stat_criteria["denominator"]
        mult = stat_criteria.get("multiplier", 1)
        sql = f"""
            SELECT COUNT(*) FROM (
                SELECT {stat_alias}.player_id
                FROM {stat_table} {stat_alias}
                JOIN players p ON {stat_alias}.player_id = p.id
                {team_join}
                WHERE 1=1 {team_where}
                GROUP BY {stat_alias}.player_id
                HAVING SUM({stat_alias}.{den_col}) >= %s
                   AND SUM({stat_alias}.{num_col}) * {mult} / NULLIF(SUM({stat_alias}.{den_col}), 0) {sc_op} %s
                LIMIT 4
            ) sub
        """
        params = team_params + [sc_q_min, sc_threshold]
    elif is_career:
        rate_stats_b = {"batting_avg", "on_base_pct", "slugging_pct", "ops",
                        "iso", "babip", "bb_pct", "k_pct", "woba", "wrc_plus"}
        rate_stats_p = {"era", "whip", "k_per_9", "bb_per_9", "h_per_9",
                        "hr_per_9", "k_bb_ratio", "fip", "babip_against"}
        rate_stats = rate_stats_b if "batting" in sc_type else rate_stats_p
        if sc_stat in rate_stats:
            # Career rate stat - check any single qualified season
            sql = f"""
                SELECT COUNT(DISTINCT {stat_alias}.player_id) FROM {stat_table} {stat_alias}
                JOIN players p ON {stat_alias}.player_id = p.id
                {team_join}
                WHERE {stat_alias}.{sc_stat} {sc_op} %s {team_where}{q_clause}
            """
            params = [sc_threshold] + team_params + q_params
        else:
            # Career counting stat - SUM across seasons
            sql = f"""
                SELECT COUNT(*) FROM (
                    SELECT {stat_alias}.player_id
                    FROM {stat_table} {stat_alias}
                    JOIN players p ON {stat_alias}.player_id = p.id
                    {team_join}
                    WHERE 1=1 {team_where}
                    GROUP BY {stat_alias}.player_id
                    HAVING SUM({stat_alias}.{sc_stat}) {sc_op} %s
                    LIMIT 4
                ) sub
            """
            params = team_params + [sc_threshold]
    else:
        # Season stat - direct comparison
        sql = f"""
            SELECT COUNT(DISTINCT {stat_alias}.player_id) FROM {stat_table} {stat_alias}
            JOIN players p ON {stat_alias}.player_id = p.id
            {team_join}
            WHERE {stat_alias}.{sc_stat} {sc_op} %s {team_where}{q_clause}
        """
        params = [sc_threshold] + team_params + q_params

    try:
        cur.execute(sql, tuple(params))
        row = cur.fetchone()
        if not row:
            return 0
        # RealDictCursor returns dicts - get the first value
        return list(row.values())[0] or 0
    except Exception:
        return 0


def _validate_grid(columns, rows):
    """
    Check that every cell in the grid has at least 3 matching players.
    For team-vs-team cells (transfer grids), skip validation.
    Returns True if all stat cells have 3+ answers, False otherwise.
    """
    # Identify which items are team criteria vs stat criteria
    stat_types = {"season_batting", "career_batting", "season_pitching", "career_pitching"}

    stat_items_in_cols = [c for c in columns if c.get("type") in stat_types]
    stat_items_in_rows = [r for r in rows if r.get("type") in stat_types]
    team_items_in_cols = [c for c in columns if c.get("type") not in stat_types]
    team_items_in_rows = [r for r in rows if r.get("type") not in stat_types]

    # We need to check team x stat intersections
    cells_to_check = []
    for tc in team_items_in_cols:
        for sr in stat_items_in_rows:
            cells_to_check.append((tc, sr))
    for tr in team_items_in_rows:
        for sc in stat_items_in_cols:
            cells_to_check.append((tr, sc))

    if not cells_to_check:
        return True

    try:
        with get_connection() as conn:
            cur = conn.cursor()
            for team_crit, stat_crit in cells_to_check:
                count = _count_players_for_cell(cur, team_crit, stat_crit)
                if count < 3:
                    return False
        return True
    except Exception:
        # If DB unavailable, skip validation
        return True


# --------------- Random Grid Generator ---------------

def _pick_diverse_teams(rng, count):
    """Pick `count` diverse team/conference/division categories."""
    pool = list(_TEAM_POOL)
    rng.shuffle(pool)

    picked = []
    used_groups = {}

    for cat in pool:
        if len(picked) >= count:
            break
        group = cat.get("group", "")
        value = cat["value"]

        # Max 1 individual team per grid, max 2 from other groups
        if group == "team" and used_groups.get("team", 0) >= 1:
            continue
        if group != "team" and used_groups.get(group, 0) >= 2:
            continue
        # Don't pick NWAC (overall) + specific NWAC conference
        nwac_confs = {"NWAC-N", "NWAC-S", "NWAC-E", "NWAC-W"}
        if group == "nwac" and value == "JUCO" and any(p["value"] in nwac_confs for p in picked):
            continue
        if group == "nwac" and value in nwac_confs and any(p["value"] == "JUCO" for p in picked):
            continue

        picked.append(dict(cat))  # copy
        used_groups[group] = used_groups.get(group, 0) + 1

    return picked


def _pick_diverse_stats(rng, pool, count):
    """Pick `count` stat categories with no duplicate stat columns."""
    shuffled = list(pool)
    rng.shuffle(shuffled)
    picked = []
    used_stats = set()
    for cat in shuffled:
        if len(picked) >= count:
            break
        # Avoid two categories using the same stat column (e.g. 5+ HR and 10+ HR)
        if cat["stat"] in used_stats:
            continue
        picked.append(dict(cat))
        used_stats.add(cat["stat"])
    return picked


def _pick_mixed_stats(rng, count):
    """Pick `count` stat categories mixing batting and pitching, no duplicate stat columns."""
    batting_pool = _SEASON_BATTING_POOL + _CAREER_BATTING_POOL
    pitching_pool = _SEASON_PITCHING_POOL + _CAREER_PITCHING_POOL

    # Guarantee at least 1 batting and 1 pitching
    # For count=2: always 1 batting + 1 pitching
    # For count=3: either 2 batting + 1 pitching (70%) or 1 batting + 2 pitching (30%)
    if count <= 2:
        batting_count = 1
    else:
        batting_count = rng.choices([2, 1], weights=[70, 30])[0]
    pitching_count = count - batting_count

    rng.shuffle(batting_pool)
    rng.shuffle(pitching_pool)

    picked = []
    used_stats = set()

    # Pick batting stats
    for cat in batting_pool:
        if len(picked) >= batting_count:
            break
        if cat["stat"] in used_stats:
            continue
        picked.append(dict(cat))
        used_stats.add(cat["stat"])

    # Pick pitching stats
    for cat in pitching_pool:
        if len(picked) >= count:
            break
        if cat["stat"] in used_stats:
            continue
        picked.append(dict(cat))
        used_stats.add(cat["stat"])

    rng.shuffle(picked)
    return picked


def _generate_random_grid(seed=None):
    """Generate a random PNW Grid configuration.
    Validates that every team×stat cell has 3+ matching players.
    Retries up to 20 times if validation fails.
    Optional seed for deterministic generation (e.g. daily grids)."""
    rng = _grid_random.Random(seed)

    for _attempt in range(20):
        # Pick layout:
        #   80% standard = 3 team cols + 3 stat rows
        #   10% flipped  = 3 stat cols + 3 team rows
        #   10% transfer = 3 team cols + 2 stat rows + 1 cross-group team row
        layout = rng.choices(["standard", "flipped", "transfer"], weights=[80, 10, 10])[0]

        teams = _pick_diverse_teams(rng, 3)
        stats = _pick_mixed_stats(rng, 3)

        if layout == "standard":
            columns = teams
            rows = stats
        elif layout == "flipped":
            columns = stats
            rows = teams
        else:
            # Transfer grid: columns are teams, rows are 2 stats + 1 cross-group team
            col_groups = {t.get("group") for t in teams}
            if "nwac" in col_groups:
                cross_pool = list(_4YR_CATS)
            else:
                cross_pool = list(_NWAC_CATS)
            rng.shuffle(cross_pool)
            cross_team = dict(cross_pool[0])
            stats_2 = _pick_mixed_stats(rng, 2)
            rows = stats_2 + [cross_team]
            rng.shuffle(rows)
            columns = teams

        # Validate: every team×stat cell must have 3+ matching players
        if _validate_grid(columns, rows):
            return {
                "title": "Random Grid",
                "mode": "random",
                "columns": columns,
                "rows": rows,
            }

    # Fallback after 20 failed attempts - return last generated grid anyway
    return {
        "title": "Random Grid",
        "mode": "random",
        "columns": columns,
        "rows": rows,
    }


import datetime as _grid_datetime

def _get_daily_grid():
    """Get today's daily grid. Uses date as seed for deterministic generation.
    Caches in the config JSON file so it's only generated once per day."""
    today = _grid_datetime.date.today().isoformat()  # e.g. "2026-03-31"

    # Check if we have a cached grid for today
    try:
        with open(_GRID_CONFIG_PATH) as f:
            cached = _grid_json.load(f)
            if cached and cached.get("date") == today:
                return cached
    except (FileNotFoundError, ValueError):
        pass

    # Generate a new grid seeded by today's date
    seed = f"pnw-grid-{today}"
    grid = _generate_random_grid(seed=seed)
    grid["title"] = _grid_datetime.date.today().strftime("%B %d, %Y")
    grid["mode"] = "daily"
    grid["date"] = today

    # Cache it
    try:
        _GRID_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(_GRID_CONFIG_PATH, "w") as f:
            _grid_json.dump(grid, f)
    except Exception:
        pass  # Still return the grid even if caching fails

    return grid


@router.get("/grid/config")
def grid_config():
    """Return today's daily PNW Grid puzzle configuration."""
    return _get_daily_grid()


@router.get("/grid/random")
def grid_random():
    """Generate a random PNW Grid configuration."""
    return _generate_random_grid()


@router.get("/grid/search")
def grid_player_search(q: str = Query(..., min_length=2), limit: int = Query(10)):
    """
    Search players for the PNW Grid. Returns players with basic info
    including all teams they've played for.
    """
    with get_connection() as conn:
        cur = conn.cursor()
        search = f"%{q.strip()}%"

        cur.execute("""
            SELECT DISTINCT p.id, p.first_name, p.last_name, p.position,
                   p.year_in_school, p.headshot_url,
                   t.short_name as team_short, t.logo_url,
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

        results = []
        for r in cur.fetchall():
            results.append(dict(r))

        return results


def _get_all_player_ids(cur, player_id):
    """
    Resolve a player_id to all related IDs (canonical + linked).
    Handles transfers where old and new records are linked.
    Returns a list of all player IDs for this person.
    """
    # Check if this player is a linked (old) record pointing to a canonical
    cur.execute(
        "SELECT canonical_id FROM player_links WHERE linked_id = %s",
        (player_id,),
    )
    row = cur.fetchone()
    if row:
        canonical_id = row["canonical_id"]
    else:
        canonical_id = player_id

    # Get all linked IDs for this canonical player
    cur.execute(
        "SELECT linked_id FROM player_links WHERE canonical_id = %s",
        (canonical_id,),
    )
    linked_ids = [r["linked_id"] for r in cur.fetchall()]
    return [canonical_id] + linked_ids


def _check_team_criteria(cur, player_id, criteria):
    """
    Check if a player has ever been on a team matching the criteria.
    Criteria type can be: 'team', 'conference', 'division'.
    Includes all linked player records (transfers).
    Returns True/False.
    """
    ctype = criteria["type"]
    value = criteria.get("value", "")

    if ctype == "division" and value == "ALL":
        # Any PNW school - always true if the player exists
        return True

    all_ids = _get_all_player_ids(cur, player_id)
    id_ph = ",".join(["%s"] * len(all_ids))

    if ctype == "team":
        cur.execute(f"""
            SELECT 1 FROM player_seasons ps
            JOIN teams t ON ps.team_id = t.id
            WHERE ps.player_id IN ({id_ph}) AND t.short_name = %s
            UNION
            SELECT 1 FROM players p
            JOIN teams t ON p.team_id = t.id
            WHERE p.id IN ({id_ph}) AND t.short_name = %s
            LIMIT 1
        """, (*all_ids, value, *all_ids, value))
        return cur.fetchone() is not None

    if ctype == "conference":
        cur.execute(f"""
            SELECT 1 FROM player_seasons ps
            JOIN teams t ON ps.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            WHERE ps.player_id IN ({id_ph})
              AND (c.abbreviation ILIKE %s OR c.name ILIKE %s)
            UNION
            SELECT 1 FROM players p
            JOIN teams t ON p.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            WHERE p.id IN ({id_ph})
              AND (c.abbreviation ILIKE %s OR c.name ILIKE %s)
            LIMIT 1
        """, (*all_ids, value, f"%{value}%",
              *all_ids, value, f"%{value}%"))
        return cur.fetchone() is not None

    if ctype == "division":
        # Handle "non_d1_4yr" = D2 + D3 + NAIA
        if value == "non_d1_4yr":
            cur.execute(f"""
                SELECT 1 FROM player_seasons ps
                JOIN teams t ON ps.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                WHERE ps.player_id IN ({id_ph}) AND d.level IN ('D2', 'D3', 'NAIA')
                UNION
                SELECT 1 FROM players p
                JOIN teams t ON p.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                WHERE p.id IN ({id_ph}) AND d.level IN ('D2', 'D3', 'NAIA')
                LIMIT 1
            """, (*all_ids, *all_ids))
            return cur.fetchone() is not None

        cur.execute(f"""
            SELECT 1 FROM player_seasons ps
            JOIN teams t ON ps.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE ps.player_id IN ({id_ph}) AND d.level = %s
            UNION
            SELECT 1 FROM players p
            JOIN teams t ON p.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE p.id IN ({id_ph}) AND d.level = %s
            LIMIT 1
        """, (*all_ids, value, *all_ids, value))
        return cur.fetchone() is not None

    return False


def _check_stat_criteria(cur, player_id, criteria):
    """
    Check if a player meets a stat criteria.
    Types: season_batting, season_pitching, career_batting, career_pitching.
    Includes all linked player records (transfers).
    Supports qualification minimums for rate stats.
    """
    ctype = criteria["type"]
    stat = criteria["stat"]
    op = criteria.get("operator", ">=")
    threshold = criteria["threshold"]
    qualified = criteria.get("qualified", False)
    q_stat = criteria.get("q_stat", "")
    q_min = criteria.get("q_min", 0)

    # Map operators
    sql_op = {">=": ">=", ">": ">", "<=": "<=", "<": "<", "=": "="}
    op_str = sql_op.get(op, ">=")

    all_ids = _get_all_player_ids(cur, player_id)
    id_ph = ",".join(["%s"] * len(all_ids))

    # Build qualification clause for season-level queries
    q_clause = ""
    q_params = []
    if qualified and q_stat and q_min:
        q_clause = f" AND bs.{q_stat} >= %s" if "batting" in ctype else f" AND ps.{q_stat} >= %s"
        q_params = [q_min]

    if ctype == "season_batting":
        cur.execute(f"""
            SELECT 1 FROM batting_stats bs
            WHERE bs.player_id IN ({id_ph}) AND bs.{stat} {op_str} %s{q_clause}
            LIMIT 1
        """, (*all_ids, threshold, *q_params))
        return cur.fetchone() is not None

    if ctype == "career_batting":
        rate_stats = {"batting_avg", "on_base_pct", "slugging_pct", "ops",
                      "iso", "babip", "bb_pct", "k_pct", "woba", "wrc_plus"}
        if stat in rate_stats:
            # For career rate stats, check any single qualified season
            cur.execute(f"""
                SELECT 1 FROM batting_stats bs
                WHERE bs.player_id IN ({id_ph}) AND bs.{stat} {op_str} %s{q_clause}
                LIMIT 1
            """, (*all_ids, threshold, *q_params))
        else:
            cur.execute(f"""
                SELECT 1 FROM (
                    SELECT SUM(bs.{stat}) as career_total
                    FROM batting_stats bs
                    WHERE bs.player_id IN ({id_ph})
                ) sub
                WHERE sub.career_total {op_str} %s
            """, (*all_ids, threshold))
        return cur.fetchone() is not None

    if ctype == "season_pitching":
        cur.execute(f"""
            SELECT 1 FROM pitching_stats ps
            WHERE ps.player_id IN ({id_ph}) AND ps.{stat} {op_str} %s{q_clause}
            LIMIT 1
        """, (*all_ids, threshold, *q_params))
        return cur.fetchone() is not None

    if ctype == "career_pitching":
        # Special handling for career rate stats computed from raw components
        if criteria.get("career_rate"):
            num_col = criteria["numerator"]
            den_col = criteria["denominator"]
            mult = criteria.get("multiplier", 1)
            cur.execute(f"""
                SELECT 1 FROM (
                    SELECT SUM(ps.{num_col}) * {mult} / NULLIF(SUM(ps.{den_col}), 0) as career_rate,
                           SUM(ps.{den_col}) as total_den
                    FROM pitching_stats ps
                    WHERE ps.player_id IN ({id_ph})
                ) sub
                WHERE sub.total_den >= %s AND sub.career_rate {op_str} %s
            """, (*all_ids, q_min, threshold))
            return cur.fetchone() is not None

        rate_stats = {"era", "whip", "k_per_9", "bb_per_9", "h_per_9",
                      "hr_per_9", "k_bb_ratio", "fip", "babip_against",
                      "era_minus", "fip_plus"}
        if stat in rate_stats:
            cur.execute(f"""
                SELECT 1 FROM pitching_stats ps
                WHERE ps.player_id IN ({id_ph}) AND ps.{stat} {op_str} %s{q_clause}
                LIMIT 1
            """, (*all_ids, threshold, *q_params))
        else:
            cur.execute(f"""
                SELECT 1 FROM (
                    SELECT SUM(ps.{stat}) as career_total
                    FROM pitching_stats ps
                    WHERE ps.player_id IN ({id_ph})
                ) sub
                WHERE sub.career_total {op_str} %s
            """, (*all_ids, threshold))
        return cur.fetchone() is not None

    return False


def _get_player_teams(cur, player_id):
    """Get all teams a player has been on (across linked records), with logos."""
    all_ids = _get_all_player_ids(cur, player_id)
    id_ph = ",".join(["%s"] * len(all_ids))
    cur.execute(f"""
        SELECT DISTINCT t.short_name, t.logo_url
        FROM players p
        JOIN teams t ON p.team_id = t.id
        WHERE p.id IN ({id_ph})
        ORDER BY t.short_name
    """, tuple(all_ids))
    return [{"short_name": r["short_name"], "logo_url": r["logo_url"]} for r in cur.fetchall()]


def _get_stat_years(cur, player_id, criteria):
    """
    Get the years a player met a stat criteria.
    Returns a list of seasons (years) or a career span string.
    """
    all_ids = _get_all_player_ids(cur, player_id)
    id_ph = ",".join(["%s"] * len(all_ids))
    ctype = criteria["type"]
    stat = criteria["stat"]
    op = criteria.get("operator", ">=")
    threshold = criteria["threshold"]
    sql_op = {">=": ">=", ">": ">", "<=": "<=", "<": "<", "=": "="}.get(op, ">=")

    rate_stats_batting = {"batting_avg", "on_base_pct", "slugging_pct", "ops",
                          "iso", "babip", "bb_pct", "k_pct", "woba", "wrc_plus"}
    rate_stats_pitching = {"era", "whip", "k_per_9", "bb_per_9", "h_per_9",
                           "hr_per_9", "k_bb_ratio", "fip", "babip_against",
                           "era_minus", "fip_plus"}

    if ctype == "season_batting":
        cur.execute(f"""
            SELECT DISTINCT bs.season FROM batting_stats bs
            WHERE bs.player_id IN ({id_ph}) AND bs.{stat} {sql_op} %s
            ORDER BY bs.season
        """, (*all_ids, threshold))
        return {"type": "seasons", "years": [r["season"] for r in cur.fetchall()]}

    if ctype == "season_pitching":
        cur.execute(f"""
            SELECT DISTINCT ps.season FROM pitching_stats ps
            WHERE ps.player_id IN ({id_ph}) AND ps.{stat} {sql_op} %s
            ORDER BY ps.season
        """, (*all_ids, threshold))
        return {"type": "seasons", "years": [r["season"] for r in cur.fetchall()]}

    if ctype == "career_batting":
        # Get all seasons this player has batting stats
        cur.execute(f"""
            SELECT DISTINCT bs.season FROM batting_stats bs
            WHERE bs.player_id IN ({id_ph})
            ORDER BY bs.season
        """, tuple(all_ids))
        seasons = [r["season"] for r in cur.fetchall()]
        if seasons:
            return {"type": "career", "years": seasons, "span": f"{min(seasons)}-{max(seasons)}"}
        return {"type": "career", "years": [], "span": ""}

    if ctype == "career_pitching":
        cur.execute(f"""
            SELECT DISTINCT ps.season FROM pitching_stats ps
            WHERE ps.player_id IN ({id_ph})
            ORDER BY ps.season
        """, tuple(all_ids))
        seasons = [r["season"] for r in cur.fetchall()]
        if seasons:
            return {"type": "career", "years": seasons, "span": f"{min(seasons)}-{max(seasons)}"}
        return {"type": "career", "years": [], "span": ""}

    return {"type": "unknown", "years": []}


def _check_any_criteria(cur, player_id, criteria):
    """Check any criteria type - team/conference/division or stat."""
    ctype = criteria.get("type", "")
    if ctype in ("team", "conference", "division"):
        return _check_team_criteria(cur, player_id, criteria)
    return _check_stat_criteria(cur, player_id, criteria)


def _do_grid_check(cur, player_id, row_criteria, col_criteria):
    """Core grid check logic shared by weekly and custom endpoints."""
    # Get player info
    cur.execute("""
        SELECT p.id, p.first_name, p.last_name, p.position,
               p.year_in_school, p.headshot_url,
               t.short_name as team_short, t.logo_url
        FROM players p
        JOIN teams t ON p.team_id = t.id
        WHERE p.id = %s
    """, (player_id,))
    player = cur.fetchone()
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")

    col_match = _check_any_criteria(cur, player_id, col_criteria)
    row_match = _check_any_criteria(cur, player_id, row_criteria)
    correct = col_match and row_match

    all_teams = []
    stat_years = None
    if correct:
        all_teams = _get_player_teams(cur, player_id)
        # Get stat years from whichever criteria is a stat type
        for crit in (row_criteria, col_criteria):
            if crit.get("type", "") not in ("team", "conference", "division"):
                stat_years = _get_stat_years(cur, player_id, crit)
                break

    return {
        "correct": correct,
        "player": dict(player),
        "col_match": col_match,
        "row_match": row_match,
        "all_teams": all_teams,
        "stat_years": stat_years,
    }


@router.get("/grid/check/{player_id}/{row}/{col}")
def grid_check_guess(player_id: int, row: int, col: int):
    """
    Check if a player fits a specific grid cell (row, col) for the weekly grid.
    Row = 0-2, Col = 0-2.
    """
    config = _get_daily_grid()
    if not config:
        raise HTTPException(status_code=404, detail="No grid configured")

    if row < 0 or row > 2 or col < 0 or col > 2:
        raise HTTPException(status_code=400, detail="Row and col must be 0-2")

    row_criteria = config["rows"][row]
    col_criteria = config["columns"][col]

    with get_connection() as conn:
        cur = conn.cursor()
        return _do_grid_check(cur, player_id, row_criteria, col_criteria)


@router.post("/grid/check-custom")
def grid_check_custom(data: dict = Body(...)):
    """
    Check if a player fits custom grid criteria (for random mode).
    Body: {player_id, row_criteria: {...}, col_criteria: {...}}
    """
    player_id = data.get("player_id")
    row_criteria = data.get("row_criteria")
    col_criteria = data.get("col_criteria")
    if not player_id or not row_criteria or not col_criteria:
        raise HTTPException(status_code=400, detail="Missing player_id, row_criteria, or col_criteria")

    with get_connection() as conn:
        cur = conn.cursor()
        return _do_grid_check(cur, player_id, row_criteria, col_criteria)


@router.post("/grid/solutions")
def grid_solutions(data: dict = Body(...)):
    """
    Return all valid players for each cell of a grid.
    Body: {rows: [...], columns: [...]}
    Returns: {cells: {"0-0": [...], "0-1": [...], ...}}
    Each player list is ordered by most recent season (desc), capped at 50 per cell.
    """
    rows = data.get("rows")
    columns = data.get("columns")
    if not rows or not columns:
        raise HTTPException(status_code=400, detail="Missing rows or columns")

    stat_types = {"season_batting", "career_batting", "season_pitching", "career_pitching"}

    with get_connection() as conn:
        cur = conn.cursor()
        cells = {}
        for ri, row_crit in enumerate(rows):
            for ci, col_crit in enumerate(columns):
                # Figure out which is team and which is stat
                if row_crit.get("type") in stat_types and col_crit.get("type") not in stat_types:
                    team_crit, stat_crit = col_crit, row_crit
                elif col_crit.get("type") in stat_types and row_crit.get("type") not in stat_types:
                    team_crit, stat_crit = row_crit, col_crit
                else:
                    # Both are teams (transfer cell) or both stats - skip
                    cells[f"{ri}-{ci}"] = []
                    continue

                players = _find_players_for_cell(cur, team_crit, stat_crit)
                cells[f"{ri}-{ci}"] = players

        return {"cells": cells}


@router.get("/grid/options")
def grid_options():
    """Return all available criteria for the custom grid builder."""
    teams = []
    conferences = []
    divisions = []
    for item in _TEAM_POOL:
        entry = {"label": item["label"], "value": item.get("value", ""), "type": item["type"], "group": item.get("group", "")}
        if item.get("logo_url"):
            entry["logo_url"] = item["logo_url"]
        if item["type"] == "team":
            teams.append(entry)
        elif item["type"] == "conference":
            conferences.append(entry)
        elif item["type"] == "division":
            divisions.append(entry)

    stats = {
        "season_batting": [{"label": s["label"], "category": s.get("category", ""), **{k: v for k, v in s.items() if k != "label" and k != "category"}} for s in _SEASON_BATTING_POOL],
        "career_batting": [{"label": s["label"], "category": s.get("category", ""), **{k: v for k, v in s.items() if k != "label" and k != "category"}} for s in _CAREER_BATTING_POOL],
        "season_pitching": [{"label": s["label"], "category": s.get("category", ""), **{k: v for k, v in s.items() if k != "label" and k != "category"}} for s in _SEASON_PITCHING_POOL],
        "career_pitching": [{"label": s["label"], "category": s.get("category", ""), **{k: v for k, v in s.items() if k != "label" and k != "category"}} for s in _CAREER_PITCHING_POOL],
    }

    return {
        "teams": sorted(teams, key=lambda t: t["label"]),
        "conferences": conferences,
        "divisions": divisions,
        "stats": stats,
    }


@router.post("/grid/validate-custom")
def grid_validate_custom(data: dict = Body(...)):
    """
    Validate a custom grid - check that every cell has at least 1 matching player.
    Body: {rows: [...], columns: [...]}
    Returns: {valid: bool, cell_counts: {"0-0": n, ...}, invalid_cells: [...]}
    """
    rows = data.get("rows")
    columns = data.get("columns")
    if not rows or not columns or len(rows) != 3 or len(columns) != 3:
        raise HTTPException(status_code=400, detail="Need exactly 3 rows and 3 columns")

    stat_types = {"season_batting", "career_batting", "season_pitching", "career_pitching"}

    cell_counts = {}
    invalid_cells = []
    with get_connection() as conn:
        cur = conn.cursor()
        for ri, row_crit in enumerate(rows):
            for ci, col_crit in enumerate(columns):
                key = f"{ri}-{ci}"
                # Figure out team vs stat
                if row_crit.get("type") in stat_types and col_crit.get("type") not in stat_types:
                    team_crit, stat_crit = col_crit, row_crit
                elif col_crit.get("type") in stat_types and row_crit.get("type") not in stat_types:
                    team_crit, stat_crit = row_crit, col_crit
                elif row_crit.get("type") not in stat_types and col_crit.get("type") not in stat_types:
                    # Both are team criteria - check if any player has been on both
                    count = _count_dual_team_cell(cur, row_crit, col_crit)
                    cell_counts[key] = count
                    if count < 1:
                        invalid_cells.append(key)
                    continue
                else:
                    # Both stats - invalid combo
                    cell_counts[key] = 0
                    invalid_cells.append(key)
                    continue

                count = _count_players_for_cell(cur, team_crit, stat_crit)
                cell_counts[key] = count
                if count < 1:
                    invalid_cells.append(key)

    return {
        "valid": len(invalid_cells) == 0,
        "cell_counts": cell_counts,
        "invalid_cells": invalid_cells,
    }


def _count_dual_team_cell(cur, team_a, team_b):
    """Count players who have been on teams matching both team criteria."""
    # Build WHERE clauses for each team criteria
    def _team_subquery(crit, alias):
        tc_type = crit["type"]
        tc_value = crit.get("value", "")
        if tc_type == "team":
            return f"SELECT p.id FROM players p JOIN teams t ON p.team_id = t.id WHERE t.short_name = %s", [tc_value]
        elif tc_type == "conference":
            return (f"SELECT p.id FROM players p JOIN teams t ON p.team_id = t.id "
                    f"JOIN conferences c ON t.conference_id = c.id "
                    f"WHERE c.abbreviation ILIKE %s OR c.name ILIKE %s"), [tc_value, f"%{tc_value}%"]
        elif tc_type == "division":
            if tc_value == "non_d1_4yr":
                return (f"SELECT p.id FROM players p JOIN teams t ON p.team_id = t.id "
                        f"JOIN conferences c ON t.conference_id = c.id JOIN divisions d ON c.division_id = d.id "
                        f"WHERE d.level IN ('D2','D3','NAIA')"), []
            elif tc_value == "ALL":
                return "SELECT p.id FROM players p", []
            return (f"SELECT p.id FROM players p JOIN teams t ON p.team_id = t.id "
                    f"JOIN conferences c ON t.conference_id = c.id JOIN divisions d ON c.division_id = d.id "
                    f"WHERE d.level = %s"), [tc_value]
        return "SELECT NULL WHERE FALSE", []

    sq_a, params_a = _team_subquery(team_a, "a")
    sq_b, params_b = _team_subquery(team_b, "b")

    sql = f"SELECT COUNT(*) FROM ({sq_a}) a_ids INNER JOIN ({sq_b}) b_ids ON a_ids.id = b_ids.id"
    try:
        cur.execute(sql, tuple(params_a + params_b))
        row = cur.fetchone()
        return list(row.values())[0] or 0
    except Exception:
        return 0


def _find_players_for_cell(cur, team_criteria, stat_criteria, limit=50):
    """
    Find all players matching both team and stat criteria for a grid cell.
    Returns list of player dicts ordered by most recent season (desc).
    """
    tc_type = team_criteria["type"]
    tc_value = team_criteria.get("value", "")

    sc_type = stat_criteria["type"]
    sc_stat = stat_criteria["stat"]
    sc_op = {">=": ">=", ">": ">", "<=": "<=", "<": "<", "=": "="}.get(
        stat_criteria.get("operator", ">="), ">="
    )
    sc_threshold = stat_criteria["threshold"]
    sc_qualified = stat_criteria.get("qualified", False)
    sc_q_stat = stat_criteria.get("q_stat", "")
    sc_q_min = stat_criteria.get("q_min", 0)

    # Build team join/filter
    if tc_type == "division" and tc_value == "ALL":
        team_join = ""
        team_where = ""
        team_params = []
    elif tc_type == "team":
        team_join = "JOIN teams t ON p.team_id = t.id"
        team_where = "AND t.short_name = %s"
        team_params = [tc_value]
    elif tc_type == "conference":
        team_join = "JOIN teams t ON p.team_id = t.id JOIN conferences c ON t.conference_id = c.id"
        team_where = "AND (c.abbreviation ILIKE %s OR c.name ILIKE %s)"
        team_params = [tc_value, f"%{tc_value}%"]
    elif tc_type == "division":
        if tc_value == "non_d1_4yr":
            team_join = "JOIN teams t ON p.team_id = t.id JOIN conferences c ON t.conference_id = c.id JOIN divisions d ON c.division_id = d.id"
            team_where = "AND d.level IN ('D2', 'D3', 'NAIA')"
            team_params = []
        else:
            team_join = "JOIN teams t ON p.team_id = t.id JOIN conferences c ON t.conference_id = c.id JOIN divisions d ON c.division_id = d.id"
            team_where = "AND d.level = %s"
            team_params = [tc_value]
    else:
        return []

    # Stat table and alias
    if sc_type in ("season_batting", "career_batting"):
        stat_table = "batting_stats"
        stat_alias = "bs"
    else:
        stat_table = "pitching_stats"
        stat_alias = "ps"

    # Qualification clause
    q_clause = ""
    q_params = []
    if sc_qualified and sc_q_stat and sc_q_min:
        q_clause = f" AND {stat_alias}.{sc_q_stat} >= %s"
        q_params = [sc_q_min]

    is_career = sc_type.startswith("career_")
    career_rate = stat_criteria.get("career_rate", False)

    if is_career and career_rate:
        num_col = stat_criteria["numerator"]
        den_col = stat_criteria["denominator"]
        mult = stat_criteria.get("multiplier", 1)
        sql = f"""
            SELECT {stat_alias}.player_id,
                   p.first_name, p.last_name, p.headshot_url,
                   t2.short_name as team_short, t2.logo_url,
                   MAX({stat_alias}.season) as last_season
            FROM {stat_table} {stat_alias}
            JOIN players p ON {stat_alias}.player_id = p.id
            JOIN teams t2 ON p.team_id = t2.id
            {team_join}
            WHERE 1=1 {team_where}
            GROUP BY {stat_alias}.player_id, p.first_name, p.last_name, p.headshot_url,
                     t2.short_name, t2.logo_url
            HAVING SUM({stat_alias}.{den_col}) >= %s
               AND SUM({stat_alias}.{num_col}) * {mult} / NULLIF(SUM({stat_alias}.{den_col}), 0) {sc_op} %s
            ORDER BY last_season DESC, p.last_name, p.first_name
            LIMIT %s
        """
        params = team_params + [sc_q_min, sc_threshold, limit]
    elif is_career:
        rate_stats_b = {"batting_avg", "on_base_pct", "slugging_pct", "ops",
                        "iso", "babip", "bb_pct", "k_pct", "woba", "wrc_plus"}
        rate_stats_p = {"era", "whip", "k_per_9", "bb_per_9", "h_per_9",
                        "hr_per_9", "k_bb_ratio", "fip", "babip_against"}
        rate_stats = rate_stats_b if "batting" in sc_type else rate_stats_p
        if sc_stat in rate_stats:
            sql = f"""
                SELECT DISTINCT ON ({stat_alias}.player_id)
                       {stat_alias}.player_id,
                       p.first_name, p.last_name, p.headshot_url,
                       t2.short_name as team_short, t2.logo_url,
                       {stat_alias}.season as last_season
                FROM {stat_table} {stat_alias}
                JOIN players p ON {stat_alias}.player_id = p.id
                JOIN teams t2 ON p.team_id = t2.id
                {team_join}
                WHERE {stat_alias}.{sc_stat} {sc_op} %s {team_where}{q_clause}
                ORDER BY {stat_alias}.player_id, {stat_alias}.season DESC
            """
            params = [sc_threshold] + team_params + q_params
            # Wrap to re-sort by last_season desc
            sql = f"""
                SELECT * FROM ({sql}) sub
                ORDER BY last_season DESC, last_name, first_name
                LIMIT %s
            """
            params.append(limit)
        else:
            sql = f"""
                SELECT {stat_alias}.player_id,
                       p.first_name, p.last_name, p.headshot_url,
                       t2.short_name as team_short, t2.logo_url,
                       MAX({stat_alias}.season) as last_season
                FROM {stat_table} {stat_alias}
                JOIN players p ON {stat_alias}.player_id = p.id
                JOIN teams t2 ON p.team_id = t2.id
                {team_join}
                WHERE 1=1 {team_where}
                GROUP BY {stat_alias}.player_id, p.first_name, p.last_name, p.headshot_url,
                         t2.short_name, t2.logo_url
                HAVING SUM({stat_alias}.{sc_stat}) {sc_op} %s
                ORDER BY last_season DESC, p.last_name, p.first_name
                LIMIT %s
            """
            params = team_params + [sc_threshold, limit]
    else:
        # Season stat
        sql = f"""
            SELECT DISTINCT ON ({stat_alias}.player_id)
                   {stat_alias}.player_id,
                   p.first_name, p.last_name, p.headshot_url,
                   t2.short_name as team_short, t2.logo_url,
                   {stat_alias}.season as last_season
            FROM {stat_table} {stat_alias}
            JOIN players p ON {stat_alias}.player_id = p.id
            JOIN teams t2 ON p.team_id = t2.id
            {team_join}
            WHERE {stat_alias}.{sc_stat} {sc_op} %s {team_where}{q_clause}
            ORDER BY {stat_alias}.player_id, {stat_alias}.season DESC
        """
        params = [sc_threshold] + team_params + q_params
        # Wrap to re-sort
        sql = f"""
            SELECT * FROM ({sql}) sub
            ORDER BY last_season DESC, last_name, first_name
            LIMIT %s
        """
        params.append(limit)

    try:
        cur.execute(sql, tuple(params))
        results = []
        for row in cur.fetchall():
            results.append({
                "player_id": row["player_id"],
                "first_name": row["first_name"],
                "last_name": row["last_name"],
                "headshot_url": row["headshot_url"],
                "team_short": row["team_short"],
                "logo_url": row["logo_url"],
                "last_season": row["last_season"],
            })
        return results
    except Exception:
        return []


