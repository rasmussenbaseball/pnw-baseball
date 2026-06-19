"""PNW Pickle — "guess the player" game.

Returns two lists for the chosen scope (level + seasons):
  - answers: QUALIFIED, positive-WAR player-seasons (difficulty-filtered) — the
    hidden player is drawn from here, so it's a name people remember.
  - guesses: EVERY player-season in the scope (any WAR, any playing time) — so
    the search box lets you guess any player from that level/year, not just the
    possible answers.

Both carry the same clue attributes; one player-season = one entry. A player
still needs handedness, class year, and a team so the clue columns have data.
"""

import math
import time
from typing import Optional

from fastapi import APIRouter, Query

from app.models.database import get_connection

pnw_pickle_router = APIRouter(prefix="/pnw-pickle")

QUALIFIED_PA_PER_GAME = 2.0
QUALIFIED_IP_PER_GAME = 0.75
FLAT_MIN_PA = 80   # fallback when a season predates game-results data
FLAT_MIN_IP = 30

DIFFICULTY = {
    "easy":   {"hit": 2.0, "pit": 1.3},
    "medium": {"hit": 0.8, "pit": 0.5},
    "hard":   {"hit": 0.1, "pit": 0.1},
}
DEFAULT_DIFFICULTY = "medium"

CLASS_RANK = {
    "Fr": 1, "R-Fr": 1, "So": 2, "R-So": 2, "Jr": 3, "R-Jr": 3,
    "Sr": 4, "R-Sr": 4, "5th": 5, "Gr": 6,
}
LEVEL_TO_DB = {"D1": "D1", "D2": "D2", "D3": "D3", "NAIA": "NAIA", "NWAC": "JUCO"}

_CACHE = {}
_TTL = 1800


def _pos_group(pos: str) -> str:
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
    return "NWAC" if db_level == "JUCO" else db_level


def _ip_outs(ip):
    if ip is None:
        return 0
    whole = math.floor(ip)
    return whole * 3 + round((ip - whole) * 10)


@pnw_pickle_router.get("/pool")
def get_pool(
    level: str = Query("all", description="all | D1 | D2 | D3 | NAIA | NWAC"),
    seasons: Optional[str] = Query(None, description="CSV of years; omit for all"),
    difficulty: str = Query(DEFAULT_DIFFICULTY, description="easy | medium | hard"),
):
    level = (level or "all").upper()
    difficulty = (difficulty or DEFAULT_DIFFICULTY).lower()
    season_list = None
    if seasons:
        try:
            season_list = sorted({int(s) for s in seasons.split(",") if s.strip()})
        except ValueError:
            season_list = None

    ck = (level, tuple(season_list) if season_list else None, difficulty)
    cached = _CACHE.get(ck)
    if cached and (time.time() - cached[0]) < _TTL:
        return cached[1]

    db_level = LEVEL_TO_DB.get(level) if level != "ALL" else None
    war_min = DIFFICULTY.get(difficulty, DIFFICULTY[DEFAULT_DIFFICULTY])
    level_clause = "AND d.level = %(db_level)s" if db_level else ""
    season_clause = "AND bs.season = ANY(%(seasons)s)" if season_list else ""
    season_clause_p = "AND ps.season = ANY(%(seasons)s)" if season_list else ""
    params = {"db_level": db_level, "seasons": season_list}

    team_games_cte = """
        team_games AS (
            SELECT season, team_id, COUNT(*) AS g FROM (
                SELECT season, home_team_id AS team_id FROM games WHERE status = 'final'
                UNION ALL
                SELECT season, away_team_id AS team_id FROM games WHERE status = 'final'
            ) x GROUP BY season, team_id
        )
    """

    entries = {}  # (player_id, season, team_id) -> entry (with internal flags)

    with get_connection() as conn:
        cur = conn.cursor()

        # ── Hitters: every in-scope batter-season (no WAR / no qualification) ──
        cur.execute(
            f"""
            WITH {team_games_cte}
            SELECT p.id AS player_id, p.first_name, p.last_name,
                   p.position, p.bats, p.throws,
                   COALESCE(NULLIF(psn.year_in_school, ''), NULLIF(p.year_in_school, '')) AS year_in_school,
                   bs.season, bs.team_id, tg.g AS team_games,
                   t.short_name AS team_short, t.name AS team_name, t.logo_url,
                   c.abbreviation AS conference, d.level AS db_level,
                   bs.offensive_war AS war, bs.plate_appearances,
                   bs.batting_avg, bs.on_base_pct, bs.slugging_pct, bs.ops,
                   bs.home_runs, bs.rbi, bs.stolen_bases
            FROM batting_stats bs
            JOIN players p ON p.id = bs.player_id
            JOIN teams t ON t.id = bs.team_id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN team_games tg ON tg.season = bs.season AND tg.team_id = bs.team_id
            LEFT JOIN player_seasons psn ON psn.player_id = bs.player_id
                 AND psn.season = bs.season AND psn.team_id = bs.team_id
            WHERE COALESCE(p.is_phantom, false) = false
              AND p.bats IS NOT NULL AND p.bats <> ''
              AND COALESCE(NULLIF(psn.year_in_school, ''), NULLIF(p.year_in_school, '')) IS NOT NULL
              AND p.first_name IS NOT NULL AND p.last_name IS NOT NULL
              {level_clause} {season_clause}
            """,
            params,
        )
        for r in cur.fetchall():
            key = (r["player_id"], r["season"], r["team_id"])
            owar = float(r["war"] or 0)
            tg = r["team_games"]
            min_pa = QUALIFIED_PA_PER_GAME * tg if tg else FLAT_MIN_PA
            qualified = (r["plate_appearances"] or 0) >= min_pa
            entries[key] = {
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
                "war": round(owar, 1),
                "stats": {
                    "AVG": r["batting_avg"], "OBP": r["on_base_pct"],
                    "SLG": r["slugging_pct"], "OPS": r["ops"], "HR": r["home_runs"],
                    "RBI": r["rbi"], "SB": r["stolen_bases"],
                    "PA": r["plate_appearances"], "oWAR": round(owar, 1),
                },
                "_answer": qualified and owar >= war_min["hit"],
            }

        # ── Pitchers: every in-scope pitcher-season ──
        cur.execute(
            f"""
            WITH {team_games_cte}
            SELECT p.id AS player_id, p.first_name, p.last_name,
                   p.position, p.bats, p.throws,
                   COALESCE(NULLIF(psn.year_in_school, ''), NULLIF(p.year_in_school, '')) AS year_in_school,
                   ps.season, ps.team_id, tg.g AS team_games,
                   t.short_name AS team_short, t.name AS team_name, t.logo_url,
                   c.abbreviation AS conference, d.level AS db_level,
                   ps.pitching_war AS war, ps.innings_pitched,
                   ps.era, ps.whip, ps.strikeouts, ps.walks, ps.wins, ps.saves
            FROM pitching_stats ps
            JOIN players p ON p.id = ps.player_id
            JOIN teams t ON t.id = ps.team_id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            LEFT JOIN team_games tg ON tg.season = ps.season AND tg.team_id = ps.team_id
            LEFT JOIN player_seasons psn ON psn.player_id = ps.player_id
                 AND psn.season = ps.season AND psn.team_id = ps.team_id
            WHERE COALESCE(p.is_phantom, false) = false
              AND p.throws IS NOT NULL AND p.throws <> ''
              AND COALESCE(NULLIF(psn.year_in_school, ''), NULLIF(p.year_in_school, '')) IS NOT NULL
              AND p.first_name IS NOT NULL AND p.last_name IS NOT NULL
              {level_clause} {season_clause_p}
            """,
            params,
        )
        for r in cur.fetchall():
            key = (r["player_id"], r["season"], r["team_id"])
            pwar = float(r["war"] or 0)
            tg = r["team_games"]
            min_outs = QUALIFIED_IP_PER_GAME * 3 * tg if tg else FLAT_MIN_IP * 3
            qualified = _ip_outs(r["innings_pitched"]) >= min_outs
            p_answer = qualified and pwar >= war_min["pit"]
            pstats = {
                "ERA": r["era"], "WHIP": r["whip"], "SO": r["strikeouts"],
                "BB": r["walks"], "IP": r["innings_pitched"], "W": r["wins"],
                "SV": r["saves"], "pWAR": round(pwar, 1),
            }
            if key in entries:
                e = entries[key]
                e["role"] = "Two-Way"
                e["stats"].update(pstats)
                if pwar > e["war"]:
                    e["war"] = round(pwar, 1)
                e["_answer"] = e["_answer"] or p_answer
            else:
                entries[key] = {
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
                    "war": round(pwar, 1),
                    "stats": pstats,
                    "_answer": p_answer,
                }

    all_entries = list(entries.values())
    # Answers keep full statlines (used for the reveal). Guesses only need the
    # grid clue fields (AVG/HR/ERA/SO + WAR), so trim them to keep the payload
    # small even when guessing across every player in a big scope.
    answers = []
    for e in all_entries:
        if e.pop("_answer", False):
            answers.append(e)

    def trim(e):
        s = e["stats"]
        return {
            "player_id": e["player_id"], "name": e["name"], "season": e["season"],
            "team": e["team"], "logo": e["logo"], "conference": e["conference"],
            "level": e["level"], "position": e["position"], "posGroup": e["posGroup"],
            "bats": e["bats"], "throws": e["throws"], "classYear": e["classYear"],
            "classRank": e["classRank"], "role": e["role"], "war": e["war"],
            "stats": {"AVG": s.get("AVG"), "HR": s.get("HR"), "ERA": s.get("ERA"), "SO": s.get("SO")},
        }

    guesses = [trim(e) for e in all_entries]
    guesses.sort(key=lambda e: (e["name"], e["season"]))
    answers.sort(key=lambda e: (e["name"], e["season"]))

    result = {
        "level": level,
        "difficulty": difficulty,
        "answers": answers,
        "guesses": guesses,
        "answer_count": len(answers),
        "guess_count": len(guesses),
    }
    _CACHE[ck] = (time.time(), result)
    return result
