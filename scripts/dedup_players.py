#!/usr/bin/env python3
"""
Find and link SAME-TEAM duplicate player rows (spelling variants, casing,
re-scrape dupes) that link_transfers.py misses.

link_transfers.py handles transfers: EXACT name, DIFFERENT team. It explicitly
skips same-team and can't see fuzzy names. This pass covers the opposite:
the same person split into two rows on the SAME team because a data source
spelled the name differently ("Emery-Hednerson" vs "Emery-Henderson"), used
different casing ("DeVerna" vs "Deverna"), or a re-scrape created a fresh row.

Matching (conservative, same team only):
  - both rows non-phantom, same team_id, neither already a linked_id
  - normalized names equal (alnum-only, lowercased)  OR
  - difflib ratio on the full normalized name >= THRESHOLD
Canonical (the row that survives in search) = the one with the most attached
data; the other becomes a player_links linked_id -> canonical.

Dry run by default. Use --commit to write links.

    PYTHONPATH=backend python3 scripts/dedup_players.py            # dry run
    PYTHONPATH=backend python3 scripts/dedup_players.py --commit   # create links
    PYTHONPATH=backend python3 scripts/dedup_players.py --threshold 0.90
"""
import argparse
import re
from collections import defaultdict
from difflib import SequenceMatcher
from app.models.database import get_connection

THRESHOLD = 0.86


def norm(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def is_nonplayer(p, team_names):
    """Detect rows that are scraping garbage, not real players: a team name
    parsed as a person ("SW Oregon"), or a location-prefixed fragment
    ("at SW Oregon", "vs Big Bend")."""
    fn = (p['first_name'] or '').strip().lower()
    full = re.sub(r'\s+', ' ', f"{p['first_name'] or ''} {p['last_name'] or ''}".strip().lower())
    if fn in ('at', 'vs', '@', 'at.', 'vs.', 'the'):
        return True
    if full in team_names:
        return True
    # "at <team>" / "vs <team>" shapes
    for pre in ('at ', 'vs ', '@ '):
        if full.startswith(pre) and full[len(pre):] in team_names:
            return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--commit', action='store_true', help='Create the player_links')
    ap.add_argument('--threshold', type=float, default=THRESHOLD)
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        # Already-linked ids (either side) — never touch these.
        cur.execute("SELECT canonical_id, linked_id FROM player_links")
        links = cur.fetchall()
        linked_ids = {r['linked_id'] for r in links}
        canonical_ids = {r['canonical_id'] for r in links}

        # Known team names (to reject team-name-as-player garbage rows).
        cur.execute("SELECT LOWER(short_name) n FROM teams UNION SELECT LOWER(name) FROM teams")
        team_names = {r['n'] for r in cur.fetchall() if r['n']}

        # Non-phantom players on a real team.
        cur.execute("""
            SELECT p.id, p.first_name, p.last_name, p.team_id, p.position,
                   p.year_in_school, t.short_name AS team
            FROM players p JOIN teams t ON t.id = p.team_id
            WHERE COALESCE(p.is_phantom, FALSE) = FALSE
        """)
        players = [p for p in cur.fetchall() if not is_nonplayer(p, team_names)]

        # Bulk data counts per player_id (one pass each, far cheaper than subqueries).
        counts = defaultdict(lambda: defaultdict(int))
        for col, q in [
            ('bstat', "SELECT player_id id, COUNT(*) c FROM batting_stats GROUP BY 1"),
            ('pstat', "SELECT player_id id, COUNT(*) c FROM pitching_stats GROUP BY 1"),
            ('gbat',  "SELECT player_id id, COUNT(*) c FROM game_batting GROUP BY 1"),
            ('gpit',  "SELECT player_id id, COUNT(*) c FROM game_pitching GROUP BY 1"),
            ('evb',   "SELECT batter_player_id id, COUNT(*) c FROM game_events WHERE batter_player_id IS NOT NULL GROUP BY 1"),
            ('evp',   "SELECT pitcher_player_id id, COUNT(*) c FROM game_events WHERE pitcher_player_id IS NOT NULL GROUP BY 1"),
        ]:
            cur.execute(q)
            for r in cur.fetchall():
                counts[r['id']][col] = r['c']

        def score(pid):
            c = counts[pid]
            # season stats are the strongest "this is the real roster row" signal
            return (c['bstat'] + c['pstat']) * 100 + c['gbat'] + c['gpit'] + c['evb'] + c['evp']

        def summarize(pid):
            c = counts[pid]
            return f"bs={c['bstat']} ps={c['pstat']} gb={c['gbat']} gp={c['gpit']} evB={c['evb']} evP={c['evp']}"

        # Group by team, compare pairs.
        by_team = defaultdict(list)
        for p in players:
            by_team[p['team_id']].append(p)

        proposals = []  # (canonical, dup, ratio)
        seen_pairs = set()
        for team_id, group in by_team.items():
            n = len(group)
            for i in range(n):
                for j in range(i + 1, n):
                    a, b = group[i], group[j]
                    na = norm(a['first_name'] + a['last_name'])
                    nb = norm(b['first_name'] + b['last_name'])
                    if not na or not nb:
                        continue
                    ratio = 1.0 if na == nb else SequenceMatcher(None, na, nb).ratio()
                    if ratio < args.threshold:
                        continue
                    # Skip if either is already in a link chain (leave those to manual review)
                    if a['id'] in linked_ids or b['id'] in linked_ids:
                        continue
                    # Pick canonical = more data; tiebreak lower id
                    if score(a['id']) >= score(b['id']):
                        canon, dup = a, b
                    else:
                        canon, dup = b, a
                    key = (canon['id'], dup['id'])
                    if key in seen_pairs:
                        continue
                    seen_pairs.add(key)
                    proposals.append((canon, dup, ratio))

        proposals.sort(key=lambda x: (-x[2], x[0]['team']))
        print(f"\n=== {len(proposals)} same-team duplicate candidate(s) "
              f"(threshold {args.threshold}) ===\n")
        for canon, dup, ratio in proposals:
            flag = "" if norm(canon['first_name']+canon['last_name']) == norm(dup['first_name']+dup['last_name']) else "  <-- FUZZY"
            print(f"[{ratio:.2f}] {canon['team']}{flag}")
            print(f"   KEEP  id={canon['id']:<6} {canon['first_name']} {canon['last_name']} "
                  f"({canon['position']},{canon['year_in_school']})  {summarize(canon['id'])}")
            print(f"   LINK  id={dup['id']:<6} {dup['first_name']} {dup['last_name']} "
                  f"({dup['position']},{dup['year_in_school']})  {summarize(dup['id'])}")
            print()

        if args.commit and proposals:
            for canon, dup, ratio in proposals:
                cur.execute("""
                    INSERT INTO player_links (canonical_id, linked_id, match_type, confidence)
                    VALUES (%s, %s, 'dedup_same_team', %s)
                """, (canon['id'], dup['id'], round(float(ratio), 3)))
            conn.commit()
            print(f"COMMITTED {len(proposals)} links.")
        elif proposals:
            print("Dry run. Re-run with --commit to create these links.")
        cur.close()


if __name__ == '__main__':
    main()
