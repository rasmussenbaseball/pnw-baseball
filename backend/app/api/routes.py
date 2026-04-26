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
import smtplib
import threading
from bisect import bisect_left, bisect_right
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, date, timedelta

from fastapi import APIRouter, Depends, Query, HTTPException
from fastapi.responses import JSONResponse
from typing import Optional
from ..models.database import get_connection
from .auth import require_admin
from .leverage import compute_li

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
from ..stats.ppi import compute_ppi_for_division
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
QUALIFIED_PITCHING_WHERE = (
    " AND ps.innings_pitched >= {ip_per_game} * (COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0))"
    .format(ip_per_game=QUALIFIED_IP_PER_GAME)
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
            SUM(COALESCE(gp.innings_pitched,0)) as innings_pitched,
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
            CASE WHEN SUM(COALESCE(gp.innings_pitched,0)) > 0
                THEN ROUND(9.0 * SUM(COALESCE(gp.earned_runs,0))::numeric / SUM(gp.innings_pitched)::numeric, 2) END as era,
            CASE WHEN SUM(COALESCE(gp.innings_pitched,0)) > 0
                THEN ROUND((SUM(COALESCE(gp.walks,0)) + SUM(COALESCE(gp.hits_allowed,0)))::numeric / SUM(gp.innings_pitched)::numeric, 2) END as whip,
            CASE WHEN SUM(COALESCE(gp.innings_pitched,0)) > 0
                THEN ROUND(9.0 * SUM(COALESCE(gp.strikeouts,0))::numeric / SUM(gp.innings_pitched)::numeric, 1) END as k_per_9,
            CASE WHEN SUM(COALESCE(gp.innings_pitched,0)) > 0
                THEN ROUND(9.0 * SUM(COALESCE(gp.walks,0))::numeric / SUM(gp.innings_pitched)::numeric, 1) END as bb_per_9,
            CASE WHEN SUM(COALESCE(gp.innings_pitched,0)) > 0
                THEN ROUND(9.0 * SUM(COALESCE(gp.hits_allowed,0))::numeric / SUM(gp.innings_pitched)::numeric, 1) END as h_per_9,
            CASE WHEN SUM(COALESCE(gp.innings_pitched,0)) > 0
                THEN ROUND(9.0 * SUM(COALESCE(gp.home_runs_allowed,0))::numeric / SUM(gp.innings_pitched)::numeric, 1) END as hr_per_9,
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
def site_stats():
    """Return aggregate counts and a random player for the homepage."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) AS cnt FROM players")
        total_players = cur.fetchone()["cnt"]
        cur.execute("SELECT COUNT(*) AS cnt FROM games")
        total_games = cur.fetchone()["cnt"]
        cur.execute("SELECT COUNT(DISTINCT team_id) AS cnt FROM batting_stats")
        total_teams = cur.fetchone()["cnt"]

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
        "random_player": dict(random_player) if random_player else None,
    }


# ── Stats last-updated timestamps ─────────────────────────────────
@router.get("/stats/last-updated")
def stats_last_updated_top(season: int = 2026):
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
def hometown_search(q: str = Query("", min_length=0)):
    """Search players by hometown. Returns players whose hometown contains the query string."""
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
def list_divisions():
    """List all divisions (D1, D2, D3, NAIA, NWAC)."""
    with get_connection() as conn:
        cur = conn.cursor()
        rows = cur.execute("SELECT * FROM divisions ORDER BY id")
        rows = cur.fetchall()
        return [dict(r) for r in rows]


@router.get("/conferences")
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

        # Fetch PPI ranks for JUCO teams (no national rankings exist for them)
        cur.execute("""
            SELECT t.id,
                   COALESCE(bat.total_owar, 0) as team_owar,
                   COALESCE(pit.total_pwar, 0) as team_pwar,
                   COALESCE(bat.total_owar, 0) + COALESCE(pit.total_pwar, 0) as team_war,
                   COALESCE(bat.team_wrc_plus, 100) as team_wrc_plus,
                   COALESCE(pit.team_fip, 4.5) as team_fip,
                   COALESCE(sf.wins, s.wins, 0) as wins,
                   COALESCE(sf.losses, s.losses, 0) as losses,
                   COALESCE(sf.conference_wins, s.conference_wins, 0) as conf_wins,
                   COALESCE(sf.conference_losses, s.conference_losses, 0) as conf_losses
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN team_season_stats_frozen sf ON sf.team_id = t.id AND sf.season = %s
            LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
            LEFT JOIN (
                SELECT team_id,
                    SUM(offensive_war) as total_owar,
                    SUM(wrc_plus * plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL)
                      / NULLIF(SUM(plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL), 0) as team_wrc_plus
                FROM batting_stats WHERE season = %s GROUP BY team_id
            ) bat ON bat.team_id = t.id
            LEFT JOIN (
                SELECT team_id,
                    SUM(pitching_war) as total_pwar,
                    SUM(fip * innings_pitched) FILTER (WHERE fip IS NOT NULL)
                      / NULLIF(SUM(innings_pitched) FILTER (WHERE fip IS NOT NULL), 0) as team_fip
                FROM pitching_stats WHERE season = %s GROUP BY team_id
            ) pit ON pit.team_id = t.id
            WHERE t.is_active = 1 AND d.level = 'JUCO'
        """, (season, season, season, season))
        juco_rows = cur.fetchall()
        # Compute PPI and build lookup
        juco_teams_for_ppi = []
        for r in juco_rows:
            t = dict(r)
            total = t["wins"] + t["losses"]
            t["win_pct"] = round(t["wins"] / total, 3) if total > 0 else 0.0
            conf_total = t["conf_wins"] + t["conf_losses"]
            t["conf_win_pct"] = round(t["conf_wins"] / conf_total, 3) if conf_total > 0 else 0.0
            juco_teams_for_ppi.append(t)
        juco_ranked = compute_ppi_for_division(juco_teams_for_ppi)
        ppi_lookup = {t["id"]: t.get("ppi_rank") for t in juco_ranked}

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
            # Attach ranking: national_rank for D1-NAIA, ppi_rank for JUCO
            if team["division_level"] == "JUCO":
                team["rank"] = ppi_lookup.get(team["id"])
                team["rank_label"] = "PPI"
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
                    SUM(fip * innings_pitched) FILTER (WHERE fip IS NOT NULL)
                      / NULLIF(SUM(innings_pitched) FILTER (WHERE fip IS NOT NULL), 0) as avg_fip
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

        # 4. For JUCO teams, compute PPI ranks.
        # COALESCE pattern: read wins/losses from team_season_stats_frozen first
        # (so a frozen NWAC conference keeps its end-of-regular-season record),
        # falling back to the live table for conferences still playing.
        cur.execute("""
            SELECT t.id,
                   COALESCE(bat.total_owar, 0) as team_owar,
                   COALESCE(pit.total_pwar, 0) as team_pwar,
                   COALESCE(bat.total_owar, 0) + COALESCE(pit.total_pwar, 0) as team_war,
                   COALESCE(bat.team_wrc_plus, 100) as team_wrc_plus,
                   COALESCE(pit.team_fip, 4.5) as team_fip,
                   COALESCE(sf.wins, s.wins, 0) as wins,
                   COALESCE(sf.losses, s.losses, 0) as losses,
                   COALESCE(sf.conference_wins, s.conference_wins, 0) as conf_wins,
                   COALESCE(sf.conference_losses, s.conference_losses, 0) as conf_losses
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN team_season_stats_frozen sf ON sf.team_id = t.id AND sf.season = %s
            LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
            LEFT JOIN (
                SELECT team_id,
                    SUM(offensive_war) as total_owar,
                    SUM(wrc_plus * plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL)
                      / NULLIF(SUM(plate_appearances) FILTER (WHERE wrc_plus IS NOT NULL), 0) as team_wrc_plus
                FROM batting_stats WHERE season = %s GROUP BY team_id
            ) bat ON bat.team_id = t.id
            LEFT JOIN (
                SELECT team_id,
                    SUM(pitching_war) as total_pwar,
                    SUM(fip * innings_pitched) FILTER (WHERE fip IS NOT NULL)
                      / NULLIF(SUM(innings_pitched) FILTER (WHERE fip IS NOT NULL), 0) as team_fip
                FROM pitching_stats WHERE season = %s GROUP BY team_id
            ) pit ON pit.team_id = t.id
            WHERE t.is_active = 1 AND d.level = 'JUCO'
        """, (season, season, season, season))
        juco_rows = cur.fetchall()
        juco_teams_for_ppi = []
        for r in juco_rows:
            t = dict(r)
            total = t["wins"] + t["losses"]
            t["win_pct"] = round(t["wins"] / total, 3) if total > 0 else 0.0
            conf_total = t["conf_wins"] + t["conf_losses"]
            t["conf_win_pct"] = round(t["conf_wins"] / conf_total, 3) if conf_total > 0 else 0.0
            juco_teams_for_ppi.append(t)
        juco_ranked = compute_ppi_for_division(juco_teams_for_ppi)
        ppi_lookup = {t["id"]: t.get("ppi_rank") for t in juco_ranked}

        # 5. Build conference groups
        conferences = {}
        for r in team_rows:
            team = dict(r)
            total_games = team["wins"] + team["losses"]
            team["win_pct"] = round(team["wins"] / total_games, 3) if total_games > 0 else 0
            conf_games = team["conf_wins"] + team["conf_losses"]
            team["conf_win_pct"] = round(team["conf_wins"] / conf_games, 3) if conf_games > 0 else 0
            team["conf_games_remaining"] = conf_remaining.get(team["id"], 0)

            # Ranking: national for 4-year, PPI for JUCO
            if team["division_level"] == "JUCO":
                team["rank"] = ppi_lookup.get(team["id"])
                team["rank_label"] = "PPI"
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
                            SUM(COALESCE(gp.innings_pitched, 0)) as ip_raw,
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
                       CASE WHEN ps.innings_pitched >= {QUALIFIED_IP_PER_GAME} * (COALESCE(tss2.wins,0) + COALESCE(tss2.losses,0) + COALESCE(tss2.ties,0))
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
            WHERE ps.innings_pitched >= 0.75 * (COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0))
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
                   SUM(ps.innings_pitched) as innings_pitched,
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
            HAVING SUM(ps.innings_pitched) >= 100
        """)
        career_pit_rows = []
        for r in cur.fetchall():
            d = dict(r)
            ip = d["innings_pitched"] or 0
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
                   CASE WHEN SUM(ps.innings_pitched) > 0
                        THEN ROUND((SUM(ps.earned_runs)::numeric / SUM(ps.innings_pitched)::numeric) * 9, 2) END as team_era,
                   CASE WHEN SUM(ps.innings_pitched) > 0
                        THEN ROUND(SUM(ps.walks + ps.hits_allowed)::numeric / SUM(ps.innings_pitched)::numeric, 2) END as team_whip,
                   CASE WHEN SUM(ps.innings_pitched) FILTER (WHERE ps.fip IS NOT NULL) > 0
                        THEN ROUND(
                          SUM(ps.fip * ps.innings_pitched) FILTER (WHERE ps.fip IS NOT NULL)::numeric
                          / SUM(ps.innings_pitched) FILTER (WHERE ps.fip IS NOT NULL)::numeric, 2)
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
def team_ratings(
    season: int = Query(..., description="Season year"),
):
    """
    PNW Power Index (PPI) ratings for all teams, grouped by division.
    Each team is rated 0-100 relative to its division peers (50 = average).
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
                    SUM(fip * innings_pitched) FILTER (WHERE fip IS NOT NULL)
                      / NULLIF(SUM(innings_pitched) FILTER (WHERE fip IS NOT NULL), 0) as team_fip
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

        # Compute PPI per division
        for div in divisions.values():
            div["teams"] = compute_ppi_for_division(div["teams"])

        return list(divisions.values())


@router.get("/national-rankings")
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

        # For teams without composite rankings (JUCO), include PPI data
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
                "note": "NWAC teams use PPI (internal rating) - no external national rankings available for JUCO"
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
                       SUM(innings_pitched) as total_ip,
                       SUM(strikeouts) as total_k,
                       SUM(walks) as total_bb,
                       SUM(hits_allowed) as total_h,
                       SUM(earned_runs) as total_er,
                       SUM(home_runs_allowed) as total_hr,
                       SUM(hit_batters) as total_hbp,
                       CASE WHEN SUM(innings_pitched) > 0
                            THEN ROUND((SUM(earned_runs) * 9.0 / SUM(innings_pitched))::numeric, 2) ELSE 0 END as team_era,
                       CASE WHEN SUM(innings_pitched) > 0
                            THEN ROUND(((SUM(walks) + SUM(hits_allowed)) / SUM(innings_pitched))::numeric, 2) ELSE 0 END as team_whip,
                       -- Rate stats: IP-weighted with NULL guards.
                       -- k_pct/bb_pct rebuilt from raw totals over batters_faced.
                       ROUND((SUM(fip * innings_pitched) FILTER (WHERE fip IS NOT NULL)
                              / NULLIF(SUM(innings_pitched) FILTER (WHERE fip IS NOT NULL), 0))::numeric, 2) as avg_fip,
                       ROUND((SUM(fip_plus * innings_pitched) FILTER (WHERE fip_plus IS NOT NULL)
                              / NULLIF(SUM(innings_pitched) FILTER (WHERE fip_plus IS NOT NULL), 0))::numeric, 0) as avg_fip_plus,
                       ROUND((SUM(era_minus * innings_pitched) FILTER (WHERE era_minus IS NOT NULL)
                              / NULLIF(SUM(innings_pitched) FILTER (WHERE era_minus IS NOT NULL), 0))::numeric, 0) as avg_era_minus,
                       ROUND((SUM(xfip * innings_pitched) FILTER (WHERE xfip IS NOT NULL)
                              / NULLIF(SUM(innings_pitched) FILTER (WHERE xfip IS NOT NULL), 0))::numeric, 2) as avg_xfip,
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

            row = dict(team)
            row["record"] = dict(record) if record else {"wins": 0, "losses": 0, "ties": 0}
            row["batting"] = dict(batting_agg) if batting_agg else {}
            row["pitching"] = _add_era_plus(dict(pitching_agg)) if pitching_agg else {}
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
                       SUM(fip * innings_pitched) FILTER (WHERE fip IS NOT NULL)
                         / NULLIF(SUM(innings_pitched) FILTER (WHERE fip IS NOT NULL), 0) as avg_fip,
                       SUM(fip_plus * innings_pitched) FILTER (WHERE fip_plus IS NOT NULL)
                         / NULLIF(SUM(innings_pitched) FILTER (WHERE fip_plus IS NOT NULL), 0) as avg_fip_plus,
                       SUM(pitching_war) as total_pwar,
                       SUM(innings_pitched) as total_ip,
                       CASE WHEN SUM(innings_pitched) > 0
                            THEN ROUND((SUM(earned_runs) * 9.0 / SUM(innings_pitched))::numeric, 2)
                            ELSE 0 END as team_era
                FROM pitching_stats
                WHERE team_id = %s AND season = %s AND innings_pitched >= 3
            """, (tid, season))
            pit = cur.fetchone()

            if not bat or not pit:
                continue

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
            rs = float(bat["rs"] or 0)
            ra = float(pit["ra"] or pit["er"] or 0)
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
                    "team_era": float(pit["team_era"] or 0),
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
               SUM(fip * innings_pitched) FILTER (WHERE fip IS NOT NULL)
                 / NULLIF(SUM(innings_pitched) FILTER (WHERE fip IS NOT NULL), 0) as avg_fip,
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
    season: int = Query(2026, description="Season year"),
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
    season: int = Query(2026, description="Season year"),
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
                    SUM(fip * innings_pitched) FILTER (WHERE fip IS NOT NULL)
                      / NULLIF(SUM(innings_pitched) FILTER (WHERE fip IS NOT NULL), 0) as avg_fip
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


@router.get("/teams/scatter")
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
                       SUM(innings_pitched) as ip, SUM(earned_runs) as er,
                       SUM(runs_allowed) as ra,
                       SUM(walks) as bb, SUM(hits_allowed) as h,
                       SUM(strikeouts) as k, SUM(home_runs_allowed) as hr,
                       -- Rate stats: IP-weighted with NULL guards.
                       -- k_pct/bb_pct rebuilt from raw totals over batters_faced.
                       SUM(fip * innings_pitched) FILTER (WHERE fip IS NOT NULL)
                         / NULLIF(SUM(innings_pitched) FILTER (WHERE fip IS NOT NULL), 0) as avg_fip,
                       SUM(fip_plus * innings_pitched) FILTER (WHERE fip_plus IS NOT NULL)
                         / NULLIF(SUM(innings_pitched) FILTER (WHERE fip_plus IS NOT NULL), 0) as avg_fip_plus,
                       SUM(era_minus * innings_pitched) FILTER (WHERE era_minus IS NOT NULL)
                         / NULLIF(SUM(innings_pitched) FILTER (WHERE era_minus IS NOT NULL), 0) as avg_era_minus,
                       SUM(xfip * innings_pitched) FILTER (WHERE xfip IS NOT NULL)
                         / NULLIF(SUM(innings_pitched) FILTER (WHERE xfip IS NOT NULL), 0) as avg_xfip,
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

            def _compute(stat_name, b=bat_row, p=pit_row):
                if stat_name == "team_avg":
                    return round(b["h"] / b["ab"], 3) if b["ab"] else None
                elif stat_name == "team_obp":
                    d = b["pa"] or 0
                    return round((b["h"] + b["bb"] + b["hbp"]) / d, 3) if d else None
                elif stat_name == "team_slg":
                    ab = b["ab"] or 0
                    if not ab: return None
                    tb = (b["h"]-b["d2b"]-b["d3b"]-b["hr"]) + 2*b["d2b"] + 3*b["d3b"] + 4*b["hr"]
                    return round(tb / ab, 3)
                elif stat_name == "team_ops":
                    obp = _compute("team_obp", b, p)
                    slg = _compute("team_slg", b, p)
                    return round(obp + slg, 3) if obp and slg else None
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
                    ip = (p["ip"] or 0) if p else 0
                    return round(p["er"] * 9 / ip, 2) if ip > 0 else None
                elif stat_name == "team_whip":
                    ip = (p["ip"] or 0) if p else 0
                    return round((p["bb"] + p["h"]) / ip, 2) if ip > 0 else None
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
                """SELECT SUM(innings_pitched) as ip, SUM(earned_runs) as er,
                       SUM(runs_allowed) as ra,
                       SUM(walks) as bb, SUM(hits_allowed) as h,
                       SUM(strikeouts) as k, SUM(home_runs_allowed) as hr,
                       -- Rate stats: IP-weighted with NULL guards.
                       -- k_pct/bb_pct rebuilt from raw totals over batters_faced.
                       SUM(fip * innings_pitched) FILTER (WHERE fip IS NOT NULL)
                         / NULLIF(SUM(innings_pitched) FILTER (WHERE fip IS NOT NULL), 0) as avg_fip,
                       SUM(xfip * innings_pitched) FILTER (WHERE xfip IS NOT NULL)
                         / NULLIF(SUM(innings_pitched) FILTER (WHERE xfip IS NOT NULL), 0) as avg_xfip,
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
            ip = (p["ip"] or 0) if p else 0

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
def get_team_rankings(
    team_id: int,
    season: int = Query(2026, description="Season year"),
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

@router.get("/teams/{team_id}/info-graphic")
def team_info_graphic(
    team_id: int,
    season: int = Query(2026, description="Season year"),
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
                   SUM(fip * innings_pitched) FILTER (WHERE fip IS NOT NULL)
                     / NULLIF(SUM(innings_pitched) FILTER (WHERE fip IS NOT NULL), 0) as avg_fip
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
                           SUM(fip * innings_pitched) FILTER (WHERE fip IS NOT NULL)
                             / NULLIF(SUM(innings_pitched) FILTER (WHERE fip IS NOT NULL), 0) as avg_fip
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
                   bs.offensive_war::float as offensive_war
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
        cur.execute("""
            SELECT p.id, p.first_name, p.last_name, p.position, p.year_in_school,
                   p.headshot_url,
                   ps.era::float as era,
                   ps.siera::float as siera,
                   (COALESCE(ps.k_pct, 0) * 100)::float as k_pct,
                   (COALESCE(ps.bb_pct, 0) * 100)::float as bb_pct,
                   ps.pitching_war::float as pitching_war
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
                   (SUM(ps.earned_runs) * 9.0 / NULLIF(SUM(ps.innings_pitched), 0))::float as era,
                   (SUM(ps.siera * ps.innings_pitched)
                      FILTER (WHERE ps.siera IS NOT NULL))::float
                     / NULLIF(SUM(ps.innings_pitched)
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
            """Return {percentile, rank, total} for my_val against division peers."""
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
            # percentile for color
            if total < 3:
                pct = None
            else:
                below = sum(1 for v in vals if v < my_val)
                equal = sum(1 for v in vals if v == my_val)
                pct = round(((below + equal * 0.5) / total) * 100)
                if not higher_is_better:
                    pct = 100 - pct
                pct = max(1, min(99, pct))
            return {"percentile": pct, "rank": rank, "total": total}

        my_bat = next((b for b in bat_div if b["team_id"] == team_id), {}) or {}
        my_pit = next((p for p in pit_div if p["team_id"] == team_id), {}) or {}

        def _to_f(v):
            return float(v) if v is not None else None

        def _pack(value, rb):
            return {"value": _to_f(value), **rb}

        batting_percentiles = {
            "batting_avg": _pack(my_bat.get("batting_avg"),
                                 _rank_block([b.get("batting_avg") for b in bat_div], my_bat.get("batting_avg"), True)),
            "woba":        _pack(my_bat.get("woba"),
                                 _rank_block([b.get("woba") for b in bat_div], my_bat.get("woba"), True)),
            "hr_per_pa":   _pack(my_bat.get("hr_per_pa"),
                                 _rank_block([b.get("hr_per_pa") for b in bat_div], my_bat.get("hr_per_pa"), True)),
            "owar":        _pack(my_bat.get("owar"),
                                 _rank_block([b.get("owar") for b in bat_div], my_bat.get("owar"), True)),
            "wrc_plus":    _pack(my_bat.get("wrc_plus"),
                                 _rank_block([b.get("wrc_plus") for b in bat_div], my_bat.get("wrc_plus"), True)),
        }
        pitching_percentiles = {
            "era":   _pack(my_pit.get("era"),
                           _rank_block([p.get("era") for p in pit_div], my_pit.get("era"), False)),
            "siera": _pack(my_pit.get("siera"),
                           _rank_block([p.get("siera") for p in pit_div], my_pit.get("siera"), False)),
            "k_pct": _pack(my_pit.get("k_pct"),
                           _rank_block([p.get("k_pct") for p in pit_div], my_pit.get("k_pct"), True)),
            "baa":   _pack(my_pit.get("baa"),
                           _rank_block([p.get("baa") for p in pit_div], my_pit.get("baa"), False)),
            "pwar":  _pack(my_pit.get("pwar"),
                           _rank_block([p.get("pwar") for p in pit_div], my_pit.get("pwar"), True)),
        }

        # Inject convenience "name" into top performers
        for h in top_hitters:
            h["name"] = f'{h.get("first_name","")} {h.get("last_name","")}'.strip()
        for p in top_pitchers:
            p["name"] = f'{p.get("first_name","")} {p.get("last_name","")}'.strip()

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
# LEADERBOARDS: Pitching
# ============================================================

@router.get("/leaderboards/pitching")
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
# WAR LEADERBOARD
# ============================================================

@router.get("/leaderboards/war")
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
                       SUM(innings_pitched) as ip, SUM(earned_runs) as er,
                       SUM(walks) as bb, SUM(hits_allowed) as h,
                       SUM(strikeouts) as k, SUM(home_runs_allowed) as hr,
                       SUM(batters_faced) as bf,
                       -- Rate stats: IP-weighted w/ NULL guards; k and bb rates raw totals.
                       SUM(fip * innings_pitched) FILTER (WHERE fip IS NOT NULL)
                         / NULLIF(SUM(innings_pitched) FILTER (WHERE fip IS NOT NULL), 0) as avg_fip,
                       SUM(fip_plus * innings_pitched) FILTER (WHERE fip_plus IS NOT NULL)
                         / NULLIF(SUM(innings_pitched) FILTER (WHERE fip_plus IS NOT NULL), 0) as avg_fip_plus,
                       SUM(era_minus * innings_pitched) FILTER (WHERE era_minus IS NOT NULL)
                         / NULLIF(SUM(innings_pitched) FILTER (WHERE era_minus IS NOT NULL), 0) as avg_era_minus,
                       SUM(xfip * innings_pitched) FILTER (WHERE xfip IS NOT NULL)
                         / NULLIF(SUM(innings_pitched) FILTER (WHERE xfip IS NOT NULL), 0) as avg_xfip,
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
                # batting
                "team_avg": round(b["h"] / ab, 3) if ab else None,
                "team_obp": round((b["h"] + b["bb"] + b["hbp"]) / pa, 3) if pa else None,
                "team_slg": None,
                "team_ops": None,
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
                # pitching
                "team_era": round(float(p["er"]) * 9 / ip, 2) if ip > 0 else None,
                "team_whip": round((float(p["bb"]) + float(p["h"])) / ip, 2) if ip > 0 else None,
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

            # SLG and OPS
            if ab > 0:
                tb = (b["h"] - b["d2b"] - b["d3b"] - b["hr"]) + 2 * b["d2b"] + 3 * b["d3b"] + 4 * b["hr"]
                row["team_slg"] = round(tb / ab, 3)
                if row["team_obp"] is not None:
                    row["team_ops"] = round(row["team_obp"] + row["team_slg"], 3)

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
              AND (p.first_name ILIKE %s OR p.last_name ILIKE %s
                   OR (p.first_name || ' ' || p.last_name) ILIKE %s)
            ORDER BY p.last_name, p.first_name
            LIMIT %s
        """, (search, search, search, limit))
        players = cur.fetchall()

        return {
            "teams": [dict(r) for r in teams],
            "players": [dict(r) for r in players],
        }


# ============================================================
# PLAYERS
# ============================================================

@router.get("/players/search")
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
          COUNT(*) FILTER (
            WHERE bb_type IN ('LD','FB')
              AND ((UPPER(p.bats) = 'R' AND field_zone = 'LEFT')
                OR (UPPER(p.bats) = 'L' AND field_zone = 'RIGHT'))
          ) AS air_pull,
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

    baselines = _get_pitch_level_baselines(cur, season, division_level, weights)
    overall = baselines.get("overall") or {}
    deciles = overall.get("deciles") or {}

    out = {}
    if contact_pct is not None:
        p = _pct_from_deciles(contact_pct, deciles.get("contact_pct"), higher_better=True)
        if p is not None:
            out["contact_pct"] = {"value": contact_pct, "percentile": p}
    if air_pull_pct is not None:
        p = _pct_from_deciles(air_pull_pct, deciles.get("air_pull_pct"), higher_better=True)
        if p is not None:
            out["air_pull_pct"] = {"value": air_pull_pct, "percentile": p}

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
          COUNT(*) FILTER (WHERE pitches_thrown IS NOT NULL) AS tracked_pa,
          COALESCE(SUM(pitches_thrown), 0) AS pitches,
          COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))), 0) AS pK,
          COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'S', ''))), 0) AS pS,
          COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS pF,
          COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS p_inplay,
          COUNT(*) FILTER (
              WHERE pitches_thrown IS NOT NULL AND
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
    swings = pK + pF + in_play
    strikes = pK + pS + pF + in_play
    bb_total = r.get("bb_total") or 0

    strike_pct = (strikes / pitches) if pitches > 0 else None
    whiff_pct = (pK / swings) if swings > 0 else None
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
                      SUM(ps.innings_pitched) as ip, SUM(ps.earned_runs) as er,
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
                  AND SUM(ps.innings_pitched) >= 20""",
            (division_level,),
        )
        all_players = cur.fetchall()

        league_stats = []
        for p in all_players:
            pd = dict(p)
            ip, bb, k, bf = pd["ip"], pd["bb"], pd["k"], pd["bf"]
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
                agg_expr = "ROUND((9.0 * SUM(ps.earned_runs) / NULLIF(SUM(ps.innings_pitched), 0))::numeric, 2)"
            elif col == "pitching_war":
                agg_expr = "ROUND(SUM(ps.pitching_war)::numeric, 1)"
            elif col == "innings_pitched":
                agg_expr = "ROUND(SUM(ps.innings_pitched)::numeric, 1)"
            else:
                agg_expr = f"SUM(ps.{col})"

            direction = "DESC" if desc else "ASC"
            cur.execute(
                f"""SELECT ps.player_id, {agg_expr} as career_val
                    FROM pitching_stats ps
                    WHERE ps.team_id = %s
                    GROUP BY ps.player_id
                    HAVING SUM(ps.innings_pitched) >= 20
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

        # Determine which season to compute percentiles for
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
            target_season = None
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
        current_season = 2026
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
        cur.execute("""
            SELECT gb.position, COUNT(DISTINCT (g.game_date, COALESCE(g.game_number, 1))) as games
            FROM game_batting gb
            JOIN games g ON g.id = gb.game_id
            WHERE gb.player_id IN %s
              AND g.season = 2026
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

        return {
            "player": player_dict,
            "batting_stats": batting_list,
            "pitching_stats": [_add_era_plus(r) for r in pitching_list],
            "team_history": [dict(r) for r in history],
            "batting_percentiles": batting_percentiles,
            "pitching_percentiles": pitching_percentiles,
            "percentile_season": percentile_label,
            "awards": all_awards["season_awards"],
            "career_rankings": all_awards["career_rankings"],
            "pnw_rankings": pnw_rankings,
            "position_breakdown": position_breakdown,
            "linked_players": linked_players,
            "summer_batting": summer_batting,
            "summer_pitching": summer_pitching,
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
):
    """
    Find uncommitted JUCO players - the primary recruiting tool.
    Shows sophomores (or specified class) who haven't committed to a 4-year school.
    Year filter groups: 'So' matches So and R-So, 'Fr' matches Fr and R-Fr.
    """
    allowed_sort = {
        "total_war", "offensive_war", "pitching_war",
        "batting_avg", "on_base_pct", "slugging_pct", "ops",
        "woba", "wrc_plus", "home_runs", "rbi", "stolen_bases",
        "plate_appearances", "era", "fip", "fip_plus", "era_minus", "era_plus", "innings_pitched",
    }
    if sort_by not in allowed_sort:
        sort_by = "total_war"
    direction = "ASC" if sort_dir.lower() == "asc" else "DESC"
    # For ERA/FIP, ascending is better
    if sort_by in ("era", "fip") and sort_dir.lower() not in ("asc", "desc"):
        direction = "ASC"

    with get_connection() as conn:
        cur = conn.cursor()
        query = """
            SELECT p.*, t.name as team_name, t.short_name as team_short, t.logo_url,
                   bs.batting_avg, bs.on_base_pct, bs.slugging_pct, bs.ops,
                   bs.woba, bs.wrc_plus, bs.offensive_war,
                   bs.home_runs, bs.rbi, bs.stolen_bases, bs.plate_appearances,
                   ps2.era, ps2.fip, ps2.fip_plus, ps2.era_minus, ps2.xfip, ps2.strikeouts as pitch_k,
                   ps2.k_pct as pitch_k_pct, ps2.bb_pct as pitch_bb_pct,
                   ps2.innings_pitched, ps2.pitching_war,
                   COALESCE(bs.offensive_war, 0) + COALESCE(ps2.pitching_war, 0) as total_war
            FROM players p
            JOIN teams t ON p.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN batting_stats bs ON p.id = bs.player_id AND bs.season = %s
            LEFT JOIN pitching_stats ps2 ON p.id = ps2.player_id AND ps2.season = %s
            WHERE d.level = 'JUCO'
              AND (bs.player_id IS NOT NULL OR ps2.player_id IS NOT NULL)
        """
        params: list = [season, season]

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

        # Use the computed total_war alias or COALESCE for other columns
        if sort_by == "total_war":
            query += f" ORDER BY total_war {direction} NULLS LAST"
        elif sort_by in ("era", "fip", "era_minus", "innings_pitched"):
            # Lower-is-better pitching stats: NULLs → 999 so they sort last in ASC
            query += f" ORDER BY COALESCE(ps2.{sort_by}, 999) {direction}"
        elif sort_by == "era_plus":
            query += f" ORDER BY CASE WHEN ps2.era_minus > 0 THEN 10000.0 / ps2.era_minus END {direction} NULLS LAST"
        elif sort_by in ("fip_plus", "pitching_war"):
            # Higher-is-better pitching stats: NULLs → 0 so they sort last in DESC
            query += f" ORDER BY COALESCE(ps2.{sort_by}, 0) {direction}"
        else:
            query += f" ORDER BY COALESCE(bs.{sort_by}, 0) {direction} NULLS LAST"
        query += " LIMIT %s"
        params.append(limit)

        rows = cur.execute(query, params)
        rows = cur.fetchall()
        return [_add_era_plus(dict(r)) for r in rows]


# ============================================================
# TEAM STATS
# ============================================================

@router.get("/teams/{team_id}/roster")
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


@router.get("/teams/{team_id}/stats")
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

        cur.execute(
            """SELECT bs.*, p.first_name, p.last_name, p.position, p.year_in_school
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
                      p.first_name, p.last_name, p.position, p.year_in_school
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
                      SUM(ps.innings_pitched) as total_ip,
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

            league_era = round(pit.get("total_er", 0) * 9 / total_ip, 2) if total_ip > 0 else 0
            league_whip = round((pit.get("total_bb", 0) + pit.get("total_h", 0)) / total_ip, 2) if total_ip > 0 else 0

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
            WHERE gb.player_id = %s AND g.season = 2026
            ORDER BY g.game_date
        """, (player_id,))
        matched = [dict(r) for r in cur.fetchall()]

        # Unmatched rows on this team that might be this player
        cur.execute("""
            SELECT gb.player_name, gb.position, g.game_date, g.home_team_name, g.away_team_name
            FROM game_batting gb
            JOIN games g ON g.id = gb.game_id
            WHERE gb.player_id IS NULL
              AND gb.team_id = %s
              AND g.season = 2026
              AND (
                LOWER(gb.player_name) LIKE %s
                OR LOWER(gb.player_name) LIKE %s
              )
            ORDER BY g.game_date
        """, (team_id, f"%{player['last_name'].lower()}%", f"%{player['first_name'].lower()}%"))
        unmatched_maybe = [dict(r) for r in cur.fetchall()]

        # Also show ALL distinct player names for this team that are unmatched
        cur.execute("""
            SELECT gb.player_name, COUNT(*) as rows
            FROM game_batting gb
            JOIN games g ON g.id = gb.game_id
            WHERE gb.player_id IS NULL
              AND gb.team_id = %s
              AND g.season = 2026
            GROUP BY gb.player_name
            ORDER BY rows DESC
        """, (team_id,))
        all_unmatched_names = [dict(r) for r in cur.fetchall()]

        # How many total games does this team have?
        cur.execute("""
            SELECT COUNT(*) as cnt FROM games
            WHERE season = 2026 AND (home_team_id = %s OR away_team_id = %s)
        """, (team_id, team_id))
        team_games = cur.fetchone()["cnt"]

        # How many of those games have ANY game_batting data?
        cur.execute("""
            SELECT COUNT(DISTINCT g.id) as cnt
            FROM games g
            JOIN game_batting gb ON gb.game_id = g.id
            WHERE g.season = 2026 AND (g.home_team_id = %s OR g.away_team_id = %s)
        """, (team_id, team_id))
        games_with_batting = cur.fetchone()["cnt"]

        # Distinct game dates with batting data for this team
        cur.execute("""
            SELECT COUNT(DISTINCT (g.game_date, COALESCE(g.game_number, 1))) as cnt
            FROM games g
            JOIN game_batting gb ON gb.game_id = g.id
            WHERE g.season = 2026 AND (g.home_team_id = %s OR g.away_team_id = %s)
        """, (team_id, team_id))
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
            WHERE g.season = 2026
              AND (g.home_team_id = %s OR g.away_team_id = %s)
            ORDER BY g.game_date, g.game_number
        """, (player_id, team_id,
              f"%{player['last_name'].lower()}%", f"%{player['first_name'].lower()}%",
              team_id, team_id, team_id))
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
            WHERE g.season = 2026
              AND (g.home_team_id = %s OR g.away_team_id = %s)
            ORDER BY g.game_date, g.game_number
        """, (team_id, team_id))
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
def get_park_factors(
    state: Optional[str] = Query(None),
    division_id: Optional[int] = Query(None),
    conference_id: Optional[int] = Query(None),
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
            cur.execute(
                """SELECT COUNT(*) as num_pitchers,
                          SUM(innings_pitched) as total_ip,
                          SUM(strikeouts) as total_k,
                          SUM(wins) as total_w,
                          SUM(losses) as total_l,
                          SUM(saves) as total_sv,
                          SUM(pitching_war) as total_pwar,
                          SUM(CASE WHEN innings_pitched >= 10 AND fip IS NOT NULL
                                   THEN fip * innings_pitched ELSE 0 END) as weighted_fip,
                          SUM(CASE WHEN innings_pitched >= 10 AND fip IS NOT NULL
                                   THEN innings_pitched ELSE 0 END) as qualified_ip
                   FROM pitching_stats WHERE team_id = %s AND season = %s""",
                (team_id, yr),
            )
            pit_agg = cur.fetchone()

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
                      SUM(ps.innings_pitched) as career_ip,
                      SUM(ps.strikeouts) as career_k,
                      SUM(ps.wins) as career_w,
                      SUM(ps.losses) as career_l,
                      SUM(ps.saves) as career_sv,
                      SUM(ps.earned_runs) as career_er,
                      SUM(ps.walks) as career_bb,
                      SUM(ps.hits_allowed) as career_ha,
                      SUM(ps.pitching_war) as career_pwar,
                      CASE WHEN SUM(ps.innings_pitched) > 0
                           THEN ROUND((9.0 * SUM(ps.earned_runs)::numeric / SUM(ps.innings_pitched))::numeric, 2)
                           ELSE NULL END as career_era,
                      CASE WHEN SUM(ps.innings_pitched) > 0
                           THEN ROUND(((SUM(ps.walks) + SUM(ps.hits_allowed))::numeric / SUM(ps.innings_pitched))::numeric, 2)
                           ELSE NULL END as career_whip
               FROM pitching_stats ps
               JOIN players p ON ps.player_id = p.id
               WHERE ps.team_id = %s
               GROUP BY p.id
               HAVING SUM(ps.innings_pitched) >= 20
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
    season: int = 2026,
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
                                "season": 2026,
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
            season_val = games[0]["season"] if games else 2026
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
    season: int = Query(2026),
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
    season: int = Query(2026),
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
def weekly_top_performers(
    week_start: str = Query(..., description="Monday start date (YYYY-MM-DD)"),
    season: int = Query(2026),
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
            JOIN teams t ON gb.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN players p ON gb.player_id = p.id
            WHERE gb.game_id IN ({placeholders})
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
            JOIN teams t ON gp.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN players p ON gp.player_id = p.id
            WHERE gp.game_id IN ({placeholders})
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
    season: int = Query(2026),
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
def series_recap(
    week_start: str = Query(..., description="Tuesday start date (YYYY-MM-DD)"),
    season: int = Query(2026),
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
def daily_recap(
    date: str = Query(..., description="Date in YYYY-MM-DD format"),
    home_team_id: int = Query(...),
    away_team_id: int = Query(...),
    season: int = Query(2026),
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
            JOIN teams t ON gb.team_id = t.id
            LEFT JOIN players p ON gb.player_id = p.id
            WHERE gb.game_id IN ({placeholders})
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
            JOIN teams t ON gp.team_id = t.id
            LEFT JOIN players p ON gp.player_id = p.id
            WHERE gp.game_id IN ({placeholders})
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
    season: int = Query(2026),
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
    season: int = Query(2026),
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
    season: int = Query(2026),
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
                    ROUND((SUM(fip * innings_pitched)
                             FILTER (WHERE fip IS NOT NULL AND innings_pitched >= 3)
                           / NULLIF(SUM(innings_pitched)
                             FILTER (WHERE fip IS NOT NULL AND innings_pitched >= 3), 0))::numeric, 2) AS avg_fip,
                    ROUND(SUM(COALESCE(strikeouts, 0))::numeric
                          / NULLIF(SUM(COALESCE(batters_faced, 0)), 0), 3) AS avg_k_pct,
                    ROUND(SUM(COALESCE(walks, 0))::numeric
                          / NULLIF(SUM(COALESCE(batters_faced, 0)), 0), 3) AS avg_bb_pct,
                    CASE WHEN SUM(COALESCE(innings_pitched, 0)) > 0
                         THEN ROUND((SUM(COALESCE(earned_runs, 0)) * 9.0
                                     / SUM(COALESCE(innings_pitched, 0)))::numeric, 2)
                         ELSE 0 END AS team_era,
                    CASE WHEN SUM(COALESCE(innings_pitched, 0)) > 0
                         THEN ROUND(((SUM(COALESCE(walks, 0))
                                      + SUM(COALESCE(hits_allowed, 0)))::numeric
                                     / SUM(COALESCE(innings_pitched, 0)))::numeric, 2)
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

    # Build a team info lookup for logos/names
    team_info = {}
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT id, short_name, logo_url FROM teams WHERE is_active = 1")
            for row in cur.fetchall():
                team_info[row["id"]] = {"short_name": row["short_name"], "logo_url": row["logo_url"]}
    except Exception:
        pass

    # Enrich games with team logos and names from DB
    enriched = []
    for g in games[:limit]:
        home_id = g.get("home_team_id")
        away_id = g.get("away_team_id")
        enriched.append({
            **g,
            "home_logo": team_info.get(home_id, {}).get("logo_url") if home_id else None,
            "away_logo": team_info.get(away_id, {}).get("logo_url") if away_id else None,
            "home_short": team_info.get(home_id, {}).get("short_name", g.get("home_team", "")),
            "away_short": team_info.get(away_id, {}).get("short_name", g.get("away_team", "")),
            "status": "scheduled",
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
    season: int = 2026,
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
def quality_starts_leaderboard(
    season: int = 2026,
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
            GROUP BY gp.player_id, p.first_name, p.last_name, gp.player_name,
                     t.short_name, t.logo_url, d.level
            HAVING COUNT(*) FILTER (WHERE gp.is_starter = TRUE) >= 3
            ORDER BY quality_starts DESC, avg_game_score DESC
            LIMIT %s
        """, (season, limit))

        return [dict(r) for r in cur.fetchall()]


@router.get("/games/game-scores")
def game_score_leaderboard(
    season: int = 2026,
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
    season: int = 2026,
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


# ── Player Game Logs ──────────────────────────────────────────────────

@router.get("/players/{player_id}/gamelogs")
def get_player_gamelogs(
    player_id: int,
    season: int = Query(2026),
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
                "is_quality_start": r["is_quality_start"],
            })

        return {
            "batting": batting_logs,
            "pitching": pitching_logs,
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


# ============================================================
# Pitch-Level Stats — derived from game_events (Phase 1 PBP)
# ============================================================

# Per-division per-filter league baselines for color coding.
# Cache keyed by (season, division_level) → {filter_key: {metric: value}}.
# TTL = 6 hours; refreshed on first request after expiry.
import time as _pl_time
_PITCH_LEVEL_BASELINES_CACHE: dict = {}
_PITCH_LEVEL_BASELINES_TTL = 6 * 3600  # seconds


def _compute_pitch_level_deciles(cur, season: int, division_level: str, filter_sql: str, weights, league_woba=None):
    """For each metric, return the 9 decile thresholds (10th-90th
    percentile) across all qualifying players in the division for the
    given filter. Used to bucket each cell into a 10-shade color
    gradient on the frontend.

    A player must have >= 5 PAs in the filter to be included in the
    distribution — keeps tiny samples from skewing the deciles.
    """
    cur.execute(f"""
        WITH per_player AS (
            SELECT
                ge.batter_player_id AS pid,
                COUNT(*) AS pa,
                COALESCE(SUM(pitches_thrown), 0) AS pitches,
                SUM(CASE WHEN result_type IN ('walk','intentional_walk','hbp','sac_bunt') THEN 0 ELSE 1 END) AS ab,
                SUM(CASE WHEN result_type IN ('single','double','triple','home_run') THEN 1 ELSE 0 END) AS h,
                SUM(CASE WHEN result_type = 'double' THEN 1 ELSE 0 END) AS d2,
                SUM(CASE WHEN result_type = 'triple' THEN 1 ELSE 0 END) AS d3,
                SUM(CASE WHEN result_type = 'home_run' THEN 1 ELSE 0 END) AS hr,
                SUM(CASE WHEN result_type = 'walk' THEN 1 ELSE 0 END) AS ubb,
                SUM(CASE WHEN result_type IN ('walk','intentional_walk') THEN 1 ELSE 0 END) AS bb,
                SUM(CASE WHEN result_type = 'hbp' THEN 1 ELSE 0 END) AS hbp,
                SUM(CASE WHEN result_type IN ('strikeout_swinging','strikeout_looking') THEN 1 ELSE 0 END) AS k,
                SUM(CASE WHEN result_type = 'sac_fly' THEN 1 ELSE 0 END) AS sf,
                COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))), 0) AS f_k,
                COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS f_f,
                COALESCE(SUM(CASE WHEN was_in_play AND pitches_thrown IS NOT NULL THEN 1 ELSE 0 END), 0) AS f_in_play,
                COALESCE(SUM(CASE WHEN LEFT(pitch_sequence, 1) IN ('K', 'F') THEN 1
                                  WHEN pitch_sequence = '' AND was_in_play THEN 1
                                  ELSE 0 END), 0) AS f1_swings,
                COALESCE(SUM(CASE WHEN LEFT(pitch_sequence, 1) IN ('K', 'S', 'F') THEN 1
                                  WHEN pitch_sequence = '' AND was_in_play THEN 1
                                  ELSE 0 END), 0) AS f1_strikes,
                COALESCE(SUM(CASE WHEN pitch_sequence = '' AND was_in_play THEN 1
                                  ELSE 0 END), 0) AS f1_in_play,
                COALESCE(SUM(CASE WHEN strikes_before = 2 THEN 1 ELSE 0 END), 0) AS two_strike_pa,
                COALESCE(SUM(CASE WHEN strikes_before = 2 AND result_type IN
                    ('strikeout_swinging','strikeout_looking') THEN 1 ELSE 0 END), 0) AS two_strike_k,
                COUNT(*) FILTER (WHERE bb_type = 'GB') AS gb_n,
                COUNT(*) FILTER (WHERE bb_type = 'FB') AS fb_n,
                COUNT(*) FILTER (WHERE bb_type = 'LD') AS ld_n,
                COUNT(*) FILTER (WHERE bb_type = 'PU') AS pu_n,
                COUNT(*) FILTER (WHERE bb_type IS NOT NULL) AS bb_total,
                COUNT(*) FILTER (
                    WHERE bb_type IN ('LD','FB')
                      AND ((UPPER(p.bats) = 'R' AND field_zone = 'LEFT')
                        OR (UPPER(p.bats) = 'L' AND field_zone = 'RIGHT'))
                ) AS air_pull_n,
                COUNT(*) FILTER (
                    WHERE bb_type IS NOT NULL
                      AND UPPER(p.bats) IN ('L','R')
                ) AS air_denom_n
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            JOIN players p ON p.id = ge.batter_player_id
            JOIN teams t ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE g.season = %s AND d.level = %s
              AND ge.batter_player_id IS NOT NULL
              AND {filter_sql}
            GROUP BY ge.batter_player_id
            HAVING COUNT(*) >= 5
        )
        SELECT * FROM per_player
    """, [season, division_level])
    rows = cur.fetchall()
    if not rows:
        return {}

    metrics = {k: [] for k in (
        'ba','obp','slg','ops','iso','woba','wrc_plus','k_pct','bb_pct',
        'swing_pct','contact_pct','whiff_pct',
        'first_pitch_swing_pct','first_pitch_strike_pct','first_pitch_in_play_pct',
        'putaway_pct','pitches_per_pa',
        'gb_pct','fb_pct','ld_pct','pu_pct','air_pull_pct',
    )}
    for r in rows:
        ab = r["ab"] or 0; h = r["h"] or 0
        d2 = r["d2"] or 0; d3 = r["d3"] or 0; hr = r["hr"] or 0
        ubb = r["ubb"] or 0; bb = r["bb"] or 0
        hbp = r["hbp"] or 0; sf = r["sf"] or 0; k = r["k"] or 0
        pa = r["pa"] or 0; pitches = r["pitches"] or 0
        f_k = r["f_k"] or 0; f_f = r["f_f"] or 0; f_in_play = r["f_in_play"] or 0
        singles = h - d2 - d3 - hr
        tb = singles + 2*d2 + 3*d3 + 4*hr
        obp_denom = ab + bb + hbp + sf
        if ab > 0:
            metrics["ba"].append(h / ab)
            metrics["slg"].append(tb / ab)
            metrics["iso"].append((tb - h) / ab)
        if obp_denom > 0:
            obp_v = (h + bb + hbp) / obp_denom
            metrics["obp"].append(obp_v)
            if ab > 0:
                metrics["ops"].append(obp_v + tb / ab)
        woba_denom = ab + ubb + sf + hbp
        if woba_denom > 0:
            woba_v = (weights.w_bb * ubb + weights.w_hbp * hbp +
                      weights.w_1b * singles + weights.w_2b * d2 +
                      weights.w_3b * d3 + weights.w_hr * hr) / woba_denom
            metrics["woba"].append(woba_v)
            if league_woba is not None and weights.woba_scale > 0 and weights.runs_per_pa > 0:
                wrc = ((woba_v - league_woba) / weights.woba_scale + weights.runs_per_pa) / weights.runs_per_pa * 100
                metrics["wrc_plus"].append(wrc)
        if pa > 0:
            metrics["k_pct"].append(k / pa)
            metrics["bb_pct"].append(bb / pa)
            metrics["first_pitch_swing_pct"].append((r["f1_swings"] or 0) / pa)
            metrics["first_pitch_strike_pct"].append((r["f1_strikes"] or 0) / pa)
            metrics["first_pitch_in_play_pct"].append((r["f1_in_play"] or 0) / pa)
        if pitches > 0:
            metrics["pitches_per_pa"].append(pitches / pa)
        swings = f_k + f_f + f_in_play
        if pitches > 0:
            metrics["swing_pct"].append(swings / pitches)
        if swings > 0:
            metrics["contact_pct"].append((f_f + f_in_play) / swings)
            metrics["whiff_pct"].append(f_k / swings)
        ts_pa = r["two_strike_pa"] or 0
        if ts_pa >= 5:
            metrics["putaway_pct"].append((r["two_strike_k"] or 0) / ts_pa)
        bb_total = r["bb_total"] or 0
        if bb_total >= 5:
            metrics["gb_pct"].append((r["gb_n"] or 0) / bb_total)
            metrics["fb_pct"].append((r["fb_n"] or 0) / bb_total)
            metrics["ld_pct"].append((r["ld_n"] or 0) / bb_total)
            metrics["pu_pct"].append((r["pu_n"] or 0) / bb_total)
        air_denom = r["air_denom_n"] or 0
        if air_denom >= 5:
            metrics["air_pull_pct"].append((r["air_pull_n"] or 0) / air_denom)

    # 9 decile thresholds (10th, 20th, ..., 90th) per metric.
    out = {}
    deciles = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
    for m, vals in metrics.items():
        if not vals:
            out[m] = None
            continue
        vals_sorted = sorted(vals)
        out[m] = [_quantile(vals_sorted, q) for q in deciles]
    return out


def _quantile(sorted_vals, q):
    """Linear interpolation quantile (matches numpy default)."""
    if not sorted_vals:
        return None
    n = len(sorted_vals)
    if n == 1:
        return sorted_vals[0]
    pos = q * (n - 1)
    lo = int(pos)
    hi = min(lo + 1, n - 1)
    frac = pos - lo
    return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac


def _compute_pitch_level_baseline(cur, season: int, division_level: str, filter_sql: str, weights):
    """Aggregate league-wide stats over all PNW players in the division
    matching the given filter. Returns a dict matching the player-row
    metric keys so the frontend can compare apples-to-apples.
    """
    cur.execute(f"""
        SELECT
            COUNT(*) AS pa,
            COUNT(*) FILTER (WHERE pitches_thrown IS NOT NULL) AS tracked_pa,
            COALESCE(SUM(pitches_thrown), 0) AS pitches,
            SUM(CASE WHEN result_type IN ('walk','intentional_walk','hbp','sac_bunt') THEN 0 ELSE 1 END) AS ab,
            SUM(CASE WHEN result_type IN ('single','double','triple','home_run') THEN 1 ELSE 0 END) AS h,
            SUM(CASE WHEN result_type = 'double' THEN 1 ELSE 0 END) AS d,
            SUM(CASE WHEN result_type = 'triple' THEN 1 ELSE 0 END) AS t,
            SUM(CASE WHEN result_type = 'home_run' THEN 1 ELSE 0 END) AS hr,
            SUM(CASE WHEN result_type IN ('walk') THEN 1 ELSE 0 END) AS ubb,
            SUM(CASE WHEN result_type IN ('walk','intentional_walk') THEN 1 ELSE 0 END) AS bb,
            SUM(CASE WHEN result_type = 'hbp' THEN 1 ELSE 0 END) AS hbp,
            SUM(CASE WHEN result_type IN ('strikeout_swinging','strikeout_looking') THEN 1 ELSE 0 END) AS k,
            SUM(CASE WHEN result_type = 'sac_fly' THEN 1 ELSE 0 END) AS sf,
            SUM(CASE WHEN was_in_play THEN 1 ELSE 0 END) AS bip,
            COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))), 0) AS f_k,
            COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS f_f,
            COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS f_in_play,
            -- F1 counts: only over PAs WITH pitch tracking, otherwise
            -- the in-play branch falsely fires for events that lack a
            -- pitch sequence string (untracked PAs have empty seq).
            COUNT(*) FILTER (
                WHERE pitches_thrown IS NOT NULL AND
                      (LEFT(pitch_sequence, 1) IN ('K', 'F')
                       OR (pitch_sequence = '' AND was_in_play))
            ) AS f1_swings,
            COUNT(*) FILTER (
                WHERE pitches_thrown IS NOT NULL AND
                      (LEFT(pitch_sequence, 1) IN ('K', 'S', 'F')
                       OR (pitch_sequence = '' AND was_in_play))
            ) AS f1_strikes,
            COUNT(*) FILTER (
                WHERE pitches_thrown IS NOT NULL
                      AND pitch_sequence = '' AND was_in_play
            ) AS f1_in_play,
            COUNT(*) FILTER (WHERE strikes_before = 2) AS two_strike_pa,
            COUNT(*) FILTER (
                WHERE strikes_before = 2 AND result_type IN
                ('strikeout_swinging','strikeout_looking')
            ) AS two_strike_k,
            COUNT(*) FILTER (WHERE bb_type = 'GB') AS gb_n,
            COUNT(*) FILTER (WHERE bb_type = 'FB') AS fb_n,
            COUNT(*) FILTER (WHERE bb_type = 'LD') AS ld_n,
            COUNT(*) FILTER (WHERE bb_type = 'PU') AS pu_n,
            COUNT(*) FILTER (WHERE bb_type IS NOT NULL) AS bb_total,
            -- Air-pull: LD+FB hit to pull side. Pull = LEFT for RHB,
            -- RIGHT for LHB. Switch hitters & unknown hand excluded.
            COUNT(*) FILTER (
                WHERE bb_type IN ('LD','FB')
                  AND ((UPPER(p.bats) = 'R' AND field_zone = 'LEFT')
                    OR (UPPER(p.bats) = 'L' AND field_zone = 'RIGHT'))
            ) AS air_pull_n,
            COUNT(*) FILTER (
                WHERE bb_type IS NOT NULL
                  AND UPPER(p.bats) IN ('L','R')
            ) AS air_denom_n
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        JOIN players p ON p.id = ge.batter_player_id
        JOIN teams t ON t.id = p.team_id
        JOIN conferences c ON c.id = t.conference_id
        JOIN divisions d ON d.id = c.division_id
        WHERE g.season = %s
          AND d.level = %s
          AND ge.batter_player_id IS NOT NULL
          AND {filter_sql}
    """, [season, division_level])
    r = cur.fetchone()
    n_pa = r["pa"] or 0
    n_tracked = r["tracked_pa"] or 0
    n_pitches = r["pitches"] or 0
    ab = r["ab"] or 0; h = r["h"] or 0
    d_ = r["d"] or 0; tr = r["t"] or 0; hr = r["hr"] or 0
    ubb = r["ubb"] or 0; bb = r["bb"] or 0
    hbp = r["hbp"] or 0; sf = r["sf"] or 0; kct = r["k"] or 0
    singles = h - d_ - tr - hr
    tb = singles + 2*d_ + 3*tr + 4*hr
    obp_denom = ab + bb + hbp + sf
    ba = (h / ab) if ab > 0 else None
    obp = ((h + bb + hbp) / obp_denom) if obp_denom > 0 else None
    slg = (tb / ab) if ab > 0 else None
    ops = ((obp or 0) + (slg or 0)) if (obp is not None and slg is not None) else None
    iso = ((slg - ba) if (slg is not None and ba is not None) else None)
    woba_num = (weights.w_bb * ubb + weights.w_hbp * hbp +
                weights.w_1b * singles + weights.w_2b * d_ +
                weights.w_3b * tr + weights.w_hr * hr)
    woba_denom = ab + ubb + sf + hbp
    woba = (woba_num / woba_denom) if woba_denom > 0 else None
    swings = r["f_k"] + r["f_f"] + r["f_in_play"]
    contact = r["f_f"] + r["f_in_play"]
    bb_total = r["bb_total"] or 0
    two_strike_pa = r["two_strike_pa"] or 0
    air_denom = r["air_denom_n"] or 0
    return {
        "pa": n_pa, "tracked_pa": n_tracked, "pitches": n_pitches,
        "ba": ba, "obp": obp, "slg": slg, "ops": ops,
        "iso": iso, "woba": woba,
        "swing_pct": (swings / n_pitches) if n_pitches > 0 else None,
        "contact_pct": (contact / swings) if swings > 0 else None,
        "whiff_pct": (r["f_k"] / swings) if swings > 0 else None,
        "k_pct": (kct / n_pa) if n_pa > 0 else None,
        "bb_pct": (bb / n_pa) if n_pa > 0 else None,
        # F1 / putaway / P-PA denominators are TRACKED PAs only
        "first_pitch_swing_pct":   (r["f1_swings"]  / n_tracked) if n_tracked > 0 else None,
        "first_pitch_strike_pct":  (r["f1_strikes"] / n_tracked) if n_tracked > 0 else None,
        "first_pitch_in_play_pct": (r["f1_in_play"] / n_tracked) if n_tracked > 0 else None,
        "putaway_pct": (r["two_strike_k"] / two_strike_pa) if two_strike_pa > 0 else None,
        "pitches_per_pa": (n_pitches / n_tracked) if n_tracked > 0 else None,
        "gb_pct": (r["gb_n"] / bb_total) if bb_total > 0 else None,
        "fb_pct": (r["fb_n"] / bb_total) if bb_total > 0 else None,
        "ld_pct": (r["ld_n"] / bb_total) if bb_total > 0 else None,
        "pu_pct": (r["pu_n"] / bb_total) if bb_total > 0 else None,
        "air_pull_pct": (r["air_pull_n"] / air_denom) if air_denom > 0 else None,
    }


def _get_pitch_level_baselines(cur, season: int, division_level: str, weights) -> dict:
    """Return cached or freshly computed league baselines for every
    Pitch-Level Stats filter (count states + L/R splits).
    """
    key = (season, division_level)
    now = _pl_time.time()
    cached = _PITCH_LEVEL_BASELINES_CACHE.get(key)
    if cached and (now - cached["ts"]) < _PITCH_LEVEL_BASELINES_TTL:
        return cached["data"]

    filters = {
        # Overall — every PA. Used as the wRC+ baseline AND for the
        # discipline-tile color coding ("how does this player's overall
        # swing% compare to the division average?").
        "overall":     "TRUE",
        "hitters":     "(balls_before, strikes_before) IN ((1,0),(2,0),(3,0),(3,1))",
        "neutral":     "(balls_before, strikes_before) IN ((0,0),(1,1),(2,1),(2,2),(3,2))",
        "pitchers":    "(balls_before, strikes_before) IN ((0,1),(0,2),(1,2))",
        "two_strike":  "strikes_before = 2",
        "vs_lhp":      "ge.pitcher_player_id IN (SELECT id FROM players WHERE UPPER(throws) = 'L')",
        "vs_rhp":      "ge.pitcher_player_id IN (SELECT id FROM players WHERE UPPER(throws) = 'R')",
        # Situational (Phase A state). Match the hitter endpoint definitions.
        "bases_empty":   "bases_before = '000'",
        "runner_on":     "bases_before IS NOT NULL AND bases_before <> '000'",
        "risp":          ("bases_before IS NOT NULL AND "
                          "(SUBSTRING(bases_before, 2, 1) = '1' OR "
                          "SUBSTRING(bases_before, 3, 1) = '1')"),
        "risp_2out":     ("bases_before IS NOT NULL AND "
                          "(SUBSTRING(bases_before, 2, 1) = '1' OR "
                          "SUBSTRING(bases_before, 3, 1) = '1') AND outs_before = 2"),
        "innings_early": "inning BETWEEN 1 AND 3",
        "innings_mid":   "inning BETWEEN 4 AND 6",
        "innings_late":  "inning >= 7",
        "late_close":    ("inning >= 7 AND bat_score_before IS NOT NULL "
                          "AND ABS(bat_score_before - fld_score_before) <= 1"),
        "leadoff":       "outs_before = 0 AND bases_before = '000'",
    }
    out = {}
    for k, fsql in filters.items():
        mean = _compute_pitch_level_baseline(cur, season, division_level, fsql, weights)
        # wRC+ for the league mean is 100 by definition (the average
        # player IS the league average → wRC+ = 100).
        mean["wrc_plus"] = 100 if mean.get("woba") is not None else None
        deciles = _compute_pitch_level_deciles(
            cur, season, division_level, fsql, weights,
            league_woba=mean.get("woba"),
        )
        out[k] = {"mean": mean, "deciles": deciles}
    _PITCH_LEVEL_BASELINES_CACHE[key] = {"ts": now, "data": out}
    return out


#
# Stats menu (hitter side):
#   Plate discipline:
#     - swing %         : (K + F + in_play_contact) / total_pitches
#     - first_pitch_swing % : per PA, was 1st pitch a swing
#     - contact %       : (F + in_play_contact) / total_swings
#     - pitches per PA  : total_pitches / total_PA
#   Count states (slash lines):
#     - hitter's counts (1-0, 2-0, 3-1)
#     - pitcher's counts (0-1, 0-2, 1-2)
#     - 2-strike (any 2-strike count)
#   L/R splits: vs LHP / RHP / Unknown
#
# Pitch sequence letters: B=ball, K=swinging strike, S=called strike,
# F=foul, H=HBP. Empty pitch_sequence with was_in_play=True means the
# 0-0 first pitch was put in play — that counts as 1 swing/contact.

@router.get("/players/{player_id}/pitch-level-stats")
def get_player_pitch_level_stats(
    player_id: int,
    season: int = Query(2026, description="Season year"),
):
    """Hitter pitch-level stats from game_events.

    Returns plate discipline, count-state slash lines, and L/R splits
    each with sample sizes (PA + total pitches as relevant).
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # Resolve canonical player and gather linked IDs (handles transfers)
        cur.execute(
            "SELECT canonical_id FROM player_links WHERE linked_id = %s",
            (player_id,),
        )
        canonical = cur.fetchone()
        if canonical:
            player_id = canonical["canonical_id"]
        cur.execute(
            "SELECT linked_id FROM player_links WHERE canonical_id = %s",
            (player_id,),
        )
        linked_ids = [r["linked_id"] for r in cur.fetchall()]
        all_pids = [player_id] + linked_ids

        # ── Discipline metrics ──
        # Many source PBP feeds (e.g. some Sidearm sites) publish narrative
        # lines like "Player walked." with NO count or pitch sequence in
        # parens. Those events have pitches_thrown IS NULL — pitch-level
        # stats can't be computed for them. We compute discipline ONLY
        # over the "pitch-tracked" subset (pitches_thrown IS NOT NULL)
        # and surface both totals so the user can judge sample reliability.
        cur.execute("""
            SELECT COUNT(*) AS total_pa FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE ge.batter_player_id = ANY(%s) AND g.season = %s
        """, (all_pids, season))
        total_pa = cur.fetchone()["total_pa"] or 0

        cur.execute("""
            SELECT
                COUNT(*) AS tracked_pa,
                COALESCE(SUM(pitches_thrown), 0) AS pitches,
                COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))), 0) AS k_count,
                COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'S', ''))), 0) AS s_count,
                COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS f_count,
                COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'B', ''))), 0) AS b_count,
                COALESCE(SUM(CASE WHEN was_in_play THEN 1 ELSE 0 END), 0) AS in_play,
                COALESCE(SUM(CASE
                    WHEN LEFT(pitch_sequence, 1) IN ('K', 'F') THEN 1
                    WHEN pitch_sequence = '' AND was_in_play THEN 1
                    ELSE 0
                END), 0) AS f1_swings,
                COALESCE(SUM(CASE
                    WHEN LEFT(pitch_sequence, 1) IN ('K', 'S', 'F') THEN 1
                    WHEN pitch_sequence = '' AND was_in_play THEN 1
                    ELSE 0
                END), 0) AS f1_strikes,
                COALESCE(SUM(CASE
                    WHEN pitch_sequence = '' AND was_in_play THEN 1
                    ELSE 0
                END), 0) AS f1_in_play,
                COALESCE(SUM(CASE WHEN strikes_before = 2 THEN 1 ELSE 0 END), 0) AS two_strike_pa,
                COALESCE(SUM(CASE WHEN strikes_before = 2
                    AND result_type IN ('strikeout_swinging','strikeout_looking')
                    THEN 1 ELSE 0 END), 0) AS two_strike_k
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE ge.batter_player_id = ANY(%s)
              AND g.season = %s
              AND ge.pitches_thrown IS NOT NULL
        """, (all_pids, season))
        r = cur.fetchone()
        tracked_pa = r["tracked_pa"] or 0
        pitches = r["pitches"] or 0
        k = r["k_count"]; f = r["f_count"]; in_play = r["in_play"]
        swings = k + f + in_play
        contact = f + in_play
        whiffs = k
        two_strike_pa = r["two_strike_pa"] or 0
        two_strike_k  = r["two_strike_k"] or 0
        discipline = {
            "total_pa": total_pa,
            "tracked_pa": tracked_pa,
            "pitches": pitches,
            "swings": swings,
            "whiffs": whiffs,
            "swing_pct": (swings / pitches) if pitches > 0 else None,
            "whiff_pct": (whiffs / swings) if swings > 0 else None,
            "contact_pct": (contact / swings) if swings > 0 else None,
            "first_pitch_swing_pct":   (r["f1_swings"]   / tracked_pa) if tracked_pa > 0 else None,
            "first_pitch_strike_pct":  (r["f1_strikes"]  / tracked_pa) if tracked_pa > 0 else None,
            "first_pitch_in_play_pct": (r["f1_in_play"]  / tracked_pa) if tracked_pa > 0 else None,
            "two_strike_pa": two_strike_pa,
            # From the HITTER's perspective: lower putaway_pct is better
            # (you survive more 2-strike counts). It's the same number
            # the pitcher endpoint surfaces; we label it differently.
            "putaway_pct":   (two_strike_k / two_strike_pa) if two_strike_pa > 0 else None,
            "pitches_per_pa": (pitches / tracked_pa) if tracked_pa > 0 else None,
        }

        # ── Leverage Index (Phase D MVP) ──
        # Avg LI across every PA where state was derived. Tells us the
        # importance of moments this hitter typically faced. ~1.0 is
        # average; > 1.5 means high-leverage at-bats; < 0.7 means low-
        # leverage spots.
        cur.execute("""
            SELECT inning, half, bat_score_before, fld_score_before,
                   bases_before, outs_before
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE ge.batter_player_id = ANY(%s)
              AND g.season = %s
              AND ge.bases_before IS NOT NULL
        """, (all_pids, season))
        li_rows = cur.fetchall()
        if li_rows:
            li_values = [
                compute_li(
                    r["inning"], r["half"],
                    (r["bat_score_before"] or 0) - (r["fld_score_before"] or 0),
                    r["bases_before"], r["outs_before"]
                ) for r in li_rows
            ]
            discipline["avg_li"] = sum(li_values) / len(li_values)
            discipline["li_pa"] = len(li_values)
            discipline["max_li"] = max(li_values)
        else:
            discipline["avg_li"] = None
            discipline["li_pa"] = 0
            discipline["max_li"] = None

        # ── WPA (Phase D.5) ──
        # Total Win Probability Added across every PA. Positive = the
        # hitter contributed wins, negative = lost wins for his team.
        # Computed in scripts/compute_wpa.py from an empirical WP table
        # built from 2026 PBP. Also surface peak WPA (the most clutch
        # single PA — usually a walk-off or lead-changing late hit).
        cur.execute("""
            SELECT
                SUM(ge.wpa_batter)            AS total_wpa,
                COUNT(ge.wpa_batter)          AS wpa_pa,
                MAX(ge.wpa_batter)            AS peak_wpa,
                AVG(ABS(ge.wpa_batter))       AS mean_abs_wpa
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE ge.batter_player_id = ANY(%s)
              AND g.season = %s
              AND ge.wpa_batter IS NOT NULL
        """, (all_pids, season))
        wr = cur.fetchone()
        if wr and wr["wpa_pa"]:
            discipline["total_wpa"]    = float(wr["total_wpa"])
            discipline["wpa_pa"]       = int(wr["wpa_pa"])
            discipline["peak_wpa"]     = float(wr["peak_wpa"])
            discipline["mean_abs_wpa"] = float(wr["mean_abs_wpa"])
        else:
            discipline["total_wpa"]    = None
            discipline["wpa_pa"]       = 0
            discipline["peak_wpa"]     = None
            discipline["mean_abs_wpa"] = None

        # ── Phase E: Contact profile (bb_type) + spray (Pull/Center/Oppo) ──
        # Counts of GB/FB/LD/PU and field zones derived from the
        # narrative. Spray Pull/Center/Oppo is derived from field_zone +
        # players.bats — switch hitters return None (would need pitcher
        # hand to disambiguate).
        cur.execute(
            "SELECT bats FROM players WHERE id = %s",
            (player_id,),
        )
        bats_row = cur.fetchone()
        bats = bats_row["bats"] if bats_row else None

        cur.execute("""
            SELECT bb_type, field_zone, COUNT(*) AS c
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE ge.batter_player_id = ANY(%s)
              AND g.season = %s
              AND (bb_type IS NOT NULL OR field_zone IS NOT NULL)
            GROUP BY bb_type, field_zone
        """, (all_pids, season))
        bb_counts = {"GB": 0, "FB": 0, "LD": 0, "PU": 0}
        zone_counts = {"LEFT": 0, "CENTER": 0, "RIGHT": 0}
        spray_counts = {"Pull": 0, "Center": 0, "Oppo": 0}
        bb_total = 0
        zone_total = 0
        air_pull = 0  # numerator: LD+FB pulled
        for r in cur.fetchall():
            n = r["c"]
            if r["bb_type"]:
                bb_counts[r["bb_type"]] = bb_counts.get(r["bb_type"], 0) + n
                bb_total += n
            if r["field_zone"]:
                zone_counts[r["field_zone"]] = zone_counts.get(r["field_zone"], 0) + n
                zone_total += n
                spray = _spray_for(r["field_zone"], bats)
                if spray:
                    spray_counts[spray] = spray_counts.get(spray, 0) + n
                # AIRPULL%: LD or FB to pull side, as fraction of ALL
                # batted balls (FanGraphs / Statcast convention).
                if r["bb_type"] in ("LD", "FB") and spray == "Pull":
                    air_pull += n
        # Denominator for AIRPULL% is total BIP for hitters with known
        # handedness — switch hitters & unknown bats excluded from
        # numerator; we reflect that in the denominator only when we
        # have a usable handedness on the player.
        air_denom = bb_total if bats and bats.upper() in ("L", "R") else 0
        spray_total = sum(spray_counts.values())

        # ── Phase F: zoned spray chart breakdown ──
        # Returns counts (NOT percentages — the frontend computes those
        # so it can re-normalize when filtering). One bucket per filter:
        #   all       — every BIP
        #   vs_lhp    — BIP vs left-handed pitchers
        #   vs_rhp    — BIP vs right-handed pitchers
        #   xbh       — extra-base hits only (2B/3B/HR)
        #   hr        — home runs only
        # Plus hr_by_outfield (LF/CF/RF totals — for fence badges).
        FINE_ZONES = ["LF", "LC", "CF", "RC", "RF",
                      "IF_3B", "IF_SS", "IF_MID", "IF_1B", "IF_C"]
        cur.execute("""
            SELECT field_zone_fine,
                   CASE
                     WHEN UPPER(p.throws) = 'L' THEN 'LHP'
                     WHEN UPPER(p.throws) = 'R' THEN 'RHP'
                     ELSE 'UNK'
                   END AS pitcher_hand,
                   result_type,
                   COUNT(*) AS c
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            LEFT JOIN players p ON p.id = ge.pitcher_player_id
            WHERE ge.batter_player_id = ANY(%s)
              AND g.season = %s
              AND ge.field_zone_fine IS NOT NULL
            GROUP BY field_zone_fine, pitcher_hand, result_type
        """, (all_pids, season))
        spray_chart = {
            "all":    {z: 0 for z in FINE_ZONES},
            "vs_lhp": {z: 0 for z in FINE_ZONES},
            "vs_rhp": {z: 0 for z in FINE_ZONES},
            "xbh":    {z: 0 for z in FINE_ZONES},
            "hr":     {z: 0 for z in FINE_ZONES},
        }
        XBH_TYPES = {"double", "triple", "home_run"}
        for r in cur.fetchall():
            z = r["field_zone_fine"]
            n = r["c"]
            rt = r["result_type"]
            spray_chart["all"][z] += n
            if r["pitcher_hand"] == "LHP":
                spray_chart["vs_lhp"][z] += n
            elif r["pitcher_hand"] == "RHP":
                spray_chart["vs_rhp"][z] += n
            if rt in XBH_TYPES:
                spray_chart["xbh"][z] += n
            if rt == "home_run":
                spray_chart["hr"][z] += n
        for k in ("all", "vs_lhp", "vs_rhp", "xbh", "hr"):
            spray_chart[f"{k}_total"] = sum(spray_chart[k].values())
        contact_profile = {
            "bb_total": bb_total,
            "zone_total": zone_total,
            "spray_total": spray_total,
            "bats": bats,
            "gb_pct": (bb_counts["GB"] / bb_total) if bb_total > 0 else None,
            "fb_pct": (bb_counts["FB"] / bb_total) if bb_total > 0 else None,
            "ld_pct": (bb_counts["LD"] / bb_total) if bb_total > 0 else None,
            "pu_pct": (bb_counts["PU"] / bb_total) if bb_total > 0 else None,
            "gb_count": bb_counts["GB"],
            "fb_count": bb_counts["FB"],
            "ld_count": bb_counts["LD"],
            "pu_count": bb_counts["PU"],
            "pull_pct":   (spray_counts["Pull"]   / spray_total) if spray_total > 0 else None,
            "center_pct": (spray_counts["Center"] / spray_total) if spray_total > 0 else None,
            "oppo_pct":   (spray_counts["Oppo"]   / spray_total) if spray_total > 0 else None,
            "air_pull_pct": (air_pull / air_denom) if air_denom > 0 else None,
            "air_pull_count": air_pull,
            "air_denom": air_denom,
        }

        # ── Pull division-specific weights for wOBA ──
        # Player's division comes from their team → conference → division.
        # Defaults to D1 weights if we can't resolve.
        cur.execute("""
            SELECT d.level
            FROM players p
            JOIN teams t ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE p.id = %s
        """, (player_id,))
        div_row = cur.fetchone()
        division_level = (div_row["level"] if div_row else "D1") or "D1"
        weights = DEFAULT_WEIGHTS.get(division_level, DEFAULT_WEIGHTS["D1"])

        # ── Count-state / split slash lines ──
        # Returns slash + sample sizes + plate-discipline within the
        # filter. The `pitches` and discipline counts are NULL-summed
        # so PAs without pitch data still count toward `pa` but don't
        # inflate pitch-derived numbers.
        def _slash(filter_sql, filter_params):
            cur.execute(f"""
                SELECT
                    COUNT(*) AS pa,
                    COALESCE(SUM(pitches_thrown), 0) AS pitches,
                    SUM(CASE WHEN result_type IN ('walk','intentional_walk','hbp','sac_bunt') THEN 0 ELSE 1 END) AS ab,
                    SUM(CASE WHEN result_type IN ('single','double','triple','home_run') THEN 1 ELSE 0 END) AS h,
                    SUM(CASE WHEN result_type = 'double' THEN 1 ELSE 0 END) AS d,
                    SUM(CASE WHEN result_type = 'triple' THEN 1 ELSE 0 END) AS t,
                    SUM(CASE WHEN result_type = 'home_run' THEN 1 ELSE 0 END) AS hr,
                    SUM(CASE WHEN result_type IN ('walk') THEN 1 ELSE 0 END) AS ubb,
                    SUM(CASE WHEN result_type IN ('walk','intentional_walk') THEN 1 ELSE 0 END) AS bb,
                    SUM(CASE WHEN result_type = 'hbp' THEN 1 ELSE 0 END) AS hbp,
                    SUM(CASE WHEN result_type IN ('strikeout_swinging','strikeout_looking') THEN 1 ELSE 0 END) AS k,
                    SUM(CASE WHEN result_type = 'sac_fly' THEN 1 ELSE 0 END) AS sf,
                    SUM(CASE WHEN was_in_play THEN 1 ELSE 0 END) AS bip,
                    -- Plate discipline counts within this filter (NULL-summed for tracked PAs only)
                    COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))), 0) AS f_k,
                    COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS f_f,
                    COALESCE(SUM(CASE WHEN was_in_play AND pitches_thrown IS NOT NULL THEN 1 ELSE 0 END), 0) AS f_in_play
                FROM game_events ge
                JOIN games g ON g.id = ge.game_id
                WHERE ge.batter_player_id = ANY(%s)
                  AND g.season = %s
                  AND {filter_sql}
            """, [all_pids, season] + filter_params)
            row = cur.fetchone()
            n_pa = row["pa"] or 0
            n_pitches = row["pitches"] or 0
            ab = row["ab"] or 0
            h = row["h"] or 0
            d = row["d"] or 0
            tr = row["t"] or 0
            hr = row["hr"] or 0
            ubb = row["ubb"] or 0
            bb = row["bb"] or 0
            hbp = row["hbp"] or 0
            sf = row["sf"] or 0
            kct = row["k"] or 0
            bip = row["bip"] or 0
            singles = h - d - tr - hr
            tb = singles + 2*d + 3*tr + 4*hr
            obp_denom = ab + bb + hbp + sf
            ba = (h / ab) if ab > 0 else None
            obp = ((h + bb + hbp) / obp_denom) if obp_denom > 0 else None
            slg = (tb / ab) if ab > 0 else None
            ops = ((obp or 0) + (slg or 0)) if (obp is not None and slg is not None) else None
            iso = ((slg - ba) if (slg is not None and ba is not None) else None)
            # wOBA = (w_bb*uBB + w_hbp*HBP + w_1b*1B + w_2b*2B + w_3b*3B + w_hr*HR) / (AB + BB - IBB + SF + HBP)
            # Using uBB (walks excl. intentional) per Fangraphs convention.
            woba_num = (weights.w_bb * ubb + weights.w_hbp * hbp +
                        weights.w_1b * singles + weights.w_2b * d +
                        weights.w_3b * tr + weights.w_hr * hr)
            woba_denom = ab + ubb + sf + hbp
            woba = (woba_num / woba_denom) if woba_denom > 0 else None
            # Plate discipline within filter (over pitch-tracked subset)
            swings = row["f_k"] + row["f_f"] + row["f_in_play"]
            contact = row["f_f"] + row["f_in_play"]
            swing_pct = (swings / n_pitches) if n_pitches > 0 else None
            contact_pct = (contact / swings) if swings > 0 else None
            whiff_pct = (row["f_k"] / swings) if swings > 0 else None
            return {
                "pa": n_pa, "pitches": n_pitches, "bip": bip,
                "ab": ab, "h": h, "hr": hr, "bb": bb, "k": kct,
                "ba": ba, "obp": obp, "slg": slg, "ops": ops,
                "iso": iso, "woba": woba,
                "swing_pct": swing_pct, "contact_pct": contact_pct, "whiff_pct": whiff_pct,
                "k_pct": (kct / n_pa) if n_pa > 0 else None,
                "bb_pct": (bb / n_pa) if n_pa > 0 else None,
                # wRC+ filled in below once we have the league baseline for this filter
                "wrc_plus": None,
            }

        # Define count groups per common baseball convention.
        # Hitters / Neutral / Pitchers form a complete partition of
        # all valid pre-PA counts (every PA falls into exactly one).
        # 2-strike is a cross-cutting analytical lens that overlaps
        # with Pitchers (0-2, 1-2) and Neutral (2-2, 3-2).
        hitters_counts = "(balls_before, strikes_before) IN ((1,0),(2,0),(3,0),(3,1))"
        pitchers_counts = "(balls_before, strikes_before) IN ((0,1),(0,2),(1,2))"
        neutral_counts = "(balls_before, strikes_before) IN ((0,0),(1,1),(2,1),(2,2),(3,2))"
        two_strike = "strikes_before = 2"
        count_states = [
            {"label": "Hitter's counts", "detail": "1-0, 2-0, 3-0, 3-1",
             "filter_key": "hitters", **_slash(hitters_counts, [])},
            {"label": "Neutral counts", "detail": "0-0, 1-1, 2-1, 2-2, 3-2",
             "filter_key": "neutral", **_slash(neutral_counts, [])},
            {"label": "Pitcher's counts", "detail": "0-1, 0-2, 1-2",
             "filter_key": "pitchers", **_slash(pitchers_counts, [])},
            {"label": "2-strike", "detail": "any 2-strike count",
             "filter_key": "two_strike", **_slash(two_strike, [])},
        ]

        # ── L/R splits (vs LHP, RHP, Unknown) ──
        # Use pitcher_player_id → players.throws to classify
        def _split(throws_filter):
            return _slash(
                f"ge.pitcher_player_id IN (SELECT id FROM players WHERE {throws_filter})",
                []
            )
        def _split_unknown():
            # Unknown = pitcher_player_id IS NULL OR pitcher's throws is null
            return _slash(
                "(ge.pitcher_player_id IS NULL OR ge.pitcher_player_id IN "
                "(SELECT id FROM players WHERE throws IS NULL))",
                []
            )
        lr_splits = [
            {"label": "vs LHP",     "filter_key": "vs_lhp",     **_split("UPPER(throws) = 'L'")},
            {"label": "vs RHP",     "filter_key": "vs_rhp",     **_split("UPPER(throws) = 'R'")},
            {"label": "vs Unknown", "filter_key": None,         **_split_unknown()},
        ]

        # ── Situational splits — uses base/out/score state from Phase A ──
        # All filters guard with `bases_before IS NOT NULL` so PAs from
        # not-yet-state-derived games (or pre-Phase-A backfill) are
        # excluded rather than miscounted.
        bases_empty   = "bases_before = '000'"
        runner_on     = "bases_before IS NOT NULL AND bases_before <> '000'"
        # RISP = 2B or 3B occupied (char 2 or char 3 of '100' format = '1')
        risp          = ("bases_before IS NOT NULL AND "
                         "(SUBSTRING(bases_before, 2, 1) = '1' OR "
                         "SUBSTRING(bases_before, 3, 1) = '1')")
        risp_2out     = f"({risp}) AND outs_before = 2"
        innings_early = "inning BETWEEN 1 AND 3"
        innings_mid   = "inning BETWEEN 4 AND 6"
        innings_late  = "inning >= 7"
        late_close    = ("inning >= 7 AND bat_score_before IS NOT NULL "
                         "AND ABS(bat_score_before - fld_score_before) <= 1")
        leadoff       = "outs_before = 0 AND bases_before = '000'"
        situational_splits = [
            {"label": "Bases empty",   "detail": "no runners on",        "filter_key": "bases_empty",   **_slash(bases_empty,   [])},
            {"label": "Runner(s) on",  "detail": "any base occupied",    "filter_key": "runner_on",     **_slash(runner_on,     [])},
            {"label": "RISP",          "detail": "2B or 3B occupied",    "filter_key": "risp",          **_slash(risp,          [])},
            {"label": "RISP / 2 out",  "detail": "RISP w/ 2 outs",       "filter_key": "risp_2out",     **_slash(risp_2out,     [])},
            {"label": "Innings 1-3",   "detail": "early",                "filter_key": "innings_early", **_slash(innings_early, [])},
            {"label": "Innings 4-6",   "detail": "middle",               "filter_key": "innings_mid",   **_slash(innings_mid,   [])},
            {"label": "Innings 7+",    "detail": "late",                 "filter_key": "innings_late",  **_slash(innings_late,  [])},
            {"label": "Late & close",  "detail": "7+ inn, score ±1",     "filter_key": "late_close",    **_slash(late_close,    [])},
            {"label": "Leadoff PA",    "detail": "first PA of inning",   "filter_key": "leadoff",       **_slash(leadoff,       [])},
        ]

        # ── Attach league baselines + deciles for color coding ──
        # Per-division per-filter league averages (for tooltips) and
        # decile thresholds (for Savant-style 10-shade gradient).
        # wRC+ is keyed off the OVERALL season league wOBA (not the per-
        # filter wOBA) so situational wRC+ swings around 100 meaningfully:
        # a player who performs at his normal .330 wOBA in pitcher counts
        # (where league avg is .220) lights up at wRC+ ~140, not 100.
        baselines = _get_pitch_level_baselines(cur, season, division_level, weights)
        overall_entry = baselines.get("overall") or {}
        overall_league_woba = (overall_entry.get("mean") or {}).get("woba")
        for row in count_states + lr_splits + situational_splits:
            fk = row.get("filter_key")
            entry = baselines.get(fk) if fk else None
            league = entry["mean"] if entry else None
            row["league"] = league
            row["deciles"] = entry["deciles"] if entry else None
            if (row.get("woba") is not None and overall_league_woba is not None
                    and weights.woba_scale > 0 and weights.runs_per_pa > 0):
                row["wrc_plus"] = round(
                    ((row["woba"] - overall_league_woba) / weights.woba_scale
                     + weights.runs_per_pa) / weights.runs_per_pa * 100
                )
            else:
                row["wrc_plus"] = None

        # Attach league baselines to the discipline block for color
        # coding the top tile row (Swing %, Whiff %, Contact %, etc.).
        discipline["league"] = overall_entry.get("mean")
        discipline["deciles"] = overall_entry.get("deciles")

        return {
            "player_id": player_id,
            "season": season,
            "division_level": division_level,
            "discipline": discipline,
            "count_states": count_states,
            "lr_splits": lr_splits,
            "situational_splits": situational_splits,
            "contact_profile": contact_profile,
            "spray_chart": spray_chart,
        }


# ============================================================
# Pitcher Pitch-Level Stats — mirror of hitter card
# ============================================================
#
# Same color semantics (red = good pitcher performance, low opponent
# numbers): for opponent BA/OBP/SLG/OPS/wOBA/ISO LOWER is better, so
# direction is inverted. K%/Whiff% (induced) are HIGH-good. BB% is
# LOW-good. Putaway% is HIGH-good. Strike% / Called-Strike% / F1
# Strike% are HIGH-good.

# Cache shared with hitter baselines but keyed by ('pitcher', season, div).
_PITCH_LEVEL_PITCHER_BASELINES_CACHE: dict = {}


def _compute_pitcher_pitch_level_baseline(cur, season: int, division_level: str, filter_sql: str, weights):
    """League average pitcher metrics under a filter.

    Same SQL skeleton as hitter baseline, but joined via pitcher_player_id
    (the player on the mound) instead of batter_player_id. Stats are
    computed FROM THE PITCHER'S PERSPECTIVE — opponent BA, etc.
    """
    cur.execute(f"""
        SELECT
            COUNT(*) AS pa,
            COUNT(*) FILTER (WHERE pitches_thrown IS NOT NULL) AS tracked_pa,
            COALESCE(SUM(pitches_thrown), 0) AS pitches,
            SUM(CASE WHEN result_type IN ('walk','intentional_walk','hbp','sac_bunt') THEN 0 ELSE 1 END) AS ab,
            SUM(CASE WHEN result_type IN ('single','double','triple','home_run') THEN 1 ELSE 0 END) AS h,
            SUM(CASE WHEN result_type = 'double' THEN 1 ELSE 0 END) AS d,
            SUM(CASE WHEN result_type = 'triple' THEN 1 ELSE 0 END) AS t,
            SUM(CASE WHEN result_type = 'home_run' THEN 1 ELSE 0 END) AS hr,
            SUM(CASE WHEN result_type = 'walk' THEN 1 ELSE 0 END) AS ubb,
            SUM(CASE WHEN result_type IN ('walk','intentional_walk') THEN 1 ELSE 0 END) AS bb,
            SUM(CASE WHEN result_type = 'hbp' THEN 1 ELSE 0 END) AS hbp,
            SUM(CASE WHEN result_type IN ('strikeout_swinging','strikeout_looking') THEN 1 ELSE 0 END) AS k,
            SUM(CASE WHEN result_type = 'sac_fly' THEN 1 ELSE 0 END) AS sf,
            SUM(CASE WHEN was_in_play THEN 1 ELSE 0 END) AS bip,
            COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))), 0) AS pK,
            COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'S', ''))), 0) AS pS,
            COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS pF,
            COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'B', ''))), 0) AS pB,
            COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS p_inplay,
            COUNT(*) FILTER (
                WHERE pitches_thrown IS NOT NULL AND
                      (LEFT(pitch_sequence, 1) IN ('K', 'S', 'F')
                       OR (pitch_sequence = '' AND was_in_play))
            ) AS f1_strikes,
            COUNT(*) FILTER (WHERE strikes_before = 2) AS two_strike_pa,
            COUNT(*) FILTER (
                WHERE strikes_before = 2 AND result_type IN
                ('strikeout_swinging','strikeout_looking')
            ) AS two_strike_k,
            COUNT(*) FILTER (WHERE bb_type = 'GB') AS gb_n,
            COUNT(*) FILTER (WHERE bb_type = 'FB') AS fb_n,
            COUNT(*) FILTER (WHERE bb_type = 'LD') AS ld_n,
            COUNT(*) FILTER (WHERE bb_type = 'PU') AS pu_n,
            COUNT(*) FILTER (WHERE bb_type IS NOT NULL) AS bb_total,
            COUNT(*) FILTER (
                WHERE bb_type IN ('LD','FB')
                  AND ((UPPER(b.bats) = 'R' AND field_zone = 'LEFT')
                    OR (UPPER(b.bats) = 'L' AND field_zone = 'RIGHT'))
            ) AS opp_air_pull_n
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        JOIN players p ON p.id = ge.pitcher_player_id
        JOIN teams t ON t.id = p.team_id
        JOIN conferences c ON c.id = t.conference_id
        JOIN divisions d ON d.id = c.division_id
        LEFT JOIN players b ON b.id = ge.batter_player_id
        WHERE g.season = %s AND d.level = %s
          AND ge.pitcher_player_id IS NOT NULL
          AND {filter_sql}
    """, [season, division_level])
    r = cur.fetchone()
    n_pa = r["pa"] or 0
    n_pitches = r["pitches"] or 0
    ab = r["ab"] or 0; h = r["h"] or 0
    d_ = r["d"] or 0; tr = r["t"] or 0; hr = r["hr"] or 0
    ubb = r["ubb"] or 0; bb = r["bb"] or 0
    hbp = r["hbp"] or 0; sf = r["sf"] or 0; kct = r["k"] or 0
    singles = h - d_ - tr - hr
    tb = singles + 2*d_ + 3*tr + 4*hr
    obp_denom = ab + bb + hbp + sf
    ba = (h / ab) if ab > 0 else None
    obp = ((h + bb + hbp) / obp_denom) if obp_denom > 0 else None
    slg = (tb / ab) if ab > 0 else None
    ops = ((obp or 0) + (slg or 0)) if (obp is not None and slg is not None) else None
    iso = ((slg - ba) if (slg is not None and ba is not None) else None)
    woba_num = (weights.w_bb * ubb + weights.w_hbp * hbp +
                weights.w_1b * singles + weights.w_2b * d_ +
                weights.w_3b * tr + weights.w_hr * hr)
    woba_denom = ab + ubb + sf + hbp
    woba = (woba_num / woba_denom) if woba_denom > 0 else None
    pK = r["pk"]; pS = r["ps"]; pF = r["pf"]; in_play = r["p_inplay"]
    swings = pK + pF + in_play
    strikes = pK + pS + pF + in_play
    bb_total = r["bb_total"] or 0
    two_strike_pa = r["two_strike_pa"] or 0
    n_tracked = r["tracked_pa"] or 0
    return {
        "pa": n_pa, "tracked_pa": n_tracked, "pitches": n_pitches,
        "opp_ba": ba, "opp_obp": obp, "opp_slg": slg, "opp_ops": ops,
        "opp_iso": iso, "opp_woba": woba,
        "k_pct": (kct / n_pa) if n_pa > 0 else None,
        "bb_pct": (bb / n_pa) if n_pa > 0 else None,
        "strike_pct": (strikes / n_pitches) if n_pitches > 0 else None,
        "called_strike_pct": (pS / n_pitches) if n_pitches > 0 else None,
        "whiff_pct": (pK / swings) if swings > 0 else None,
        "first_pitch_strike_pct": (r["f1_strikes"] / n_tracked) if n_tracked > 0 else None,
        "putaway_pct": (r["two_strike_k"] / two_strike_pa) if two_strike_pa > 0 else None,
        "pitches_per_pa": (n_pitches / n_tracked) if n_tracked > 0 else None,
        "gb_pct": (r["gb_n"] / bb_total) if bb_total > 0 else None,
        "fb_pct": (r["fb_n"] / bb_total) if bb_total > 0 else None,
        "ld_pct": (r["ld_n"] / bb_total) if bb_total > 0 else None,
        "pu_pct": (r["pu_n"] / bb_total) if bb_total > 0 else None,
        "opp_air_pull_pct": (r["opp_air_pull_n"] / bb_total) if bb_total > 0 else None,
        "hr_pa_pct": (hr / n_pa) if n_pa > 0 else None,
    }


def _compute_pitcher_pitch_level_deciles(cur, season, division_level, filter_sql, weights, league_woba=None):
    cur.execute(f"""
        WITH per_pitcher AS (
            SELECT ge.pitcher_player_id AS pid,
                   COUNT(*) AS pa,
                   COALESCE(SUM(pitches_thrown), 0) AS pitches,
                   SUM(CASE WHEN result_type IN ('walk','intentional_walk','hbp','sac_bunt') THEN 0 ELSE 1 END) AS ab,
                   SUM(CASE WHEN result_type IN ('single','double','triple','home_run') THEN 1 ELSE 0 END) AS h,
                   SUM(CASE WHEN result_type = 'double' THEN 1 ELSE 0 END) AS d2,
                   SUM(CASE WHEN result_type = 'triple' THEN 1 ELSE 0 END) AS d3,
                   SUM(CASE WHEN result_type = 'home_run' THEN 1 ELSE 0 END) AS hr,
                   SUM(CASE WHEN result_type = 'walk' THEN 1 ELSE 0 END) AS ubb,
                   SUM(CASE WHEN result_type IN ('walk','intentional_walk') THEN 1 ELSE 0 END) AS bb,
                   SUM(CASE WHEN result_type = 'hbp' THEN 1 ELSE 0 END) AS hbp,
                   SUM(CASE WHEN result_type IN ('strikeout_swinging','strikeout_looking') THEN 1 ELSE 0 END) AS k,
                   SUM(CASE WHEN result_type = 'sac_fly' THEN 1 ELSE 0 END) AS sf,
                   COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))), 0) AS pK,
                   COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'S', ''))), 0) AS pS,
                   COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS pF,
                   COALESCE(SUM(CASE WHEN was_in_play AND pitches_thrown IS NOT NULL THEN 1 ELSE 0 END), 0) AS p_inplay,
                   COALESCE(SUM(CASE WHEN LEFT(pitch_sequence, 1) IN ('K', 'S', 'F') THEN 1
                                     WHEN pitch_sequence = '' AND was_in_play THEN 1
                                     ELSE 0 END), 0) AS f1_strikes,
                   COALESCE(SUM(CASE WHEN strikes_before = 2 THEN 1 ELSE 0 END), 0) AS two_strike_pa,
                   COALESCE(SUM(CASE WHEN strikes_before = 2 AND result_type IN
                       ('strikeout_swinging','strikeout_looking') THEN 1 ELSE 0 END), 0) AS two_strike_k,
                   COUNT(*) FILTER (WHERE bb_type = 'GB') AS gb_n,
                   COUNT(*) FILTER (WHERE bb_type = 'FB') AS fb_n,
                   COUNT(*) FILTER (WHERE bb_type = 'LD') AS ld_n,
                   COUNT(*) FILTER (WHERE bb_type = 'PU') AS pu_n,
                   COUNT(*) FILTER (WHERE bb_type IS NOT NULL) AS bb_total,
                   COUNT(*) FILTER (
                       WHERE bb_type IN ('LD','FB')
                         AND ((UPPER(b.bats) = 'R' AND field_zone = 'LEFT')
                           OR (UPPER(b.bats) = 'L' AND field_zone = 'RIGHT'))
                   ) AS opp_air_pull_n
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            JOIN players p ON p.id = ge.pitcher_player_id
            JOIN teams t ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            LEFT JOIN players b ON b.id = ge.batter_player_id
            WHERE g.season = %s AND d.level = %s
              AND ge.pitcher_player_id IS NOT NULL
              AND {filter_sql}
            GROUP BY ge.pitcher_player_id
            HAVING COUNT(*) >= 5
        )
        SELECT * FROM per_pitcher
    """, [season, division_level])
    rows = cur.fetchall()
    if not rows:
        return {}
    metrics = {k: [] for k in ('opp_ba','opp_obp','opp_slg','opp_ops','opp_iso','opp_woba','wrc_plus_against',
                                'k_pct','bb_pct','strike_pct','called_strike_pct','whiff_pct',
                                'first_pitch_strike_pct','putaway_pct','pitches_per_pa',
                                'gb_pct','fb_pct','ld_pct','pu_pct',
                                'hr_pa_pct','opp_air_pull_pct')}
    for r in rows:
        ab = r["ab"] or 0; h = r["h"] or 0
        d2 = r["d2"] or 0; d3 = r["d3"] or 0; hr = r["hr"] or 0
        ubb = r["ubb"] or 0; bb = r["bb"] or 0
        hbp = r["hbp"] or 0; sf = r["sf"] or 0; k = r["k"] or 0
        pa = r["pa"] or 0; pitches = r["pitches"] or 0
        pK = r["pk"] or 0; pS = r["ps"] or 0; pF = r["pf"] or 0; in_play = r["p_inplay"] or 0
        singles = h - d2 - d3 - hr
        tb = singles + 2*d2 + 3*d3 + 4*hr
        obp_denom = ab + bb + hbp + sf
        if ab > 0:
            metrics["opp_ba"].append(h / ab)
            metrics["opp_slg"].append(tb / ab)
            metrics["opp_iso"].append((tb - h) / ab)
        if obp_denom > 0:
            obp_v = (h + bb + hbp) / obp_denom
            metrics["opp_obp"].append(obp_v)
            if ab > 0:
                metrics["opp_ops"].append(obp_v + tb / ab)
        woba_denom = ab + ubb + sf + hbp
        if woba_denom > 0:
            woba_v = (weights.w_bb * ubb + weights.w_hbp * hbp +
                      weights.w_1b * singles + weights.w_2b * d2 +
                      weights.w_3b * d3 + weights.w_hr * hr) / woba_denom
            metrics["opp_woba"].append(woba_v)
            if league_woba is not None and weights.woba_scale > 0 and weights.runs_per_pa > 0:
                wrc = ((woba_v - league_woba) / weights.woba_scale + weights.runs_per_pa) / weights.runs_per_pa * 100
                metrics["wrc_plus_against"].append(wrc)
        if pa > 0:
            metrics["k_pct"].append(k / pa)
            metrics["bb_pct"].append(bb / pa)
            metrics["first_pitch_strike_pct"].append((r["f1_strikes"] or 0) / pa)
            if pitches > 0:
                metrics["pitches_per_pa"].append(pitches / pa)
        swings = pK + pF + in_play
        strikes = pK + pS + pF + in_play
        if pitches > 0:
            metrics["strike_pct"].append(strikes / pitches)
            metrics["called_strike_pct"].append(pS / pitches)
        if swings > 0:
            metrics["whiff_pct"].append(pK / swings)
        ts_pa = r["two_strike_pa"] or 0
        if ts_pa >= 5:
            metrics["putaway_pct"].append((r["two_strike_k"] or 0) / ts_pa)
        bb_total = r["bb_total"] or 0
        if bb_total >= 5:
            metrics["gb_pct"].append((r["gb_n"] or 0) / bb_total)
            metrics["fb_pct"].append((r["fb_n"] or 0) / bb_total)
            metrics["ld_pct"].append((r["ld_n"] or 0) / bb_total)
            metrics["pu_pct"].append((r["pu_n"] or 0) / bb_total)
            metrics["opp_air_pull_pct"].append((r["opp_air_pull_n"] or 0) / bb_total)
        if pa >= 10:
            metrics["hr_pa_pct"].append((r["hr"] or 0) / pa)
    out = {}
    deciles = [0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9]
    for m, vals in metrics.items():
        if not vals:
            out[m] = None
            continue
        vs = sorted(vals)
        out[m] = [_quantile(vs, q) for q in deciles]
    return out


def _get_pitcher_pitch_level_baselines(cur, season, division_level, weights):
    key = (season, division_level)
    now = _pl_time.time()
    cached = _PITCH_LEVEL_PITCHER_BASELINES_CACHE.get(key)
    if cached and (now - cached["ts"]) < _PITCH_LEVEL_BASELINES_TTL:
        return cached["data"]
    filters = {
        "overall":     "TRUE",
        "hitters":     "(balls_before, strikes_before) IN ((1,0),(2,0),(3,0),(3,1))",
        "neutral":     "(balls_before, strikes_before) IN ((0,0),(1,1),(2,1),(2,2),(3,2))",
        "pitchers":    "(balls_before, strikes_before) IN ((0,1),(0,2),(1,2))",
        "two_strike":  "strikes_before = 2",
        "vs_lhb":      "ge.batter_player_id IN (SELECT id FROM players WHERE UPPER(bats) = 'L')",
        "vs_rhb":      "ge.batter_player_id IN (SELECT id FROM players WHERE UPPER(bats) = 'R')",
        # Situational (Phase A state). Match the pitcher endpoint definitions.
        "bases_empty":   "bases_before = '000'",
        "runner_on":     "bases_before IS NOT NULL AND bases_before <> '000'",
        "risp":          ("bases_before IS NOT NULL AND "
                          "(SUBSTRING(bases_before, 2, 1) = '1' OR "
                          "SUBSTRING(bases_before, 3, 1) = '1')"),
        "risp_2out":     ("bases_before IS NOT NULL AND "
                          "(SUBSTRING(bases_before, 2, 1) = '1' OR "
                          "SUBSTRING(bases_before, 3, 1) = '1') AND outs_before = 2"),
        "innings_early": "inning BETWEEN 1 AND 3",
        "innings_mid":   "inning BETWEEN 4 AND 6",
        "innings_late":  "inning >= 7",
        "late_close":    ("inning >= 7 AND bat_score_before IS NOT NULL "
                          "AND ABS(bat_score_before - fld_score_before) <= 1"),
        "leadoff":       "outs_before = 0 AND bases_before = '000'",
    }
    out = {}
    for k, fsql in filters.items():
        mean = _compute_pitcher_pitch_level_baseline(cur, season, division_level, fsql, weights)
        mean["wrc_plus_against"] = 100 if mean.get("opp_woba") is not None else None
        deciles = _compute_pitcher_pitch_level_deciles(
            cur, season, division_level, fsql, weights,
            league_woba=mean.get("opp_woba"),
        )
        out[k] = {"mean": mean, "deciles": deciles}
    _PITCH_LEVEL_PITCHER_BASELINES_CACHE[key] = {"ts": now, "data": out}
    return out


@router.get("/players/{player_id}/pitch-level-stats-pitcher")
def get_player_pitch_level_stats_pitcher(
    player_id: int,
    season: int = Query(2026, description="Season year"),
):
    """Pitcher pitch-level stats from game_events.

    Mirror of /pitch-level-stats but joined via pitcher_player_id.
    Returns:
      discipline: pitches, strike%, called-strike%, whiff%, F1 strike%, putaway%, P/PA
      count_states: opponent slash + induced K%/BB% in each count
      lr_splits: vs LHB / RHB / Unknown opponent slash
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # Resolve canonical + linked
        cur.execute("SELECT canonical_id FROM player_links WHERE linked_id = %s", (player_id,))
        canonical = cur.fetchone()
        if canonical:
            player_id = canonical["canonical_id"]
        cur.execute("SELECT linked_id FROM player_links WHERE canonical_id = %s", (player_id,))
        linked_ids = [r["linked_id"] for r in cur.fetchall()]
        all_pids = [player_id] + linked_ids

        # Division for weights
        cur.execute("""
            SELECT d.level FROM players p
            JOIN teams t ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE p.id = %s
        """, (player_id,))
        div_row = cur.fetchone()
        division_level = (div_row["level"] if div_row else "D1") or "D1"
        weights = DEFAULT_WEIGHTS.get(division_level, DEFAULT_WEIGHTS["D1"])

        # ── Discipline ──
        cur.execute("""
            SELECT COUNT(*) AS total_pa FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE ge.pitcher_player_id = ANY(%s) AND g.season = %s
        """, (all_pids, season))
        total_pa = cur.fetchone()["total_pa"] or 0

        cur.execute("""
            SELECT
                COUNT(*) AS tracked_pa,
                COALESCE(SUM(pitches_thrown), 0) AS pitches,
                COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))), 0) AS pk,
                COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'S', ''))), 0) AS ps,
                COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS pf,
                COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'B', ''))), 0) AS pb,
                COALESCE(SUM(CASE WHEN was_in_play THEN 1 ELSE 0 END), 0) AS in_play,
                COALESCE(SUM(CASE WHEN strikes_before = 2 THEN 1 ELSE 0 END), 0) AS two_strike_pa,
                COALESCE(SUM(CASE WHEN strikes_before = 2 AND result_type IN ('strikeout_swinging','strikeout_looking') THEN 1 ELSE 0 END), 0) AS two_strike_k,
                COALESCE(SUM(CASE
                    WHEN LEFT(pitch_sequence, 1) IN ('K', 'S', 'F') THEN 1
                    WHEN pitch_sequence = '' AND was_in_play THEN 1
                    ELSE 0
                END), 0) AS f1_strikes
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE ge.pitcher_player_id = ANY(%s) AND g.season = %s
              AND ge.pitches_thrown IS NOT NULL
        """, (all_pids, season))
        r = cur.fetchone()
        tracked_pa = r["tracked_pa"] or 0
        pitches = r["pitches"] or 0
        pK = r["pk"]; pS = r["ps"]; pF = r["pf"]; in_play = r["in_play"]
        swings = pK + pF + in_play
        strikes = pK + pS + pF + in_play
        discipline = {
            "total_pa": total_pa,
            "tracked_pa": tracked_pa,
            "pitches": pitches,
            "swings": swings,
            "whiffs": pK,
            "strike_pct": (strikes / pitches) if pitches > 0 else None,
            "called_strike_pct": (pS / pitches) if pitches > 0 else None,
            "whiff_pct": (pK / swings) if swings > 0 else None,
            "first_pitch_strike_pct": (r["f1_strikes"] / tracked_pa) if tracked_pa > 0 else None,
            "two_strike_pa": r["two_strike_pa"] or 0,
            "putaway_pct": (r["two_strike_k"] / r["two_strike_pa"]) if r["two_strike_pa"] > 0 else None,
            "pitches_per_pa": (pitches / tracked_pa) if tracked_pa > 0 else None,
        }

        # ── Leverage Index (Phase D MVP) ──
        # Avg LI is the headline reliever stat: closers come in for high
        # LI moments (1.5+), mop-up relievers see low LI (≤0.5). For
        # starters, avg LI tends to drift toward 1.0.
        cur.execute("""
            SELECT inning, half, bat_score_before, fld_score_before,
                   bases_before, outs_before
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE ge.pitcher_player_id = ANY(%s)
              AND g.season = %s
              AND ge.bases_before IS NOT NULL
        """, (all_pids, season))
        li_rows = cur.fetchall()
        if li_rows:
            li_values = [
                compute_li(
                    r["inning"], r["half"],
                    (r["bat_score_before"] or 0) - (r["fld_score_before"] or 0),
                    r["bases_before"], r["outs_before"]
                ) for r in li_rows
            ]
            discipline["avg_li"] = sum(li_values) / len(li_values)
            discipline["li_pa"] = len(li_values)
            discipline["max_li"] = max(li_values)
        else:
            discipline["avg_li"] = None
            discipline["li_pa"] = 0
            discipline["max_li"] = None

        # ── WPA (Phase D.5) ──
        # Total Win Probability Added across every PA faced. Positive
        # = pitcher contributed wins (induced low-WPA outcomes for the
        # batter). Closers often post highest WPA per IP because their
        # outs come in the highest-leverage states.
        cur.execute("""
            SELECT
                SUM(ge.wpa_pitcher)           AS total_wpa,
                COUNT(ge.wpa_pitcher)         AS wpa_pa,
                MAX(ge.wpa_pitcher)           AS peak_wpa,
                AVG(ABS(ge.wpa_pitcher))      AS mean_abs_wpa
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE ge.pitcher_player_id = ANY(%s)
              AND g.season = %s
              AND ge.wpa_pitcher IS NOT NULL
        """, (all_pids, season))
        wr = cur.fetchone()
        if wr and wr["wpa_pa"]:
            discipline["total_wpa"]    = float(wr["total_wpa"])
            discipline["wpa_pa"]       = int(wr["wpa_pa"])
            discipline["peak_wpa"]     = float(wr["peak_wpa"])
            discipline["mean_abs_wpa"] = float(wr["mean_abs_wpa"])
        else:
            discipline["total_wpa"]    = None
            discipline["wpa_pa"]       = 0
            discipline["peak_wpa"]     = None
            discipline["mean_abs_wpa"] = None

        # ── Phase E: opponent contact profile (induced bb_type) ──
        # GB% / FB% / LD% / PU% on balls in play AGAINST this pitcher.
        # Headline pitcher stats: GB% (sinkerballers > 50%), LD% (low =
        # weak contact). No spray — spray depends on batter's hand.
        cur.execute("""
            SELECT bb_type, COUNT(*) AS c
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE ge.pitcher_player_id = ANY(%s)
              AND g.season = %s
              AND bb_type IS NOT NULL
            GROUP BY bb_type
        """, (all_pids, season))
        bb_counts = {"GB": 0, "FB": 0, "LD": 0, "PU": 0}
        for r in cur.fetchall():
            bb_counts[r["bb_type"]] = bb_counts.get(r["bb_type"], 0) + r["c"]
        bb_total = sum(bb_counts.values())
        opp_contact_profile = {
            "bb_total": bb_total,
            "gb_pct": (bb_counts["GB"] / bb_total) if bb_total > 0 else None,
            "fb_pct": (bb_counts["FB"] / bb_total) if bb_total > 0 else None,
            "ld_pct": (bb_counts["LD"] / bb_total) if bb_total > 0 else None,
            "pu_pct": (bb_counts["PU"] / bb_total) if bb_total > 0 else None,
            "gb_count": bb_counts["GB"],
            "fb_count": bb_counts["FB"],
            "ld_count": bb_counts["LD"],
            "pu_count": bb_counts["PU"],
        }

        # ── Phase F: opponent spray chart (zone × LHB/RHB × xbh/hr) ──
        FINE_ZONES = ["LF", "LC", "CF", "RC", "RF",
                      "IF_3B", "IF_SS", "IF_MID", "IF_1B", "IF_C"]
        cur.execute("""
            SELECT field_zone_fine,
                   CASE
                     WHEN UPPER(p.bats) = 'L' THEN 'LHB'
                     WHEN UPPER(p.bats) = 'R' THEN 'RHB'
                     ELSE 'UNK'
                   END AS batter_hand,
                   result_type,
                   COUNT(*) AS c
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            LEFT JOIN players p ON p.id = ge.batter_player_id
            WHERE ge.pitcher_player_id = ANY(%s)
              AND g.season = %s
              AND ge.field_zone_fine IS NOT NULL
            GROUP BY field_zone_fine, batter_hand, result_type
        """, (all_pids, season))
        opp_spray_chart = {
            "all":    {z: 0 for z in FINE_ZONES},
            "vs_lhb": {z: 0 for z in FINE_ZONES},
            "vs_rhb": {z: 0 for z in FINE_ZONES},
            "xbh":    {z: 0 for z in FINE_ZONES},
            "hr":     {z: 0 for z in FINE_ZONES},
        }
        XBH_TYPES = {"double", "triple", "home_run"}
        for r in cur.fetchall():
            z = r["field_zone_fine"]; n = r["c"]; rt = r["result_type"]
            opp_spray_chart["all"][z] += n
            if r["batter_hand"] == "LHB":
                opp_spray_chart["vs_lhb"][z] += n
            elif r["batter_hand"] == "RHB":
                opp_spray_chart["vs_rhb"][z] += n
            if rt in XBH_TYPES:
                opp_spray_chart["xbh"][z] += n
            if rt == "home_run":
                opp_spray_chart["hr"][z] += n
        for k in ("all", "vs_lhb", "vs_rhb", "xbh", "hr"):
            opp_spray_chart[f"{k}_total"] = sum(opp_spray_chart[k].values())

        # ── Count-state opponent slash (from pitcher's POV) ──
        def _opp_slash(filter_sql, params):
            cur.execute(f"""
                SELECT
                    COUNT(*) AS pa,
                    COALESCE(SUM(pitches_thrown), 0) AS pitches,
                    SUM(CASE WHEN result_type IN ('walk','intentional_walk','hbp','sac_bunt') THEN 0 ELSE 1 END) AS ab,
                    SUM(CASE WHEN result_type IN ('single','double','triple','home_run') THEN 1 ELSE 0 END) AS h,
                    SUM(CASE WHEN result_type = 'double' THEN 1 ELSE 0 END) AS d,
                    SUM(CASE WHEN result_type = 'triple' THEN 1 ELSE 0 END) AS t,
                    SUM(CASE WHEN result_type = 'home_run' THEN 1 ELSE 0 END) AS hr,
                    SUM(CASE WHEN result_type = 'walk' THEN 1 ELSE 0 END) AS ubb,
                    SUM(CASE WHEN result_type IN ('walk','intentional_walk') THEN 1 ELSE 0 END) AS bb,
                    SUM(CASE WHEN result_type = 'hbp' THEN 1 ELSE 0 END) AS hbp,
                    SUM(CASE WHEN result_type IN ('strikeout_swinging','strikeout_looking') THEN 1 ELSE 0 END) AS k,
                    SUM(CASE WHEN result_type = 'sac_fly' THEN 1 ELSE 0 END) AS sf,
                    SUM(CASE WHEN was_in_play THEN 1 ELSE 0 END) AS bip,
                    COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))), 0) AS pk,
                    COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'S', ''))), 0) AS ps,
                    COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS pf,
                    COALESCE(SUM(CASE WHEN was_in_play AND pitches_thrown IS NOT NULL THEN 1 ELSE 0 END), 0) AS p_inplay
                FROM game_events ge JOIN games g ON g.id = ge.game_id
                WHERE ge.pitcher_player_id = ANY(%s) AND g.season = %s AND {filter_sql}
            """, [all_pids, season] + params)
            row = cur.fetchone()
            n_pa = row["pa"] or 0
            n_pitches = row["pitches"] or 0
            ab = row["ab"] or 0; h = row["h"] or 0
            d = row["d"] or 0; tr = row["t"] or 0; hr = row["hr"] or 0
            ubb = row["ubb"] or 0; bb = row["bb"] or 0
            hbp = row["hbp"] or 0; sf = row["sf"] or 0; kct = row["k"] or 0
            singles = h - d - tr - hr
            tb = singles + 2*d + 3*tr + 4*hr
            obp_denom = ab + bb + hbp + sf
            ba = (h / ab) if ab > 0 else None
            obp = ((h + bb + hbp) / obp_denom) if obp_denom > 0 else None
            slg = (tb / ab) if ab > 0 else None
            ops = ((obp or 0) + (slg or 0)) if (obp is not None and slg is not None) else None
            iso = ((slg - ba) if (slg is not None and ba is not None) else None)
            woba_num = (weights.w_bb * ubb + weights.w_hbp * hbp +
                        weights.w_1b * singles + weights.w_2b * d +
                        weights.w_3b * tr + weights.w_hr * hr)
            woba_denom = ab + ubb + sf + hbp
            woba = (woba_num / woba_denom) if woba_denom > 0 else None
            pK = row["pk"]; pS = row["ps"]; pF = row["pf"]; in_play = row["p_inplay"]
            swings = pK + pF + in_play
            strikes = pK + pS + pF + in_play
            return {
                "pa": n_pa, "pitches": n_pitches, "bip": row["bip"] or 0,
                "ab": ab, "h": h, "hr": hr, "bb": bb, "k": kct,
                "opp_ba": ba, "opp_obp": obp, "opp_slg": slg, "opp_ops": ops,
                "opp_iso": iso, "opp_woba": woba,
                "k_pct": (kct / n_pa) if n_pa > 0 else None,
                "bb_pct": (bb / n_pa) if n_pa > 0 else None,
                "strike_pct": (strikes / n_pitches) if n_pitches > 0 else None,
                "whiff_pct": (pK / swings) if swings > 0 else None,
                "wrc_plus_against": None,
            }

        hitters_counts = "(balls_before, strikes_before) IN ((1,0),(2,0),(3,0),(3,1))"
        pitchers_counts = "(balls_before, strikes_before) IN ((0,1),(0,2),(1,2))"
        neutral_counts = "(balls_before, strikes_before) IN ((0,0),(1,1),(2,1),(2,2),(3,2))"
        two_strike = "strikes_before = 2"
        count_states = [
            {"label": "Hitter's counts", "detail": "1-0, 2-0, 3-0, 3-1", "filter_key": "hitters", **_opp_slash(hitters_counts, [])},
            {"label": "Neutral counts", "detail": "0-0, 1-1, 2-1, 2-2, 3-2", "filter_key": "neutral", **_opp_slash(neutral_counts, [])},
            {"label": "Pitcher's counts", "detail": "0-1, 0-2, 1-2", "filter_key": "pitchers", **_opp_slash(pitchers_counts, [])},
            {"label": "2-strike", "detail": "any 2-strike count", "filter_key": "two_strike", **_opp_slash(two_strike, [])},
        ]

        # ── L/R batter splits ──
        def _split(bats_filter):
            return _opp_slash(
                f"ge.batter_player_id IN (SELECT id FROM players WHERE {bats_filter})",
                []
            )
        def _split_unknown():
            return _opp_slash(
                "(ge.batter_player_id IS NULL OR ge.batter_player_id IN (SELECT id FROM players WHERE bats IS NULL))",
                []
            )
        lr_splits = [
            {"label": "vs LHB", "filter_key": "vs_lhb", **_split("UPPER(bats) = 'L'")},
            {"label": "vs RHB", "filter_key": "vs_rhb", **_split("UPPER(bats) = 'R'")},
            {"label": "vs Unknown", "filter_key": None, **_split_unknown()},
        ]

        # ── Situational splits (pitcher's perspective) ──
        # Same Phase A state filters as the hitter card. Reads as
        # "opponent BA when we have RISP / late & close / etc."
        bases_empty   = "bases_before = '000'"
        runner_on     = "bases_before IS NOT NULL AND bases_before <> '000'"
        risp          = ("bases_before IS NOT NULL AND "
                         "(SUBSTRING(bases_before, 2, 1) = '1' OR "
                         "SUBSTRING(bases_before, 3, 1) = '1')")
        risp_2out     = f"({risp}) AND outs_before = 2"
        innings_early = "inning BETWEEN 1 AND 3"
        innings_mid   = "inning BETWEEN 4 AND 6"
        innings_late  = "inning >= 7"
        late_close    = ("inning >= 7 AND bat_score_before IS NOT NULL "
                         "AND ABS(bat_score_before - fld_score_before) <= 1")
        leadoff       = "outs_before = 0 AND bases_before = '000'"
        situational_splits = [
            {"label": "Bases empty",   "detail": "no runners on",       "filter_key": "bases_empty",   **_opp_slash(bases_empty,   [])},
            {"label": "Runner(s) on",  "detail": "any base occupied",   "filter_key": "runner_on",     **_opp_slash(runner_on,     [])},
            {"label": "RISP",          "detail": "2B or 3B occupied",   "filter_key": "risp",          **_opp_slash(risp,          [])},
            {"label": "RISP / 2 out",  "detail": "RISP w/ 2 outs",      "filter_key": "risp_2out",     **_opp_slash(risp_2out,     [])},
            {"label": "Innings 1-3",   "detail": "early",               "filter_key": "innings_early", **_opp_slash(innings_early, [])},
            {"label": "Innings 4-6",   "detail": "middle",              "filter_key": "innings_mid",   **_opp_slash(innings_mid,   [])},
            {"label": "Innings 7+",    "detail": "late",                "filter_key": "innings_late",  **_opp_slash(innings_late,  [])},
            {"label": "Late & close",  "detail": "7+ inn, score ±1",    "filter_key": "late_close",    **_opp_slash(late_close,    [])},
            {"label": "Leadoff PA",    "detail": "first PA of inning",  "filter_key": "leadoff",       **_opp_slash(leadoff,       [])},
        ]

        # Attach baselines + compute wRC+ allowed (vs OVERALL league wOBA,
        # not the per-filter wOBA — same fix as the hitter endpoint).
        baselines = _get_pitcher_pitch_level_baselines(cur, season, division_level, weights)
        overall_entry = baselines.get("overall") or {}
        overall_league_opp_woba = (overall_entry.get("mean") or {}).get("opp_woba")
        for row in count_states + lr_splits + situational_splits:
            fk = row.get("filter_key")
            entry = baselines.get(fk) if fk else None
            league = entry["mean"] if entry else None
            row["league"] = league
            row["deciles"] = entry["deciles"] if entry else None
            if (row.get("opp_woba") is not None and overall_league_opp_woba is not None
                    and weights.woba_scale > 0 and weights.runs_per_pa > 0):
                row["wrc_plus_against"] = round(
                    ((row["opp_woba"] - overall_league_opp_woba) / weights.woba_scale
                     + weights.runs_per_pa) / weights.runs_per_pa * 100
                )
            else:
                row["wrc_plus_against"] = None

        # Attach overall baseline to discipline for top-row tile coloring
        discipline["league"] = overall_entry.get("mean")
        discipline["deciles"] = overall_entry.get("deciles")

        return {
            "player_id": player_id,
            "season": season,
            "division_level": division_level,
            "discipline": discipline,
            "count_states": count_states,
            "lr_splits": lr_splits,
            "situational_splits": situational_splits,
            "opp_contact_profile": opp_contact_profile,
            "opp_spray_chart": opp_spray_chart,
        }


# ============================================================
# ============================================================
# IMAGE PROXY - for canvas export (avoids CORS issues)
# ============================================================
import httpx as _httpx
from fastapi.responses import Response as _ImgResponse

@router.get("/proxy-image")
async def proxy_image(url: str = Query(...)):
    """Proxy an external image to avoid CORS issues in canvas exports."""
    if not url.startswith("http"):
        raise HTTPException(400, "Invalid URL")
    try:
        async with _httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            resp = await client.get(url)
        if resp.status_code != 200:
            raise HTTPException(resp.status_code, "Upstream error")
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
              AND (p.first_name ILIKE %s OR p.last_name ILIKE %s
                   OR (p.first_name || ' ' || p.last_name) ILIKE %s)
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


# ============================================================
# SUMMER LEADERBOARDS
# ============================================================

@router.get("/leaderboards/summer/batting")
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
                   sp.first_name, sp.last_name, sp.position, sp.college,
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
                   sp.first_name, sp.last_name, sp.position, sp.college,
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
# FEATURE REQUESTS
# ════════════════════════════════════════════════════════════════

def _send_feature_request_email(req_id, email, category, message):
    """Send email notification for a new feature request."""
    smtp_user = os.getenv("SMTP_USER")
    smtp_pass = os.getenv("SMTP_PASS")
    notify_email = os.getenv("NOTIFY_EMAIL")

    if not all([smtp_user, smtp_pass, notify_email]):
        return  # Skip if email not configured

    try:
        msg = MIMEMultipart()
        msg["From"] = smtp_user
        msg["To"] = notify_email
        msg["Subject"] = f"[NWBB Stats] New {category}: #{req_id}"

        body = f"""New {category} submitted on NWBB Stats:

From: {email or 'Anonymous'}
Category: {category}
Request ID: #{req_id}

Message:
{message}
"""
        msg.attach(MIMEText(body, "plain"))

        with smtplib.SMTP("smtp.gmail.com", 587, timeout=10) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)
    except Exception:
        pass  # Don't fail the request if email fails


@router.post("/feature-requests")
def submit_feature_request(data: dict = Body(...)):
    """Submit a feature request or feedback."""
    message = (data.get("message") or "").strip()
    email = (data.get("email") or "").strip()
    category = (data.get("category") or "feature").strip()

    if not message:
        raise HTTPException(status_code=400, detail="Message is required")
    if len(message) > 2000:
        raise HTTPException(status_code=400, detail="Message too long (max 2000 chars)")

    with get_connection() as conn:
        cur = conn.cursor()
        # Create table if it doesn't exist
        cur.execute("""
            CREATE TABLE IF NOT EXISTS feature_requests (
                id SERIAL PRIMARY KEY,
                email TEXT,
                category TEXT DEFAULT 'feature',
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        cur.execute(
            """INSERT INTO feature_requests (email, category, message)
               VALUES (%s, %s, %s) RETURNING id""",
            (email or None, category, message),
        )
        req_id = list(cur.fetchone().values())[0]

    # Send notification email in background thread so it doesn't block the response
    threading.Thread(
        target=_send_feature_request_email,
        args=(req_id, email, category, message),
        daemon=True,
    ).start()

    return {"id": req_id, "status": "received"}


@router.get("/feature-requests")
def list_feature_requests():
    """List all feature requests (admin use)."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT id, email, category, message, created_at
            FROM feature_requests
            ORDER BY created_at DESC
            LIMIT 100
        """)
        return [dict(r) for r in cur.fetchall()]


@router.get("/recruiting/guide/{team_id}")
def get_recruiting_guide(team_id: int):
    """
    Comprehensive recruiting guide for a team.

    Returns:
    - Basic team info with division/conference
    - 5-year W-L trend
    - 5-year team stats (ERA, batting avg, OPS, runs)
    - Roster overview and class breakdown
    - Freshman production metrics
    - Roster turnover rates
    - Redshirt rate
    - Four-year retention (for 4-year schools)
    - Average physical attributes by position
    - Player hometowns
    - Hometown breakdown by state and metro area
    - Top 10 all-time players by WAR
    - Team WAR by season
    - Placeholder for user-submitted ratings
    """
    try:
        with get_connection() as conn:
            cur = conn.cursor()

            # ============ TEAM INFO ============
            cur.execute("""
                SELECT t.id, t.name, t.school_name, t.short_name, t.mascot,
                       t.city, t.state, t.logo_url, t.stats_url, t.roster_url,
                       c.name as conference_name, d.name as division_name
                FROM teams t
                LEFT JOIN conferences c ON t.conference_id = c.id
                LEFT JOIN divisions d ON c.division_id = d.id
                WHERE t.id = %s
            """, (team_id,))
            team_row = cur.fetchone()
            if not team_row:
                return JSONResponse(content={"error": "Team not found"}, status_code=404)

            team_info = dict(team_row)

            # ============ SEASON RECORDS (All years) ============
            # Only show seasons where the team actually had players with stats,
            # to filter out fake/bad data for programs that didn't exist yet
            cur.execute("""
                SELECT tss.season, tss.wins, tss.losses, tss.ties,
                       COALESCE(tss.conference_wins, 0) as conf_wins,
                       COALESCE(tss.conference_losses, 0) as conf_losses
                FROM team_season_stats tss
                WHERE tss.team_id = %s
                  AND (
                    EXISTS (SELECT 1 FROM batting_stats WHERE team_id = %s AND season = tss.season)
                    OR EXISTS (SELECT 1 FROM pitching_stats WHERE team_id = %s AND season = tss.season)
                  )
                ORDER BY season DESC
            """, (team_id, team_id, team_id))
            season_records = [dict(r) for r in cur.fetchall()]
            season_records.reverse()

            # ============ SEASON STATS (All years) ============
            cur.execute("""
                SELECT season, team_era, team_batting_avg, team_ops,
                       runs_scored, runs_allowed
                FROM team_season_stats
                WHERE team_id = %s
                ORDER BY season DESC
            """, (team_id,))
            season_stats = [dict(r) for r in cur.fetchall()]
            season_stats.reverse()

            # ============ CURRENT ROSTER OVERVIEW ============
            # Get the most recent season with stats for this team
            cur.execute("""
                SELECT MAX(season) as max_season FROM (
                    SELECT MAX(season) as season FROM batting_stats WHERE team_id = %s
                    UNION ALL
                    SELECT MAX(season) as season FROM pitching_stats WHERE team_id = %s
                ) s
            """, (team_id, team_id))
            max_season_row = cur.fetchone()
            current_season = max_season_row['max_season'] if max_season_row else 2026

            # Use roster_year to identify current roster players.
            # If roster_year is populated, use it; otherwise fall back to
            # players with stats in the current season.
            cur.execute("""
                SELECT COUNT(*) as cnt FROM players
                WHERE team_id = %s AND roster_year = %s
            """, (team_id, current_season))
            roster_year_count = cur.fetchone()['cnt']

            if roster_year_count > 0:
                # Use roster_year filter (preferred)
                cur.execute("""
                    SELECT DISTINCT p.id, p.position, p.year_in_school
                    FROM players p
                    WHERE p.team_id = %s AND p.roster_year = %s
                    ORDER BY p.id
                """, (team_id, current_season))
            else:
                # Fallback: players with stats in current season
                cur.execute("""
                    SELECT DISTINCT p.id, p.position, p.year_in_school
                    FROM players p
                    WHERE p.team_id = %s
                      AND p.id IN (
                        SELECT DISTINCT player_id FROM batting_stats
                        WHERE team_id = %s AND season = %s
                        UNION
                        SELECT DISTINCT player_id FROM pitching_stats
                        WHERE team_id = %s AND season = %s
                      )
                    ORDER BY p.id
                """, (team_id, team_id, current_season, team_id, current_season))
            all_roster_rows = cur.fetchall()

            total_players = len(all_roster_rows)

            # Pitcher detection: check for exact position matches
            pitcher_positions = {'P', 'RHP', 'LHP', 'SP', 'RP'}
            pitcher_count = 0
            for r in all_roster_rows:
                pos = r['position'] or ''
                # Split on "/" or "," to handle multi-position like "RHP/1B"
                pos_parts = [p.strip() for p in pos.replace(',', '/').split('/')]
                if any(pp in pitcher_positions for pp in pos_parts):
                    pitcher_count += 1
            hitter_count = total_players - pitcher_count

            # Class breakdown - map redshirt classes to their base class
            # R-Fr → Fr, R-So → So, R-Jr → Jr, R-Sr → Sr, Gr → Sr
            # Players with NULL year_in_school counted as "Unknown"
            class_map = {
                "Fr": "Fr", "So": "So", "Jr": "Jr", "Sr": "Sr",
                "R-Fr": "Fr", "R-So": "So", "R-Jr": "Jr", "R-Sr": "Sr",
                "Gr": "Sr", "GR": "Sr",
            }
            class_breakdown = {"Fr": 0, "So": 0, "Jr": 0, "Sr": 0, "Unknown": 0}
            for r in all_roster_rows:
                year = r['year_in_school']
                if year:
                    mapped = class_map.get(year.strip(), "Unknown")
                    class_breakdown[mapped] += 1
                else:
                    class_breakdown["Unknown"] += 1

            # Count players who appeared in at least one game in the most recent season
            cur.execute("""
                SELECT COUNT(DISTINCT player_id) as appeared
                FROM (
                    SELECT DISTINCT player_id FROM batting_stats
                    WHERE team_id = %s AND season = (SELECT MAX(season) FROM batting_stats WHERE team_id = %s)
                    UNION
                    SELECT DISTINCT player_id FROM pitching_stats
                    WHERE team_id = %s AND season = (SELECT MAX(season) FROM pitching_stats WHERE team_id = %s)
                ) AS combined
            """, (team_id, team_id, team_id, team_id))
            appeared_result = cur.fetchone()
            players_appeared = appeared_result['appeared'] if appeared_result else 0

            roster_overview = {
                "total_players": total_players,
                "pitcher_count": pitcher_count,
                "hitter_count": hitter_count,
                "players_appeared": players_appeared,
                "by_class": class_breakdown,
                "season": current_season
            }

            # ============ FRESHMAN PRODUCTION ============
            # Back-calculate each player's freshman year from their current
            # year_in_school. E.g. a Jr in 2026 was a Fr in 2024.
            # Offset = how many years ago they were a freshman
            class_to_offset = {
                "Fr": 0, "R-Fr": 0,
                "So": 1, "R-So": 1,
                "Jr": 2, "R-Jr": 2,
                "Sr": 3, "R-Sr": 3,
                "Gr": 4, "GR": 4,
            }

            cur.execute("""
                SELECT DISTINCT season FROM batting_stats
                WHERE team_id = %s
                UNION
                SELECT DISTINCT season FROM pitching_stats
                WHERE team_id = %s
                ORDER BY season DESC
                LIMIT 5
            """, (team_id, team_id))
            seasons = [r['season'] for r in cur.fetchall()]
            seasons.sort()

            # Get all players who've had stats at this team, with their
            # year_in_school and the most recent season they were active
            cur.execute("""
                SELECT p.id, p.year_in_school,
                       COALESCE(p.roster_year, (
                           SELECT MAX(season) FROM (
                               SELECT season FROM batting_stats WHERE player_id = p.id AND team_id = %s
                               UNION
                               SELECT season FROM pitching_stats WHERE player_id = p.id AND team_id = %s
                           ) s
                       )) as ref_year
                FROM players p
                WHERE p.team_id = %s AND p.year_in_school IS NOT NULL
            """, (team_id, team_id, team_id))

            # Build set of freshman player IDs per season
            freshmen_by_season = {}
            for r in cur.fetchall():
                yis = (r['year_in_school'] or '').strip()
                ref_year = r['ref_year']
                if not yis or not ref_year or yis not in class_to_offset:
                    continue
                fr_year = ref_year - class_to_offset[yis]
                if fr_year not in freshmen_by_season:
                    freshmen_by_season[fr_year] = set()
                freshmen_by_season[fr_year].add(r['id'])

            freshman_production = []
            for season in seasons:
                fresh_ids = freshmen_by_season.get(season, set())
                if not fresh_ids:
                    freshman_production.append({
                        "season": season,
                        "fresh_pa_pct": 0,
                        "fresh_ip_pct": 0,
                        "total_war": 0
                    })
                    continue

                id_placeholders = ','.join(['%s'] * len(fresh_ids))
                fresh_id_list = list(fresh_ids)

                # Freshman PA
                cur.execute(f"""
                    SELECT SUM(bs.plate_appearances) as fr_pa
                    FROM batting_stats bs
                    WHERE bs.team_id = %s AND bs.season = %s
                      AND bs.player_id IN ({id_placeholders})
                """, [team_id, season] + fresh_id_list)
                fr_pa = (cur.fetchone() or {}).get('fr_pa') or 0

                # Total PA
                cur.execute("""
                    SELECT SUM(bs.plate_appearances) as total_pa
                    FROM batting_stats bs
                    WHERE bs.team_id = %s AND bs.season = %s
                """, (team_id, season))
                total_pa = (cur.fetchone() or {}).get('total_pa') or 0

                fr_pa_pct = (fr_pa / total_pa * 100) if total_pa > 0 else 0

                # Freshman IP
                cur.execute(f"""
                    SELECT SUM(ps2.innings_pitched) as fr_ip
                    FROM pitching_stats ps2
                    WHERE ps2.team_id = %s AND ps2.season = %s
                      AND ps2.player_id IN ({id_placeholders})
                """, [team_id, season] + fresh_id_list)
                fr_ip = (cur.fetchone() or {}).get('fr_ip') or 0

                # Total IP
                cur.execute("""
                    SELECT SUM(ps2.innings_pitched) as total_ip
                    FROM pitching_stats ps2
                    WHERE ps2.team_id = %s AND ps2.season = %s
                """, (team_id, season))
                total_ip = (cur.fetchone() or {}).get('total_ip') or 0

                fr_ip_pct = (fr_ip / total_ip * 100) if total_ip > 0 else 0

                # Freshman WAR
                cur.execute(f"""
                    SELECT COALESCE(SUM(COALESCE(owar, 0) + COALESCE(pwar, 0)), 0) as fr_war
                    FROM (
                        SELECT bs.offensive_war as owar, NULL as pwar
                        FROM batting_stats bs
                        WHERE bs.team_id = %s AND bs.season = %s AND bs.player_id IN ({id_placeholders})
                        UNION ALL
                        SELECT NULL as owar, ps3.pitching_war as pwar
                        FROM pitching_stats ps3
                        WHERE ps3.team_id = %s AND ps3.season = %s AND ps3.player_id IN ({id_placeholders})
                    ) sub
                """, [team_id, season] + fresh_id_list + [team_id, season] + fresh_id_list)
                fr_war = (cur.fetchone() or {}).get('fr_war') or 0

                freshman_production.append({
                    "season": season,
                    "fresh_pa_pct": round(fr_pa_pct / 100, 4) if fr_pa_pct else 0,
                    "fresh_ip_pct": round(fr_ip_pct / 100, 4) if fr_ip_pct else 0,
                    "total_war": round(fr_war, 2)
                })

            # ============ ROSTER COMPOSITION ============
            # Year-by-year: % returners, % freshmen, % transfers
            # A "returner" was on the same team the previous season.
            # A "freshman" has year_in_school Fr or R-Fr (back-calculated).
            # A "transfer" is new to the team and not a freshman.
            roster_composition = []

            # Build player sets per season (reuse for efficiency)
            players_by_season = {}
            for s in seasons:
                cur.execute("""
                    SELECT DISTINCT player_id FROM batting_stats
                    WHERE team_id = %s AND season = %s
                    UNION
                    SELECT DISTINCT player_id FROM pitching_stats
                    WHERE team_id = %s AND season = %s
                """, (team_id, s, team_id, s))
                players_by_season[s] = set(r['player_id'] for r in cur.fetchall())

            # Build freshman set per season using back-calculated class year
            # (reuse class_to_offset from freshman production section above)
            fresh_by_season = {}
            for s in seasons:
                fresh_ids = set()
                for pid in players_by_season.get(s, set()):
                    # Look up this player's year_in_school and ref_year
                    # to back-calculate if they were a freshman in season s
                    pass
                fresh_by_season[s] = fresh_ids

            # Use the same back-calculation approach as freshman production
            # Get all players with year_in_school for this team
            cur.execute("""
                SELECT p.id, p.year_in_school,
                       COALESCE(p.roster_year, (
                           SELECT MAX(season) FROM (
                               SELECT season FROM batting_stats WHERE player_id = p.id AND team_id = %s
                               UNION
                               SELECT season FROM pitching_stats WHERE player_id = p.id AND team_id = %s
                           ) s
                       )) as ref_year
                FROM players p
                WHERE p.team_id = %s AND p.year_in_school IS NOT NULL
            """, (team_id, team_id, team_id))

            # Map player_id -> their freshman season
            player_fresh_season = {}
            for r in cur.fetchall():
                offset = class_to_offset.get(r['year_in_school'])
                if offset is not None and r['ref_year']:
                    player_fresh_season[r['id']] = int(r['ref_year']) - offset

            for s in seasons:
                roster = players_by_season.get(s, set())
                total = len(roster)
                if total == 0:
                    continue

                # Skip if no prior season data - can't determine returners vs new
                if (s - 1) not in players_by_season:
                    continue

                prev = players_by_season.get(s - 1, set())
                returners = roster & prev
                new_players = roster - prev

                freshmen = set()
                transfers = set()
                for pid in new_players:
                    if player_fresh_season.get(pid) == s:
                        freshmen.add(pid)
                    else:
                        transfers.add(pid)

                roster_composition.append({
                    "season": s,
                    "total": total,
                    "returners": len(returners),
                    "freshmen": len(freshmen),
                    "transfers": len(transfers),
                    "returner_pct": round(len(returners) / total, 4),
                    "freshman_pct": round(len(freshmen) / total, 4),
                    "transfer_pct": round(len(transfers) / total, 4),
                })

            # ============ REDSHIRT RATE ============
            cur.execute("""
                SELECT COUNT(*) as redshirt_count
                FROM players
                WHERE team_id = %s AND year_in_school LIKE %s
            """, (team_id, 'R-%'))
            redshirt_count = (cur.fetchone() or {}).get('redshirt_count') or 0

            redshirt_rate = {
                "redshirt_count": redshirt_count,
                "total": total_players,
                "rate": round(redshirt_count / total_players, 4) if total_players > 0 else 0
            }

            # (Four-year retention removed)

            # ============ AVERAGE SIZE BY POSITION ============
            position_groups = {
                "Catcher": {"C"},
                "Middle Infield": {"SS", "2B"},
                "Corner Infield": {"1B", "3B"},
                "Outfield": {"OF", "CF", "LF", "RF"},
                "Pitcher": {"P", "RHP", "LHP", "SP", "RP"}
            }

            # Fetch current roster players only, then group in Python with exact matching
            if roster_year_count > 0:
                cur.execute("""
                    SELECT p.position, p.height, p.weight FROM players p
                    WHERE p.team_id = %s AND p.roster_year = %s
                      AND p.position IS NOT NULL AND p.position != ''
                """, (team_id, current_season))
            else:
                cur.execute("""
                    SELECT p.position, p.height, p.weight FROM players p
                    WHERE p.team_id = %s AND p.position IS NOT NULL AND p.position != ''
                      AND p.id IN (
                        SELECT DISTINCT player_id FROM batting_stats
                        WHERE team_id = %s AND season = %s
                        UNION
                        SELECT DISTINCT player_id FROM pitching_stats
                        WHERE team_id = %s AND season = %s
                      )
                """, (team_id, team_id, current_season, team_id, current_season))
            all_players_for_size = cur.fetchall()

            def get_pos_parts(pos_str):
                """Split position like 'RHP/1B' or 'C, OF' into individual parts."""
                return [p.strip() for p in pos_str.replace(',', '/').split('/')]

            avg_size_by_position = []
            for group_name, valid_positions in position_groups.items():
                players_in_group = [
                    p for p in all_players_for_size
                    if any(pp in valid_positions for pp in get_pos_parts(p['position']))
                ]

                if players_in_group:
                    heights_inches = []
                    weights = []
                    for p in players_in_group:
                        h, w = p['height'], p['weight']
                        if h:
                            # Handle formats like "6 2", "6-2", "6'2"
                            match = re.match(r"(\d+)['\s\-]+(\d+)", str(h))
                            if match:
                                try:
                                    feet, inches = int(match.group(1)), int(match.group(2))
                                    heights_inches.append(feet * 12 + inches)
                                except Exception:
                                    # Narrowed from bare `except:`; skips a
                                    # malformed row without swallowing signals.
                                    pass
                        if w:
                            try:
                                weights.append(int(str(w).replace('lbs', '').strip()))
                            except Exception:
                                # Narrowed from bare `except:`; skips a
                                # malformed weight string.
                                pass

                    avg_height = sum(heights_inches) / len(heights_inches) if heights_inches else None
                    avg_weight = sum(weights) / len(weights) if weights else None

                    avg_size_by_position.append({
                        "position_group": group_name,
                        "avg_height_inches": round(avg_height, 1) if avg_height else None,
                        "avg_weight": round(avg_weight, 1) if avg_weight else None,
                        "count": len(players_in_group)
                    })

            # ============ PLAYER HOMETOWNS ============
            if roster_year_count > 0:
                cur.execute("""
                    SELECT p.id, p.first_name, p.last_name, p.hometown, p.height, p.weight
                    FROM players p
                    WHERE p.team_id = %s AND p.roster_year = %s
                      AND p.hometown IS NOT NULL AND p.hometown != ''
                    ORDER BY p.last_name, p.first_name
                """, (team_id, current_season))
            else:
                cur.execute("""
                    SELECT p.id, p.first_name, p.last_name, p.hometown, p.height, p.weight
                    FROM players p
                    WHERE p.team_id = %s AND p.hometown IS NOT NULL AND p.hometown != ''
                      AND p.id IN (
                        SELECT DISTINCT player_id FROM batting_stats
                        WHERE team_id = %s AND season = %s
                        UNION
                        SELECT DISTINCT player_id FROM pitching_stats
                        WHERE team_id = %s AND season = %s
                      )
                    ORDER BY p.last_name, p.first_name
                """, (team_id, team_id, current_season, team_id, current_season))

            player_hometowns = []
            for p in cur.fetchall():
                player_hometowns.append({
                    "name": f"{p['first_name']} {p['last_name']}",
                    "hometown": p['hometown'],
                    "state": None,
                    "lat": None,
                    "lng": None
                })

            # ============ HOMETOWN BREAKDOWN ============
            metro_keywords = {
                "Seattle Metro": {
                    "keywords": ["Seattle"],
                    "cities": ["Bellevue", "Tacoma", "Kent", "Renton", "Auburn", "Federal Way",
                              "Kirkland", "Redmond", "Bothell", "Issaquah", "Sammamish", "Woodinville",
                              "Lynnwood", "Edmonds", "Shoreline", "Burien", "Tukwila", "Mercer Island",
                              "Kenmore", "Lake Stevens", "Marysville", "Everett", "Snohomish", "Monroe",
                              "Mukilteo", "Mountlake Terrace", "Mill Creek"],
                    "state": "WA"
                },
                "Portland Metro": {
                    "keywords": ["Portland"],
                    "cities": ["Beaverton", "Hillsboro", "Gresham", "Lake Oswego", "Tigard", "Tualatin",
                              "West Linn", "Oregon City", "Milwaukie", "Clackamas", "Happy Valley",
                              "Sherwood", "Wilsonville", "Canby", "Troutdale", "Camas", "Washougal",
                              "Vancouver"],
                    "state": "OR"
                },
                "Boise Metro": {
                    "keywords": ["Boise"],
                    "cities": ["Meridian", "Nampa", "Caldwell", "Eagle", "Kuna", "Star"],
                    "state": "ID"
                },
                "Spokane Metro": {
                    "keywords": ["Spokane"],
                    "cities": ["Liberty Lake", "Cheney", "Airway Heights", "Medical Lake"],
                    "state": "WA"
                }
            }

            hometown_by_state = {}
            hometown_by_metro = {}

            for p in player_hometowns:
                hometown = p['hometown']
                # Try to extract state (simple logic - look for ", XX" at end)
                state = None
                if ", " in hometown:
                    state = hometown.split(", ")[-1].strip().upper()

                # Count by state
                if state:
                    hometown_by_state[state] = hometown_by_state.get(state, 0) + 1

                # Assign to metro area
                metro = "Other"
                for metro_name, metro_data in metro_keywords.items():
                    for keyword in metro_data["keywords"]:
                        if keyword in hometown:
                            metro = metro_name
                            break
                    if metro != "Other":
                        break
                    for city in metro_data["cities"]:
                        if city in hometown and state == metro_data["state"]:
                            metro = metro_name
                            break
                    if metro != "Other":
                        break

                hometown_by_metro[metro] = hometown_by_metro.get(metro, 0) + 1

            hometown_breakdown = {
                "by_state": [{"state": s, "count": c} for s, c in sorted(hometown_by_state.items(), key=lambda x: -x[1])],
                "by_metro": [{"metro": m, "count": c} for m, c in sorted(hometown_by_metro.items(), key=lambda x: -x[1])]
            }

            # ============ BEST PLAYERS (Top 10 by WAR) ============
            # Offensive WAR
            cur.execute("""
                SELECT p.id, p.first_name, p.last_name, p.position,
                       SUM(bs.offensive_war) as total_war,
                       STRING_AGG(DISTINCT bs.season::text, ',') as seasons
                FROM players p
                LEFT JOIN batting_stats bs ON p.id = bs.player_id AND bs.team_id = %s
                WHERE p.team_id = %s AND bs.offensive_war IS NOT NULL
                GROUP BY p.id, p.first_name, p.last_name, p.position
                ORDER BY total_war DESC
                LIMIT 10
            """, (team_id, team_id))
            offensive_top_10 = [
                {
                    "name": f"{r['first_name']} {r['last_name']}",
                    "position": r['position'],
                    "seasons": sorted(r['seasons'].split(',')) if r['seasons'] else [],
                    "total_war": round(r['total_war'], 2)
                } for r in cur.fetchall()
            ]

            # Pitching WAR
            cur.execute("""
                SELECT p.id, p.first_name, p.last_name, p.position,
                       SUM(ps.pitching_war) as total_war,
                       STRING_AGG(DISTINCT ps.season::text, ',') as seasons
                FROM players p
                LEFT JOIN pitching_stats ps ON p.id = ps.player_id AND ps.team_id = %s
                WHERE p.team_id = %s AND ps.pitching_war IS NOT NULL
                GROUP BY p.id, p.first_name, p.last_name, p.position
                ORDER BY total_war DESC
                LIMIT 10
            """, (team_id, team_id))
            pitching_top_10 = [
                {
                    "name": f"{r['first_name']} {r['last_name']}",
                    "position": r['position'],
                    "seasons": sorted(r['seasons'].split(',')) if r['seasons'] else [],
                    "total_war": round(r['total_war'], 2)
                } for r in cur.fetchall()
            ]

            best_players = {
                "batting": offensive_top_10,
                "pitching": pitching_top_10
            }

            # ============ WAR BY SEASON ============
            war_by_season = []
            for season in seasons:
                cur.execute("""
                    SELECT COALESCE(SUM(offensive_war), 0) as total_owar
                    FROM batting_stats
                    WHERE team_id = %s AND season = %s
                """, (team_id, season))
                owar_result = cur.fetchone()
                total_owar = owar_result['total_owar'] if owar_result else 0

                cur.execute("""
                    SELECT COALESCE(SUM(pitching_war), 0) as total_pwar
                    FROM pitching_stats
                    WHERE team_id = %s AND season = %s
                """, (team_id, season))
                pwar_result = cur.fetchone()
                total_pwar = pwar_result['total_pwar'] if pwar_result else 0

                war_by_season.append({
                    "season": season,
                    "total_owar": round(float(total_owar), 2),
                    "total_pwar": round(float(total_pwar), 2),
                    "total_war": round(float(total_owar) + float(total_pwar), 2)
                })

            # ============ COACHING STAFF ============
            coaching_staff = []
            try:
                cur.execute("SAVEPOINT coaches_sp")
                cur.execute("""
                    SELECT name, title, role, photo_url, email, alma_mater, years_at_school, bio
                    FROM coaches
                    WHERE team_id = %s
                    ORDER BY
                        CASE WHEN role = 'head_coach' THEN 0
                             WHEN role = 'pitching' THEN 1
                             WHEN role = 'hitting' THEN 2
                             WHEN role = 'assistant' THEN 3
                             ELSE 4 END,
                        name
                """, (team_id,))
                coaching_staff = [dict(r) for r in cur.fetchall()]
                cur.execute("RELEASE SAVEPOINT coaches_sp")
            except Exception:
                cur.execute("ROLLBACK TO SAVEPOINT coaches_sp")  # Keep transaction usable

            # ============ RATINGS PLACEHOLDER ============
            ratings = {
                "field": None,
                "coaching": None,
                "facilities": None,
                "academics": None,
                "fan_support": None,
                "location": None,
                "competitiveness": None
            }

            # ============ ASSEMBLE RESPONSE ============
            return {
                "team_info": team_info,
                "season_records": season_records,
                "season_stats": season_stats,
                "roster_overview": roster_overview,
                "freshman_production": freshman_production,
                "roster_composition": roster_composition,
                "redshirt_rate": redshirt_rate,
                "avg_size_by_position": avg_size_by_position,
                "player_hometowns": player_hometowns,
                "hometown_breakdown": hometown_breakdown,
                "best_players": best_players,
                "war_by_season": war_by_season,
                "coaching_staff": coaching_staff,
                "ratings": ratings
            }

    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse(content={"error": str(e)}, status_code=500)


# ============================================================
# RECRUITING BREAKDOWN
# ============================================================

@router.get("/recruiting/breakdown")
def recruiting_breakdown(season: int = 2026):
    """
    Team-level recruiting breakdown table.
    Returns per-team: record, W-L%, 3-year trend, freshman PA%, freshman IP%,
    WAR/G, team wRC+, team FIP, with division info.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # 1) Current season records + W-L% for current and prior 2 seasons
        cur.execute("""
            SELECT tss.team_id, t.name, t.short_name, t.logo_url,
                   d.level AS division,
                   tss.season, tss.wins, tss.losses
            FROM team_season_stats tss
            JOIN teams t ON tss.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE tss.season BETWEEN %s AND %s
              AND t.is_active = 1
              AND t.state IN ('WA', 'OR', 'ID', 'MT', 'BC')
            ORDER BY tss.team_id, tss.season
        """, (season - 2, season))
        records_rows = cur.fetchall()

        # Build per-team record data
        team_records = {}  # team_id -> {season -> {wins, losses}}
        team_info = {}     # team_id -> {name, short_name, logo_url, division}
        for r in records_rows:
            tid = r["team_id"]
            if tid not in team_info:
                team_info[tid] = {
                    "team_id": tid,
                    "name": r["name"],
                    "short_name": r["short_name"],
                    "logo_url": r["logo_url"],
                    "division": r["division"],
                }
            if tid not in team_records:
                team_records[tid] = {}
            s = r["season"]
            w, l = r["wins"] or 0, r["losses"] or 0
            team_records[tid][s] = {"wins": w, "losses": l, "win_pct": round(w / (w + l), 3) if (w + l) > 0 else 0}

        # Only include teams that have current season data
        active_teams = [tid for tid in team_records if season in team_records[tid]]

        if not active_teams:
            return []

        placeholders = ",".join(["%s"] * len(active_teams))

        # 2) Freshman PA% - Fr + R-Fr plate appearances as % of team total
        cur.execute(f"""
            SELECT bs.team_id,
                   SUM(CASE WHEN p.year_in_school IN ('Fr', 'R-Fr') THEN bs.plate_appearances ELSE 0 END) AS fr_pa,
                   SUM(bs.plate_appearances) AS total_pa
            FROM batting_stats bs
            JOIN players p ON bs.player_id = p.id
            WHERE bs.season = %s AND bs.team_id IN ({placeholders})
            GROUP BY bs.team_id
        """, [season] + active_teams)
        fr_pa_data = {r["team_id"]: {"fr_pa": r["fr_pa"] or 0, "total_pa": r["total_pa"] or 0} for r in cur.fetchall()}

        # 3) Freshman IP% - Fr + R-Fr innings as % of team total
        cur.execute(f"""
            SELECT ps.team_id,
                   SUM(CASE WHEN p.year_in_school IN ('Fr', 'R-Fr') THEN ps.innings_pitched ELSE 0 END) AS fr_ip,
                   SUM(ps.innings_pitched) AS total_ip
            FROM pitching_stats ps
            JOIN players p ON ps.player_id = p.id
            WHERE ps.season = %s AND ps.team_id IN ({placeholders})
            GROUP BY ps.team_id
        """, [season] + active_teams)
        fr_ip_data = {r["team_id"]: {"fr_ip": float(r["fr_ip"] or 0), "total_ip": float(r["total_ip"] or 0)} for r in cur.fetchall()}

        # 4) Team WAR totals (offensive + pitching) and games played
        cur.execute(f"""
            SELECT bs.team_id, SUM(COALESCE(bs.offensive_war, 0)) AS total_owar,
                   MAX(tss.wins) + MAX(tss.losses) AS games
            FROM batting_stats bs
            JOIN team_season_stats tss ON bs.team_id = tss.team_id AND bs.season = tss.season
            WHERE bs.season = %s AND bs.team_id IN ({placeholders})
            GROUP BY bs.team_id
        """, [season] + active_teams)
        owar_data = {r["team_id"]: {"owar": float(r["total_owar"] or 0), "games": r["games"] or 0} for r in cur.fetchall()}

        cur.execute(f"""
            SELECT ps.team_id, SUM(COALESCE(ps.pitching_war, 0)) AS total_pwar
            FROM pitching_stats ps
            WHERE ps.season = %s AND ps.team_id IN ({placeholders})
            GROUP BY ps.team_id
        """, [season] + active_teams)
        pwar_data = {r["team_id"]: float(r["total_pwar"] or 0) for r in cur.fetchall()}

        # 5) Team avg wRC+ (weighted by PA)
        cur.execute(f"""
            SELECT bs.team_id,
                   SUM(bs.wrc_plus * bs.plate_appearances) / NULLIF(SUM(bs.plate_appearances), 0) AS avg_wrc_plus
            FROM batting_stats bs
            WHERE bs.season = %s AND bs.team_id IN ({placeholders})
              AND bs.plate_appearances >= 20
              AND bs.wrc_plus IS NOT NULL
            GROUP BY bs.team_id
        """, [season] + active_teams)
        wrc_data = {r["team_id"]: round(float(r["avg_wrc_plus"]), 1) if r["avg_wrc_plus"] else None for r in cur.fetchall()}

        # 6) Team avg FIP (weighted by IP)
        cur.execute(f"""
            SELECT ps.team_id,
                   SUM(ps.fip * ps.innings_pitched) / NULLIF(SUM(ps.innings_pitched), 0) AS avg_fip
            FROM pitching_stats ps
            WHERE ps.season = %s AND ps.team_id IN ({placeholders})
              AND ps.innings_pitched >= 5
              AND ps.fip IS NOT NULL
            GROUP BY ps.team_id
        """, [season] + active_teams)
        fip_data = {r["team_id"]: round(float(r["avg_fip"]), 2) if r["avg_fip"] else None for r in cur.fetchall()}

        # 7) National composite rankings (D1/D2/D3/NAIA)
        cur.execute(f"""
            SELECT team_id, composite_rank
            FROM composite_rankings
            WHERE season = %s AND team_id IN ({placeholders})
        """, [season] + active_teams)
        rank_data = {r["team_id"]: int(r["composite_rank"]) if r["composite_rank"] else None for r in cur.fetchall()}

        # 8) PPI rankings for NWAC (no national rankings available)
        #    Compute PPI inline: rank JUCO teams by WAR/G within NWAC
        juco_teams = [tid for tid in active_teams if team_info[tid]["division"] == "JUCO"]
        ppi_data = {}
        if juco_teams:
            # Use WAR + win_pct to create a simple PPI rank
            juco_scores = []
            for tid in juco_teams:
                oinfo = owar_data.get(tid, {"owar": 0, "games": 0})
                pw = pwar_data.get(tid, 0)
                g = oinfo["games"]
                wpct = team_records[tid].get(season, {}).get("win_pct", 0)
                warg = (oinfo["owar"] + pw) / g if g > 0 else 0
                # Composite: 50% WAR/G + 50% W-L%
                score = warg * 0.5 + wpct * 0.5
                juco_scores.append((tid, score))
            juco_scores.sort(key=lambda x: x[1], reverse=True)
            for rank, (tid, _) in enumerate(juco_scores, 1):
                ppi_data[tid] = rank

        # Build the response
        results = []
        for tid in active_teams:
            info = team_info[tid]
            rec = team_records[tid]
            curr = rec.get(season, {})
            prev1 = rec.get(season - 1, {})
            prev2 = rec.get(season - 2, {})

            # 3-year trend: weighted linear trend of W-L%
            # Use simple difference: current - average of prior 2 (if available)
            trend_seasons = []
            if prev2 and prev2.get("wins", 0) + prev2.get("losses", 0) > 0:
                trend_seasons.append(prev2["win_pct"])
            if prev1 and prev1.get("wins", 0) + prev1.get("losses", 0) > 0:
                trend_seasons.append(prev1["win_pct"])

            trend = None
            if trend_seasons:
                prior_avg = sum(trend_seasons) / len(trend_seasons)
                trend = round(curr.get("win_pct", 0) - prior_avg, 3)

            # Freshman PA%
            fpa = fr_pa_data.get(tid, {})
            fr_pa_pct = round(fpa.get("fr_pa", 0) / fpa["total_pa"] * 100, 1) if fpa.get("total_pa", 0) > 0 else 0

            # Freshman IP%
            fip_ip = fr_ip_data.get(tid, {})
            fr_ip_pct = round(fip_ip.get("fr_ip", 0) / fip_ip["total_ip"] * 100, 1) if fip_ip.get("total_ip", 0) > 0 else 0

            # WAR/G
            owar_info = owar_data.get(tid, {"owar": 0, "games": 0})
            pwar_val = pwar_data.get(tid, 0)
            total_war = owar_info["owar"] + pwar_val
            games = owar_info["games"]
            war_per_game = round(total_war / games, 2) if games > 0 else 0

            results.append({
                "team_id": tid,
                "name": info["name"],
                "short_name": info["short_name"],
                "logo_url": info["logo_url"],
                "division": info["division"],
                "wins": curr.get("wins", 0),
                "losses": curr.get("losses", 0),
                "win_pct": curr.get("win_pct", 0),
                "prev1_win_pct": prev1.get("win_pct") if prev1 else None,
                "prev2_win_pct": prev2.get("win_pct") if prev2 else None,
                "trend": trend,
                "fr_pa_pct": fr_pa_pct,
                "fr_ip_pct": fr_ip_pct,
                "war_per_game": war_per_game,
                "team_wrc_plus": wrc_data.get(tid),
                "team_fip": fip_data.get(tid),
                "games": games,
                "total_war": round(total_war, 1),
                "national_rank": rank_data.get(tid),
                "ppi_rank": ppi_data.get(tid),
            })

        # Sort by win_pct descending by default
        results.sort(key=lambda x: x["win_pct"], reverse=True)
        return results


# ============================================================
# Team Stats Aggregation
# ============================================================

@router.get("/team-stats")
def team_stats_agg(
    season: int = Query(..., description="Season year"),
    stat_type: str = Query("hitting", description="'hitting' or 'pitching'"),
    level: str = Query("all", description="Division level filter: all, D1, D2, D3, NAIA, JUCO"),
):
    """
    Aggregated team-level stats for all teams in a season.
    Returns one row per team with all available stats.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        if stat_type == "hitting":
            cur.execute("""
                SELECT
                    t.id as team_id,
                    t.short_name as team_name,
                    t.logo_url,
                    c.name as conference_name,
                    c.abbreviation as conference_abbrev,
                    d.level as division_level,
                    COALESCE(s.wins, 0) as wins,
                    COALESCE(s.losses, 0) as losses,
                    -- Counting stats
                    SUM(b.games) as games,
                    SUM(b.plate_appearances) as pa,
                    SUM(b.at_bats) as ab,
                    SUM(b.runs) as r,
                    SUM(b.hits) as h,
                    SUM(b.doubles) as "2b",
                    SUM(b.triples) as "3b",
                    SUM(b.home_runs) as hr,
                    SUM(b.rbi) as rbi,
                    SUM(b.walks) as bb,
                    SUM(b.strikeouts) as so,
                    SUM(b.hit_by_pitch) as hbp,
                    SUM(b.sacrifice_flies) as sf,
                    SUM(b.sacrifice_bunts) as sh,
                    SUM(b.stolen_bases) as sb,
                    SUM(b.caught_stealing) as cs,
                    SUM(b.grounded_into_dp) as gdp,
                    -- Rate stats (weighted by PA or AB)
                    CASE WHEN SUM(b.at_bats) > 0
                         THEN ROUND(SUM(b.hits)::numeric / SUM(b.at_bats), 3)
                         ELSE NULL END as avg,
                    CASE WHEN SUM(b.plate_appearances) > 0
                         THEN ROUND((SUM(b.hits) + SUM(b.walks) + SUM(COALESCE(b.hit_by_pitch,0)))::numeric
                              / SUM(b.plate_appearances), 3)
                         ELSE NULL END as obp,
                    CASE WHEN SUM(b.at_bats) > 0
                         THEN ROUND((SUM(b.hits) + SUM(b.doubles) + 2*SUM(b.triples) + 3*SUM(b.home_runs))::numeric
                              / SUM(b.at_bats), 3)
                         ELSE NULL END as slg,
                    CASE WHEN SUM(b.at_bats) > 0 AND SUM(b.plate_appearances) > 0
                         THEN ROUND(
                              (SUM(b.hits) + SUM(b.walks) + SUM(COALESCE(b.hit_by_pitch,0)))::numeric / SUM(b.plate_appearances)
                              + (SUM(b.hits) + SUM(b.doubles) + 2*SUM(b.triples) + 3*SUM(b.home_runs))::numeric / SUM(b.at_bats),
                              3)
                         ELSE NULL END as ops,
                    CASE WHEN SUM(b.at_bats) > 0
                         THEN ROUND(
                              ((SUM(b.hits) + SUM(b.doubles) + 2*SUM(b.triples) + 3*SUM(b.home_runs))::numeric / SUM(b.at_bats))
                              - (SUM(b.hits)::numeric / SUM(b.at_bats)),
                              3)
                         ELSE NULL END as iso,
                    CASE WHEN (SUM(b.at_bats) - SUM(b.strikeouts) - SUM(b.home_runs) + SUM(COALESCE(b.sacrifice_flies,0))) > 0
                         THEN ROUND(
                              (SUM(b.hits) - SUM(b.home_runs))::numeric
                              / (SUM(b.at_bats) - SUM(b.strikeouts) - SUM(b.home_runs) + SUM(COALESCE(b.sacrifice_flies,0))),
                              3)
                         ELSE NULL END as babip,
                    CASE WHEN SUM(b.plate_appearances) > 0
                         THEN ROUND(SUM(b.walks)::numeric / SUM(b.plate_appearances) * 100, 1)
                         ELSE NULL END as bb_pct,
                    CASE WHEN SUM(b.plate_appearances) > 0
                         THEN ROUND(SUM(b.strikeouts)::numeric / SUM(b.plate_appearances) * 100, 1)
                         ELSE NULL END as k_pct,
                    -- Weighted advanced stats (PA-weighted averages with NULL guards).
                    -- Denominator CASE must ALSO require the stat IS NOT NULL, otherwise
                    -- NULL-stat rows add PA to the denominator only and deflate the mean.
                    CASE WHEN SUM(CASE WHEN b.plate_appearances >= 10 AND b.wrc_plus IS NOT NULL THEN b.plate_appearances ELSE 0 END) > 0
                         THEN ROUND(
                              SUM(CASE WHEN b.plate_appearances >= 10 AND b.wrc_plus IS NOT NULL THEN b.wrc_plus * b.plate_appearances ELSE 0 END)::numeric
                              / SUM(CASE WHEN b.plate_appearances >= 10 AND b.wrc_plus IS NOT NULL THEN b.plate_appearances ELSE 0 END),
                              1)
                         ELSE NULL END as wrc_plus,
                    CASE WHEN SUM(CASE WHEN b.plate_appearances >= 10 AND b.woba IS NOT NULL THEN b.plate_appearances ELSE 0 END) > 0
                         THEN ROUND(
                              SUM(CASE WHEN b.plate_appearances >= 10 AND b.woba IS NOT NULL THEN b.woba * b.plate_appearances ELSE 0 END)::numeric
                              / SUM(CASE WHEN b.plate_appearances >= 10 AND b.woba IS NOT NULL THEN b.plate_appearances ELSE 0 END),
                              3)
                         ELSE NULL END as woba,
                    ROUND(SUM(COALESCE(b.wraa, 0))::numeric, 1) as wraa,
                    ROUND(SUM(COALESCE(b.wrc, 0))::numeric, 1) as wrc,
                    ROUND(SUM(COALESCE(b.offensive_war, 0))::numeric, 1) as owar
                FROM teams t
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
                LEFT JOIN batting_stats b ON b.team_id = t.id AND b.season = %s
                WHERE t.is_active = 1
                  AND t.state IN ('WA', 'OR', 'ID', 'MT', 'BC')
                GROUP BY t.id, t.short_name, t.logo_url, c.name, c.abbreviation,
                         d.level, s.wins, s.losses
                HAVING SUM(b.plate_appearances) > 0
                ORDER BY t.short_name
            """, (season, season))
        else:
            # Pitching: straight SUM of pitching_stats, same as what each team's
            # own stats page reports. No box-score reconciliation — historically
            # that caused inflated totals when game_pitching had orphan rows for
            # unmatched pitchers OR duplicate rows from two scrapers writing the
            # same pitcher under different name formats. pitching_stats IS the
            # source of truth for team aggregation.
            cur.execute("""
                WITH team_ps AS (
                    SELECT ps.team_id,
                           SUM(COALESCE(ps.games, 0))              AS g,
                           SUM(COALESCE(ps.games_started, 0))      AS gs,
                           SUM(COALESCE(ps.wins, 0))               AS w,
                           SUM(COALESCE(ps.losses, 0))             AS l,
                           SUM(COALESCE(ps.saves, 0))              AS sv,
                           SUM(COALESCE(ps.complete_games, 0))     AS cg,
                           SUM(COALESCE(ps.shutouts, 0))           AS sho,
                           SUM(COALESCE(ps.innings_pitched, 0))    AS ip,
                           SUM(COALESCE(ps.hits_allowed, 0))       AS h,
                           SUM(COALESCE(ps.runs_allowed, 0))       AS r,
                           SUM(COALESCE(ps.earned_runs, 0))        AS er,
                           SUM(COALESCE(ps.walks, 0))              AS bb,
                           SUM(COALESCE(ps.strikeouts, 0))         AS k,
                           SUM(COALESCE(ps.home_runs_allowed, 0))  AS hr,
                           SUM(COALESCE(ps.hit_batters, 0))        AS hbp,
                           SUM(COALESCE(ps.wild_pitches, 0))       AS wp,
                           SUM(COALESCE(ps.batters_faced, 0))      AS bf,
                           ROUND(SUM(COALESCE(ps.pitching_war, 0))::numeric, 1) AS pwar,
                           -- IP-weighted advanced stat numerators and denominators
                           SUM(CASE WHEN ps.innings_pitched >= 3 AND ps.fip IS NOT NULL
                                    THEN ps.fip * ps.innings_pitched ELSE 0 END) AS fip_num,
                           SUM(CASE WHEN ps.innings_pitched >= 3 AND ps.fip IS NOT NULL
                                    THEN ps.innings_pitched ELSE 0 END) AS fip_den,
                           SUM(CASE WHEN ps.innings_pitched >= 3 AND ps.xfip IS NOT NULL
                                    THEN ps.xfip * ps.innings_pitched ELSE 0 END) AS xfip_num,
                           SUM(CASE WHEN ps.innings_pitched >= 3 AND ps.xfip IS NOT NULL
                                    THEN ps.innings_pitched ELSE 0 END) AS xfip_den,
                           SUM(CASE WHEN ps.innings_pitched >= 3 AND (ps.siera IS NOT NULL OR ps.fip IS NOT NULL)
                                    THEN COALESCE(ps.siera, ps.fip) * ps.innings_pitched ELSE 0 END) AS siera_num,
                           SUM(CASE WHEN ps.innings_pitched >= 3 AND (ps.siera IS NOT NULL OR ps.fip IS NOT NULL)
                                    THEN ps.innings_pitched ELSE 0 END) AS siera_den
                    FROM pitching_stats ps
                    WHERE ps.season = %s
                    GROUP BY ps.team_id
                )
                SELECT
                    t.id as team_id,
                    t.short_name as team_name,
                    t.logo_url,
                    c.name as conference_name,
                    c.abbreviation as conference_abbrev,
                    d.level as division_level,
                    COALESCE(s.wins, 0) as wins,
                    COALESCE(s.losses, 0) as losses,
                    -- Counting stats
                    tp.g, tp.gs, tp.w, tp.l, tp.sv, tp.cg, tp.sho,
                    ROUND(tp.ip::numeric, 1) as ip,
                    tp.h, tp.r AS r, tp.er, tp.bb, tp.k as so,
                    tp.hr, tp.hbp, tp.wp, tp.bf,
                    -- Rate stats
                    CASE WHEN tp.ip > 0
                         THEN ROUND((tp.er * 9.0 / tp.ip)::numeric, 2)
                         ELSE NULL END as era,
                    CASE WHEN tp.ip > 0
                         THEN ROUND(((tp.bb + tp.h)::numeric / tp.ip)::numeric, 2)
                         ELSE NULL END as whip,
                    CASE WHEN tp.ip > 0
                         THEN ROUND((tp.k * 9.0 / tp.ip)::numeric, 1)
                         ELSE NULL END as k_per_9,
                    CASE WHEN tp.ip > 0
                         THEN ROUND((tp.bb * 9.0 / tp.ip)::numeric, 1)
                         ELSE NULL END as bb_per_9,
                    CASE WHEN tp.ip > 0
                         THEN ROUND((tp.h * 9.0 / tp.ip)::numeric, 1)
                         ELSE NULL END as h_per_9,
                    CASE WHEN tp.ip > 0
                         THEN ROUND((tp.hr * 9.0 / tp.ip)::numeric, 2)
                         ELSE NULL END as hr_per_9,
                    CASE WHEN tp.bb > 0
                         THEN ROUND((tp.k::numeric / tp.bb)::numeric, 2)
                         ELSE NULL END as k_bb,
                    CASE WHEN tp.bf > 0
                         THEN ROUND(tp.k::numeric / tp.bf * 100, 1)
                         ELSE NULL END as k_pct,
                    CASE WHEN tp.bf > 0
                         THEN ROUND(tp.bb::numeric / tp.bf * 100, 1)
                         ELSE NULL END as bb_pct,
                    -- Opponent batting average (H / (BF - BB - HBP))
                    CASE WHEN (tp.bf - tp.bb - tp.hbp) > 0
                         THEN ROUND(tp.h::numeric / (tp.bf - tp.bb - tp.hbp), 3)
                         ELSE NULL END as opp_avg,
                    -- Weighted advanced stats (IP-weighted averages from pitching_stats)
                    CASE WHEN tp.fip_den > 0
                         THEN ROUND((tp.fip_num / tp.fip_den)::numeric, 2)
                         ELSE NULL END as fip,
                    CASE WHEN tp.xfip_den > 0
                         THEN ROUND((tp.xfip_num / tp.xfip_den)::numeric, 2)
                         ELSE NULL END as xfip,
                    CASE WHEN tp.siera_den > 0
                         THEN ROUND((tp.siera_num / tp.siera_den)::numeric, 2)
                         ELSE NULL END as siera,
                    -- Team BABIP-against from pitching_stats totals.
                    CASE WHEN (tp.bf - tp.bb - tp.hbp - tp.k - tp.hr) > 0
                           AND (tp.h - tp.hr) >= 0
                         THEN ROUND(((tp.h - tp.hr)::numeric
                              / (tp.bf - tp.bb - tp.hbp - tp.k - tp.hr))::numeric, 3)
                         ELSE NULL END as babip,
                    tp.pwar as pwar
                FROM teams t
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
                JOIN team_ps tp ON tp.team_id = t.id
                WHERE t.is_active = 1
                  AND t.state IN ('WA', 'OR', 'ID', 'MT', 'BC')
                  AND tp.ip > 0
                ORDER BY t.short_name
            """, (season, season))

        rows = cur.fetchall()

        # Apply level filter
        if level and level != "all":
            rows = [r for r in rows if r["division_level"] == level]

        return rows


# ── Opponent Trends (Coaching Tool) ─────────────────────────────────────

@router.get("/opponent-trends/{team_id}")
def opponent_trends(
    team_id: int,
    season: int = Query(2026, description="Season year"),
):
    """
    Comprehensive opponent scouting report.
    Builds best-guess starting lineups (unique 9 players) vs LHP/RHP and
    by game number (1-4).  Pitching: rotation, bullpen, predictions.
    Recent games weighted via exponential decay (half-life 10 games).
    """
    from collections import defaultdict, Counter
    import re

    def normalize_name(name):
        """Normalize player names to 'First Last' format.
        Handles: 'Last, First' → 'First Last'
        Strips extra whitespace.
        """
        if not name:
            return name
        name = name.strip()
        if ',' in name:
            parts = name.split(',', 1)
            name = parts[1].strip() + ' ' + parts[0].strip()
        return name

    def build_name_alias_map(names):
        """Build a mapping from abbreviated names (like 'A. Takuma')
        to their full version ('Aiden Takuma') when possible.
        Only maps when there's exactly one matching full name.
        """
        alias = {}
        full_names = [n for n in names if not re.match(r'^[A-Z]\.\s', n)]
        abbrev_names = [n for n in names if re.match(r'^[A-Z]\.\s', n)]
        for abbr in abbrev_names:
            initial = abbr[0]
            last = abbr.split(' ', 1)[1] if ' ' in abbr else ''
            matches = [fn for fn in full_names
                       if fn.startswith(initial) and fn.endswith(last)
                       and ' ' in fn and fn.split(' ', 1)[1] == last]
            if len(matches) == 1:
                alias[abbr] = matches[0]
        return alias

    with get_connection() as conn:
        cur = conn.cursor()

        # ── Team info ──
        cur.execute("""
            SELECT t.id, t.name, t.short_name, t.logo_url,
                   c.name as conference_name, c.abbreviation as conf_abbrev,
                   d.level as division_level
            FROM teams t
            LEFT JOIN conferences c ON t.conference_id = c.id
            LEFT JOIN divisions d ON c.division_id = d.id
            WHERE t.id = %s
        """, (team_id,))
        team = cur.fetchone()
        if not team:
            raise HTTPException(status_code=404, detail="Team not found")
        team = dict(team)

        # ── All final games for this team this season ──
        cur.execute("""
            SELECT g.id, g.game_date, g.game_number, g.home_team_id, g.away_team_id,
                   g.home_score, g.away_score, g.is_conference_game,
                   COALESCE(ht.short_name, ht.name) AS home_short,
                   COALESCE(at2.short_name, at2.name) AS away_short
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at2 ON g.away_team_id = at2.id
            WHERE (g.home_team_id = %s OR g.away_team_id = %s)
              AND g.season = %s AND g.status = 'final'
              AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
            ORDER BY g.game_date ASC, g.game_number ASC, g.id ASC
        """, (team_id, team_id, season))
        all_games = [dict(r) for r in cur.fetchall()]

        if not all_games:
            return {"team": team, "games_analyzed": 0,
                    "lineup_trends": None, "pitching_trends": None}

        game_ids = [g["id"] for g in all_games]

        # ── Enrich: opponent, series detection ──
        opp_games = defaultdict(list)
        for g in all_games:
            opp_id = g["away_team_id"] if g["home_team_id"] == team_id else g["home_team_id"]
            g["opponent_id"] = opp_id
            g["opponent_name"] = g["away_short"] if g["home_team_id"] == team_id else g["home_short"]
            g["is_home"] = g["home_team_id"] == team_id
            opp_games[opp_id].append(g)

        for opp_id, games in opp_games.items():
            games.sort(key=lambda gg: (gg["game_date"], gg.get("game_number") or 1, gg["id"]))
            cur_ser = [games[0]]
            for i in range(1, len(games)):
                if (games[i]["game_date"] - cur_ser[-1]["game_date"]).days > 4:
                    for idx, sg in enumerate(cur_ser):
                        sg["series_game_num"] = idx + 1
                        sg["series_length"] = len(cur_ser)
                    cur_ser = [games[i]]
                else:
                    cur_ser.append(games[i])
            for idx, sg in enumerate(cur_ser):
                sg["series_game_num"] = idx + 1
                sg["series_length"] = len(cur_ser)

        all_ge = []
        for games in opp_games.values():
            all_ge.extend(games)
        all_ge.sort(key=lambda gg: (gg["game_date"], gg.get("game_number") or 1))

        # ── Recency weights (half-life 7 games) ──
        # Tighter than before (was 10) so a player returning from injury
        # and playing the last 5-7 games outweighs a guy who started
        # earlier in the season.
        n_games = len(all_ge)
        gw = {}
        for i, g in enumerate(all_ge):
            gw[g["id"]] = 2 ** (-(n_games - 1 - i) / 7)

        # ── Bulk fetch batting — DEDUPLICATE per game ──
        ph = ",".join(["%s"] * len(game_ids))
        cur.execute(f"""
            SELECT gb.game_id, gb.player_id, gb.player_name, gb.team_id,
                   gb.batting_order, gb.position,
                   gb.at_bats, gb.hits, gb.runs, gb.rbi,
                   gb.doubles, gb.triples, gb.home_runs,
                   gb.walks, gb.strikeouts, gb.hit_by_pitch,
                   gb.stolen_bases, gb.caught_stealing,
                   gb.sacrifice_flies, gb.sacrifice_bunts
            FROM game_batting gb
            WHERE gb.game_id IN ({ph}) AND gb.team_id = %s
            ORDER BY gb.game_id, gb.batting_order
        """, game_ids + [team_id])
        raw_batting = [dict(r) for r in cur.fetchall()]

        # Normalize all player names in batting data
        for b in raw_batting:
            b["player_name"] = normalize_name(b["player_name"])

        # (Deduplication happens after alias resolution below)

        # ── Bulk fetch pitching ──
        cur.execute(f"""
            SELECT gp.game_id, gp.player_id, gp.player_name, gp.team_id,
                   gp.pitch_order, gp.is_starter, gp.innings_pitched,
                   gp.hits_allowed, gp.runs_allowed, gp.earned_runs,
                   gp.walks, gp.strikeouts, gp.home_runs_allowed,
                   gp.hit_batters, gp.batters_faced, gp.pitches_thrown,
                   gp.decision, gp.is_quality_start, gp.game_score
            FROM game_pitching gp
            WHERE gp.game_id IN ({ph}) AND gp.team_id = %s
            ORDER BY gp.game_id, gp.pitch_order
        """, game_ids + [team_id])
        raw_pitching = [dict(r) for r in cur.fetchall()]

        # Normalize all player names in pitching data
        for p in raw_pitching:
            p["player_name"] = normalize_name(p["player_name"])

        # (Deduplication happens after alias resolution below)

        # ── Opposing starters (for LHP/RHP) ──
        cur.execute(f"""
            SELECT gp.game_id, gp.player_name, p.throws
            FROM game_pitching gp
            LEFT JOIN players p ON gp.player_id = p.id
            WHERE gp.game_id IN ({ph})
              AND gp.team_id != %s AND gp.is_starter = true
        """, game_ids + [team_id])
        opp_starters = {}
        for r in cur.fetchall():
            opp_starters[r["game_id"]] = {
                "name": r["player_name"],
                "throws": (r["throws"] or "").upper() if r["throws"] else None,
            }

        # ── Pitcher names set (exclude from def subs) ──
        pitcher_names = set()
        for p in raw_pitching:
            pitcher_names.add(p["player_name"])  # already normalized

        # ── Player info ──
        cur.execute("SELECT id, throws, bats FROM players WHERE team_id = %s", (team_id,))
        player_info = {r["id"]: {"throws": r["throws"], "bats": r["bats"]}
                       for r in cur.fetchall()}

        # ── Canonicalize every row using player_id as the source of truth ──
        # The box-score scraper tags most rows with the correct player_id even
        # when the displayed name is abbreviated or reversed. Before any dedup
        # or aggregation, overwrite player_name with the canonical "First Last"
        # from the players table. Rows missing a player_id are fuzzy-matched
        # against the same canonical map so truncated/garbled names still
        # collapse into the real player. This kills the root cause of the
        # Mana Heffernan / M. Heffernan style duplicates.
        player_ids_seen = {b["player_id"] for b in raw_batting if b.get("player_id")}
        player_ids_seen.update(p["player_id"] for p in raw_pitching if p.get("player_id"))

        canonical_name_by_id = {}
        if player_ids_seen:
            ph_pid = ",".join(["%s"] * len(player_ids_seen))
            cur.execute(f"""
                SELECT id, first_name, last_name
                FROM players
                WHERE id IN ({ph_pid})
            """, list(player_ids_seen))
            for r in cur.fetchall():
                first = (r["first_name"] or "").strip()
                last = (r["last_name"] or "").strip()
                full = (first + " " + last).strip()
                if full:
                    canonical_name_by_id[r["id"]] = full

        def _strip_prefix_junk(s):
            """Strip leading non-letter characters (stray HTML, bullets, etc.)."""
            return re.sub(r'^[^A-Za-z]+', '', s or '').strip()

        def resolve_raw_name(raw_name):
            """Best-effort match of a raw name against canonical_name_by_id.
            Handles truncation ('Siniscalc' vs 'Siniscalchi'), initials
            ('L. Siniscalchi'), 'Last, First', and leading junk characters.
            Returns (player_id, full_name) or (None, None) if ambiguous."""
            if not raw_name or not canonical_name_by_id:
                return (None, None)
            name = _strip_prefix_junk(normalize_name(raw_name))
            if not name:
                return (None, None)
            nl = name.lower()
            # Exact match
            for pid, full in canonical_name_by_id.items():
                if full.lower() == nl:
                    return (pid, full)
            # "F. Last" / "F Last" form — allow last-name truncation on either side
            m = re.match(r'^([A-Za-z])\.?\s*(.+)$', name)
            if m:
                initial = m.group(1).lower()
                last_raw = m.group(2).strip().lower()
                matches = []
                for pid, full in canonical_name_by_id.items():
                    parts = full.split(None, 1)
                    if len(parts) < 2:
                        continue
                    f_first, f_last = parts[0].lower(), parts[1].lower()
                    if not f_first.startswith(initial):
                        continue
                    if f_last.startswith(last_raw) or last_raw.startswith(f_last):
                        matches.append((pid, full))
                if len(matches) == 1:
                    return matches[0]
            # Last-name-only prefix match (rare, but covers edge truncation)
            matches = []
            for pid, full in canonical_name_by_id.items():
                parts = full.split(None, 1)
                if len(parts) < 2:
                    continue
                f_last = parts[1].lower()
                if f_last.startswith(nl) or nl.startswith(f_last):
                    matches.append((pid, full))
            if len(matches) == 1:
                return matches[0]
            return (None, None)

        # Apply canonical names to every batting/pitching row in place
        for row in raw_batting:
            pid = row.get("player_id")
            if pid and pid in canonical_name_by_id:
                row["player_name"] = canonical_name_by_id[pid]
                continue
            rpid, rname = resolve_raw_name(row.get("player_name"))
            if rpid:
                row["player_id"] = rpid
                row["player_name"] = rname
            else:
                row["player_name"] = _strip_prefix_junk(normalize_name(row.get("player_name") or ""))
        for row in raw_pitching:
            pid = row.get("player_id")
            if pid and pid in canonical_name_by_id:
                row["player_name"] = canonical_name_by_id[pid]
                continue
            rpid, rname = resolve_raw_name(row.get("player_name"))
            if rpid:
                row["player_id"] = rpid
                row["player_name"] = rname
            else:
                row["player_name"] = _strip_prefix_junk(normalize_name(row.get("player_name") or ""))

        # Rebuild the pitcher_names set with canonical names
        pitcher_names = {p["player_name"] for p in raw_pitching if p.get("player_name")}

        # ── Player PRIMARY position (single best position this season) ──
        # Built in-memory from the now-canonicalized batting rows so every
        # name variant for the same player contributes to one bucket.
        #
        # Each game contributes its recency weight (gw), not a flat +1, so
        # a player's RECENT position wins over his older one. Example: a
        # player who started at SS for 20 early games and then moved to 3B
        # for the last 7 games is classified as 3B because the recent
        # games outweigh the older ones.
        _pos_counts = defaultdict(lambda: defaultdict(float))
        for b in raw_batting:
            if (b.get("batting_order") or 0) > 9:
                continue
            raw_pos = (b.get("position") or "").upper().strip()
            if raw_pos in ("PH", "PR", "CR", "P", ""):
                continue
            # Split slashed positions (e.g. "CF/RF") and take the primary
            primary_pos = raw_pos.split('/')[0].strip() if '/' in raw_pos else raw_pos
            w = gw.get(b["game_id"], 1.0)
            _pos_counts[b["player_name"]][primary_pos] += w
        player_primary_pos = {}
        for name, buckets in _pos_counts.items():
            if buckets:
                player_primary_pos[name] = max(buckets.items(), key=lambda kv: kv[1])[0]

        # Re-build deduplicated data after alias resolution
        batting_by_game = defaultdict(list)
        for b in raw_batting:
            batting_by_game[b["game_id"]].append(b)
        deduped_batting_by_game = defaultdict(list)
        for gid, batters in batting_by_game.items():
            seen_players = set()
            for b in sorted(batters, key=lambda x: x["batting_order"]):
                key = b["player_name"]
                if key in seen_players:
                    continue
                seen_players.add(key)
                deduped_batting_by_game[gid].append(b)

        pitching_by_game = defaultdict(list)
        for p in raw_pitching:
            pitching_by_game[p["game_id"]].append(p)
        deduped_pitching_by_game = defaultdict(list)
        for gid, pitchers in pitching_by_game.items():
            seen = set()
            for p in sorted(pitchers, key=lambda x: x["pitch_order"]):
                key = p["player_name"]
                if key in seen:
                    continue
                seen.add(key)
                deduped_pitching_by_game[gid].append(p)

        # ══════════════════════════════════════════════════════════════
        # CLASSIFY GAMES BY OPPOSING PITCHER HAND
        # ══════════════════════════════════════════════════════════════
        # Only classify when we KNOW the hand — don't lump unknown into RHP
        games_vs_rhp, games_vs_lhp, games_vs_unknown = [], [], []
        for g in all_ge:
            opp_sp = opp_starters.get(g["id"])
            hand = opp_sp["throws"] if opp_sp and opp_sp["throws"] else None
            g["opp_hand"] = hand
            if hand == "L":
                games_vs_lhp.append(g)
            elif hand == "R":
                games_vs_rhp.append(g)
            else:
                games_vs_unknown.append(g)

        # Games by series slot
        games_by_slot = defaultdict(list)
        for g in all_ge:
            slot = g.get("series_game_num", 1)
            if slot <= 4:
                games_by_slot[slot].append(g)

        # ══════════════════════════════════════════════════════════════
        # SMART LINEUP CONSTRUCTION — anchor dominant players first
        # ══════════════════════════════════════════════════════════════

        def build_best_lineup(game_list):
            """
            Build a best-guess starting 9 with UNIQUE players.

            Algorithm:
            1) For each player, find their most common lineup spot and
               how dominant they are there (% of starts at that spot).
            2) Sort by dominance — players who ALWAYS hit in one spot
               get locked in first (e.g. Fahland always 9th).
            3) Fill remaining spots with remaining players by weight.
            4) For each assigned row, compute alternates at the same
               defensive position. If the starter has < 65% share of
               that position's weighted starts, list up to 2 alts with
               >= 20% share ("Miyazawa/Richards" style).

            Excludes PH, PR, CR from lineup consideration.
            """
            if not game_list:
                return {"games_count": 0, "lineup": [], "bench": []}

            # Track: player -> spot -> weighted count
            player_spot_wt = defaultdict(lambda: defaultdict(float))
            player_total_wt = defaultdict(float)
            player_game_count = defaultdict(int)
            # position_wt[pos][name] = weighted starts at that defensive
            # position (across this game_list). Used AFTER the main
            # assignment to surface close position alternates.
            position_wt = defaultdict(lambda: defaultdict(float))

            for g in game_list:
                w = gw.get(g["id"], 1.0)
                seen_in_game = set()
                batters = deduped_batting_by_game.get(g["id"], [])
                for b in batters:
                    pos = (b["position"] or "").upper().strip()
                    if b["batting_order"] > 9 or pos in ("PH", "PR", "CR"):
                        continue
                    name = b["player_name"] or "Unknown"
                    if name in seen_in_game:
                        continue
                    seen_in_game.add(name)
                    spot = b["batting_order"]
                    player_spot_wt[name][spot] += w
                    player_total_wt[name] += w
                    player_game_count[name] += 1
                    # Track defensive-position starts (primary slot when
                    # the scraper recorded "CF/RF" we take CF).
                    if pos and pos != "P":
                        primary_pos = pos.split("/")[0].strip()
                        if primary_pos:
                            position_wt[primary_pos][name] += w

            if not player_spot_wt:
                return {"games_count": len(game_list), "lineup": [], "bench": []}

            # For each player, find their best spot and dominance score
            player_best = {}
            for name, spots in player_spot_wt.items():
                best_spot = max(spots, key=spots.get)
                best_wt = spots[best_spot]
                total = player_total_wt[name]
                dominance = best_wt / total if total > 0 else 0
                player_best[name] = {
                    "best_spot": best_spot,
                    "best_wt": best_wt,
                    "dominance": dominance,
                    "total_wt": total,
                    "games": player_game_count[name],
                }

            # Sort players by TOTAL WEIGHTED GAMES first — the guy who
            # started 39 of 42 games should be in the lineup, period,
            # even if he moves around the order. Tie-break by dominance
            # so a consistent player edges out a journeyman when they
            # have the same weighted game count.
            sorted_players = sorted(
                player_best.items(),
                key=lambda x: (x[1]["total_wt"], x[1]["dominance"]),
                reverse=True,
            )

            assigned = {}     # spot -> {name, pos, pct}
            used_players = set()
            # Enforce one player per defensive position (C, 1B, 2B, 3B,
            # SS, LF, CF, RF, DH). A team can only have one catcher in
            # the lineup, one shortstop, one DH, etc.
            used_positions = set()

            def spot_pct(name, spot, wt):
                spot_total = sum(
                    player_spot_wt[n][spot]
                    for n in player_spot_wt if spot in player_spot_wt[n]
                )
                return round(wt / spot_total * 100, 1) if spot_total else 0

            # Main pass: walk players best-to-worst by weighted starts,
            # and give each their best-remaining slot where the position
            # isn't already used. One pass, no phases.
            for name, info in sorted_players:
                if name in used_players:
                    continue
                pos = player_primary_pos.get(name, "")
                if pos and pos in used_positions:
                    continue

                # Candidate slots ranked by this player's weight at each
                slots_desc = sorted(
                    player_spot_wt[name].items(),
                    key=lambda kv: kv[1],
                    reverse=True,
                )
                for spot, wt in slots_desc:
                    if spot < 1 or spot > 9 or spot in assigned or wt <= 0:
                        continue
                    assigned[spot] = {
                        "player_name": name,
                        "position": pos,
                        "pct": spot_pct(name, spot, wt),
                    }
                    used_players.add(name)
                    if pos:
                        used_positions.add(pos)
                    break

            # Rescue pass: a high-start player may have been squeezed
            # out because every slot they've ever batted in got taken
            # (e.g. Stevens always DHs at slot 3, someone else took 3
            # in the few LHP games). Drop them into the best open slot
            # with an unused position so they still appear in the
            # lineup, at pct=0 to signal low confidence.
            if used_players:
                top_wt = sorted_players[0][1]["total_wt"]
            else:
                top_wt = 0
            for name, info in sorted_players:
                if name in used_players:
                    continue
                # Only rescue players who started a meaningful share of
                # games. 20% of the top guy's weighted starts catches
                # regulars who only played in, say, 4 of 20 games but
                # still clearly own their position.
                if info["total_wt"] < 0.2 * top_wt:
                    break
                pos = player_primary_pos.get(name, "")
                if pos and pos in used_positions:
                    continue
                open_slots = [s for s in range(1, 10) if s not in assigned]
                if not open_slots:
                    break
                spot = info["best_spot"] if info["best_spot"] in open_slots else open_slots[0]
                assigned[spot] = {
                    "player_name": name,
                    "position": pos,
                    "pct": 0,
                }
                used_players.add(name)
                if pos:
                    used_positions.add(pos)

            # Final fill pass: any still-empty slots get filled by the
            # remaining sub with the most weighted games whose primary
            # position is still open. Showing a low-sample backup at
            # pct=0 is more useful than leaving slot 8 blank — fans /
            # coaches can infer "we're not sure, but this is the most
            # likely body in that spot."
            open_slots = [s for s in range(1, 10) if s not in assigned]
            if open_slots:
                for name, info in sorted_players:
                    if not open_slots:
                        break
                    if name in used_players:
                        continue
                    pos = player_primary_pos.get(name, "")
                    if pos and pos in used_positions:
                        continue
                    spot = info["best_spot"] if info["best_spot"] in open_slots else open_slots[0]
                    assigned[spot] = {
                        "player_name": name,
                        "position": pos,
                        "pct": 0,
                    }
                    used_players.add(name)
                    if pos:
                        used_positions.add(pos)
                    open_slots = [s for s in range(1, 10) if s not in assigned]

            # ── Alternates at each defensive position ──
            # For each assigned slot, if the starter does NOT dominate
            # their defensive position (< 65% of weighted starts), show
            # up to 2 other players who have also put real innings there
            # (>= 20% share). Rendered as "Miyazawa/Richards" on the
            # lineup row so fans/coaches see the real committee.
            ALT_TOP_THRESHOLD = 0.65   # starter must clear this to hide alts
            ALT_MIN_SHARE = 0.20       # alt must clear this to show up
            MAX_ALTS = 2

            for spot, info in assigned.items():
                pos = info.get("position") or ""
                if not pos:
                    info["alts"] = []
                    continue
                starter_name = info["player_name"]
                pos_totals = position_wt.get(pos, {})
                total_at_pos = sum(pos_totals.values())
                if total_at_pos <= 0:
                    info["alts"] = []
                    continue
                starter_share = pos_totals.get(starter_name, 0) / total_at_pos
                if starter_share >= ALT_TOP_THRESHOLD:
                    info["alts"] = []
                    continue
                # Collect candidates who aren't the starter, aren't
                # already locked into another lineup slot, and clear
                # the minimum share bar.
                candidates = []
                for cand_name, cand_wt in pos_totals.items():
                    if cand_name == starter_name:
                        continue
                    if cand_name in used_players:
                        # Already occupying another lineup slot. Don't
                        # list them as a backup at a position they
                        # aren't actually playing tonight.
                        continue
                    share = cand_wt / total_at_pos
                    if share < ALT_MIN_SHARE:
                        continue
                    candidates.append({
                        "player_name": cand_name,
                        "pct": round(share * 100, 1),
                    })
                candidates.sort(key=lambda c: c["pct"], reverse=True)
                info["alts"] = candidates[:MAX_ALTS]

            lineup = []
            for spot in range(1, 10):
                if spot in assigned:
                    lineup.append({"spot": spot, **assigned[spot]})
                else:
                    lineup.append({"spot": spot, "player_name": "—",
                                   "position": "", "pct": 0, "alts": []})

            # Bench: starters not in the constructed lineup
            bench = []
            for name, info in sorted_players:
                if name in used_players:
                    continue
                bench.append({
                    "player_name": name,
                    "position": player_primary_pos.get(name, ""),
                    "games_started": info["games"],
                })
                if len(bench) >= 6:
                    break

            return {
                "games_count": len(game_list),
                "lineup": lineup,
                "bench": bench,
            }

        # ──────────────────────────────────────────────────────────────
        # Hitter splits: per-player breakdown by LINEUP SPOT and by
        # DEFENSIVE POSITION. Fans/coaches want to see "how does this
        # guy hit in the 5 hole vs the 1 hole" and "how does he hit
        # when he's in CF vs 1B". Built from the same game-log rows
        # used for the lineup construction so the universe of games
        # matches exactly.
        #
        # Thresholds:
        #   - Include a player if they have >= 10 total AB in the window
        #   - Include a bucket (spot or position) if it has >= 3 AB
        # ──────────────────────────────────────────────────────────────
        def _blank_bucket():
            return {
                "ab": 0, "h": 0, "bb": 0, "hbp": 0, "sf": 0,
                "doubles": 0, "triples": 0, "hr": 0, "rbi": 0,
                "k": 0, "r": 0, "g": 0,
            }

        def _finalize_bucket(b):
            """AVG/OBP/SLG/OPS out of the raw totals."""
            ab = b["ab"]
            bb = b["bb"]
            hbp = b["hbp"]
            sf = b["sf"]
            h = b["h"]
            singles = h - b["doubles"] - b["triples"] - b["hr"]
            tb = singles + 2 * b["doubles"] + 3 * b["triples"] + 4 * b["hr"]
            avg = round(h / ab, 3) if ab > 0 else None
            obp_den = ab + bb + hbp + sf
            obp = round((h + bb + hbp) / obp_den, 3) if obp_den > 0 else None
            slg = round(tb / ab, 3) if ab > 0 else None
            ops = round(obp + slg, 3) if (obp is not None and slg is not None) else None
            return {
                "ab": ab, "h": h, "hr": b["hr"], "rbi": b["rbi"],
                "bb": bb, "k": b["k"], "r": b["r"], "g": b["g"],
                "avg": avg, "obp": obp, "slg": slg, "ops": ops,
            }

        def build_hitter_splits():
            # player_name -> "spot" -> spot (1..9) -> bucket
            # player_name -> "pos"  -> position     -> bucket
            by_spot = defaultdict(lambda: defaultdict(_blank_bucket))
            by_pos = defaultdict(lambda: defaultdict(_blank_bucket))
            totals = defaultdict(_blank_bucket)

            for g in all_ge:
                batters = deduped_batting_by_game.get(g["id"], [])
                for b in batters:
                    name = b["player_name"] or "Unknown"
                    if name == "Unknown":
                        continue
                    raw_pos = (b["position"] or "").upper().strip()
                    # Ignore pure pinch-hit / pinch-run appearances
                    # in the position split — they aren't a defensive
                    # position. They still count in the spot split if
                    # the scraper gave them a batting order (rare).
                    spot = b["batting_order"] or 0
                    ab = b["at_bats"] or 0
                    bb = b["walks"] or 0
                    hbp = b["hit_by_pitch"] or 0
                    sf = b["sacrifice_flies"] or 0
                    h = b["hits"] or 0
                    d = b["doubles"] or 0
                    t = b["triples"] or 0
                    hr = b["home_runs"] or 0
                    rbi = b["rbi"] or 0
                    k = b["strikeouts"] or 0
                    r = b["runs"] or 0

                    def _add(bucket):
                        bucket["ab"] += ab
                        bucket["h"] += h
                        bucket["bb"] += bb
                        bucket["hbp"] += hbp
                        bucket["sf"] += sf
                        bucket["doubles"] += d
                        bucket["triples"] += t
                        bucket["hr"] += hr
                        bucket["rbi"] += rbi
                        bucket["k"] += k
                        bucket["r"] += r
                        bucket["g"] += 1

                    _add(totals[name])

                    if 1 <= spot <= 9 and raw_pos not in ("PH", "PR", "CR"):
                        _add(by_spot[name][spot])

                    if raw_pos and raw_pos not in ("PH", "PR", "CR", "P"):
                        # "CF/RF" -> bucket under CF (primary slot)
                        primary = raw_pos.split("/")[0].strip()
                        if primary:
                            _add(by_pos[name][primary])

            PLAYER_MIN_AB = 10
            BUCKET_MIN_AB = 3

            result = []
            for name, t in totals.items():
                if t["ab"] < PLAYER_MIN_AB:
                    continue
                spot_rows = []
                for spot in sorted(by_spot.get(name, {}).keys()):
                    bk = by_spot[name][spot]
                    if bk["ab"] < BUCKET_MIN_AB:
                        continue
                    spot_rows.append({"spot": spot, **_finalize_bucket(bk)})
                pos_rows = []
                raw_pos_map = by_pos.get(name, {})
                for pos, bk in sorted(
                    raw_pos_map.items(),
                    key=lambda kv: kv[1]["ab"],
                    reverse=True,
                ):
                    if bk["ab"] < BUCKET_MIN_AB:
                        continue
                    pos_rows.append({"position": pos, **_finalize_bucket(bk)})
                # Only return players who have at least one meaningful
                # bucket in EITHER view. A guy with 12 AB all in one
                # spot / one position has nothing to split, so skip.
                if not spot_rows and not pos_rows:
                    continue
                result.append({
                    "player_name": name,
                    "primary_position": player_primary_pos.get(name, ""),
                    "overall": _finalize_bucket(t),
                    "by_spot": spot_rows,
                    "by_position": pos_rows,
                })

            # Sort by overall AB desc so the regulars show up first.
            result.sort(key=lambda p: p["overall"]["ab"], reverse=True)
            return result

        # Build lineups — strict split: only games where we KNOW the opposing
        # starter's hand count toward vs_rhp/vs_lhp. Unknown games are excluded
        # so they don't pollute the split (they'd bias toward whatever the
        # team's "neutral" lineup is, which is not what a vs-hand split means).
        lineup_vs_rhp = build_best_lineup(games_vs_rhp)
        lineup_vs_lhp = build_best_lineup(games_vs_lhp)

        game_slot_lineups = {}
        for slot in range(1, 5):
            gl = games_by_slot.get(slot, [])
            if len(gl) >= 2:
                game_slot_lineups[str(slot)] = build_best_lineup(gl)

        # ── Pinch hitters, pinch runners ──
        ph_stats = defaultdict(lambda: {"apps": 0, "ab": 0, "h": 0,
                                         "rbi": 0, "bb": 0})
        pr_stats = defaultdict(lambda: {"apps": 0, "sb": 0, "r": 0, "cs": 0})

        for g in all_ge:
            seen_ph = set()
            seen_pr = set()
            batters = deduped_batting_by_game.get(g["id"], [])
            for b in batters:
                pos = (b["position"] or "").upper().strip()
                name = b["player_name"] or "Unknown"
                if pos == "PH" and name not in seen_ph:
                    seen_ph.add(name)
                    s = ph_stats[name]
                    s["apps"] += 1
                    s["ab"] += b["at_bats"] or 0
                    s["h"] += b["hits"] or 0
                    s["rbi"] += b["rbi"] or 0
                    s["bb"] += b["walks"] or 0
                elif pos in ("PR", "CR") and name not in seen_pr:
                    seen_pr.add(name)
                    s = pr_stats[name]
                    s["apps"] += 1
                    s["sb"] += b["stolen_bases"] or 0
                    s["r"] += b["runs"] or 0
                    s["cs"] += b["caught_stealing"] or 0

        pinch_hitters = sorted([
            {"name": n, "apps": s["apps"], "ab": s["ab"], "h": s["h"],
             "rbi": s["rbi"], "bb": s["bb"],
             "avg": round(s["h"] / s["ab"], 3) if s["ab"] > 0 else None}
            for n, s in ph_stats.items()
        ], key=lambda x: x["apps"], reverse=True)

        pinch_runners = sorted([
            {"name": n, "apps": s["apps"], "sb": s["sb"],
             "cs": s["cs"], "r": s["r"]}
            for n, s in pr_stats.items()
        ], key=lambda x: x["apps"], reverse=True)

        hitter_splits = build_hitter_splits()

        lineup_trends = {
            "vs_rhp": lineup_vs_rhp,
            "vs_lhp": lineup_vs_lhp,
            "by_game_number": game_slot_lineups,
            "pinch_hitters": pinch_hitters,
            "pinch_runners": pinch_runners,
            "hitter_splits": hitter_splits,
            "count_vs_rhp": len(games_vs_rhp),
            "count_vs_lhp": len(games_vs_lhp),
            "count_vs_unknown": len(games_vs_unknown),
        }

        # ══════════════════════════════════════════════════════════════
        # PITCHING TRENDS
        # ══════════════════════════════════════════════════════════════

        # FIP constant used for per-slot splits below. We repeat the value the
        # reliever section uses (3.50) so college ERAs and FIPs line up at the
        # league-average level.
        _SP_FIP_CONSTANT = 3.50

        # Reference point for the "inactive" icon — the team's most recent game.
        # Compare each pitcher's last outing against this to flag arms that
        # haven't been used in 2+ weeks.
        latest_team_date = all_ge[-1]["game_date"] if all_ge else None

        def _slot_totals():
            return {
                "starts": 0, "outs": 0, "er": 0,
                "k": 0, "bb": 0, "hr": 0, "hbp": 0,
                "wins": 0, "losses": 0,
            }

        starter_data = defaultdict(lambda: {
            "starts": 0, "total_outs": 0, "game_slots": Counter(),
            "recent_starts": [], "player_id": None, "throws": None,
            "wins": 0, "losses": 0, "qs": 0,
            "total_k": 0, "total_er": 0, "total_bb": 0,
            "slot_totals": defaultdict(_slot_totals),
        })

        for g in all_ge:
            pitchers = deduped_pitching_by_game.get(g["id"], [])
            for p in pitchers:
                if not p["is_starter"]:
                    continue
                name = p["player_name"] or "Unknown"
                s = starter_data[name]
                s["starts"] += 1
                raw_ip = p["innings_pitched"]
                outs_this = ip_to_outs(raw_ip)
                s["total_outs"] += outs_this
                s["player_id"] = p["player_id"]
                s["throws"] = player_info.get(p["player_id"], {}).get("throws")
                s["total_k"] += p["strikeouts"] or 0
                s["total_er"] += p["earned_runs"] or 0
                s["total_bb"] += p["walks"] or 0
                if p["decision"] == "W":
                    s["wins"] += 1
                elif p["decision"] == "L":
                    s["losses"] += 1
                if p["is_quality_start"]:
                    s["qs"] += 1
                slot = g.get("series_game_num", 1)
                s["game_slots"][slot] += 1
                # Per-slot accumulators (for "By Series Game" splits in UI)
                st = s["slot_totals"][slot]
                st["starts"] += 1
                st["outs"] += outs_this
                st["er"] += p["earned_runs"] or 0
                st["k"] += p["strikeouts"] or 0
                st["bb"] += p["walks"] or 0
                st["hr"] += p["home_runs_allowed"] or 0
                st["hbp"] += p["hit_batters"] or 0
                if p["decision"] == "W":
                    st["wins"] += 1
                elif p["decision"] == "L":
                    st["losses"] += 1
                s["recent_starts"].append({
                    "date": g["game_date"].isoformat() if hasattr(g["game_date"], "isoformat") else str(g["game_date"]),
                    "opp": g["opponent_name"],
                    "g": slot,
                    "ip": float(raw_ip or 0),
                    "k": p["strikeouts"] or 0,
                    "er": p["earned_runs"] or 0,
                    "dec": p["decision"],
                    "gs": p["game_score"],
                    "pc": p["pitches_thrown"],
                })

        starters_list = []
        for name, s in starter_data.items():
            if s["starts"] < 2:
                continue
            # avg IP uses real innings (outs/3) so it's mathematically sensible
            avg_ip = round(s["total_outs"] / s["starts"] / 3, 1) if s["starts"] else 0

            # Per-slot splits: GS, IP, IP/GS, ERA, FIP, K, BB, HR, Record
            slot_splits = {}
            for slot_num, st in s["slot_totals"].items():
                if st["starts"] == 0:
                    continue
                outs = st["outs"]
                ip_real = round(outs / 3.0, 2)
                slot_avg_ip = round(outs / st["starts"] / 3.0, 1) if st["starts"] else 0
                # FIP — None if no outs (divide-by-zero guard)
                if outs > 0:
                    ip_for_fip = outs / 3.0
                    fip_val = round(
                        (13 * st["hr"] + 3 * (st["bb"] + st["hbp"]) - 2 * st["k"]) / ip_for_fip
                        + _SP_FIP_CONSTANT,
                        2,
                    )
                else:
                    fip_val = None
                slot_splits[str(slot_num)] = {
                    "gs": st["starts"],
                    "ip": ip_real,
                    "avg_ip": slot_avg_ip,
                    "era": era_from_outs(st["er"], outs),
                    "fip": fip_val,
                    "k": st["k"],
                    "bb": st["bb"],
                    "hr": st["hr"],
                    "record": f"{st['wins']}-{st['losses']}",
                }

            # Icon flags for starters
            last2 = s["recent_starts"][-2:]
            er_2 = sum(a.get("er", 0) or 0 for a in last2)
            outs_2 = sum(ip_to_outs(a.get("ip", 0)) for a in last2)
            flag_hot = len(last2) >= 2 and outs_2 > 0 and (er_2 * 27 / outs_2) <= 2.00
            flag_cold = len(last2) >= 2 and (
                (outs_2 > 0 and (er_2 * 27 / outs_2) >= 7.00) or
                (outs_2 == 0 and er_2 > 0)
            )
            # Starters need a bigger sample for the K/9 flag (20 IP = 60 outs)
            flag_high_k = s["total_outs"] >= 60 and (s["total_k"] * 27 / s["total_outs"]) >= 10.0
            flag_inactive = False
            if latest_team_date and s["starts"] >= 3 and s["recent_starts"]:
                last_str = s["recent_starts"][-1]["date"]
                try:
                    last_dt = date.fromisoformat(last_str) if isinstance(last_str, str) else last_str
                    if (latest_team_date - last_dt).days >= 14:
                        flag_inactive = True
                except (ValueError, TypeError):
                    pass

            starters_list.append({
                "name": name,
                "player_id": s["player_id"],
                "throws": s["throws"],
                "starts": s["starts"],
                "avg_ip": avg_ip,
                "era": era_from_outs(s["total_er"], s["total_outs"]),
                "record": f"{s['wins']}-{s['losses']}",
                "qs": s["qs"],
                "k": s["total_k"],
                "bb": s["total_bb"],
                "slots": {str(k): v for k, v in s["game_slots"].most_common()},
                "slot_splits": slot_splits,
                "recent": s["recent_starts"][-6:],
                "flag_hot": flag_hot,
                "flag_cold": flag_cold,
                "flag_high_k": flag_high_k,
                "flag_inactive": flag_inactive,
            })
        starters_list.sort(key=lambda x: x["starts"], reverse=True)

        # ── Predicted rotation ──
        recent_series = []
        seen_series = set()
        for g in reversed(all_ge):
            if g.get("series_game_num") == 1 and g.get("series_length", 0) >= 2:
                s_id = (g["opponent_id"], str(g["game_date"]))
                if s_id not in seen_series:
                    seen_series.add(s_id)
                    sg_list = [
                        gg for gg in all_ge
                        if gg["opponent_id"] == g["opponent_id"]
                        and 0 <= (gg["game_date"] - g["game_date"]).days <= 4
                    ]
                    sg_list.sort(key=lambda x: (x["game_date"], x.get("game_number") or 1))
                    recent_series.append(sg_list)
                    if len(recent_series) >= 4:
                        break

        # Count how many of the recent series each pitcher started in
        # (not total games — we want "% of series where this pitcher got a start")
        pitcher_series_count = Counter()
        for series in recent_series:
            seen_in_series = set()
            for sg in series:
                pitchers = deduped_pitching_by_game.get(sg["id"], [])
                sp = next((p for p in pitchers if p["is_starter"]), None)
                if sp and sp["player_name"] not in seen_in_series:
                    seen_in_series.add(sp["player_name"])
                    pitcher_series_count[sp["player_name"]] += 1
        num_recent_series = len(recent_series) or 1

        predicted_rotation = []
        # Track pitchers already slotted into an earlier game so the same arm
        # can't be predicted twice in one series (e.g. the G2 starter also
        # winning G3 because he's the most common starter both slots). We
        # greedy-pick the highest-weight AVAILABLE pitcher for each slot.
        assigned_pitchers = set()
        for slot in range(1, 5):
            slot_starters = Counter()
            slot_wt = 0
            for s_idx, series in enumerate(recent_series):
                w = 2 ** (-s_idx)
                for sg in series:
                    if sg.get("series_game_num") == slot:
                        pitchers = deduped_pitching_by_game.get(sg["id"], [])
                        sp = next((p for p in pitchers if p["is_starter"]), None)
                        if sp:
                            slot_starters[sp["player_name"]] += w
                            slot_wt += w
            # Primary pick: most-likely unassigned pitcher who has actually
            # started THIS slot in recent series.
            top_pick = None
            top_w = 0
            pick_source = None
            if slot_starters:
                for name, w in slot_starters.most_common():
                    if name not in assigned_pitchers:
                        top_pick = name
                        top_w = w
                        pick_source = "slot"
                        break

            # Fallback: if every slot-specific candidate is already assigned
            # (e.g. team runs a 3-man rotation and both of its G3 starters
            # also own G1 and G2), grab the next most-used starter overall
            # who hasn't been placed yet. Better to surface a best-guess
            # 4th starter than to leave the slot blank on the site.
            if not top_pick:
                overall_ranked = sorted(
                    starter_data.items(),
                    key=lambda kv: kv[1].get("starts", 0),
                    reverse=True,
                )
                for name, _info in overall_ranked:
                    if name not in assigned_pitchers:
                        top_pick = name
                        top_w = 0  # signals 'fallback — no slot-specific weight'
                        pick_source = "fallback"
                        break

            if top_pick:
                assigned_pitchers.add(top_pick)
                sp_info = starter_data.get(top_pick, {})
                series_with_start = pitcher_series_count.get(top_pick, 0)
                # game_conf is slot-specific confidence. Only meaningful for
                # primary picks; fallback picks report 0 so the UI can show
                # uncertainty.
                if pick_source == "slot" and slot_wt:
                    game_conf = round(top_w / slot_wt * 100)
                else:
                    game_conf = 0
                predicted_rotation.append({
                    "game": slot,
                    "name": top_pick,
                    "throws": sp_info.get("throws"),
                    "game_conf": game_conf,
                    "week_pct": round(series_with_start / num_recent_series * 100),
                })

        # ── Relievers (deduplicated) ──
        reliever_data = defaultdict(lambda: {
            "apps": 0, "total_outs": 0, "saves": 0,
            "k": 0, "er": 0, "bb": 0, "hr": 0, "hbp": 0, "bf": 0,
            "player_id": None, "throws": None,
            "close_apps": 0, "multi_ip_apps": 0,
            "longest_outs": 0,
            "recent": [],
        })

        for g in all_ge:
            pitchers = deduped_pitching_by_game.get(g["id"], [])
            our = g["home_score"] if g["is_home"] else g["away_score"]
            their = g["away_score"] if g["is_home"] else g["home_score"]
            close = abs((our or 0) - (their or 0)) <= 3

            for p in pitchers:
                if p["is_starter"]:
                    continue
                name = p["player_name"] or "Unknown"
                r = reliever_data[name]
                raw_ip = p["innings_pitched"]
                outs = ip_to_outs(raw_ip)
                r["apps"] += 1
                r["total_outs"] += outs
                r["player_id"] = p["player_id"]
                r["throws"] = player_info.get(p["player_id"], {}).get("throws")
                r["k"] += p["strikeouts"] or 0
                r["er"] += p["earned_runs"] or 0
                r["bb"] += p["walks"] or 0
                r["hr"] += p["home_runs_allowed"] or 0
                r["hbp"] += p["hit_batters"] or 0
                r["bf"] += p["batters_faced"] or 0
                if p["decision"] == "S":
                    r["saves"] += 1
                if close:
                    r["close_apps"] += 1
                # multi-inning appearance = 4+ outs (1⅓ IP or more)
                if outs >= 4:
                    r["multi_ip_apps"] += 1
                if outs > r["longest_outs"]:
                    r["longest_outs"] = outs
                r["recent"].append({
                    "date": g["game_date"].isoformat() if hasattr(g["game_date"], "isoformat") else str(g["game_date"]),
                    "opp": g["opponent_name"],
                    "ip": float(raw_ip or 0),
                    "k": p["strikeouts"] or 0,
                    "er": p["earned_runs"] or 0, "dec": p["decision"],
                })

        # ── Reliever rating helpers ──
        # FIP constant picked so league-average FIP ≈ league-average ERA at
        # the college level. 3.10 is the standard MLB constant; college ERAs
        # run higher, so we use 3.50 as a rough neutral baseline.
        FIP_CONSTANT = 3.50

        def compute_fip(hr, bb, hbp, k, outs):
            if outs <= 0:
                return None
            ip = outs / 3.0
            return round((13 * hr + 3 * (bb + hbp) - 2 * k) / ip + FIP_CONSTANT, 2)

        def compute_k_bb_pct(k, bb, bf):
            if bf <= 0:
                return None
            return round((k - bb) * 100 / bf, 1)

        def reliever_tier(rating, apps):
            # "small_sample" relievers don't get a tier badge
            if apps < 3:
                return "small_sample"
            if rating is None:
                return "small_sample"
            if rating >= 15:
                return "elite"
            if rating >= 5:
                return "solid"
            if rating >= -5:
                return "average"
            return "struggling"

        relievers_list = []
        for name, r in reliever_data.items():
            # avg IP uses real innings (outs/3) so averaging is sensible
            avg_ip = round(r["total_outs"] / r["apps"] / 3, 1) if r["apps"] else 0
            era = era_from_outs(r["er"], r["total_outs"])
            total_ip_display = outs_to_ip(r["total_outs"])

            # Advanced stats
            fip = compute_fip(r["hr"], r["bb"], r["hbp"], r["k"], r["total_outs"])
            k_bb_pct = compute_k_bb_pct(r["k"], r["bb"], r["bf"])

            # Composite rating: combines command (K-BB%) and run prevention
            # (FIP). Higher is better. K-BB% is already a percentage; FIP is
            # subtracted from the baseline so low-FIP pitchers get a bonus.
            if k_bb_pct is not None and fip is not None:
                rating = round(k_bb_pct - (fip - FIP_CONSTANT) * 5, 1)
            else:
                rating = None

            tier = reliever_tier(rating, r["apps"])

            # Classify: closer / multi-inning / one-inning / mop-up
            # Thresholds use real innings via outs (3 outs = 1 IP)
            if r["saves"] >= 2:
                role = "closer"
            elif avg_ip >= 1.5 or r["multi_ip_apps"] >= r["apps"] * 0.4:
                role = "multi_inning"
            elif r["apps"] >= 3 and r["total_outs"] < 18 and (era is None or era > 12):
                role = "mop_up"
            elif r["total_outs"] < 9 and r["apps"] <= 2:
                role = "mop_up"
            else:
                role = "one_inning"

            # Icon flags: hot, cold, high_k, inactive
            # Hot/cold from last 2 appearances
            last2 = r["recent"][-2:]
            er_2 = sum(a.get("er", 0) or 0 for a in last2)
            outs_2 = sum(ip_to_outs(a.get("ip", 0)) for a in last2)
            flag_hot = len(last2) >= 2 and outs_2 > 0 and (er_2 * 27 / outs_2) <= 2.00
            flag_cold = len(last2) >= 2 and (
                (outs_2 > 0 and (er_2 * 27 / outs_2) >= 7.00) or
                (outs_2 == 0 and er_2 > 0)
            )
            # High-K: season K/9 >= 10, with at least 10 IP (30 outs)
            flag_high_k = r["total_outs"] >= 30 and (r["k"] * 27 / r["total_outs"]) >= 10.0
            # Inactive: hasn't pitched in 14+ days (only flag if 3+ apps — avoid flagging guys who just came back from injury)
            flag_inactive = False
            if latest_team_date and r["apps"] >= 3 and r["recent"]:
                last_str = r["recent"][-1]["date"]
                try:
                    last_dt = date.fromisoformat(last_str) if isinstance(last_str, str) else last_str
                    if (latest_team_date - last_dt).days >= 14:
                        flag_inactive = True
                except (ValueError, TypeError):
                    pass

            relievers_list.append({
                "name": name, "throws": r["throws"],
                "apps": r["apps"], "avg_ip": avg_ip, "era": era,
                "total_ip": total_ip_display,
                "longest_ip": outs_to_ip(r["longest_outs"]),
                "saves": r["saves"], "k": r["k"], "bb": r["bb"],
                "hr": r["hr"], "bf": r["bf"],
                "fip": fip, "k_bb_pct": k_bb_pct,
                "rating": rating, "tier": tier,
                "role": role,
                "leverage_pct": round(r["close_apps"] / r["apps"] * 100) if r["apps"] else 0,
                "recent": r["recent"][-5:],
                "flag_hot": flag_hot,
                "flag_cold": flag_cold,
                "flag_high_k": flag_high_k,
                "flag_inactive": flag_inactive,
            })

        # Mark the best 2 (highest rating, min 3 apps) as "top_reliever"
        qualified = [r for r in relievers_list if r["apps"] >= 3 and r["rating"] is not None]
        qualified.sort(key=lambda x: x["rating"], reverse=True)
        top_names = {r["name"] for r in qualified[:2]}
        for r in relievers_list:
            r["is_top"] = r["name"] in top_names

        # Sort by appearances for the main list display
        relievers_list.sort(key=lambda x: -x["apps"])

        # ── PBP tendencies (Phase D.5) ──
        # For every pitcher in starters+relievers, pull PBP-derived
        # tendencies from game_events: first-pitch strike rate, whiff
        # rate, putaway rate, ground-ball rate, opponent contact mix,
        # total WPA. One bulk query keyed on player_id, attach to each
        # pitcher entry. Keys default to None so the frontend can show
        # "—" for pitchers without enough PBP-tracked data.
        pitcher_pids = []
        for s in starters_list:
            if s.get("player_id"):
                pitcher_pids.append(s["player_id"])
        for r in relievers_list:
            if r.get("player_id"):
                pitcher_pids.append(r["player_id"])

        pitcher_tendencies = {}  # player_id -> tendencies dict
        if pitcher_pids:
            cur.execute("""
                SELECT
                    ge.pitcher_player_id AS pid,
                    COUNT(*) AS pa,
                    COUNT(*) FILTER (WHERE pitches_thrown IS NOT NULL) AS tracked_pa,
                    COALESCE(SUM(pitches_thrown), 0) AS pitches,
                    COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))), 0) AS pK,
                    COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'S', ''))), 0) AS pS,
                    COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS pF,
                    COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS in_play,
                    COUNT(*) FILTER (
                        WHERE pitches_thrown IS NOT NULL AND
                              (LEFT(pitch_sequence, 1) IN ('K', 'S', 'F')
                               OR (pitch_sequence = '' AND was_in_play))
                    ) AS f1_strikes,
                    COUNT(*) FILTER (WHERE strikes_before = 2) AS two_strike_pa,
                    COUNT(*) FILTER (
                        WHERE strikes_before = 2
                          AND result_type IN ('strikeout_swinging','strikeout_looking')
                    ) AS two_strike_k,
                    COUNT(*) FILTER (WHERE bb_type = 'GB') AS gb_n,
                    COUNT(*) FILTER (WHERE bb_type = 'FB') AS fb_n,
                    COUNT(*) FILTER (WHERE bb_type = 'LD') AS ld_n,
                    COUNT(*) FILTER (WHERE bb_type = 'PU') AS pu_n,
                    COUNT(*) FILTER (WHERE bb_type IS NOT NULL) AS bb_total,
                    COUNT(*) FILTER (WHERE result_type = 'home_run') AS hr,
                    SUM(ge.wpa_pitcher)        AS total_wpa,
                    COUNT(ge.wpa_pitcher)      AS wpa_pa
                FROM game_events ge
                JOIN games g ON g.id = ge.game_id
                WHERE g.season = %s
                  AND ge.pitcher_player_id = ANY(%s)
                GROUP BY ge.pitcher_player_id
            """, (season, pitcher_pids))
            for r in cur.fetchall():
                pa = r["pa"] or 0
                tracked = r["tracked_pa"] or 0
                pitches = r["pitches"] or 0
                pk = r["pk"] or 0; ps = r["ps"] or 0; pf = r["pf"] or 0
                inp = r["in_play"] or 0
                swings = pk + pf + inp
                bb_total = r["bb_total"] or 0
                two_k_pa = r["two_strike_pa"] or 0
                pitcher_tendencies[r["pid"]] = {
                    "pa": pa,
                    "fps_pct": ((r["f1_strikes"] or 0) / tracked) if tracked > 0 else None,
                    "whiff_pct": (pk / swings) if swings > 0 else None,
                    "putaway_pct": ((r["two_strike_k"] or 0) / two_k_pa) if two_k_pa > 0 else None,
                    "strike_pct": ((pk + ps + pf + inp) / pitches) if pitches > 0 else None,
                    "gb_pct": ((r["gb_n"] or 0) / bb_total) if bb_total > 0 else None,
                    "ld_pct": ((r["ld_n"] or 0) / bb_total) if bb_total > 0 else None,
                    "fb_pct": ((r["fb_n"] or 0) / bb_total) if bb_total > 0 else None,
                    "pu_pct": ((r["pu_n"] or 0) / bb_total) if bb_total > 0 else None,
                    "hr_pa_pct": ((r["hr"] or 0) / pa) if pa > 0 else None,
                    "total_wpa": float(r["total_wpa"]) if r["total_wpa"] is not None else None,
                    "wpa_pa": int(r["wpa_pa"] or 0),
                }
        # Attach to each pitcher entry
        for s in starters_list:
            s["tendencies"] = pitcher_tendencies.get(s.get("player_id"))
        for r in relievers_list:
            r["tendencies"] = pitcher_tendencies.get(r.get("player_id"))

        # ── Hitter tendencies (Phase D.5) ──
        # Same idea for hitters in the lineup. Pull contact profile
        # (GB/LD/FB/PU + Pull/Center/Oppo), 2-strike approach, and
        # total WPA per hitter. Lets coaches plan how to attack each
        # batter.
        #
        # Lineup spots only carry `player_name`, not `player_id` —
        # build a name->id map from raw_batting (which has both),
        # then resolve each spot to a pid before querying tendencies.
        name_to_pid = {}
        for b in raw_batting:
            n = b.get("player_name")
            pid = b.get("player_id")
            if n and pid and n not in name_to_pid:
                name_to_pid[n] = pid

        def _walk_lineup_spots():
            """Yield (spot_dict) for every lineup spot in lineup_trends."""
            for hand_key in ("vs_rhp", "vs_lhp"):
                hand = lineup_trends.get(hand_key) or {}
                for s in (hand.get("lineup") or []):
                    yield s
            by_gn = lineup_trends.get("by_game_number") or {}
            for slot_data in by_gn.values():
                for s in (slot_data.get("lineup") or []):
                    yield s

        # Resolve spot.player_name to player_id, attach as spot.player_id
        # so the frontend can deep-link if needed.
        batter_pids = set()
        for spot in _walk_lineup_spots():
            n = spot.get("player_name")
            pid = name_to_pid.get(n)
            if pid:
                spot["player_id"] = pid
                batter_pids.add(pid)

        batter_tendencies = {}
        if batter_pids:
            cur.execute("""
                SELECT
                    ge.batter_player_id AS pid,
                    p.bats AS bats,
                    COUNT(*) AS pa,
                    COUNT(*) FILTER (WHERE bb_type = 'GB') AS gb_n,
                    COUNT(*) FILTER (WHERE bb_type = 'FB') AS fb_n,
                    COUNT(*) FILTER (WHERE bb_type = 'LD') AS ld_n,
                    COUNT(*) FILTER (WHERE bb_type = 'PU') AS pu_n,
                    COUNT(*) FILTER (WHERE bb_type IS NOT NULL) AS bb_total,
                    COUNT(*) FILTER (
                        WHERE bb_type IN ('LD','FB')
                          AND ((UPPER(p.bats) = 'R' AND field_zone = 'LEFT')
                            OR (UPPER(p.bats) = 'L' AND field_zone = 'RIGHT'))
                    ) AS air_pull,
                    COUNT(*) FILTER (
                        WHERE field_zone = 'LEFT' AND UPPER(p.bats) = 'R'
                           OR field_zone = 'RIGHT' AND UPPER(p.bats) = 'L'
                    ) AS pull_n,
                    COUNT(*) FILTER (WHERE field_zone = 'CENTER') AS center_n,
                    COUNT(*) FILTER (
                        WHERE field_zone = 'RIGHT' AND UPPER(p.bats) = 'R'
                           OR field_zone = 'LEFT' AND UPPER(p.bats) = 'L'
                    ) AS oppo_n,
                    COUNT(*) FILTER (WHERE field_zone IS NOT NULL) AS zone_total,
                    COUNT(*) FILTER (WHERE strikes_before = 2) AS two_strike_pa,
                    COUNT(*) FILTER (
                        WHERE strikes_before = 2
                          AND result_type IN ('strikeout_swinging','strikeout_looking')
                    ) AS two_strike_k,
                    COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))), 0) AS pK,
                    COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS pF,
                    COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS in_play,
                    SUM(ge.wpa_batter)         AS total_wpa,
                    COUNT(ge.wpa_batter)       AS wpa_pa
                FROM game_events ge
                JOIN games g ON g.id = ge.game_id
                JOIN players p ON p.id = ge.batter_player_id
                WHERE g.season = %s
                  AND ge.batter_player_id = ANY(%s)
                GROUP BY ge.batter_player_id, p.bats
            """, (season, list(batter_pids)))
            for r in cur.fetchall():
                bb_total = r["bb_total"] or 0
                zone_total = r["zone_total"] or 0
                two_k_pa = r["two_strike_pa"] or 0
                pk = r["pk"] or 0; pf = r["pf"] or 0; inp = r["in_play"] or 0
                swings = pk + pf + inp
                contact = pf + inp
                batter_tendencies[r["pid"]] = {
                    "pa": r["pa"] or 0,
                    "bats": r["bats"],
                    "gb_pct": ((r["gb_n"] or 0) / bb_total) if bb_total > 0 else None,
                    "ld_pct": ((r["ld_n"] or 0) / bb_total) if bb_total > 0 else None,
                    "fb_pct": ((r["fb_n"] or 0) / bb_total) if bb_total > 0 else None,
                    "pu_pct": ((r["pu_n"] or 0) / bb_total) if bb_total > 0 else None,
                    "pull_pct": ((r["pull_n"] or 0) / zone_total) if zone_total > 0 else None,
                    "center_pct": ((r["center_n"] or 0) / zone_total) if zone_total > 0 else None,
                    "oppo_pct": ((r["oppo_n"] or 0) / zone_total) if zone_total > 0 else None,
                    "air_pull_pct": ((r["air_pull"] or 0) / bb_total) if bb_total > 0 else None,
                    "putaway_pct": ((r["two_strike_k"] or 0) / two_k_pa) if two_k_pa > 0 else None,
                    "contact_pct": (contact / swings) if swings > 0 else None,
                    "whiff_pct": (pk / swings) if swings > 0 else None,
                    "total_wpa": float(r["total_wpa"]) if r["total_wpa"] is not None else None,
                    "wpa_pa": int(r["wpa_pa"] or 0),
                }

        # Attach hitter tendencies onto each lineup spot using the same
        # walker as the pid-resolution step above.
        for spot in _walk_lineup_spots():
            pid = spot.get("player_id")
            if pid:
                spot["tendencies"] = batter_tendencies.get(pid)

        return {
            "team": team,
            "games_analyzed": n_games,
            "lineup_trends": lineup_trends,
            "pitching_trends": {
                "starters": starters_list,
                "predicted_rotation": predicted_rotation,
                "relievers": relievers_list,
            },
        }


# ============================================================
# ALL-CONFERENCE GENERATOR
# Builds first team, second team, and top-3 honorable mentions
# for each conference (and aggregate groupings).
# ============================================================

def _get_conf_freeze(cur, conf_key):
    """Return the conference_freezes row for conf_key, or None if live.

    Presence of a row means the conference's regular season is over and the
    All-Conference page (and other frozen features) should serve the
    snapshot from the *_frozen tables instead of the live aggregates.
    """
    cur.execute(
        "SELECT conf_key, regular_season_end_date, frozen_at "
        "FROM conference_freezes WHERE conf_key = %s",
        (conf_key,),
    )
    return cur.fetchone()


# Maps the user-facing `conf` query param to the set of conference
# names/abbreviations stored in the `conferences` table.
ALL_CONF_GROUPS = {
    "gnac": {
        "label": "GNAC (D2)",
        "conf_names": ["Great Northwest Athletic Conference", "GNAC"],
        "conf_abbrevs": ["GNAC"],
        "rate_mode": False,
    },
    "nwc": {
        "label": "NWC (D3)",
        "conf_names": ["Northwest Conference", "NWC"],
        "conf_abbrevs": ["NWC"],
        "rate_mode": False,
    },
    "ccc": {
        "label": "CCC (NAIA)",
        "conf_names": ["Cascade Collegiate Conference", "CCC"],
        "conf_abbrevs": ["CCC"],
        "rate_mode": False,
    },
    "nwac-north": {
        "label": "NWAC North",
        "conf_names": ["NWAC North Division", "NWAC North"],
        "conf_abbrevs": ["NWAC-N"],
        "rate_mode": False,
    },
    "nwac-east": {
        "label": "NWAC East",
        "conf_names": ["NWAC East Division", "NWAC East"],
        "conf_abbrevs": ["NWAC-E"],
        "rate_mode": False,
    },
    "nwac-south": {
        "label": "NWAC South",
        "conf_names": ["NWAC South Division", "NWAC South"],
        "conf_abbrevs": ["NWAC-S"],
        "rate_mode": False,
    },
    "nwac-west": {
        "label": "NWAC West",
        "conf_names": ["NWAC West Division", "NWAC West"],
        "conf_abbrevs": ["NWAC-W"],
        "rate_mode": False,
    },
    "all-nwac": {
        "label": "All-NWAC",
        "conf_names": [
            "NWAC North Division", "NWAC East Division",
            "NWAC South Division", "NWAC West Division",
        ],
        "conf_abbrevs": ["NWAC-N", "NWAC-E", "NWAC-S", "NWAC-W"],
        "rate_mode": False,
    },
    "all-pnw": {
        "label": "All-PNW",
        "conf_names": None,  # every conference
        "conf_abbrevs": None,
        "rate_mode": True,   # use WAR/PA and WAR/IP, qualified only
    },
}

# 10 position slots in display order: 5 IF + 3 OF + DH + UTIL
AC_POSITION_SLOTS = ["C", "1B", "2B", "3B", "SS", "OF1", "OF2", "OF3", "DH", "UTIL"]
# Each slot maps to an underlying eligibility "category"
AC_SLOT_TO_CATEGORY = {
    "C": "C", "1B": "1B", "2B": "2B", "3B": "3B", "SS": "SS",
    "OF1": "OF", "OF2": "OF", "OF3": "OF",
    "DH": "DH", "UTIL": "UTIL",
}
# Distinct eligibility categories used for HM lists / candidate pools
AC_CATEGORIES = ["C", "1B", "2B", "3B", "SS", "OF", "DH", "UTIL"]
# Positions that qualify a player as an infielder (for UTIL)
AC_INFIELD = {"C", "1B", "2B", "3B", "SS"}
AC_OUTFIELD = {"LF", "CF", "RF", "OF"}
# Minimum games at a position to be eligible there
AC_POS_GAMES_MIN = 15
# DH share: DH games must be this fraction of games appeared (fielding+DH).
# No minimum game count — a player who appears in 20 games with 4+ at DH qualifies.
AC_DH_MIN_SHARE = 0.20
# Two-way UTIL thresholds
AC_UTIL_TWO_WAY_MIN_IP = 10.0
AC_UTIL_TWO_WAY_MIN_PA = 40
# Flex UTIL threshold (applies to each of the two position-based paths)
AC_UTIL_FLEX_POS_GAMES = 5
# Reliever thresholds
AC_REL_MIN_IP = 15.0
AC_REL_MAX_GS = 3  # < 4 starts


@router.get("/all-conference")
def all_conference(
    conf: str = Query(..., description="Conference group key (e.g. gnac, nwc, ccc, nwac-east, all-nwac, all-pnw)"),
    season: int = Query(2026, description="Season year"),
):
    """
    Build mock first team, second team, and top-3 honorable mentions for
    a conference (or aggregate grouping).  10 position spots (C/1B/2B/3B/
    SS/OF1/OF2/OF3/DH/UTIL) plus 4 SP + 1 RP per team.

    Selection rules:
      - Position eligibility: 15+ games at that position in game_batting
      - OF1/OF2/OF3 share one combined outfield pool (any LF/CF/RF/OF
        appearance counts toward outfield games)
      - DH: 15+ games at DH AND DH games >= 50% of defensive games
      - UTIL: two-way player (10+ IP AND 40+ PA) OR 7+ games at both
        infield and outfield (catcher counts as infield)
      - Negative WAR players are excluded from every pool
      - Each player can only appear once on a conference page (across 1st
        team, 2nd team, and HM, and across hitter/pitcher pools)
      - Primary role for two-way players is whichever WAR is higher
      - Primary sort: WAR (rate-adjusted WAR/PA + WAR/IP for 'all-pnw')
      - Hitter tiebreak: wRC+
      - Pitcher tiebreak: FIP (lower is better)
      - Multi-position handling: maximize combined WAR across both slots
      - Starters: qualified (0.75 IP per team game), ranked by WAR
      - Reliever: 15+ IP, fewer than 4 starts, ranked by WAR/IP
      - all-pnw uses rate stats and is qualified-only
    """
    group = ALL_CONF_GROUPS.get(conf)
    if not group:
        return {"error": f"Unknown conference key: {conf}"}

    rate_mode = group["rate_mode"]

    with get_connection() as conn:
        cur = conn.cursor()

        # ── Freeze check ─────────────────────────────────────────
        # If this conference's regular season has ended, we serve data
        # from the *_frozen snapshot tables instead of the live ones so
        # playoff games don't change the All-Conference teams or awards.
        # all-pnw (which has None conf_names) can never be frozen directly
        # since it spans every division.
        freeze = _get_conf_freeze(cur, conf) if group["conf_names"] is not None else None
        is_frozen = freeze is not None
        batting_table = "batting_stats_frozen" if is_frozen else "batting_stats"
        pitching_table = "pitching_stats_frozen" if is_frozen else "pitching_stats"
        team_season_table = "team_season_stats_frozen" if is_frozen else "team_season_stats"
        # Frozen tables have a conf_key stamp; live tables do not.
        tss_conf_cond = " AND tss.conf_key = %s" if is_frozen else ""
        bs_conf_cond = " AND bs.conf_key = %s" if is_frozen else ""
        ps_conf_cond = " AND ps.conf_key = %s" if is_frozen else ""

        # ── Resolve the set of team_ids in scope ─────────────────
        if group["conf_names"] is None:
            # all-pnw: every active team with stats this season
            cur.execute(f"""
                SELECT t.id, t.name, t.short_name, t.logo_url,
                       c.name as conference_name, c.abbreviation as conference_abbrev,
                       d.level as division_level,
                       COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0) as team_games
                FROM teams t
                JOIN conferences c ON c.id = t.conference_id
                JOIN divisions d ON d.id = c.division_id
                LEFT JOIN {team_season_table} tss
                  ON tss.team_id = t.id AND tss.season = %s
                WHERE t.is_active = 1
            """, (season,))
        else:
            tss_params = (conf,) if is_frozen else ()
            cur.execute(f"""
                SELECT t.id, t.name, t.short_name, t.logo_url,
                       c.name as conference_name, c.abbreviation as conference_abbrev,
                       d.level as division_level,
                       COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0) as team_games
                FROM teams t
                JOIN conferences c ON c.id = t.conference_id
                JOIN divisions d ON d.id = c.division_id
                LEFT JOIN {team_season_table} tss
                  ON tss.team_id = t.id AND tss.season = %s{tss_conf_cond}
                WHERE t.is_active = 1
                  AND (c.name = ANY(%s) OR c.abbreviation = ANY(%s))
            """, (season, *tss_params, group["conf_names"], group["conf_abbrevs"]))

        team_rows = cur.fetchall()
        teams_by_id = {t["id"]: dict(t) for t in team_rows}
        team_ids = list(teams_by_id.keys())
        if not team_ids:
            return {"conf": conf, "label": group["label"], "season": season,
                    "first_team": {}, "second_team": {}, "honorable_mentions": {}, "teams": []}

        # ── Pull batting stats for players on these teams ─────────
        bs_params = (conf,) if is_frozen else ()
        cur.execute(f"""
            SELECT bs.player_id, bs.team_id,
                   p.first_name, p.last_name, p.headshot_url, p.position as listed_position,
                   p.year_in_school, p.bats, p.throws,
                   bs.plate_appearances, bs.at_bats, bs.hits, bs.home_runs,
                   bs.stolen_bases,
                   bs.strikeouts, bs.walks,
                   bs.batting_avg, bs.on_base_pct, bs.slugging_pct, bs.ops,
                   bs.iso, bs.woba, bs.k_pct, bs.bb_pct,
                   bs.wrc_plus, bs.offensive_war
            FROM {batting_table} bs
            JOIN players p ON p.id = bs.player_id
            WHERE bs.season = %s AND bs.team_id = ANY(%s){bs_conf_cond}
        """, (season, team_ids, *bs_params))
        batting_rows = [dict(r) for r in cur.fetchall()]
        batting_by_pid = {b["player_id"]: b for b in batting_rows}

        # ── Pull pitching stats for players on these teams ────────
        ps_params = (conf,) if is_frozen else ()
        cur.execute(f"""
            SELECT ps.player_id, ps.team_id,
                   p.first_name, p.last_name, p.headshot_url, p.position as listed_position,
                   p.year_in_school, p.bats, p.throws,
                   ps.innings_pitched, ps.games, ps.games_started,
                   ps.era, ps.fip, ps.fip_plus, ps.whip, ps.siera,
                   ps.strikeouts, ps.walks, ps.k_pct, ps.bb_pct,
                   ps.wins, ps.saves,
                   ps.pitching_war
            FROM {pitching_table} ps
            JOIN players p ON p.id = ps.player_id
            WHERE ps.season = %s AND ps.team_id = ANY(%s){ps_conf_cond}
        """, (season, team_ids, *ps_params))
        pitching_rows = [dict(r) for r in cur.fetchall()]
        pitching_by_pid = {p["player_id"]: p for p in pitching_rows}

        # ── Pull position-games per player from game_batting ──────
        # We use normalized position buckets: C, 1B, 2B, 3B, SS, LF, CF, RF,
        # DH, P.  Anything else is ignored. Postseason games are excluded
        # so playoff appearances don't affect position eligibility — the
        # all-conference pools should reflect the regular season only.
        cur.execute("""
            SELECT gb.player_id, gb.position,
                   COUNT(DISTINCT (g.game_date, COALESCE(g.game_number, 1))) as games
            FROM game_batting gb
            JOIN games g ON g.id = gb.game_id
            WHERE gb.player_id IS NOT NULL
              AND g.season = %s
              AND gb.team_id = ANY(%s)
              AND gb.position IS NOT NULL
              AND gb.position != ''
              AND gb.position != '-'
              AND (g.is_postseason IS NULL OR g.is_postseason = FALSE)
            GROUP BY gb.player_id, gb.position
        """, (season, team_ids))
        pos_rows = cur.fetchall()

        # ── First-season-at-team lookup (for Transfer of the Year) ──
        # A player is "first-year at program" if their earliest season
        # at the current team_id is this season.  Uses batting_stats
        # UNION pitching_stats so two-way guys get covered either way.
        cur.execute("""
            SELECT player_id, team_id, MIN(season) AS first_season
            FROM (
                SELECT player_id, team_id, season FROM batting_stats
                UNION
                SELECT player_id, team_id, season FROM pitching_stats
            ) s
            WHERE team_id = ANY(%s)
            GROUP BY player_id, team_id
        """, (team_ids,))
        first_season_rows = cur.fetchall()
        first_season_by_pid_team = {
            (r["player_id"], r["team_id"]): r["first_season"]
            for r in first_season_rows
        }

    # Normalize positions locally (same logic as update_positions.py uses,
    # but simple enough to inline)
    def norm_pos(raw):
        if not raw:
            return None
        s = raw.strip().upper()
        # Strip trailing slash parts ("2B/SS" -> first token)
        s = s.split("/")[0]
        aliases = {
            "C": "C", "1B": "1B", "2B": "2B", "3B": "3B", "SS": "SS",
            "LF": "LF", "CF": "CF", "RF": "RF", "DH": "DH", "PH": None,
            "PR": None, "P": "P", "RHP": "P", "LHP": "P", "OF": "OF",
            "IF": None,
        }
        return aliases.get(s, None)

    pos_games = {}  # player_id -> {pos: games}
    for row in pos_rows:
        pid = row["player_id"]
        np = norm_pos(row["position"])
        if not np:
            continue
        if pid not in pos_games:
            pos_games[pid] = {}
        pos_games[pid][np] = pos_games[pid].get(np, 0) + (row["games"] or 0)

    # OF bucket: some players have raw "OF" rows; also any LF/CF/RF counts
    for pid, pg in pos_games.items():
        of_total = pg.get("LF", 0) + pg.get("CF", 0) + pg.get("RF", 0) + pg.get("OF", 0)
        pg["_OF_TOTAL"] = of_total
        if_total = sum(pg.get(p, 0) for p in AC_INFIELD)
        pg["_IF_TOTAL"] = if_total

    # ── Build per-player candidate objects ───────────────────────
    # One entry per player, whether they hit, pitch, or both.
    def base_player(pid, team_id, first_name, last_name, headshot, listed, year_in_school):
        team = teams_by_id.get(team_id, {}) or {}
        return {
            "player_id": pid,
            "team_id": team_id,
            "team_name": team.get("name"),
            "team_short": team.get("short_name"),
            "team_logo": team.get("logo_url"),
            "conference_abbrev": team.get("conference_abbrev"),
            "division_level": team.get("division_level"),
            "team_games": team.get("team_games") or 0,
            "name": f"{first_name or ''} {last_name or ''}".strip(),
            "first_name": first_name,
            "last_name": last_name,
            "headshot_url": headshot,
            "listed_position": listed,
            "year_in_school": year_in_school,
        }

    players = {}  # pid -> merged record
    for b in batting_rows:
        pid = b["player_id"]
        rec = players.get(pid) or base_player(
            pid, b["team_id"], b["first_name"], b["last_name"],
            b["headshot_url"], b["listed_position"], b.get("year_in_school")
        )
        pa = float(b.get("plate_appearances") or 0)
        war = float(b.get("offensive_war") or 0)
        rec.update({
            "pa": pa,
            "war_bat": war,
            "war_bat_rate": (war / pa) if pa > 0 else 0.0,
            "wrc_plus": b.get("wrc_plus"),
            "avg": b.get("batting_avg"),
            "obp": b.get("on_base_pct"),
            "slg": b.get("slugging_pct"),
            "ops": b.get("ops"),
            "iso": b.get("iso"),
            "woba": b.get("woba"),
            "hr": b.get("home_runs"),
            "sb": b.get("stolen_bases"),
            "hits": b.get("hits"),
            "bat_k": b.get("strikeouts"),
            "bat_bb": b.get("walks"),
            "bat_k_pct": b.get("k_pct"),
            "bat_bb_pct": b.get("bb_pct"),
        })
        players[pid] = rec

    for p in pitching_rows:
        pid = p["player_id"]
        rec = players.get(pid) or base_player(
            pid, p["team_id"], p["first_name"], p["last_name"],
            p["headshot_url"], p["listed_position"], p.get("year_in_school")
        )
        ip = float(p.get("innings_pitched") or 0)
        pwar = float(p.get("pitching_war") or 0)
        rec.update({
            "ip": ip,
            "war_pit": pwar,
            "war_pit_rate": (pwar / ip) if ip > 0 else 0.0,
            "fip": p.get("fip"),
            "fip_plus": p.get("fip_plus"),
            "era": p.get("era"),
            "whip": p.get("whip"),
            "siera": p.get("siera"),
            "k": p.get("strikeouts"),
            "bb": p.get("walks"),
            "pit_k_pct": p.get("k_pct"),
            "pit_bb_pct": p.get("bb_pct"),
            "gs": p.get("games_started") or 0,
            "g_pitch": p.get("games") or 0,
        })
        players[pid] = rec

    # Attach position games to each player
    for pid, rec in players.items():
        pg = pos_games.get(pid, {})
        rec["pos_games"] = {k: v for k, v in pg.items() if not k.startswith("_")}
        rec["if_games"] = pg.get("_IF_TOTAL", 0)
        rec["of_games"] = pg.get("_OF_TOTAL", 0)
        rec.setdefault("pa", 0.0)
        rec.setdefault("war_bat", 0.0)
        rec.setdefault("war_bat_rate", 0.0)
        rec.setdefault("ip", 0.0)
        rec.setdefault("war_pit", 0.0)
        rec.setdefault("war_pit_rate", 0.0)
        rec.setdefault("gs", 0)

    # ── Helpers for sort keys ────────────────────────────────────
    def bat_war(rec):
        return rec["war_bat_rate"] if rate_mode else rec["war_bat"]

    def pit_war(rec):
        return rec["war_pit_rate"] if rate_mode else rec["war_pit"]

    def bat_tiebreak(rec):
        # Higher wRC+ is better
        return rec.get("wrc_plus") or -999

    def pit_tiebreak(rec):
        # Lower FIP is better (so negate for descending sort)
        fip = rec.get("fip")
        return -fip if fip is not None else -999

    # ── Qualification helpers ────────────────────────────────────
    def is_qualified_bat(rec):
        tg = rec["team_games"] or 0
        return rec["pa"] >= QUALIFIED_PA_PER_GAME * tg and tg > 0

    def is_qualified_pit(rec):
        tg = rec["team_games"] or 0
        return rec["ip"] >= QUALIFIED_IP_PER_GAME * tg and tg > 0

    # ── Position eligibility ─────────────────────────────────────
    def eligible_categories(rec):
        """Set of eligibility categories the player qualifies for
        (C, 1B, 2B, 3B, SS, OF, DH).  Does NOT include UTIL."""
        pg = rec.get("pos_games", {})
        eligible = set()
        for cat in ("C", "1B", "2B", "3B", "SS"):
            if pg.get(cat, 0) >= AC_POS_GAMES_MIN:
                eligible.add(cat)
        # Outfield: combined LF+CF+RF+OF >= 15 games
        if rec.get("of_games", 0) >= AC_POS_GAMES_MIN:
            eligible.add("OF")
        # DH: DH games must be at least AC_DH_MIN_SHARE (20%) of the games
        # in which the player appeared (fielding + DH). No minimum game count.
        dh_games = pg.get("DH", 0)
        total_def_games = sum(v for k, v in pg.items()
                              if k in {"C", "1B", "2B", "3B", "SS",
                                       "LF", "CF", "RF", "OF", "DH"})
        if dh_games > 0 and total_def_games > 0 \
                and (dh_games / total_def_games) >= AC_DH_MIN_SHARE:
            eligible.add("DH")
        return eligible

    def is_util_eligible(rec):
        """UTIL-eligible if any path applies:
          (a) Two-way player: 10+ IP AND 40+ PA.
          (b) 5+ games in the infield (excluding C) AND 5+ games in the
              outfield.
          (c) 5+ games at catcher AND 5+ games at another non-DH position
              (1B/2B/3B/SS/LF/CF/RF/OF).
        """
        pg = rec.get("pos_games", {})
        # (a) Two-way
        if rec["ip"] >= AC_UTIL_TWO_WAY_MIN_IP and rec["pa"] >= AC_UTIL_TWO_WAY_MIN_PA:
            return True
        # (b) IF (excluding C) and OF both >= threshold
        if_excl_c = rec["if_games"] - pg.get("C", 0)
        if if_excl_c >= AC_UTIL_FLEX_POS_GAMES and rec["of_games"] >= AC_UTIL_FLEX_POS_GAMES:
            return True
        # (c) Catcher plus another non-DH position
        c_games = pg.get("C", 0)
        if c_games >= AC_UTIL_FLEX_POS_GAMES:
            other_games = sum(v for k, v in pg.items()
                              if k in {"1B", "2B", "3B", "SS",
                                       "LF", "CF", "RF", "OF"})
            if other_games >= AC_UTIL_FLEX_POS_GAMES:
                return True
        return False

    # ── Primary role classification (one-role-per-player rule) ────
    # A player can only appear once on a conference page.  For two-way
    # guys (Donny Tober etc.) we pick whichever role's WAR is higher
    # and remove them from the other pool entirely.
    primary_role = {}  # pid -> "BAT" | "PIT" | None
    for pid, rec in players.items():
        b = bat_war(rec) if rec["pa"] > 0 else None
        p = pit_war(rec) if rec["ip"] > 0 else None
        if b is not None and p is not None:
            primary_role[pid] = "BAT" if b >= p else "PIT"
        elif b is not None:
            primary_role[pid] = "BAT"
        elif p is not None:
            primary_role[pid] = "PIT"
        else:
            primary_role[pid] = None

    # ── Build per-category candidate pools ────────────────────────
    # Each candidate is a (war_value, tiebreak_value, player_id) tuple.
    # Pools are keyed by CATEGORY (C/1B/2B/3B/SS/OF/DH/UTIL); slot-based
    # picks (OF1/OF2/OF3) all draw from the same OF pool.
    cat_candidates = {cat: [] for cat in AC_CATEGORIES}

    for pid, rec in players.items():
        if primary_role.get(pid) != "BAT":
            continue
        # Negative WAR: exclude entirely
        if bat_war(rec) < 0:
            continue
        # Rate mode: must be a qualified hitter to be in a hitter slot
        if rate_mode and not is_qualified_bat(rec):
            continue
        elig = eligible_categories(rec)
        for cat in elig:
            cat_candidates[cat].append((bat_war(rec), bat_tiebreak(rec), pid))
        if is_util_eligible(rec):
            # UTIL pool is ranked by TOTAL WAR (bat + pit) so two-way
            # players get credit for both sides of the ball. Non-two-way
            # UTIL candidates just get their bat_war (pit_war is 0).
            total_war = bat_war(rec)
            p_war = pit_war(rec) if rec.get("ip", 0) > 0 else 0
            if p_war:
                total_war = total_war + p_war
            cat_candidates["UTIL"].append((total_war, bat_tiebreak(rec), pid))

    # Sort each pool descending by war, then tiebreak
    for cat in cat_candidates:
        cat_candidates[cat].sort(key=lambda x: (x[0], x[1]), reverse=True)

    # ── Selection: greedy with combined-WAR swap ─────────────────
    # Build first team, then remove those players and repeat for second team,
    # then honorable mentions from the remainder.

    def select_team(candidates_by_cat, taken):
        """
        Assign one player per position slot, skipping anyone already taken.
        Slots map to categories (OF1/OF2/OF3 all draw from 'OF'), so the
        three outfield spots pick the top three eligible OF players.
        """
        # First pass: naive top pick per slot (excluding taken and players
        # already assigned to an earlier slot on this team)
        picks = {}
        for slot in AC_POSITION_SLOTS:
            cat = AC_SLOT_TO_CATEGORY[slot]
            for war_val, tb, pid in candidates_by_cat[cat]:
                if pid in taken:
                    continue
                if pid in picks.values():
                    continue
                picks[slot] = pid
                break

        # Swap pass: consider swaps between slots that would increase the
        # sum of WAR across both slots.
        def war_for(pid, slot):
            cat = AC_SLOT_TO_CATEGORY[slot]
            for war_val, tb, _pid in candidates_by_cat[cat]:
                if _pid == pid:
                    return war_val
            return None  # not eligible at this slot's category

        changed = True
        safety = 0
        while changed and safety < 3:
            changed = False
            safety += 1
            for i, slot_a in enumerate(AC_POSITION_SLOTS):
                for slot_b in AC_POSITION_SLOTS[i + 1:]:
                    pid_a = picks.get(slot_a)
                    pid_b = picks.get(slot_b)
                    if not pid_a or not pid_b:
                        continue
                    a_at_b = war_for(pid_a, slot_b)
                    b_at_a = war_for(pid_b, slot_a)
                    if a_at_b is None or b_at_a is None:
                        continue
                    current = (war_for(pid_a, slot_a) or 0) + (war_for(pid_b, slot_b) or 0)
                    swapped = a_at_b + b_at_a
                    if swapped > current + 1e-6:
                        picks[slot_a], picks[slot_b] = pid_b, pid_a
                        changed = True

        return picks

    first_picks = select_team(cat_candidates, taken=set())
    second_picks = select_team(cat_candidates, taken=set(first_picks.values()))

    # Honorable mentions: top 3 per category, with cross-category dedup
    # (a player can only appear once across all HM categories).
    already = set(first_picks.values()) | set(second_picks.values())
    hm_taken = set()  # players already used as HM somewhere
    honorable = {}
    for cat in AC_CATEGORIES:
        hm_list = []
        for war_val, tb, pid in cat_candidates[cat]:
            if pid in already:
                continue
            if pid in hm_taken:
                continue
            if pid in hm_list:
                continue
            hm_list.append(pid)
            hm_taken.add(pid)
            if len(hm_list) >= 3:
                break
        honorable[cat] = hm_list

    # ── Pitcher selection ────────────────────────────────────────
    # Starters: qualified pitchers, sorted by WAR (FIP tiebreak)
    # Reliever: IP >= 15 AND GS < 4, sorted by WAR/IP (rate) with FIP tiebreak
    # Both pools obey: primary_role == "PIT" and WAR > 0.
    starter_candidates = []
    reliever_candidates = []
    for pid, rec in players.items():
        if rec["ip"] <= 0:
            continue
        if primary_role.get(pid) != "PIT":
            continue
        # Negative pitching WAR: exclude entirely
        if pit_war(rec) < 0:
            continue
        # Starters must be qualified (always, even in non-rate mode)
        if is_qualified_pit(rec):
            starter_candidates.append((pit_war(rec), pit_tiebreak(rec), pid))
        # Reliever uses WAR/IP regardless of rate_mode
        if rec["ip"] >= AC_REL_MIN_IP and rec["gs"] < AC_REL_MAX_GS + 1:
            # Skip relievers with negative rate WAR too
            if rec["war_pit_rate"] < 0:
                continue
            reliever_candidates.append(
                (rec["war_pit_rate"], pit_tiebreak(rec), pid)
            )

    starter_candidates.sort(key=lambda x: (x[0], x[1]), reverse=True)
    reliever_candidates.sort(key=lambda x: (x[0], x[1]), reverse=True)

    def pick_n(pool, already_ids, n):
        picks = []
        for war_val, tb, pid in pool:
            if pid in already_ids:
                continue
            if pid in picks:
                continue
            picks.append(pid)
            if len(picks) >= n:
                break
        return picks

    first_sp = pick_n(starter_candidates, set(), 4)
    first_rp = pick_n(reliever_candidates, set(first_sp), 1)
    taken_pit = set(first_sp) | set(first_rp)

    second_sp = pick_n(starter_candidates, taken_pit, 4)
    taken_pit |= set(second_sp)
    second_rp = pick_n(reliever_candidates, taken_pit, 1)
    taken_pit |= set(second_rp)

    hm_sp = pick_n(starter_candidates, taken_pit, 3)
    taken_pit |= set(hm_sp)
    hm_rp = pick_n(reliever_candidates, taken_pit, 3)

    # ── Serialize output ─────────────────────────────────────────
    def serialize_hitter(pid, slot):
        rec = players[pid]
        pg = rec.get("pos_games", {})
        is_two_way = rec["ip"] >= AC_UTIL_TWO_WAY_MIN_IP and rec["pa"] >= AC_UTIL_TWO_WAY_MIN_PA
        out = {
            "player_id": pid,
            "name": rec["name"],
            "team_id": rec["team_id"],
            "team_short": rec["team_short"],
            "team_logo": rec["team_logo"],
            "conference": rec["conference_abbrev"],
            "division_level": rec["division_level"],
            "headshot_url": rec["headshot_url"],
            "slot": slot,
            "listed_position": rec["listed_position"],
            "pos_games": pg,
            "war": round(rec["war_bat"], 2),
            "war_rate": round(rec["war_bat_rate"], 4) if rec["pa"] > 0 else None,
            "wrc_plus": rec.get("wrc_plus"),
            "pa": int(rec["pa"]),
            "avg": rec.get("avg"),
            "obp": rec.get("obp"),
            "slg": rec.get("slg"),
            "ops": rec.get("ops"),
            "iso": rec.get("iso"),
            "woba": rec.get("woba"),
            "hr": rec.get("hr"),
            "sb": rec.get("sb"),
            "k_pct": rec.get("bat_k_pct"),
            "bb_pct": rec.get("bat_bb_pct"),
            "is_two_way": is_two_way,
        }
        # Include pitching info for two-way players (so UTIL/HM cards can show it)
        if is_two_way:
            out["pitching"] = {
                "ip": rec.get("ip"),
                "gs": rec.get("gs"),
                "era": rec.get("era"),
                "fip": rec.get("fip"),
                "fip_plus": rec.get("fip_plus"),
                "siera": rec.get("siera"),
                "war": round(rec["war_pit"], 2),
                "k": rec.get("k"),
                "bb": rec.get("bb"),
                "k_pct": rec.get("pit_k_pct"),
                "bb_pct": rec.get("pit_bb_pct"),
            }
        return out

    def serialize_pitcher(pid, role):
        rec = players[pid]
        return {
            "player_id": pid,
            "name": rec["name"],
            "team_id": rec["team_id"],
            "team_short": rec["team_short"],
            "team_logo": rec["team_logo"],
            "conference": rec["conference_abbrev"],
            "division_level": rec["division_level"],
            "headshot_url": rec["headshot_url"],
            "slot": role,
            "war": round(rec["war_pit"], 2),
            "war_rate": round(rec["war_pit_rate"], 4) if rec["ip"] > 0 else None,
            "fip": rec.get("fip"),
            "fip_plus": rec.get("fip_plus"),
            "era": rec.get("era"),
            "whip": rec.get("whip"),
            "siera": rec.get("siera"),
            "ip": rec.get("ip"),
            "k": rec.get("k"),
            "bb": rec.get("bb"),
            "k_pct": rec.get("pit_k_pct"),
            "bb_pct": rec.get("pit_bb_pct"),
            "gs": rec.get("gs"),
        }

    def build_team_obj(hitter_picks, sp_list, rp_list):
        out = {}
        for slot, pid in hitter_picks.items():
            out[slot] = serialize_hitter(pid, slot) if pid else None
        for i, pid in enumerate(sp_list, start=1):
            out[f"SP{i}"] = serialize_pitcher(pid, f"SP{i}")
        # pad to 4 SPs
        for i in range(len(sp_list) + 1, 5):
            out[f"SP{i}"] = None
        out["RP"] = serialize_pitcher(rp_list[0], "RP") if rp_list else None
        return out

    first_team = build_team_obj(first_picks, first_sp, first_rp)
    second_team = build_team_obj(second_picks, second_sp, second_rp)

    # HM is keyed by CATEGORY (C/1B/2B/3B/SS/OF/DH/UTIL) so OF is one
    # combined list rather than three slot-specific lists.
    hm_out = {}
    for cat in AC_CATEGORIES:
        hm_out[cat] = [serialize_hitter(pid, cat) for pid in honorable[cat]]
    hm_out["SP"] = [serialize_pitcher(pid, "SP") for pid in hm_sp]
    hm_out["RP"] = [serialize_pitcher(pid, "RP") for pid in hm_rp]

    # ── Awards (MVP, HoY, PoY, Transfer of Year, Freshman of Year) ──
    # Awards rank all players in the conference by their total WAR
    # (bat_war + pit_war for two-way guys).  The five awards are
    # mutually exclusive so each goes to a different player.
    FRESHMAN_YEARS = {"Fr", "R-Fr"}

    def award_total_war(rec):
        # Combine both sides of the ball for two-way players so
        # dominant two-way guys can win MVP off pure total value.
        b = rec["war_bat"] if rec["pa"] > 0 else 0
        p = rec["war_pit"] if rec["ip"] > 0 else 0
        return b + p

    def is_freshman(rec):
        y = rec.get("year_in_school")
        return y in FRESHMAN_YEARS

    def is_transfer(rec):
        # First-year at current program AND not a freshman.
        if is_freshman(rec):
            return False
        first_season = first_season_by_pid_team.get(
            (rec["player_id"], rec["team_id"])
        )
        return first_season == season

    # Sort all players by MVP-style total WAR descending
    award_ranked = sorted(
        [(pid, rec, award_total_war(rec)) for pid, rec in players.items()
         if award_total_war(rec) > 0],
        key=lambda x: x[2],
        reverse=True,
    )

    def find_award(predicate, taken):
        for pid, rec, war in award_ranked:
            if pid in taken:
                continue
            if predicate(pid, rec):
                return pid
        return None

    taken_awards = set()

    # MVP: top total WAR, any role
    mvp_pid = find_award(lambda pid, rec: True, taken_awards)
    if mvp_pid:
        taken_awards.add(mvp_pid)

    # Hitter of the Year: best non-MVP hitter (primary_role == BAT)
    hoy_pid = find_award(
        lambda pid, rec: primary_role.get(pid) == "BAT" and rec["war_bat"] > 0,
        taken_awards,
    )
    if hoy_pid:
        taken_awards.add(hoy_pid)

    # Pitcher of the Year: best non-MVP pitcher
    # Ranking by total WAR matches the MVP ordering, which is fine —
    # a two-way guy wins PoY only if their pitching WAR alone still
    # ranks them higher than all other pitchers' pitching WAR.
    def pitcher_war_only(rec):
        return rec["war_pit"] if rec["ip"] > 0 else 0

    pitchers_ranked = sorted(
        [(pid, rec) for pid, rec in players.items()
         if pitcher_war_only(rec) > 0 and primary_role.get(pid) == "PIT"],
        key=lambda x: pitcher_war_only(x[1]),
        reverse=True,
    )
    poy_pid = None
    for pid, rec in pitchers_ranked:
        if pid in taken_awards:
            continue
        poy_pid = pid
        break
    if poy_pid:
        taken_awards.add(poy_pid)

    # Transfer of the Year: first-year at program, not freshman
    transfer_pid = find_award(
        lambda pid, rec: is_transfer(rec),
        taken_awards,
    )
    if transfer_pid:
        taken_awards.add(transfer_pid)

    # Freshman of the Year: Fr/R-Fr with the most WAR
    freshman_pid = find_award(
        lambda pid, rec: is_freshman(rec),
        taken_awards,
    )
    if freshman_pid:
        taken_awards.add(freshman_pid)

    def serialize_award(pid):
        if not pid:
            return None
        rec = players[pid]
        # Pick a position label: the player's first_team slot if they
        # landed on the first team, else their listed_position, else
        # role-based fallback.
        slot = None
        for s, p in first_picks.items():
            if p == pid:
                slot = s
                break
        if not slot:
            for s, p in second_picks.items():
                if p == pid:
                    slot = s
                    break
        if not slot:
            if pid in first_sp or pid in second_sp:
                slot = "SP"
            elif pid in first_rp or pid in second_rp:
                slot = "RP"
            elif primary_role.get(pid) == "PIT":
                slot = "P"
            else:
                slot = rec.get("listed_position") or "UTIL"
        return {
            "player_id": pid,
            "name": rec["name"],
            "team_id": rec["team_id"],
            "team_short": rec["team_short"],
            "team_logo": rec["team_logo"],
            "conference": rec["conference_abbrev"],
            "division_level": rec["division_level"],
            "headshot_url": rec["headshot_url"],
            "position": slot,
            "year_in_school": rec.get("year_in_school"),
        }

    awards = {
        "mvp": serialize_award(mvp_pid),
        "hitter_of_year": serialize_award(hoy_pid),
        "pitcher_of_year": serialize_award(poy_pid),
        "transfer_of_year": serialize_award(transfer_pid),
        "freshman_of_year": serialize_award(freshman_pid),
    }

    return {
        "conf": conf,
        "label": group["label"],
        "season": season,
        "rate_mode": rate_mode,
        "team_count": len(team_ids),
        "teams": [
            {"id": t["id"], "name": t["name"], "short_name": t["short_name"],
             "logo_url": t["logo_url"], "conference_abbrev": t["conference_abbrev"]}
            for t in teams_by_id.values()
        ],
        "first_team": first_team,
        "second_team": second_team,
        "honorable_mentions": hm_out,
        "awards": awards,
        "frozen": is_frozen,
        "frozen_at": freeze["frozen_at"].isoformat() if is_frozen else None,
        "regular_season_end_date": (
            freeze["regular_season_end_date"].isoformat() if is_frozen else None
        ),
    }


# ── Historic Matchup (Coaching Tool) ────────────────────────────────────
#
# Returns aggregated batting + pitching player stats from every game played
# between two teams in a given season, plus a list of those games (scores,
# location, W/L/S decisions). Used by the "Historic" page in the Coaching
# tab to show how a team's players performed against a specific opponent.


# In-process cache for league constants. Keyed by (season, division_level).
# Constants change slowly relative to request rate, and recomputing them
# requires two SUMs over batting_stats/pitching_stats — fine to compute
# on-demand the first time for a given season+division and reuse after.
_LEAGUE_CONSTANTS_CACHE: dict = {}


def _get_league_constants(cur, season: int, division_level: str) -> dict:
    """Return league constants for a given division+season needed to compute
    advanced stats (FIP, wOBA, wRC+, etc.). Mirrors the multi-year run
    environment used by scripts/recalculate_league_adjusted.py — averages
    across 2022 through `season`, which keeps the FIP constant stable
    early in the year.
    """
    key = (season, division_level)
    if key in _LEAGUE_CONSTANTS_CACHE:
        return _LEAGUE_CONSTANTS_CACHE[key]

    # Batting aggregates for the division.
    cur.execute("""
        SELECT SUM(bs.plate_appearances) AS total_pa,
               SUM(bs.at_bats) AS total_ab,
               SUM(bs.hits) AS total_h,
               SUM(bs.doubles) AS total_2b,
               SUM(bs.triples) AS total_3b,
               SUM(bs.home_runs) AS total_hr,
               SUM(bs.runs) AS total_r,
               SUM(bs.walks) AS total_bb,
               SUM(bs.intentional_walks) AS total_ibb,
               SUM(bs.strikeouts) AS total_k,
               SUM(bs.hit_by_pitch) AS total_hbp,
               SUM(bs.sacrifice_flies) AS total_sf
        FROM batting_stats bs
        JOIN teams t ON bs.team_id = t.id
        JOIN conferences c ON t.conference_id = c.id
        JOIN divisions d ON c.division_id = d.id
        WHERE bs.season BETWEEN 2022 AND %s
          AND d.level = %s
          AND bs.plate_appearances >= 5
    """, (season, division_level))
    bat = cur.fetchone()

    cur.execute("""
        SELECT SUM(ps.innings_pitched) AS total_ip,
               SUM(ps.earned_runs) AS total_er,
               SUM(ps.hits_allowed) AS total_h,
               SUM(ps.walks) AS total_bb,
               SUM(ps.strikeouts) AS total_k,
               SUM(ps.home_runs_allowed) AS total_hr,
               SUM(ps.hit_batters) AS total_hbp
        FROM pitching_stats ps
        JOIN teams t ON ps.team_id = t.id
        JOIN conferences c ON t.conference_id = c.id
        JOIN divisions d ON c.division_id = d.id
        WHERE ps.season BETWEEN 2022 AND %s
          AND d.level = %s
          AND ps.innings_pitched >= 1
    """, (season, division_level))
    pit = cur.fetchone()

    weights = DEFAULT_WEIGHTS.get(division_level, DEFAULT_WEIGHTS["D1"])

    # Defaults if a division has no rows yet (e.g. season too early).
    fallback = {
        "lg_avg": 0.270, "lg_obp": 0.350, "lg_slg": 0.400,
        "lg_woba": 0.320, "lg_r_per_pa": weights.runs_per_pa,
        "lg_era": 4.50, "lg_fip": 4.20, "fip_constant": 3.10,
        "weights": weights, "division_level": division_level,
    }
    if not bat or not bat.get("total_pa") or not pit or not pit.get("total_ip"):
        _LEAGUE_CONSTANTS_CACHE[key] = fallback
        return fallback

    total_pa = bat["total_pa"] or 1
    total_ab = bat["total_ab"] or 1
    total_ip = pit["total_ip"] or 1

    lg_h = bat["total_h"] or 0
    lg_2b = bat["total_2b"] or 0
    lg_3b = bat["total_3b"] or 0
    lg_hr = bat["total_hr"] or 0
    lg_1b = lg_h - lg_2b - lg_3b - lg_hr
    lg_bb = bat["total_bb"] or 0
    lg_ibb = bat["total_ibb"] or 0
    lg_ubb = lg_bb - lg_ibb
    lg_hbp = bat["total_hbp"] or 0
    lg_sf = bat["total_sf"] or 0
    lg_runs = bat["total_r"] or 0

    lg_avg = lg_h / total_ab
    lg_obp = (lg_h + lg_bb + lg_hbp) / (total_ab + lg_bb + lg_hbp + lg_sf)
    lg_tb = lg_1b + 2 * lg_2b + 3 * lg_3b + 4 * lg_hr
    lg_slg = lg_tb / total_ab
    lg_r_per_pa = lg_runs / total_pa

    woba_num = (
        weights.w_bb * lg_ubb
        + weights.w_hbp * lg_hbp
        + weights.w_1b * lg_1b
        + weights.w_2b * lg_2b
        + weights.w_3b * lg_3b
        + weights.w_hr * lg_hr
    )
    woba_denom = total_ab + lg_ubb + lg_sf + lg_hbp
    lg_woba = woba_num / woba_denom if woba_denom > 0 else 0.320

    pit_er = pit["total_er"] or 0
    pit_bb = pit["total_bb"] or 0
    pit_k = pit["total_k"] or 0
    pit_hr = pit["total_hr"] or 0
    pit_hbp = pit["total_hbp"] or 0

    lg_era = (pit_er * 9) / total_ip if total_ip > 0 else 4.50

    fip_const = compute_fip_constant(
        league_era=lg_era,
        league_hr=pit_hr,
        league_bb=pit_bb,
        league_hbp=pit_hbp,
        league_k=pit_k,
        league_ip=total_ip,
    )

    ip_decimal = innings_to_outs(total_ip) / 3.0 if total_ip else 1
    lg_fip = (
        (13 * pit_hr + 3 * (pit_bb + pit_hbp) - 2 * pit_k) / ip_decimal
    ) + fip_const

    constants = {
        "lg_avg": lg_avg,
        "lg_obp": lg_obp,
        "lg_slg": lg_slg,
        "lg_woba": lg_woba,
        "lg_r_per_pa": lg_r_per_pa,
        "lg_era": lg_era,
        "lg_fip": lg_fip,
        "fip_constant": fip_const,
        "weights": weights,
        "division_level": division_level,
    }
    _LEAGUE_CONSTANTS_CACHE[key] = constants
    return constants


# ── Top Moments of the season (Phase D.5 surface) ────────────────────
#
# Three-in-one endpoint powering the /top-moments page. Returns the
# season's biggest single-PA WPA swings, the cumulative-WPA hitter
# leaderboard, and the cumulative-WPA pitcher leaderboard.
#
# Moments are filtered to AUDIT-CLEAN games — we don't want artifact
# walk-offs from games with scorer-omitted runs (we saw +0.94 fakes
# during Phase D.5 development from missing-run games). Player
# leaderboards include all events because per-PA noise averages out
# when you sum across 50+ PAs.

@router.get("/top-moments")
def top_moments(
    season: int = Query(2026, description="Season year"),
    moments_limit: int = Query(25, description="How many top PAs to return"),
    leaderboard_limit: int = Query(25, description="How many leaderboard rows"),
    min_pa: int = Query(50, description="Minimum PAs/BFs for leaderboard inclusion"),
):
    SUBEVENT_TYPES = (
        'stolen_base', 'caught_stealing', 'wild_pitch',
        'passed_ball', 'balk', 'pickoff', 'runner_other',
    )
    with get_connection() as conn:
        cur = conn.cursor()

        # ── Top single-PA WPA moments ──
        # Audit-clean games only. Join everything we need to render
        # rich game-context cards on the frontend without a second
        # round-trip per moment.
        cur.execute("""
            WITH game_audit AS (
                SELECT g.id AS game_id,
                       (g.home_score + g.away_score) AS actual_total,
                       COALESCE(SUM(ge.runs_on_play), 0) AS derived_total
                FROM games g
                LEFT JOIN game_events ge ON ge.game_id = g.id
                WHERE g.season = %s
                  AND g.home_score IS NOT NULL
                  AND g.away_score IS NOT NULL
                  AND g.home_score <> g.away_score
                GROUP BY g.id
            )
            SELECT
                ge.id, ge.game_id, g.game_date,
                ge.inning, ge.half, ge.sequence_idx,
                ge.balls_before, ge.strikes_before, ge.pitch_sequence,
                ge.bat_score_before, ge.fld_score_before, ge.runs_on_play,
                ge.batter_player_id, ge.batter_name, ge.batting_team_id,
                ge.pitcher_player_id, ge.pitcher_name,
                ge.result_type, ge.result_text,
                ge.wpa_batter, ge.wp_before, ge.wp_after,
                g.home_team_id, g.away_team_id,
                g.home_score AS final_home, g.away_score AS final_away,
                COALESCE(th.short_name, th.name) AS home_short,
                COALESCE(ta.short_name, ta.name) AS away_short,
                th.logo_url AS home_logo, ta.logo_url AS away_logo
            FROM game_events ge
            JOIN game_audit ga ON ga.game_id = ge.game_id
                              AND ga.derived_total = ga.actual_total
            JOIN games g  ON g.id = ge.game_id
            JOIN teams th ON th.id = g.home_team_id
            JOIN teams ta ON ta.id = g.away_team_id
            WHERE g.season = %s
              AND ge.wpa_batter IS NOT NULL
              AND ge.batter_player_id IS NOT NULL
              AND ge.pitcher_player_id IS NOT NULL
              AND ge.result_type NOT IN %s
            ORDER BY ge.wpa_batter DESC
            LIMIT %s
        """, (season, season, SUBEVENT_TYPES, moments_limit))
        moments = []
        for r in cur.fetchall():
            home_batting = (r["half"] == "bottom")
            batter_team_id = r["home_team_id"] if home_batting else r["away_team_id"]
            pitcher_team_id = r["away_team_id"] if home_batting else r["home_team_id"]
            moments.append({
                "id": r["id"],
                "game_id": r["game_id"],
                "game_date": r["game_date"].isoformat() if r["game_date"] else None,
                "inning": r["inning"],
                "half": r["half"],
                "balls_before": r["balls_before"],
                "strikes_before": r["strikes_before"],
                "pitch_sequence": r["pitch_sequence"],
                "bat_score_before": r["bat_score_before"],
                "fld_score_before": r["fld_score_before"],
                "runs_on_play": r["runs_on_play"] or 0,
                "result_type": r["result_type"],
                "result_text": r["result_text"],
                "wpa": float(r["wpa_batter"]) if r["wpa_batter"] is not None else None,
                "wp_before": float(r["wp_before"]) if r["wp_before"] is not None else None,
                "wp_after": float(r["wp_after"]) if r["wp_after"] is not None else None,
                "batter": {
                    "id": r["batter_player_id"],
                    "name": r["batter_name"],
                    "team_id": batter_team_id,
                },
                "pitcher": {
                    "id": r["pitcher_player_id"],
                    "name": r["pitcher_name"],
                    "team_id": pitcher_team_id,
                },
                "game": {
                    "home_short": r["home_short"],
                    "away_short": r["away_short"],
                    "home_logo": r["home_logo"],
                    "away_logo": r["away_logo"],
                    "final_home": r["final_home"],
                    "final_away": r["final_away"],
                },
            })

        # ── Top hitters by total WPA ──
        cur.execute("""
            SELECT p.id, p.first_name, p.last_name, p.position, p.bats,
                   t.id AS team_id, t.short_name AS team_short,
                   t.logo_url AS team_logo,
                   d.level AS division_level,
                   c.abbreviation AS conference_abbrev,
                   SUM(ge.wpa_batter)        AS total_wpa,
                   COUNT(ge.wpa_batter)      AS pa,
                   MAX(ge.wpa_batter)        AS peak_wpa,
                   AVG(ABS(ge.wpa_batter))   AS mean_abs_wpa
            FROM game_events ge
            JOIN games g       ON g.id = ge.game_id
            JOIN players p     ON p.id = ge.batter_player_id
            JOIN teams t       ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d   ON d.id = c.division_id
            WHERE g.season = %s AND ge.wpa_batter IS NOT NULL
            GROUP BY p.id, p.first_name, p.last_name, p.position, p.bats,
                     t.id, t.short_name, t.logo_url,
                     d.level, c.abbreviation
            HAVING COUNT(ge.wpa_batter) >= %s
            ORDER BY SUM(ge.wpa_batter) DESC
            LIMIT %s
        """, (season, min_pa, leaderboard_limit))
        top_hitters = []
        for i, r in enumerate(cur.fetchall(), start=1):
            top_hitters.append({
                "rank": i,
                "player_id": r["id"],
                "name": f"{r['first_name']} {r['last_name']}",
                "position": r["position"],
                "bats": r["bats"],
                "team_id": r["team_id"],
                "team_short": r["team_short"],
                "team_logo": r["team_logo"],
                "division_level": r["division_level"],
                "conference": r["conference_abbrev"],
                "total_wpa": float(r["total_wpa"]),
                "peak_wpa": float(r["peak_wpa"]) if r["peak_wpa"] is not None else None,
                "mean_abs_wpa": float(r["mean_abs_wpa"]) if r["mean_abs_wpa"] is not None else None,
                "pa": int(r["pa"]),
            })

        # ── Top pitchers by total WPA ──
        cur.execute("""
            SELECT p.id, p.first_name, p.last_name, p.position, p.throws,
                   t.id AS team_id, t.short_name AS team_short,
                   t.logo_url AS team_logo,
                   d.level AS division_level,
                   c.abbreviation AS conference_abbrev,
                   SUM(ge.wpa_pitcher)        AS total_wpa,
                   COUNT(ge.wpa_pitcher)      AS bf,
                   MAX(ge.wpa_pitcher)        AS peak_wpa,
                   AVG(ABS(ge.wpa_pitcher))   AS mean_abs_wpa
            FROM game_events ge
            JOIN games g       ON g.id = ge.game_id
            JOIN players p     ON p.id = ge.pitcher_player_id
            JOIN teams t       ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d   ON d.id = c.division_id
            WHERE g.season = %s AND ge.wpa_pitcher IS NOT NULL
            GROUP BY p.id, p.first_name, p.last_name, p.position, p.throws,
                     t.id, t.short_name, t.logo_url,
                     d.level, c.abbreviation
            HAVING COUNT(ge.wpa_pitcher) >= %s
            ORDER BY SUM(ge.wpa_pitcher) DESC
            LIMIT %s
        """, (season, min_pa, leaderboard_limit))
        top_pitchers = []
        for i, r in enumerate(cur.fetchall(), start=1):
            top_pitchers.append({
                "rank": i,
                "player_id": r["id"],
                "name": f"{r['first_name']} {r['last_name']}",
                "position": r["position"],
                "throws": r["throws"],
                "team_id": r["team_id"],
                "team_short": r["team_short"],
                "team_logo": r["team_logo"],
                "division_level": r["division_level"],
                "conference": r["conference_abbrev"],
                "total_wpa": float(r["total_wpa"]),
                "peak_wpa": float(r["peak_wpa"]) if r["peak_wpa"] is not None else None,
                "mean_abs_wpa": float(r["mean_abs_wpa"]) if r["mean_abs_wpa"] is not None else None,
                "bf": int(r["bf"]),
            })

        return {
            "season": season,
            "moments": moments,
            "top_hitters": top_hitters,
            "top_pitchers": top_pitchers,
            "min_pa": min_pa,
        }


@router.get("/coaching/historic-matchup")
def historic_matchup(
    team_a: int = Query(..., description="First team id"),
    team_b: int = Query(..., description="Opponent team id"),
    season: int = Query(2026, description="Season year"),
):
    """Per-player batting and pitching aggregates for the games team_a
    and team_b played each other this season, plus a list of those games.
    """
    if team_a == team_b:
        raise HTTPException(
            status_code=400,
            detail="team_a and team_b must be different",
        )

    with get_connection() as conn:
        cur = conn.cursor()

        # ── Team metadata ──
        cur.execute("""
            SELECT t.id, t.name, t.short_name, t.logo_url,
                   c.abbreviation AS conference_abbrev,
                   d.level AS division_level
            FROM teams t
            LEFT JOIN conferences c ON t.conference_id = c.id
            LEFT JOIN divisions d ON c.division_id = d.id
            WHERE t.id = ANY(%s)
        """, ([team_a, team_b],))
        team_rows = {r["id"]: dict(r) for r in cur.fetchall()}
        if team_a not in team_rows or team_b not in team_rows:
            raise HTTPException(status_code=404, detail="Team not found")

        def _team_payload(tid):
            r = team_rows[tid]
            return {
                "id": r["id"],
                "name": r["name"],
                "short_name": r["short_name"] or r["name"],
                "logo_url": r["logo_url"],
                "conference_abbrev": r["conference_abbrev"],
                "division_level": r["division_level"],
            }

        # ── Games between the two teams this season ──
        cur.execute("""
            SELECT g.id, g.game_date, g.home_team_id, g.away_team_id,
                   g.home_score, g.away_score,
                   g.is_neutral_site, g.location,
                   g.game_number,
                   COALESCE(ht.short_name, ht.name) AS home_short,
                   COALESCE(at2.short_name, at2.name) AS away_short
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at2 ON g.away_team_id = at2.id
            WHERE g.season = %s
              AND g.status = 'final'
              AND g.home_score IS NOT NULL
              AND g.away_score IS NOT NULL
              AND (
                (g.home_team_id = %s AND g.away_team_id = %s)
                OR (g.home_team_id = %s AND g.away_team_id = %s)
              )
            ORDER BY g.game_date ASC,
                     g.game_number ASC NULLS LAST,
                     g.id ASC
        """, (season, team_a, team_b, team_b, team_a))
        games_rows = [dict(r) for r in cur.fetchall()]

        if not games_rows:
            return {
                "season": season,
                "team_a": _team_payload(team_a),
                "team_b": _team_payload(team_b),
                "games": [],
                "team_a_batting": [],
                "team_a_pitching": [],
                "team_b_batting": [],
                "team_b_pitching": [],
            }

        game_ids = [g["id"] for g in games_rows]
        # Map of game_id -> (home_team_id, away_team_id) for ghost-row guard.
        game_sides = {
            g["id"]: (g["home_team_id"], g["away_team_id"])
            for g in games_rows
        }

        # ── Decisions per game (W / L / S) ──
        cur.execute("""
            SELECT game_id, team_id, player_id, player_name, decision
            FROM game_pitching
            WHERE game_id = ANY(%s)
              AND decision IN ('W', 'L', 'S')
        """, (game_ids,))
        decisions_by_game = {}
        for r in cur.fetchall():
            decisions_by_game.setdefault(r["game_id"], []).append(dict(r))

        def _decision_for(game_id, team_id, kind):
            for d in decisions_by_game.get(game_id, []):
                if d["team_id"] == team_id and d["decision"] == kind:
                    return d["player_name"]
            return None

        # Build games[] payload.
        games_out = []
        for g in games_rows:
            home_id = g["home_team_id"]
            away_id = g["away_team_id"]
            if g["home_score"] > g["away_score"]:
                winning_team_id, losing_team_id = home_id, away_id
            elif g["away_score"] > g["home_score"]:
                winning_team_id, losing_team_id = away_id, home_id
            else:
                winning_team_id = losing_team_id = None

            wp = (
                _decision_for(g["id"], winning_team_id, "W")
                if winning_team_id else None
            )
            lp = (
                _decision_for(g["id"], losing_team_id, "L")
                if losing_team_id else None
            )
            sv = (
                _decision_for(g["id"], winning_team_id, "S")
                if winning_team_id else None
            )

            games_out.append({
                "id": g["id"],
                "game_date": g["game_date"].isoformat() if g["game_date"] else None,
                "game_number": g["game_number"],
                "home_team_id": home_id,
                "away_team_id": away_id,
                "home_short": g["home_short"],
                "away_short": g["away_short"],
                "home_score": g["home_score"],
                "away_score": g["away_score"],
                "is_neutral_site": g["is_neutral_site"],
                "location": g["location"],
                "winning_pitcher": wp,
                "losing_pitcher": lp,
                "save_pitcher": sv,
            })

        # ── Aggregate batting per side ──
        # Pull every game_batting row across all matchup games, with the
        # ghost-row guard (team_id must match one of the game's two sides).
        cur.execute("""
            SELECT gb.game_id, gb.player_id, gb.player_name, gb.team_id,
                   gb.at_bats, gb.runs, gb.hits, gb.doubles, gb.triples,
                   gb.home_runs, gb.rbi, gb.walks, gb.strikeouts,
                   gb.hit_by_pitch, gb.sacrifice_flies, gb.sacrifice_bunts,
                   gb.stolen_bases, gb.caught_stealing,
                   p.headshot_url, p.jersey_number,
                   p.first_name, p.last_name
            FROM game_batting gb
            LEFT JOIN players p ON p.id = gb.player_id
            WHERE gb.game_id = ANY(%s)
        """, (game_ids,))
        bat_rows = [dict(r) for r in cur.fetchall()]

        cur.execute("""
            SELECT gp.game_id, gp.player_id, gp.player_name, gp.team_id,
                   gp.innings_pitched, gp.hits_allowed, gp.runs_allowed,
                   gp.earned_runs, gp.walks, gp.strikeouts,
                   gp.home_runs_allowed, gp.hit_batters,
                   gp.wild_pitches, gp.batters_faced, gp.decision,
                   gp.is_starter,
                   p.headshot_url, p.jersey_number,
                   p.first_name, p.last_name
            FROM game_pitching gp
            LEFT JOIN players p ON p.id = gp.player_id
            WHERE gp.game_id = ANY(%s)
        """, (game_ids,))
        pit_rows = [dict(r) for r in cur.fetchall()]

        # ── Season-to-date stats for every batter in the matchup ──
        batter_player_ids = sorted({
            r["player_id"] for r in bat_rows if r["player_id"]
        })
        season_batting_by_player: dict = {}
        if batter_player_ids:
            cur.execute("""
                SELECT bs.player_id,
                       SUM(bs.plate_appearances) AS pa,
                       SUM(bs.at_bats)           AS ab,
                       SUM(bs.hits)              AS h,
                       SUM(bs.doubles)           AS doubles,
                       SUM(bs.triples)           AS triples,
                       SUM(bs.home_runs)         AS hr,
                       SUM(bs.walks)             AS bb,
                       SUM(bs.strikeouts)        AS k,
                       SUM(bs.hit_by_pitch)      AS hbp,
                       SUM(bs.sacrifice_flies)   AS sf
                FROM batting_stats bs
                WHERE bs.player_id = ANY(%s)
                  AND bs.season = %s
                GROUP BY bs.player_id
            """, (batter_player_ids, season))
            season_batting_by_player = {
                r["player_id"]: dict(r) for r in cur.fetchall()
            }

        def _season_batting_for(player_id):
            """Compute a small dict of season stats for one batter, derived
            from summed batting_stats rows (handles transfers cleanly).
            Returns dict with pa, avg, ops, hr, k_pct, bb_pct (or Nones).
            """
            row = season_batting_by_player.get(player_id)
            if not row or not row.get("pa"):
                return {
                    "season_pa": None, "season_avg": None, "season_ops": None,
                    "season_hr": None, "season_k_pct": None,
                    "season_bb_pct": None,
                }
            pa = int(row["pa"] or 0)
            ab = int(row["ab"] or 0)
            h = int(row["h"] or 0)
            doubles = int(row["doubles"] or 0)
            triples = int(row["triples"] or 0)
            hr = int(row["hr"] or 0)
            bb = int(row["bb"] or 0)
            k = int(row["k"] or 0)
            hbp = int(row["hbp"] or 0)
            sf = int(row["sf"] or 0)
            singles = h - doubles - triples - hr
            tb = singles + 2 * doubles + 3 * triples + 4 * hr
            avg = round(h / ab, 3) if ab > 0 else None
            obp_denom = ab + bb + hbp + sf
            obp = round((h + bb + hbp) / obp_denom, 3) if obp_denom > 0 else None
            slg = round(tb / ab, 3) if ab > 0 else None
            ops = round((obp or 0) + (slg or 0), 3) if (obp is not None and slg is not None) else None
            return {
                "season_pa": pa,
                "season_avg": avg,
                "season_ops": ops,
                "season_hr": hr,
                "season_k_pct": (k / pa) if pa > 0 else None,
                "season_bb_pct": (bb / pa) if pa > 0 else None,
            }

        def _aggregate_batting(side_team_id):
            bucket = {}
            for r in bat_rows:
                # Ghost-row guard: only include rows where team_id matches
                # one of the game's two sides AND matches the side we want.
                home_id, away_id = game_sides[r["game_id"]]
                if r["team_id"] not in (home_id, away_id):
                    continue
                if r["team_id"] != side_team_id:
                    continue
                # Group by player_id when available, fall back to name.
                key = r["player_id"] or ("name:" + (r["player_name"] or ""))
                if key not in bucket:
                    bucket[key] = {
                        "player_id": r["player_id"],
                        "player_name": (
                            (r["first_name"] or "") + " " + (r["last_name"] or "")
                        ).strip() or r["player_name"],
                        "headshot_url": r["headshot_url"],
                        "jersey_number": r["jersey_number"],
                        "g": 0, "ab": 0, "r": 0, "h": 0,
                        "doubles": 0, "triples": 0, "hr": 0, "rbi": 0,
                        "bb": 0, "k": 0, "hbp": 0, "sf": 0, "sh": 0,
                        "sb": 0, "cs": 0,
                    }
                b = bucket[key]
                b["g"] += 1
                b["ab"] += r["at_bats"] or 0
                b["r"] += r["runs"] or 0
                b["h"] += r["hits"] or 0
                b["doubles"] += r["doubles"] or 0
                b["triples"] += r["triples"] or 0
                b["hr"] += r["home_runs"] or 0
                b["rbi"] += r["rbi"] or 0
                b["bb"] += r["walks"] or 0
                b["k"] += r["strikeouts"] or 0
                b["hbp"] += r["hit_by_pitch"] or 0
                b["sf"] += r["sacrifice_flies"] or 0
                b["sh"] += r["sacrifice_bunts"] or 0
                b["sb"] += r["stolen_bases"] or 0
                b["cs"] += r["caught_stealing"] or 0

            out = []
            for b in bucket.values():
                ab, h, bb, hbp, sf = b["ab"], b["h"], b["bb"], b["hbp"], b["sf"]
                obp_denom = ab + bb + hbp + sf
                singles = h - b["doubles"] - b["triples"] - b["hr"]
                tb = singles + 2 * b["doubles"] + 3 * b["triples"] + 4 * b["hr"]
                avg = round(h / ab, 3) if ab > 0 else None
                obp = round((h + bb + hbp) / obp_denom, 3) if obp_denom > 0 else None
                slg = round(tb / ab, 3) if ab > 0 else None
                ops = round(obp + slg, 3) if (obp is not None and slg is not None) else None
                xbh = b["doubles"] + b["triples"] + b["hr"]
                pa = ab + bb + hbp + sf + b["sh"]
                # Skip players who never came to the plate in the matchup
                # (typically pitchers who pitched but didn't bat). Keeps the
                # batting table focused on actual hitters.
                if pa <= 0:
                    continue
                out.append({
                    **b,
                    "pa": pa, "tb": tb, "xbh": xbh,
                    "avg": avg, "obp": obp, "slg": slg, "ops": ops,
                    **_season_batting_for(b["player_id"]),
                })
            # Sort: most PA first (regulars on top), tie-break by AVG desc.
            out.sort(key=lambda x: (-(x["pa"]), -(x["avg"] or 0)))
            return out

        # ── Season-to-date stats for every pitcher in the matchup ──
        # One batched query keyed by player_id, summed across rows in case
        # a pitcher transferred mid-season (rare, but be defensive).
        pitcher_player_ids = sorted({
            r["player_id"] for r in pit_rows if r["player_id"]
        })
        season_pitching_by_player: dict = {}
        if pitcher_player_ids:
            cur.execute("""
                SELECT ps.player_id,
                       SUM(ps.innings_pitched)   AS ip,
                       SUM(ps.strikeouts)        AS k,
                       SUM(ps.walks)             AS bb,
                       SUM(ps.home_runs_allowed) AS hr,
                       SUM(ps.hit_batters)       AS hbp,
                       SUM(ps.batters_faced)     AS bf
                FROM pitching_stats ps
                WHERE ps.player_id = ANY(%s)
                  AND ps.season = %s
                GROUP BY ps.player_id
            """, (pitcher_player_ids, season))
            season_pitching_by_player = {
                r["player_id"]: dict(r) for r in cur.fetchall()
            }

        def _season_stats_for(player_id, division_level):
            """Compute (season_ip, season_fip, season_k_pct, season_bb_pct)
            for a single pitcher, using the side's division for FIP constant.
            Returns Nones if the player has no season totals.
            """
            row = season_pitching_by_player.get(player_id)
            if not row or not row.get("ip"):
                return None, None, None, None
            ip = float(row["ip"] or 0)
            k = int(row["k"] or 0)
            bb = int(row["bb"] or 0)
            hr = int(row["hr"] or 0)
            hbp = int(row["hbp"] or 0)
            bf = int(row["bf"] or 0)
            outs = innings_to_outs(ip)
            if outs <= 0:
                return None, None, None, None
            ip_decimal = outs / 3.0
            lc = _get_league_constants(cur, season, division_level or "D1")
            fip = (
                (13 * hr + 3 * (bb + hbp) - 2 * k) / ip_decimal
            ) + lc["fip_constant"]
            k_pct = (k / bf) if bf > 0 else None
            bb_pct = (bb / bf) if bf > 0 else None
            return ip, round(fip, 2), k_pct, bb_pct

        def _aggregate_pitching(side_team_id, division_level=None):
            bucket = {}
            for r in pit_rows:
                home_id, away_id = game_sides[r["game_id"]]
                if r["team_id"] not in (home_id, away_id):
                    continue
                if r["team_id"] != side_team_id:
                    continue
                key = r["player_id"] or ("name:" + (r["player_name"] or ""))
                if key not in bucket:
                    bucket[key] = {
                        "player_id": r["player_id"],
                        "player_name": (
                            (r["first_name"] or "") + " " + (r["last_name"] or "")
                        ).strip() or r["player_name"],
                        "headshot_url": r["headshot_url"],
                        "jersey_number": r["jersey_number"],
                        "g": 0, "gs": 0, "outs": 0,
                        "h": 0, "r": 0, "er": 0,
                        "bb": 0, "k": 0, "hr": 0, "hbp": 0,
                        "wp": 0, "bf": 0,
                        "w": 0, "l": 0, "sv": 0,
                    }
                p = bucket[key]
                p["g"] += 1
                if r["is_starter"]:
                    p["gs"] += 1
                p["outs"] += ip_to_outs(r["innings_pitched"])
                p["h"] += r["hits_allowed"] or 0
                p["r"] += r["runs_allowed"] or 0
                p["er"] += r["earned_runs"] or 0
                p["bb"] += r["walks"] or 0
                p["k"] += r["strikeouts"] or 0
                p["hr"] += r["home_runs_allowed"] or 0
                p["hbp"] += r["hit_batters"] or 0
                p["wp"] += r["wild_pitches"] or 0
                p["bf"] += r["batters_faced"] or 0
                d = (r["decision"] or "").upper()
                if d == "W":
                    p["w"] += 1
                elif d == "L":
                    p["l"] += 1
                elif d == "S":
                    p["sv"] += 1

            out = []
            for p in bucket.values():
                outs = p["outs"]
                ip_display = outs_to_ip(outs)
                era = round(p["er"] * 27 / outs, 2) if outs > 0 else None
                whip = round((p["h"] + p["bb"]) * 3 / outs, 2) if outs > 0 else None
                k9 = round(p["k"] * 27 / outs, 2) if outs > 0 else None
                bb9 = round(p["bb"] * 27 / outs, 2) if outs > 0 else None
                # Approximate opp-AVG: opp_AB ≈ BF − BB − HBP
                # (we don't track opp SF / SH separately).
                opp_ab = max(p["bf"] - p["bb"] - p["hbp"], 0)
                opp_avg = round(p["h"] / opp_ab, 3) if opp_ab > 0 else None
                decision_parts = []
                if p["w"]:
                    decision_parts.append(f"{p['w']}W")
                if p["l"]:
                    decision_parts.append(f"{p['l']}L")
                if p["sv"]:
                    decision_parts.append(f"{p['sv']}SV")
                decision_summary = " ".join(decision_parts) or None
                s_ip, s_fip, s_k_pct, s_bb_pct = _season_stats_for(
                    p["player_id"], division_level
                )
                out.append({
                    **p,
                    "ip": ip_display,
                    "era": era,
                    "whip": whip,
                    "k9": k9,
                    "bb9": bb9,
                    "opp_avg": opp_avg,
                    "decision_summary": decision_summary,
                    "season_ip": s_ip,
                    "season_fip": s_fip,
                    "season_k_pct": s_k_pct,
                    "season_bb_pct": s_bb_pct,
                })
            # Sort: most outs first (workhorses on top), tie-break by lower ERA.
            out.sort(key=lambda x: (-(x["outs"]), x["era"] if x["era"] is not None else 999))
            return out

        # ── Team-level series totals (with advanced stats) ──
        #
        # Sums every batting/pitching row for the side, then runs it through
        # compute_batting_advanced / compute_pitching_advanced using the
        # division's league constants (FIP constant, league wOBA, league
        # R/PA), so the wRC+/FIP/etc. are calibrated the same way they are
        # everywhere else on the site.

        def _team_batting_totals(side_team_id: int, division_level: str) -> dict:
            line = BattingLine()
            for r in bat_rows:
                home_id, away_id = game_sides[r["game_id"]]
                if r["team_id"] not in (home_id, away_id):
                    continue
                if r["team_id"] != side_team_id:
                    continue
                line.ab += r["at_bats"] or 0
                line.hits += r["hits"] or 0
                line.doubles += r["doubles"] or 0
                line.triples += r["triples"] or 0
                line.hr += r["home_runs"] or 0
                line.bb += r["walks"] or 0
                line.k += r["strikeouts"] or 0
                line.hbp += r["hit_by_pitch"] or 0
                line.sf += r["sacrifice_flies"] or 0
                line.sh += r["sacrifice_bunts"] or 0
                line.sb += r["stolen_bases"] or 0
                line.cs += r["caught_stealing"] or 0
            line.pa = line.ab + line.bb + line.hbp + line.sf + line.sh

            # Sum runs separately — BattingLine has no runs field.
            runs = sum(
                (r["runs"] or 0)
                for r in bat_rows
                if r["team_id"] == side_team_id
                and r["team_id"] in game_sides[r["game_id"]]
            )
            rbi = sum(
                (r["rbi"] or 0)
                for r in bat_rows
                if r["team_id"] == side_team_id
                and r["team_id"] in game_sides[r["game_id"]]
            )

            lc = _get_league_constants(cur, season, division_level or "D1")
            adv = compute_batting_advanced(
                line,
                weights=lc["weights"],
                league_woba=lc["lg_woba"],
                league_obp=lc["lg_obp"],
                park_factor=1.0,  # Series-level: we don't blend park factors
                division_level=lc["division_level"],
            )

            def _r(v, d=3):
                return round(v, d) if v is not None else None

            return {
                "pa": line.pa, "ab": line.ab, "r": runs, "h": line.hits,
                "doubles": line.doubles, "triples": line.triples,
                "hr": line.hr, "rbi": rbi,
                "bb": line.bb, "k": line.k, "hbp": line.hbp,
                "sf": line.sf, "sh": line.sh,
                "sb": line.sb, "cs": line.cs,
                "tb": line.tb,
                "avg": _r(adv.batting_avg, 3),
                "obp": _r(adv.obp, 3),
                "slg": _r(adv.slg, 3),
                "ops": _r(adv.ops, 3),
                "iso": _r(adv.iso, 3),
                "babip": _r(adv.babip, 3),
                "bb_pct": _r(adv.bb_pct, 4),
                "k_pct": _r(adv.k_pct, 4),
                "woba": _r(adv.woba, 3),
                "wobacon": _r(adv.wobacon, 3),
                "wraa": _r(adv.wraa, 1),
                "wrc_plus": _r(adv.wrc_plus, 0),
                "lg_woba": _r(lc["lg_woba"], 3),
            }

        def _team_pitching_totals(side_team_id: int, division_level: str) -> dict:
            outs = 0
            h = bb = k = hr = hbp = er = r_allowed = bf = 0
            wins = losses = saves = 0
            for row in pit_rows:
                home_id, away_id = game_sides[row["game_id"]]
                if row["team_id"] not in (home_id, away_id):
                    continue
                if row["team_id"] != side_team_id:
                    continue
                outs += ip_to_outs(row["innings_pitched"])
                h += row["hits_allowed"] or 0
                bb += row["walks"] or 0
                k += row["strikeouts"] or 0
                hr += row["home_runs_allowed"] or 0
                hbp += row["hit_batters"] or 0
                er += row["earned_runs"] or 0
                r_allowed += row["runs_allowed"] or 0
                bf += row["batters_faced"] or 0
                d = (row["decision"] or "").upper()
                if d == "W":
                    wins += 1
                elif d == "L":
                    losses += 1
                elif d == "S":
                    saves += 1

            ip_display = outs_to_ip(outs)
            lc = _get_league_constants(cur, season, division_level or "D1")

            line = PitchingLine(
                ip=ip_display, hits=h, er=er, runs=r_allowed,
                bb=bb, k=k, hr=hr, hbp=hbp, bf=bf,
                wins=wins, losses=losses, saves=saves,
            )
            adv = compute_pitching_advanced(
                line,
                fip_constant=lc["fip_constant"],
                league_era=lc["lg_era"],
                league_fip=lc["lg_fip"],
                division_level=lc["division_level"],
            )

            def _r(v, d=2):
                return round(v, d) if v is not None else None

            return {
                "ip": ip_display, "outs": outs,
                "h": h, "r": r_allowed, "er": er,
                "bb": bb, "k": k, "hr": hr, "hbp": hbp, "bf": bf,
                "w": wins, "l": losses, "sv": saves,
                "era": _r(adv.era, 2),
                "whip": _r(adv.whip, 2),
                "k9": _r(adv.k_per_9, 2),
                "bb9": _r(adv.bb_per_9, 2),
                "h9": _r(adv.h_per_9, 2),
                "hr9": _r(adv.hr_per_9, 2),
                "k_pct": _r(adv.k_pct, 4),
                "bb_pct": _r(adv.bb_pct, 4),
                "fip": _r(adv.fip, 2),
                "xfip": _r(adv.xfip, 2),
                "k_bb": _r(adv.k_bb_ratio, 2),
                "babip": _r(adv.babip_against, 3),
                "lob_pct": _r(adv.lob_pct, 4),
                "lg_era": _r(lc["lg_era"], 2),
                "lg_fip": _r(lc["lg_fip"], 2),
            }

        team_a_division = team_rows[team_a].get("division_level")
        team_b_division = team_rows[team_b].get("division_level")

        # ── PA-level matchup history (Phase D.5 unlock) ──
        # For every PA between these two teams, group by (batter,
        # pitcher) so a coach can see "Smith faced Jones 4 times this
        # series — here's the pitch sequence and outcome of each one."
        # Skipping sub-events (steals, WPs, etc.) — just PA results.
        SUBEVENT_TYPES = (
            'stolen_base', 'caught_stealing', 'wild_pitch',
            'passed_ball', 'balk', 'pickoff', 'runner_other',
        )
        cur.execute("""
            SELECT
                ge.id, ge.game_id, g.game_date,
                ge.inning, ge.half, ge.sequence_idx,
                ge.batter_player_id, ge.batter_name, ge.batting_team_id,
                ge.pitcher_player_id, ge.pitcher_name,
                CASE WHEN ge.batting_team_id = g.home_team_id
                     THEN g.away_team_id
                     ELSE g.home_team_id END AS pitcher_team_id,
                ge.balls_before, ge.strikes_before, ge.pitch_sequence,
                ge.result_type, ge.result_text,
                ge.bat_score_before, ge.fld_score_before,
                ge.runs_on_play, ge.rbi,
                ge.wpa_batter, ge.wpa_pitcher
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE ge.game_id = ANY(%s)
              AND ge.batter_player_id IS NOT NULL
              AND ge.pitcher_player_id IS NOT NULL
              AND ge.result_type IS NOT NULL
              AND ge.result_type NOT IN %s
            ORDER BY g.game_date ASC, ge.inning ASC,
                     CASE WHEN ge.half = 'top' THEN 0 ELSE 1 END,
                     ge.sequence_idx ASC
        """, (game_ids, SUBEVENT_TYPES))
        pa_rows = cur.fetchall()

        # Group by (batter_id, pitcher_id) into matchup buckets.
        # Hit / walk / strikeout / HR counts give the summary line for
        # each matchup card. total_wpa is from the BATTER's perspective.
        HIT_TYPES = {'single', 'double', 'triple', 'home_run'}
        BB_TYPES = {'walk', 'intentional_walk'}
        K_TYPES = {'strikeout_swinging', 'strikeout_looking'}

        matchups = {}   # (bat_id, pit_id) -> matchup dict
        for r in pa_rows:
            bid = r["batter_player_id"]
            pid = r["pitcher_player_id"]
            key = (bid, pid)
            m = matchups.get(key)
            if m is None:
                m = {
                    "batter": {
                        "id": bid,
                        "name": r["batter_name"],
                        "team_id": r["batting_team_id"],
                    },
                    "pitcher": {
                        "id": pid,
                        "name": r["pitcher_name"],
                        "team_id": r["pitcher_team_id"],
                    },
                    "pa_count": 0,
                    "hits": 0, "walks": 0, "strikeouts": 0, "home_runs": 0,
                    "rbi": 0,
                    "total_wpa": 0.0,
                    "pas": [],
                }
                matchups[key] = m
            m["pa_count"] += 1
            rt = r["result_type"]
            if rt in HIT_TYPES:    m["hits"] += 1
            if rt in BB_TYPES:     m["walks"] += 1
            if rt in K_TYPES:      m["strikeouts"] += 1
            if rt == 'home_run':   m["home_runs"] += 1
            m["rbi"] += int(r["rbi"] or 0)
            if r["wpa_batter"] is not None:
                m["total_wpa"] += float(r["wpa_batter"])
            m["pas"].append({
                "game_id": r["game_id"],
                "game_date": r["game_date"].isoformat() if r["game_date"] else None,
                "inning": r["inning"],
                "half": r["half"],
                "balls_before": r["balls_before"],
                "strikes_before": r["strikes_before"],
                "pitch_sequence": r["pitch_sequence"],
                "result_type": r["result_type"],
                "result_text": r["result_text"],
                "bat_score_before": r["bat_score_before"],
                "fld_score_before": r["fld_score_before"],
                "runs_on_play": r["runs_on_play"] or 0,
                "rbi": r["rbi"] or 0,
                "wpa": float(r["wpa_batter"]) if r["wpa_batter"] is not None else None,
            })

        # Round total_wpa for cleaner JSON
        for m in matchups.values():
            m["total_wpa"] = round(m["total_wpa"], 4)

        # Split by which team is at bat. Sort each list by pa_count
        # desc so the most-faced matchups surface first.
        def _matchup_sort_key(m):
            return (-m["pa_count"], -m["pa_count"], m["batter"]["name"] or "")

        team_a_at_bat = sorted(
            [m for m in matchups.values() if m["batter"]["team_id"] == team_a],
            key=_matchup_sort_key,
        )
        team_b_at_bat = sorted(
            [m for m in matchups.values() if m["batter"]["team_id"] == team_b],
            key=_matchup_sort_key,
        )

        pa_matchups = {
            "team_a_at_bat": team_a_at_bat,
            "team_b_at_bat": team_b_at_bat,
            "total_pas": len(pa_rows),
        }

        return {
            "season": season,
            "team_a": _team_payload(team_a),
            "team_b": _team_payload(team_b),
            "games": games_out,
            "team_a_batting": _aggregate_batting(team_a),
            "team_a_pitching": _aggregate_pitching(team_a, team_a_division),
            "team_b_batting": _aggregate_batting(team_b),
            "team_b_pitching": _aggregate_pitching(team_b, team_b_division),
            "team_a_totals": {
                "batting": _team_batting_totals(team_a, team_a_division),
                "pitching": _team_pitching_totals(team_a, team_a_division),
            },
            "team_b_totals": {
                "batting": _team_batting_totals(team_b, team_b_division),
                "pitching": _team_pitching_totals(team_b, team_b_division),
            },
            "pa_matchups": pa_matchups,
        }


# ── Historic Matchup: opponent options ──────────────────────────────────
#
# Helper endpoint for the Historic page's opponent dropdown: returns the
# list of teams that team_a actually played at least one final game against
# in the given season, so the dropdown isn't a 100-team list.

@router.get("/coaching/historic-matchup/opponents")
def historic_matchup_opponents(
    team_a: int = Query(..., description="Team id whose opponents to list"),
    season: int = Query(2026, description="Season year"),
):
    """Distinct opponents team_a played at least one final game against."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT DISTINCT
                CASE
                    WHEN g.home_team_id = %s THEN g.away_team_id
                    ELSE g.home_team_id
                END AS opp_id
            FROM games g
            WHERE g.season = %s
              AND g.status = 'final'
              AND g.home_score IS NOT NULL
              AND g.away_score IS NOT NULL
              AND (g.home_team_id = %s OR g.away_team_id = %s)
        """, (team_a, season, team_a, team_a))
        opp_ids = [r["opp_id"] for r in cur.fetchall() if r["opp_id"]]

        if not opp_ids:
            return {"opponents": []}

        cur.execute("""
            SELECT t.id, t.name, t.short_name, t.logo_url,
                   c.abbreviation AS conference_abbrev,
                   d.level AS division_level
            FROM teams t
            LEFT JOIN conferences c ON t.conference_id = c.id
            LEFT JOIN divisions d ON c.division_id = d.id
            WHERE t.id = ANY(%s)
            ORDER BY COALESCE(t.short_name, t.name)
        """, (opp_ids,))
        return {
            "opponents": [
                {
                    "id": r["id"],
                    "name": r["name"],
                    "short_name": r["short_name"] or r["name"],
                    "logo_url": r["logo_url"],
                    "conference_abbrev": r["conference_abbrev"],
                    "division_level": r["division_level"],
                }
                for r in cur.fetchall()
            ]
        }
