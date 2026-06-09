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

        win_prob = _summer_win_prob(cur, dict(game))

    return {
        "game": dict(game),
        "batting": batting,
        "pitching": pitching,
        "win_prob": win_prob,
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
            eff_season = season if season is not None else 2026

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
    season: int = Query(2026),
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
    season: int = Query(2026),
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
        "woba", "wrc_plus", "wraa", "wrc", "iso", "babip",
        "k_pct", "bb_pct", "offensive_war",
        # Plate-discipline rates derived from PBP (summer_game_events).
        "swing_pct", "contact_pct", "whiff_pct",
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
    PBP_SORTS = {"swing_pct", "contact_pct", "whiff_pct"}
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
                   b.woba, b.wrc_plus, b.wraa, b.wrc,
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
                COUNT(*) AS pa_pbp
              FROM summer_game_events e
              JOIN summer_games g2 ON g2.id = e.game_id
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
    season: int = Query(2026),
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
    season: int = Query(2026),
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
    season: int = Query(2026),
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
    season: int = Query(2026),
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
    season: int = Query(2026),
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
