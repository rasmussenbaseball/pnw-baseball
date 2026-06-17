"""
Resolve player_id for each entry in backend/data/gold_gloves.json by matching
(name, team_short) → players row. Writes the file back in place.

Usage: PYTHONPATH=backend python3 scripts/resolve_gold_gloves.py [--commit]

Without --commit: dry-run, prints what would change. With --commit: rewrites the JSON.

Resolution tiers per entry (within the matching team_id):
  1) exact first + last (case-insensitive)
  2) hyphen-prefix on last name (Crowley → Crowley-Koehler)
  3) fuzzy difflib ≥0.85 on full name
  4) last-name-only exact (when only one player has that last name on the team)

Entries already resolved (player_id not null) are left alone unless --refresh is passed.
"""
import sys, os, json, argparse
from difflib import SequenceMatcher

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

from app.models.database import get_connection

DATA_PATH = os.path.join(os.path.dirname(__file__), '..', 'backend', 'data', 'gold_gloves.json')


def _norm(s):
    return (s or '').strip().lower()


def _split_name(full):
    parts = full.strip().split()
    if len(parts) < 2:
        return parts[0] if parts else '', ''
    return parts[0], ' '.join(parts[1:])


def _resolve_team_id(cur, team_short):
    cur.execute(
        "SELECT id FROM teams WHERE LOWER(short_name) = LOWER(%s) LIMIT 1",
        (team_short,),
    )
    row = cur.fetchone()
    return row['id'] if row else None


def _candidates_for_team(cur, team_id):
    """Return all (id, first, last) for a team (active + historical)."""
    cur.execute(
        "SELECT id, first_name, last_name FROM players WHERE team_id = %s",
        (team_id,),
    )
    return cur.fetchall()


def _best_match(first, last, full_name, candidates):
    """Tiered matcher within a team's player list."""
    nf, nl = _norm(first), _norm(last)
    # 1) exact
    for c in candidates:
        if _norm(c['first_name']) == nf and _norm(c['last_name']) == nl:
            return c['id'], 'exact'
    # 2) hyphen-prefix on last name (DB has hyphenated form, source truncated)
    for c in candidates:
        cl = _norm(c['last_name'])
        if _norm(c['first_name']) == nf and (
            cl.startswith(nl + '-') or nl.startswith(cl + '-')
        ):
            return c['id'], 'hyphen'
    # 3) fuzzy full-name ≥0.85
    target = _norm(full_name)
    best = None
    best_score = 0.0
    for c in candidates:
        cn = f"{_norm(c['first_name'])} {_norm(c['last_name'])}"
        score = SequenceMatcher(None, target, cn).ratio()
        if score > best_score:
            best_score = score
            best = c
    if best and best_score >= 0.85:
        return best['id'], f'fuzzy({best_score:.2f})'
    # 4) last-name-only unique
    last_matches = [c for c in candidates if _norm(c['last_name']) == nl]
    if len(last_matches) == 1:
        return last_matches[0]['id'], 'lastname-only'
    return None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--commit', action='store_true', help='Write resolved IDs back to JSON')
    ap.add_argument('--refresh', action='store_true', help='Re-resolve even entries that already have player_id')
    args = ap.parse_args()

    with open(DATA_PATH) as f:
        data = json.load(f)

    entries = data['awards']
    resolved = 0
    unchanged = 0
    unmatched = []

    # Cache team_id + candidate lists per team_short
    team_cache = {}

    with get_connection() as conn:
        cur = conn.cursor()
        for entry in entries:
            if entry.get('player_id') is not None and not args.refresh:
                unchanged += 1
                continue

            ts = entry['team_short']
            if ts not in team_cache:
                tid = _resolve_team_id(cur, ts)
                team_cache[ts] = {
                    'team_id': tid,
                    'candidates': _candidates_for_team(cur, tid) if tid else [],
                }
            cache = team_cache[ts]
            if not cache['team_id']:
                unmatched.append(f"  TEAM-MISS: {entry['name']} ({ts}) — no team in DB")
                continue

            first, last = _split_name(entry['name'])
            pid, how = _best_match(first, last, entry['name'], cache['candidates'])
            if pid:
                entry['player_id'] = pid
                resolved += 1
                print(f"  ✓ [{how}] {entry['name']} ({ts}) → {pid}")
            else:
                unmatched.append(f"  MISS: {entry['name']} ({ts})")

    print(f"\nResolved {resolved}, unchanged {unchanged}, unmatched {len(unmatched)}")
    if unmatched:
        print("\nUnmatched (player_id stays null — they will not surface on profiles):")
        for u in unmatched:
            print(u)

    if args.commit:
        with open(DATA_PATH, 'w') as f:
            json.dump(data, f, indent=2)
            f.write('\n')
        print(f"\nWrote {DATA_PATH}")
    else:
        print("\n(dry-run — pass --commit to write JSON)")


if __name__ == '__main__':
    main()
