"""
Pitch-level (PBP-derived) player stat cards.

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
                COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'S', ''))), 0) AS f_s,
                COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS f_f,
                COALESCE(SUM(CASE WHEN was_in_play AND pitches_thrown IS NOT NULL THEN 1 ELSE 0 END), 0) AS f_in_play,
                COALESCE(SUM(CASE WHEN LEFT(pitch_sequence, 1) IN ('S', 'F') THEN 1
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
        f_s = r["f_s"] or 0; f_f = r["f_f"] or 0; f_in_play = r["f_in_play"] or 0
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
        swings = f_s + f_f + f_in_play
        if pitches > 0:
            metrics["swing_pct"].append(swings / pitches)
        if swings > 0:
            metrics["contact_pct"].append((f_f + f_in_play) / swings)
            metrics["whiff_pct"].append(f_s / swings)
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
            -- pitches_thrown >= 1 (not just IS NOT NULL): the parser emits
            -- pitches_thrown=0 for PAs that have a "(0-0)" count notation
            -- in the source HTML but no actual pitch sequence string. Those
            -- rows can never satisfy the FPS numerator branches, so leaving
            -- them in tracked_pa silently deflates first-pitch-strike rate.
            COUNT(*) FILTER (WHERE pitches_thrown >= 1) AS tracked_pa,
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
            COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'S', ''))), 0) AS f_s,
            COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', ''))), 0) AS f_f,
            COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS f_in_play,
            -- F1 counts: tighten to pitches_thrown >= 1 (same reason as
            -- tracked_pa above — pitches_thrown=0 rows are untracked).
            COUNT(*) FILTER (
                WHERE pitches_thrown >= 1 AND
                      (LEFT(pitch_sequence, 1) IN ('S', 'F')
                       OR (pitch_sequence = '' AND was_in_play))
            ) AS f1_swings,
            COUNT(*) FILTER (
                WHERE pitches_thrown >= 1 AND
                      (LEFT(pitch_sequence, 1) IN ('K', 'S', 'F')
                       OR (pitch_sequence = '' AND was_in_play))
            ) AS f1_strikes,
            COUNT(*) FILTER (
                WHERE pitches_thrown >= 1
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
    swings = r["f_s"] + r["f_f"] + r["f_in_play"]
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
        "whiff_pct": (r["f_s"] / swings) if swings > 0 else None,
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


@router.get("/players/{player_id}/wpa-by-game")
def get_player_wpa_by_game(
    player_id: int,
    season: int = Query(CURRENT_SEASON, description="Season year"),
):
    """Per-game WPA totals + running cumulative for one player.

    Powers the rolling-WPA chart on the player profile. Returns two
    parallel series so two-way players can render both sides:

        {
          "batter":  [{game_id, date, opp, is_home, result, wpa, pa, cumulative}, ...],
          "pitcher": [{game_id, date, opp, is_home, result, wpa, bf, cumulative}, ...]
        }

    Each list is in chronological order. `cumulative` is the running
    sum of `wpa` from the start of the season through that game —
    that's what gets plotted on the y-axis. `wpa` per row is the
    per-game total (sum of wpa_batter or wpa_pitcher across all PAs
    in that game).

    Aggregates across linked players (transfers) the same way the
    rest of the player profile does.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # Resolve canonical player + linked IDs (handles transfers)
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

        def _build_series(side: str):
            """side: 'batter' or 'pitcher'. Returns chronologically-
            ordered list of per-game WPA rows with running cumulative."""
            id_col = "batter_player_id" if side == "batter" else "pitcher_player_id"
            wpa_col = "wpa_batter" if side == "batter" else "wpa_pitcher"
            count_label = "pa" if side == "batter" else "bf"

            # Per-game aggregates. Note: a player can appear in a game
            # via team_id either home or away — we don't filter by team
            # because phantoms / transfers might land on either side.
            cur.execute(f"""
                SELECT
                    g.id AS game_id,
                    g.game_date,
                    g.home_team_id, g.away_team_id,
                    g.home_score, g.away_score,
                    th.short_name AS home_short, th.logo_url AS home_logo,
                    ta.short_name AS away_short, ta.logo_url AS away_logo,
                    SUM(ge.{wpa_col})       AS wpa,
                    COUNT(ge.{wpa_col})     AS n_pa,
                    -- determine whether the player's team was home or
                    -- away from the events themselves: if the player
                    -- batted in the bottom half, his team was home.
                    BOOL_OR(
                        CASE WHEN ge.{id_col} = ANY(%s) AND ge.half =
                            CASE WHEN '{side}' = 'batter' THEN 'bottom'
                                 ELSE 'top' END
                            THEN TRUE ELSE FALSE END
                    ) AS player_team_home
                FROM game_events ge
                JOIN games g ON g.id = ge.game_id
                JOIN teams th ON th.id = g.home_team_id
                JOIN teams ta ON ta.id = g.away_team_id
                WHERE ge.{id_col} = ANY(%s)
                  AND g.season = %s
                  AND ge.{wpa_col} IS NOT NULL
                GROUP BY g.id, g.game_date, g.home_team_id, g.away_team_id,
                         g.home_score, g.away_score,
                         th.short_name, th.logo_url, ta.short_name, ta.logo_url
                ORDER BY g.game_date ASC, g.id ASC
            """, (all_pids, all_pids, season))
            rows = cur.fetchall()

            out = []
            cumulative = 0.0
            for r in rows:
                wpa = float(r["wpa"]) if r["wpa"] is not None else 0.0
                cumulative += wpa
                # Player's team won?
                player_won = None
                if r["home_score"] is not None and r["away_score"] is not None:
                    if r["player_team_home"]:
                        player_won = r["home_score"] > r["away_score"]
                    else:
                        player_won = r["away_score"] > r["home_score"]
                # Build "W 7-3" or "L 4-5" string from player's perspective
                if (r["home_score"] is None or r["away_score"] is None
                        or player_won is None):
                    result_str = None
                else:
                    if r["player_team_home"]:
                        result_str = (
                            f"{'W' if player_won else 'L'} "
                            f"{r['home_score']}-{r['away_score']}"
                        )
                    else:
                        result_str = (
                            f"{'W' if player_won else 'L'} "
                            f"{r['away_score']}-{r['home_score']}"
                        )
                # Opposing team
                if r["player_team_home"]:
                    opp_short = r["away_short"]
                    opp_logo = r["away_logo"]
                else:
                    opp_short = r["home_short"]
                    opp_logo = r["home_logo"]
                out.append({
                    "game_id": r["game_id"],
                    "date": r["game_date"].isoformat() if r["game_date"] else None,
                    "is_home": r["player_team_home"],
                    "opp_short": opp_short,
                    "opp_logo": opp_logo,
                    "result": result_str,
                    "won": player_won,
                    "wpa": round(wpa, 4),
                    count_label: int(r["n_pa"] or 0),
                    "cumulative": round(cumulative, 4),
                })
            return out

        return {
            "season": season,
            "batter": _build_series("batter"),
            "pitcher": _build_series("pitcher"),
        }


@router.get("/players/{player_id}/pitch-level-stats")
def get_player_pitch_level_stats(
    player_id: int,
    season: int = Query(CURRENT_SEASON, description="Season year"),
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
                    WHEN LEFT(pitch_sequence, 1) IN ('S', 'F') THEN 1
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
              -- pitches_thrown >= 1, not just IS NOT NULL: parser stamps
              -- pitches_thrown=0 on "(0-0)" PAs from sources that don't
              -- ship a pitch sequence string.
              AND ge.pitches_thrown >= 1
        """, (all_pids, season))
        r = cur.fetchone()
        tracked_pa = r["tracked_pa"] or 0
        pitches = r["pitches"] or 0
        s = r["s_count"]; f = r["f_count"]; in_play = r["in_play"]
        swings = s + f + in_play
        contact = f + in_play
        whiffs = s
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
                      "IF_3B", "IF_SS", "IF_MID", "IF_2B", "IF_1B", "IF_C"]
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
                    COALESCE(SUM(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'S', ''))), 0) AS f_s,
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
            swings = row["f_s"] + row["f_f"] + row["f_in_play"]
            contact = row["f_f"] + row["f_in_play"]
            swing_pct = (swings / n_pitches) if n_pitches > 0 else None
            contact_pct = (contact / swings) if swings > 0 else None
            whiff_pct = (row["f_s"] / swings) if swings > 0 else None
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
            -- pitches_thrown >= 1, not just IS NOT NULL: the parser emits
            -- pitches_thrown=0 for untracked "(0-0)" PAs from sources that
            -- don't ship a pitch sequence string. Those can never be in
            -- the FPS numerator, so they'd silently deflate that rate.
            COUNT(*) FILTER (WHERE pitches_thrown >= 1) AS tracked_pa,
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
                WHERE pitches_thrown >= 1 AND
                      (LEFT(pitch_sequence, 1) IN ('K', 'S', 'F')
                       OR (pitch_sequence = '' AND was_in_play))
            ) AS f1_strikes,
            COUNT(*) FILTER (WHERE strikes_before = 2) AS two_strike_pa,
            COUNT(*) FILTER (
                WHERE strikes_before = 2 AND result_type IN
                ('strikeout_swinging','strikeout_looking')
            ) AS two_strike_k,
            -- "On or Out in 3" — efficiency stat. PAs that ended in 1-3
            -- pitches with the batter either getting a hit or making an
            -- out (incl. K). Walks, IBBs, HBP, and catcher's interference
            -- are excluded — those are pitcher-inefficient outcomes that
            -- happened to end quickly.
            COUNT(*) FILTER (
                WHERE pitches_thrown BETWEEN 1 AND 3
                  AND result_type NOT IN
                    ('walk','intentional_walk','hbp','catcher_interference')
            ) AS on_or_out_3,
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
    swings = pS + pF + in_play
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
        "called_strike_pct": (pK / n_pitches) if n_pitches > 0 else None,
        "whiff_pct": (pS / swings) if swings > 0 else None,
        "first_pitch_strike_pct": (r["f1_strikes"] / n_tracked) if n_tracked > 0 else None,
        "putaway_pct": (r["two_strike_k"] / two_strike_pa) if two_strike_pa > 0 else None,
        "pitches_per_pa": (n_pitches / n_tracked) if n_tracked > 0 else None,
        # On/Out-in-3 league mean: tracked PAs ending in 1-3 pitches
        # with hit-or-out outcome, over all tracked PAs.
        "on_or_out_3_pct": (r["on_or_out_3"] / n_tracked) if n_tracked > 0 else None,
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
                   COUNT(*) FILTER (WHERE pitches_thrown >= 1) AS tracked_pa,
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
                   -- "On or Out in 3" — efficiency stat. PAs ending in 1-3
                   -- pitches with hit-or-out outcome (walks/HBP/CI excluded).
                   COALESCE(SUM(CASE
                       WHEN pitches_thrown BETWEEN 1 AND 3
                         AND result_type NOT IN
                           ('walk','intentional_walk','hbp','catcher_interference')
                       THEN 1 ELSE 0
                   END), 0) AS on_or_out_3,
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
                                'on_or_out_3_pct',
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
        swings = pS + pF + in_play
        strikes = pK + pS + pF + in_play
        if pitches > 0:
            metrics["strike_pct"].append(strikes / pitches)
            metrics["called_strike_pct"].append(pK / pitches)
        if swings > 0:
            metrics["whiff_pct"].append(pS / swings)
        ts_pa = r["two_strike_pa"] or 0
        if ts_pa >= 5:
            metrics["putaway_pct"].append((r["two_strike_k"] or 0) / ts_pa)
        # On/Out-in-3: denominator is tracked PAs (we can only judge a
        # PA's pitch count if pitches were tracked). Min 10 tracked PAs
        # to avoid noisy tiny samples.
        tracked_pa_row = r["tracked_pa"] or 0
        if tracked_pa_row >= 10:
            metrics["on_or_out_3_pct"].append(
                (r["on_or_out_3"] or 0) / tracked_pa_row)
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
    season: int = Query(CURRENT_SEASON, description="Season year"),
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
                END), 0) AS f1_strikes,
                -- "On or Out in 3": efficiency stat. Tracked PAs that
                -- ended in 1-3 pitches with the batter getting a hit
                -- or making an out. Walks/IBBs/HBP/CI are excluded.
                COALESCE(SUM(CASE
                    WHEN pitches_thrown BETWEEN 1 AND 3
                      AND result_type NOT IN
                        ('walk','intentional_walk','hbp','catcher_interference')
                    THEN 1 ELSE 0
                END), 0) AS on_or_out_3
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE ge.pitcher_player_id = ANY(%s) AND g.season = %s
              -- Require pitches_thrown >= 1, not just IS NOT NULL: the
              -- parser stamps pitches_thrown=0 on "(0-0)" PAs from
              -- sources that don't ship a pitch sequence string. Leaving
              -- those rows in the denominator silently deflates FPS.
              AND ge.pitches_thrown >= 1
        """, (all_pids, season))
        r = cur.fetchone()
        tracked_pa = r["tracked_pa"] or 0
        pitches = r["pitches"] or 0
        pK = r["pk"]; pS = r["ps"]; pF = r["pf"]; in_play = r["in_play"]
        swings = pS + pF + in_play
        strikes = pK + pS + pF + in_play
        discipline = {
            "total_pa": total_pa,
            "tracked_pa": tracked_pa,
            "pitches": pitches,
            "swings": swings,
            "whiffs": pS,
            "strike_pct": (strikes / pitches) if pitches > 0 else None,
            "called_strike_pct": (pK / pitches) if pitches > 0 else None,
            "whiff_pct": (pS / swings) if swings > 0 else None,
            "first_pitch_strike_pct": (r["f1_strikes"] / tracked_pa) if tracked_pa > 0 else None,
            "two_strike_pa": r["two_strike_pa"] or 0,
            "putaway_pct": (r["two_strike_k"] / r["two_strike_pa"]) if r["two_strike_pa"] > 0 else None,
            "pitches_per_pa": (pitches / tracked_pa) if tracked_pa > 0 else None,
            # On/Out-in-3: PAs that ended in 1-3 pitches with hit-or-out
            # outcome (walks/HBP excluded). Quick-decision efficiency.
            "on_or_out_3": r["on_or_out_3"] or 0,
            "on_or_out_3_pct": (r["on_or_out_3"] / tracked_pa) if tracked_pa > 0 else None,
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
                      "IF_3B", "IF_SS", "IF_MID", "IF_2B", "IF_1B", "IF_C"]
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
            swings = pS + pF + in_play
            strikes = pK + pS + pF + in_play
            return {
                "pa": n_pa, "pitches": n_pitches, "bip": row["bip"] or 0,
                "ab": ab, "h": h, "hr": hr, "bb": bb, "k": kct,
                "opp_ba": ba, "opp_obp": obp, "opp_slg": slg, "opp_ops": ops,
                "opp_iso": iso, "opp_woba": woba,
                "k_pct": (kct / n_pa) if n_pa > 0 else None,
                "bb_pct": (bb / n_pa) if n_pa > 0 else None,
                "strike_pct": (strikes / n_pitches) if n_pitches > 0 else None,
                "whiff_pct": (pS / swings) if swings > 0 else None,
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



# ═══════════════════════════════════════════════════════════════════════
# Custom-card blocks: per-player defensive alignment, times-through-the-
# order, and per-count discipline. All PBP-derived, all public (they feed
# the coach's Custom Player Card but expose nothing sensitive).
# ═══════════════════════════════════════════════════════════════════════

@router.get("/players/{player_id}/alignment")
@cached_endpoint(ttl_seconds=1800)
def get_player_alignment(
    player_id: int,
    season: int = Query(CURRENT_SEASON),
):
    """Ideal defensive alignment vs THIS hitter — fielder (angle, depth, code)
    per position + a shift summary. Reuses the Series Planner fielder model on
    the hitter's own fine spray zones. Returns {alignment: null} if too few
    batted balls to say anything."""
    from .series_planner import build_alignment_for_hitter, _ALIGN_IF, _ALIGN_OF

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT p.first_name, p.last_name, p.bats,
                   t.short_name AS team_short
            FROM players p LEFT JOIN teams t ON p.team_id = t.id
            WHERE p.id = %s
        """, (player_id,))
        prow = cur.fetchone()
        if not prow:
            raise HTTPException(status_code=404, detail="Player not found")
        prow = dict(prow)

        # Fine batted-ball zones for this hitter (this season).
        cur.execute("""
            SELECT field_zone_fine AS z, COUNT(*) AS n
            FROM game_events ge
            JOIN games g ON ge.game_id = g.id
            WHERE ge.batter_player_id = %s AND g.season = %s
              AND ge.field_zone_fine IS NOT NULL
            GROUP BY field_zone_fine
        """, (player_id, season))
        zones = {r["z"]: r["n"] for r in cur.fetchall()}

        # Season batting line for iso / wobacon / speed (weight by PA if split).
        cur.execute("""
            SELECT plate_appearances AS pa, batting_avg AS avg, slugging_pct AS slg,
                   iso, wobacon, stolen_bases
            FROM batting_stats WHERE player_id = %s AND season = %s
            ORDER BY plate_appearances DESC NULLS LAST
        """, (player_id, season))
        brow = dict(cur.fetchone() or {})

    bip = sum(zones.get(z, 0) for z in (_ALIGN_IF + _ALIGN_OF)) + (zones.get("IF_C") or 0)
    hitter = {
        "iso": brow.get("iso"),
        "avg": brow.get("avg"),
        "slg": brow.get("slg"),
        "wobacon": brow.get("wobacon"),
        "stolen_bases": brow.get("stolen_bases") or 0,
        "bats": prow.get("bats"),
    }
    spray = {"spray_chart": {"all": zones}, "bats": prow.get("bats")}
    alignment = build_alignment_for_hitter(hitter, spray)

    return {
        "player": {"id": player_id, "name": f"{prow.get('first_name') or ''} {prow.get('last_name') or ''}".strip(),
                   "bats": prow.get("bats"), "team_short": prow.get("team_short")},
        "bip": bip,
        "alignment": alignment,   # {fielders, shift, recs, ...} or None
    }


@router.get("/players/{player_id}/tto")
@cached_endpoint(ttl_seconds=1800)
def get_player_tto(
    player_id: int,
    season: int = Query(CURRENT_SEASON),
):
    """Times-through-the-order splits for one PITCHER: the batting line against
    him the 1st / 2nd / 3rd / 4th+ time he faces a hitter in a game."""
    from collections import defaultdict
    from .team_stats import (
        _tto_finalize, _TTO_NON_PA, _TTO_HITS, _TTO_SO, _TTO_BB,
    )

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT ge.game_id, ge.inning, ge.half, ge.sequence_idx,
                   ge.batter_player_id, ge.result_type
            FROM game_events ge
            JOIN games g ON ge.game_id = g.id
            WHERE ge.pitcher_player_id = %s AND g.season = %s
              AND ge.batter_player_id IS NOT NULL
              AND ge.result_type IS NOT NULL
              AND ge.result_type NOT IN %s
            ORDER BY ge.game_id, ge.inning,
                     CASE WHEN ge.half = 'top' THEN 0 ELSE 1 END, ge.sequence_idx
        """, (player_id, season, _TTO_NON_PA))
        events = cur.fetchall()

    seen = defaultdict(int)

    def _blank():
        return {k: 0 for k in ('pa', 'ab', 'h', 'tb', 'bb', 'hbp', 'so', 'hr', 'sf')}
    buckets = defaultdict(_blank)
    for e in events:
        key = (e["game_id"], e["batter_player_id"])
        seen[key] += 1
        tto = min(seen[key], 4)
        rt = e["result_type"]
        a = buckets[tto]
        a["pa"] += 1
        if rt in _TTO_HITS:
            a["h"] += 1; a["ab"] += 1
            a["tb"] += {"single": 1, "double": 2, "triple": 3, "home_run": 4}[rt]
            if rt == "home_run":
                a["hr"] += 1
        elif rt in _TTO_SO:
            a["so"] += 1; a["ab"] += 1
        elif rt in _TTO_BB:
            a["bb"] += 1
        elif rt == "hbp":
            a["hbp"] += 1
        elif rt == "sac_fly":
            a["sf"] += 1
        elif rt in ("sac_bunt", "catcher_interference"):
            pass
        else:
            a["ab"] += 1

    out = {}
    for tto, agg in buckets.items():
        fb = _tto_finalize(agg)
        if fb:
            out[str(tto)] = fb
    return {"buckets": out, "total_bf": sum(b["pa"] for b in buckets.values())}


# Count order for the per-count discipline grid (hitter's counts → pitcher's).
_COUNT_GRID = [(0, 0), (1, 0), (0, 1), (2, 0), (1, 1), (0, 2),
               (3, 0), (2, 1), (1, 2), (3, 1), (2, 2), (3, 2)]


@router.get("/players/{player_id}/count-detail")
@cached_endpoint(ttl_seconds=1800)
def get_player_count_detail(
    player_id: int,
    season: int = Query(CURRENT_SEASON),
    side: str = Query("batter", description="'batter' or 'pitcher'"),
):
    """Per-count plate discipline replayed from pitch sequences. For a hitter:
    his swing / whiff / contact by count. For a pitcher: what he induces plus
    the rate he throws a strike in each count. Encoding (corrected site-wide
    2026-06-12): S=swinging strike (whiff), K=called strike, F=foul, B=ball,
    H=HBP. The ball put in play is an implicit final pitch (no letter)."""
    col = "pitcher_player_id" if side == "pitcher" else "batter_player_id"
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(f"""
            SELECT ge.pitch_sequence AS seq, ge.was_in_play AS bip
            FROM game_events ge
            JOIN games g ON ge.game_id = g.id
            WHERE ge.{col} = %s AND g.season = %s
              AND ge.pitch_sequence IS NOT NULL
        """, (player_id, season))
        rows = cur.fetchall()

    from collections import defaultdict
    agg = defaultdict(lambda: {"p": 0, "sw": 0, "wh": 0, "st": 0, "bl": 0})
    for r in rows:
        seq = r["seq"] or ""
        b = s = 0
        for ch in seq:
            b = min(b, 3); s = min(s, 2)
            a = agg[(b, s)]
            a["p"] += 1
            if ch == "B":
                a["bl"] += 1
                if b < 3:
                    b += 1
            elif ch == "K":               # called strike
                a["st"] += 1
                if s < 2:
                    s += 1
            elif ch == "S":               # swinging strike (whiff)
                a["sw"] += 1; a["wh"] += 1; a["st"] += 1
                if s < 2:
                    s += 1
            elif ch == "F":               # foul
                a["sw"] += 1; a["st"] += 1
                if s < 2:
                    s += 1
            # H / N / P: counted as a pitch, not classified, no count change
        if r["bip"]:
            b = min(b, 3); s = min(s, 2)
            a = agg[(b, s)]
            a["p"] += 1; a["sw"] += 1; a["st"] += 1   # in-play = swing + contact + strike

    counts = []
    for (b, s) in _COUNT_GRID:
        a = agg.get((b, s))
        if not a or a["p"] == 0:
            counts.append({"count": f"{b}-{s}", "pitches": 0})
            continue
        p, sw, wh = a["p"], a["sw"], a["wh"]
        counts.append({
            "count": f"{b}-{s}",
            "pitches": p,
            "swing_pct": round(sw / p, 3),
            "whiff_pct": round(wh / sw, 3) if sw > 0 else None,
            "contact_pct": round((sw - wh) / sw, 3) if sw > 0 else None,
            "strike_pct": round(a["st"] / p, 3),
        })
    return {"side": side, "counts": counts,
            "total_pitches": sum(c.get("pitches", 0) for c in counts)}

@router.get("/players/{player_id}/vs-elite")
@cached_endpoint(ttl_seconds=1800)
def get_player_vs_elite(
    player_id: int,
    season: int = Query(CURRENT_SEASON),
):
    """A hitter's line vs ELITE pitching — pitchers with a top-quartile ERA
    (min 20 IP) this season. A quick read on whether he holds up against good
    arms. Returns {vs_elite: null} if he hasn't faced enough of them."""
    from .team_stats import _tto_finalize, _TTO_NON_PA, _TTO_HITS, _TTO_SO, _TTO_BB

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT player_id, era
            FROM pitching_stats
            WHERE season = %s AND innings_pitched >= 20
              AND era IS NOT NULL AND player_id IS NOT NULL
        """, (season,))
        quals = [dict(r) for r in cur.fetchall()]
        if len(quals) < 8:
            return {"vs_elite": None, "n_pitchers": 0, "era_cutoff": None}
        eras = sorted(q["era"] for q in quals)
        cutoff = eras[max(0, int(len(eras) * 0.25) - 1)]   # 25th-percentile ERA
        elite_ids = tuple({q["player_id"] for q in quals if q["era"] <= cutoff})
        if not elite_ids:
            return {"vs_elite": None, "n_pitchers": 0, "era_cutoff": None}

        cur.execute("""
            SELECT ge.result_type AS rt, COUNT(*) AS n
            FROM game_events ge JOIN games g ON ge.game_id = g.id
            WHERE ge.batter_player_id = %s AND g.season = %s
              AND ge.pitcher_player_id IN %s
              AND ge.result_type IS NOT NULL AND ge.result_type NOT IN %s
            GROUP BY ge.result_type
        """, (player_id, season, elite_ids, _TTO_NON_PA))
        counts = {r["rt"]: r["n"] for r in cur.fetchall()}

    agg = {k: 0 for k in ("pa", "ab", "h", "tb", "bb", "hbp", "so", "hr", "sf")}
    for rt, n in counts.items():
        agg["pa"] += n
        if rt in _TTO_HITS:
            agg["h"] += n; agg["ab"] += n
            agg["tb"] += {"single": 1, "double": 2, "triple": 3, "home_run": 4}[rt] * n
            if rt == "home_run":
                agg["hr"] += n
        elif rt in _TTO_SO:
            agg["so"] += n; agg["ab"] += n
        elif rt in _TTO_BB:
            agg["bb"] += n
        elif rt == "hbp":
            agg["hbp"] += n
        elif rt == "sac_fly":
            agg["sf"] += n
        elif rt in ("sac_bunt", "catcher_interference"):
            pass
        else:
            agg["ab"] += n
    return {"vs_elite": _tto_finalize(agg), "n_pitchers": len(elite_ids),
            "era_cutoff": round(cutoff, 2)}


@router.get("/players/{player_id}/bench")
@cached_endpoint(ttl_seconds=1800)
def get_player_bench(
    player_id: int,
    season: int = Query(CURRENT_SEASON),
):
    """Off-the-bench production: the hitter's line as a PINCH HITTER plus his
    pinch-run appearances, from box-score position codes (PH / PR)."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT COUNT(*) AS apps,
                   COALESCE(SUM(at_bats), 0) AS ab, COALESCE(SUM(hits), 0) AS h,
                   COALESCE(SUM(doubles), 0) AS d, COALESCE(SUM(triples), 0) AS t,
                   COALESCE(SUM(home_runs), 0) AS hr, COALESCE(SUM(walks), 0) AS bb,
                   COALESCE(SUM(strikeouts), 0) AS so, COALESCE(SUM(rbi), 0) AS rbi,
                   COALESCE(SUM(hit_by_pitch), 0) AS hbp, COALESCE(SUM(sacrifice_flies), 0) AS sf
            FROM game_batting gb JOIN games g ON gb.game_id = g.id
            WHERE gb.player_id = %s AND g.season = %s AND UPPER(gb.position) = 'PH'
        """, (player_id, season))
        ph = dict(cur.fetchone() or {})
        cur.execute("""
            SELECT COUNT(*) AS apps, COALESCE(SUM(stolen_bases), 0) AS sb,
                   COALESCE(SUM(runs), 0) AS r, COALESCE(SUM(caught_stealing), 0) AS cs
            FROM game_batting gb JOIN games g ON gb.game_id = g.id
            WHERE gb.player_id = %s AND g.season = %s AND UPPER(gb.position) = 'PR'
        """, (player_id, season))
        pr = dict(cur.fetchone() or {})

    ab = ph.get("ab") or 0
    h = ph.get("h") or 0
    bb = ph.get("bb") or 0
    hbp = ph.get("hbp") or 0
    sf = ph.get("sf") or 0
    tb = (h - ph.get("d", 0) - ph.get("t", 0) - ph.get("hr", 0)) + 2 * ph.get("d", 0) + 3 * ph.get("t", 0) + 4 * ph.get("hr", 0)
    obp_den = ab + bb + hbp + sf
    ph_out = {
        "apps": ph.get("apps") or 0, "ab": ab, "h": h, "hr": ph.get("hr") or 0,
        "bb": bb, "so": ph.get("so") or 0, "rbi": ph.get("rbi") or 0,
        "avg": round(h / ab, 3) if ab > 0 else None,
        "obp": round((h + bb + hbp) / obp_den, 3) if obp_den > 0 else None,
        "slg": round(tb / ab, 3) if ab > 0 else None,
    } if (ph.get("apps") or 0) > 0 else None
    if ph_out and ph_out["obp"] is not None and ph_out["slg"] is not None:
        ph_out["ops"] = round(ph_out["obp"] + ph_out["slg"], 3)
    pr_out = {"apps": pr.get("apps") or 0, "sb": pr.get("sb") or 0,
              "cs": pr.get("cs") or 0, "r": pr.get("r") or 0} if (pr.get("apps") or 0) > 0 else None
    return {"ph": ph_out, "pr": pr_out}
