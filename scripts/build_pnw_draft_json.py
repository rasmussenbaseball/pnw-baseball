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
ROLE_MIN_APPS = 3    # min starts AND relief apps to count a pitcher as a swing (both)

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

    # Total distinct games per hitter (for the `g` display when batting_stats.games
    # is missing/zero — e.g. the Willamette D3 rows whose games never ingested).
    cur.execute("""
        SELECT gb.player_id,
               COUNT(DISTINCT (g.game_date, COALESCE(g.game_number, 1))) AS games
        FROM game_batting gb
        JOIN games g ON g.id = gb.game_id
        WHERE gb.player_id IS NOT NULL AND g.season = %s AND gb.team_id = ANY(%s)
          AND (g.is_postseason IS NULL OR g.is_postseason = FALSE)
        GROUP BY gb.player_id
    """, (season, team_ids))
    games_count = {r['player_id']: int(r['games'] or 0) for r in cur.fetchall()}
    return primary, eligible, games_count


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

        primary_pos, eligible_pos, games_count = assign_positions(cur, season, team_ids)

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
                'g': int(r['games'] or 0) or games_count.get(r['player_id'], 0),
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
            relief = max(g - gs, 0)
            # Role from actual usage (NOT saves — a starter can vulture a save).
            #   both  = meaningful time as starter AND reliever -> user chooses slot
            #   SP    = mostly starts;  RP = mostly relief
            if gs >= ROLE_MIN_APPS and relief >= ROLE_MIN_APPS:
                role = 'both'
            elif gs >= relief:
                role = 'SP'
            else:
                role = 'RP'
            pitchers.append({
                'pid': r['player_id'], 'n': f"{r['first_name'] or ''} {r['last_name'] or ''}".strip(),
                't': team['short'], 'l': team['level'],
                'era': round(float(r['era']), 2),
                'whip': round(float(r['whip'] or 0), 2),
                'k9': round(float(r['k_per_9'] or 0), 1),
                'fip': round(float(r['fip'] or 0), 2),
                'ip': round(ip_real, 1),
                'w': int(r['wins'] or 0), 'sv': int(r['saves'] or 0),
                'g': g, 'gs': gs, 'role': role,
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

    def ps_of(ps):  # mean pitching talent (simple mean, mirrors the hitters'
        # mean off — IP-weighting buried elite relievers and made staffs read
        # systematically lower than equivalently-good lineups)
        return sum(x['pit'] for x in ps) / len(ps)

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
    totals, hs_samp, ps_samp = [], [], []
    for _ in range(8000):
        hs = [random.choice(by_pos[pos] or hitters) for pos in HPOS]
        ps = random.sample(pitchers, N_PITCHERS)
        totals.append(total_of(hs, ps))
        hs_samp.append(hs_of(hs)); ps_samp.append(ps_of(ps))
    mean = sum(totals) / len(totals)

    # ── Engaged-play (greedy) distribution ──
    # A thoughtful player grabs the best available stud each round. We compare a
    # candidate hitter vs pitcher by PERCENTILE within its own pool (so the 90th-
    # pct bat ranks like the 90th-pct arm) and take the higher. This is what the
    # win curve's upper anchors are calibrated to, so a genuinely strong draft
    # reaches the low-to-mid 50s instead of stalling in the high 30s.
    pitchers_by_team = {}
    for p in pitchers:
        pitchers_by_team.setdefault((p['l'], p['t']), []).append(p)
    off_sorted = sorted(h['off'] for h in hitters)
    pit_sorted = sorted(p['pit'] for p in pitchers)

    def _pct(sorted_vals, v):
        from bisect import bisect_left
        return bisect_left(sorted_vals, v) / max(len(sorted_vals) - 1, 1)

    def greedy_total(rng):
        need = set(HPOS); need_p = N_PITCHERS
        hs, ps = [], []
        guard = 0
        while (need or need_p > 0) and guard < 500:
            guard += 1
            lv = rng.choice(list(teams_by_level)); tm = rng.choice(teams_by_level[lv])
            # best hitter for an open eligible slot (DH counts if open)
            bh = None
            for h in hByteam_get(lv, tm):
                fits = ('DH' in need) or any(pos in need for pos in (h.get('elig') or [h['p']]))
                if fits and (bh is None or h['off'] > bh['off']):
                    bh = h
            bp = None
            if need_p > 0:
                for p in pitchers_by_team.get((lv, tm), []):
                    if bp is None or p['pit'] > bp['pit']:
                        bp = p
            take_h = bh and (not bp or _pct(off_sorted, bh['off']) >= _pct(pit_sorted, bp['pit']))
            if take_h:
                slot = next((pos for pos in (bh.get('elig') or [bh['p']]) if pos in need), 'DH')
                need.discard(slot); hs.append(bh)
            elif bp:
                need_p -= 1; ps.append(bp)
        if len(hs) == 9 and len(ps) == 5:
            return total_of(hs, ps), hs_of(hs), ps_of(ps)
        return None

    hByteam = {}
    for h in hitters:
        hByteam.setdefault((h['l'], h['t']), []).append(h)
    def hByteam_get(lv, tm):
        return hByteam.get((lv, tm), [])

    grng = random.Random(11)
    gres = [r for r in (greedy_total(grng) for _ in range(4000)) if r is not None]
    gtot = sorted(r[0] for r in gres)
    g50 = gtot[len(gtot) // 2]
    g90 = gtot[int(0.90 * len(gtot))]
    g99 = gtot[int(0.99 * len(gtot))]

    # 56-0 (a sweep) should be a reachable apex for elite drafting, not only the
    # literal theoretical-best roster. Pegging it to best_total made it virtually
    # impossible (even 99th-pct engaged play landed ~53). Anchor the sweep halfway
    # between the 99th-pct engaged draft (g99) and the perfect roster (best_total),
    # so a great, lucky build can run the table while it stays the rarest result.
    sweep_total = g99 + 0.5 * (best_total - g99)
    # Win curve = linear interpolation through monotonic (total, wins) anchors.
    raw_anchors = [
        (worst_total, 2.0),     # careless / worst-possible bottoms out
        (mean, 28.0),           # a random roster is roughly .500
        (g50, 44.0),            # typical engaged play
        (g90, 52.0),            # a strong, well-built roster
        (max(sweep_total, g90 + 1), 56.0),  # elite + lucky -> sweep
    ]
    anchors = []
    for tot, w in raw_anchors:
        if not anchors or tot > anchors[-1][0] + 1e-6:
            anchors.append((round(tot, 3), w))

    def wins(total):
        if total <= anchors[0][0]:
            return max(0, min(56, round(anchors[0][1])))
        for (t0, w0), (t1, w1) in zip(anchors, anchors[1:]):
            if total <= t1:
                frac = (total - t0) / max(t1 - t0, 1e-6)
                return max(0, min(56, round(w0 + frac * (w1 - w0))))
        return 56

    # 0-100 bars = PERCENTILE of this roster's offense / pitching among realistic
    # rosters (random + engaged play). A min/max scale can't make the two bars
    # symmetric (offense is consistently high and tightly packed; pitching is more
    # spread, so the same quality read lower). Percentile fixes it by construction:
    # "better than 85% of rosters" shows 85 on EITHER side. We store 21 quantile
    # breakpoints per side and the frontend interpolates.
    def quantiles(vals, n=20):
        s = sorted(vals)
        return [round(s[min(len(s) - 1, int(k / n * (len(s) - 1)))], 3) for k in range(n + 1)]
    pooled_hs = hs_samp + [r[1] for r in gres]
    pooled_ps = ps_samp + [r[2] for r in gres]
    off_q = quantiles(pooled_hs)
    pit_q = quantiles(pooled_ps)

    meta = {
        'season': season,
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'n_hitters': len(hitters), 'n_pitchers': len(pitchers),
        'level_str': LEVEL_STR, 'min_pa': MIN_PA, 'min_ip': MIN_IP,
        'weights': {'h': WEIGHT_H, 'p': WEIGHT_P},
        'games': 56,
        'win_map': {'anchors': anchors},
        'off_bar': {'q': off_q},
        'pit_bar': {'q': pit_q},
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
    print(f"  win anchors (total->wins): " + ", ".join(f"{t:.0f}->{w:.0f}" for t, w in anchors))
    print(f"  win calibration: random mean={wins(mean)}  best={wins(best_total)}  worst={wins(worst_total)}")
    rw = sorted(wins(t) for t in totals)
    print(f"  random win spread: p5={rw[len(rw)//20]}  p50={rw[len(rw)//2]}  p95={rw[19*len(rw)//20]}  "
          f"min={rw[0]} max={rw[-1]}")
    gww = sorted(wins(t) for t in gtot)
    print(f"  GREEDY engaged play wins: p5={gww[len(gww)//20]}  p50={gww[len(gww)//2]}  "
          f"p90={gww[int(0.9*len(gww))]}  p95={gww[19*len(gww)//20]}  max={gww[-1]}")
    print(f"  multi-position hitters: {sum(1 for h in hitters if len(h['elig'])>1)}  "
          f"swing pitchers (both): {sum(1 for p in pitchers if p['role']=='both')}")
    print("  BEST roster:")
    for h in best_h:
        print(f"    {h['p']:3} {h['n']:22} {h['l']:5} wRC+={h['wrc']:.0f} off={h['off']}")
    for p in best_p:
        print(f"    P   {p['n']:22} {p['l']:5} FIP={p['fip']:.2f} pit={p['pit']}")


if __name__ == '__main__':
    main()
