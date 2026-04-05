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
import re

from fastapi import APIRouter, Query, HTTPException
from fastapi.responses import JSONResponse
from typing import Optional
from ..models.database import get_connection
from ..stats.advanced import (
    BattingLine, PitchingLine,
    compute_batting_advanced, compute_pitching_advanced, compute_college_war,
    normalize_position, DEFAULT_WEIGHTS,
    POSITION_ADJUSTMENTS_FULL,
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

        # Random player — pick someone with real stats so the card is interesting
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
        cur.execute("""
            SELECT t.id, t.short_name, t.logo_url, t.city, t.state,
                   c.id as conference_id, c.name as conference_name, c.abbreviation as conference_abbrev,
                   d.id as division_id, d.name as division_name, d.level as division_level,
                   COALESCE(s.wins, 0) as wins, COALESCE(s.losses, 0) as losses,
                   COALESCE(s.conference_wins, 0) as conf_wins,
                   COALESCE(s.conference_losses, 0) as conf_losses,
                   cr.composite_rank as national_rank
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
            LEFT JOIN composite_rankings cr ON cr.team_id = t.id AND cr.season = %s
            WHERE t.is_active = 1
            ORDER BY d.id, c.name, t.short_name
        """, (season, season))
        rows = cur.fetchall()

        # Fetch PPI ranks for JUCO teams (no national rankings exist for them)
        cur.execute("""
            SELECT t.id,
                   COALESCE(bat.total_owar, 0) as team_owar,
                   COALESCE(pit.total_pwar, 0) as team_pwar,
                   COALESCE(bat.total_owar, 0) + COALESCE(pit.total_pwar, 0) as team_war,
                   COALESCE(bat.team_wrc_plus, 100) as team_wrc_plus,
                   COALESCE(pit.team_fip, 4.5) as team_fip,
                   COALESCE(s.wins, 0) as wins, COALESCE(s.losses, 0) as losses,
                   COALESCE(s.conference_wins, 0) as conf_wins,
                   COALESCE(s.conference_losses, 0) as conf_losses
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN team_season_stats s ON s.team_id = t.id AND s.season = %s
            LEFT JOIN (
                SELECT team_id,
                    SUM(offensive_war) as total_owar,
                    SUM(wrc_plus * plate_appearances) / NULLIF(SUM(plate_appearances), 0) as team_wrc_plus
                FROM batting_stats WHERE season = %s GROUP BY team_id
            ) bat ON bat.team_id = t.id
            LEFT JOIN (
                SELECT team_id,
                    SUM(pitching_war) as total_pwar,
                    SUM(fip * innings_pitched) / NULLIF(SUM(innings_pitched), 0) as team_fip
                FROM pitching_stats WHERE season = %s GROUP BY team_id
            ) pit ON pit.team_id = t.id
            WHERE t.is_active = 1 AND d.level = 'JUCO'
        """, (season, season, season))
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

            # Pitching splits — same logic: use player's team from players table
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
                {"key": "wins", "label": "W", "col": "agg.w", "order": "DESC", "format": "int"},
                {"key": "saves", "label": "SV", "col": "agg.sv", "order": "DESC", "format": "int"},
            ]

            def fetch_pitching_split_leaders(cat):
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
                    WHERE agg.real_ip >= %s
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
            {"key": "stolen_bases", "label": "SB", "col": "bs.stolen_bases", "order": "DESC", "format": "int"},
            {"key": "batting_avg", "label": "AVG", "col": "bs.batting_avg", "order": "DESC", "format": "avg"},
            {"key": "iso", "label": "ISO", "col": "bs.iso", "order": "DESC", "format": "avg"},
        ]

        pitching_categories = [
            {"key": "pitching_war", "label": "pWAR", "col": "ps.pitching_war", "order": "DESC", "format": "float1"},
            {"key": "fip_plus", "label": "FIP+", "col": "ps.fip_plus", "order": "DESC", "format": "int"},
            {"key": "quality_starts", "label": "QS", "col": "COALESCE(ps.quality_starts, 0)", "order": "DESC", "format": "int"},
            {"key": "strikeouts", "label": "K", "col": "ps.strikeouts", "order": "DESC", "format": "int"},
            {"key": "k_minus_bb_pct", "label": "K-BB%", "col": "(ps.k_pct - ps.bb_pct)", "order": "DESC", "format": "pct"},
            {"key": "era", "label": "ERA", "col": "ps.era", "order": "ASC", "format": "float2"},
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
            q_join = QUALIFIED_PITCHING_JOIN if qualified else ""
            q_where = QUALIFIED_PITCHING_WHERE if qualified else ""
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
                WHERE ps.season = %s AND ps.innings_pitched >= %s
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
                            THEN ROUND((SUM(hits)::numeric / SUM(at_bats))::numeric, 3) ELSE 0 END as team_avg,
                       CASE WHEN SUM(plate_appearances) > 0
                            THEN ROUND(((SUM(hits) + SUM(walks) + SUM(hit_by_pitch))::numeric / SUM(plate_appearances))::numeric, 3) ELSE 0 END as team_obp,
                       CASE WHEN SUM(at_bats) > 0
                            THEN ROUND(((SUM(hits) - SUM(doubles) - SUM(triples) - SUM(home_runs) + 2*SUM(doubles) + 3*SUM(triples) + 4*SUM(home_runs))::numeric / SUM(at_bats))::numeric, 3) ELSE 0 END as team_slg,
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
                            THEN ROUND((SUM(earned_runs) * 9.0 / SUM(innings_pitched))::numeric, 2) ELSE 0 END as team_era,
                       CASE WHEN SUM(innings_pitched) > 0
                            THEN ROUND(((SUM(walks) + SUM(hits_allowed)) / SUM(innings_pitched))::numeric, 2) ELSE 0 END as team_whip,
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
        qb_where = QUALIFIED_BATTING_WHERE if qualified else ""
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
                       AVG(woba) as avg_woba, AVG(wrc_plus) as avg_wrc_plus,
                       AVG(iso) as avg_iso, AVG(bb_pct) as avg_bb_pct,
                       AVG(k_pct) as avg_k_pct, SUM(offensive_war) as total_owar
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
                       AVG(fip) as avg_fip, AVG(fip_plus) as avg_fip_plus,
                       AVG(era_minus) as avg_era_minus, AVG(xfip) as avg_xfip,
                       AVG(k_pct) as avg_k_pct, AVG(bb_pct) as avg_bb_pct,
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
    Player must have 10+ PA (batters) or 5+ IP (pitchers) to get percentiles.
    Comparison pool: 10+ PA for batters, 5+ IP for pitchers.
    Returns dict of { stat_key: { value, percentile } }.
    """
    # Check player qualification thresholds
    if stat_type == "batting" and (player_stats.get("plate_appearances") or 0) < 10:
        return {}
    if stat_type == "pitching" and (player_stats.get("innings_pitched") or 0) < 5:
        return {}

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
              AND ps.innings_pitched >= 5
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
            query += " AND p.position ILIKE %s"
            params.append(f"%{position}%")
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
def recalculate_war(season: int = Query(..., description="Season to recalculate")):
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
def unmatched_game_batting(limit: int = Query(50)):
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
def debug_player_games(player_id: int):
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
def team_game_coverage(team_id: int):
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

        conditions = ["g.game_date = %s"]
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
            ORDER BY
                CASE g.status
                    WHEN 'live' THEN 0
                    WHEN 'final' THEN 1
                    ELSE 2
                END,
                g.game_time ASC NULLS LAST,
                g.id
        """, params)

        games = [dict(g) for g in cur.fetchall()]
        return {"games": games, "date": date, "count": len(games)}


@router.get("/games/live")
def games_live():
    """
    Get live scores, today's games, recent results, and upcoming games.
    Reads from the live_scores.json file generated by scrape_live_scores.py.
    """
    import json as _json
    from pathlib import Path as _Path

    live_scores_path = _Path(__file__).parent.parent.parent / "data" / "live_scores.json"

    if not live_scores_path.exists():
        return {
            "today": [],
            "recent": [],
            "upcoming": [],
            "last_updated": None,
            "date": None,
        }

    try:
        with open(live_scores_path) as f:
            data = _json.load(f)
        return data
    except (ValueError, OSError):
        return {
            "today": [],
            "recent": [],
            "upcoming": [],
            "last_updated": None,
            "date": None,
        }


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

            # Determine if player's team is home or away.
            # Priority: check player's known team IDs against game record,
            # then fall back to gb/gp.team_id comparison.
            if home_tid in player_team_ids:
                is_home = True
            elif away_tid in player_team_ids:
                is_home = False
            else:
                # Neither side matches player's team IDs (e.g. opponent
                # not in DB so away_team_id is NULL). Fall back to
                # gb.team_id matching.
                row_team_id = r["team_id"]
                is_home = (row_team_id == home_tid)

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
# ============================================================
# IMAGE PROXY — for canvas export (avoids CORS issues)
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


# PNW GRID — Immaculate Grid for PNW College Baseball
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
    # Individual teams — D1
    {"type": "team", "label": "Gonzaga (D1)", "value": "Gonzaga", "group": "team"},
    {"type": "team", "label": "Oregon (D1)", "value": "Oregon", "group": "team"},
    {"type": "team", "label": "Oregon St. (D1)", "value": "Oregon St.", "group": "team"},
    {"type": "team", "label": "UW (D1)", "value": "UW", "group": "team"},
    {"type": "team", "label": "Wash. St. (D1)", "value": "Wash. St.", "group": "team"},
    {"type": "team", "label": "Portland (D1)", "value": "Portland", "group": "team"},
    {"type": "team", "label": "Seattle U (D1)", "value": "Seattle U", "group": "team"},
    # Individual teams — D2
    {"type": "team", "label": "CWU (D2)", "value": "CWU", "group": "team"},
    {"type": "team", "label": "WOU (D2)", "value": "WOU", "group": "team"},
    {"type": "team", "label": "NNU (D2)", "value": "NNU", "group": "team"},
    {"type": "team", "label": "MSUB (D2)", "value": "MSUB", "group": "team"},
    {"type": "team", "label": "SMU (D2)", "value": "SMU", "group": "team"},
    # Individual teams — D3
    {"type": "team", "label": "Linfield (D3)", "value": "Linfield", "group": "team"},
    {"type": "team", "label": "GFU (D3)", "value": "GFU", "group": "team"},
    {"type": "team", "label": "PLU (D3)", "value": "PLU", "group": "team"},
    {"type": "team", "label": "UPS (D3)", "value": "UPS", "group": "team"},
    {"type": "team", "label": "L&C (D3)", "value": "L&C", "group": "team"},
    {"type": "team", "label": "Whitworth (D3)", "value": "Whitworth", "group": "team"},
    {"type": "team", "label": "Whitman (D3)", "value": "Whitman", "group": "team"},
    {"type": "team", "label": "Willamette (D3)", "value": "Willamette", "group": "team"},
    {"type": "team", "label": "Pacific (D3)", "value": "Pacific", "group": "team"},
    # Individual teams — NAIA
    {"type": "team", "label": "Bushnell (NAIA)", "value": "Bushnell", "group": "team"},
    {"type": "team", "label": "Corban (NAIA)", "value": "Corban", "group": "team"},
    {"type": "team", "label": "C of I (NAIA)", "value": "C of I", "group": "team"},
    {"type": "team", "label": "EOU (NAIA)", "value": "EOU", "group": "team"},
    {"type": "team", "label": "LCSC (NAIA)", "value": "LCSC", "group": "team"},
    {"type": "team", "label": "OIT (NAIA)", "value": "OIT", "group": "team"},
    {"type": "team", "label": "Warner Pacific (NAIA)", "value": "Warner Pacific", "group": "team"},
    {"type": "team", "label": "UBC (NAIA)", "value": "UBC", "group": "team"},
    # Individual teams — NWAC
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
    {"type": "team", "label": "GRC (NWAC)", "value": "GRC", "group": "team"},
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
    Returns the count (capped at 4 for efficiency — we only need to know if >= 3).
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
            # Career rate stat — check any single qualified season
            sql = f"""
                SELECT COUNT(DISTINCT {stat_alias}.player_id) FROM {stat_table} {stat_alias}
                JOIN players p ON {stat_alias}.player_id = p.id
                {team_join}
                WHERE {stat_alias}.{sc_stat} {sc_op} %s {team_where}{q_clause}
            """
            params = [sc_threshold] + team_params + q_params
        else:
            # Career counting stat — SUM across seasons
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
        # Season stat — direct comparison
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
        # RealDictCursor returns dicts — get the first value
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

    # Fallback after 20 failed attempts — return last generated grid anyway
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
        search = f"%{q}%"

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
        # Any PNW school — always true if the player exists
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
    """Check any criteria type — team/conference/division or stat."""
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
                    # Both are teams (transfer cell) or both stats — skip
                    cells[f"{ri}-{ci}"] = []
                    continue

                players = _find_players_for_cell(cur, team_crit, stat_crit)
                cells[f"{ri}-{ci}"] = players

        return {"cells": cells}


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
    """Summer league batting leaderboard — WCL, PIL, or all."""
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
    """Summer league pitching leaderboard — WCL, PIL, or all."""
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
            {"key": "home_runs", "label": "HR", "col": "sbs.home_runs", "order": "DESC", "format": "int", "min_pa": 30},
            {"key": "batting_avg", "label": "AVG", "col": "sbs.batting_avg", "order": "DESC", "format": "avg", "min_pa": 50},
        ]
        pitching_cats = [
            {"key": "era", "label": "ERA", "col": "sps.era", "order": "ASC", "format": "float2", "min_ip": 20},
            {"key": "strikeouts", "label": "K", "col": "sps.strikeouts", "order": "DESC", "format": "int", "min_ip": 10},
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

            # Class breakdown — map redshirt classes to their base class
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

                # Skip if no prior season data — can't determine returners vs new
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
                                except:
                                    pass
                        if w:
                            try:
                                weights.append(int(str(w).replace('lbs', '').strip()))
                            except:
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

        # 2) Freshman PA% — Fr + R-Fr plate appearances as % of team total
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

        # 3) Freshman IP% — Fr + R-Fr innings as % of team total
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
