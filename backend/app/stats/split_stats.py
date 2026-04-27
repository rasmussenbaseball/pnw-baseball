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
"""K% stabilizes around 60 PAs (Carleton)."""

BB_PCT_REGRESSION_PA = 120
"""BB% stabilizes around 120 PAs."""

OBP_REGRESSION_PA = 460
"""OBP stabilizes around 460 PAs."""

SLG_REGRESSION_PA = 320
"""SLG stabilizes around 320 PAs."""

ISO_REGRESSION_PA = 160
"""ISO stabilizes around 160 PAs."""

CONTACT_PCT_REGRESSION_PA = 100
"""Contact% stabilizes around 100 swings; we approximate with PA-equivalent."""

GB_PCT_REGRESSION_PA = 110
"""GB% stabilizes around 110 PAs (or 80 BIPs); approximate with PA."""


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

def _event_components(event_row: dict, weights: LinearWeights) -> dict:
    """Return the per-event contributions used for all view-level rate stats.

    `event_row` is expected to have keys: result_type, pitch_sequence (str or None),
    was_in_play (bool), bb_type (str or None).

    Returns a dict with components for wOBA/OBP/SLG/AVG plus pitch counts for
    Contact%/Whiff%/Swing% and batted-ball counts for GB%/FB%/LD%/PU%.
    """
    out = {
        'singles': 0, 'doubles': 0, 'triples': 0, 'hr': 0,
        'bb': 0, 'ibb': 0, 'hbp': 0, 'k': 0, 'sf': 0, 'sh': 0,
        'out': 0,
        'pa': 1, 'ab': 0,
        'on_base': 0,  # H + BB + HBP (for OBP)
        'tb': 0,       # Total bases (for SLG)
        'woba_num': 0.0,
        # Pitch-level: counts of K/F/B chars in pitch_sequence + the terminal
        # in-play pitch. K = swinging strike (whiff). F = foul (contact). B = ball.
        'k_pitches': 0,
        'f_pitches': 0,
        'b_pitches': 0,
        'in_play': 0,
        'pitches_total': 0,
        # Batted-ball type counts (only when bb_type is set)
        'bb_total': 0,
        'gb': 0, 'fb': 0, 'ld': 0, 'pu': 0,
    }

    rt = event_row.get('result_type') if isinstance(event_row, dict) else None
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
        out['pa'] = 0

    # Pitch-level counts from pitch_sequence + the terminal (if was_in_play)
    seq = event_row.get('pitch_sequence') if isinstance(event_row, dict) else None
    if seq:
        out['k_pitches'] = seq.count('K')
        out['f_pitches'] = seq.count('F')
        out['b_pitches'] = seq.count('B')
        out['pitches_total'] = len(seq)
    if event_row.get('was_in_play'):
        out['in_play'] = 1
        out['pitches_total'] += 1

    # Batted-ball type
    bb_type = event_row.get('bb_type') if isinstance(event_row, dict) else None
    if bb_type in ('GB', 'FB', 'LD', 'PU'):
        out['bb_total'] = 1
        if bb_type == 'GB': out['gb'] = 1
        elif bb_type == 'FB': out['fb'] = 1
        elif bb_type == 'LD': out['ld'] = 1
        elif bb_type == 'PU': out['pu'] = 1

    return out


def _aggregate_to_rates(agg: dict) -> dict:
    """Given a weighted-aggregate dict, return all rate stats used downstream."""
    pa = agg['pa']
    ab = agg['ab']
    sf = agg['sf']
    bb = agg['bb']
    hbp = agg['hbp']
    h = agg['singles'] + agg['doubles'] + agg['triples'] + agg['hr']

    woba_denom = ab + bb + sf + hbp
    woba = agg['woba_num'] / woba_denom if woba_denom > 0 else 0.0

    obp_num = h + bb + agg['ibb'] + hbp
    obp_denom = ab + bb + agg['ibb'] + hbp + sf
    obp = obp_num / obp_denom if obp_denom > 0 else 0.0

    slg = agg['tb'] / ab if ab > 0 else 0.0
    avg = h / ab if ab > 0 else 0.0
    iso = (slg - avg) if ab > 0 else 0.0

    k_pct = agg['k'] / pa if pa > 0 else 0.0
    bb_pct = (agg['bb'] + agg['ibb']) / pa if pa > 0 else 0.0

    # Contact%: contact / swings, where swings = K + F + in_play
    swings = agg.get('k_pitches', 0) + agg.get('f_pitches', 0) + agg.get('in_play', 0)
    contact = agg.get('f_pitches', 0) + agg.get('in_play', 0)
    contact_pct = (contact / swings) if swings > 0 else None
    whiff_pct = (agg.get('k_pitches', 0) / swings) if swings > 0 else None
    swing_pct = (swings / agg['pitches_total']) if agg.get('pitches_total', 0) > 0 else None

    bb_total = agg.get('bb_total', 0)
    gb_pct = (agg.get('gb', 0) / bb_total) if bb_total > 0 else None
    fb_pct = (agg.get('fb', 0) / bb_total) if bb_total > 0 else None
    ld_pct = (agg.get('ld', 0) / bb_total) if bb_total > 0 else None
    pu_pct = (agg.get('pu', 0) / bb_total) if bb_total > 0 else None

    return {
        'wOBA': woba, 'OBP': obp, 'SLG': slg, 'AVG': avg, 'ISO': iso,
        'K_pct': k_pct, 'BB_pct': bb_pct,
        'Contact_pct': contact_pct, 'Whiff_pct': whiff_pct, 'Swing_pct': swing_pct,
        'GB_pct': gb_pct, 'FB_pct': fb_pct, 'LD_pct': ld_pct, 'PU_pct': pu_pct,
        '_swings': swings, '_bb_total': bb_total,
    }


# ============================================================
# League platoon constants (computed empirically, cached per call)
# ============================================================

_EMPTY_AGG = {
    'pa': 0.0, 'ab': 0.0, 'sf': 0.0, 'bb': 0.0, 'hbp': 0.0, 'ibb': 0.0,
    'singles': 0.0, 'doubles': 0.0, 'triples': 0.0, 'hr': 0.0,
    'tb': 0.0, 'woba_num': 0.0, 'k': 0.0, 'sh': 0.0, 'out': 0.0,
    'on_base': 0.0,
    'k_pitches': 0.0, 'f_pitches': 0.0, 'b_pitches': 0.0,
    'in_play': 0.0, 'pitches_total': 0.0,
    'bb_total': 0.0, 'gb': 0.0, 'fb': 0.0, 'ld': 0.0, 'pu': 0.0,
}


def _new_agg():
    return dict(_EMPTY_AGG)


def compute_league_platoon_deltas(
    cur,
    season: int,
    division_level: str = 'NAIA',
    half_life_weeks: float = DEFAULT_HALF_LIFE_WEEKS,
    reference_date: Optional[date] = None,
) -> dict:
    """Compute league-average rate-stat deltas per (bats, throws) bucket relative
    to each batter-handedness's overall rate. Returns deltas for wOBA, OBP, SLG, ISO.

    Returns:
        {
          'R': {'R': {'wOBA': dx, 'OBP': dx, 'SLG': dx, 'ISO': dx}, 'L': {...}},
          'L': {...},
          'B': {'R': {'wOBA': 0, ...}, 'L': {'wOBA': 0, ...}},  # switch: no adj
        }
    """
    if reference_date is None:
        reference_date = date.today()

    weights = DEFAULT_WEIGHTS.get(division_level, DEFAULT_WEIGHTS['NAIA'])

    cur.execute(
        """
        SELECT pb.bats, pp.throws, ge.result_type, g.game_date,
               ge.pitch_sequence, ge.was_in_play, ge.bb_type
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

    buckets = {('R','R'): [], ('R','L'): [], ('L','R'): [], ('L','L'): [],
               ('B','R'): [], ('B','L'): []}
    for r in rows:
        bats = r['bats']; throws = r['throws']
        if r['result_type'] not in PA_RESULT_TYPES:
            continue
        w = decay_weight(r['game_date'], reference_date, half_life_weeks)
        comps = _event_components(r, weights)
        buckets[(bats, throws)].append((w, comps))

    def _rates_for_bucket(bucket_evts):
        agg = _new_agg()
        for w, c in bucket_evts:
            for k, v in c.items():
                agg[k] = agg.get(k, 0.0) + w * v
        return _aggregate_to_rates(agg)

    rates_by_bucket = {key: _rates_for_bucket(evts) for key, evts in buckets.items()}

    rhb_overall = _rates_for_bucket(buckets[('R','R')] + buckets[('R','L')])
    lhb_overall = _rates_for_bucket(buckets[('L','R')] + buckets[('L','L')])

    def _delta_block(bucket_rates, baseline_rates):
        return {
            'wOBA': bucket_rates['wOBA'] - baseline_rates['wOBA'],
            'OBP':  bucket_rates['OBP']  - baseline_rates['OBP'],
            'SLG':  bucket_rates['SLG']  - baseline_rates['SLG'],
            'ISO':  bucket_rates['ISO']  - baseline_rates['ISO'],
        }

    return {
        'R': {
            'R': _delta_block(rates_by_bucket[('R','R')], rhb_overall),
            'L': _delta_block(rates_by_bucket[('R','L')], rhb_overall),
        },
        'L': {
            'R': _delta_block(rates_by_bucket[('L','R')], lhb_overall),
            'L': _delta_block(rates_by_bucket[('L','L')], lhb_overall),
        },
        'B': {
            'R': {'wOBA': 0.0, 'OBP': 0.0, 'SLG': 0.0, 'ISO': 0.0},
            'L': {'wOBA': 0.0, 'OBP': 0.0, 'SLG': 0.0, 'ISO': 0.0},
        },
    }


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

    cur.execute(
        """
        SELECT ge.result_type, g.game_date, pp.throws AS pitcher_hand,
               pb.bats AS batter_hand,
               ge.pitch_sequence, ge.was_in_play, ge.bb_type
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

    season_evts = []
    vs_r_evts = []
    vs_l_evts = []
    for r in rows:
        rt = r['result_type']
        if rt not in PA_RESULT_TYPES:
            continue
        w = decay_weight(r['game_date'], reference_date, half_life_weeks)
        comps = _event_components(r, weights)
        if comps['pa'] == 0:
            continue
        season_evts.append((w, comps))
        ph = r['pitcher_hand']
        if ph == 'R':
            vs_r_evts.append((w, comps))
        elif ph == 'L':
            vs_l_evts.append((w, comps))

    season_view = _build_view(season_evts)

    bats_key = bats if bats in ('R', 'L', 'B') else 'R'
    deltas_r = league_deltas[bats_key]['R']
    deltas_l = league_deltas[bats_key]['L']

    def _build_split(evts, deltas):
        return _build_view(
            evts,
            regress_woba_to=season_view['wOBA'] + deltas['wOBA'], k_regress_woba=k_regress,
            regress_obp_to=season_view['OBP'] + deltas['OBP'], k_regress_obp=OBP_REGRESSION_PA,
            regress_slg_to=season_view['SLG'] + deltas['SLG'], k_regress_slg=SLG_REGRESSION_PA,
            regress_iso_to=season_view['ISO'] + deltas['ISO'], k_regress_iso=ISO_REGRESSION_PA,
            regress_k_pct_to=season_view['K_pct'], k_regress_k_pct=K_PCT_REGRESSION_PA,
            regress_bb_pct_to=season_view['BB_pct'], k_regress_bb_pct=BB_PCT_REGRESSION_PA,
            regress_contact_pct_to=season_view.get('Contact_pct'),
            k_regress_contact_pct=CONTACT_PCT_REGRESSION_PA,
            regress_gb_pct_to=season_view.get('GB_pct'),
            k_regress_gb_pct=GB_PCT_REGRESSION_PA,
        )

    vs_r_view = _build_split(vs_r_evts, deltas_r)
    vs_l_view = _build_split(vs_l_evts, deltas_l)

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
    regress_obp_to: Optional[float] = None,
    k_regress_obp: float = 0,
    regress_slg_to: Optional[float] = None,
    k_regress_slg: float = 0,
    regress_iso_to: Optional[float] = None,
    k_regress_iso: float = 0,
    regress_k_pct_to: Optional[float] = None,
    k_regress_k_pct: float = 0,
    regress_bb_pct_to: Optional[float] = None,
    k_regress_bb_pct: float = 0,
    regress_contact_pct_to: Optional[float] = None,
    k_regress_contact_pct: float = 0,
    regress_gb_pct_to: Optional[float] = None,
    k_regress_gb_pct: float = 0,
) -> dict:
    """Aggregate weighted events; optionally regress each rate stat."""
    agg = _new_agg()
    raw_pa = 0
    for w, c in evts:
        raw_pa += c['pa']
        for k_, v in c.items():
            agg[k_] = agg.get(k_, 0.0) + w * v

    rates = _aggregate_to_rates(agg)
    effective_pa = agg['pa']
    effective_swings = agg.get('k_pitches', 0) + agg.get('f_pitches', 0) + agg.get('in_play', 0)
    effective_bb_total = agg.get('bb_total', 0)

    # Snapshot observed values before regression
    observed = {
        'wOBA': rates['wOBA'],
        'OBP':  rates['OBP'],
        'SLG':  rates['SLG'],
        'ISO':  rates['ISO'],
        'K_pct': rates['K_pct'],
        'BB_pct': rates['BB_pct'],
        'Contact_pct': rates['Contact_pct'],
        'GB_pct': rates['GB_pct'],
    }

    if regress_woba_to is not None:
        rates['wOBA'] = _regress(rates['wOBA'], effective_pa, regress_woba_to, k_regress_woba)
    if regress_obp_to is not None:
        rates['OBP'] = _regress(rates['OBP'], effective_pa, regress_obp_to, k_regress_obp)
    if regress_slg_to is not None:
        rates['SLG'] = _regress(rates['SLG'], effective_pa, regress_slg_to, k_regress_slg)
    if regress_iso_to is not None:
        rates['ISO'] = _regress(rates['ISO'], effective_pa, regress_iso_to, k_regress_iso)
    if regress_k_pct_to is not None:
        rates['K_pct'] = _regress(rates['K_pct'], effective_pa, regress_k_pct_to, k_regress_k_pct)
    if regress_bb_pct_to is not None:
        rates['BB_pct'] = _regress(rates['BB_pct'], effective_pa, regress_bb_pct_to, k_regress_bb_pct)
    if regress_contact_pct_to is not None and rates['Contact_pct'] is not None:
        rates['Contact_pct'] = _regress(
            rates['Contact_pct'], effective_swings, regress_contact_pct_to, k_regress_contact_pct
        )
    if regress_gb_pct_to is not None and rates['GB_pct'] is not None:
        rates['GB_pct'] = _regress(
            rates['GB_pct'], effective_bb_total, regress_gb_pct_to, k_regress_gb_pct
        )

    rates['observed_wOBA'] = observed['wOBA']
    rates['observed_OBP'] = observed['OBP']
    rates['observed_SLG'] = observed['SLG']
    rates['observed_ISO'] = observed['ISO']
    rates['observed_K_pct'] = observed['K_pct']
    rates['observed_BB_pct'] = observed['BB_pct']
    rates['observed_Contact_pct'] = observed['Contact_pct']
    rates['observed_GB_pct'] = observed['GB_pct']
    rates['effective_pa'] = round(effective_pa, 2)
    rates['effective_swings'] = round(effective_swings, 2)
    rates['effective_bb_total'] = round(effective_bb_total, 2)
    rates['raw_pa'] = raw_pa
    return rates


def _empty_profile(player_id: int, season: int) -> dict:
    empty_view = {
        'wOBA': 0.0, 'OBP': 0.0, 'SLG': 0.0, 'AVG': 0.0, 'ISO': 0.0,
        'K_pct': 0.0, 'BB_pct': 0.0,
        'Contact_pct': None, 'Whiff_pct': None, 'Swing_pct': None,
        'GB_pct': None, 'FB_pct': None, 'LD_pct': None, 'PU_pct': None,
        'observed_wOBA': 0.0, 'observed_OBP': 0.0, 'observed_SLG': 0.0,
        'observed_ISO': 0.0, 'observed_K_pct': 0.0, 'observed_BB_pct': 0.0,
        'observed_Contact_pct': None, 'observed_GB_pct': None,
        'effective_pa': 0.0, 'effective_swings': 0.0, 'effective_bb_total': 0.0,
        'raw_pa': 0,
    }
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
