"""
Top moments, historic matchups, lineup helper, portal sheets, commitments, pro alumni.

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
from ..stats.ppi import compute_ppi_for_division
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

from .routes import ip_to_outs, outs_to_ip
from .all_conference import _get_league_constants

router = APIRouter()

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
@cached_endpoint(ttl_seconds=1800)  # WPA + game_events audit (multi-second) — cache hard
def top_moments(
    season: int = Query(CURRENT_SEASON, description="Season year"),
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

        # ── Top single-PA WPA moments (HITTER + PITCHER lists) ──
        # We surface BOTH perspectives:
        #   - Hitter moments: ORDER BY wpa_batter DESC — big swings,
        #     walk-off hits, lead-changing HRs.
        #   - Pitcher moments: ORDER BY wpa_pitcher DESC — escape-
        #     the-jam strikeouts, inning-ending outs in big spots.
        # WPA values per event satisfy wpa_batter = -wpa_pitcher, so
        # a pitcher moment's wpa_pitcher = +0.45 corresponds to the
        # batter losing -0.45 WPA on that PA. Each list shows the
        # SAME moments from a different actor's perspective.
        # Audit-clean games only — we don't want artifact walk-offs
        # from games with scorer-omitted runs.

        def _shape_moment(r, perspective: str):
            """perspective: 'batter' or 'pitcher' — controls which
            wpa column populates the headline `wpa` field."""
            home_batting = (r["half"] == "bottom")
            batter_team_id = r["home_team_id"] if home_batting else r["away_team_id"]
            pitcher_team_id = r["away_team_id"] if home_batting else r["home_team_id"]
            wpa = r["wpa_batter"] if perspective == "batter" else r["wpa_pitcher"]
            wp_before_perspective = r["wp_before"]
            wp_after_perspective = r["wp_after"]
            # WP is stored from BATTING team's perspective. For pitcher
            # cards, flip it to the pitcher's perspective (1 - WP) so
            # "WP swing 0.05 → 0.50" means "the pitcher's chance went
            # from 5% to 50%" — which is what a coach reads naturally.
            if perspective == "pitcher":
                wp_before_perspective = 1.0 - r["wp_before"] if r["wp_before"] is not None else None
                wp_after_perspective  = 1.0 - r["wp_after"]  if r["wp_after"]  is not None else None
            return {
                "id": r["id"],
                "game_id": r["game_id"],
                "game_date": r["game_date"].isoformat() if r["game_date"] else None,
                "inning": r["inning"],
                "half": r["half"],
                "perspective": perspective,
                "balls_before": r["balls_before"],
                "strikes_before": r["strikes_before"],
                "bases_before": r["bases_before"],
                "outs_before": r["outs_before"],
                "pitch_sequence": r["pitch_sequence"],
                "bat_score_before": r["bat_score_before"],
                "fld_score_before": r["fld_score_before"],
                "runs_on_play": r["runs_on_play"] or 0,
                "result_type": r["result_type"],
                "result_text": r["result_text"],
                "wpa": float(wpa) if wpa is not None else None,
                "wp_before": float(wp_before_perspective) if wp_before_perspective is not None else None,
                "wp_after":  float(wp_after_perspective)  if wp_after_perspective is not None else None,
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
            }

        moment_select = """
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
                ge.balls_before, ge.strikes_before, ge.bases_before, ge.outs_before,
                ge.pitch_sequence,
                ge.bat_score_before, ge.fld_score_before, ge.runs_on_play,
                ge.batter_player_id, ge.batter_name, ge.batting_team_id,
                ge.pitcher_player_id, ge.pitcher_name,
                ge.result_type, ge.result_text,
                ge.wpa_batter, ge.wpa_pitcher, ge.wp_before, ge.wp_after,
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
              AND ge.batter_player_id IS NOT NULL
              AND ge.pitcher_player_id IS NOT NULL
              AND ge.result_type NOT IN %s
        """

        # Hitter moments
        cur.execute(
            moment_select + " AND ge.wpa_batter IS NOT NULL ORDER BY ge.wpa_batter DESC LIMIT %s",
            (season, season, SUBEVENT_TYPES, moments_limit),
        )
        hitter_moments = [_shape_moment(r, "batter") for r in cur.fetchall()]

        # Pitcher moments
        cur.execute(
            moment_select + " AND ge.wpa_pitcher IS NOT NULL ORDER BY ge.wpa_pitcher DESC LIMIT %s",
            (season, season, SUBEVENT_TYPES, moments_limit),
        )
        pitcher_moments = [_shape_moment(r, "pitcher") for r in cur.fetchall()]

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
            "hitter_moments": hitter_moments,
            "pitcher_moments": pitcher_moments,
            "top_hitters": top_hitters,
            "top_pitchers": top_pitchers,
            "min_pa": min_pa,
        }


@router.get("/coaching/historic-matchup")
def historic_matchup(
    team_a: int = Query(..., description="First team id"),
    team_b: int = Query(..., description="Opponent team id"),
    season: int = Query(CURRENT_SEASON, description="Season year"),
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
                       outs_to_ip(SUM(ip_outs(ps.innings_pitched))) AS ip,
                       SUM(ip_outs(ps.innings_pitched))             AS ip_outs_total,
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
            # ip_outs_total is the true total outs from SQL (ip_outs(SUM)); the
            # display `ip` is baseball notation, so do NOT re-parse it here.
            outs = int(row["ip_outs_total"] or 0)
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
    season: int = Query(CURRENT_SEASON, description="Season year"),
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


# ============================================================
# Lineup Helper (Coaching & Scouting Portal)
# ============================================================

@router.get("/coaching/lineup-helper")
def lineup_helper_auto(
    team_id: int = Query(..., description="Team id to optimize lineup for"),
    season: int = Query(CURRENT_SEASON, description="Season year"),
    min_pa: int = Query(30, description="Minimum PA threshold for inclusion"),
    min_position_starts: int = Query(8, description="Min games started at a position to be eligible there"),
    half_life_weeks: float = Query(6.0, description="Recency-decay half-life in weeks"),
):
    """Auto mode: pick the optimal 9-player starting lineup vs RHP and LHP
    for the given team, with bench rankings.

    Uses time-weighted, sample-regressed split stats (see split_stats.py)
    and modern sabermetric slot weights (see lineup_engine.py)."""
    with get_connection() as conn:
        cur = conn.cursor()
        result = compute_team_lineup_helper(
            cur, team_id, season,
            min_pa=min_pa,
            min_position_starts=min_position_starts,
            half_life_weeks=half_life_weeks,
        )
        if 'error' in result and 'team' not in result:
            raise HTTPException(status_code=404, detail=result['error'])
        return result


from pydantic import BaseModel, Field


class ManualLineupAssignment(BaseModel):
    player_id: int
    position: str = Field(..., description="One of: C, 1B, 2B, 3B, SS, LF, CF, RF, DH")


class ManualLineupRequest(BaseModel):
    season: int = CURRENT_SEASON
    division_level: str = 'NAIA'
    half_life_weeks: float = 6.0
    assignments: list[ManualLineupAssignment]


@router.post("/coaching/lineup-helper/manual")
def lineup_helper_manual(req: ManualLineupRequest):
    """Manual mode: user supplies 9 (player_id, position) pairs, we order them
    optimally vs RHP and LHP."""
    if len(req.assignments) != 9:
        raise HTTPException(
            status_code=400,
            detail=f"Manual mode requires exactly 9 assignments, got {len(req.assignments)}",
        )
    valid_positions = {'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'}
    for a in req.assignments:
        if a.position not in valid_positions:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid position '{a.position}'. Must be one of {sorted(valid_positions)}",
            )

    with get_connection() as conn:
        cur = conn.cursor()
        result = compute_manual_lineup(
            cur,
            player_assignments=[a.model_dump() for a in req.assignments],
            season=req.season,
            division_level=req.division_level,
            half_life_weeks=req.half_life_weeks,
        )
        if 'error' in result:
            raise HTTPException(status_code=400, detail=result['error'])
        return result


# ── Override / swap endpoint: same response shape as auto mode ───────────────

class OverrideAssignment(BaseModel):
    player_id: int
    position: str


class LineupOverrideRequest(BaseModel):
    team_id: int
    season: int = CURRENT_SEASON
    min_pa: int = 30
    min_position_starts: int = 8
    half_life_weeks: float = 6.0
    vs_RHP: Optional[list[OverrideAssignment]] = None
    vs_LHP: Optional[list[OverrideAssignment]] = None


class BuildLineupRequest(BaseModel):
    team_id: Optional[int] = None
    season: int = CURRENT_SEASON
    division_level: Optional[str] = None
    vs_hand: Optional[str] = None  # 'R', 'L', 'unknown', or None for all three
    half_life_weeks: float = 6.0
    assignments: list[ManualLineupAssignment]


@router.get("/portal/team-scouting")
def portal_team_scouting(
    team_id: int = Query(..., description="Team to scout"),
    season: int = Query(CURRENT_SEASON, description="Season year"),
    _user: str = Depends(require_tier("coach")),
):
    """Comprehensive team scouting page data: team-level stats with conference
    percentiles, per-player breakdowns, auto-generated writeup, last-10 form."""
    with get_connection() as conn:
        cur = conn.cursor()
        result = compute_team_scouting(cur, team_id, season)
        if 'error' in result and 'team' not in result:
            raise HTTPException(status_code=404, detail=result['error'])
        return result


@router.get("/portal/bullpen-sheet/{team_id}")
def portal_bullpen_sheet(
    team_id: int,
    season: int = Query(CURRENT_SEASON, description="Season year"),
    _user: str = Depends(require_tier("coach")),
):
    """Printable Bullpen Sheet for one team — coaching tool for in-game
    bullpen decisions. Returns full pitcher roster with situational
    splits + leaderboards (best on the road, vs RHH, w/ RISP, etc.).
    """
    from .bullpen_sheet import build_bullpen_sheet
    with get_connection() as conn:
        cur = conn.cursor()
        result = build_bullpen_sheet(cur, team_id, season)
        if not result:
            raise HTTPException(status_code=404, detail=f"Team {team_id} not found")
        return result


@router.get("/commitments")
@cached_endpoint(ttl_seconds=300)
def list_commitments(
    # PUBLIC endpoint — powers the /news/commitments page that anyone
    # (signed-in or not) can view. Do NOT gate this behind require_tier();
    # commitments are a discovery/visibility feature for recruits and
    # belong on the free side of the paywall.
    season: int = Query(CURRENT_SEASON, description="Season to pull stats from"),
    level: str = Query("JUCO", description="Division level filter (default JUCO/NWAC)"),
    limit: int = Query(200, ge=1, le=500),
):
    """List committed players, newest commitment first.

    Powers the public /news/commitments page. Each row includes:
      • Player meta (name, current team, position, year, ht/wt, headshot).
      • Light current-season stats — hitting (AVG/HR/RBI/PA) and pitching
        (IP/K/ERA) — so visitors get a feel for who's committing.
      • If the school they're committing to matches a PNW team we track,
        a `committed_team` block with that team's id + logo. Otherwise
        the school is shown as plain text (no logo).
    Sorted by `updated_at DESC` so the freshest commitments rise to top.
    """
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT p.id            AS player_id,
                   p.first_name,
                   p.last_name,
                   p.position,
                   p.year_in_school,
                   p.height,
                   p.weight,
                   p.headshot_url,
                   p.committed_to,
                   p.updated_at     AS commitment_date,
                   t.id             AS team_id,
                   t.short_name     AS team_short,
                   t.name           AS team_name,
                   t.logo_url       AS team_logo,
                   c.abbreviation   AS conference_abbrev,
                   d.level          AS division_level
            FROM players p
            JOIN teams t       ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions  d  ON d.id = c.division_id
            WHERE p.is_committed = 1
              AND p.committed_to IS NOT NULL
              AND p.committed_to <> ''
              AND COALESCE(p.is_phantom, FALSE) = FALSE
              AND t.is_active = 1
              AND d.level = %s
            ORDER BY p.updated_at DESC, p.last_name ASC
            LIMIT %s
            """,
            (level, limit),
        )
        rows = [dict(r) for r in cur.fetchall()]
        if not rows:
            return {"season": season, "level": level, "count": 0, "commitments": []}

        player_ids = [r["player_id"] for r in rows]

        # ── Season stats (batting + pitching) for every committed player.
        cur.execute(
            """
            SELECT player_id, plate_appearances, at_bats, hits, home_runs,
                   rbi, stolen_bases, batting_avg, on_base_pct, slugging_pct
            FROM batting_stats
            WHERE season = %s AND player_id = ANY(%s)
              AND COALESCE(plate_appearances, 0) > 0
            """,
            (season, player_ids),
        )
        bat_by_pid = {r["player_id"]: dict(r) for r in cur.fetchall()}

        cur.execute(
            """
            SELECT player_id, innings_pitched, strikeouts, walks,
                   earned_runs, era, fip
            FROM pitching_stats
            WHERE season = %s AND player_id = ANY(%s)
              AND COALESCE(innings_pitched, 0) > 0
            """,
            (season, player_ids),
        )
        pit_by_pid = {r["player_id"]: dict(r) for r in cur.fetchall()}

        # ── School logo: try to match committed_to to a team we track.
        # Strict-then-fuzzy in one query: exact short_name match wins, then
        # short_name with periods stripped (Oregon St. -> Oregon St), then
        # school_name contains the committed_to phrase. Limit 1 by best rank.
        committed_strings = sorted({r["committed_to"] for r in rows if r["committed_to"]})
        school_lookup = {}
        for s in committed_strings:
            # Three-tier rank: exact short_name → period-stripped match →
            # full school_name contains the phrase. Match against
            # `school_name` (e.g. "Pacific Lutheran University") rather than
            # `name` (e.g. "PLU Lutes") so phrases like "Pacific Lutheran"
            # find PLU instead of accidentally matching D3 Pacific.
            cur.execute(
                """
                SELECT id, short_name, school_name, logo_url,
                       CASE
                         WHEN LOWER(short_name) = LOWER(%s)                                          THEN 1
                         WHEN LOWER(REPLACE(short_name, '.', '')) = LOWER(REPLACE(%s, '.', ''))      THEN 2
                         WHEN LOWER(school_name) ILIKE '%%' || LOWER(%s) || '%%'                     THEN 3
                         ELSE 99
                       END AS rank
                FROM teams
                WHERE is_active = 1
                  AND (
                    LOWER(short_name) = LOWER(%s)
                    OR LOWER(REPLACE(short_name, '.', '')) = LOWER(REPLACE(%s, '.', ''))
                    OR LOWER(school_name) ILIKE '%%' || LOWER(%s) || '%%'
                  )
                ORDER BY rank ASC, LENGTH(school_name) ASC
                LIMIT 1
                """,
                (s, s, s, s, s, s),
            )
            m = cur.fetchone()
            if m:
                school_lookup[s] = {
                    "team_id": m["id"],
                    "short_name": m["short_name"],
                    "school_name": m["school_name"],
                    "logo_url": m["logo_url"],
                }

        # ── Compose response rows.
        for r in rows:
            r["commitment_date"] = r["commitment_date"].isoformat() if r["commitment_date"] else None

            b = bat_by_pid.get(r["player_id"])
            p = pit_by_pid.get(r["player_id"])

            # Include batting if they have at least 30 PA OR if there's no
            # meaningful pitching to show (so two-way players still surface).
            if b and ((b["plate_appearances"] or 0) >= 30 or not p):
                avg = float(b["batting_avg"]) if b["batting_avg"] is not None else None
                r["batting"] = {
                    "pa": b["plate_appearances"], "ab": b["at_bats"],
                    "h": b["hits"], "hr": b["home_runs"], "rbi": b["rbi"],
                    "sb": b["stolen_bases"],
                    "avg": round(avg, 3) if avg is not None else None,
                }
            else:
                r["batting"] = None

            # Include pitching if they have at least 10 IP OR no batting.
            if p and ((float(p["innings_pitched"] or 0) >= 10) or not b):
                era = float(p["era"]) if p["era"] is not None else None
                r["pitching"] = {
                    "ip": float(p["innings_pitched"]) if p["innings_pitched"] is not None else None,
                    "k": p["strikeouts"], "bb": p["walks"],
                    "er": p["earned_runs"],
                    "era": round(era, 2) if era is not None else None,
                }
            else:
                r["pitching"] = None

            r["committed_team"] = school_lookup.get(r["committed_to"])  # None if not a PNW team

        return {"season": season, "level": level, "count": len(rows), "commitments": rows}


@router.get("/portal/scouting-sheet/{team_id}")
def portal_scouting_sheet(
    team_id: int,
    season: int = Query(CURRENT_SEASON, description="Season year"),
    _user: str = Depends(require_tier("coach")),
):
    """Printable per-team scouting sheet — every hitter on one page,
    every pitcher on another. Returns full roster with the 13 hitter
    stats / 11 pitcher stats and percentile ranks vs the team's
    conference cohort (used for color shading on the frontend)."""
    from .scouting_sheet import build_scouting_sheet
    with get_connection() as conn:
        cur = conn.cursor()
        result = build_scouting_sheet(cur, team_id, season)
        if not result:
            raise HTTPException(status_code=404, detail=f"Team {team_id} not found")
        return result


@router.get("/portal/nwac-tournament-sheet")
@cached_endpoint(ttl_seconds=1800)
def portal_nwac_tournament_sheet(
    season: int = Query(CURRENT_SEASON, description="Season year"),
    _user: str = Depends(require_tier("coach")),
):
    """Cross-team scouting board for the 8 NWAC Championship teams.
    Two ranked-by-WAR boards (pitchers, then hitters) pooling every
    player across the field, with bio columns (Ht/Wt/Yr/Commitment)
    and percentile shading computed within the championship field."""
    from .nwac_tournament_sheet import build_nwac_tournament_sheet
    with get_connection() as conn:
        cur = conn.cursor()
        return build_nwac_tournament_sheet(cur, season)


@router.post("/coaching/lineup-helper/build")
def lineup_helper_build(req: BuildLineupRequest):
    """Build-from-scratch mode. User picks 9 players (any positions, no
    eligibility check, no minimum PA) and we order them optimally.

    `vs_hand` accepts 'R' (vs RHP), 'L' (vs LHP), 'unknown' (uses season
    splits with no platoon adjustment), or null to compute all three.
    """
    if len(req.assignments) != 9:
        raise HTTPException(
            status_code=400,
            detail=f"Build mode requires exactly 9 assignments, got {len(req.assignments)}",
        )
    valid_positions = {'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'}
    positions = [a.position for a in req.assignments]
    if set(positions) != valid_positions:
        raise HTTPException(
            status_code=400,
            detail=f"Build mode requires each of {sorted(valid_positions)} exactly once.",
        )
    if req.vs_hand is not None and req.vs_hand not in ('R', 'L', 'unknown'):
        raise HTTPException(
            status_code=400,
            detail=f"vs_hand must be one of 'R', 'L', 'unknown', or null.",
        )

    with get_connection() as conn:
        cur = conn.cursor()
        result = compute_build_lineup(
            cur,
            team_id=req.team_id,
            season=req.season,
            assignments=[a.model_dump() for a in req.assignments],
            vs_hand=req.vs_hand,
            division_level_override=req.division_level,
            half_life_weeks=req.half_life_weeks,
        )
        if 'error' in result and 'team' not in result:
            raise HTTPException(status_code=400, detail=result['error'])
        return result


@router.post("/coaching/lineup-helper/override")
def lineup_helper_override(req: LineupOverrideRequest):
    """Re-run the engine for a team using user-specified starters for one or
    both pitcher hands. Same response shape as the GET (auto) endpoint, so the
    frontend can swap in the response wholesale."""
    valid_positions = {'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'}
    overrides = {}
    for hand_key, lineup in (('vs_RHP', req.vs_RHP), ('vs_LHP', req.vs_LHP)):
        if lineup is None:
            continue
        if len(lineup) != 9:
            raise HTTPException(
                status_code=400,
                detail=f"{hand_key} override must have exactly 9 assignments, got {len(lineup)}",
            )
        positions = [a.position for a in lineup]
        if set(positions) != valid_positions:
            raise HTTPException(
                status_code=400,
                detail=f"{hand_key} override must cover each of {sorted(valid_positions)} exactly once.",
            )
        if len(set(a.player_id for a in lineup)) != 9:
            raise HTTPException(
                status_code=400,
                detail=f"{hand_key} override has duplicate player_ids.",
            )
        overrides[hand_key] = [a.model_dump() for a in lineup]

    if not overrides:
        raise HTTPException(
            status_code=400,
            detail="At least one of vs_RHP or vs_LHP must be provided.",
        )

    with get_connection() as conn:
        cur = conn.cursor()
        result = compute_team_lineup_helper(
            cur, req.team_id, req.season,
            min_pa=req.min_pa,
            min_position_starts=req.min_position_starts,
            half_life_weeks=req.half_life_weeks,
            overrides=overrides,
        )
        if 'error' in result and 'team' not in result:
            raise HTTPException(status_code=404, detail=result['error'])
        return result


# Pro level display order (best level first). Anything unrecognized sorts last.
_PRO_LEVEL_ORDER = {"MLB": 0, "AAA": 1, "AA": 2, "A+": 3, "A": 4, "Rk": 5}


@router.get("/pro-alumni")
@cached_endpoint(ttl_seconds=3600)
def pro_alumni():
    """PNW college alumni currently in affiliated pro ball (MiLB/MLB).

    Reads the curated backend/data/pro_alumni.json (generated by
    scripts/ingest_pro_alumni.py from Nate's spreadsheet), enriches each
    college with live team metadata (name/logo), groups players by their
    college team, and computes the headline overview. Players who attended
    more than one PNW school appear under each. Players whose college
    pre-dates our coverage stay listed but unlinked (player_id is null)."""
    import json as _json
    from pathlib import Path as _Path

    path = _Path(__file__).parent.parent.parent / "data" / "pro_alumni.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Pro alumni data not available")
    with open(path) as f:
        payload = _json.load(f)
    players = payload.get("players", [])

    # Live team metadata for every referenced college.
    team_ids = sorted({tid for p in players for tid in (p.get("college_team_ids") or [])})
    teams_meta = {}
    if team_ids:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT t.id, t.short_name, t.name, t.logo_url, t.state,
                       d.level AS division_level, c.abbreviation AS conference_abbrev
                FROM teams t
                JOIN conferences c ON c.id = t.conference_id
                JOIN divisions d ON d.id = c.division_id
                WHERE t.id = ANY(%s)
            """, (team_ids,))
            for r in cur.fetchall():
                teams_meta[r["id"]] = dict(r)

    def level_rank(lvl):
        return _PRO_LEVEL_ORDER.get(lvl, 99)

    # Group players under each college they played for.
    groups = {tid: [] for tid in team_ids}
    unaffiliated = []
    for p in players:
        tids = p.get("college_team_ids") or []
        if not tids:
            unaffiliated.append(p)
        for tid in tids:
            groups.setdefault(tid, []).append(p)

    teams_out = []
    for tid, plist in groups.items():
        meta = teams_meta.get(tid)
        if not meta:
            continue
        plist_sorted = sorted(plist, key=lambda x: (level_rank(x.get("level")), x.get("name") or ""))
        teams_out.append({
            "team_id": tid,
            "short_name": meta["short_name"],
            "name": meta["name"],
            "logo_url": meta["logo_url"],
            "state": meta["state"],
            "division_level": meta["division_level"],
            "conference_abbrev": meta["conference_abbrev"],
            "count": len(plist_sorted),
            "mlb_count": sum(1 for x in plist_sorted if x.get("level") == "MLB"),
            "players": plist_sorted,
        })
    # Most pros first, then alphabetical for ties.
    teams_out.sort(key=lambda t: (-t["count"], t["short_name"]))

    # Headline overview (distinct players, so multi-college folks count once).
    level_counts = {}
    for p in players:
        lvl = p.get("level") or "—"
        level_counts[lvl] = level_counts.get(lvl, 0) + 1
    overview = {
        "total_players": len(players),
        "total_mlb": sum(1 for p in players if p.get("level") == "MLB"),
        "total_orgs": len({(p.get("affiliate") or "").strip() for p in players if p.get("affiliate")}),
        "total_colleges": len(teams_out),
        "level_counts": level_counts,
    }

    return {
        "generated_at": payload.get("generated_at"),
        "overview": overview,
        "teams": teams_out,
        "unaffiliated": unaffiliated,
    }
