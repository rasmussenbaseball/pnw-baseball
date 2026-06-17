"""
Build backend/data/pnw_draft.json — the data feed for the PNW Draft game
(a 162-0 / 82-0 style "build the best roster" game for PNW college baseball).

Each round the player spins a random level + team and drafts one player from
that team into a position-locked lineup (9 hitters) + pitching staff (5). When
the roster is full, a level-aware model grades it into a stylized W-L record.

WHY A GENERATOR (not a hand-pasted blob): rosters/stats change all season, and
the win-mapping normalization constants must be recomputed from the live pool
or the records drift. Run this whenever you want to refresh the game:

    PYTHONPATH=backend python3 scripts/build_pnw_draft_json.py

Talks to PROD Supabase directly (get_connection loads .env). Writes the JSON;
the frontend reads it via GET /api/v1/pnw-draft.

KEY DESIGN POINTS
- Level adjustment: raw AVG/OBP/SLG are NOT comparable across levels (JUCO mean
  AVG ~.241 vs D2/D3/NAIA ~.285), so scoring uses level-RELATIVE wRC+ / FIP+
  (100 = average at that level) scaled by a division-strength multiplier
  (LEVEL_STR) so a 150 wRC+ at JUCO is worth less than a 150 at D1. The
  multipliers are the one tunable knob — adjust LEVEL_STR and re-run.
- Sample filters: hitters need >= MIN_PA, pitchers >= MIN_IP (kills fluke
  small-sample .500 cameos / 0.00 ERA relievers). g=0 rows are dropped.
- Position is assigned from game_batting (games per position, regular season),
  the same authoritative source the All-Conference generator uses — NOT the
  free-text players.position field (which is chaos: "OF", "INF", "UTL", ...).
- Every entry carries pid (player_id) so the frontend can block drafting a
  two-way player as both a hitter AND a pitcher (same human, two slots).
- Win-mapping constants (mean/std/k of the talent total over random rosters,
  plus best/worst) are computed here and stored in meta, so the curve stays
  calibrated and is gentler than a raw min-max (no more 11% blowout rosters).
"""
import sys, os, json, random
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))
from app.models.database import get_connection
try:
    from app.config import CURRENT_SEASON
except Exception:
    CURRENT_SEASON = 2026

OUT_PATH = os.path.join(os.path.dirname(__file__), '..', 'backend', 'data', 'pnw_draft.json')

MIN_PA = 40
MIN_IP = 20.0
ELIG_MIN_GAMES = 5   # games at a position to qualify there (for multi-position)

# Division-strength multipliers — absolute quality of an AVERAGE player at each
# level, D1 = 1.00 baseline. This is what makes cross-level rosters fair: a
# level-relative 150 wRC+ is multiplied by the level's strength so lower-level
# rate inflation doesn't dominate. TUNE THESE and re-run if the mix feels off.
LEVEL_STR = {
    "D1":   1.00,
    "D2":   0.90,
    "NAIA": 0.85,
    "JUCO": 0.84,   # NWAC
    "D3":   0.80,
}

HPOS = ['C', '1B', '2B', 'SS', '3B', 'RF', 'CF', 'LF', 'DH']
N_PITCHERS = 5
WEIGHT_H = 0.55
WEIGHT_P = 0.45


def norm_pos(raw):
    """Normalize a raw box-score position into a lineup bucket (or None)."""
    if not raw:
        return None
    s = raw.strip().upper().split('/')[0]
    aliases = {
        'C': 'C', '1B': '1B', '2B': '2B', '3B': '3B', 'SS': 'SS',
        'LF': 'LF', 'CF': 'CF', 'RF': 'RF', 'DH': 'DH',
        'OF': 'OF',  # generic outfield, resolved later
        'P': None, 'RHP': None, 'LHP': None, 'PH': None, 'PR': None, 'IF': None,
    }
    return aliases.get(s)


def assign_positions(cur, season, team_ids):
    """player_id -> primary lineup position, from regular-season game_batting."""
    cur.execute("""
        SELECT gb.player_id, gb.position,
               COUNT(DISTINCT (g.game_date, COALESCE(g.game_number, 1))) AS games
        FROM game_batting gb
        JOIN games g ON g.id = gb.game_id
        WHERE gb.player_id IS NOT NULL
          AND g.season = %s
          AND gb.team_id = ANY(%s)
          AND gb.position IS NOT NULL AND gb.position NOT IN ('', '-')
          AND (g.is_postseason IS NULL OR g.is_postseason = FALSE)
        GROUP BY gb.player_id, gb.position
    """, (season, team_ids))
    pg = {}
    for r in cur.fetchall():
        np = norm_pos(r['position'])
        if not np:
            continue
        pg.setdefault(r['player_id'], {})
        pg[r['player_id']][np] = pg[r['player_id']].get(np, 0) + (r['games'] or 0)

    primary = {}
    eligible = {}  # pid -> [positions], primary first, where they played >= ELIG_MIN_GAMES
    for pid, counts in pg.items():
        # Best specific lineup position by games.
        specific = {p: g for p, g in counts.items() if p in HPOS}
        if specific:
            prim = max(specific, key=specific.get)
            primary[pid] = prim
            # Multi-position: any specific position with enough games qualifies.
            elig = [p for p, g in specific.items() if g >= ELIG_MIN_GAMES]
            if prim not in elig:
                elig.append(prim)
            # Order primary first, then the rest in lineup order.
            eligible[pid] = [prim] + [p for p in HPOS if p in elig and p != prim]
        elif counts.get('OF'):
            primary[pid] = 'LF'   # generic-OF-only → corner default
            eligible[pid] = ['LF']
        # else: leave unassigned (only DH/PH/PR/IF generic) → filled by fallback
    return primary, eligible


def main():
    season = CURRENT_SEASON
    with get_connection() as conn:
        cur = conn.cursor()

        # All active teams with their level + short name
        cur.execute("""
            SELECT t.id, t.short_name, d.level
            FROM teams t
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE t.is_active = 1
        """)
        teams = {r['id']: {'short': r['short_name'], 'level': r['level']} for r in cur.fetchall()}
        team_ids = list(teams.keys())

        primary_pos, eligible_pos = assign_positions(cur, season, team_ids)

        # Hitters (qualified)
        cur.execute("""
            SELECT bs.player_id, bs.team_id, p.first_name, p.last_name, p.position AS listed,
                   bs.games, bs.plate_appearances,
                   bs.batting_avg, bs.on_base_pct, bs.slugging_pct,
                   bs.home_runs, bs.rbi, bs.wrc_plus, bs.offensive_war
            FROM batting_stats bs
            JOIN players p ON p.id = bs.player_id
            WHERE bs.season = %s AND bs.team_id = ANY(%s)
              AND bs.plate_appearances >= %s
              AND COALESCE(bs.games, 0) > 0
              AND bs.wrc_plus IS NOT NULL
              AND bs.batting_avg IS NOT NULL
        """, (season, team_ids, MIN_PA))
        hitters = []
        for r in cur.fetchall():
            team = teams.get(r['team_id'])
            if not team or team['level'] not in LEVEL_STR:
                continue
            pos = primary_pos.get(r['player_id'])
            elig = eligible_pos.get(r['player_id'])
            if not pos:
                pos = norm_pos(r['listed']) if norm_pos(r['listed']) in HPOS else 'DH'
                if pos == 'OF':
                    pos = 'LF'
            if not elig:
                elig = [pos]
            off = float(r['wrc_plus']) * LEVEL_STR[team['level']]
            hitters.append({
                'pid': r['player_id'], 'n': f"{r['first_name'] or ''} {r['last_name'] or ''}".strip(),
                't': team['short'], 'p': pos, 'elig': elig, 'l': team['level'],
                'avg': round(float(r['batting_avg']), 3),
                'obp': round(float(r['on_base_pct'] or 0), 3),
                'slg': round(float(r['slugging_pct'] or 0), 3),
                'hr': int(r['home_runs'] or 0), 'rbi': int(r['rbi'] or 0),
                'wrc': round(float(r['wrc_plus']), 0),
                'war': round(float(r['offensive_war'] or 0), 2),
                'g': int(r['games'] or 0),
                'off': round(off, 1),
            })

        # Pitchers (qualified)
        cur.execute("""
            SELECT ps.player_id, ps.team_id, p.first_name, p.last_name,
                   ps.games, ps.games_started, ps.innings_pitched, ps.era, ps.whip, ps.k_per_9,
                   ps.fip, ps.fip_plus, ps.wins, ps.saves, ps.pitching_war
            FROM pitching_stats ps
            JOIN players p ON p.id = ps.player_id
            WHERE ps.season = %s AND ps.team_id = ANY(%s)
              AND ps.innings_pitched IS NOT NULL
              AND ps.fip_plus IS NOT NULL
              AND ps.era IS NOT NULL
        """, (season, team_ids))
        pitchers = []
        for r in cur.fetchall():
            team = teams.get(r['team_id'])
            if not team or team['level'] not in LEVEL_STR:
                continue
            # innings_pitched is baseball notation (6.2 = 6 2/3); convert for the filter
            ip_raw = float(r['innings_pitched'])
            whole = int(ip_raw)
            ip_real = whole + (round((ip_raw - whole) * 10) / 3.0)
            if ip_real < MIN_IP:
                continue
            pit = float(r['fip_plus']) * LEVEL_STR[team['level']]
            g = int(r['games'] or 0)
            gs = int(r['games_started'] or 0)
            # Reliever = primarily relief appearances (or has saves). Drives the
            # RP badge AND which staff slot the pick fills.
            is_rp = (gs < g * 0.5) or int(r['saves'] or 0) > 0
            pitchers.append({
                'pid': r['player_id'], 'n': f"{r['first_name'] or ''} {r['last_name'] or ''}".strip(),
                't': team['short'], 'l': team['level'],
                'era': round(float(r['era']), 2),
                'whip': round(float(r['whip'] or 0), 2),
                'k9': round(float(r['k_per_9'] or 0), 1),
                'fip': round(float(r['fip'] or 0), 2),
                'ip': round(ip_real, 1),
                'w': int(r['wins'] or 0), 'sv': int(r['saves'] or 0),
                'g': g, 'gs': gs, 'rp': is_rp,
                'war': round(float(r['pitching_war'] or 0), 2),
                'pit': round(pit, 1),
            })

    # ── Teams structure: per level, the short_names that have any qualifying player ──
    teams_by_level = {}
    have_player = set(h['t'] for h in hitters) | set(p['t'] for p in pitchers)
    for tid, info in teams.items():
        if info['level'] in LEVEL_STR and info['short'] in have_player:
            teams_by_level.setdefault(info['level'], set()).add(info['short'])
    teams_by_level = {lv: sorted(v) for lv, v in teams_by_level.items()}

    # ── Calibrate win-mapping over the talent totals ──
    def hs_of(hs):  # mean offense talent
        return sum(x['off'] for x in hs) / len(hs)

    def ps_of(ps):  # IP-weighted pitching talent
        tot_ip = sum(x['ip'] for x in ps) or 1.0
        return sum(x['pit'] * x['ip'] for x in ps) / tot_ip

    def total_of(hs, ps):
        return WEIGHT_H * hs_of(hs) + WEIGHT_P * ps_of(ps)

    by_pos = {pos: [h for h in hitters if h['p'] == pos] for pos in HPOS}
    # Best/worst achievable (DH can be any hitter, so best DH = best leftover hitter)
    best_h = []
    for pos in HPOS:
        pool = by_pos[pos] if by_pos[pos] else hitters
        best_h.append(max(pool, key=lambda x: x['off']))
    best_p = sorted(pitchers, key=lambda x: -x['pit'])[:N_PITCHERS]
    worst_h = []
    for pos in HPOS:
        pool = by_pos[pos] if by_pos[pos] else hitters
        worst_h.append(min(pool, key=lambda x: x['off']))
    worst_p = sorted(pitchers, key=lambda x: x['pit'])[:N_PITCHERS]
    best_total = total_of(best_h, best_p)
    worst_total = total_of(worst_h, worst_p)

    random.seed(7)
    totals = []
    for _ in range(8000):
        hs = [random.choice(by_pos[pos] or hitters) for pos in HPOS]
        ps = random.sample(pitchers, N_PITCHERS)
        totals.append(total_of(hs, ps))
    mean = sum(totals) / len(totals)

    # Win mapping = piecewise-linear through three anchors:
    #   worst-possible roster -> 3 wins, average (random) roster -> 30,
    #   best-possible roster -> 56. Gives full dynamic range (a careless
    #   roster can bottom out, an optimized one reaches a clean sweep)
    #   while keeping the typical roster respectable.
    WORST_WINS, CENTER_WINS, BEST_WINS = 3.0, 30.0, 56.0

    def wins(total):
        if total <= mean:
            frac = (total - worst_total) / max(mean - worst_total, 1e-6)
            w = WORST_WINS + frac * (CENTER_WINS - WORST_WINS)
        else:
            frac = (total - mean) / max(best_total - mean, 1e-6)
            w = CENTER_WINS + frac * (BEST_WINS - CENTER_WINS)
        return max(0, min(56, round(w)))

    # 0-100 bar bounds from the worst/best achievable single-roster means
    off_lo, off_hi = hs_of(worst_h), hs_of(best_h)
    pit_lo, pit_hi = ps_of(worst_p), ps_of(best_p)

    meta = {
        'season': season,
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'n_hitters': len(hitters), 'n_pitchers': len(pitchers),
        'level_str': LEVEL_STR, 'min_pa': MIN_PA, 'min_ip': MIN_IP,
        'weights': {'h': WEIGHT_H, 'p': WEIGHT_P},
        'games': 56,
        'win_map': {'worst_total': round(worst_total, 3), 'mean': round(mean, 3),
                    'best_total': round(best_total, 3),
                    'worst_wins': WORST_WINS, 'center_wins': CENTER_WINS, 'best_wins': BEST_WINS},
        'off_bar': {'min': round(off_lo, 2), 'max': round(off_hi, 2)},
        'pit_bar': {'min': round(pit_lo, 2), 'max': round(pit_hi, 2)},
        'best_total': round(best_total, 2), 'worst_total': round(worst_total, 2),
    }

    out = {'meta': meta, 'hitters': hitters, 'pitchers': pitchers, 'teams': teams_by_level}
    with open(OUT_PATH, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
        f.write('\n')

    # ── Diagnostics ──
    print(f"Wrote {OUT_PATH}")
    print(f"  hitters={len(hitters)} pitchers={len(pitchers)} "
          f"teams={sum(len(v) for v in teams_by_level.values())}")
    print(f"  teams/level: " + ", ".join(f"{lv}:{len(v)}" for lv, v in sorted(teams_by_level.items())))
    print(f"  win calibration: random mean={wins(mean)}  best={wins(best_total)}  worst={wins(worst_total)}")
    rw = sorted(wins(t) for t in totals)
    print(f"  random win spread: p5={rw[len(rw)//20]}  p50={rw[len(rw)//2]}  p95={rw[19*len(rw)//20]}  "
          f"min={rw[0]} max={rw[-1]}")

    # Greedy engaged play: each round spin a random level+team, take the best
    # available player for a still-needed slot (DH can be any hitter).
    def greedy_game(rng):
        need = set(HPOS); need_p = N_PITCHERS
        hs, ps = [], []
        guard = 0
        while need or need_p > 0:
            guard += 1
            if guard > 500:
                break
            lv = rng.choice(list(teams_by_level))
            tm = rng.choice(teams_by_level[lv])
            cand_h = [h for h in hitters if h['t'] == tm and (h['p'] in need or 'DH' in need)]
            cand_p = pitchers_by_team.get(tm, []) if need_p > 0 else []
            best_h_pick = max(cand_h, key=lambda x: x['off'], default=None)
            best_p_pick = max(cand_p, key=lambda x: x['pit'], default=None)
            if best_h_pick and (not best_p_pick or best_h_pick['off'] >= best_p_pick['pit'] * 0.9):
                slot = best_h_pick['p'] if best_h_pick['p'] in need else 'DH'
                need.discard(slot); hs.append(best_h_pick)
            elif best_p_pick:
                need_p -= 1; ps.append(best_p_pick)
        if len(hs) == 9 and len(ps) == 5:
            return wins(total_of(hs, ps))
        return None
    pitchers_by_team = {}
    for p in pitchers:
        pitchers_by_team.setdefault(p['t'], []).append(p)
    grng = random.Random(11)
    gw = sorted(w for w in (greedy_game(grng) for _ in range(3000)) if w is not None)
    print(f"  GREEDY engaged play: p5={gw[len(gw)//20]}  p50={gw[len(gw)//2]}  p95={gw[19*len(gw)//20]}  max={gw[-1]}")
    print("  BEST roster:")
    for h in best_h:
        print(f"    {h['p']:3} {h['n']:22} {h['l']:5} wRC+={h['wrc']:.0f} off={h['off']}")
    for p in best_p:
        print(f"    P   {p['n']:22} {p['l']:5} FIP={p['fip']:.2f} pit={p['pit']}")


if __name__ == '__main__':
    main()
