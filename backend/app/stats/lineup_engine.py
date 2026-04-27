"""
Lineup optimization engine for the Lineup Helper.

Methodology: modern sabermetric per The Book (Tango/Lichtman/Dolphin) plus
follow-on work from Lichtman 2013, Carleton's reliability series, and
Petriello's batted-ball studies. Adapted for college baseball.

Slot-fitness uses a 7-stat formula:
  score(p, s) = w_OBP[s]    * (OBP - LG_OBP)
              + w_PWR[s]    * (PWR - LG_PWR)        [SLG everywhere except slots 4,5 which use ISO]
              + w_BB[s]     * (BB% - LG_BB%)
              - w_K[s]      * (K%  - LG_K%)
              + w_Contact[s]* (Contact% - LG_Contact%)   [non-zero only at slots 2 and 8]
              - w_GB[s]     * max(0, GB% - 0.45)         [non-zero only at slots 2 and 3]
              + w_SPD[s]    * speed_z                    [non-zero only at slots 1, 2, 9]

Slot-weight matrix is calibrated from The Book's per-slot run-value tables
and scaled 1.3x for college run environment. Best hitter (highest OBP) goes
at #2, second-best (or best power) at #4 — see Lichtman 2013, Andrecheck 2009.

Brute-force search over 9! permutations finds the optimal assignment. Since
slot-scoring is linear (no slot-to-slot interaction), this matches Hungarian
linear-assignment for optimality and runs in <2 seconds in pure Python.
"""

from __future__ import annotations

import itertools
from typing import Optional


# ============================================================
# Slot weights — calibrated from The Book + Lichtman 2013
# Values are runs per +0.010 in the rate stat per full season,
# scaled 1.3x for college run environment.
# ============================================================

# All rate-stat weights are in "runs per +1.0 in stat per season".
# So a +0.030 OBP advantage at slot 2 contributes 255 * 0.030 = 7.65 runs.
# Speed weights are in "runs per +1.0 standard deviation of within-team speed
# proxy" so they're already in run units and don't need the *100 factor.
#
# Calibrated from The Book + Lichtman 2013, scaled 1.3x for college run env.
# Contact% and GB% magnitudes calibrated against Petriello's batted-ball work
# (~1.5 runs at +0.05 Contact at slot 2; ~3 runs at +0.05 GB above 0.45).
#
# Power signal: we use SLG everywhere (cleaner dynamic range than ISO at our
# college sample sizes). Slot 4 keeps a small ISO bonus on top of SLG to
# specifically reward extra-base power for the cleanup spot.

SLOT_WEIGHTS = {
    1: {'OBP': 240, 'SLG': 135, 'ISO': 0,   'BB': 125, 'K': 25,
        'Contact': 0,  'GB': 0,  'SPD': 2.0},
    2: {'OBP': 255, 'SLG': 170, 'ISO': 0,   'BB': 130, 'K': 30,
        'Contact': 30, 'GB': 60, 'SPD': 1.0},
    3: {'OBP': 215, 'SLG': 175, 'ISO': 0,   'BB': 110, 'K': 25,
        'Contact': 0,  'GB': 30, 'SPD': 0.0},
    4: {'OBP': 200, 'SLG': 200, 'ISO': 60,  'BB': 105, 'K': 25,
        'Contact': 0,  'GB': 0,  'SPD': 0.0},
    5: {'OBP': 180, 'SLG': 180, 'ISO': 40,  'BB': 95,  'K': 20,
        'Contact': 0,  'GB': 0,  'SPD': 0.0},
    6: {'OBP': 160, 'SLG': 155, 'ISO': 0,   'BB': 85,  'K': 20,
        'Contact': 0,  'GB': 0,  'SPD': 0.0},
    7: {'OBP': 145, 'SLG': 135, 'ISO': 0,   'BB': 70,  'K': 15,
        'Contact': 0,  'GB': 0,  'SPD': 0.0},
    8: {'OBP': 130, 'SLG': 125, 'ISO': 0,   'BB': 65,  'K': 15,
        'Contact': 20, 'GB': 0,  'SPD': 0.0},
    9: {'OBP': 125, 'SLG': 115, 'ISO': 0,   'BB': 65,  'K': 15,
        'Contact': 0,  'GB': 0,  'SPD': 1.5},
}

# League-average reference values (NAIA / NWC / NWAC composite).
# Subtracting these means a perfectly average hitter scores 0 at every slot
# and the optimizer is driven by RELATIVE differences from average.
LG_OBP = 0.350
LG_SLG = 0.420
LG_ISO = 0.110
LG_K_PCT = 0.20
LG_BB_PCT = 0.10
LG_CONTACT_PCT = 0.78
GB_PENALTY_THRESHOLD = 0.45  # GB% above this incurs penalty at slots 2, 3


# ============================================================
# Scoring
# ============================================================

def score_player_for_slot(view: dict, speed_z: float, slot: int) -> float:
    """Score a player at a given lineup slot (1-9) using the 7-stat formula.

    Args:
        view: a regressed split view (output of split_stats `_build_view`).
              Must have OBP, SLG, ISO, K_pct, BB_pct. Contact_pct and GB_pct
              are optional (None when no PBP coverage).
        speed_z: within-team z-score of the player's speed proxy. Default 0.
        slot: 1-9.
    """
    w = SLOT_WEIGHTS[slot]

    obp = view.get('OBP') or LG_OBP
    slg = view.get('SLG') or LG_SLG
    iso = view.get('ISO') or LG_ISO
    k_pct = view.get('K_pct') or LG_K_PCT
    bb_pct = view.get('BB_pct') or LG_BB_PCT
    contact_pct = view.get('Contact_pct')
    gb_pct = view.get('GB_pct')

    score = 0.0
    score += w['OBP'] * (obp - LG_OBP)
    score += w['SLG'] * (slg - LG_SLG)
    if w['ISO']:
        score += w['ISO'] * (iso - LG_ISO)
    score += w['BB'] * (bb_pct - LG_BB_PCT)
    score -= w['K'] * (k_pct - LG_K_PCT)
    if w['Contact'] > 0 and contact_pct is not None:
        score += w['Contact'] * (contact_pct - LG_CONTACT_PCT)
    if w['GB'] > 0 and gb_pct is not None:
        score -= w['GB'] * max(0, gb_pct - GB_PENALTY_THRESHOLD)
    if w['SPD'] != 0:
        score += w['SPD'] * speed_z

    return score


# ============================================================
# Optimizer (brute-force 9! permutations)
# ============================================================

def optimize_batting_order(
    players: list,
    vs_hand: str = 'R',
    speeds: Optional[list] = None,
) -> dict:
    """Find the optimal 1-9 batting order for these 9 players vs the given hand.

    Args:
        players: list of 9 split profiles from `compute_player_split_profile`.
                 Each must have 'vs_RHP' and 'vs_LHP' views.
        vs_hand: 'R' or 'L'.
        speeds:  list of 9 floats (within-team speed_z values). Defaults to 0.0
                 (neutral) for everyone if omitted.
    """
    if len(players) != 9:
        raise ValueError(f"optimize_batting_order requires exactly 9 players, got {len(players)}")
    if speeds is None:
        speeds = [0.0] * 9

    view_key = 'vs_RHP' if vs_hand == 'R' else 'vs_LHP'

    # Precompute 9x9 cost matrix
    cost = []
    for i, p in enumerate(players):
        view = p[view_key]
        spd = speeds[i]
        row = [score_player_for_slot(view, spd, s + 1) for s in range(9)]
        cost.append(row)

    best_total = float('-inf')
    best_perm = None
    for perm in itertools.permutations(range(9)):
        total = sum(cost[player_idx][slot_idx] for slot_idx, player_idx in enumerate(perm))
        if total > best_total:
            best_total = total
            best_perm = perm

    order = []
    for slot_idx, player_idx in enumerate(best_perm):
        p = players[player_idx]
        view = p[view_key]
        order.append({
            'slot': slot_idx + 1,
            'player_id': p['player_id'],
            'wOBA': round(view['wOBA'], 3),
            'observed_wOBA': round(view.get('observed_wOBA', view['wOBA']), 3),
            'OBP': round(view.get('OBP', 0) or 0, 3),
            'SLG': round(view.get('SLG', 0) or 0, 3),
            'ISO': round(view.get('ISO', 0) or 0, 3),
            'K_pct': round(view['K_pct'], 3),
            'BB_pct': round(view['BB_pct'], 3),
            'Contact_pct': _round_or_none(view.get('Contact_pct')),
            'GB_pct': _round_or_none(view.get('GB_pct')),
            'speed_z': round(speeds[player_idx], 3),
            'effective_pa': view.get('effective_pa', 0),
            'raw_pa': view.get('raw_pa', 0),
            'score': round(cost[player_idx][slot_idx], 4),
        })

    return {
        'order': order,
        'total_score': round(best_total, 4),
        'vs_hand': vs_hand,
    }


def optimize_both_lineups(players: list, speeds: Optional[list] = None) -> dict:
    return {
        'vs_RHP': optimize_batting_order(players, vs_hand='R', speeds=speeds),
        'vs_LHP': optimize_batting_order(players, vs_hand='L', speeds=speeds),
    }


def _round_or_none(v):
    return None if v is None else round(v, 3)


# ============================================================
# Starter selection (constrained backtracking over 9 positions)
# ============================================================

LINEUP_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH']


def _player_select_score(profile: dict, vs_hand: str, speed_z: float = 0.0) -> float:
    """Select a player based on their best-slot fit across all 9 slots."""
    view_key = 'vs_RHP' if vs_hand == 'R' else 'vs_LHP'
    view = profile[view_key]
    return max(score_player_for_slot(view, speed_z, s) for s in range(1, 10))


def select_optimal_starters(
    eligible_players: list,
    vs_hand: str,
    speeds_by_pid: Optional[dict] = None,
) -> Optional[dict]:
    """Pick the 9-player starting lineup that maximizes total selection-score
    while satisfying position-eligibility constraints."""
    if len(eligible_players) < 9:
        return None

    speeds_by_pid = speeds_by_pid or {}

    for p in eligible_players:
        spd = speeds_by_pid.get(p['player_id'], 0.0)
        p['_select_score'] = _player_select_score(p['profile'], vs_hand, spd)
        p['_speed_z'] = spd

    candidates_by_pos = {}
    for pos in LINEUP_POSITIONS:
        if pos == 'DH':
            cands = list(eligible_players)
        else:
            cands = [p for p in eligible_players if pos in p['eligible_positions']]
        cands.sort(key=lambda x: x['_select_score'], reverse=True)
        candidates_by_pos[pos] = cands

    sorted_positions = sorted(LINEUP_POSITIONS, key=lambda p: len(candidates_by_pos[p]))

    best = {'score': float('-inf'), 'assignment': None}

    def backtrack(idx, used, current_score, current_assignment):
        if idx == len(sorted_positions):
            if current_score > best['score']:
                best['score'] = current_score
                best['assignment'] = dict(current_assignment)
            return
        pos = sorted_positions[idx]
        for cand in candidates_by_pos[pos]:
            if cand['player_id'] in used:
                continue
            used.add(cand['player_id'])
            current_assignment[pos] = cand
            backtrack(idx + 1, used, current_score + cand['_select_score'], current_assignment)
            used.remove(cand['player_id'])
            del current_assignment[pos]

    backtrack(0, set(), 0.0, {})

    if best['assignment'] is None:
        return None

    result = dict(best['assignment'])
    result['_total_select_score'] = best['score']
    return result


# ============================================================
# Bench ranking
# ============================================================

def rank_bench(
    eligible_players: list,
    starters_pids: set,
    vs_hand: str,
    top_n: int = 5,
    speeds_by_pid: Optional[dict] = None,
) -> list:
    """Rank top N non-starters as bench options."""
    bench_players = [p for p in eligible_players if p['player_id'] not in starters_pids]
    speeds_by_pid = speeds_by_pid or {}

    view_key = 'vs_RHP' if vs_hand == 'R' else 'vs_LHP'
    out = []
    for p in bench_players:
        view = p['profile'][view_key]
        spd = speeds_by_pid.get(p['player_id'], 0.0)
        best_slot, best_score = max(
            ((s, score_player_for_slot(view, spd, s)) for s in range(1, 10)),
            key=lambda x: x[1],
        )
        best_position = next(iter(p['eligible_positions']), 'DH') if p['eligible_positions'] else 'DH'
        out.append({
            'player_id': p['player_id'],
            'best_slot': best_slot,
            'best_score': round(best_score, 4),
            'best_position': best_position,
            'eligible_positions': sorted(p['eligible_positions']) + (
                ['DH'] if 'DH' not in p['eligible_positions'] else []
            ),
            'wOBA': round(view['wOBA'], 3),
            'observed_wOBA': round(view.get('observed_wOBA', view['wOBA']), 3),
            'OBP': round(view.get('OBP', 0) or 0, 3),
            'SLG': round(view.get('SLG', 0) or 0, 3),
            'ISO': round(view.get('ISO', 0) or 0, 3),
            'K_pct': round(view['K_pct'], 3),
            'BB_pct': round(view['BB_pct'], 3),
            'Contact_pct': _round_or_none(view.get('Contact_pct')),
            'GB_pct': _round_or_none(view.get('GB_pct')),
            'speed_z': round(spd, 3),
            'raw_pa': view.get('raw_pa', 0),
        })

    out.sort(key=lambda x: x['best_score'], reverse=True)
    return out[:top_n]
