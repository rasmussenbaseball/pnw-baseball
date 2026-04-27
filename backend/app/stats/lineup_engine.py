"""
Lineup optimization engine for the Lineup Helper.

Given 9 player split profiles (from `split_stats.compute_player_split_profile`),
this module returns the optimal 1-9 batting order vs a given pitcher handedness.

Methodology is modern sabermetric per The Book (Tango/Lichtman/Dolphin, 2007),
adapted for college baseball:

- Per-slot weight vectors over wOBA, K%, and a speed proxy.
- Brute-force search over all 9! = 362,880 permutations. The slot-scoring is
  linear (no slot-to-slot interaction), so brute-force matches Hungarian for
  optimality and runs in <2 seconds in pure Python.
- Two assignments per call: one vs RHP, one vs LHP, using the regressed split
  wOBAs from the player's profile.

Key Book findings reflected in the weights:
- Slot 2 gets one of your three best hitters (highest w_wOBA after slot 4).
- Slot 4 wants power; w_K is lowest there because a HR offsets the K cost.
- Slot 9 is a "second leadoff" — high w_wOBA and w_SPD, not your worst hitter.
- Outs at slots 1 and 9 cost more than outs at 5-7 (high w_K at 1, 9).

Speed proxy: derived from a player's SB attempts per time on base. Not yet
hooked up — the API surface accepts a speed value, defaulting to 0.5 (league
average) so the engine works even when speed data isn't available.
"""

from __future__ import annotations

import itertools
from typing import Optional


# ============================================================
# Slot weights — The Book, normalized
# ============================================================

SLOT_WEIGHTS = {
    1: {'w_wOBA': 1.4, 'w_K': 1.4, 'w_SPD': 0.8},
    2: {'w_wOBA': 1.5, 'w_K': 1.2, 'w_SPD': 0.4},
    3: {'w_wOBA': 1.0, 'w_K': 0.8, 'w_SPD': 0.2},
    4: {'w_wOBA': 1.6, 'w_K': 0.6, 'w_SPD': 0.0},
    5: {'w_wOBA': 1.4, 'w_K': 0.7, 'w_SPD': 0.1},
    6: {'w_wOBA': 1.0, 'w_K': 0.8, 'w_SPD': 0.2},
    7: {'w_wOBA': 0.9, 'w_K': 0.9, 'w_SPD': 0.3},
    8: {'w_wOBA': 0.85, 'w_K': 1.0, 'w_SPD': 0.4},
    9: {'w_wOBA': 1.2, 'w_K': 1.2, 'w_SPD': 0.7},
}

# League-average reference values for centering scores.
# Subtracting these means a "league-average" hitter scores ~0 at every slot,
# and the assignment cares about RELATIVE differences between hitters.
LEAGUE_AVG_wOBA = 0.350
LEAGUE_AVG_K_PCT = 0.20
LEAGUE_AVG_SPD = 0.5


# ============================================================
# Scoring
# ============================================================

def score_player_for_slot(
    woba: float,
    k_pct: float,
    speed: float,
    slot: int,
) -> float:
    """Score a player at a given lineup slot (1-9).

    Higher score = better fit for that slot.

    Inputs are deltas relative to league average — so a player with wOBA = 0.350
    (league average) and K% = 0.20 (league average) scores 0 everywhere, and
    the assignment is driven by ABOVE/BELOW average performance.
    """
    w = SLOT_WEIGHTS[slot]
    score = (
        w['w_wOBA'] * (woba - LEAGUE_AVG_wOBA)
        - w['w_K'] * (k_pct - LEAGUE_AVG_K_PCT)
        + w['w_SPD'] * (speed - LEAGUE_AVG_SPD)
    )
    return score


# ============================================================
# Optimizer
# ============================================================

def optimize_batting_order(
    players: list,
    vs_hand: str = 'R',
    speeds: Optional[list] = None,
) -> dict:
    """Find the optimal 1-9 batting order for these 9 players vs the given pitcher hand.

    Args:
        players: list of 9 split profiles from `compute_player_split_profile`.
                 Each must have a 'vs_RHP' and 'vs_LHP' key with a 'wOBA' and 'K_pct'.
                 Profiles also need a 'player_id' for the result.
        vs_hand: 'R' or 'L' — which pitcher handedness this lineup faces.
        speeds:  optional list of 9 floats, one per player, for the speed proxy.
                 Defaults to LEAGUE_AVG_SPD for all players.

    Returns:
        {
            'order': [{'slot': 1, 'player_id': X, 'wOBA': 0.420, 'K_pct': 0.18, 'score': 0.045}, ...],
            'total_score': float,  # sum of slot scores
        }
    """
    if len(players) != 9:
        raise ValueError(f"optimize_batting_order requires exactly 9 players, got {len(players)}")

    if speeds is None:
        speeds = [LEAGUE_AVG_SPD] * 9

    view_key = 'vs_RHP' if vs_hand == 'R' else 'vs_LHP'

    # Precompute the 9x9 cost matrix: cost[player_idx][slot_idx] = slot score
    # (slot_idx 0 corresponds to lineup slot 1, slot_idx 8 corresponds to slot 9)
    cost = []
    for i, p in enumerate(players):
        view = p[view_key]
        woba = view['wOBA']
        k_pct = view['K_pct']
        spd = speeds[i]
        row = [score_player_for_slot(woba, k_pct, spd, s+1) for s in range(9)]
        cost.append(row)

    # Brute-force search over all 9! permutations.
    # perm[slot_idx] = player_idx assigned to that slot.
    best_total = float('-inf')
    best_perm = None
    for perm in itertools.permutations(range(9)):
        total = 0.0
        for slot_idx, player_idx in enumerate(perm):
            total += cost[player_idx][slot_idx]
        if total > best_total:
            best_total = total
            best_perm = perm

    # Build result
    order = []
    for slot_idx, player_idx in enumerate(best_perm):
        p = players[player_idx]
        view = p[view_key]
        order.append({
            'slot': slot_idx + 1,
            'player_id': p['player_id'],
            'wOBA': round(view['wOBA'], 3),
            'observed_wOBA': round(view.get('observed_wOBA', view['wOBA']), 3),
            'K_pct': round(view['K_pct'], 3),
            'BB_pct': round(view['BB_pct'], 3),
            'OBP': round(view['OBP'], 3),
            'SLG': round(view['SLG'], 3),
            'effective_pa': view.get('effective_pa', 0),
            'raw_pa': view.get('raw_pa', 0),
            'score': round(cost[player_idx][slot_idx], 4),
        })

    return {
        'order': order,
        'total_score': round(best_total, 4),
        'vs_hand': vs_hand,
    }


def optimize_both_lineups(
    players: list,
    speeds: Optional[list] = None,
) -> dict:
    """Run optimize_batting_order twice — once vs RHP, once vs LHP.

    Returns: {'vs_RHP': {...}, 'vs_LHP': {...}}.
    """
    return {
        'vs_RHP': optimize_batting_order(players, vs_hand='R', speeds=speeds),
        'vs_LHP': optimize_batting_order(players, vs_hand='L', speeds=speeds),
    }


# ============================================================
# Starter selection (9 positions, position-eligibility constraints)
# ============================================================

LINEUP_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH']


def _player_select_score(profile: dict, vs_hand: str) -> float:
    """Score a player's overall fitness for being in the lineup vs this hand.

    Used for the *selection* step (which 9 to pick). For *ordering*, we use
    score_player_for_slot which is per-slot.
    """
    view_key = 'vs_RHP' if vs_hand == 'R' else 'vs_LHP'
    view = profile[view_key]
    # Best fit across all 9 slots = how good is this player at their best slot
    best = max(
        score_player_for_slot(view['wOBA'], view['K_pct'], LEAGUE_AVG_SPD, s)
        for s in range(1, 10)
    )
    return best


def select_optimal_starters(
    eligible_players: list,
    vs_hand: str,
) -> Optional[dict]:
    """Pick the 9-player starting lineup that maximizes total selection-score
    while satisfying position-eligibility constraints.

    Args:
        eligible_players: list of dicts, each with:
            - 'player_id'
            - 'profile' (output of compute_player_split_profile)
            - 'eligible_positions' (set of position strings: 'C', 'SS', etc.;
              every player is implicitly DH-eligible)
        vs_hand: 'R' or 'L' — which lineup we're picking for.

    Returns:
        {'C': player_dict, '1B': player_dict, ..., 'DH': player_dict, 'total': float}
        or None if no feasible assignment exists (e.g., no eligible catcher).
    """
    if len(eligible_players) < 9:
        return None

    # Precompute selection score per player
    for p in eligible_players:
        p['_select_score'] = _player_select_score(p['profile'], vs_hand)

    # For each position, list eligible candidates, sorted by score desc
    candidates_by_pos = {}
    for pos in LINEUP_POSITIONS:
        if pos == 'DH':
            cands = list(eligible_players)
        else:
            cands = [p for p in eligible_players if pos in p['eligible_positions']]
        cands.sort(key=lambda p: p['_select_score'], reverse=True)
        candidates_by_pos[pos] = cands

    # Order positions by scarcity (fewest candidates first) to prune faster
    sorted_positions = sorted(LINEUP_POSITIONS, key=lambda p: len(candidates_by_pos[p]))

    best = {'score': float('-inf'), 'assignment': None}

    def backtrack(idx, used, current_score, current_assignment):
        if idx == len(sorted_positions):
            if current_score > best['score']:
                best['score'] = current_score
                best['assignment'] = dict(current_assignment)
            return

        pos = sorted_positions[idx]
        # Bound: even if all remaining positions get their best candidate,
        # we can't beat best['score']. Skip in that case.
        # (Simple optimization: we don't compute the bound here, it's not needed
        # for typical college roster sizes.)
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
) -> list:
    """Rank the top N non-starters as bench options vs this hand.

    Each bench entry includes the player's best-fit slot and best-fit position.
    """
    bench_players = [p for p in eligible_players if p['player_id'] not in starters_pids]

    view_key = 'vs_RHP' if vs_hand == 'R' else 'vs_LHP'
    out = []
    for p in bench_players:
        view = p['profile'][view_key]
        # Best slot for this player's profile
        best_slot, best_score = max(
            (
                (s, score_player_for_slot(view['wOBA'], view['K_pct'], LEAGUE_AVG_SPD, s))
                for s in range(1, 10)
            ),
            key=lambda x: x[1],
        )
        # Best position they could take (highest-scoring eligible non-DH if available)
        best_position = next(iter(p['eligible_positions']), 'DH') if p['eligible_positions'] else 'DH'
        out.append({
            'player_id': p['player_id'],
            'best_slot': best_slot,
            'best_score': round(best_score, 4),
            'best_position': best_position,
            'eligible_positions': sorted(p['eligible_positions']) + (['DH'] if 'DH' not in p['eligible_positions'] else []),
            'wOBA': round(view['wOBA'], 3),
            'observed_wOBA': round(view.get('observed_wOBA', view['wOBA']), 3),
            'K_pct': round(view['K_pct'], 3),
            'BB_pct': round(view['BB_pct'], 3),
            'OBP': round(view['OBP'], 3),
            'SLG': round(view['SLG'], 3),
            'raw_pa': view.get('raw_pa', 0),
        })

    out.sort(key=lambda x: x['best_score'], reverse=True)
    return out[:top_n]
