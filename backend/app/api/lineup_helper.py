"""
Lineup Helper orchestration.

Bridges the database to the pure-Python lineup engine. Given a team_id and
season, this module:

1. Pulls every player on the team with 30+ PAs in the season.
2. Computes their position eligibility from `game_batting` (8+ starts at a
   position to be eligible there; everyone is implicitly DH-eligible).
3. Computes time-weighted, regression-adjusted split profiles for each.
4. Runs the optimal-starter selector twice (vs RHP, vs LHP).
5. Runs the batting-order optimizer on each starting 9.
6. Ranks the top 5 bench options vs each hand.
7. Returns a single response dict ready for the API endpoint.
"""

from __future__ import annotations

import re
from datetime import date
from collections import defaultdict
from typing import Optional

from ..stats.split_stats import (
    compute_player_split_profile,
    compute_league_platoon_deltas,
    DEFAULT_HALF_LIFE_WEEKS,
    DEFAULT_REGRESSION_PA,
)
from ..stats.lineup_engine import (
    optimize_batting_order,
    select_optimal_starters,
    rank_bench,
    LINEUP_POSITIONS,
)
from ..stats.advanced import _POS_TOKEN_MAP


# Constants
DEFAULT_MIN_PA = 30
DEFAULT_MIN_POSITION_STARTS = 8


# ============================================================
# Position eligibility from game_batting
# ============================================================

# Lineup-slot positions are concrete (no OF/IF/UT). When a box score lists a
# generic group, we credit the player at every concrete position the group
# implies.
_GROUP_EXPANSION = {
    'OF': {'LF', 'CF', 'RF'},
    'IF': {'1B', '2B', '3B', 'SS'},
    'UT': {'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'},
}


def _expand_position_string(raw: Optional[str]) -> set:
    """Tokenize a single-game position string and return all concrete
    lineup-slot positions credited."""
    if not raw:
        return set()
    out = set()
    tokens = re.split(r'[/,\-\s]+', raw.lower().strip())
    for tok in tokens:
        tok = tok.strip()
        if not tok:
            continue
        mapped = _POS_TOKEN_MAP.get(tok)
        if mapped is None:
            continue
        if mapped == 'P':
            continue  # We're picking hitters, ignore the pitching designation
        if mapped in _GROUP_EXPANSION:
            out.update(_GROUP_EXPANSION[mapped])
        elif mapped in ('C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'):
            out.add(mapped)
    return out


def _fetch_position_eligibility(cur, team_id: int, season: int, min_starts: int) -> dict:
    """Return {player_id: set_of_eligible_positions}.

    A player is eligible at a position if they have `min_starts` or more
    games at that position (concrete positions only — OF/IF/UT are expanded
    into their components).
    """
    cur.execute(
        """
        SELECT gb.player_id, gb.game_id, gb.position
        FROM game_batting gb
        JOIN games g ON g.id = gb.game_id
        JOIN players p ON p.id = gb.player_id
        WHERE p.team_id = %s
          AND g.season = %s
          AND gb.position IS NOT NULL
        """,
        (team_id, season),
    )
    # (player_id, position) -> set of game_ids
    starts = defaultdict(lambda: defaultdict(set))
    for row in cur.fetchall():
        positions = _expand_position_string(row['position'])
        for pos in positions:
            starts[row['player_id']][pos].add(row['game_id'])

    eligibility = {}
    for pid, pos_dict in starts.items():
        eligibility[pid] = {pos for pos, gids in pos_dict.items() if len(gids) >= min_starts}
    return eligibility


# ============================================================
# Eligible-player roster
# ============================================================

def _fetch_eligible_players(
    cur,
    team_id: int,
    season: int,
    min_pa: int,
) -> list:
    """Return team players with `min_pa` or more PAs in the season,
    each as a dict ready for the engine."""
    cur.execute(
        """
        SELECT p.id, p.first_name, p.last_name, p.bats, p.throws, p.position,
               p.headshot_url, p.jersey_number,
               COUNT(*) FILTER (WHERE ge.result_type IS NOT NULL) AS pa
        FROM players p
        LEFT JOIN game_events ge ON ge.batter_player_id = p.id
        LEFT JOIN games g ON g.id = ge.game_id AND g.season = %s
        WHERE p.team_id = %s
        GROUP BY p.id
        HAVING COUNT(*) FILTER (WHERE ge.result_type IS NOT NULL) >= %s
        ORDER BY pa DESC
        """,
        (season, team_id, min_pa),
    )
    return cur.fetchall()


# ============================================================
# The main entry point
# ============================================================

def compute_team_lineup_helper(
    cur,
    team_id: int,
    season: int,
    min_pa: int = DEFAULT_MIN_PA,
    min_position_starts: int = DEFAULT_MIN_POSITION_STARTS,
    half_life_weeks: float = DEFAULT_HALF_LIFE_WEEKS,
    k_regress: float = DEFAULT_REGRESSION_PA,
    reference_date: Optional[date] = None,
) -> dict:
    """Build the full Lineup Helper response for a team."""
    if reference_date is None:
        reference_date = date.today()

    # Fetch team metadata
    cur.execute(
        """
        SELECT t.id, t.name, t.short_name, t.logo_url, c.name AS conference_name,
               d.level AS division_level, d.name AS division_name
        FROM teams t
        JOIN conferences c ON c.id = t.conference_id
        JOIN divisions d ON d.id = c.division_id
        WHERE t.id = %s
        """,
        (team_id,),
    )
    team_row = cur.fetchone()
    if not team_row:
        return {'error': f'Team {team_id} not found'}
    division_level = team_row['division_level']

    # Pull eligible players
    roster = _fetch_eligible_players(cur, team_id, season, min_pa)
    if len(roster) < 9:
        return {
            'team': dict(team_row),
            'season': season,
            'error': f'Only {len(roster)} hitters with {min_pa}+ PAs. Need 9.',
            'eligible_count': len(roster),
        }

    # Position eligibility
    eligibility = _fetch_position_eligibility(cur, team_id, season, min_position_starts)

    # League deltas (computed once)
    league_deltas = compute_league_platoon_deltas(
        cur, season, division_level, half_life_weeks, reference_date
    )

    # Build profiles for every eligible player
    eligible_players = []
    for r in roster:
        profile = compute_player_split_profile(
            cur, r['id'], season,
            division_level=division_level,
            half_life_weeks=half_life_weeks,
            k_regress=k_regress,
            reference_date=reference_date,
            league_deltas=league_deltas,
        )
        eligible_players.append({
            'player_id': r['id'],
            'first_name': r['first_name'],
            'last_name': r['last_name'],
            'bats': r['bats'],
            'jersey_number': r['jersey_number'],
            'headshot_url': r['headshot_url'],
            'position_listed': r['position'],
            'pa_total': r['pa'],
            'profile': profile,
            'eligible_positions': eligibility.get(r['id'], set()),
        })

    # For each pitcher hand, run the engine
    results = {}
    for vs_hand in ('R', 'L'):
        starter_pick = select_optimal_starters(eligible_players, vs_hand)
        if starter_pick is None:
            results[f'vs_{vs_hand}HP'] = {
                'error': 'No feasible starting 9 — likely missing position eligibility somewhere (e.g., no eligible catcher).',
                'starters': [],
                'bench': [],
            }
            continue

        # Build the 9 starters in a list, with their assigned position
        starter_list = []
        starter_pids = set()
        for pos in LINEUP_POSITIONS:
            entry = starter_pick[pos]
            starter_list.append(entry)
            starter_pids.add(entry['player_id'])

        # Pass profiles to the batting-order optimizer
        profiles_for_order = [s['profile'] for s in starter_list]
        order_result = optimize_batting_order(profiles_for_order, vs_hand=vs_hand)

        # Merge: attach assigned position + name to each ordered slot
        pid_to_starter = {s['player_id']: s for s in starter_list}
        pid_to_assigned_pos = {starter_pick[pos]['player_id']: pos for pos in LINEUP_POSITIONS}
        ordered_starters = []
        for entry in order_result['order']:
            base = pid_to_starter[entry['player_id']]
            ordered_starters.append({
                **entry,
                'first_name': base['first_name'],
                'last_name': base['last_name'],
                'bats': base['bats'],
                'jersey_number': base['jersey_number'],
                'headshot_url': base['headshot_url'],
                'assigned_position': pid_to_assigned_pos[entry['player_id']],
                'pa_total': base['pa_total'],
            })

        # Bench
        bench = rank_bench(eligible_players, starter_pids, vs_hand, top_n=5)
        # Decorate bench with names
        pid_to_player = {p['player_id']: p for p in eligible_players}
        for b in bench:
            base = pid_to_player[b['player_id']]
            b['first_name'] = base['first_name']
            b['last_name'] = base['last_name']
            b['bats'] = base['bats']
            b['jersey_number'] = base['jersey_number']
            b['headshot_url'] = base['headshot_url']

        results[f'vs_{vs_hand}HP'] = {
            'starters': ordered_starters,
            'bench': bench,
            'total_score': order_result['total_score'],
        }

    return {
        'team': dict(team_row),
        'season': season,
        'as_of_date': reference_date.isoformat(),
        'config': {
            'min_pa': min_pa,
            'min_position_starts': min_position_starts,
            'half_life_weeks': half_life_weeks,
            'k_regress': k_regress,
        },
        'eligible_count': len(eligible_players),
        'vs_RHP': results['vs_RHP'],
        'vs_LHP': results['vs_LHP'],
    }


# ============================================================
# Manual mode
# ============================================================

def compute_manual_lineup(
    cur,
    player_assignments: list,
    season: int,
    division_level: str,
    half_life_weeks: float = DEFAULT_HALF_LIFE_WEEKS,
    k_regress: float = DEFAULT_REGRESSION_PA,
    reference_date: Optional[date] = None,
) -> dict:
    """Manual mode: user gives 9 (player_id, position) pairs, we order them.

    Args:
        player_assignments: [{'player_id': 123, 'position': 'C'}, ...] (length 9)
    """
    if reference_date is None:
        reference_date = date.today()
    if len(player_assignments) != 9:
        return {'error': 'Manual mode requires exactly 9 player assignments.'}

    league_deltas = compute_league_platoon_deltas(
        cur, season, division_level, half_life_weeks, reference_date
    )

    # Build profiles for the 9
    profiles = []
    for pa in player_assignments:
        profile = compute_player_split_profile(
            cur, pa['player_id'], season,
            division_level=division_level,
            half_life_weeks=half_life_weeks,
            k_regress=k_regress,
            reference_date=reference_date,
            league_deltas=league_deltas,
        )
        profiles.append(profile)

    # Run optimizer for both hands
    vs_r = optimize_batting_order(profiles, vs_hand='R')
    vs_l = optimize_batting_order(profiles, vs_hand='L')

    # Decorate with player metadata
    pid_list = [pa['player_id'] for pa in player_assignments]
    cur.execute(
        """SELECT id, first_name, last_name, bats, jersey_number, headshot_url
           FROM players WHERE id = ANY(%s)""",
        (pid_list,),
    )
    pid_to_meta = {r['id']: dict(r) for r in cur.fetchall()}
    pid_to_pos = {pa['player_id']: pa['position'] for pa in player_assignments}

    def _decorate(order_result):
        out = []
        for entry in order_result['order']:
            meta = pid_to_meta.get(entry['player_id'], {})
            out.append({
                **entry,
                'first_name': meta.get('first_name'),
                'last_name': meta.get('last_name'),
                'bats': meta.get('bats'),
                'jersey_number': meta.get('jersey_number'),
                'headshot_url': meta.get('headshot_url'),
                'assigned_position': pid_to_pos[entry['player_id']],
            })
        return {'order': out, 'total_score': order_result['total_score'], 'vs_hand': order_result['vs_hand']}

    return {
        'season': season,
        'as_of_date': reference_date.isoformat(),
        'vs_RHP': _decorate(vs_r),
        'vs_LHP': _decorate(vs_l),
    }
