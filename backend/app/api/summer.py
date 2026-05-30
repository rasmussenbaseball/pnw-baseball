"""
Summer-league API endpoints (WCL today, more leagues later).

The summer schema lives in its own namespace (summer_games, summer_teams,
summer_batting_stats, etc.) so a WCL home run never accidentally rolls
up into a college season-stats query. This module exposes:

  GET /summer/leagues                  list of summer leagues we cover
  GET /summer/scoreboard               recent + upcoming games strip
  GET /summer/standings                W/L by team for the season
  GET /summer/games                    paginated games list
  GET /summer/games/{game_id}          single game with box score
  GET /summer/teams                    team directory for a league
  GET /summer/teams/{team_id}          team detail (roster + recent games)
  GET /summer/leaderboards/batting     season batting leaders
  GET /summer/leaderboards/pitching    season pitching leaders
"""

from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from ..cache import cached_endpoint
from ..models.database import get_connection


router = APIRouter()

# Default league for endpoints that don't take an explicit league filter.
# WCL is the only one with a frontend right now; the others (PIL, etc.)
# are already scraped but not yet surfaced in the UI.
DEFAULT_LEAGUE = "WCL"


def _league_id_for(cur, league_abbr: str) -> int:
    cur.execute(
        "SELECT id FROM summer_leagues WHERE abbreviation = %s",
        (league_abbr,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"Unknown summer league: {league_abbr}")
    return row["id"]


# ── /summer/leagues ────────────────────────────────────────────────

@router.get("/summer/leagues")
@cached_endpoint(ttl_seconds=3600)
def summer_leagues():
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, name, abbreviation, website_url, logo_url, is_active
            FROM summer_leagues
            WHERE is_active = TRUE
            ORDER BY abbreviation
            """
        )
        rows = cur.fetchall()
    return [dict(r) for r in rows]


# ── /summer/scoreboard ─────────────────────────────────────────────

@router.get("/summer/scoreboard")
@cached_endpoint(ttl_seconds=120)
def summer_scoreboard(
    league: str = Query(DEFAULT_LEAGUE),
    season: int = Query(2026),
    days_back: int = Query(3, ge=0, le=14),
    days_ahead: int = Query(3, ge=0, le=14),
):
    """Recent + upcoming games. Default window is yesterday + today + tomorrow."""
    with get_connection() as conn:
        cur = conn.cursor()
        league_id = _league_id_for(cur, league)
        today = date.today()
        cur.execute(
            """
            SELECT
                g.id,
                g.game_date,
                g.status,
                g.away_team_id,
                g.home_team_id,
                g.away_team_name,
                g.home_team_name,
                g.away_score,
                g.home_score,
                g.innings,
                g.source_url,
                ta.short_name AS away_short,
                ta.logo_url   AS away_logo,
                th.short_name AS home_short,
                th.logo_url   AS home_logo
            FROM summer_games g
            LEFT JOIN summer_teams ta ON ta.id = g.away_team_id
            LEFT JOIN summer_teams th ON th.id = g.home_team_id
            WHERE g.league_id = %s AND g.season = %s
              AND g.game_date BETWEEN %s AND %s
            ORDER BY g.game_date, g.id
            """,
            (league_id, season,
             today - timedelta(days=days_back),
             today + timedelta(days=days_ahead)),
        )
        rows = cur.fetchall()
    return [dict(r) for r in rows]


# ── /summer/games ──────────────────────────────────────────────────

@router.get("/summer/games")
@cached_endpoint(ttl_seconds=300)
def summer_games(
    league: str = Query(DEFAULT_LEAGUE),
    season: int = Query(2026),
    team_id: Optional[int] = None,
    status: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    with get_connection() as conn:
        cur = conn.cursor()
        league_id = _league_id_for(cur, league)
        where = ["g.league_id = %s", "g.season = %s"]
        params = [league_id, season]
        if team_id:
            where.append("(g.away_team_id = %s OR g.home_team_id = %s)")
            params.extend([team_id, team_id])
        if status:
            where.append("g.status = %s")
            params.append(status)
        sql = f"""
            SELECT g.id, g.game_date, g.status,
                   g.away_team_id, g.home_team_id,
                   g.away_team_name, g.home_team_name,
                   g.away_score, g.home_score, g.innings,
                   ta.short_name AS away_short, ta.logo_url AS away_logo,
                   th.short_name AS home_short, th.logo_url AS home_logo
            FROM summer_games g
            LEFT JOIN summer_teams ta ON ta.id = g.away_team_id
            LEFT JOIN summer_teams th ON th.id = g.home_team_id
            WHERE {" AND ".join(where)}
            ORDER BY g.game_date DESC, g.id DESC
            LIMIT %s OFFSET %s
        """
        cur.execute(sql, [*params, limit, offset])
        rows = cur.fetchall()
    return [dict(r) for r in rows]


# ── /summer/games/{id} ─────────────────────────────────────────────

@router.get("/summer/games/{game_id}")
@cached_endpoint(ttl_seconds=180)
def summer_game_detail(game_id: int):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT g.*,
                   ta.short_name AS away_short, ta.logo_url AS away_logo,
                   th.short_name AS home_short, th.logo_url AS home_logo
            FROM summer_games g
            LEFT JOIN summer_teams ta ON ta.id = g.away_team_id
            LEFT JOIN summer_teams th ON th.id = g.home_team_id
            WHERE g.id = %s
            """,
            (game_id,),
        )
        game = cur.fetchone()
        if not game:
            raise HTTPException(status_code=404, detail="Game not found")

        cur.execute(
            """
            SELECT *
            FROM summer_game_batting
            WHERE game_id = %s
            ORDER BY is_home, batting_order NULLS LAST, id
            """,
            (game_id,),
        )
        batting = [dict(r) for r in cur.fetchall()]

        cur.execute(
            """
            SELECT *
            FROM summer_game_pitching
            WHERE game_id = %s
            ORDER BY is_home, pitch_order NULLS LAST, id
            """,
            (game_id,),
        )
        pitching = [dict(r) for r in cur.fetchall()]

    return {
        "game": dict(game),
        "batting": batting,
        "pitching": pitching,
    }


# ── /summer/teams ──────────────────────────────────────────────────

@router.get("/summer/teams")
@cached_endpoint(ttl_seconds=600)
def summer_teams(league: str = Query(DEFAULT_LEAGUE)):
    with get_connection() as conn:
        cur = conn.cursor()
        league_id = _league_id_for(cur, league)
        cur.execute(
            """
            SELECT id, name, short_name, city, state, logo_url, division
            FROM summer_teams
            WHERE league_id = %s AND is_active = TRUE
            ORDER BY name
            """,
            (league_id,),
        )
        rows = cur.fetchall()
    return [dict(r) for r in rows]


@router.get("/summer/teams/{team_id}")
@cached_endpoint(ttl_seconds=300)
def summer_team_detail(team_id: int, season: int = Query(2026)):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT t.*, l.abbreviation AS league_abbr, l.name AS league_name
            FROM summer_teams t
            JOIN summer_leagues l ON l.id = t.league_id
            WHERE t.id = %s
            """,
            (team_id,),
        )
        team = cur.fetchone()
        if not team:
            raise HTTPException(status_code=404, detail="Team not found")

        # Team season totals (sum across roster)
        cur.execute(
            """
            SELECT
                SUM(games)::int             AS bat_games,
                SUM(plate_appearances)::int AS pa,
                SUM(at_bats)::int           AS ab,
                SUM(hits)::int              AS hits,
                SUM(doubles)::int           AS doubles,
                SUM(triples)::int           AS triples,
                SUM(home_runs)::int         AS home_runs,
                SUM(walks)::int             AS bb,
                SUM(strikeouts)::int        AS so,
                SUM(rbi)::int               AS rbi,
                SUM(stolen_bases)::int      AS sb,
                CASE WHEN SUM(at_bats) > 0
                     THEN SUM(hits)::real / SUM(at_bats) ELSE 0 END AS team_avg
            FROM summer_batting_stats
            WHERE team_id = %s AND season = %s
            """,
            (team_id, season),
        )
        team_bat = dict(cur.fetchone() or {})

        # W/L from finals
        cur.execute(
            """
            SELECT
                COALESCE(SUM(CASE
                    WHEN (home_team_id = %s AND home_score > away_score)
                      OR (away_team_id = %s AND away_score > home_score)
                    THEN 1 ELSE 0 END), 0)::int AS wins,
                COALESCE(SUM(CASE
                    WHEN (home_team_id = %s AND home_score < away_score)
                      OR (away_team_id = %s AND away_score < home_score)
                    THEN 1 ELSE 0 END), 0)::int AS losses
            FROM summer_games
            WHERE (home_team_id = %s OR away_team_id = %s)
              AND season = %s AND status = 'final'
              AND away_team_id IS NOT NULL AND home_team_id IS NOT NULL
              AND away_team_id <> home_team_id
            """,
            (team_id, team_id, team_id, team_id, team_id, team_id, season),
        )
        record = dict(cur.fetchone() or {"wins": 0, "losses": 0})

        # Last 10 games
        cur.execute(
            """
            SELECT g.id, g.game_date, g.status,
                   g.away_team_id, g.home_team_id,
                   g.away_team_name, g.home_team_name,
                   g.away_score, g.home_score
            FROM summer_games g
            WHERE (g.away_team_id = %s OR g.home_team_id = %s) AND g.season = %s
            ORDER BY g.game_date DESC
            LIMIT 12
            """,
            (team_id, team_id, season),
        )
        recent = [dict(r) for r in cur.fetchall()]

        # Roster — summer_players + season batting line if any
        cur.execute(
            """
            SELECT p.id, p.first_name, p.last_name, p.jersey_number,
                   p.position, p.bats, p.throws, p.college, p.year_in_school,
                   b.batting_avg, b.on_base_pct, b.slugging_pct, b.ops,
                   b.games AS bat_games, b.home_runs, b.rbi
            FROM summer_players p
            LEFT JOIN summer_batting_stats b
                   ON b.player_id = p.id AND b.season = %s AND b.team_id = p.team_id
            WHERE p.team_id = %s
            ORDER BY p.last_name, p.first_name
            """,
            (season, team_id),
        )
        roster = [dict(r) for r in cur.fetchall()]

    return {
        "team": dict(team),
        "record": record,
        "team_batting": team_bat,
        "recent_games": recent,
        "roster": roster,
    }


# ── /summer/players/{id} ───────────────────────────────────────────

@router.get("/summer/players/{player_id}")
@cached_endpoint(ttl_seconds=180)
def summer_player_detail(player_id: int, season: int = Query(2026)):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT p.*,
                   t.id   AS team_id,
                   t.name AS team_name,
                   t.short_name AS team_short,
                   t.logo_url AS team_logo,
                   l.abbreviation AS league_abbr,
                   l.name AS league_name
            FROM summer_players p
            JOIN summer_teams t   ON t.id = p.team_id
            JOIN summer_leagues l ON l.id = t.league_id
            WHERE p.id = %s
            """,
            (player_id,),
        )
        player = cur.fetchone()
        if not player:
            raise HTTPException(status_code=404, detail="Summer player not found")

        # Season totals
        cur.execute(
            "SELECT * FROM summer_batting_stats WHERE player_id = %s ORDER BY season",
            (player_id,),
        )
        batting = [dict(r) for r in cur.fetchall()]
        cur.execute(
            "SELECT * FROM summer_pitching_stats WHERE player_id = %s ORDER BY season",
            (player_id,),
        )
        pitching = [dict(r) for r in cur.fetchall()]

        # Per-game logs for the requested season
        cur.execute(
            """
            SELECT b.*, g.game_date, g.away_team_name, g.home_team_name,
                   g.away_score, g.home_score, g.away_team_id, g.home_team_id
            FROM summer_game_batting b
            JOIN summer_games g ON g.id = b.game_id
            WHERE b.player_id = %s AND g.season = %s
            ORDER BY g.game_date
            """,
            (player_id, season),
        )
        game_batting = [dict(r) for r in cur.fetchall()]
        cur.execute(
            """
            SELECT p.*, g.game_date, g.away_team_name, g.home_team_name,
                   g.away_score, g.home_score, g.away_team_id, g.home_team_id
            FROM summer_game_pitching p
            JOIN summer_games g ON g.id = p.game_id
            WHERE p.player_id = %s AND g.season = %s
            ORDER BY g.game_date
            """,
            (player_id, season),
        )
        game_pitching = [dict(r) for r in cur.fetchall()]

        # Spring link, if known
        cur.execute(
            """
            SELECT pl.spring_player_id, sp.first_name AS spring_first, sp.last_name AS spring_last,
                   sp.team_id AS spring_team_id, sp.position AS spring_position,
                   t.short_name AS spring_team_short, t.logo_url AS spring_team_logo
            FROM summer_player_links pl
            JOIN players sp ON sp.id = pl.spring_player_id
            LEFT JOIN teams t ON t.id = sp.team_id
            WHERE pl.summer_player_id = %s
            LIMIT 1
            """,
            (player_id,),
        )
        spring_link = cur.fetchone()

    return {
        "player": dict(player),
        "batting": batting,
        "pitching": pitching,
        "game_batting": game_batting,
        "game_pitching": game_pitching,
        "spring_link": dict(spring_link) if spring_link else None,
    }


# ── /summer/standings ──────────────────────────────────────────────

@router.get("/summer/standings")
@cached_endpoint(ttl_seconds=600)
def summer_standings(
    league: str = Query(DEFAULT_LEAGUE),
    season: int = Query(2026),
):
    """W/L computed from summer_games (status='final'). Excludes
    exhibitions when team_id is on both sides (Pickles intrasquads etc.)
    by checking for distinct team_ids."""
    with get_connection() as conn:
        cur = conn.cursor()
        league_id = _league_id_for(cur, league)
        cur.execute(
            """
            WITH finals AS (
              SELECT id, away_team_id, home_team_id, away_score, home_score
              FROM summer_games
              WHERE league_id = %s AND season = %s
                AND status = 'final'
                AND away_score IS NOT NULL AND home_score IS NOT NULL
                AND away_team_id IS NOT NULL AND home_team_id IS NOT NULL
                AND away_team_id <> home_team_id
            ),
            team_results AS (
              SELECT away_team_id AS team_id,
                     SUM(CASE WHEN away_score > home_score THEN 1 ELSE 0 END) AS wins,
                     SUM(CASE WHEN away_score < home_score THEN 1 ELSE 0 END) AS losses,
                     SUM(away_score) AS rs,
                     SUM(home_score) AS ra
              FROM finals GROUP BY away_team_id
              UNION ALL
              SELECT home_team_id AS team_id,
                     SUM(CASE WHEN home_score > away_score THEN 1 ELSE 0 END) AS wins,
                     SUM(CASE WHEN home_score < away_score THEN 1 ELSE 0 END) AS losses,
                     SUM(home_score) AS rs,
                     SUM(away_score) AS ra
              FROM finals GROUP BY home_team_id
            ),
            agg AS (
              SELECT team_id,
                     SUM(wins)::int  AS wins,
                     SUM(losses)::int AS losses,
                     SUM(rs)::int  AS runs_scored,
                     SUM(ra)::int  AS runs_against
              FROM team_results GROUP BY team_id
            )
            SELECT a.team_id, t.name, t.short_name, t.logo_url, t.city, t.state,
                   t.division,
                   a.wins, a.losses,
                   a.runs_scored, a.runs_against,
                   CASE WHEN (a.wins + a.losses) > 0
                        THEN a.wins::real / (a.wins + a.losses)
                        ELSE NULL END AS pct
            FROM agg a
            JOIN summer_teams t ON t.id = a.team_id
            WHERE t.league_id = %s
            ORDER BY t.division NULLS LAST, a.wins DESC, pct DESC NULLS LAST, t.name
            """,
            (league_id, season, league_id),
        )
        rows = cur.fetchall()
    return [dict(r) for r in rows]


# ── /summer/leaderboards/batting ───────────────────────────────────

@router.get("/summer/leaderboards/batting")
@cached_endpoint(ttl_seconds=600)
def summer_batting_leaderboard(
    league: str = Query(DEFAULT_LEAGUE),
    season: int = Query(2026),
    min_pa: int = Query(20, ge=0),
    sort_by: str = Query("ops"),
    limit: int = Query(100, ge=1, le=500),
):
    valid_sorts = {
        "ops", "batting_avg", "on_base_pct", "slugging_pct",
        "home_runs", "rbi", "hits", "stolen_bases", "walks", "runs",
    }
    if sort_by not in valid_sorts:
        sort_by = "ops"
    with get_connection() as conn:
        cur = conn.cursor()
        league_id = _league_id_for(cur, league)
        cur.execute(
            f"""
            SELECT p.id   AS player_id,
                   p.first_name, p.last_name,
                   p.position, p.college, p.year_in_school,
                   t.id   AS team_id, t.name AS team_name, t.short_name AS team_short, t.logo_url,
                   b.games, b.plate_appearances, b.at_bats, b.hits, b.doubles, b.triples,
                   b.home_runs, b.runs, b.rbi, b.walks, b.strikeouts, b.stolen_bases,
                   b.batting_avg, b.on_base_pct, b.slugging_pct, b.ops
            FROM summer_batting_stats b
            JOIN summer_players p ON p.id = b.player_id
            JOIN summer_teams t   ON t.id = b.team_id
            WHERE t.league_id = %s AND b.season = %s
              AND b.plate_appearances >= %s
            ORDER BY b.{sort_by} DESC NULLS LAST
            LIMIT %s
            """,
            (league_id, season, min_pa, limit),
        )
        rows = cur.fetchall()
    return [dict(r) for r in rows]


# ── /summer/leaderboards/pitching ──────────────────────────────────

@router.get("/summer/leaderboards/pitching")
@cached_endpoint(ttl_seconds=600)
def summer_pitching_leaderboard(
    league: str = Query(DEFAULT_LEAGUE),
    season: int = Query(2026),
    min_ip: float = Query(10.0, ge=0),
    sort_by: str = Query("era"),
    limit: int = Query(100, ge=1, le=500),
):
    valid_sorts = {
        "era", "whip", "k_per_9", "bb_per_9",
        "strikeouts", "wins", "saves", "innings_pitched",
    }
    if sort_by not in valid_sorts:
        sort_by = "era"
    asc_sorts = {"era", "whip", "bb_per_9"}
    direction = "ASC" if sort_by in asc_sorts else "DESC"
    with get_connection() as conn:
        cur = conn.cursor()
        league_id = _league_id_for(cur, league)
        cur.execute(
            f"""
            SELECT p.id   AS player_id,
                   p.first_name, p.last_name,
                   p.position, p.college, p.year_in_school,
                   t.id   AS team_id, t.name AS team_name, t.short_name AS team_short, t.logo_url,
                   pt.games, pt.games_started, pt.innings_pitched,
                   pt.wins, pt.losses, pt.saves, pt.strikeouts, pt.walks,
                   pt.earned_runs, pt.hits_allowed,
                   pt.era, pt.whip, pt.k_per_9, pt.bb_per_9
            FROM summer_pitching_stats pt
            JOIN summer_players p ON p.id = pt.player_id
            JOIN summer_teams t   ON t.id = pt.team_id
            WHERE t.league_id = %s AND pt.season = %s
              AND pt.innings_pitched >= %s
            ORDER BY pt.{sort_by} {direction} NULLS LAST
            LIMIT %s
            """,
            (league_id, season, min_ip, limit),
        )
        rows = cur.fetchall()
    return [dict(r) for r in rows]
