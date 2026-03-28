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
import os

from fastapi import APIRouter, Query, HTTPException
from typing import Optional
from ..models.database import get_connection
from ..stats.advanced import (
    BattingLine, PitchingLine,
    compute_batting_advanced, compute_pitching_advanced, compute_college_war,
    normalize_position, DEFAULT_WEIGHTS,
)
from ..stats.ppi import compute_ppi_for_division

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

# SQL fragments for qualified filter — join team_season_stats to get team games
QUALIFIED_BATTING_JOIN = """
    JOIN team_season_stats tss
      ON tss.team_id = bs.team_id AND tss.season = bs.season
"""
QUALIFIED_BATTING_WHERE = (
    " AND bs.plate_appearances >= {pa_per_game} * (COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0))"
    .format(pa_per_game=QUALIFIED_PA_PER_GAME)
)
QUALIFIED_PITCHING_JOIN = """
    JOIN team_season_stats tss
      ON tss.team_id = ps.team_id AND tss.season = ps.season
"""
QUALIFIED_PITCHING_WHERE = (
    " AND ps.innings_pitched >= {ip_per_game} * (COALESCE(tss.wins,0) + COALESCE(tss.losses,0) + COALESCE(tss.ties,0))"
    .format(ip_per_game=QUALIFIED_IP_PER_GAME)
)


def _add_era_plus(row: dict) -> dict:
    """Convert era_minus to era_plus (higher=better). ERA+ = 10000/ERA-."""
    em = row.get("era_minus")
    if em and em > 0:
        row["era_plus"] = round(10000.0 / em)
    else:
        row["era_plus"] = None
    # Also handle avg_era_minus → avg_era_plus for team aggregates
    aem = row.get("avg_era_minus")
    if aem and aem > 0:
        row["avg_era_plus"] = round(10000.0 / aem)
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
        rows = cur.fetchall()

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

        # Sort each conference by conf win %, then overall win % as tiebreaker
        for conf in conferences.values():
            conf["teams"].sort(key=lambda t: (t["conf_win_pct"], t["win_pct"]), reverse=True)

        # Sort overall by win %
        all_teams.sort(key=lambda t: (t["win_pct"], t["wins"]), reverse=True)

        return {
            "conferences": list(conferences.values()),
            "overall": all_teams,
        }


@router.get("/stat-leaders")
def stat_leaders(
    season: int = Query(..., description="Season year"),
    limit: int = Query(5, description="Number of leaders per category"),
    qualified: bool = Query(False, description="Only qualified players (2 PA/game batting, 0.75 IP/game pitching)"),
):
    """
    Return top N players for key batting and pitching categories.
    Batting: wRC+, HR, SB, oWAR, AVG, ISO
    Pitching: pWAR, FIP+, SIERA, K-BB%, ERA, K
    """
    with get_connection() as conn:
        cur = conn.cursor()
        min_pa = 30
        min_ip = 10

        batting_categories = [
            {"key": "wrc_plus", "label": "wRC+", "col": "bs.wrc_plus", "order": "DESC", "format": "int"},
            {"key": "home_runs", "label": "HR", "col": "bs.home_runs", "order": "DESC", "format": "int"},
            {"key": "stolen_bases", "label": "SB", "col": "bs.stolen_bases", "order": "DESC", "format": "int"},
            {"key": "offensive_war", "label": "oWAR", "col": "bs.offensive_war", "order": "DESC", "format": "float1"},
            {"key": "batting_avg", "label": "AVG", "col": "bs.batting_avg", "order": "DESC", "format": "avg"},
            {"key": "iso", "label": "ISO", "col": "bs.iso", "order": "DESC", "format": "avg"},
        ]

        pitching_categories = [
            {"key": "pitching_war", "label": "pWAR", "col": "ps.pitching_war", "order": "DESC", "format": "float1"},
            {"key": "fip_plus", "label": "FIP+", "col": "ps.fip_plus", "order": "DESC", "format": "int"},
            {"key": "siera", "label": "SIERA", "col": "ps.siera", "order": "ASC", "format": "float2"},
            {"key": "k_minus_bb_pct", "label": "K-BB%", "col": "(ps.k_pct - ps.bb_pct)", "order": "DESC", "format": "pct"},
            {"key": "era", "label": "ERA", "col": "ps.era", "order": "ASC", "format": "float2"},
            {"key": "strikeouts", "label": "K", "col": "ps.strikeouts", "order": "DESC", "format": "int"},
        ]

        def fetch_batting_leaders(cat):
            q_join = QUALIFIED_BATTING_JOIN if qualified else ""
            q_where = QUALIFIED_BATTING_WHERE if qualified else ""
            cur.execute(f"""
                SELECT p.id as player_id, p.first_name, p.last_name, p.position,
                       t.id as team_id, t.short_name, t.logo_url,
                       d.level as division_level,
                       {cat['col']} as value
                FROM batting_stats bs
                JOIN players p ON bs.player_id = p.id
                JOIN teams t ON bs.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                {q_join}
                WHERE bs.season = %s AND bs.plate_appearances >= %s
                  AND {cat['col']} IS NOT NULL
                  {q_where}
                ORDER BY {cat['col']} {cat['order']}
                LIMIT %s
            """, (season, min_pa, limit))
            rows = cur.fetchall()
            return {
                "key": cat["key"],
                "label": cat["label"],
                "format": cat["format"],
                "leaders": [dict(r) for r in rows],
            }

        def fetch_pitching_leaders(cat):
            q_join = QUALIFIED_PITCHING_JOIN if qualified else ""
            q_where = QUALIFIED_PITCHING_WHERE if qualified else ""
            cur.execute(f"""
                SELECT p.id as player_id, p.first_name, p.last_name,
                       t.id as team_id, t.short_name, t.logo_url,
                       d.level as division_level,
                       {cat['col']} as value
                FROM pitching_stats ps
                JOIN players p ON ps.player_id = p.id
                JOIN teams t ON ps.team_id = t.id
                JOIN conferences c ON t.conference_id = c.id
                JOIN divisions d ON c.division_id = d.id
                {q_join}
                WHERE ps.season = %s AND ps.innings_pitched >= %s
                  AND {cat['col']} IS NOT NULL
                  {q_where}
                ORDER BY {cat['col']} {cat['order']}
                LIMIT %s
            """, (season, min_ip, limit))
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
                    SUM(wrc_plus * plate_appearances) / NULLIF(SUM(plate_appearances), 0) as team_wrc_plus
                FROM batting_stats WHERE season = %s
                GROUP BY team_id
            ) bat ON bat.team_id = t.id
            LEFT JOIN (
                SELECT team_id,
                    SUM(pitching_war) as total_pwar,
                    SUM(fip * innings_pitched) / NULLIF(SUM(innings_pitched), 0) as team_fip
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
                "note": "NWAC teams use PPI (internal rating) — no external national rankings available for JUCO"
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
                            THEN ROUND(SUM(hits)::numeric / SUM(at_bats), 3) ELSE 0 END as team_avg,
                       CASE WHEN SUM(plate_appearances) > 0
                            THEN ROUND((SUM(hits) + SUM(walks) + SUM(hit_by_pitch))::numeric / SUM(plate_appearances), 3) ELSE 0 END as team_obp,
                       CASE WHEN SUM(at_bats) > 0
                            THEN ROUND((SUM(hits) - SUM(doubles) - SUM(triples) - SUM(home_runs) + 2*SUM(doubles) + 3*SUM(triples) + 4*SUM(home_runs))::numeric / SUM(at_bats), 3) ELSE 0 END as team_slg,
                       ROUND(AVG(woba)::numeric, 3) as avg_woba,
                       ROUND(AVG(wrc_plus)::numeric, 0) as avg_wrc_plus,
                       ROUND(AVG(iso)::numeric, 3) as avg_iso,
                       ROUND(AVG(bb_pct)::numeric, 3) as avg_bb_pct,
                       ROUND(AVG(k_pct)::numeric, 3) as avg_k_pct,
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
                            THEN ROUND(SUM(earned_runs)::numeric * 9 / SUM(innings_pitched), 2) ELSE 0 END as team_era,
                       CASE WHEN SUM(innings_pitched) > 0
                            THEN ROUND((SUM(walks) + SUM(hits_allowed))::numeric / SUM(innings_pitched), 2) ELSE 0 END as team_whip,
                       ROUND(AVG(fip)::numeric, 2) as avg_fip,
                       ROUND(AVG(fip_plus)::numeric, 0) as avg_fip_plus,
                       ROUND(AVG(era_minus)::numeric, 0) as avg_era_minus,
                       ROUND(AVG(xfip)::numeric, 2) as avg_xfip,
                       ROUND(AVG(k_pct)::numeric, 3) as avg_k_pct,
                       ROUND(AVG(bb_pct)::numeric, 3) as avg_bb_pct,
                       ROUND(SUM(pitching_war)::numeric, 1) as total_pwar
                   FROM pitching_stats
                   WHERE team_id = %s AND season = %s AND innings_pitched >= 3""",
                (tid, season),
            )
            pitching_agg = cur.fetchone()

            row = dict(team)
            row["batting"] = dict(batting_agg) if batting_agg else {}
            row["pitching"] = _add_era_plus(dict(pitching_agg)) if pitching_agg else {}
            row["total_war"] = round(
                (batting_agg["total_owar"] or 0) + (pitching_agg["total_pwar"] or 0), 1
            ) if batting_agg and pitching_agg else 0
            results.append(row)

        return results


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
        "total_ip", "total_war",
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
                       AVG(woba) as avg_woba, AVG(wrc_plus) as avg_wrc_plus,
                       AVG(iso) as avg_iso, AVG(bb_pct) as avg_bb_pct,
                       AVG(k_pct) as avg_k_pct, SUM(offensive_war) as total_owar
                   FROM batting_stats bs
                   WHERE bs.team_id = %s AND bs.season = %s AND bs.plate_appearances >= 10""",
                (tid, season),
            )
            bat_row = cur.fetchone()

            cur.execute(
                """SELECT COUNT(*) as n,
                       SUM(innings_pitched) as ip, SUM(earned_runs) as er,
                       SUM(walks) as bb, SUM(hits_allowed) as h,
                       SUM(strikeouts) as k, SUM(home_runs_allowed) as hr,
                       AVG(fip) as avg_fip, AVG(fip_plus) as avg_fip_plus,
                       AVG(era_minus) as avg_era_minus, AVG(xfip) as avg_xfip,
                       AVG(k_pct) as avg_k_pct, AVG(bb_pct) as avg_bb_pct,
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
):
    """
    Batting stat leaders with comprehensive filtering.
    Includes both traditional and advanced stats.
    """
    allowed_sort = {
        "batting_avg", "on_base_pct", "slugging_pct", "ops", "woba", "wrc_plus",
        "home_runs", "rbi", "hits", "runs", "stolen_bases", "walks",
        "strikeouts", "doubles", "triples", "plate_appearances", "iso",
        "babip", "bb_pct", "k_pct", "offensive_war",
    }
    if sort_by not in allowed_sort:
        sort_by = "batting_avg"
    sort_direction = "DESC" if sort_dir.lower() == "desc" else "ASC"

    with get_connection() as conn:
        cur = conn.cursor()
        q_join = QUALIFIED_BATTING_JOIN if qualified else ""
        q_where = QUALIFIED_BATTING_WHERE if qualified else ""
        query = f"""
            SELECT bs.*,
                   p.first_name, p.last_name, p.position, p.year_in_school,
                   p.bats, p.throws, p.hometown, p.previous_school,
                   p.is_committed, p.committed_to,
                   t.name as team_name, t.short_name as team_short, t.logo_url,
                   t.state as team_state,
                   c.name as conference_name, c.abbreviation as conference_abbrev,
                   d.name as division_name, d.level as division_level
            FROM batting_stats bs
            JOIN players p ON bs.player_id = p.id
            JOIN teams t ON bs.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            {q_join}
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
        count_q = f"""
            SELECT COUNT(*) as total
            FROM batting_stats bs
            JOIN players p ON bs.player_id = p.id
            JOIN teams t ON bs.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            {q_join}
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
):
    """
    Pitching stat leaders with comprehensive filtering.
    Includes traditional and advanced metrics (FIP, xFIP, SIERA, WAR).
    """
    allowed_sort = {
        "era", "whip", "fip", "xfip", "siera", "kwera",
        "wins", "losses", "saves", "strikeouts", "innings_pitched",
        "k_per_9", "bb_per_9", "hr_per_9", "k_bb_ratio",
        "k_pct", "bb_pct", "k_bb_pct",
        "babip_against", "lob_pct", "pitching_war",
        "fip_plus", "era_minus", "era_plus",
        "quality_starts",
    }
    # Computed column aliases that can't use ps.{name} in ORDER BY
    computed_sort_expressions = {
        "k_bb_pct": "(COALESCE(ps.k_pct, 0) - COALESCE(ps.bb_pct, 0))",
        "era_plus": "CASE WHEN ps.era_minus > 0 THEN 10000.0 / ps.era_minus END",
        "quality_starts": "COALESCE(ps.quality_starts, 0)",
    }
    if sort_by not in allowed_sort:
        sort_by = "era"
    # For ERA/FIP/xFIP, ascending is better; for K/9, WAR, descending is better
    ascending_stats = {"era", "whip", "fip", "xfip", "siera", "kwera", "bb_per_9", "bb_pct", "hr_per_9", "losses"}
    default_dir = "ASC" if sort_by in ascending_stats else "DESC"
    sort_direction = sort_dir.upper() if sort_dir.upper() in ("ASC", "DESC") else default_dir

    with get_connection() as conn:
        cur = conn.cursor()
        q_join = QUALIFIED_PITCHING_JOIN if qualified else ""
        q_where = QUALIFIED_PITCHING_WHERE if qualified else ""
        query = f"""
            SELECT ps.*,
                   COALESCE(ps.k_pct, 0) - COALESCE(ps.bb_pct, 0) as k_bb_pct,
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
):
    """
    Combined WAR leaderboard for all players (hitters + pitchers).
    Two-way players have both components summed.
    """
    allowed_sort = {
        "total_war", "offensive_war", "pitching_war", "war_per_pa", "war_per_ip",
        "plate_appearances", "batting_avg", "woba", "wrc_plus",
        "innings_pitched", "era", "whip", "fip", "fip_plus", "era_minus", "era_plus", "k_per_9", "wins",
    }
    if sort_by not in allowed_sort:
        sort_by = "total_war"
    # For ERA/WHIP/FIP lower is better, so flip the default direction
    sort_direction = "DESC" if sort_dir.lower() == "desc" else "ASC"

    with get_connection() as conn:
        cur = conn.cursor()
        qb_join = QUALIFIED_BATTING_JOIN if qualified else ""
        qb_where = QUALIFIED_BATTING_WHERE if qualified else ""
        qp_join = QUALIFIED_PITCHING_JOIN if qualified else ""
        qp_where = QUALIFIED_PITCHING_WHERE if qualified else ""
        # Get offensive WAR for batters
        batting_query = f"""
            SELECT p.id as player_id, p.first_name, p.last_name, p.position,
                   p.year_in_school, t.id as team_id, t.name as team_name, t.short_name as team_short, t.logo_url,
                   d.name as division_name, d.level as division_level,
                   c.abbreviation as conference_abbrev,
                   bs.offensive_war, bs.plate_appearances,
                   bs.batting_avg, bs.on_base_pct, bs.slugging_pct, bs.woba, bs.wrc_plus,
                   0.0 as pitching_war, 0.0 as innings_pitched,
                   NULL as era, NULL as whip, NULL as fip, NULL as fip_plus, NULL as era_minus, NULL as k_per_9,
                   NULL as wins, NULL as losses, 0 as strikeouts_p, 0 as walks_p
            FROM batting_stats bs
            JOIN players p ON bs.player_id = p.id
            JOIN teams t ON bs.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            {qb_join}
            WHERE bs.season = %s AND bs.plate_appearances >= %s
            {qb_where}
        """
        params_b: list = [season, min_pa]
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

        # Get pitching WAR
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
                   ps.wins, ps.losses, ps.strikeouts as strikeouts_p, ps.walks as walks_p
            FROM pitching_stats ps
            JOIN players p ON ps.player_id = p.id
            JOIN teams t ON ps.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            {qp_join}
            WHERE ps.season = %s AND ps.innings_pitched >= %s
            {qp_where}
        """
        params_p: list = [season, min_ip]
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
        combined_query = f"""
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
                        ELSE NULL END as war_per_ip
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
        search = f"%{q}%"

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
        search = f"%{q}%"
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


def _compute_percentiles(conn, division_level: str, season: int, player_stats: dict, stat_type: str):
    """
    Compute Baseball Savant-style percentiles for a player within their division.
    Only qualified players (50+ PA for batters, 10+ IP for pitchers) form the distribution.
    Returns dict of { stat_key: { value, percentile } }.
    """
    if stat_type == "batting":
        metrics = {
            "woba":          {"col": "bs.woba",          "higher_better": True},
            "wrc_plus":      {"col": "bs.wrc_plus",      "higher_better": True},
            "iso":           {"col": "bs.iso",           "higher_better": True},
            "bb_pct":        {"col": "bs.bb_pct",        "higher_better": True},
            "k_pct":         {"col": "bs.k_pct",         "higher_better": False},
            "offensive_war":  {"col": "bs.offensive_war", "higher_better": True},
            "stolen_bases":  {"col": "bs.stolen_bases",  "higher_better": True},
        }
        base_query = """
            SELECT {col} as val
            FROM batting_stats bs
            JOIN players p ON bs.player_id = p.id
            JOIN teams t ON bs.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE d.level = %s AND bs.season = %s
              AND bs.plate_appearances >= 50
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
            "pitching_war":  {"col": "ps.pitching_war",  "higher_better": True},
            "k_bb_pct":      {"col": "COALESCE(ps.k_pct, 0) - COALESCE(ps.bb_pct, 0)", "higher_better": True},
        }
        base_query = """
            SELECT {col} as val
            FROM pitching_stats ps
            JOIN players p ON ps.player_id = p.id
            JOIN teams t ON ps.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE d.level = %s AND ps.season = %s
              AND ps.innings_pitched >= 10
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
    totals["offensive_war"] = sum(s.get("offensive_war", 0) or 0 for s in seasons)

    # wOBA / wRC+ are complex league-adjusted — use PA-weighted average as approximation
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

    # FIP+ / ERA+ — IP-weighted
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
            "stolen_bases":  {"higher_better": True},
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
               HAVING num_seasons >= 2 AND pa >= 100""",
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
                "stolen_bases": sb,
            })

    else:
        metrics = {
            "k_pct":         {"higher_better": True},
            "bb_pct":        {"higher_better": False},
            "fip":           {"higher_better": False},
            "xfip":          {"higher_better": False},
            "siera":         {"higher_better": False},
            "lob_pct":       {"higher_better": True},
            "pitching_war":  {"higher_better": True},
            "k_bb_pct":      {"higher_better": True},
        }
        cur.execute(
            """SELECT ps.player_id,
                      SUM(ps.innings_pitched) as ip, SUM(ps.earned_runs) as er,
                      SUM(ps.walks) as bb, SUM(ps.hits_allowed) as h,
                      SUM(ps.strikeouts) as k, SUM(ps.batters_faced) as bf,
                      SUM(ps.pitching_war) as pitching_war,
                      COUNT(DISTINCT ps.season) as num_seasons
               FROM pitching_stats ps
               JOIN teams t ON ps.team_id = t.id
               JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id
               WHERE d.level = %s
               GROUP BY ps.player_id
               HAVING num_seasons >= 2 AND ip >= 20""",
            (division_level,),
        )
        all_players = cur.fetchall()

        league_stats = []
        for p in all_players:
            pd = dict(p)
            ip, bb, k, bf = pd["ip"], pd["bb"], pd["k"], pd["bf"]
            k_pct = k / bf if bf > 0 else None
            bb_pct = bb / bf if bf > 0 else None
            league_stats.append({
                "k_pct": k_pct,
                "bb_pct": bb_pct,
                "fip": None,  # Complex to recompute from aggregates
                "xfip": None,
                "siera": None,
                "lob_pct": None,
                "pitching_war": pd["pitching_war"],
                "k_bb_pct": (k_pct or 0) - (bb_pct or 0),
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
            # Redirect to the canonical player page
            from fastapi.responses import RedirectResponse
            return RedirectResponse(
                url=f"/api/players/{canonical_link['canonical_id']}"
                + (f"?percentile_season={percentile_season}" if percentile_season else ""),
                status_code=307,
            )

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
                    linked_players.append(dict(lp))

        # Get all batting seasons (across all linked IDs)
        cur.execute(
            f"""SELECT bs.*, t.short_name as team_short, t.logo_url,
                      d.level as division_level, c.abbreviation as conference_abbrev
               FROM batting_stats bs
               JOIN teams t ON bs.team_id = t.id
               JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id
               WHERE bs.player_id IN ({id_placeholders}) ORDER BY bs.season""",
            all_player_ids,
        )
        batting = cur.fetchall()

        # Get all pitching seasons (across all linked IDs)
        cur.execute(
            f"""SELECT ps.*,
                      COALESCE(ps.k_pct, 0) - COALESCE(ps.bb_pct, 0) as k_bb_pct,
                      t.short_name as team_short, t.logo_url,
                      d.level as division_level, c.abbreviation as conference_abbrev
               FROM pitching_stats ps
               JOIN teams t ON ps.team_id = t.id
               JOIN conferences c ON t.conference_id = c.id
               JOIN divisions d ON c.division_id = d.id
               WHERE ps.player_id IN ({id_placeholders}) ORDER BY ps.season""",
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

            if batting_list:
                # Find matching season or default to most recent
                bat_row = None
                if target_season:
                    bat_row = next((r for r in batting_list if r["season"] == target_season), None)
                if not bat_row:
                    bat_row = batting_list[-1]
                percentile_label = str(bat_row["season"])
                batting_percentiles = _compute_percentiles(
                    conn, player_dict["division_level"], bat_row["season"],
                    bat_row, "batting"
                )

            if pitching_list:
                pit_row = None
                if target_season:
                    pit_row = next((r for r in pitching_list if r["season"] == target_season), None)
                if not pit_row:
                    pit_row = pitching_list[-1]
                if not percentile_label:
                    percentile_label = str(pit_row["season"])
                pitching_percentiles = _compute_percentiles(
                    conn, player_dict["division_level"], pit_row["season"],
                    pit_row, "pitching"
                )

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
            "linked_players": linked_players,
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
    limit: int = Query(500),
):
    """
    Find uncommitted JUCO players — the primary recruiting tool.
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
                   ps2.innings_pitched, ps2.pitching_war,
                   COALESCE(bs.offensive_war, 0) + COALESCE(ps2.pitching_war, 0) as total_war
            FROM players p
            JOIN teams t ON p.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN batting_stats bs ON p.id = bs.player_id AND bs.season = %s
            LEFT JOIN pitching_stats ps2 ON p.id = ps2.player_id AND ps2.season = %s
            WHERE d.level = 'JUCO'
              AND p.is_committed = 0
              AND (bs.player_id IS NOT NULL OR ps2.player_id IS NOT NULL)
        """
        params: list = [season, season]

        if year_in_school:
            query = _apply_year_filter(query, params, year_in_school)
        if position:
            query += " AND p.position ILIKE %s"
            params.append(f"%{position}%")
        if min_ab > 0:
            query += " AND COALESCE(bs.at_bats, 0) >= %s"
            params.append(min_ab)
        if min_ip > 0:
            query += " AND COALESCE(ps2.innings_pitched, 0) >= %s"
            params.append(min_ip)

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
            "batting": [dict(r) for r in batting],
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
def recalculate_war(season: int = Query(..., description="Season to recalculate")):
    """
    Recalculate offensive WAR for all batters in a given season using
    the current formula (with positional adjustments and replacement level).

    Also recalculates pitching WAR from the stored counting stats.

    This lets us tweak the WAR formula and re-run it without re-scraping.
    """
    with get_connection() as conn:
        cur = conn.cursor()
        # ── Recalculate batting WAR ──
        cur.execute(
            """SELECT bs.id, bs.player_id, bs.plate_appearances, bs.at_bats,
                      bs.hits, bs.doubles, bs.triples, bs.home_runs, bs.walks,
                      bs.intentional_walks, bs.hit_by_pitch, bs.sacrifice_flies,
                      bs.sacrifice_bunts, bs.strikeouts, bs.stolen_bases,
                      bs.caught_stealing, bs.grounded_into_dp, bs.wraa,
                      p.position
               FROM batting_stats bs
               JOIN players p ON bs.player_id = p.id
               WHERE bs.season = %s""",
            (season,),
        )
        batters = cur.fetchall()

        batting_updated = 0
        for b in batters:
            pos = normalize_position(b["position"]) or "UT"
            pa = b["plate_appearances"] or 0

            # Use stored wRAA to avoid recomputing everything
            # We rebuild a minimal BattingAdvanced just for the WAR calc
            class _MinBatting:
                wraa = b["wraa"] or 0.0
                off_war = 0.0  # will be overwritten

            war = compute_college_war(
                batting=_MinBatting(),
                position=pos,
                plate_appearances=pa,
                division_level="JUCO",
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
                      ps.games, ps.games_started, ps.runs_allowed
               FROM pitching_stats ps
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
            adv = compute_pitching_advanced(line, division_level="JUCO")

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
        conn.row_factory = lambda c, r: dict(zip([col[0] for col in c.description], r))

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

    # Sort by elevation (highest first) as a default interesting sort
    result.sort(key=lambda x: x.get("elevation_ft", 0), reverse=True)

    return {
        "teams": result,
        "qualification_notes": park_data.get("qualification_notes", {}),
        "total": len(result),
    }


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
                          SUM(CASE WHEN plate_appearances >= 50 THEN wrc_plus * plate_appearances ELSE 0 END) as weighted_wrc,
                          SUM(CASE WHEN plate_appearances >= 50 THEN plate_appearances ELSE 0 END) as qualified_pa
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
                          SUM(CASE WHEN innings_pitched >= 10 THEN fip * innings_pitched ELSE 0 END) as weighted_fip,
                          SUM(CASE WHEN innings_pitched >= 10 THEN innings_pitched ELSE 0 END) as qualified_ip
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
    Quality starts leaderboard — pitchers ranked by QS count.
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
