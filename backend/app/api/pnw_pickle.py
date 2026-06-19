"""PNW Pickle — "guess the player" game.

Returns a pool of QUALIFIED, positive-WAR player-seasons with all the
attributes the front-end needs to run a Wordle/Poeltl-style guessing game
entirely client-side. One player-season = one guessable entry.

Qualification mirrors the rest of the site (see routes.py constants):
  - Hitters:  offensive_war > 0 AND plate_appearances >= 2.0 * team_games
  - Pitchers: pitching_war  > 0 AND IP(outs) >= 0.75 * 3 * team_games

A player must also have non-null handedness (bats for hitters / throws for
pitchers), class year, and a team so every clue column has data.
"""

from typing import Optional

from fastapi import APIRouter, Query

from app.models.database import get_connection

pnw_pickle_router = APIRouter(prefix="/pnw-pickle")

# Site-standard qualification rates (match routes.py QUALIFIED_*_PER_GAME).
QUALIFIED_PA_PER_GAME = 2.0
QUALIFIED_IP_PER_GAME = 0.75

# Class year → numeric rank, so "close" clues and arrows work. Redshirt
# variants collapse onto their base year.
CLASS_RANK = {
    "Fr": 1, "R-Fr": 1,
    "So": 2, "R-So": 2,
    "Jr": 3, "R-Jr": 3,
    "Sr": 4, "R-Sr": 4,
    "5th": 5,
    "Gr": 6,
}

# Level the user selects in "single level" mode → divisions.level value.
# NWAC is the PNW junior-college conference; in the DB its level is "JUCO".
LEVEL_TO_DB = {"D1": "D1", "D2": "D2", "D3": "D3", "NAIA": "NAIA", "NWAC": "JUCO"}


def _pos_group(pos: str) -> str:
    """Collapse a messy position string to a group, for 'close' (yellow) clues."""
    if not pos:
        return ""
    p = pos.upper().replace(" ", "").split("/")[0]
    if p in ("P", "RHP", "LHP", "SP", "RP", "PITCHER"):
        return "P"
    if p == "C":
        return "C"
    if p in ("1B", "2B", "3B", "SS", "INF", "IF", "MIF", "CIF"):
        return "IF"
    if p in ("OF", "LF", "CF", "RF", "OUTFIELD"):
        return "OF"
    if p in ("DH",):
        return "DH"
    if p in ("UT", "UTL", "U"):
        return "UT"
    return p


def _level_label(db_level: str) -> str:
    """Display label: JUCO shows as NWAC everywhere on the public site."""
    return "NWAC" if db_level == "JUCO" else db_level


@pnw_pickle_router.get("/pool")
def get_pool(
    level: str = Query("all", description="all | D1 | D2 | D3 | NAIA | NWAC"),
    seasons: Optional[str] = Query(None, description="CSV of years, e.g. 2024,2025; omit for all"),
):
    """Return the full qualified player-season pool for the chosen scope."""
    level = (level or "all").upper()
    db_level = LEVEL_TO_DB.get(level) if level != "ALL" else None

    season_list = None
    if seasons:
        try:
            season_list = [int(s) for s in seasons.split(",") if s.strip()]
        except ValueError:
            season_list = None
    if not season_list:
        season_list = None  # all years

    # Shared filter fragments
    level_clause = "AND d.level = %(db_level)s" if db_level else ""
    season_clause = "AND bs.season = ANY(%(seasons)s)" if season_list else ""
    season_clause_p = "AND ps.season = ANY(%(seasons)s)" if season_list else ""
    params = {"db_level": db_level, "seasons": season_list}

    # Team games played per (season, team) from completed games.
    team_games_cte = """
        team_games AS (
            SELECT season, team_id, COUNT(*) AS g FROM (
                SELECT season, home_team_id AS team_id FROM games WHERE status = 'final'
                UNION ALL
                SELECT season, away_team_id AS team_id FROM games WHERE status = 'final'
            ) x
            GROUP BY season, team_id
        )
    """

    pool = {}  # keyed by (player_id, season, team_id)

    with get_connection() as conn:
        cur = conn.cursor()

        # ── Hitters ──
        cur.execute(
            f"""
            WITH {team_games_cte}
            SELECT
                p.id AS player_id, p.first_name, p.last_name,
                p.position, p.bats, p.throws, p.year_in_school,
                bs.season, bs.team_id,
                t.short_name AS team_short, t.name AS team_name, t.logo_url,
                c.abbreviation AS conference, d.level AS db_level,
                bs.offensive_war AS war,
                bs.plate_appearances, bs.batting_avg, bs.on_base_pct,
                bs.slugging_pct, bs.ops, bs.home_runs, bs.rbi, bs.stolen_bases
            FROM batting_stats bs
            JOIN players p ON p.id = bs.player_id
            JOIN teams t ON t.id = bs.team_id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            JOIN team_games tg ON tg.season = bs.season AND tg.team_id = bs.team_id
            WHERE bs.offensive_war > 0
              AND COALESCE(p.is_phantom, false) = false
              AND p.bats IS NOT NULL AND p.bats <> ''
              AND p.year_in_school IS NOT NULL AND p.year_in_school <> ''
              AND p.first_name IS NOT NULL AND p.last_name IS NOT NULL
              AND bs.plate_appearances >= %(pa_rate)s * tg.g
              {level_clause}
              {season_clause}
            """,
            {**params, "pa_rate": QUALIFIED_PA_PER_GAME},
        )
        for r in cur.fetchall():
            key = (r["player_id"], r["season"], r["team_id"])
            pool[key] = {
                "player_id": r["player_id"],
                "name": f"{r['first_name']} {r['last_name']}".strip(),
                "season": r["season"],
                "team": r["team_short"] or r["team_name"],
                "teamName": r["team_name"],
                "logo": r["logo_url"],
                "conference": r["conference"],
                "level": _level_label(r["db_level"]),
                "position": r["position"] or "",
                "posGroup": _pos_group(r["position"] or ""),
                "bats": r["bats"],
                "throws": r["throws"] or "",
                "classYear": r["year_in_school"],
                "classRank": CLASS_RANK.get(r["year_in_school"], 0),
                "role": "Hitter",
                "war": round(float(r["war"]), 1),
                "stats": {
                    "AVG": r["batting_avg"], "OBP": r["on_base_pct"],
                    "SLG": r["slugging_pct"], "OPS": r["ops"],
                    "HR": r["home_runs"], "RBI": r["rbi"], "SB": r["stolen_bases"],
                    "PA": r["plate_appearances"], "oWAR": round(float(r["war"]), 1),
                },
            }

        # ── Pitchers ──
        cur.execute(
            f"""
            WITH {team_games_cte}
            SELECT
                p.id AS player_id, p.first_name, p.last_name,
                p.position, p.bats, p.throws, p.year_in_school,
                ps.season, ps.team_id,
                t.short_name AS team_short, t.name AS team_name, t.logo_url,
                c.abbreviation AS conference, d.level AS db_level,
                ps.pitching_war AS war,
                ps.innings_pitched, ps.era, ps.whip, ps.strikeouts, ps.walks,
                ps.wins, ps.saves
            FROM pitching_stats ps
            JOIN players p ON p.id = ps.player_id
            JOIN teams t ON t.id = ps.team_id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            JOIN team_games tg ON tg.season = ps.season AND tg.team_id = ps.team_id
            WHERE ps.pitching_war > 0
              AND COALESCE(p.is_phantom, false) = false
              AND p.throws IS NOT NULL AND p.throws <> ''
              AND p.year_in_school IS NOT NULL AND p.year_in_school <> ''
              AND p.first_name IS NOT NULL AND p.last_name IS NOT NULL
              AND (FLOOR(ps.innings_pitched) * 3
                   + ROUND((ps.innings_pitched - FLOOR(ps.innings_pitched)) * 10))
                  >= %(ip_rate)s * 3 * tg.g
              {level_clause}
              {season_clause_p}
            """,
            {**params, "ip_rate": QUALIFIED_IP_PER_GAME},
        )
        for r in cur.fetchall():
            key = (r["player_id"], r["season"], r["team_id"])
            pwar = round(float(r["war"]), 1)
            pstats = {
                "ERA": r["era"], "WHIP": r["whip"], "SO": r["strikeouts"],
                "BB": r["walks"], "IP": r["innings_pitched"], "W": r["wins"],
                "SV": r["saves"], "pWAR": pwar,
            }
            if key in pool:
                # Two-way player-season: merge, keep the larger WAR for the clue.
                e = pool[key]
                e["role"] = "Two-Way"
                e["stats"].update(pstats)
                if pwar > e["war"]:
                    e["war"] = pwar
            else:
                pool[key] = {
                    "player_id": r["player_id"],
                    "name": f"{r['first_name']} {r['last_name']}".strip(),
                    "season": r["season"],
                    "team": r["team_short"] or r["team_name"],
                    "teamName": r["team_name"],
                    "logo": r["logo_url"],
                    "conference": r["conference"],
                    "level": _level_label(r["db_level"]),
                    "position": r["position"] or "",
                    "posGroup": _pos_group(r["position"] or ""),
                    "bats": r["bats"] or "",
                    "throws": r["throws"],
                    "classYear": r["year_in_school"],
                    "classRank": CLASS_RANK.get(r["year_in_school"], 0),
                    "role": "Pitcher",
                    "war": pwar,
                    "stats": pstats,
                }

    players = list(pool.values())
    players.sort(key=lambda e: (e["name"], e["season"]))
    return {"count": len(players), "level": level, "players": players}
