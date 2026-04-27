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
from datetime import date, timedelta
from collections import defaultdict
from typing import Optional

from ..stats.split_stats import (
    compute_player_split_profile,
    compute_league_platoon_deltas,
    DEFAULT_HALF_LIFE_WEEKS,
    DEFAULT_REGRESSION_PA,
    _event_components,
    _aggregate_to_rates,
    PA_RESULT_TYPES,
)
from ..stats.lineup_engine import (
    optimize_batting_order,
    select_optimal_starters,
    rank_bench,
    LINEUP_POSITIONS,
)
from ..stats.advanced import _POS_TOKEN_MAP, DEFAULT_WEIGHTS


# Constants
DEFAULT_MIN_PA = 30
DEFAULT_MIN_POSITION_STARTS = 8
RECENT_FORM_DAYS = 14
RECENT_FORM_MIN_PA = 12  # Below this, no hot/cold designation
HOT_THRESHOLD = 0.050    # Recent wOBA must beat season by this much to be "hot"
COLD_THRESHOLD = -0.050


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
# Speed proxy — SB-and-CS rate per time on first base.
# Within-team z-score, clamped to [-2, +2].
# ============================================================

def _fetch_speed_inputs_bulk(cur, player_ids: list, season: int) -> dict:
    """Pull SB, CS, singles, walks, HBP for each player from batting_stats."""
    if not player_ids:
        return {}
    cur.execute(
        """
        SELECT player_id,
               COALESCE(stolen_bases, 0) AS sb,
               COALESCE(caught_stealing, 0) AS cs,
               COALESCE(hits, 0) - COALESCE(doubles, 0)
                 - COALESCE(triples, 0) - COALESCE(home_runs, 0) AS singles,
               COALESCE(walks, 0) AS walks,
               COALESCE(hit_by_pitch, 0) AS hbp
        FROM batting_stats
        WHERE player_id = ANY(%s) AND season = %s
        """,
        (player_ids, season),
    )
    return {r['player_id']: dict(r) for r in cur.fetchall()}


def _compute_team_speed_z(speed_inputs: dict) -> dict:
    """Compute within-team z-score of speed proxy for every player passed in.

    Speed proxy = (SB - 0.5 * CS) / (1B + BB + HBP). Per-team z-score, clamped
    to [-2, +2]. Players with no opportunities (denominator = 0) get 0.
    """
    proxies = {}
    for pid, si in speed_inputs.items():
        sb = float(si.get('sb') or 0)
        cs = float(si.get('cs') or 0)
        opps = float((si.get('singles') or 0) + (si.get('walks') or 0) + (si.get('hbp') or 0))
        proxies[pid] = ((sb - 0.5 * cs) / opps) if opps > 0 else 0.0

    if not proxies:
        return {}

    vals = list(proxies.values())
    mean = sum(vals) / len(vals)
    if len(vals) > 1:
        var = sum((v - mean) ** 2 for v in vals) / len(vals)
        stdev = var ** 0.5
    else:
        stdev = 0.0

    z_by_pid = {}
    for pid, proxy in proxies.items():
        if stdev > 0:
            z = (proxy - mean) / stdev
            z = max(-2.0, min(2.0, z))
        else:
            z = 0.0
        z_by_pid[pid] = z
    return z_by_pid


# ============================================================
# PBP stats — Contact%, Swing%, AIRPULL%, batted-ball mix, HR%, SB
# Bulk-fetched in one query for all eligible players.
# ============================================================

def _fetch_pbp_stats_bulk(cur, player_ids: list, season: int) -> dict:
    """Pull pitch-level + batted-ball stats for every player in one query.

    Returns: {player_id: {contact_pct, swing_pct, whiff_pct, air_pull_pct,
                          gb_pct, fb_pct, ld_pct, pu_pct, hr_pct, iso, sb_count}}.
    Missing values are None when sample is too small.
    """
    if not player_ids:
        return {}

    cur.execute(
        """
        SELECT
          ge.batter_player_id AS pid,
          SUM(COALESCE(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'K', '')), 0)) AS k_pitches,
          SUM(COALESCE(LENGTH(pitch_sequence) - LENGTH(REPLACE(pitch_sequence, 'F', '')), 0)) AS f_pitches,
          SUM(COALESCE(LENGTH(pitch_sequence), 0)) AS seq_total,
          COUNT(*) FILTER (WHERE was_in_play AND pitches_thrown IS NOT NULL) AS in_play,
          COUNT(*) FILTER (WHERE bb_type IS NOT NULL) AS bb_total,
          COUNT(*) FILTER (WHERE bb_type = 'GB') AS gb,
          COUNT(*) FILTER (WHERE bb_type = 'FB') AS fb,
          COUNT(*) FILTER (WHERE bb_type = 'LD') AS ld,
          COUNT(*) FILTER (WHERE bb_type = 'PU') AS pu,
          COUNT(*) FILTER (
            WHERE bb_type IN ('LD','FB')
              AND ((UPPER(p.bats) = 'R' AND field_zone = 'LEFT')
                OR (UPPER(p.bats) = 'L' AND field_zone = 'RIGHT'))
          ) AS air_pull,
          COUNT(*) FILTER (WHERE ge.result_type = 'home_run') AS hr,
          COUNT(*) FILTER (
            WHERE ge.result_type IN (
              'single','double','triple','home_run',
              'walk','intentional_walk','hbp',
              'strikeout_swinging','strikeout_looking',
              'ground_out','fly_out','line_out','pop_out',
              'sac_fly','sac_bunt','fielders_choice','error','double_play','other'
            )
          ) AS pa,
          COUNT(*) FILTER (WHERE ge.result_type = 'single') AS singles,
          COUNT(*) FILTER (WHERE ge.result_type = 'double') AS doubles,
          COUNT(*) FILTER (WHERE ge.result_type = 'triple') AS triples,
          COUNT(*) FILTER (
            WHERE ge.result_type IN (
              'single','double','triple','home_run',
              'strikeout_swinging','strikeout_looking',
              'ground_out','fly_out','line_out','pop_out',
              'fielders_choice','error','double_play','other'
            )
          ) AS ab
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        JOIN players p ON p.id = ge.batter_player_id
        WHERE ge.batter_player_id = ANY(%s)
          AND g.season = %s
        GROUP BY ge.batter_player_id
        """,
        (player_ids, season),
    )

    out = {}
    for r in cur.fetchall():
        pid = r['pid']
        k_p = r['k_pitches'] or 0
        f_p = r['f_pitches'] or 0
        seq = r['seq_total'] or 0
        in_play = r['in_play'] or 0
        bb_total = r['bb_total'] or 0
        pa = r['pa'] or 0
        ab = r['ab'] or 0
        hr = r['hr'] or 0

        swings = k_p + f_p + in_play
        contact = f_p + in_play
        total_pitches = seq + in_play

        def _safe(num, denom):
            return (num / denom) if denom else None

        # ISO = SLG - AVG = (TB - hits) / AB
        h = (r['singles'] or 0) + (r['doubles'] or 0) + (r['triples'] or 0) + hr
        tb = (r['singles'] or 0) + 2 * (r['doubles'] or 0) + 3 * (r['triples'] or 0) + 4 * hr
        iso = ((tb - h) / ab) if ab else None
        slg = (tb / ab) if ab else None

        out[pid] = {
            'contact_pct': _safe(contact, swings),
            'swing_pct': _safe(swings, total_pitches),
            'whiff_pct': _safe(k_p, swings),
            'air_pull_pct': _safe(r['air_pull'] or 0, bb_total),
            'gb_pct': _safe(r['gb'] or 0, bb_total),
            'fb_pct': _safe(r['fb'] or 0, bb_total),
            'ld_pct': _safe(r['ld'] or 0, bb_total),
            'pu_pct': _safe(r['pu'] or 0, bb_total),
            'hr_pct': _safe(hr, pa),
            'iso': iso,
            'slg': slg,
            'bb_total': bb_total,
            'pitches_seen': total_pitches,
        }
    return out


# ============================================================
# Recent form (last 14 days) — for hot/cold indicator
# ============================================================

def _compute_recent_form(
    cur,
    player_id: int,
    season: int,
    season_woba: float,
    division_level: str,
    days: int = RECENT_FORM_DAYS,
    reference_date: Optional[date] = None,
) -> dict:
    """Compute the player's wOBA over the last `days` days, with no recency
    decay. Used to flag hot/cold players relative to their season baseline.
    """
    if reference_date is None:
        reference_date = date.today()
    cutoff = reference_date - timedelta(days=days)

    weights = DEFAULT_WEIGHTS.get(division_level, DEFAULT_WEIGHTS['NAIA'])

    cur.execute(
        """
        SELECT ge.result_type, g.game_date
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        WHERE ge.batter_player_id = %s
          AND g.season = %s
          AND g.game_date >= %s
          AND g.game_date <= %s
          AND ge.result_type IS NOT NULL
        """,
        (player_id, season, cutoff, reference_date),
    )
    rows = cur.fetchall()

    agg = {'pa': 0.0, 'ab': 0.0, 'sf': 0.0, 'bb': 0.0, 'hbp': 0.0, 'ibb': 0.0,
           'singles': 0.0, 'doubles': 0.0, 'triples': 0.0, 'hr': 0.0,
           'tb': 0.0, 'woba_num': 0.0, 'k': 0.0, 'sh': 0.0, 'out': 0.0,
           'on_base': 0.0}
    pa_count = 0
    for r in rows:
        if r['result_type'] not in PA_RESULT_TYPES:
            continue
        comps = _event_components(r, weights)
        if comps['pa'] == 0:
            continue
        pa_count += 1
        for k_, v in comps.items():
            agg[k_] = agg.get(k_, 0.0) + v

    if pa_count < RECENT_FORM_MIN_PA:
        return {
            'recent_pa': pa_count,
            'recent_wOBA': None,
            'delta_vs_season': None,
            'status': 'unknown',
            'days': days,
        }

    rates = _aggregate_to_rates(agg)
    delta = rates['wOBA'] - season_woba
    if delta >= HOT_THRESHOLD:
        status = 'hot'
    elif delta <= COLD_THRESHOLD:
        status = 'cold'
    else:
        status = 'neutral'

    return {
        'recent_pa': pa_count,
        'recent_wOBA': round(rates['wOBA'], 3),
        'delta_vs_season': round(delta, 3),
        'status': status,
        'days': days,
    }


# ============================================================
# Reasoning generators
# ============================================================

def _fmt_woba(v):
    return f"{v:.3f}".lstrip('0') if v >= 0 else f"-{abs(v):.3f}".lstrip('0')


def _fmt_pct(v):
    return f"{v*100:.1f}%"


def _explain_starter_slot(slot: int, entry: dict, all_starters: list) -> str:
    """One-sentence reasoning for why this player got this slot.

    Cites the actual stat that drove the decision per the new 7-stat formula:
    OBP, SLG/ISO, Contact%, GB%, K%, BB%, speed_z. Picks the most relevant
    stat for the slot and reports the player's rank or absolute value.
    """
    obp = entry.get('OBP', 0) or 0
    slg = entry.get('SLG', 0) or 0
    iso = entry.get('ISO', 0) or 0
    k_pct = entry['K_pct']
    bb_pct = entry['BB_pct']
    contact = entry.get('Contact_pct')
    gb = entry.get('GB_pct')
    spd = entry.get('speed_z', 0) or 0

    all_obp = sorted([s.get('OBP', 0) or 0 for s in all_starters], reverse=True)
    all_slg = sorted([s.get('SLG', 0) or 0 for s in all_starters], reverse=True)
    all_iso = sorted([s.get('ISO', 0) or 0 for s in all_starters], reverse=True)
    all_k = sorted([s['K_pct'] for s in all_starters])
    obp_rank = all_obp.index(obp) + 1 if obp in all_obp else None
    slg_rank = all_slg.index(slg) + 1 if slg in all_slg else None
    iso_rank = all_iso.index(iso) + 1 if iso in all_iso else None
    k_rank = all_k.index(k_pct) + 1 if k_pct in all_k else None

    if slot == 1:
        bits = []
        if k_rank and k_rank <= 2:
            bits.append(f"lowest-K bat in the lineup ({_fmt_pct(k_pct)})")
        if contact is not None and contact >= 0.78:
            bits.append(f"high contact ({_fmt_pct(contact)})")
        if spd >= 1.0:
            bits.append("plus team-relative speed")
        if not bits:
            bits.append("contact-and-OBP profile")
        return f"Leadoff: {', '.join(bits)}."
    if slot == 2:
        bits = []
        if obp_rank == 1:
            bits.append(f"team-best OBP ({_fmt_woba(obp)})")
        elif obp_rank and obp_rank <= 3:
            bits.append(f"top-3 OBP ({_fmt_woba(obp)})")
        if contact is not None and contact >= 0.80:
            bits.append(f"elite contact rate ({_fmt_pct(contact)})")
        if gb is not None and gb < 0.40:
            bits.append("avoids ground balls (low DP risk)")
        if not bits:
            bits.append("highest-leverage on-base profile")
        return f"2-hole — the highest-leverage spot per The Book: {', '.join(bits)}."
    if slot == 3:
        # Slot 3 weights SLG nearly as much as slot 4 (175 vs 200). High-SLG
        # hitters whose OBP just trails the slot-2 winner often land here.
        if slg_rank and slg_rank <= 2:
            return (f"Top-{slg_rank} SLG ({_fmt_woba(slg)}) lands him here. "
                    "Slot 3 weights SLG nearly as much as slot 4 — his power "
                    "profile fits even though his OBP just trails the slot-2 winner.")
        return ("Per The Book, #3 sees the most 2-out empty PAs of any top-5 slot. "
                "Lower-leverage among the top-5 by design.")
    if slot == 4:
        bits = []
        if iso_rank == 1:
            bits.append(f"team-best ISO ({iso:.3f})")
        elif slg_rank == 1:
            bits.append(f"team-best SLG ({_fmt_woba(slg)})")
        elif iso_rank and iso_rank <= 2:
            bits.append(f"top-2 ISO ({iso:.3f})")
        if obp_rank and obp_rank <= 3:
            bits.append(f"top-3 OBP ({_fmt_woba(obp)})")
        if not bits:
            bits.append("best power bat available")
        return f"Cleanup: {', '.join(bits)}."
    if slot == 5:
        bits = [f"second power bat ({_fmt_woba(slg)} SLG, {iso:.3f} ISO)"]
        return f"Protects the cleanup hitter: {', '.join(bits)}."
    if slot == 6:
        return f"Mid-order continuation ({_fmt_woba(obp)} OBP, {_fmt_woba(slg)} SLG)."
    if slot == 7:
        return f"Lower-order placement ({_fmt_woba(obp)} OBP)."
    if slot == 8:
        bits = []
        if contact is not None and contact >= 0.80:
            bits.append(f"strong contact ({_fmt_pct(contact)})")
        if k_pct <= 0.15:
            bits.append(f"low K% ({_fmt_pct(k_pct)})")
        if not bits:
            bits.append("contact-leaning bat")
        return f"#8: {', '.join(bits)} — sets up the turnover."
    if slot == 9:
        bits = []
        if obp_rank and obp_rank <= 4:
            bits.append(f"strong OBP ({_fmt_woba(obp)})")
        if k_pct <= 0.16:
            bits.append(f"low K% ({_fmt_pct(k_pct)})")
        if spd >= 0.5:
            bits.append("plus team-relative speed")
        if not bits:
            bits.append(f"OBP-leaning profile ({_fmt_pct(bb_pct)} BB)")
        return f"Second leadoff: {', '.join(bits)} — feeds the top of the order."
    return ""


def _explain_bench(bench_entry: dict, starters_by_pos: dict) -> str:
    """Why is this player on the bench? Cites the OBP/SLG/Contact mismatch."""
    eligible = set(bench_entry.get('eligible_positions', []))
    eligible.discard('DH')

    if not eligible:
        return "DH-only role — lost out to a stronger bat at DH."

    losses = []
    for pos in eligible:
        starter = starters_by_pos.get(pos)
        if starter:
            losses.append((pos, starter))

    if not losses:
        return "All eligible positions taken by stronger bats."

    # Pick the position where they have the closest call — same position, smallest score gap.
    # We don't have score directly here; use OBP gap as proxy.
    losses.sort(key=lambda x: abs((x[1].get('OBP', 0) or 0) - (bench_entry.get('OBP', 0) or 0)))
    pos, starter = losses[0]
    starter_name = f"{starter['first_name']} {starter['last_name']}"
    bench_obp = bench_entry.get('OBP', 0) or 0
    starter_obp = starter.get('OBP', 0) or 0
    bench_slg = bench_entry.get('SLG', 0) or 0
    starter_slg = starter.get('SLG', 0) or 0

    # Identify the most distinguishing stat
    if starter_obp - bench_obp >= 0.020:
        return f"Behind {starter_name} at {pos} — {starter_name}'s higher OBP ({_fmt_woba(starter_obp)} vs {_fmt_woba(bench_obp)}) wins the slot fit."
    if starter_slg - bench_slg >= 0.030:
        return f"Behind {starter_name} at {pos} — {starter_name}'s higher SLG ({_fmt_woba(starter_slg)} vs {_fmt_woba(bench_slg)}) wins the slot fit."
    return f"Behind {starter_name} at {pos} — close call decided by the K%/BB%/contact mix."


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
    overrides: Optional[dict] = None,
) -> dict:
    """Build the full Lineup Helper response for a team.

    Args:
        overrides: optional {'vs_RHP': [{'player_id': X, 'position': 'C'}, ... 9 entries],
                              'vs_LHP': [...]}.
                   When provided for a side, those 9 players are used as starters
                   (no auto-selection) and only the batting order is optimized.
                   Bench is still computed from non-starter eligible players.
    """
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

    # Bulk-fetch PBP stats (Contact%, Swing%, AIRPULL%, batted-ball mix, ISO, etc.)
    pbp_stats = _fetch_pbp_stats_bulk(cur, [r['id'] for r in roster], season)

    # Speed proxy: (SB - 0.5*CS) / (1B + BB + HBP), z-scored within team.
    speed_inputs = _fetch_speed_inputs_bulk(cur, [r['id'] for r in roster], season)
    speed_z_by_pid = _compute_team_speed_z(speed_inputs)

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
        # Recent form (hot/cold) — uses the season-view wOBA as the baseline
        recent_form = _compute_recent_form(
            cur, r['id'], season,
            season_woba=profile['season_view']['wOBA'],
            division_level=division_level,
            reference_date=reference_date,
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
            'recent_form': recent_form,
            'pbp_stats': pbp_stats.get(r['id'], {}),
            'speed_z': speed_z_by_pid.get(r['id'], 0.0),
            'speed_inputs': speed_inputs.get(r['id'], {}),
        })

    # For each pitcher hand, run the engine
    results = {}
    overrides = overrides or {}
    for vs_hand in ('R', 'L'):
        override = overrides.get(f'vs_{vs_hand}HP') or overrides.get(vs_hand)

        if override:
            # User-supplied 9 starters with positions: skip select_optimal_starters
            pid_to_player = {p['player_id']: p for p in eligible_players}
            try:
                starter_list = [pid_to_player[entry['player_id']] for entry in override]
            except KeyError as e:
                results[f'vs_{vs_hand}HP'] = {
                    'error': f'Override player {e.args[0]} not found in eligible roster.',
                    'starters': [], 'bench': [],
                }
                continue
            # Build a starter_pick-compatible dict for downstream reasoning
            starter_pick = {entry['position']: pid_to_player[entry['player_id']] for entry in override}
            starter_pids = {p['player_id'] for p in starter_list}
        else:
            starter_pick = select_optimal_starters(
                eligible_players, vs_hand, speeds_by_pid=speed_z_by_pid
            )
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

        # Pass profiles + speed_z list (in same order) to the batting-order optimizer
        profiles_for_order = [s['profile'] for s in starter_list]
        speeds_for_order = [speed_z_by_pid.get(s['player_id'], 0.0) for s in starter_list]
        order_result = optimize_batting_order(
            profiles_for_order, vs_hand=vs_hand, speeds=speeds_for_order
        )

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
                'recent_form': base['recent_form'],
                'pbp_stats': base['pbp_stats'],
                'season_view': base['profile']['season_view'],
                'speed_inputs': base['speed_inputs'],
                'eligible_positions': sorted(base['eligible_positions']) + (
                    ['DH'] if 'DH' not in base['eligible_positions'] else []
                ),
            })

        # Per-slot reasoning (computed AFTER the full ordered list exists,
        # because reasoning compares each starter to the others)
        for s_entry in ordered_starters:
            s_entry['slot_reasoning'] = _explain_starter_slot(
                s_entry['slot'], s_entry, ordered_starters
            )

        # Bench
        bench = rank_bench(
            eligible_players, starter_pids, vs_hand, top_n=5,
            speeds_by_pid=speed_z_by_pid,
        )
        # Build a lookup of starters keyed by their assigned position so we
        # can explain bench players' losses.
        starters_by_pos = {
            entry['assigned_position']: entry
            for entry in ordered_starters
        }
        # Decorate bench with names + reasoning + recent form
        pid_to_player = {p['player_id']: p for p in eligible_players}
        for b in bench:
            base = pid_to_player[b['player_id']]
            b['first_name'] = base['first_name']
            b['last_name'] = base['last_name']
            b['bats'] = base['bats']
            b['jersey_number'] = base['jersey_number']
            b['headshot_url'] = base['headshot_url']
            b['recent_form'] = base['recent_form']
            b['pbp_stats'] = base['pbp_stats']
            b['season_view'] = base['profile']['season_view']
            b['speed_inputs'] = base['speed_inputs']
            b['bench_reasoning'] = _explain_bench(b, starters_by_pos)

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
    """Legacy manual mode (kept for backwards compatibility). Prefer
    `compute_build_lineup` which returns richer data."""
    return compute_build_lineup(
        cur,
        team_id=None,
        season=season,
        assignments=player_assignments,
        division_level_override=division_level,
        half_life_weeks=half_life_weeks,
        k_regress=k_regress,
        reference_date=reference_date,
        vs_hand=None,  # all three
    )


def compute_build_lineup(
    cur,
    team_id: Optional[int],
    season: int,
    assignments: list,
    vs_hand: Optional[str] = None,  # 'R', 'L', 'unknown', or None for all three
    division_level_override: Optional[str] = None,
    half_life_weeks: float = DEFAULT_HALF_LIFE_WEEKS,
    k_regress: float = DEFAULT_REGRESSION_PA,
    reference_date: Optional[date] = None,
) -> dict:
    """Build-from-scratch lineup with no position-eligibility or min-PA filter.

    Computes rich data (recent_form, pbp_stats, season_view, speed_z,
    slot reasoning) so the response is shape-compatible with auto mode.

    Args:
        assignments: list of {'player_id': X, 'position': 'C'} (length 9). The
                     same player_id can only appear once.
        vs_hand: 'R', 'L', 'unknown', or None to compute all three.
        team_id: if provided, used for division context and speed_z baseline.
                 If None, division_level_override must be provided.
    """
    if reference_date is None:
        reference_date = date.today()
    if len(assignments) != 9:
        return {'error': 'Build mode requires exactly 9 player assignments.'}
    if len({a['player_id'] for a in assignments}) != 9:
        return {'error': 'Each player can only appear once in the lineup.'}

    # Resolve division
    if team_id:
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
            return {'error': f'Team {team_id} not found.'}
        division_level = team_row['division_level']
    else:
        team_row = None
        division_level = division_level_override or 'NAIA'

    league_deltas = compute_league_platoon_deltas(
        cur, season, division_level, half_life_weeks, reference_date
    )

    pid_list = [a['player_id'] for a in assignments]
    pid_to_pos = {a['player_id']: a['position'] for a in assignments}

    # Pull player metadata
    cur.execute(
        """SELECT id, first_name, last_name, bats, jersey_number, headshot_url, position
           FROM players WHERE id = ANY(%s)""",
        (pid_list,),
    )
    pid_to_meta = {r['id']: dict(r) for r in cur.fetchall()}

    # Speed z-score baseline: if team_id is provided, use the team roster as
    # the reference population so a "fast" player here has the same meaning
    # as in auto mode. Otherwise z-score within the 9 chosen players.
    if team_id:
        cur.execute(
            "SELECT id FROM players WHERE team_id = %s",
            (team_id,),
        )
        baseline_pids = [r['id'] for r in cur.fetchall()]
    else:
        baseline_pids = pid_list
    speed_inputs = _fetch_speed_inputs_bulk(cur, baseline_pids, season)
    speed_z_by_pid = _compute_team_speed_z(speed_inputs)
    # Players in the 9 who weren't on the speed baseline (cross-team picks)
    # default to 0.0 (neutral)
    for pid in pid_list:
        speed_z_by_pid.setdefault(pid, 0.0)
        speed_inputs.setdefault(pid, {})

    # PBP stats for the 9
    pbp_stats = _fetch_pbp_stats_bulk(cur, pid_list, season)

    # Build profiles for the 9 in assignment order
    profiles = []
    rich_players = []
    for a in assignments:
        pid = a['player_id']
        profile = compute_player_split_profile(
            cur, pid, season,
            division_level=division_level,
            half_life_weeks=half_life_weeks,
            k_regress=k_regress,
            reference_date=reference_date,
            league_deltas=league_deltas,
        )
        recent_form = _compute_recent_form(
            cur, pid, season,
            season_woba=profile['season_view']['wOBA'],
            division_level=division_level,
            reference_date=reference_date,
        )
        meta = pid_to_meta.get(pid, {})
        rich_players.append({
            'player_id': pid,
            'first_name': meta.get('first_name'),
            'last_name': meta.get('last_name'),
            'bats': meta.get('bats'),
            'jersey_number': meta.get('jersey_number'),
            'headshot_url': meta.get('headshot_url'),
            'profile': profile,
            'recent_form': recent_form,
            'pbp_stats': pbp_stats.get(pid, {}),
            'speed_inputs': speed_inputs.get(pid, {}),
            'eligible_positions': [pid_to_pos[pid]],  # user-chosen, no eligibility filter
        })
        profiles.append(profile)

    speeds_for_order = [speed_z_by_pid.get(p['player_id'], 0.0) for p in rich_players]

    def _build_for_hand(vs_hand_arg):
        order_result = optimize_batting_order(
            profiles, vs_hand=vs_hand_arg, speeds=speeds_for_order,
        )
        pid_to_player = {p['player_id']: p for p in rich_players}
        ordered = []
        for entry in order_result['order']:
            base = pid_to_player[entry['player_id']]
            ordered.append({
                **entry,
                'first_name': base['first_name'],
                'last_name': base['last_name'],
                'bats': base['bats'],
                'jersey_number': base['jersey_number'],
                'headshot_url': base['headshot_url'],
                'assigned_position': pid_to_pos[entry['player_id']],
                'recent_form': base['recent_form'],
                'pbp_stats': base['pbp_stats'],
                'season_view': base['profile']['season_view'],
                'speed_inputs': base['speed_inputs'],
                'eligible_positions': base['eligible_positions'],
            })
        # Slot reasoning AFTER full ordered list exists
        for s_entry in ordered:
            s_entry['slot_reasoning'] = _explain_starter_slot(
                s_entry['slot'], s_entry, ordered
            )
        return {
            'starters': ordered,
            'bench': [],   # no bench in build mode (user chose all 9)
            'total_score': order_result['total_score'],
        }

    out = {
        'season': season,
        'as_of_date': reference_date.isoformat(),
        'mode': 'build',
    }
    if team_row:
        out['team'] = dict(team_row)

    hands_to_compute = (
        ['R', 'L', 'unknown'] if vs_hand is None else [vs_hand]
    )
    for h in hands_to_compute:
        key = 'vs_RHP' if h == 'R' else ('vs_LHP' if h == 'L' else 'vs_unknown')
        engine_arg = h if h in ('R', 'L') else None
        out[key] = _build_for_hand(engine_arg)
    return out
