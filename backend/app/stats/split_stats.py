"""
Time-weighted, sample-regressed split stats for the Lineup Helper.

This module computes per-player wOBA / OBP / SLG / K% / BB% with two adjustments
that are critical for college-baseball lineup decisions:

1. **Recency weighting (exponential decay).** A game from this week counts more
   than a game from February. We apply a decay weight of
   `weight = exp(-ln(2) * weeks_since_game / half_life_weeks)`, so a 6-week
   half-life means a game from 6 weeks ago counts at 50%, 12 weeks ago at 25%.

2. **Sample regression for splits.** Vs-RHP / vs-LHP splits in college baseball
   almost never have enough sample to be trusted at face value. We regress
   observed splits toward an expected split target using a 600-PA constant
   (Russell Carleton / Tango). The target is the player's season wOBA shifted
   by the league's typical platoon delta for that batter handedness.

The primary entry point is `compute_player_split_profile(cur, player_id, season)`
which returns a dict with season + vs-RHP + vs-LHP views, each with regressed
and observed values.

For switch hitters (`bats='B'`), no platoon adjustment is applied — they bat
the opposite side of the pitcher by design, so their splits aren't a sample-
size artifact, they're real.
"""

from __future__ import annotations

import math
from datetime import date, datetime
from typing import Optional

from .advanced import DEFAULT_WEIGHTS, LinearWeights


# ============================================================
# Tunable constants (single source of truth)
# ============================================================

DEFAULT_HALF_LIFE_WEEKS = 6.0
"""Recency half-life. A game played `half_life_weeks` ago counts at 50% weight."""

DEFAULT_REGRESSION_PA = 600
"""PA-equivalent regression constant for splits.
Carleton/Tango: vs-hand splits stabilize around 600 PAs. We blend observed
split with the expected target using this as the prior weight."""

K_PCT_REGRESSION_PA = 60
"""K% stabilizes around 60 PAs (Carleton). For split views, we regress
observed K% toward season K% with this much prior weight."""

BB_PCT_REGRESSION_PA = 120
"""BB% stabilizes around 120 PAs. Used analogously to K_PCT_REGRESSION_PA."""


# Result types we treat as plate appearances.
# `walk`, `intentional_walk`, `hbp`, `sac_bunt`, `sac_fly` are PAs but not ABs.
# Anything else in this set IS an AB.
PA_RESULT_TYPES = {
    'home_run', 'triple', 'double', 'single',
    'walk', 'intentional_walk', 'hbp',
    'strikeout_swinging', 'strikeout_looking',
    'ground_out', 'fly_out', 'line_out', 'pop_out',
    'sac_fly', 'sac_bunt', 'fielders_choice', 'error', 'double_play', 'other',
}

NON_AB_TYPES = {'walk', 'intentional_walk', 'hbp', 'sac_bunt', 'sac_fly'}
HIT_TYPES = {'single', 'double', 'triple', 'home_run'}
WALK_TYPES = {'walk', 'intentional_walk'}
K_TYPES = {'strikeout_swinging', 'strikeout_looking'}


# ============================================================
# Recency decay
# ============================================================

def decay_weight(game_date: date, reference_date: date, half_life_weeks: float) -> float:
    """Exponential decay weight. Games on `reference_date` get weight 1.0,
    games `half_life_weeks` ago get 0.5, etc. Future games get weight 1.0."""
    if game_date is None or reference_date is None:
        return 1.0
    days_ago = (reference_date - game_date).days
    if days_ago <= 0:
        return 1.0
    weeks_ago = days_ago / 7.0
    return math.exp(-math.log(2) * weeks_ago / half_life_weeks)


# ============================================================
# Per-event PA component breakdown (for wOBA/OBP/SLG aggregation)
# ============================================================

def _event_components(result_type: str, weights: LinearWeights) -> dict:
    """Return the per-event contributions to wOBA numerator, OBP/SLG components.

    Each key is in PA-units, so a single event contributes to AT MOST one of:
    `singles`, `doubles`, `triples`, `hr`, `bb` (unintentional walks),
    `ibb` (intentional walks), `hbp`, `k`, `sf`, `sh`, `out`.
    """
    out = {
        'singles': 0, 'doubles': 0, 'triples': 0, 'hr': 0,
        'bb': 0, 'ibb': 0, 'hbp': 0, 'k': 0, 'sf': 0, 'sh': 0,
        'out': 0,
        'pa': 1, 'ab': 0,
        'on_base': 0,  # H + BB + HBP (for OBP)
        'tb': 0,       # Total bases (for SLG)
        'woba_num': 0.0,
    }
    rt = result_type
    if rt == 'single':
        out['singles'] = 1; out['ab'] = 1; out['on_base'] = 1; out['tb'] = 1
        out['woba_num'] = weights.w_1b
    elif rt == 'double':
        out['doubles'] = 1; out['ab'] = 1; out['on_base'] = 1; out['tb'] = 2
        out['woba_num'] = weights.w_2b
    elif rt == 'triple':
        out['triples'] = 1; out['ab'] = 1; out['on_base'] = 1; out['tb'] = 3
        out['woba_num'] = weights.w_3b
    elif rt == 'home_run':
        out['hr'] = 1; out['ab'] = 1; out['on_base'] = 1; out['tb'] = 4
        out['woba_num'] = weights.w_hr
    elif rt == 'walk':
        out['bb'] = 1; out['on_base'] = 1
        out['woba_num'] = weights.w_bb
    elif rt == 'intentional_walk':
        out['ibb'] = 1; out['on_base'] = 1
        # IBBs don't count in wOBA numerator (per FanGraphs convention)
    elif rt == 'hbp':
        out['hbp'] = 1; out['on_base'] = 1
        out['woba_num'] = weights.w_hbp
    elif rt in K_TYPES:
        out['k'] = 1; out['ab'] = 1; out['out'] = 1
    elif rt == 'sac_fly':
        out['sf'] = 1; out['out'] = 1
    elif rt == 'sac_bunt':
        out['sh'] = 1; out['out'] = 1
    elif rt in {'ground_out', 'fly_out', 'line_out', 'pop_out',
                'fielders_choice', 'error', 'double_play', 'other'}:
        out['ab'] = 1; out['out'] = 1
    else:
        # Unknown result type — don't count as a PA.
        out['pa'] = 0
    return out


def _aggregate_to_rates(agg: dict) -> dict:
    """Given a weighted-aggregate dict, return wOBA/OBP/SLG/K%/BB%/AVG."""
    pa = agg['pa']
    ab = agg['ab']
    sf = agg['sf']
    bb = agg['bb']
    hbp = agg['hbp']
    h = agg['singles'] + agg['doubles'] + agg['triples'] + agg['hr']

    # wOBA: (woba_num) / (AB + uBB + SF + HBP)
    woba_denom = ab + bb + sf + hbp
    woba = agg['woba_num'] / woba_denom if woba_denom > 0 else 0.0

    # OBP: (H + BB + IBB + HBP) / (AB + BB + IBB + HBP + SF)
    obp_num = h + bb + agg['ibb'] + hbp
    obp_denom = ab + bb + agg['ibb'] + hbp + sf
    obp = obp_num / obp_denom if obp_denom > 0 else 0.0

    # SLG: TB / AB
    slg = agg['tb'] / ab if ab > 0 else 0.0

    # AVG: H / AB
    avg = h / ab if ab > 0 else 0.0

    # K% / BB% as fraction of PA
    k_pct = agg['k'] / pa if pa > 0 else 0.0
    bb_pct = (agg['bb'] + agg['ibb']) / pa if pa > 0 else 0.0

    return {
        'wOBA': woba, 'OBP': obp, 'SLG': slg, 'AVG': avg,
        'K_pct': k_pct, 'BB_pct': bb_pct,
    }


# ============================================================
# League platoon constants (computed empirically, cached per call)
# ============================================================

def compute_league_platoon_deltas(
    cur,
    season: int,
    division_level: str = 'NAIA',
    half_life_weeks: float = DEFAULT_HALF_LIFE_WEEKS,
    reference_date: Optional[date] = None,
) -> dict:
    """Compute the league-average wOBA delta for each (bats, throws) bucket
    relative to that batter handedness's overall wOBA.

    Returns:
        {
            'R': {'R': delta_R_vs_R, 'L': delta_R_vs_L},
            'L': {'R': delta_L_vs_R, 'L': delta_L_vs_L},
        }

    For switch hitters we return zeros — by design they neutralize platoon.
    """
    if reference_date is None:
        reference_date = date.today()

    weights = DEFAULT_WEIGHTS.get(division_level, DEFAULT_WEIGHTS['NAIA'])

    cur.execute(
        """
        SELECT pb.bats, pp.throws, ge.result_type, g.game_date
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        JOIN players pb ON pb.id = ge.batter_player_id
        JOIN players pp ON pp.id = ge.pitcher_player_id
        JOIN teams tb ON tb.id = ge.batting_team_id
        JOIN conferences c ON c.id = tb.conference_id
        JOIN divisions d ON d.id = c.division_id
        WHERE g.season = %s
          AND pb.bats IN ('R', 'L', 'B')
          AND pp.throws IN ('R', 'L')
          AND d.level = %s
          AND ge.result_type IS NOT NULL
        """,
        (season, division_level),
    )
    rows = cur.fetchall()

    # Aggregate by (bats, throws)
    buckets = {('R','R'): [], ('R','L'): [], ('L','R'): [], ('L','L'): [],
               ('B','R'): [], ('B','L'): []}
    for r in rows:
        bats = r['bats']; throws = r['throws']
        rt = r['result_type']; gd = r['game_date']
        if rt not in PA_RESULT_TYPES:
            continue
        w = decay_weight(gd, reference_date, half_life_weeks)
        comps = _event_components(rt, weights)
        buckets[(bats, throws)].append((w, comps))

    # Compute weighted wOBA per bucket
    woba_by_bucket = {}
    for key, evts in buckets.items():
        agg = {'pa': 0.0, 'ab': 0.0, 'sf': 0.0, 'bb': 0.0, 'hbp': 0.0, 'ibb': 0.0,
               'singles': 0.0, 'doubles': 0.0, 'triples': 0.0, 'hr': 0.0,
               'tb': 0.0, 'woba_num': 0.0, 'k': 0.0, 'sh': 0.0, 'out': 0.0,
               'on_base': 0.0}
        for w, c in evts:
            for k, v in c.items():
                agg[k] = agg.get(k, 0.0) + w * v
        rates = _aggregate_to_rates(agg)
        woba_by_bucket[key] = rates['wOBA']

    # Aggregate across pitcher-hand to get per-bats-hand season baseline
    rhb_overall = _woba_overall(buckets[('R','R')] + buckets[('R','L')], weights)
    lhb_overall = _woba_overall(buckets[('L','R')] + buckets[('L','L')], weights)

    deltas = {
        'R': {
            'R': woba_by_bucket.get(('R','R'), 0.0) - rhb_overall,
            'L': woba_by_bucket.get(('R','L'), 0.0) - rhb_overall,
        },
        'L': {
            'R': woba_by_bucket.get(('L','R'), 0.0) - lhb_overall,
            'L': woba_by_bucket.get(('L','L'), 0.0) - lhb_overall,
        },
        'B': {'R': 0.0, 'L': 0.0},  # switch hitters: no adjustment
    }
    return deltas


def _woba_overall(evts, weights):
    agg = {'pa': 0.0, 'ab': 0.0, 'sf': 0.0, 'bb': 0.0, 'hbp': 0.0, 'ibb': 0.0,
           'singles': 0.0, 'doubles': 0.0, 'triples': 0.0, 'hr': 0.0,
           'tb': 0.0, 'woba_num': 0.0, 'k': 0.0, 'sh': 0.0, 'out': 0.0,
           'on_base': 0.0}
    for w, c in evts:
        for k, v in c.items():
            agg[k] = agg.get(k, 0.0) + w * v
    return _aggregate_to_rates(agg)['wOBA']


# ============================================================
# Per-player split profile (the primary entry point)
# ============================================================

def compute_player_split_profile(
    cur,
    player_id: int,
    season: int,
    division_level: str = 'NAIA',
    half_life_weeks: float = DEFAULT_HALF_LIFE_WEEKS,
    k_regress: float = DEFAULT_REGRESSION_PA,
    reference_date: Optional[date] = None,
    league_deltas: Optional[dict] = None,
) -> dict:
    """Return a player's recency-weighted, regression-adjusted split profile.

    The result dict has three views:
      - 'season' — all PAs combined, no regression (large sample)
      - 'vs_RHP' — regressed toward season + league RHB-vs-RHP delta
      - 'vs_LHP' — regressed toward season + league RHB-vs-LHP delta

    Each view contains: wOBA, OBP, SLG, AVG, K_pct, BB_pct, plus
    `effective_pa` (sum of decay weights) and `raw_pa` (actual PA count).
    The split views additionally contain `observed_wOBA` (raw weighted, before
    regression) for UI display.

    If `league_deltas` is None we compute it on demand. Pass it in if calling
    this for many players in a row to avoid re-querying.
    """
    if reference_date is None:
        reference_date = date.today()
    if league_deltas is None:
        league_deltas = compute_league_platoon_deltas(
            cur, season, division_level, half_life_weeks, reference_date
        )

    weights = DEFAULT_WEIGHTS.get(division_level, DEFAULT_WEIGHTS['NAIA'])

    # Pull all batter PAs for this player in this season, with pitcher hand and game date
    cur.execute(
        """
        SELECT ge.result_type, g.game_date, pp.throws AS pitcher_hand,
               pb.bats AS batter_hand
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        JOIN players pb ON pb.id = ge.batter_player_id
        LEFT JOIN players pp ON pp.id = ge.pitcher_player_id
        WHERE ge.batter_player_id = %s
          AND g.season = %s
          AND ge.result_type IS NOT NULL
        """,
        (player_id, season),
    )
    rows = cur.fetchall()

    if not rows:
        return _empty_profile(player_id, season)

    bats = rows[0]['batter_hand'] or 'R'

    # Bucket events by (vs_R, vs_L, all)
    season_evts = []
    vs_r_evts = []
    vs_l_evts = []
    for r in rows:
        rt = r['result_type']
        if rt not in PA_RESULT_TYPES:
            continue
        w = decay_weight(r['game_date'], reference_date, half_life_weeks)
        comps = _event_components(rt, weights)
        if comps['pa'] == 0:
            continue
        season_evts.append((w, comps))
        ph = r['pitcher_hand']
        if ph == 'R':
            vs_r_evts.append((w, comps))
        elif ph == 'L':
            vs_l_evts.append((w, comps))
        # else: unknown pitcher hand — counts toward season only

    # Season view: no regression (the season *is* the prior for the splits).
    season_view = _build_view(season_evts)

    # Regression target for each split = season wOBA + league delta for this batter hand
    bats_key = bats if bats in ('R', 'L', 'B') else 'R'
    target_woba_vs_r = season_view['wOBA'] + league_deltas[bats_key]['R']
    target_woba_vs_l = season_view['wOBA'] + league_deltas[bats_key]['L']
    # K% and BB% targets are the player's season values (no platoon delta needed —
    # platoon effects on K%/BB% are very small in college samples).
    target_k = season_view['K_pct']
    target_bb = season_view['BB_pct']

    vs_r_view = _build_view(
        vs_r_evts,
        regress_woba_to=target_woba_vs_r, k_regress_woba=k_regress,
        regress_k_pct_to=target_k, k_regress_k_pct=K_PCT_REGRESSION_PA,
        regress_bb_pct_to=target_bb, k_regress_bb_pct=BB_PCT_REGRESSION_PA,
    )
    vs_l_view = _build_view(
        vs_l_evts,
        regress_woba_to=target_woba_vs_l, k_regress_woba=k_regress,
        regress_k_pct_to=target_k, k_regress_k_pct=K_PCT_REGRESSION_PA,
        regress_bb_pct_to=target_bb, k_regress_bb_pct=BB_PCT_REGRESSION_PA,
    )

    return {
        'player_id': player_id,
        'season': season,
        'bats': bats,
        'reference_date': reference_date.isoformat(),
        'half_life_weeks': half_life_weeks,
        'k_regress': k_regress,
        'season_view': season_view,
        'vs_RHP': vs_r_view,
        'vs_LHP': vs_l_view,
    }


def _regress(observed: float, n: float, target: float, k: float) -> float:
    """Standard regression-to-mean: (n*observed + k*target) / (n + k)."""
    if k <= 0:
        return observed
    return (n * observed + k * target) / (n + k)


def _build_view(
    evts,
    regress_woba_to: Optional[float] = None,
    k_regress_woba: float = 0,
    regress_k_pct_to: Optional[float] = None,
    k_regress_k_pct: float = 0,
    regress_bb_pct_to: Optional[float] = None,
    k_regress_bb_pct: float = 0,
) -> dict:
    """Aggregate weighted events; optionally regress wOBA, K%, and BB%."""
    agg = {'pa': 0.0, 'ab': 0.0, 'sf': 0.0, 'bb': 0.0, 'hbp': 0.0, 'ibb': 0.0,
           'singles': 0.0, 'doubles': 0.0, 'triples': 0.0, 'hr': 0.0,
           'tb': 0.0, 'woba_num': 0.0, 'k': 0.0, 'sh': 0.0, 'out': 0.0,
           'on_base': 0.0}
    raw_pa = 0
    for w, c in evts:
        raw_pa += c['pa']
        for k_, v in c.items():
            agg[k_] = agg.get(k_, 0.0) + w * v

    rates = _aggregate_to_rates(agg)
    effective_pa = agg['pa']
    observed_woba = rates['wOBA']
    observed_k_pct = rates['K_pct']
    observed_bb_pct = rates['BB_pct']

    # Apply regression on each rate stat independently.
    if regress_woba_to is not None:
        rates['wOBA'] = _regress(observed_woba, effective_pa, regress_woba_to, k_regress_woba)
    if regress_k_pct_to is not None:
        rates['K_pct'] = _regress(observed_k_pct, effective_pa, regress_k_pct_to, k_regress_k_pct)
    if regress_bb_pct_to is not None:
        rates['BB_pct'] = _regress(observed_bb_pct, effective_pa, regress_bb_pct_to, k_regress_bb_pct)

    rates['observed_wOBA'] = observed_woba
    rates['observed_K_pct'] = observed_k_pct
    rates['observed_BB_pct'] = observed_bb_pct
    rates['effective_pa'] = round(effective_pa, 2)
    rates['raw_pa'] = raw_pa
    return rates


def _empty_profile(player_id: int, season: int) -> dict:
    empty_view = {'wOBA': 0.0, 'OBP': 0.0, 'SLG': 0.0, 'AVG': 0.0,
                  'K_pct': 0.0, 'BB_pct': 0.0,
                  'observed_wOBA': 0.0, 'effective_pa': 0.0, 'raw_pa': 0}
    return {
        'player_id': player_id,
        'season': season,
        'bats': None,
        'reference_date': None,
        'half_life_weeks': DEFAULT_HALF_LIFE_WEEKS,
        'k_regress': DEFAULT_REGRESSION_PA,
        'season_view': dict(empty_view),
        'vs_RHP': dict(empty_view),
        'vs_LHP': dict(empty_view),
    }
