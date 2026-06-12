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

import math
from datetime import date, timedelta
from itertools import groupby
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from ..cache import cached_endpoint
from ..config import CURRENT_SEASON
from ..models.database import get_connection
from ..stats.cpi import compute_cpi


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
    season: int = Query(CURRENT_SEASON),
    days_back: int = Query(3, ge=0, le=120),
    days_ahead: int = Query(3, ge=0, le=120),
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
    season: int = Query(CURRENT_SEASON),
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


# ── Win-probability curve (PA-by-PA, from summer_game_events) ──────
#
# Summer games have play-by-play (summer_game_events: one row per plate
# appearance with count, pitch sequence, and outcome) but NOT the derived
# base/out/score game state the spring `game_events` carry. So we reconstruct
# what a win-expectancy model needs directly from the events: walk every PA in
# order, count outs from the result type, and tally the running score from the
# narrative (reconciled to the authoritative line score at each half-inning).
# Win expectancy uses (run lead, outs remaining) via a normal approximation of
# the remaining run differential. It is NOT full WPA — it has no baserunner
# leverage, since the events don't store base state.
_OUT_PLAIN = {"ground_out", "fly_out", "pop_out", "line_out", "sac_fly",
              "caught_stealing", "pickoff"}


def _se_outs(rt, text):
    t = (text or "").lower()
    if rt and rt.startswith("strikeout"):
        return 0 if "reached" in t else 1   # K + WP/PB/dropped 3rd = batter safe
    if rt == "double_play":
        return 2
    if rt in _OUT_PLAIN:
        return 1
    if rt in ("fielders_choice", "runner_other"):
        return 1 if "out" in t else 0
    return 0


def _se_runs(rt, text):
    # The narrative always names a scorer ("... scored"), except the batter on a
    # home run, so count "scored" and add the HR hitter.
    r = (text or "").lower().count("scored")
    if rt == "home_run":
        r += 1
    return r


def _se_we_home(lead, outs_remaining):
    if outs_remaining <= 0:
        return 1.0 if lead > 0 else 0.0 if lead < 0 else 0.5
    inn_rem = max(0.12, outs_remaining / 6.0)          # 6 outs per full inning
    sd = 1.65 * math.sqrt(inn_rem) + 0.45
    z = (lead + (0.2 if lead == 0 else 0)) / sd
    return max(0.02, min(0.98, 0.5 * (1 + math.erf(z / math.sqrt(2)))))


def _summer_win_prob(cur, game):
    """Return {pts:[{x,wp}], innings} of HOME win probability, or None."""
    cur.execute(
        """
        SELECT inning, half, sequence_idx, result_type, result_text, rbi
        FROM summer_game_events
        WHERE game_id = %s
        ORDER BY inning, (half <> 'top'), sequence_idx
        """,
        (game["id"],),
    )
    evs = cur.fetchall()
    if len(evs) < 3:
        return None

    def line_cum(line, upto):
        s = 0
        for i in range(min(upto, len(line or []))):
            v = line[i]
            if isinstance(v, str) or v is None:
                continue
            try:
                s += int(v)
            except (TypeError, ValueError):
                pass
        return s

    away_line = game.get("away_line_score") or []
    home_line = game.get("home_line_score") or []
    TOTAL_OUTS = 54  # 27 per side, regulation
    away_score = home_score = away_outs = home_outs = 0
    max_inn = max(e["inning"] for e in evs)

    pts = [{"x": 0.0, "wp": round(_se_we_home(0, TOTAL_OUTS), 4)}]
    for (inning, half), grp in groupby(evs, key=lambda e: (e["inning"], e["half"])):
        grp = list(grp)
        is_top = half == "top"
        m = len(grp)
        half_outs = 0
        for j, e in enumerate(grp):
            runs = _se_runs(e["result_type"], e["result_text"])
            if is_top:
                away_score += runs
            else:
                home_score += runs
            half_outs = min(3, half_outs + _se_outs(e["result_type"], e["result_text"]))
            outs_remaining = max(0, TOTAL_OUTS - (away_outs + home_outs) - half_outs)
            x = (inning - 1) + (0.0 if is_top else 0.5) + 0.5 * ((j + 1) / m)
            pts.append({"x": round(x, 4),
                        "wp": round(_se_we_home(home_score - away_score, outs_remaining), 4)})
        # snap the running score to the authoritative line score for this inning
        if is_top:
            away_score = line_cum(away_line, inning)
            away_outs += half_outs
        else:
            home_score = line_cum(home_line, inning)
            home_outs += half_outs

    fa = game.get("away_score") or 0
    fh = game.get("home_score") or 0
    pts[-1] = {"x": pts[-1]["x"], "wp": 1.0 if fh > fa else 0.0 if fa > fh else 0.5}
    return {"pts": pts, "innings": max_inn}


# ── Player college resolution (for recap graphics, "which guys are PNWers") ──
#
# We show ONLY a school we can confirm the player played for in the current
# season, via the spring cross-link (summer_player_links -> players -> teams),
# resolved to their most-recent-season team. There is intentionally NO raw
# Pointstreak `college` fallback: that field carries no season and is often
# stale (an old transfer's school), so an unconfirmable school is left blank.


def _school_from_team(name, mascot):
    if not name:
        return None
    if mascot and name.endswith(mascot):
        return name[:-len(mascot)].strip() or name
    return name


def _resolve_colleges(cur, player_ids, season):
    """player_id -> CONFIRMED current (>= `season`) school, else None.

    We only show a school we can confirm the player played for in the current
    season. Players transfer, and our spring DB stores one row per (player,
    team), so a 2026 summer record can be linked to a 2022 JUCO row. So: among
    all spring records sharing the linked player's name, take the team from the
    most recent stats season, and emit it ONLY if that season is >= the game's
    season (i.e. they played there this year). We deliberately do NOT fall back
    to the raw Pointstreak `college` string — it has no season and is often
    stale (e.g. an out-of-region school from an old roster), so when we can't
    confirm the current school we leave it blank rather than show stale data.
    """
    ids = sorted({p for p in player_ids if p})
    if not ids or not season:
        return {}
    out = {}
    cur.execute(
        """
        WITH linked AS (
            SELECT DISTINCT ON (lk.summer_player_id)
                   lk.summer_player_id AS spid,
                   lower(spr.first_name) AS fn, lower(spr.last_name) AS ln
            FROM summer_player_links lk
            JOIN players spr ON spr.id = lk.spring_player_id
            WHERE lk.summer_player_id = ANY(%s)
            ORDER BY lk.summer_player_id, lk.confidence DESC NULLS LAST
        ),
        cand AS (
            SELECT l.spid, p.id AS pid, p.team_id,
                   GREATEST(
                     COALESCE((SELECT MAX(season) FROM batting_stats b WHERE b.player_id = p.id), 0),
                     COALESCE((SELECT MAX(season) FROM pitching_stats pt WHERE pt.player_id = p.id), 0)
                   ) AS last_season
            FROM linked l
            JOIN players p ON lower(p.first_name) = l.fn AND lower(p.last_name) = l.ln
        )
        SELECT DISTINCT ON (c.spid) c.spid, t.name, t.mascot, c.last_season
        FROM cand c JOIN teams t ON t.id = c.team_id
        ORDER BY c.spid, c.last_season DESC, c.pid DESC
        """,
        (ids,),
    )
    for r in cur.fetchall():
        if (r["last_season"] or 0) < season:
            continue  # can't confirm they played there this season -> leave blank
        sch = _school_from_team(r["name"], r["mascot"])
        if sch:
            out[r["spid"]] = sch
    return out


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

        # Confirmed current-season school per player (spring cross-link, most
        # recent season >= this game's season). Blank when unconfirmable —
        # never shows a stale/old school. Flags PNW players on recap graphics.
        _g = dict(game)
        _season = _g.get("season") or (int(_g["game_date"][:4]) if _g.get("game_date") else None)
        colleges = _resolve_colleges(
            cur,
            [r.get("player_id") for r in batting] + [r.get("player_id") for r in pitching],
            _season,
        )
        for r in batting:
            r["college"] = colleges.get(r.get("player_id"))
        for r in pitching:
            r["college"] = colleges.get(r.get("player_id"))

        win_prob = _summer_win_prob(cur, dict(game))

    return {
        "game": dict(game),
        "batting": batting,
        "pitching": pitching,
        "win_prob": win_prob,
    }


# ── /summer/cpi — Composite Power Index (predictive team rating) ────

@router.get("/summer/cpi")
@cached_endpoint(ttl_seconds=600)
def summer_cpi(league: str = Query(DEFAULT_LEAGUE), season: int = Query(CURRENT_SEASON)):
    """Composite Power Index: a predictive, SoS-adjusted power rating built from
    underlying performance (team wRC+ / FIP) blended with regressed results.
    Engine in app.stats.cpi (reused for spring later)."""
    from collections import defaultdict
    with get_connection() as conn:
        cur = conn.cursor()
        league_id = _league_id_for(cur, league)
        cur.execute(
            """SELECT home_team_id h, away_team_id a, home_score hs, away_score a_s
               FROM summer_games
               WHERE league_id=%s AND season=%s AND status='final'
                 AND home_score IS NOT NULL AND away_score IS NOT NULL
                 AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL""",
            (league_id, season),
        )
        games_by_team = defaultdict(list)
        for g in cur.fetchall():
            games_by_team[g["h"]].append((g["a"], g["hs"] - g["a_s"]))
            games_by_team[g["a"]].append((g["h"], g["a_s"] - g["hs"]))
        team_ids = list(games_by_team)
        if not team_ids:
            return {"league": league, "season": season, "teams": []}

        cur.execute(
            """SELECT team_id, SUM(plate_appearances) pa, SUM(wrc_plus*plate_appearances) wsum
               FROM summer_batting_stats WHERE season=%s AND plate_appearances>0
               GROUP BY team_id""", (season,))
        offense = {r["team_id"]: {"pa": r["pa"], "wrc_sum": float(r["wsum"])} for r in cur.fetchall()}
        # innings_pitched is only a weighting term here; small notation error is fine.
        cur.execute(
            """SELECT team_id, SUM(innings_pitched) ip, SUM(fip*innings_pitched) fsum
               FROM summer_pitching_stats WHERE season=%s AND innings_pitched>0
               GROUP BY team_id""", (season,))
        pitching = {r["team_id"]: {"ip": float(r["ip"]), "fip_sum": float(r["fsum"])} for r in cur.fetchall()}

        cur.execute("SELECT id, name, short_name, logo_url, division FROM summer_teams WHERE id = ANY(%s)", (team_ids,))
        meta = {r["id"]: dict(r) for r in cur.fetchall()}

    ratings = compute_cpi(team_ids, games_by_team, offense, pitching)
    rows = []
    for tid, r in ratings.items():
        m = meta.get(tid, {})
        rows.append({**r, "team_id": tid, "team": m.get("short_name") or m.get("name"),
                     "team_name": m.get("name"), "logo": m.get("logo_url"),
                     "division": m.get("division")})
    rows.sort(key=lambda x: -x["cpi_raw"])
    for i, row in enumerate(rows, 1):
        row["rank"] = i
    return {"league": league, "season": season, "teams": rows}


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
def summer_team_detail(team_id: int, season: int = Query(CURRENT_SEASON)):
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

        # Top 5 batters by OPS
        cur.execute(
            """
            SELECT b.player_id, b.plate_appearances, b.batting_avg, b.on_base_pct,
                   b.slugging_pct, b.ops, b.woba, b.wrc_plus, b.home_runs, b.rbi,
                   p.first_name, p.last_name, p.position
            FROM summer_batting_stats b
            JOIN summer_players p ON p.id = b.player_id
            WHERE b.team_id = %s AND b.season = %s AND b.plate_appearances > 0
            ORDER BY b.ops DESC NULLS LAST, b.plate_appearances DESC
            LIMIT 6
            """,
            (team_id, season),
        )
        top_batters = [dict(r) for r in cur.fetchall()]

        # Top 5 pitchers by ERA (min 1 IP, fall back to IP order)
        cur.execute(
            """
            SELECT pt.player_id, pt.innings_pitched, pt.era, pt.whip, pt.fip,
                   pt.k_per_9, pt.strikeouts, pt.wins, pt.losses, pt.saves,
                   p.first_name, p.last_name
            FROM summer_pitching_stats pt
            JOIN summer_players p ON p.id = pt.player_id
            WHERE pt.team_id = %s AND pt.season = %s AND pt.innings_pitched > 0
            ORDER BY pt.era ASC NULLS LAST, pt.innings_pitched DESC
            LIMIT 6
            """,
            (team_id, season),
        )
        top_pitchers = [dict(r) for r in cur.fetchall()]

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

        # Roster — the full {season} roster (scraped from wclstats into
        # summer_players.roster_year) PLUS anyone with {season} game stats.
        # Each player gets a `role` (pitcher / hitter / two-way) derived from
        # PA vs IP (position breaks ties for no-stat bench players), so pitchers
        # stop showing up as 0-for hitters. Both batting and pitching lines are
        # attached so the frontend can show the right stat per role.
        cur.execute(
            """
            SELECT p.id, p.first_name, p.last_name, p.jersey_number,
                   p.position, p.bats, p.throws, p.college, p.year_in_school,
                   p.hometown, p.roster_year,
                   b.plate_appearances, b.batting_avg, b.on_base_pct,
                   b.slugging_pct, b.ops, b.games AS bat_games, b.home_runs, b.rbi,
                   pt.innings_pitched, pt.era, pt.whip, pt.strikeouts AS p_strikeouts,
                   pt.wins AS p_wins, pt.losses AS p_losses, pt.saves AS p_saves,
                   spl.spring_player_id,
                   (EXISTS (SELECT 1 FROM batting_stats bs
                            WHERE bs.player_id = spl.spring_player_id AND bs.season = %s)
                    OR EXISTS (SELECT 1 FROM pitching_stats ps2
                            WHERE ps2.player_id = spl.spring_player_id AND ps2.season = %s)) AS pnw_spring
            FROM summer_players p
            LEFT JOIN summer_batting_stats b
                   ON b.player_id = p.id AND b.season = %s AND b.team_id = p.team_id
            LEFT JOIN summer_pitching_stats pt
                   ON pt.player_id = p.id AND pt.season = %s AND pt.team_id = p.team_id
            LEFT JOIN summer_player_links spl ON spl.summer_player_id = p.id
            WHERE p.team_id = %s
              AND (
                p.roster_year = %s
                OR EXISTS (SELECT 1 FROM summer_game_batting gb
                        JOIN summer_games g ON g.id = gb.game_id
                        WHERE gb.player_id = p.id AND gb.team_id = %s AND g.season = %s)
                OR EXISTS (SELECT 1 FROM summer_game_pitching gp
                        JOIN summer_games g ON g.id = gp.game_id
                        WHERE gp.player_id = p.id AND gp.team_id = %s AND g.season = %s)
              )
            ORDER BY p.last_name, p.first_name
            """,
            (season, season, season, season, team_id, season, team_id, season, team_id, season),
        )
        PITCHER_POS = {"P", "RHP", "LHP", "SP", "RP"}
        roster = []
        for r in cur.fetchall():
            row = dict(r)
            pa = row.get("plate_appearances") or 0
            ip = float(row.get("innings_pitched") or 0)
            pos = (row.get("position") or "").upper().strip()
            if pa > 0 and ip > 0:
                row["role"] = "two-way"
            elif ip > 0:
                row["role"] = "pitcher"
            elif pa > 0:
                row["role"] = "hitter"
            else:
                row["role"] = "pitcher" if pos in PITCHER_POS else "hitter"
            row["has_stats"] = bool(pa > 0 or ip > 0)
            roster.append(row)

    return {
        "team": dict(team),
        "record": record,
        "team_batting": team_bat,
        "recent_games": recent,
        "roster": roster,
        "top_batters": top_batters,
        "top_pitchers": top_pitchers,
    }


# ── Hitter approach splits (from summer_game_events PBP) ────────────

# PA-ending result types written by parse_wcl_pbp. Standalone sub-events
# (stolen_base, wild_pitch, ...) carry no batter_player_id, so filtering
# by batter already excludes them; we also gate on these for safety.
_PA_RESULT_TYPES = [
    "single", "double", "triple", "home_run", "walk", "intentional_walk", "hbp",
    "strikeout_swinging", "strikeout_looking", "ground_out", "fly_out", "line_out",
    "pop_out", "sac_fly", "sac_bunt", "fielders_choice", "error", "double_play", "other",
]


def _compute_summer_approach(cur, player_id, season):
    """Pitch-level + count approach splits from summer_game_events.

    Pitch-sequence letters (StatCrew/Presto): K = swinging strike (whiff),
    F = foul, B = ball, S = called strike. A swing = whiff + foul + ball
    in play; contact excludes whiffs. Same formula as the spring
    lineup_helper._fetch_pbp_stats_bulk. Returns None when no PBP PAs.
    """
    cur.execute(
        """
        SELECT
          COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))), 0) AS k_pitches,
          COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS f_pitches,
          COALESCE(SUM(LENGTH(COALESCE(pitch_sequence, ''))), 0) AS seq_total,
          COUNT(*) FILTER (WHERE was_in_play) AS in_play,
          COUNT(*) AS pa,
          COUNT(*) FILTER (WHERE result_type IN ('strikeout_swinging', 'strikeout_looking')) AS k,
          COUNT(*) FILTER (WHERE result_type IN ('walk', 'intentional_walk')) AS bb,
          COUNT(*) FILTER (
            WHERE LEFT(COALESCE(pitch_sequence, ''), 1) IN ('K', 'F')
               OR (was_in_play AND COALESCE(LENGTH(pitch_sequence), 0) = 0)
          ) AS fp_swing
        FROM summer_game_events e
        JOIN summer_games g ON g.id = e.game_id
        WHERE e.batter_player_id = %s
          AND g.season = %s
          AND e.result_type = ANY(%s)
        """,
        (player_id, season, _PA_RESULT_TYPES),
    )
    r = cur.fetchone()
    if not r or not r["pa"]:
        return None

    k_p = r["k_pitches"] or 0
    f_p = r["f_pitches"] or 0
    seq = r["seq_total"] or 0
    in_play = r["in_play"] or 0
    pa = r["pa"] or 0
    swings = k_p + f_p + in_play
    contact = f_p + in_play
    pitches_seen = seq + in_play

    def pct(num, den):
        return round(num / den, 3) if den else None

    return {
        "season": season,
        "pa": pa,
        "pitches_seen": pitches_seen,
        "swing_pct": pct(swings, pitches_seen),
        "contact_pct": pct(contact, swings),
        "whiff_pct": pct(k_p, swings),
        "first_pitch_swing_pct": pct(r["fp_swing"] or 0, pa),
        "k_pct": pct(r["k"] or 0, pa),
        "bb_pct": pct(r["bb"] or 0, pa),
    }


# ── Pitcher pitch-level approach (from summer_game_events PBP) ──────

def _compute_summer_pitch_approach(cur, player_id, season):
    """Pitcher pitch-level rates from summer_game_events (2026 WCL PBP).

    Mirrors the hitter approach denominator convention: pitches seen =
    all pitch-sequence letters + balls-in-play (the contacted pitch isn't
    always logged in the sequence). Strike = called strike (S) + swinging
    strike (K) + foul (F) + ball in play. Whiff = K / swings. First-pitch
    strike = PAs whose first logged pitch is S/K/F (or a 0-0 ball in play).
    Returns None when no tracked PBP PAs.
    """
    cur.execute(
        """
        SELECT
          COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', ''))), 0) AS k_p,
          COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS f_p,
          COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'S', ''))), 0) AS s_p,
          COALESCE(SUM(LENGTH(COALESCE(pitch_sequence, ''))), 0) AS seq_total,
          COUNT(*) FILTER (WHERE was_in_play) AS in_play,
          COUNT(*) FILTER (WHERE pitches_thrown >= 1) AS tracked_pa,
          COUNT(*) FILTER (
            WHERE pitches_thrown >= 1
              AND (LEFT(COALESCE(pitch_sequence, ''), 1) IN ('K', 'S', 'F')
                   OR (COALESCE(pitch_sequence, '') = '' AND was_in_play))
          ) AS f1_strikes,
          COUNT(*) AS pa,
          COUNT(*) FILTER (WHERE result_type IN ('strikeout_swinging', 'strikeout_looking')) AS k,
          COUNT(*) FILTER (WHERE result_type IN ('walk', 'intentional_walk')) AS bb
        FROM summer_game_events e
        JOIN summer_games g ON g.id = e.game_id
        WHERE e.pitcher_player_id = %s
          AND g.season = %s
          AND e.result_type = ANY(%s)
        """,
        (player_id, season, _PA_RESULT_TYPES),
    )
    r = cur.fetchone()
    if not r or not r["pa"]:
        return None
    k_p = r["k_p"] or 0
    f_p = r["f_p"] or 0
    s_p = r["s_p"] or 0
    seq = r["seq_total"] or 0
    in_play = r["in_play"] or 0
    pa = r["pa"] or 0
    swings = k_p + f_p + in_play
    strikes = k_p + s_p + f_p + in_play
    pitches_seen = seq + in_play

    def pct(num, den):
        return round(num / den, 3) if den else None

    return {
        "season": season,
        "pa": pa,
        "pitches_seen": pitches_seen,
        "strike_pct": pct(strikes, pitches_seen),
        "whiff_pct": pct(k_p, swings),
        "first_pitch_strike_pct": pct(r["f1_strikes"] or 0, r["tracked_pa"] or 0),
        "k_pct": pct(r["k"] or 0, pa),
        "bb_pct": pct(r["bb"] or 0, pa),
    }


# ── Percentile rankings (savant-style, vs league + season peers) ────

def _rank_pct(values, my_val, higher_is_better=True):
    """Rank-based percentile (rank 1 -> 99) for my_val within a peer set.

    Mirrors routes.py _rank_block: the best peer reads 99, the worst 1, so
    a true league leader never caps out at ~95. Needs >= 3 peers for a
    stable scale (otherwise percentile is None and the row hides on the
    frontend). Returns the savant payload shape the PercentilePanel reads:
    {value, percentile, rank, total, league_avg, comparison}.
    """
    if my_val is None:
        return {"value": None, "percentile": None, "rank": None, "total": None,
                "league_avg": None, "comparison": "league"}
    my_val = float(my_val)
    vals = [float(v) for v in values if v is not None]
    total = len(vals)
    avg = round(sum(vals) / total, 4) if total else None
    if total < 3:
        return {"value": my_val, "percentile": None, "rank": None, "total": total,
                "league_avg": avg, "comparison": "league"}
    if higher_is_better:
        rank = sum(1 for v in vals if v > my_val) + 1
    else:
        rank = sum(1 for v in vals if v < my_val) + 1
    pct = max(1, min(99, round(((total - rank) / (total - 1)) * 100)))
    return {"value": my_val, "percentile": pct, "rank": rank, "total": total,
            "league_avg": avg, "comparison": "league"}


def _summer_hitter_contact_cohort(cur, league_id, season, min_pa=8):
    """{batter_player_id: contact%} for the league+season (2026 PBP only)."""
    cur.execute(
        """
        SELECT e.batter_player_id AS pid,
          COALESCE(SUM(LENGTH(e.pitch_sequence) - LENGTH(REPLACE(e.pitch_sequence, 'K', ''))), 0) AS k_p,
          COALESCE(SUM(LENGTH(e.pitch_sequence) - LENGTH(REPLACE(e.pitch_sequence, 'F', ''))), 0) AS f_p,
          COUNT(*) FILTER (WHERE e.was_in_play) AS in_play,
          COUNT(*) AS pa
        FROM summer_game_events e
        JOIN summer_games g ON g.id = e.game_id
        JOIN summer_players sp ON sp.id = e.batter_player_id
        JOIN summer_teams t ON t.id = sp.team_id
        WHERE g.season = %s AND t.league_id = %s
          AND e.result_type = ANY(%s) AND e.batter_player_id IS NOT NULL
        GROUP BY e.batter_player_id
        """,
        (season, league_id, _PA_RESULT_TYPES),
    )
    out = {}
    for r in cur.fetchall():
        if (r["pa"] or 0) < min_pa:
            continue
        swings = (r["k_p"] or 0) + (r["f_p"] or 0) + (r["in_play"] or 0)
        if swings > 0:
            out[r["pid"]] = ((r["f_p"] or 0) + (r["in_play"] or 0)) / swings
    return out


def _summer_pitcher_pbp_cohort(cur, league_id, season, min_pitches=25):
    """{pitcher_player_id: {strike_pct, fps_pct, whiff_pct}} (2026 PBP only).

    Scoped to the league via the pitcher's own summer team (the defending
    side), so cross-league exhibition opponents don't leak into the cohort.
    """
    cur.execute(
        """
        SELECT e.pitcher_player_id AS pid,
          COALESCE(SUM(LENGTH(e.pitch_sequence) - LENGTH(REPLACE(e.pitch_sequence, 'K', ''))), 0) AS k_p,
          COALESCE(SUM(LENGTH(e.pitch_sequence) - LENGTH(REPLACE(e.pitch_sequence, 'F', ''))), 0) AS f_p,
          COALESCE(SUM(LENGTH(e.pitch_sequence) - LENGTH(REPLACE(e.pitch_sequence, 'S', ''))), 0) AS s_p,
          COALESCE(SUM(LENGTH(COALESCE(e.pitch_sequence, ''))), 0) AS seq_total,
          COUNT(*) FILTER (WHERE e.was_in_play) AS in_play,
          COUNT(*) FILTER (WHERE e.pitches_thrown >= 1) AS tracked_pa,
          COUNT(*) FILTER (
            WHERE e.pitches_thrown >= 1
              AND (LEFT(COALESCE(e.pitch_sequence, ''), 1) IN ('K', 'S', 'F')
                   OR (COALESCE(e.pitch_sequence, '') = '' AND e.was_in_play))
          ) AS f1_strikes
        FROM summer_game_events e
        JOIN summer_games g ON g.id = e.game_id
        JOIN summer_players sp ON sp.id = e.pitcher_player_id
        JOIN summer_teams t ON t.id = sp.team_id
        WHERE g.season = %s AND t.league_id = %s
          AND e.pitcher_player_id IS NOT NULL
        GROUP BY e.pitcher_player_id
        """,
        (season, league_id),
    )
    out = {}
    for r in cur.fetchall():
        k_p = r["k_p"] or 0
        f_p = r["f_p"] or 0
        s_p = r["s_p"] or 0
        in_play = r["in_play"] or 0
        seq = r["seq_total"] or 0
        pitches_seen = seq + in_play
        if pitches_seen < min_pitches:
            continue
        swings = k_p + f_p + in_play
        tracked = r["tracked_pa"] or 0
        out[r["pid"]] = {
            "strike_pct": ((k_p + s_p + f_p + in_play) / pitches_seen) if pitches_seen else None,
            "whiff_pct": (k_p / swings) if swings else None,
            "first_pitch_strike_pct": ((r["f1_strikes"] or 0) / tracked) if tracked else None,
        }
    return out


def _summer_percentiles(cur, league_id, season, bat_row, pit_row):
    """Build savant-style percentile payloads for the player's `season`
    line vs every qualified peer in the same summer league + season.

    Season advanced stats (wOBA, wRC+, FIP, etc.) are computed for every
    summer season we have; pitch-level rates (Contact%, Strike%, Whiff%)
    only exist where we have tracked play-by-play (2026 WCL today)."""
    batting_percentiles = {}
    pitching_percentiles = {}

    # ── Batting: peers with a meaningful sample ──
    # The qualifying floor adapts to how far the season has progressed:
    # ~20% of the league leader's PA, with an absolute minimum. In a
    # finished season that's a real qualified bar; in opening week (when
    # nobody has 20 PA yet) it still ranks everyone who's stepped in.
    if bat_row:
        cur.execute(
            """
            SELECT b.player_id, b.plate_appearances AS pa, b.home_runs AS hr,
                   b.stolen_bases AS sb, b.woba, b.wrc_plus, b.wobacon, b.iso,
                   b.k_pct, b.bb_pct, b.offensive_war
            FROM summer_batting_stats b
            JOIN summer_players p ON p.id = b.player_id
            JOIN summer_teams t ON t.id = p.team_id
            WHERE t.league_id = %s AND b.season = %s AND b.plate_appearances >= 1
            """,
            (league_id, season),
        )
        all_bat = [dict(r) for r in cur.fetchall()]
        lead_pa = max((r.get("pa") or 0) for r in all_bat) if all_bat else 0
        bat_floor = max(8, round(0.20 * lead_pa))
        peers = [r for r in all_bat if (r.get("pa") or 0) >= bat_floor]

        def _col(key):
            return [r.get(key) for r in peers]

        def _rate(numkey, r):
            pa = r.get("pa") or 0
            n = r.get(numkey)
            return (n / pa) if (pa and n is not None) else None

        my_pa = bat_row.get("plate_appearances") or 0
        my_hrpa = (bat_row["home_runs"] / my_pa) if (my_pa and bat_row.get("home_runs") is not None) else None
        my_sbpa = (bat_row["stolen_bases"] / my_pa) if (my_pa and bat_row.get("stolen_bases") is not None) else None

        batting_percentiles = {
            "offensive_war": _rank_pct(_col("offensive_war"), bat_row.get("offensive_war"), True),
            "wrc_plus":      _rank_pct(_col("wrc_plus"),      bat_row.get("wrc_plus"),      True),
            "woba":          _rank_pct(_col("woba"),          bat_row.get("woba"),          True),
            "wobacon":       _rank_pct(_col("wobacon"),       bat_row.get("wobacon"),       True),
            "iso":           _rank_pct(_col("iso"),           bat_row.get("iso"),           True),
            "hr_pa_pct":     _rank_pct([_rate("hr", r) for r in peers], my_hrpa, True),
            "k_pct":         _rank_pct(_col("k_pct"),         bat_row.get("k_pct"),         False),
            "bb_pct":        _rank_pct(_col("bb_pct"),        bat_row.get("bb_pct"),        True),
            "sb_per_pa":     _rank_pct([_rate("sb", r) for r in peers], my_sbpa, True),
        }
        contact = _summer_hitter_contact_cohort(cur, league_id, season)
        if contact:
            batting_percentiles["contact_pct"] = _rank_pct(
                list(contact.values()), contact.get(bat_row.get("player_id")), True)

    # ── Pitching: peers with a meaningful sample (adaptive floor) ──
    if pit_row:
        cur.execute(
            """
            SELECT pt.player_id, pt.innings_pitched AS ip,
                   pt.batters_faced AS bf, pt.home_runs_allowed AS hra,
                   pt.pitching_war, pt.k_pct, pt.bb_pct, pt.fip, pt.siera, pt.xfip, pt.baa
            FROM summer_pitching_stats pt
            JOIN summer_players p ON p.id = pt.player_id
            JOIN summer_teams t ON t.id = p.team_id
            WHERE t.league_id = %s AND pt.season = %s AND pt.innings_pitched > 0
            """,
            (league_id, season),
        )
        all_pit = [dict(r) for r in cur.fetchall()]
        lead_ip = max((float(r.get("ip") or 0)) for r in all_pit) if all_pit else 0
        pit_floor = max(2.0, 0.20 * lead_ip)
        peers = [r for r in all_pit if float(r.get("ip") or 0) >= pit_floor]

        def _pcol(key):
            return [r.get(key) for r in peers]

        def _hrpa(r):
            bf = r.get("bf") or 0
            hra = r.get("hra")
            return (hra / bf) if (bf and hra is not None) else None

        my_bf = pit_row.get("batters_faced") or 0
        my_hrpa = (pit_row["home_runs_allowed"] / my_bf) if (my_bf and pit_row.get("home_runs_allowed") is not None) else None

        pitching_percentiles = {
            "pitching_war": _rank_pct(_pcol("pitching_war"), pit_row.get("pitching_war"), True),
            "k_pct":        _rank_pct(_pcol("k_pct"),        pit_row.get("k_pct"),        True),
            "bb_pct":       _rank_pct(_pcol("bb_pct"),       pit_row.get("bb_pct"),       False),
            "fip":          _rank_pct(_pcol("fip"),          pit_row.get("fip"),          False),
            "siera":        _rank_pct(_pcol("siera"),        pit_row.get("siera"),        False),
            "xfip":         _rank_pct(_pcol("xfip"),         pit_row.get("xfip"),         False),
            "baa":          _rank_pct(_pcol("baa"),          pit_row.get("baa"),          False),
            "hr_pa_pct":    _rank_pct([_hrpa(r) for r in peers], my_hrpa, False),
        }
        pbp = _summer_pitcher_pbp_cohort(cur, league_id, season)
        if pbp:
            mine = pbp.get(pit_row.get("player_id")) or {}
            for key in ("strike_pct", "first_pitch_strike_pct", "whiff_pct"):
                pitching_percentiles[key] = _rank_pct(
                    [v.get(key) for v in pbp.values()], mine.get(key), True)

    return batting_percentiles, pitching_percentiles


# ── /summer/players/{id} ───────────────────────────────────────────

@router.get("/summer/players/{player_id}")
@cached_endpoint(ttl_seconds=180)
def summer_player_detail(player_id: int, season: Optional[int] = Query(None)):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT p.*,
                   t.id   AS team_id,
                   t.league_id AS league_id,
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

        # Effective season: honor an explicit ?season=, otherwise default to
        # the most recent season this player actually has stats for (so the
        # percentile panel + game logs land on real data instead of an empty
        # not-yet-started year).
        seasons_present = sorted(
            {r["season"] for r in batting} | {r["season"] for r in pitching}
        )
        if season is not None and season in seasons_present:
            eff_season = season
        elif seasons_present:
            eff_season = seasons_present[-1]
        else:
            eff_season = season if season is not None else CURRENT_SEASON

        # Per-game logs for the effective season
        cur.execute(
            """
            SELECT b.*, g.game_date, g.away_team_name, g.home_team_name,
                   g.away_score, g.home_score, g.away_team_id, g.home_team_id
            FROM summer_game_batting b
            JOIN summer_games g ON g.id = b.game_id
            WHERE b.player_id = %s AND g.season = %s
            ORDER BY g.game_date
            """,
            (player_id, eff_season),
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
            (player_id, eff_season),
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

        # Season fielding lines
        cur.execute(
            """
            SELECT season, position, games, total_chances, putouts, assists, errors,
                   passed_balls, double_plays, stolen_bases_against, caught_stealing_by,
                   catcher_interference, fielding_pct, cs_pct
            FROM summer_fielding_stats
            WHERE player_id = %s
            ORDER BY season DESC
            """,
            (player_id,),
        )
        fielding = [dict(r) for r in cur.fetchall()]

        # Pitch-level approach splits from parsed play-by-play (None if no PBP)
        approach = _compute_summer_approach(cur, player_id, eff_season)
        pitch_approach = _compute_summer_pitch_approach(cur, player_id, eff_season)

        # Savant-style percentile rankings vs league + season peers, anchored
        # to the player's effective-season line.
        bat_row = next((r for r in batting if r["season"] == eff_season), None)
        pit_row = next((r for r in pitching if r["season"] == eff_season), None)
        league_id = player["league_id"]
        batting_percentiles, pitching_percentiles = _summer_percentiles(
            cur, league_id, eff_season, bat_row, pit_row
        )

    return {
        "player": dict(player),
        "season": eff_season,
        "seasons": seasons_present,
        "batting": batting,
        "pitching": pitching,
        "fielding": fielding,
        "game_batting": game_batting,
        "game_pitching": game_pitching,
        "spring_link": dict(spring_link) if spring_link else None,
        "approach": approach,
        "pitch_approach": pitch_approach,
        "batting_percentiles": batting_percentiles,
        "pitching_percentiles": pitching_percentiles,
    }


# ── /summer/standings ──────────────────────────────────────────────

@router.get("/summer/standings")
@cached_endpoint(ttl_seconds=600)
def summer_standings(
    league: str = Query(DEFAULT_LEAGUE),
    season: int = Query(CURRENT_SEASON),
):
    """W/L per team plus last-10 record + current win/loss streak."""
    with get_connection() as conn:
        cur = conn.cursor()
        league_id = _league_id_for(cur, league)
        # Pull every final game with a per-team result tag, sorted by
        # date desc per team so we can compute L10 + streak in Python.
        cur.execute(
            """
            WITH finals AS (
              SELECT id, game_date, away_team_id, home_team_id,
                     away_score, home_score
              FROM summer_games
              WHERE league_id = %s AND season = %s
                AND status = 'final'
                AND away_score IS NOT NULL AND home_score IS NOT NULL
                AND away_team_id IS NOT NULL AND home_team_id IS NOT NULL
                AND away_team_id <> home_team_id
            )
            SELECT away_team_id AS team_id, game_date,
                   CASE WHEN away_score > home_score THEN 'W'
                        WHEN away_score < home_score THEN 'L'
                        ELSE 'T' END AS result,
                   away_score AS rs, home_score AS ra
            FROM finals
            UNION ALL
            SELECT home_team_id AS team_id, game_date,
                   CASE WHEN home_score > away_score THEN 'W'
                        WHEN home_score < away_score THEN 'L'
                        ELSE 'T' END AS result,
                   home_score AS rs, away_score AS ra
            FROM finals
            ORDER BY team_id, game_date DESC
            """,
            (league_id, season),
        )
        per_team_games = {}
        for row in cur.fetchall():
            per_team_games.setdefault(row["team_id"], []).append(row)

        # Teams metadata
        cur.execute(
            """
            SELECT id, name, short_name, logo_url, city, state, division
            FROM summer_teams WHERE league_id = %s AND is_active = TRUE
            """,
            (league_id,),
        )
        teams = {r["id"]: dict(r) for r in cur.fetchall()}

    out = []
    for team_id, meta in teams.items():
        games = per_team_games.get(team_id, [])  # newest first
        wins = sum(1 for g in games if g["result"] == "W")
        losses = sum(1 for g in games if g["result"] == "L")
        rs = sum((g["rs"] or 0) for g in games)
        ra = sum((g["ra"] or 0) for g in games)
        pct = wins / (wins + losses) if (wins + losses) else None

        # L10: last 10 chronologically — list is newest first so take [:10]
        last10 = games[:10]
        l10_w = sum(1 for g in last10 if g["result"] == "W")
        l10_l = sum(1 for g in last10 if g["result"] == "L")

        # Streak: walk from the newest game; same letter as the most
        # recent result, count consecutive.
        streak = None
        if games:
            r0 = games[0]["result"]
            if r0 in ("W", "L"):
                n = 0
                for g in games:
                    if g["result"] == r0:
                        n += 1
                    else:
                        break
                streak = f"{r0}{n}"

        out.append({
            **meta,
            "team_id": team_id,
            "wins": wins,
            "losses": losses,
            "runs_scored": rs,
            "runs_against": ra,
            "pct": pct,
            "l10_wins": l10_w,
            "l10_losses": l10_l,
            "streak": streak,
        })

    # Order: division asc (NULLS last), wins desc, pct desc
    DIV_ORDER = {"North": 0, "South": 1, "East": 2, "West": 3}
    out.sort(key=lambda r: (
        DIV_ORDER.get(r.get("division") or "", 99),
        -(r["wins"] or 0),
        -(r["pct"] or 0),
        r["name"] or "",
    ))
    # Drop teams with zero games AND skip them from the response so
    # the standings don't show 17 0-0 rows while exhibitions are the
    # only thing played.
    return [r for r in out if (r["wins"] + r["losses"]) > 0]


# ── /summer/leaderboards/batting ───────────────────────────────────

@router.get("/summer/leaderboards/batting")
@cached_endpoint(ttl_seconds=600)
def summer_batting_leaderboard(
    league: str = Query(DEFAULT_LEAGUE),
    season: int = Query(CURRENT_SEASON),
    # Qualifying. When `qualified=True`, ignores `min_pa` and uses the
    # ratio convention: a hitter is qualified at >= 2.0 PA per team
    # game played (industry standard for summer leagues).
    qualified: bool = Query(False),
    min_pa: int = Query(20, ge=0),
    sort_by: str = Query("ops"),
    sort_dir: Optional[str] = Query(None, description="'asc' | 'desc'. Defaults to the natural direction for the stat."),
    team_id: Optional[int] = None,
    limit: int = Query(100, ge=1, le=500),
):
    # Whitelist sortable columns. Includes every stat column the
    # endpoint returns so users can click-to-sort on any of them.
    valid_sorts = {
        "games", "games_started", "plate_appearances", "at_bats", "hits",
        "doubles", "triples", "home_runs", "runs", "rbi",
        "walks", "strikeouts", "hit_by_pitch", "sacrifice_flies",
        "sacrifice_bunts", "stolen_bases", "caught_stealing",
        "intentional_walks", "grounded_into_dp",
        "batting_avg", "on_base_pct", "slugging_pct", "ops",
        "woba", "wobacon", "wrc_plus", "wraa", "wrc", "iso", "babip",
        "k_pct", "bb_pct", "offensive_war",
        # Plate-discipline rates derived from PBP (summer_game_events).
        "swing_pct", "contact_pct", "whiff_pct", "air_pull_pct",
    }
    if sort_by not in valid_sorts:
        sort_by = "ops"
    # k_pct is the only "lower-is-better" column on the batting side.
    # Other columns sort high-to-low by default. Caller may override.
    if sort_dir and sort_dir.lower() in ("asc", "desc"):
        direction = sort_dir.upper()
    else:
        direction = "ASC" if sort_by == "k_pct" else "DESC"
    # PBP-derived columns are computed aliases (not on table `b`), so the
    # ORDER BY must reference the alias directly for those.
    PBP_SORTS = {"swing_pct", "contact_pct", "whiff_pct", "air_pull_pct"}
    sort_col = sort_by if sort_by in PBP_SORTS else f"b.{sort_by}"
    with get_connection() as conn:
        cur = conn.cursor()
        league_id = _league_id_for(cur, league)
        # Build SQL + params in lockstep so order can't drift.
        # When qualified=True, JOIN to a per-team game-count and use
        # PA >= team_g * 2.0. Otherwise use the absolute min_pa cap.
        params = []
        if qualified:
            qual_join = """
                JOIN (
                  SELECT team_id, COUNT(*)::int AS team_g
                  FROM (
                    SELECT home_team_id AS team_id FROM summer_games
                    WHERE league_id = %s AND season = %s AND status = 'final'
                      AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL
                      AND home_team_id <> away_team_id
                    UNION ALL
                    SELECT away_team_id AS team_id FROM summer_games
                    WHERE league_id = %s AND season = %s AND status = 'final'
                      AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL
                      AND home_team_id <> away_team_id
                  ) x
                  GROUP BY team_id
                ) tg ON tg.team_id = b.team_id
            """
            params.extend([league_id, season, league_id, season])
            qual_filter = "AND b.plate_appearances >= tg.team_g * 2.0"
        else:
            qual_join = ""
            qual_filter = "AND b.plate_appearances >= %s"

        # Plate-discipline (PBP) aggregate joins next in SQL order, so its
        # params come before the WHERE league/season placeholders.
        params.extend([season, _PA_RESULT_TYPES])

        # WHERE league_id + season
        params.extend([league_id, season])
        # Inline min_pa AFTER the WHERE league/season placeholders so
        # the order matches the SQL.
        if not qualified:
            params.append(min_pa)

        team_clause = ""
        if team_id:
            team_clause = "AND b.team_id = %s"
            params.append(team_id)

        params.append(limit)
        cur.execute(
            f"""
            SELECT p.id   AS player_id,
                   p.first_name, p.last_name,
                   p.position, p.college, p.year_in_school,
                   t.id   AS team_id, t.name AS team_name, t.short_name AS team_short, t.logo_url,
                   b.games, b.games_started, b.plate_appearances, b.at_bats, b.hits,
                   b.doubles, b.triples, b.home_runs, b.runs, b.rbi,
                   b.walks, b.strikeouts, b.hit_by_pitch,
                   b.sacrifice_flies, b.sacrifice_bunts,
                   b.stolen_bases, b.caught_stealing, b.intentional_walks,
                   b.grounded_into_dp,
                   b.batting_avg, b.on_base_pct, b.slugging_pct, b.ops,
                   b.woba, b.wobacon, b.wrc_plus, b.wraa, b.wrc,
                   b.iso, b.babip,
                   b.k_pct, b.bb_pct, b.offensive_war,
                   -- Plate discipline from PBP. Swing = whiffs + fouls +
                   -- balls in play; contact excludes whiffs (same formula as
                   -- the per-player approach splits / percentile cohort).
                   CASE WHEN (pbp.k_p + pbp.f_p + pbp.in_play) > 0
                        THEN (pbp.k_p + pbp.f_p + pbp.in_play)::real / NULLIF(pbp.seq_total + pbp.in_play, 0)
                   END AS swing_pct,
                   CASE WHEN (pbp.k_p + pbp.f_p + pbp.in_play) > 0
                        THEN (pbp.f_p + pbp.in_play)::real / (pbp.k_p + pbp.f_p + pbp.in_play)
                   END AS contact_pct,
                   CASE WHEN (pbp.k_p + pbp.f_p + pbp.in_play) > 0
                        THEN pbp.k_p::real / (pbp.k_p + pbp.f_p + pbp.in_play)
                   END AS whiff_pct,
                   CASE WHEN pbp.bb_total_pull > 0
                        THEN pbp.air_pull_count::real / pbp.bb_total_pull
                   END AS air_pull_pct,
                   pbp.bb_total_pull,
                   pbp.pa_pbp
            FROM summer_batting_stats b
            JOIN summer_players p ON p.id = b.player_id
            JOIN summer_teams t   ON t.id = b.team_id
            {qual_join}
            LEFT JOIN (
              SELECT e.batter_player_id AS pid,
                COALESCE(SUM(LENGTH(e.pitch_sequence) - LENGTH(REPLACE(e.pitch_sequence, 'K', ''))), 0) AS k_p,
                COALESCE(SUM(LENGTH(e.pitch_sequence) - LENGTH(REPLACE(e.pitch_sequence, 'F', ''))), 0) AS f_p,
                COALESCE(SUM(LENGTH(COALESCE(e.pitch_sequence, ''))), 0) AS seq_total,
                COUNT(*) FILTER (WHERE e.was_in_play) AS in_play,
                COUNT(*) AS pa_pbp,
                -- Air-pull (same definition as spring routes.py): LD/FB to
                -- the batter's pull side. bb_type/field_zone come from
                -- derive_summer_batted_ball.py; switch/unknown handedness is
                -- excluded from both numerator and denominator.
                COUNT(*) FILTER (WHERE e.bb_type IS NOT NULL
                                   AND UPPER(sp.bats) IN ('L','R')) AS bb_total_pull,
                COUNT(*) FILTER (WHERE e.bb_type IN ('LD','FB')
                    AND ((UPPER(sp.bats) = 'R' AND e.field_zone = 'LEFT')
                      OR (UPPER(sp.bats) = 'L' AND e.field_zone = 'RIGHT'))) AS air_pull_count
              FROM summer_game_events e
              JOIN summer_games g2 ON g2.id = e.game_id
              LEFT JOIN summer_players sp ON sp.id = e.batter_player_id
              WHERE g2.season = %s AND e.result_type = ANY(%s)
                AND e.batter_player_id IS NOT NULL
              GROUP BY e.batter_player_id
            ) pbp ON pbp.pid = b.player_id
            WHERE t.league_id = %s AND b.season = %s
              {qual_filter}
              {team_clause}
            ORDER BY {sort_col} {direction} NULLS LAST
            LIMIT %s
            """,
            tuple(params),
        )
        rows = cur.fetchall()
    return [dict(r) for r in rows]


# ── /summer/leaderboards/pitching ──────────────────────────────────

# ── /summer/trends ─────────────────────────────────────────────────

@router.get("/summer/trends")
@cached_endpoint(ttl_seconds=600)
def summer_trends(
    league: str = Query(DEFAULT_LEAGUE),
    season: int = Query(CURRENT_SEASON),
    window: int = Query(5, ge=2, le=15),
    min_total_pa: int = Query(15, ge=0),
    min_recent_pa: int = Query(4, ge=0),
    limit_each: int = Query(8, ge=1, le=25),
):
    """Hot/cold movers: last-{window}-games OPS minus season OPS.
    Returns two lists (hot + cold), each sorted by absolute delta.
    """
    with get_connection() as conn:
        cur = conn.cursor()
        league_id = _league_id_for(cur, league)

        cur.execute(
            """
            WITH games_ranked AS (
              SELECT b.player_id, b.team_id, g.id AS game_id, g.game_date,
                     b.ab, b.bb, b.h, b."2b" AS d, b."3b" AS t, b.hr, b.sf, b.hbp,
                     ROW_NUMBER() OVER (PARTITION BY b.player_id ORDER BY g.game_date DESC) AS rn
              FROM summer_game_batting b
              JOIN summer_games g  ON g.id = b.game_id
              JOIN summer_teams st ON st.id = b.team_id
              WHERE st.league_id = %s AND g.season = %s AND g.status = 'final'
                AND b.player_id IS NOT NULL
            ),
            recent_agg AS (
              SELECT player_id, team_id,
                     SUM(ab) AS ab, SUM(bb) AS bb, SUM(h) AS h,
                     SUM(d) AS d, SUM(t) AS t, SUM(hr) AS hr,
                     SUM(sf) AS sf, SUM(hbp) AS hbp,
                     COUNT(*) AS games
              FROM games_ranked
              WHERE rn <= %s
              GROUP BY player_id, team_id
            ),
            season_agg AS (
              SELECT player_id, team_id,
                     SUM(ab) AS ab, SUM(bb) AS bb, SUM(h) AS h,
                     SUM(d) AS d, SUM(t) AS t, SUM(hr) AS hr,
                     SUM(sf) AS sf, SUM(hbp) AS hbp
              FROM games_ranked
              GROUP BY player_id, team_id
            )
            SELECT
              r.player_id,
              r.team_id,
              sp.first_name, sp.last_name,
              st.short_name AS team_short, st.logo_url,
              r.games AS recent_games,
              (r.ab + r.bb + r.hbp + r.sf) AS recent_pa,
              (s.ab + s.bb + s.hbp + s.sf) AS season_pa,
              CASE WHEN (r.ab + r.bb + r.hbp + r.sf) > 0
                   THEN ((r.h + r.bb + r.hbp)::real / NULLIF((r.ab + r.bb + r.hbp + r.sf),0))
                      + (CASE WHEN r.ab > 0 THEN (r.h + r.d + 2*r.t + 3*r.hr)::real / r.ab ELSE 0 END)
                   ELSE NULL END AS recent_ops,
              CASE WHEN (s.ab + s.bb + s.hbp + s.sf) > 0
                   THEN ((s.h + s.bb + s.hbp)::real / NULLIF((s.ab + s.bb + s.hbp + s.sf),0))
                      + (CASE WHEN s.ab > 0 THEN (s.h + s.d + 2*s.t + 3*s.hr)::real / s.ab ELSE 0 END)
                   ELSE NULL END AS season_ops
            FROM recent_agg r
            JOIN season_agg s ON s.player_id = r.player_id AND s.team_id = r.team_id
            JOIN summer_players sp ON sp.id = r.player_id
            JOIN summer_teams st   ON st.id = r.team_id
            WHERE (r.ab + r.bb + r.hbp + r.sf) >= %s
              AND (s.ab + s.bb + s.hbp + s.sf) >= %s
            """,
            (league_id, season, window, min_recent_pa, min_total_pa),
        )
        rows = [dict(r) for r in cur.fetchall()]

    # Compute delta in Python, split into hot/cold, sort + slice
    for r in rows:
        if r.get("recent_ops") is not None and r.get("season_ops") is not None:
            r["delta"] = r["recent_ops"] - r["season_ops"]
        else:
            r["delta"] = None
    hot  = sorted([r for r in rows if (r.get("delta") or 0) > 0.05],
                  key=lambda r: -r["delta"])[:limit_each]
    cold = sorted([r for r in rows if (r.get("delta") or 0) < -0.05],
                  key=lambda r:  r["delta"])[:limit_each]
    return {"window": window, "hot": hot, "cold": cold}


# ── /summer/leaderboards/fielding ──────────────────────────────────

@router.get("/summer/leaderboards/fielding")
@cached_endpoint(ttl_seconds=600)
def summer_fielding_leaderboard(
    league: str = Query(DEFAULT_LEAGUE),
    season: int = Query(CURRENT_SEASON),
    min_chances: int = Query(5, ge=0),
    sort_by: str = Query("fielding_pct"),
    limit: int = Query(100, ge=1, le=500),
):
    valid_sorts = {
        "fielding_pct", "total_chances", "putouts", "assists", "errors",
        "double_plays", "stolen_bases_against", "caught_stealing_by", "cs_pct",
    }
    if sort_by not in valid_sorts:
        sort_by = "fielding_pct"
    # errors DESC = more errors (worse defender) at top — flip ASC so default is "fewest errors"
    asc_sorts = {"errors"}
    direction = "ASC" if sort_by in asc_sorts else "DESC"
    with get_connection() as conn:
        cur = conn.cursor()
        league_id = _league_id_for(cur, league)
        cur.execute(
            f"""
            SELECT p.id   AS player_id,
                   p.first_name, p.last_name, p.position,
                   t.id   AS team_id, t.short_name AS team_short, t.name AS team_name, t.logo_url,
                   f.games, f.total_chances, f.putouts, f.assists, f.errors,
                   f.passed_balls, f.double_plays,
                   f.stolen_bases_against, f.caught_stealing_by,
                   f.fielding_pct, f.cs_pct
            FROM summer_fielding_stats f
            JOIN summer_players p ON p.id = f.player_id
            JOIN summer_teams t   ON t.id = f.team_id
            WHERE t.league_id = %s AND f.season = %s
              AND f.total_chances >= %s
            ORDER BY f.{sort_by} {direction} NULLS LAST, f.total_chances DESC
            LIMIT %s
            """,
            (league_id, season, min_chances, limit),
        )
        rows = cur.fetchall()
    return [dict(r) for r in rows]


# ── /summer/college-representation ─────────────────────────────────

@router.get("/summer/college-representation")
@cached_endpoint(ttl_seconds=900)
def summer_college_representation(
    league: str = Query(DEFAULT_LEAGUE),
    season: int = Query(CURRENT_SEASON),
    limit: int = Query(25, ge=1, le=100),
):
    """Top colleges by number of players currently rostered in the
    given summer league. Pulls college from summer_players (set by
    Pointstreak roster scrape) and falls back to the spring team's
    school_name via summer_player_links when summer college is blank.
    """
    with get_connection() as conn:
        cur = conn.cursor()
        league_id = _league_id_for(cur, league)
        cur.execute(
            """
            WITH active_players AS (
              SELECT DISTINCT sp.id, sp.college, sp.team_id AS summer_team_id
              FROM summer_players sp
              JOIN summer_teams t ON t.id = sp.team_id
              WHERE t.league_id = %s
                AND EXISTS (
                    SELECT 1 FROM summer_game_batting gb
                    JOIN summer_games g ON g.id = gb.game_id
                    WHERE gb.player_id = sp.id AND g.season = %s
                )
            ),
            with_spring AS (
              SELECT ap.id, ap.summer_team_id,
                     COALESCE(NULLIF(ap.college, ''),
                              ct.school_name)         AS college,
                     ct.id                            AS spring_team_id,
                     ct.short_name                    AS spring_team_short,
                     ct.logo_url                      AS spring_team_logo
              FROM active_players ap
              LEFT JOIN summer_player_links spl ON spl.summer_player_id = ap.id
              LEFT JOIN players sp ON sp.id = spl.spring_player_id
              LEFT JOIN teams ct ON ct.id = sp.team_id
            )
            SELECT
                COALESCE(college, 'Unknown')      AS college,
                spring_team_id,
                spring_team_short,
                spring_team_logo,
                COUNT(*)::int                     AS players,
                COUNT(DISTINCT summer_team_id)::int AS wcl_teams
            FROM with_spring
            GROUP BY college, spring_team_id, spring_team_short, spring_team_logo
            HAVING COALESCE(college, '') <> ''
            ORDER BY players DESC, college
            LIMIT %s
            """,
            (league_id, season, limit),
        )
        rows = cur.fetchall()
    return [dict(r) for r in rows]


# ── /summer/pnw-alumni ─────────────────────────────────────────────

@router.get("/summer/pnw-alumni")
@cached_endpoint(ttl_seconds=600)
def summer_pnw_alumni(
    league: str = Query(DEFAULT_LEAGUE),
    season: int = Query(CURRENT_SEASON),
    limit: int = Query(500, ge=1, le=1000),
):
    """Spring PNW college players currently rostered in this summer
    league, paired with their college team for cross-linking.
    """
    with get_connection() as conn:
        cur = conn.cursor()
        league_id = _league_id_for(cur, league)
        cur.execute(
            """
            SELECT
                sp.id              AS summer_player_id,
                sp.first_name      AS summer_first,
                sp.last_name       AS summer_last,
                sp.position        AS summer_position,
                st.id              AS summer_team_id,
                st.short_name      AS summer_team_short,
                st.name            AS summer_team_name,
                st.logo_url        AS summer_team_logo,
                st.division        AS summer_division,
                p.id               AS spring_player_id,
                p.first_name       AS spring_first,
                p.last_name        AS spring_last,
                p.position         AS spring_position,
                p.year_in_school   AS year,
                t.id               AS spring_team_id,
                t.short_name       AS spring_team_short,
                t.school_name      AS spring_school,
                t.logo_url         AS spring_team_logo,
                d.level            AS division_level
            FROM summer_player_links spl
            JOIN summer_players sp ON sp.id = spl.summer_player_id
            JOIN summer_teams st   ON st.id = sp.team_id
            JOIN players p         ON p.id = spl.spring_player_id
            JOIN teams t           ON t.id = p.team_id
            LEFT JOIN conferences c ON c.id = t.conference_id
            LEFT JOIN divisions d   ON d.id = c.division_id
            WHERE st.league_id = %s
              AND (
                EXISTS (
                  SELECT 1 FROM summer_game_batting gb
                  JOIN summer_games g ON g.id = gb.game_id
                  WHERE gb.player_id = sp.id AND g.season = %s
                )
                OR EXISTS (
                  SELECT 1 FROM summer_game_pitching gp
                  JOIN summer_games g ON g.id = gp.game_id
                  WHERE gp.player_id = sp.id AND g.season = %s
                )
              )
            ORDER BY t.school_name, p.last_name, p.first_name
            LIMIT %s
            """,
            (league_id, season, season, limit),
        )
        rows = cur.fetchall()
    return [dict(r) for r in rows]


@router.get("/summer/leaderboards/pitching")
@cached_endpoint(ttl_seconds=600)
def summer_pitching_leaderboard(
    league: str = Query(DEFAULT_LEAGUE),
    season: int = Query(CURRENT_SEASON),
    # Qualified pitchers = IP >= team_games * 0.75 (matches MLB
    # convention scaled to short summer seasons).
    qualified: bool = Query(False),
    min_ip: float = Query(10.0, ge=0),
    sort_by: str = Query("era"),
    sort_dir: Optional[str] = Query(None, description="'asc' | 'desc'. Defaults to the natural direction for the stat."),
    team_id: Optional[int] = None,
    limit: int = Query(100, ge=1, le=500),
):
    valid_sorts = {
        "games", "games_started", "complete_games", "shutouts",
        "wins", "losses", "saves",
        "innings_pitched", "batters_faced",
        "hits_allowed", "runs_allowed", "earned_runs",
        "home_runs_allowed", "walks", "strikeouts",
        "hit_batters", "wild_pitches",
        "era", "whip",
        "k_per_9", "bb_per_9", "h_per_9", "hr_per_9", "k_bb_ratio",
        "fip", "k_pct", "bb_pct", "babip_against", "pitching_war",
        # Pitch-level rates derived from PBP (summer_game_events).
        "whiff_pct", "csw_pct", "strike_pct", "f_strike_pct",
    }
    if sort_by not in valid_sorts:
        sort_by = "era"
    # Rate stats where lower-is-better
    asc_sorts = {"era", "whip", "bb_per_9", "fip", "bb_pct",
                 "hits_allowed", "earned_runs", "runs_allowed",
                 "h_per_9", "hr_per_9", "home_runs_allowed",
                 "losses", "babip_against", "hit_batters", "wild_pitches"}
    if sort_dir and sort_dir.lower() in ("asc", "desc"):
        direction = sort_dir.upper()
    else:
        direction = "ASC" if sort_by in asc_sorts else "DESC"
    with get_connection() as conn:
        cur = conn.cursor()
        league_id = _league_id_for(cur, league)
        # Rate stats (ERA, WHIP, FIP, K/9, …) need an innings floor to be
        # meaningful, so the "qualified" gate (IP >= team_games * 0.75) applies.
        # Counting stats (saves, wins, strikeouts, IP, …) are accumulation
        # totals — gating them on innings hides the actual leaders. The clearest
        # case is saves: a save leader is a closer who throws few innings and
        # would never "qualify", which is exactly why the saves board came up
        # empty. So for counting stats we only require a real appearance (IP>0).
        RATE_SORTS = {"era", "whip", "k_per_9", "bb_per_9", "h_per_9",
                      "hr_per_9", "k_bb_ratio", "fip", "k_pct", "bb_pct",
                      "babip_against",
                      # PBP rates are also rate stats → keep the IP qualifier.
                      "whiff_pct", "csw_pct", "strike_pct", "f_strike_pct"}
        # PBP-derived columns are computed aliases (not on table `pt`), so the
        # ORDER BY must reference the alias directly for those.
        PBP_SORTS = {"whiff_pct", "csw_pct", "strike_pct", "f_strike_pct"}
        sort_col = sort_by if sort_by in PBP_SORTS else f"pt.{sort_by}"
        # Build SQL + params in lockstep. Same pattern as batting.
        params = []
        if qualified and sort_by in RATE_SORTS:
            qual_join = """
                JOIN (
                  SELECT team_id, COUNT(*)::int AS team_g
                  FROM (
                    SELECT home_team_id AS team_id FROM summer_games
                    WHERE league_id = %s AND season = %s AND status = 'final'
                      AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL
                      AND home_team_id <> away_team_id
                    UNION ALL
                    SELECT away_team_id AS team_id FROM summer_games
                    WHERE league_id = %s AND season = %s AND status = 'final'
                      AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL
                      AND home_team_id <> away_team_id
                  ) x
                  GROUP BY team_id
                ) tg ON tg.team_id = pt.team_id
            """
            params.extend([league_id, season, league_id, season])
            qual_filter = "AND pt.innings_pitched >= tg.team_g * 0.75"
        elif qualified:
            # Counting-stat board: no innings qualifier, just real appearances.
            qual_join = ""
            qual_filter = "AND pt.innings_pitched > 0"
        else:
            qual_join = ""
            qual_filter = "AND pt.innings_pitched >= %s"

        # Pitch-level (PBP) aggregate joins next in SQL order, so its params
        # come before the WHERE league/season placeholders.
        params.extend([season, _PA_RESULT_TYPES])

        params.extend([league_id, season])
        if not qualified:
            params.append(min_ip)

        # Tiebreak by innings pitched so leaders with the same value rank by the
        # bigger sample (e.g. five pitchers tied at a 0.00 ERA → most IP first).
        tiebreak = "" if sort_by == "innings_pitched" else ", pt.innings_pitched DESC NULLS LAST"

        team_clause = ""
        if team_id:
            team_clause = "AND pt.team_id = %s"
            params.append(team_id)

        params.append(limit)
        cur.execute(
            f"""
            SELECT p.id   AS player_id,
                   p.first_name, p.last_name,
                   p.position, p.college, p.year_in_school,
                   t.id   AS team_id, t.name AS team_name, t.short_name AS team_short, t.logo_url,
                   pt.games, pt.games_started,
                   pt.complete_games, pt.shutouts,
                   pt.wins, pt.losses, pt.saves,
                   pt.innings_pitched, pt.batters_faced,
                   pt.hits_allowed, pt.runs_allowed, pt.earned_runs,
                   pt.home_runs_allowed, pt.walks, pt.strikeouts,
                   pt.hit_batters, pt.wild_pitches,
                   pt.era, pt.whip,
                   pt.k_per_9, pt.bb_per_9, pt.h_per_9, pt.hr_per_9, pt.k_bb_ratio,
                   pt.fip, pt.k_pct, pt.bb_pct, pt.babip_against, pt.pitching_war,
                   -- Pitch-level rates from PBP. Strike = called(S)+swinging(K)
                   -- +foul(F)+in play; CSW = called+swinging strikes / pitches;
                   -- whiff = swinging strikes / swings; F-Strike = first-pitch
                   -- strike rate. Same accounting as the per-player approach.
                   CASE WHEN (pbp.seq_total + pbp.in_play) > 0
                        THEN (pbp.k_p + pbp.s_p + pbp.f_p + pbp.in_play)::real / (pbp.seq_total + pbp.in_play)
                   END AS strike_pct,
                   CASE WHEN (pbp.seq_total + pbp.in_play) > 0
                        THEN (pbp.k_p + pbp.s_p)::real / (pbp.seq_total + pbp.in_play)
                   END AS csw_pct,
                   CASE WHEN (pbp.k_p + pbp.f_p + pbp.in_play) > 0
                        THEN pbp.k_p::real / (pbp.k_p + pbp.f_p + pbp.in_play)
                   END AS whiff_pct,
                   CASE WHEN pbp.tracked_pa > 0
                        THEN pbp.f1_strikes::real / pbp.tracked_pa
                   END AS f_strike_pct,
                   pbp.pa_pbp
            FROM summer_pitching_stats pt
            JOIN summer_players p ON p.id = pt.player_id
            JOIN summer_teams t   ON t.id = pt.team_id
            {qual_join}
            LEFT JOIN (
              SELECT e.pitcher_player_id AS pid,
                COALESCE(SUM(LENGTH(e.pitch_sequence) - LENGTH(REPLACE(e.pitch_sequence, 'K', ''))), 0) AS k_p,
                COALESCE(SUM(LENGTH(e.pitch_sequence) - LENGTH(REPLACE(e.pitch_sequence, 'F', ''))), 0) AS f_p,
                COALESCE(SUM(LENGTH(e.pitch_sequence) - LENGTH(REPLACE(e.pitch_sequence, 'S', ''))), 0) AS s_p,
                COALESCE(SUM(LENGTH(COALESCE(e.pitch_sequence, ''))), 0) AS seq_total,
                COUNT(*) FILTER (WHERE e.was_in_play) AS in_play,
                COUNT(*) FILTER (WHERE e.pitches_thrown >= 1) AS tracked_pa,
                COUNT(*) FILTER (
                  WHERE e.pitches_thrown >= 1
                    AND (LEFT(COALESCE(e.pitch_sequence, ''), 1) IN ('K', 'S', 'F')
                         OR (COALESCE(e.pitch_sequence, '') = '' AND e.was_in_play))
                ) AS f1_strikes,
                COUNT(*) AS pa_pbp
              FROM summer_game_events e
              JOIN summer_games g2 ON g2.id = e.game_id
              WHERE g2.season = %s AND e.result_type = ANY(%s)
                AND e.pitcher_player_id IS NOT NULL
              GROUP BY e.pitcher_player_id
            ) pbp ON pbp.pid = pt.player_id
            WHERE t.league_id = %s AND pt.season = %s
              {qual_filter}
              {team_clause}
            ORDER BY {sort_col} {direction} NULLS LAST{tiebreak}
            LIMIT %s
            """,
            tuple(params),
        )
        rows = cur.fetchall()
    return [dict(r) for r in rows]


# ════════════════════════════════════════════════════════════════
# Pitch-Level Stats — full spring-card mirror, from summer PBP
# ════════════════════════════════════════════════════════════════
#
# These two endpoints return the SAME payload shape as the spring
# /players/{id}/pitch-level-stats and /pitch-level-stats-pitcher so
# the spring PitchLevelStatsCard / PitcherPitchLevelStatsCard render
# them unchanged (the cards take an `endpoint` override).
#
# What's intentionally different from spring:
#   - No base/out/score state in summer_game_events, so
#     situational_splits is ALWAYS [] and the Leverage Index / WPA
#     fields are null (the cards hide those sections when null).
#   - Pitch accounting follows the established summer convention:
#     pitches = pitch-sequence letters + balls in play (the contacted
#     pitch isn't always logged in the sequence) — same math as the
#     summer leaderboards / approach splits, so numbers agree across
#     the site.
#   - Baselines/deciles rank against the SUMMER league cohort (same
#     league_id + season), not a college division.

import time as _spl_time

from ..stats.advanced import LinearWeights

_SUMMER_PL_BASELINES_CACHE: dict = {}          # (league_id, season) -> {ts, data}
_SUMMER_PL_PITCHER_BASELINES_CACHE: dict = {}
_SUMMER_PL_BASELINES_TTL = 6 * 3600            # seconds

_SUMMER_FINE_ZONES = ["LF", "LC", "CF", "RC", "RF",
                      "IF_3B", "IF_SS", "IF_MID", "IF_1B", "IF_C"]
_SUMMER_XBH_TYPES = {"double", "triple", "home_run"}

# Count-state filter SQL (static strings — never user input).
_SPL_HITTERS_COUNTS  = "(balls_before, strikes_before) IN ((1,0),(2,0),(3,0),(3,1))"
_SPL_NEUTRAL_COUNTS  = "(balls_before, strikes_before) IN ((0,0),(1,1),(2,1),(2,2),(3,2))"
_SPL_PITCHERS_COUNTS = "(balls_before, strikes_before) IN ((0,1),(0,2),(1,2))"
_SPL_TWO_STRIKE      = "strikes_before = 2"


def _summer_spray_for(field_zone, bats):
    """'Pull' / 'Center' / 'Oppo' / None — same rules as the spring
    classify_batted_ball.spray_for (R pulls LEFT, L pulls RIGHT,
    switch/unknown handedness -> None)."""
    if not field_zone or not bats:
        return None
    b = bats.upper()
    if b == "S":
        return None
    if field_zone == "CENTER":
        return "Center"
    if b == "R":
        return "Pull" if field_zone == "LEFT" else "Oppo"
    if b == "L":
        return "Pull" if field_zone == "RIGHT" else "Oppo"
    return None


def _spl_quantile(sorted_vals, q):
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


_SPL_DECILES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]


def _spl_decile_thresholds(metrics):
    out = {}
    for m, vals in metrics.items():
        if not vals:
            out[m] = None
            continue
        vs = sorted(vals)
        out[m] = [_spl_quantile(vs, q) for q in _SPL_DECILES]
    return out


def _summer_pl_weights(cur, league_id, season):
    """Linear weights for summer wOBA/wRC+. Coefficients match
    compute_summer_advanced.py (D2-level baseline); woba_scale and
    runs_per_pa come from summer_league_averages when present."""
    cur.execute(
        """SELECT woba_scale, runs_per_pa FROM summer_league_averages
           WHERE league_id = %s AND season = %s""",
        (league_id, season),
    )
    row = cur.fetchone()
    woba_scale = float(row["woba_scale"]) if row and row.get("woba_scale") else 1.22
    runs_per_pa = float(row["runs_per_pa"]) if row and row.get("runs_per_pa") else 0.13
    return LinearWeights(
        w_bb=0.69, w_hbp=0.72, w_1b=0.89, w_2b=1.25, w_3b=1.58, w_hr=2.02,
        woba_scale=woba_scale, runs_per_pa=runs_per_pa, runs_per_win=9.5,
    )


# ── Shared SQL fragments ────────────────────────────────────────────
# Aggregate columns reused by the player rows, league means, and
# per-player decile queries (hitter side). `p` is the batter row from
# summer_players (for bats); only the baseline queries join it, so the
# air-pull columns live in a separate fragment.

_SPL_HIT_AGG = """
    COUNT(*) AS pa,
    COUNT(*) FILTER (WHERE pitches_thrown >= 1) AS tracked_pa,
    COALESCE(SUM(LENGTH(COALESCE(pitch_sequence, ''))), 0) AS seq_total,
    COUNT(*) FILTER (WHERE was_in_play) AS bip,
    COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown >= 1) AS in_play_tr,
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
    COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'S', ''))), 0) AS f_s,
    COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS f_f,
    COUNT(*) FILTER (
        WHERE pitches_thrown >= 1 AND
              (LEFT(COALESCE(pitch_sequence, ''), 1) IN ('K', 'F')
               OR (COALESCE(pitch_sequence, '') = '' AND was_in_play))
    ) AS f1_swings,
    COUNT(*) FILTER (
        WHERE pitches_thrown >= 1 AND
              (LEFT(COALESCE(pitch_sequence, ''), 1) IN ('K', 'S', 'F')
               OR (COALESCE(pitch_sequence, '') = '' AND was_in_play))
    ) AS f1_strikes,
    COUNT(*) FILTER (
        WHERE pitches_thrown >= 1
              AND COALESCE(pitch_sequence, '') = '' AND was_in_play
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
    COUNT(*) FILTER (WHERE bb_type IS NOT NULL) AS bb_total
"""

_SPL_AIRPULL_AGG = """,
    COUNT(*) FILTER (
        WHERE bb_type IN ('LD','FB')
          AND ((UPPER(p.bats) = 'R' AND field_zone = 'LEFT')
            OR (UPPER(p.bats) = 'L' AND field_zone = 'RIGHT'))
    ) AS air_pull_n,
    COUNT(*) FILTER (
        WHERE bb_type IS NOT NULL
          AND UPPER(p.bats) IN ('L','R')
    ) AS air_denom_n
"""

# "On or Out in 3" (pitcher efficiency): PAs ending in 1-3 pitches with
# a hit-or-out outcome; walks/IBB/HBP excluded.
_SPL_ON_OR_OUT_3 = """,
    COUNT(*) FILTER (
        WHERE pitches_thrown BETWEEN 1 AND 3
          AND result_type NOT IN ('walk','intentional_walk','hbp')
    ) AS on_or_out_3
"""


def _spl_slash_from_row(row, weights):
    """Common slash-line math from an aggregate row (hitter POV keys)."""
    n_pa = row["pa"] or 0
    ab = row["ab"] or 0; h = row["h"] or 0
    d2 = row["d2"] or 0; d3 = row["d3"] or 0; hr = row["hr"] or 0
    ubb = row["ubb"] or 0; bb = row["bb"] or 0
    hbp = row["hbp"] or 0; sf = row["sf"] or 0; kct = row["k"] or 0
    singles = h - d2 - d3 - hr
    tb = singles + 2 * d2 + 3 * d3 + 4 * hr
    obp_denom = ab + bb + hbp + sf
    ba = (h / ab) if ab > 0 else None
    obp = ((h + bb + hbp) / obp_denom) if obp_denom > 0 else None
    slg = (tb / ab) if ab > 0 else None
    ops = ((obp or 0) + (slg or 0)) if (obp is not None and slg is not None) else None
    iso = ((slg - ba) if (slg is not None and ba is not None) else None)
    woba_num = (weights.w_bb * ubb + weights.w_hbp * hbp +
                weights.w_1b * singles + weights.w_2b * d2 +
                weights.w_3b * d3 + weights.w_hr * hr)
    woba_denom = ab + ubb + sf + hbp
    woba = (woba_num / woba_denom) if woba_denom > 0 else None
    return {
        "pa": n_pa, "ab": ab, "h": h, "hr": hr, "bb": bb, "k": kct,
        "ba": ba, "obp": obp, "slg": slg, "ops": ops, "iso": iso, "woba": woba,
        "k_pct": (kct / n_pa) if n_pa > 0 else None,
        "bb_pct": (bb / n_pa) if n_pa > 0 else None,
    }


def _spl_pitch_counts(row):
    """Summer pitch accounting: pitches = sequence letters + tracked BIP."""
    f_k = row["f_k"] or 0
    f_s = row["f_s"] or 0
    f_f = row["f_f"] or 0
    in_play = row["in_play_tr"] or 0
    pitches = (row["seq_total"] or 0) + in_play
    swings = f_k + f_f + in_play
    strikes = f_k + f_s + f_f + in_play
    return pitches, swings, strikes, f_k, f_s


# ── League baselines + deciles (hitter) ─────────────────────────────

def _spl_hitter_metrics_from_row(r, weights, league_woba=None):
    """Per-player metric dict for the decile distribution. Returns only
    metrics whose sample floor is met (mirrors the spring gating)."""
    out = {}
    slash = _spl_slash_from_row(r, weights)
    pa = r["pa"] or 0
    tracked = r["tracked_pa"] or 0
    pitches, swings, _strikes, f_k, _f_s = _spl_pitch_counts(r)
    if (r["ab"] or 0) > 0:
        out["ba"] = slash["ba"]; out["slg"] = slash["slg"]; out["iso"] = slash["iso"]
    if slash["obp"] is not None:
        out["obp"] = slash["obp"]
        if slash["ops"] is not None:
            out["ops"] = slash["ops"]
    if slash["woba"] is not None:
        out["woba"] = slash["woba"]
        if league_woba is not None and weights.woba_scale > 0 and weights.runs_per_pa > 0:
            out["wrc_plus"] = (((slash["woba"] - league_woba) / weights.woba_scale
                               + weights.runs_per_pa) / weights.runs_per_pa * 100)
    if pa > 0:
        out["k_pct"] = slash["k_pct"]
        out["bb_pct"] = slash["bb_pct"]
    if tracked > 0:
        out["first_pitch_swing_pct"] = (r["f1_swings"] or 0) / tracked
        out["first_pitch_strike_pct"] = (r["f1_strikes"] or 0) / tracked
        out["first_pitch_in_play_pct"] = (r["f1_in_play"] or 0) / tracked
        if pitches > 0:
            out["pitches_per_pa"] = pitches / tracked
    if pitches > 0:
        out["swing_pct"] = swings / pitches
    if swings > 0:
        out["contact_pct"] = (swings - f_k) / swings
        out["whiff_pct"] = f_k / swings
    ts_pa = r["two_strike_pa"] or 0
    if ts_pa >= 5:
        out["putaway_pct"] = (r["two_strike_k"] or 0) / ts_pa
    bb_total = r["bb_total"] or 0
    if bb_total >= 5:
        out["gb_pct"] = (r["gb_n"] or 0) / bb_total
        out["fb_pct"] = (r["fb_n"] or 0) / bb_total
        out["ld_pct"] = (r["ld_n"] or 0) / bb_total
        out["pu_pct"] = (r["pu_n"] or 0) / bb_total
    air_denom = r["air_denom_n"] or 0
    if air_denom >= 5:
        out["air_pull_pct"] = (r["air_pull_n"] or 0) / air_denom
    return out


_SPL_HITTER_METRIC_KEYS = (
    'ba', 'obp', 'slg', 'ops', 'iso', 'woba', 'wrc_plus', 'k_pct', 'bb_pct',
    'swing_pct', 'contact_pct', 'whiff_pct',
    'first_pitch_swing_pct', 'first_pitch_strike_pct', 'first_pitch_in_play_pct',
    'putaway_pct', 'pitches_per_pa',
    'gb_pct', 'fb_pct', 'ld_pct', 'pu_pct', 'air_pull_pct',
)


def _compute_summer_pl_baseline(cur, league_id, season, filter_sql, weights):
    """League-wide hitter means under a filter (summer cohort)."""
    cur.execute(f"""
        SELECT {_SPL_HIT_AGG} {_SPL_AIRPULL_AGG}
        FROM summer_game_events ge
        JOIN summer_games g ON g.id = ge.game_id
        JOIN summer_players p ON p.id = ge.batter_player_id
        JOIN summer_teams t ON t.id = p.team_id
        WHERE g.season = %s AND t.league_id = %s
          AND ge.result_type = ANY(%s)
          AND {filter_sql}
    """, [season, league_id, _PA_RESULT_TYPES])
    r = cur.fetchone()
    slash = _spl_slash_from_row(r, weights)
    pitches, swings, _strikes, f_k, _f_s = _spl_pitch_counts(r)
    tracked = r["tracked_pa"] or 0
    bb_total = r["bb_total"] or 0
    ts_pa = r["two_strike_pa"] or 0
    air_denom = r["air_denom_n"] or 0
    return {
        "pa": r["pa"] or 0, "tracked_pa": tracked, "pitches": pitches,
        "ba": slash["ba"], "obp": slash["obp"], "slg": slash["slg"],
        "ops": slash["ops"], "iso": slash["iso"], "woba": slash["woba"],
        "k_pct": slash["k_pct"], "bb_pct": slash["bb_pct"],
        "swing_pct": (swings / pitches) if pitches > 0 else None,
        "contact_pct": ((swings - f_k) / swings) if swings > 0 else None,
        "whiff_pct": (f_k / swings) if swings > 0 else None,
        "first_pitch_swing_pct":   ((r["f1_swings"] or 0) / tracked) if tracked > 0 else None,
        "first_pitch_strike_pct":  ((r["f1_strikes"] or 0) / tracked) if tracked > 0 else None,
        "first_pitch_in_play_pct": ((r["f1_in_play"] or 0) / tracked) if tracked > 0 else None,
        "putaway_pct": ((r["two_strike_k"] or 0) / ts_pa) if ts_pa > 0 else None,
        "pitches_per_pa": (pitches / tracked) if tracked > 0 else None,
        "gb_pct": ((r["gb_n"] or 0) / bb_total) if bb_total > 0 else None,
        "fb_pct": ((r["fb_n"] or 0) / bb_total) if bb_total > 0 else None,
        "ld_pct": ((r["ld_n"] or 0) / bb_total) if bb_total > 0 else None,
        "pu_pct": ((r["pu_n"] or 0) / bb_total) if bb_total > 0 else None,
        "air_pull_pct": ((r["air_pull_n"] or 0) / air_denom) if air_denom > 0 else None,
    }


def _compute_summer_pl_deciles(cur, league_id, season, filter_sql, weights, league_woba=None):
    """Per-metric decile thresholds across qualifying hitters (>= 5 PA
    in the filter) in the summer league cohort."""
    cur.execute(f"""
        SELECT ge.batter_player_id AS pid, {_SPL_HIT_AGG} {_SPL_AIRPULL_AGG}
        FROM summer_game_events ge
        JOIN summer_games g ON g.id = ge.game_id
        JOIN summer_players p ON p.id = ge.batter_player_id
        JOIN summer_teams t ON t.id = p.team_id
        WHERE g.season = %s AND t.league_id = %s
          AND ge.result_type = ANY(%s)
          AND {filter_sql}
        GROUP BY ge.batter_player_id
        HAVING COUNT(*) >= 5
    """, [season, league_id, _PA_RESULT_TYPES])
    rows = cur.fetchall()
    if not rows:
        return {}
    metrics = {k: [] for k in _SPL_HITTER_METRIC_KEYS}
    for r in rows:
        for k, v in _spl_hitter_metrics_from_row(r, weights, league_woba).items():
            if v is not None:
                metrics[k].append(v)
    return _spl_decile_thresholds(metrics)


def _get_summer_pl_baselines(cur, league_id, season, weights):
    """Cached league baselines for every filter the hitter card colors
    against (count states + L/R splits — no situational filters, since
    summer events carry no base/out/score state)."""
    key = (league_id, season)
    now = _spl_time.time()
    cached = _SUMMER_PL_BASELINES_CACHE.get(key)
    if cached and (now - cached["ts"]) < _SUMMER_PL_BASELINES_TTL:
        return cached["data"]
    filters = {
        "overall":    "TRUE",
        "hitters":    _SPL_HITTERS_COUNTS,
        "neutral":    _SPL_NEUTRAL_COUNTS,
        "pitchers":   _SPL_PITCHERS_COUNTS,
        "two_strike": _SPL_TWO_STRIKE,
        "vs_lhp":     "ge.pitcher_player_id IN (SELECT id FROM summer_players WHERE UPPER(throws) = 'L')",
        "vs_rhp":     "ge.pitcher_player_id IN (SELECT id FROM summer_players WHERE UPPER(throws) = 'R')",
    }
    out = {}
    for k, fsql in filters.items():
        mean = _compute_summer_pl_baseline(cur, league_id, season, fsql, weights)
        mean["wrc_plus"] = 100 if mean.get("woba") is not None else None
        deciles = _compute_summer_pl_deciles(
            cur, league_id, season, fsql, weights, league_woba=mean.get("woba"))
        out[k] = {"mean": mean, "deciles": deciles}
    _SUMMER_PL_BASELINES_CACHE[key] = {"ts": now, "data": out}
    return out


# ── League baselines + deciles (pitcher) ────────────────────────────

_SPL_PITCHER_METRIC_KEYS = (
    'opp_ba', 'opp_obp', 'opp_slg', 'opp_ops', 'opp_iso', 'opp_woba',
    'wrc_plus_against', 'k_pct', 'bb_pct',
    'strike_pct', 'called_strike_pct', 'whiff_pct',
    'first_pitch_strike_pct', 'putaway_pct', 'pitches_per_pa',
    'on_or_out_3_pct',
    'gb_pct', 'fb_pct', 'ld_pct', 'pu_pct', 'hr_pa_pct', 'opp_air_pull_pct',
)


def _spl_pitcher_metrics_from_row(r, weights, league_woba=None):
    out = {}
    slash = _spl_slash_from_row(r, weights)
    pa = r["pa"] or 0
    tracked = r["tracked_pa"] or 0
    pitches, swings, strikes, f_k, f_s = _spl_pitch_counts(r)
    if (r["ab"] or 0) > 0:
        out["opp_ba"] = slash["ba"]; out["opp_slg"] = slash["slg"]; out["opp_iso"] = slash["iso"]
    if slash["obp"] is not None:
        out["opp_obp"] = slash["obp"]
        if slash["ops"] is not None:
            out["opp_ops"] = slash["ops"]
    if slash["woba"] is not None:
        out["opp_woba"] = slash["woba"]
        if league_woba is not None and weights.woba_scale > 0 and weights.runs_per_pa > 0:
            out["wrc_plus_against"] = (((slash["woba"] - league_woba) / weights.woba_scale
                                       + weights.runs_per_pa) / weights.runs_per_pa * 100)
    if pa > 0:
        out["k_pct"] = slash["k_pct"]
        out["bb_pct"] = slash["bb_pct"]
        if pa >= 10:
            out["hr_pa_pct"] = (r["hr"] or 0) / pa
    if tracked > 0:
        out["first_pitch_strike_pct"] = (r["f1_strikes"] or 0) / tracked
        if pitches > 0:
            out["pitches_per_pa"] = pitches / tracked
        if tracked >= 10:
            out["on_or_out_3_pct"] = (r["on_or_out_3"] or 0) / tracked
    if pitches > 0:
        out["strike_pct"] = strikes / pitches
        out["called_strike_pct"] = f_s / pitches
    if swings > 0:
        out["whiff_pct"] = f_k / swings
    ts_pa = r["two_strike_pa"] or 0
    if ts_pa >= 5:
        out["putaway_pct"] = (r["two_strike_k"] or 0) / ts_pa
    bb_total = r["bb_total"] or 0
    if bb_total >= 5:
        out["gb_pct"] = (r["gb_n"] or 0) / bb_total
        out["fb_pct"] = (r["fb_n"] or 0) / bb_total
        out["ld_pct"] = (r["ld_n"] or 0) / bb_total
        out["pu_pct"] = (r["pu_n"] or 0) / bb_total
        out["opp_air_pull_pct"] = (r["air_pull_n"] or 0) / bb_total
    return out


def _compute_summer_pl_pitcher_baseline(cur, league_id, season, filter_sql, weights):
    """League average pitcher metrics under a filter. Joined via the
    pitcher's summer team for league scoping; LEFT JOIN the batter for
    opponent handedness (air-pull)."""
    cur.execute(f"""
        SELECT {_SPL_HIT_AGG} {_SPL_ON_OR_OUT_3},
        COUNT(*) FILTER (
            WHERE bb_type IN ('LD','FB')
              AND ((UPPER(b.bats) = 'R' AND field_zone = 'LEFT')
                OR (UPPER(b.bats) = 'L' AND field_zone = 'RIGHT'))
        ) AS air_pull_n
        FROM summer_game_events ge
        JOIN summer_games g ON g.id = ge.game_id
        JOIN summer_players p ON p.id = ge.pitcher_player_id
        JOIN summer_teams t ON t.id = p.team_id
        LEFT JOIN summer_players b ON b.id = ge.batter_player_id
        WHERE g.season = %s AND t.league_id = %s
          AND ge.result_type = ANY(%s)
          AND {filter_sql}
    """, [season, league_id, _PA_RESULT_TYPES])
    r = cur.fetchone()
    slash = _spl_slash_from_row(r, weights)
    pitches, swings, strikes, f_k, f_s = _spl_pitch_counts(r)
    tracked = r["tracked_pa"] or 0
    bb_total = r["bb_total"] or 0
    ts_pa = r["two_strike_pa"] or 0
    n_pa = r["pa"] or 0
    return {
        "pa": n_pa, "tracked_pa": tracked, "pitches": pitches,
        "opp_ba": slash["ba"], "opp_obp": slash["obp"], "opp_slg": slash["slg"],
        "opp_ops": slash["ops"], "opp_iso": slash["iso"], "opp_woba": slash["woba"],
        "k_pct": slash["k_pct"], "bb_pct": slash["bb_pct"],
        "strike_pct": (strikes / pitches) if pitches > 0 else None,
        "called_strike_pct": (f_s / pitches) if pitches > 0 else None,
        "whiff_pct": (f_k / swings) if swings > 0 else None,
        "first_pitch_strike_pct": ((r["f1_strikes"] or 0) / tracked) if tracked > 0 else None,
        "putaway_pct": ((r["two_strike_k"] or 0) / ts_pa) if ts_pa > 0 else None,
        "pitches_per_pa": (pitches / tracked) if tracked > 0 else None,
        "on_or_out_3_pct": ((r["on_or_out_3"] or 0) / tracked) if tracked > 0 else None,
        "gb_pct": ((r["gb_n"] or 0) / bb_total) if bb_total > 0 else None,
        "fb_pct": ((r["fb_n"] or 0) / bb_total) if bb_total > 0 else None,
        "ld_pct": ((r["ld_n"] or 0) / bb_total) if bb_total > 0 else None,
        "pu_pct": ((r["pu_n"] or 0) / bb_total) if bb_total > 0 else None,
        "opp_air_pull_pct": ((r["air_pull_n"] or 0) / bb_total) if bb_total > 0 else None,
        "hr_pa_pct": ((r["hr"] or 0) / n_pa) if n_pa > 0 else None,
    }


def _compute_summer_pl_pitcher_deciles(cur, league_id, season, filter_sql, weights, league_woba=None):
    cur.execute(f"""
        SELECT ge.pitcher_player_id AS pid, {_SPL_HIT_AGG} {_SPL_ON_OR_OUT_3},
        COUNT(*) FILTER (
            WHERE bb_type IN ('LD','FB')
              AND ((UPPER(b.bats) = 'R' AND field_zone = 'LEFT')
                OR (UPPER(b.bats) = 'L' AND field_zone = 'RIGHT'))
        ) AS air_pull_n
        FROM summer_game_events ge
        JOIN summer_games g ON g.id = ge.game_id
        JOIN summer_players p ON p.id = ge.pitcher_player_id
        JOIN summer_teams t ON t.id = p.team_id
        LEFT JOIN summer_players b ON b.id = ge.batter_player_id
        WHERE g.season = %s AND t.league_id = %s
          AND ge.result_type = ANY(%s)
          AND {filter_sql}
        GROUP BY ge.pitcher_player_id
        HAVING COUNT(*) >= 5
    """, [season, league_id, _PA_RESULT_TYPES])
    rows = cur.fetchall()
    if not rows:
        return {}
    metrics = {k: [] for k in _SPL_PITCHER_METRIC_KEYS}
    for r in rows:
        for k, v in _spl_pitcher_metrics_from_row(r, weights, league_woba).items():
            if v is not None:
                metrics[k].append(v)
    return _spl_decile_thresholds(metrics)


def _get_summer_pl_pitcher_baselines(cur, league_id, season, weights):
    key = (league_id, season)
    now = _spl_time.time()
    cached = _SUMMER_PL_PITCHER_BASELINES_CACHE.get(key)
    if cached and (now - cached["ts"]) < _SUMMER_PL_BASELINES_TTL:
        return cached["data"]
    filters = {
        "overall":    "TRUE",
        "hitters":    _SPL_HITTERS_COUNTS,
        "neutral":    _SPL_NEUTRAL_COUNTS,
        "pitchers":   _SPL_PITCHERS_COUNTS,
        "two_strike": _SPL_TWO_STRIKE,
        "vs_lhb":     "ge.batter_player_id IN (SELECT id FROM summer_players WHERE UPPER(bats) = 'L')",
        "vs_rhb":     "ge.batter_player_id IN (SELECT id FROM summer_players WHERE UPPER(bats) = 'R')",
    }
    out = {}
    for k, fsql in filters.items():
        mean = _compute_summer_pl_pitcher_baseline(cur, league_id, season, fsql, weights)
        mean["wrc_plus_against"] = 100 if mean.get("opp_woba") is not None else None
        deciles = _compute_summer_pl_pitcher_deciles(
            cur, league_id, season, fsql, weights, league_woba=mean.get("opp_woba"))
        out[k] = {"mean": mean, "deciles": deciles}
    _SUMMER_PL_PITCHER_BASELINES_CACHE[key] = {"ts": now, "data": out}
    return out


def _spl_player_meta(cur, player_id):
    cur.execute(
        """
        SELECT p.bats, p.throws, t.league_id, l.abbreviation AS league_abbr
        FROM summer_players p
        JOIN summer_teams t   ON t.id = p.team_id
        JOIN summer_leagues l ON l.id = t.league_id
        WHERE p.id = %s
        """,
        (player_id,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Summer player not found")
    return row


# ── GET /summer/players/{id}/pitch-level-stats (hitter) ─────────────

@router.get("/summer/players/{player_id}/pitch-level-stats")
@cached_endpoint(ttl_seconds=600)
def summer_player_pitch_level_stats(
    player_id: int,
    season: int = Query(CURRENT_SEASON, description="Summer season year"),
):
    """Hitter pitch-level stats from summer_game_events — spring payload
    mirror (discipline / count_states / lr_splits / contact_profile /
    spray_chart). situational_splits is always [] and LI/WPA fields are
    null: summer events carry no base/out/score state."""
    with get_connection() as conn:
        cur = conn.cursor()
        meta = _spl_player_meta(cur, player_id)
        league_id = meta["league_id"]
        bats = meta["bats"]
        weights = _summer_pl_weights(cur, league_id, season)

        # ── Discipline (totals + tracked-pitch subset in one pass) ──
        cur.execute(f"""
            SELECT {_SPL_HIT_AGG}
            FROM summer_game_events ge
            JOIN summer_games g ON g.id = ge.game_id
            WHERE ge.batter_player_id = %s AND g.season = %s
              AND ge.result_type = ANY(%s)
        """, (player_id, season, _PA_RESULT_TYPES))
        r = cur.fetchone()
        total_pa = r["pa"] or 0
        tracked_pa = r["tracked_pa"] or 0
        pitches, swings, _strikes, f_k, _f_s = _spl_pitch_counts(r)
        two_strike_pa = r["two_strike_pa"] or 0
        discipline = {
            "total_pa": total_pa,
            "tracked_pa": tracked_pa,
            "pitches": pitches,
            "swings": swings,
            "whiffs": f_k,
            "swing_pct": (swings / pitches) if pitches > 0 else None,
            "whiff_pct": (f_k / swings) if swings > 0 else None,
            "contact_pct": ((swings - f_k) / swings) if swings > 0 else None,
            "first_pitch_swing_pct":   ((r["f1_swings"] or 0) / tracked_pa) if tracked_pa > 0 else None,
            "first_pitch_strike_pct":  ((r["f1_strikes"] or 0) / tracked_pa) if tracked_pa > 0 else None,
            "first_pitch_in_play_pct": ((r["f1_in_play"] or 0) / tracked_pa) if tracked_pa > 0 else None,
            "two_strike_pa": two_strike_pa,
            "putaway_pct": ((r["two_strike_k"] or 0) / two_strike_pa) if two_strike_pa > 0 else None,
            "pitches_per_pa": (pitches / tracked_pa) if tracked_pa > 0 else None,
            # No base/out/score state in summer PBP → no LI / WPA.
            "avg_li": None, "li_pa": 0, "max_li": None,
            "total_wpa": None, "wpa_pa": 0, "peak_wpa": None, "mean_abs_wpa": None,
        }

        # ── Contact profile (bb_type) + spray (Pull/Center/Oppo) ──
        cur.execute("""
            SELECT bb_type, field_zone, COUNT(*) AS c
            FROM summer_game_events ge
            JOIN summer_games g ON g.id = ge.game_id
            WHERE ge.batter_player_id = %s AND g.season = %s
              AND (bb_type IS NOT NULL OR field_zone IS NOT NULL)
            GROUP BY bb_type, field_zone
        """, (player_id, season))
        bb_counts = {"GB": 0, "FB": 0, "LD": 0, "PU": 0}
        zone_counts = {"LEFT": 0, "CENTER": 0, "RIGHT": 0}
        spray_counts = {"Pull": 0, "Center": 0, "Oppo": 0}
        bb_total = zone_total = air_pull = 0
        for row in cur.fetchall():
            n = row["c"]
            if row["bb_type"]:
                bb_counts[row["bb_type"]] = bb_counts.get(row["bb_type"], 0) + n
                bb_total += n
            if row["field_zone"]:
                zone_counts[row["field_zone"]] = zone_counts.get(row["field_zone"], 0) + n
                zone_total += n
                spray = _summer_spray_for(row["field_zone"], bats)
                if spray:
                    spray_counts[spray] = spray_counts.get(spray, 0) + n
                if row["bb_type"] in ("LD", "FB") and spray == "Pull":
                    air_pull += n
        air_denom = bb_total if bats and bats.upper() in ("L", "R") else 0
        spray_total = sum(spray_counts.values())
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

        # ── Zoned spray chart (fine zones × pitcher hand × xbh/hr) ──
        cur.execute("""
            SELECT field_zone_fine,
                   CASE
                     WHEN UPPER(sp.throws) = 'L' THEN 'LHP'
                     WHEN UPPER(sp.throws) = 'R' THEN 'RHP'
                     ELSE 'UNK'
                   END AS pitcher_hand,
                   result_type,
                   COUNT(*) AS c
            FROM summer_game_events ge
            JOIN summer_games g ON g.id = ge.game_id
            LEFT JOIN summer_players sp ON sp.id = ge.pitcher_player_id
            WHERE ge.batter_player_id = %s AND g.season = %s
              AND ge.field_zone_fine IS NOT NULL
            GROUP BY field_zone_fine, pitcher_hand, result_type
        """, (player_id, season))
        spray_chart = {
            "all":    {z: 0 for z in _SUMMER_FINE_ZONES},
            "vs_lhp": {z: 0 for z in _SUMMER_FINE_ZONES},
            "vs_rhp": {z: 0 for z in _SUMMER_FINE_ZONES},
            "xbh":    {z: 0 for z in _SUMMER_FINE_ZONES},
            "hr":     {z: 0 for z in _SUMMER_FINE_ZONES},
        }
        for row in cur.fetchall():
            z = row["field_zone_fine"]
            if z not in spray_chart["all"]:
                continue
            n = row["c"]; rt = row["result_type"]
            spray_chart["all"][z] += n
            if row["pitcher_hand"] == "LHP":
                spray_chart["vs_lhp"][z] += n
            elif row["pitcher_hand"] == "RHP":
                spray_chart["vs_rhp"][z] += n
            if rt in _SUMMER_XBH_TYPES:
                spray_chart["xbh"][z] += n
            if rt == "home_run":
                spray_chart["hr"][z] += n
        for k in ("all", "vs_lhp", "vs_rhp", "xbh", "hr"):
            spray_chart[f"{k}_total"] = sum(spray_chart[k].values())

        # ── Count-state / split slash rows ──
        def _slash(filter_sql):
            cur.execute(f"""
                SELECT {_SPL_HIT_AGG}
                FROM summer_game_events ge
                JOIN summer_games g ON g.id = ge.game_id
                WHERE ge.batter_player_id = %s AND g.season = %s
                  AND ge.result_type = ANY(%s)
                  AND {filter_sql}
            """, (player_id, season, _PA_RESULT_TYPES))
            row = cur.fetchone()
            slash = _spl_slash_from_row(row, weights)
            n_pitches, n_swings, _str, kk, _ss = _spl_pitch_counts(row)
            slash.update({
                "pitches": n_pitches,
                "bip": row["bip"] or 0,
                "swing_pct": (n_swings / n_pitches) if n_pitches > 0 else None,
                "contact_pct": ((n_swings - kk) / n_swings) if n_swings > 0 else None,
                "whiff_pct": (kk / n_swings) if n_swings > 0 else None,
                "wrc_plus": None,
            })
            return slash

        count_states = [
            {"label": "Hitter's counts", "detail": "1-0, 2-0, 3-0, 3-1",
             "filter_key": "hitters", **_slash(_SPL_HITTERS_COUNTS)},
            {"label": "Neutral counts", "detail": "0-0, 1-1, 2-1, 2-2, 3-2",
             "filter_key": "neutral", **_slash(_SPL_NEUTRAL_COUNTS)},
            {"label": "Pitcher's counts", "detail": "0-1, 0-2, 1-2",
             "filter_key": "pitchers", **_slash(_SPL_PITCHERS_COUNTS)},
            {"label": "2-strike", "detail": "any 2-strike count",
             "filter_key": "two_strike", **_slash(_SPL_TWO_STRIKE)},
        ]

        lr_splits = [
            {"label": "vs LHP", "filter_key": "vs_lhp",
             **_slash("ge.pitcher_player_id IN (SELECT id FROM summer_players WHERE UPPER(throws) = 'L')")},
            {"label": "vs RHP", "filter_key": "vs_rhp",
             **_slash("ge.pitcher_player_id IN (SELECT id FROM summer_players WHERE UPPER(throws) = 'R')")},
            {"label": "vs Unknown", "filter_key": None,
             **_slash("(ge.pitcher_player_id IS NULL OR ge.pitcher_player_id IN "
                      "(SELECT id FROM summer_players WHERE throws IS NULL))")},
        ]

        # No base/out/score state in summer PBP → no situational rows.
        situational_splits = []

        # ── Attach league baselines + deciles + wRC+ (vs overall wOBA) ──
        baselines = _get_summer_pl_baselines(cur, league_id, season, weights)
        overall_entry = baselines.get("overall") or {}
        overall_league_woba = (overall_entry.get("mean") or {}).get("woba")
        for row in count_states + lr_splits:
            fk = row.get("filter_key")
            entry = baselines.get(fk) if fk else None
            row["league"] = entry["mean"] if entry else None
            row["deciles"] = entry["deciles"] if entry else None
            if (row.get("woba") is not None and overall_league_woba is not None
                    and weights.woba_scale > 0 and weights.runs_per_pa > 0):
                row["wrc_plus"] = round(
                    ((row["woba"] - overall_league_woba) / weights.woba_scale
                     + weights.runs_per_pa) / weights.runs_per_pa * 100
                )
            else:
                row["wrc_plus"] = None
        discipline["league"] = overall_entry.get("mean")
        discipline["deciles"] = overall_entry.get("deciles")

        return {
            "player_id": player_id,
            "season": season,
            "division_level": meta["league_abbr"],
            "discipline": discipline,
            "count_states": count_states,
            "lr_splits": lr_splits,
            "situational_splits": situational_splits,
            "contact_profile": contact_profile,
            "spray_chart": spray_chart,
        }


# ── GET /summer/players/{id}/pitch-level-stats-pitcher ──────────────

@router.get("/summer/players/{player_id}/pitch-level-stats-pitcher")
@cached_endpoint(ttl_seconds=600)
def summer_player_pitch_level_stats_pitcher(
    player_id: int,
    season: int = Query(CURRENT_SEASON, description="Summer season year"),
):
    """Pitcher pitch-level stats from summer_game_events — spring payload
    mirror (discipline / count_states / lr_splits / opp_contact_profile /
    opp_spray_chart). situational_splits is always [] and LI/WPA fields
    are null: summer events carry no base/out/score state."""
    with get_connection() as conn:
        cur = conn.cursor()
        meta = _spl_player_meta(cur, player_id)
        league_id = meta["league_id"]
        weights = _summer_pl_weights(cur, league_id, season)

        # ── Discipline ──
        cur.execute(f"""
            SELECT {_SPL_HIT_AGG} {_SPL_ON_OR_OUT_3}
            FROM summer_game_events ge
            JOIN summer_games g ON g.id = ge.game_id
            WHERE ge.pitcher_player_id = %s AND g.season = %s
              AND ge.result_type = ANY(%s)
        """, (player_id, season, _PA_RESULT_TYPES))
        r = cur.fetchone()
        total_pa = r["pa"] or 0
        tracked_pa = r["tracked_pa"] or 0
        pitches, swings, strikes, f_k, f_s = _spl_pitch_counts(r)
        two_strike_pa = r["two_strike_pa"] or 0
        discipline = {
            "total_pa": total_pa,
            "tracked_pa": tracked_pa,
            "pitches": pitches,
            "swings": swings,
            "whiffs": f_k,
            "strike_pct": (strikes / pitches) if pitches > 0 else None,
            "called_strike_pct": (f_s / pitches) if pitches > 0 else None,
            "whiff_pct": (f_k / swings) if swings > 0 else None,
            "first_pitch_strike_pct": ((r["f1_strikes"] or 0) / tracked_pa) if tracked_pa > 0 else None,
            "two_strike_pa": two_strike_pa,
            "putaway_pct": ((r["two_strike_k"] or 0) / two_strike_pa) if two_strike_pa > 0 else None,
            "pitches_per_pa": (pitches / tracked_pa) if tracked_pa > 0 else None,
            "on_or_out_3": r["on_or_out_3"] or 0,
            "on_or_out_3_pct": ((r["on_or_out_3"] or 0) / tracked_pa) if tracked_pa > 0 else None,
            # No base/out/score state in summer PBP → no LI / WPA.
            "avg_li": None, "li_pa": 0, "max_li": None,
            "total_wpa": None, "wpa_pa": 0, "peak_wpa": None, "mean_abs_wpa": None,
        }

        # ── Opponent contact profile (induced bb_type) ──
        cur.execute("""
            SELECT bb_type, COUNT(*) AS c
            FROM summer_game_events ge
            JOIN summer_games g ON g.id = ge.game_id
            WHERE ge.pitcher_player_id = %s AND g.season = %s
              AND bb_type IS NOT NULL
            GROUP BY bb_type
        """, (player_id, season))
        bb_counts = {"GB": 0, "FB": 0, "LD": 0, "PU": 0}
        for row in cur.fetchall():
            bb_counts[row["bb_type"]] = bb_counts.get(row["bb_type"], 0) + row["c"]
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

        # ── Opponent spray chart (fine zones × batter hand × xbh/hr) ──
        cur.execute("""
            SELECT field_zone_fine,
                   CASE
                     WHEN UPPER(sb.bats) = 'L' THEN 'LHB'
                     WHEN UPPER(sb.bats) = 'R' THEN 'RHB'
                     ELSE 'UNK'
                   END AS batter_hand,
                   result_type,
                   COUNT(*) AS c
            FROM summer_game_events ge
            JOIN summer_games g ON g.id = ge.game_id
            LEFT JOIN summer_players sb ON sb.id = ge.batter_player_id
            WHERE ge.pitcher_player_id = %s AND g.season = %s
              AND ge.field_zone_fine IS NOT NULL
            GROUP BY field_zone_fine, batter_hand, result_type
        """, (player_id, season))
        opp_spray_chart = {
            "all":    {z: 0 for z in _SUMMER_FINE_ZONES},
            "vs_lhb": {z: 0 for z in _SUMMER_FINE_ZONES},
            "vs_rhb": {z: 0 for z in _SUMMER_FINE_ZONES},
            "xbh":    {z: 0 for z in _SUMMER_FINE_ZONES},
            "hr":     {z: 0 for z in _SUMMER_FINE_ZONES},
        }
        for row in cur.fetchall():
            z = row["field_zone_fine"]
            if z not in opp_spray_chart["all"]:
                continue
            n = row["c"]; rt = row["result_type"]
            opp_spray_chart["all"][z] += n
            if row["batter_hand"] == "LHB":
                opp_spray_chart["vs_lhb"][z] += n
            elif row["batter_hand"] == "RHB":
                opp_spray_chart["vs_rhb"][z] += n
            if rt in _SUMMER_XBH_TYPES:
                opp_spray_chart["xbh"][z] += n
            if rt == "home_run":
                opp_spray_chart["hr"][z] += n
        for k in ("all", "vs_lhb", "vs_rhb", "xbh", "hr"):
            opp_spray_chart[f"{k}_total"] = sum(opp_spray_chart[k].values())

        # ── Count-state / split opponent slash rows ──
        def _opp_slash(filter_sql):
            cur.execute(f"""
                SELECT {_SPL_HIT_AGG}
                FROM summer_game_events ge
                JOIN summer_games g ON g.id = ge.game_id
                WHERE ge.pitcher_player_id = %s AND g.season = %s
                  AND ge.result_type = ANY(%s)
                  AND {filter_sql}
            """, (player_id, season, _PA_RESULT_TYPES))
            row = cur.fetchone()
            slash = _spl_slash_from_row(row, weights)
            n_pitches, n_swings, n_strikes, kk, _ss = _spl_pitch_counts(row)
            return {
                "pa": slash["pa"], "pitches": n_pitches, "bip": row["bip"] or 0,
                "ab": slash["ab"], "h": slash["h"], "hr": slash["hr"],
                "bb": slash["bb"], "k": slash["k"],
                "opp_ba": slash["ba"], "opp_obp": slash["obp"],
                "opp_slg": slash["slg"], "opp_ops": slash["ops"],
                "opp_iso": slash["iso"], "opp_woba": slash["woba"],
                "k_pct": slash["k_pct"], "bb_pct": slash["bb_pct"],
                "strike_pct": (n_strikes / n_pitches) if n_pitches > 0 else None,
                "whiff_pct": (kk / n_swings) if n_swings > 0 else None,
                "wrc_plus_against": None,
            }

        count_states = [
            {"label": "Hitter's counts", "detail": "1-0, 2-0, 3-0, 3-1",
             "filter_key": "hitters", **_opp_slash(_SPL_HITTERS_COUNTS)},
            {"label": "Neutral counts", "detail": "0-0, 1-1, 2-1, 2-2, 3-2",
             "filter_key": "neutral", **_opp_slash(_SPL_NEUTRAL_COUNTS)},
            {"label": "Pitcher's counts", "detail": "0-1, 0-2, 1-2",
             "filter_key": "pitchers", **_opp_slash(_SPL_PITCHERS_COUNTS)},
            {"label": "2-strike", "detail": "any 2-strike count",
             "filter_key": "two_strike", **_opp_slash(_SPL_TWO_STRIKE)},
        ]

        lr_splits = [
            {"label": "vs LHB", "filter_key": "vs_lhb",
             **_opp_slash("ge.batter_player_id IN (SELECT id FROM summer_players WHERE UPPER(bats) = 'L')")},
            {"label": "vs RHB", "filter_key": "vs_rhb",
             **_opp_slash("ge.batter_player_id IN (SELECT id FROM summer_players WHERE UPPER(bats) = 'R')")},
            {"label": "vs Unknown", "filter_key": None,
             **_opp_slash("(ge.batter_player_id IS NULL OR ge.batter_player_id IN "
                          "(SELECT id FROM summer_players WHERE bats IS NULL))")},
        ]

        situational_splits = []

        baselines = _get_summer_pl_pitcher_baselines(cur, league_id, season, weights)
        overall_entry = baselines.get("overall") or {}
        overall_league_opp_woba = (overall_entry.get("mean") or {}).get("opp_woba")
        for row in count_states + lr_splits:
            fk = row.get("filter_key")
            entry = baselines.get(fk) if fk else None
            row["league"] = entry["mean"] if entry else None
            row["deciles"] = entry["deciles"] if entry else None
            if (row.get("opp_woba") is not None and overall_league_opp_woba is not None
                    and weights.woba_scale > 0 and weights.runs_per_pa > 0):
                row["wrc_plus_against"] = round(
                    ((row["opp_woba"] - overall_league_opp_woba) / weights.woba_scale
                     + weights.runs_per_pa) / weights.runs_per_pa * 100
                )
            else:
                row["wrc_plus_against"] = None
        discipline["league"] = overall_entry.get("mean")
        discipline["deciles"] = overall_entry.get("deciles")

        return {
            "player_id": player_id,
            "season": season,
            "division_level": meta["league_abbr"],
            "discipline": discipline,
            "count_states": count_states,
            "lr_splits": lr_splits,
            "situational_splits": situational_splits,
            "opp_contact_profile": opp_contact_profile,
            "opp_spray_chart": opp_spray_chart,
        }
