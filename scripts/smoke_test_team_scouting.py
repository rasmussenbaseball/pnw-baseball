"""
Smoke test for backend/app/api/team_scouting.py — runs the full scouting
report for Bushnell (team_id=24) and prints summary counts so we can
spot-check the response shape before plugging it into the frontend.

Run from project root:
    cd ~/Desktop/pnw-baseball
    python3 scripts/smoke_test_team_scouting.py
"""

import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.app.models.database import get_connection
from backend.app.api.team_scouting import compute_team_scouting


SEASON = 2026
TEAM_ID = 24  # Bushnell


def main():
    with get_connection() as conn:
        cur = conn.cursor()
        result = compute_team_scouting(cur, TEAM_ID, SEASON)

    if 'error' in result and 'team' not in result:
        print(f"ERROR: {result['error']}")
        return

    t = result['team']
    print(f"Team: {t['name']} ({t['short_name']})")
    print(f"Conference: {t['conference_name']} ({t['division_level']})")
    print(f"Record: {t.get('wins')}-{t.get('losses')} (conf {t.get('conference_wins')}-{t.get('conference_losses')})")
    print(f"Conference baseline: {result['conference_team_count']} teams\n")

    print(f"Last 10: {result['recent']['record']}")
    print(f"  {len(result['recent']['games'])} games captured\n")

    print("=== TEAM PANELS ===")
    for panel_name, rows in result['panels'].items():
        print(f"\n[{panel_name.upper()}]")
        for row in rows:
            v = row['value']
            v_s = '—' if v is None else (
                f"{v:.3f}" if row['format'] == 'rate' else
                f"{v*100:.1f}%" if row['format'] == 'pct' else
                f"{v:.2f}" if row['format'] == 'era' else
                f"{int(round(v))}" if row['format'] == 'int' else str(v)
            )
            pct = row.get('percentile')
            pct_s = f"{pct:>5.1f}" if pct is not None else '  —  '
            rank = row.get('rank')
            rank_s = f"{rank}/{row['total']}" if rank else '   '
            print(f"  {row['label']:<14} {v_s:>9}   pct {pct_s}  rank {rank_s:>5}  ({row['color']})")

    print("\n=== WRITEUP ===")
    print(result['writeup'])

    print(f"\n=== ROSTER ===")
    print(f"Hitters (>=30 PA): {len(result['hitters'])}")
    print(f"Starters (>=15 IP, >=3.5 IP/G): {len(result['starters'])}")
    print(f"Relievers (>=5 IP, <3.5 IP/G or <15 IP): {len(result['relievers'])}\n")

    print("Sample hitter:")
    if result['hitters']:
        h = result['hitters'][0]
        print(f"  {h['first_name']} {h['last_name']}: PA={h['plate_appearances']} wOBA={h['woba']}")
        if h.get('strengths'):
            print(f"    Strengths: " + ", ".join(f"{s['label']} ({s['percentile']:.0f}th)" for s in h['strengths']))
        if h.get('weaknesses'):
            print(f"    Weaknesses: " + ", ".join(f"{s['label']} ({s['percentile']:.0f}th)" for s in h['weaknesses']))

    print("\nSample starter:")
    if result['starters']:
        p = result['starters'][0]
        print(f"  {p['first_name']} {p['last_name']}: IP={p['innings_pitched']} ERA={p['era']} FIP={p.get('fip')}")
        if p.get('strengths'):
            print(f"    Strengths: " + ", ".join(f"{s['label']} ({s['percentile']:.0f}th)" for s in p['strengths']))
        if p.get('weaknesses'):
            print(f"    Weaknesses: " + ", ".join(f"{s['label']} ({s['percentile']:.0f}th)" for s in p['weaknesses']))


if __name__ == '__main__':
    main()
