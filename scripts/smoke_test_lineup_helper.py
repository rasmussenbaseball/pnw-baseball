"""
Smoke test for the full Lineup Helper orchestration (Phase 3).

This bypasses FastAPI and calls the orchestration helper directly with
Bushnell's team_id, exercising the same code path the endpoint uses.
We get position-eligibility, optimal-9-pick, and bench ranking all in
one shot.

Run from project root on your Mac:
    cd ~/Desktop/pnw-baseball
    python3 scripts/smoke_test_lineup_helper.py
"""

import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.app.models.database import get_connection
from backend.app.api.lineup_helper import compute_team_lineup_helper


SEASON = 2026
TEAM_NAME_LIKE = 'Bushnell%'


def main():
    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute(
            """
            SELECT t.id FROM teams t
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE t.name LIKE %s
            ORDER BY t.id LIMIT 1
            """,
            (TEAM_NAME_LIKE,),
        )
        team_row = cur.fetchone()
        if not team_row:
            print(f"No team matching '{TEAM_NAME_LIKE}' found.")
            return
        team_id = team_row['id']

        print(f"Computing Lineup Helper for team_id={team_id} (Bushnell), season={SEASON}...\n")
        result = compute_team_lineup_helper(cur, team_id, SEASON)

        if 'error' in result and 'team' not in result:
            print(f"ERROR: {result['error']}")
            return

        team = result['team']
        print(f"Team: {team['name']} (div={team['division_level']}, conf={team['conference_name']})")
        print(f"Eligible roster (≥30 PA): {result['eligible_count']} hitters")
        print(f"As of: {result['as_of_date']}")
        print(f"Config: {result['config']}\n")

        for vs in ('vs_RHP', 'vs_LHP'):
            block = result[vs]
            print("=" * 100)
            print(f"OPTIMAL LINEUP {vs}  (total slot score: {block.get('total_score', 'n/a')})")
            print("=" * 100)
            print(f"{'Slot':<5} {'Player':<25} {'Pos':<5} {'B':<3} {'wOBA':>7} {'(obs)':>7} "
                  f"{'K%':>6} {'BB%':>6} {'PA':>5} {'Score':>7}")
            print("-" * 100)
            for entry in block['starters']:
                name = f"{entry['first_name']} {entry['last_name']}"[:24]
                print(f"{entry['slot']:<5} {name:<25} "
                      f"{entry['assigned_position']:<5} "
                      f"{(entry.get('bats') or '?'):<3} "
                      f"{entry['wOBA']:>7.3f} {entry['observed_wOBA']:>7.3f} "
                      f"{entry['K_pct']:>6.3f} {entry['BB_pct']:>6.3f} "
                      f"{entry['raw_pa']:>5} {entry['score']:>7.3f}")
            print()
            print(f"BENCH (top 5 not starting {vs}):")
            print(f"{'#':<3} {'Player':<25} {'Bats':<5} {'Best Pos':<10} {'Best Slot':<10} {'wOBA':>7} {'PA':>5} {'Score':>7}")
            print("-" * 100)
            for i, b in enumerate(block.get('bench', []), start=1):
                name = f"{b.get('first_name','?')} {b.get('last_name','?')}"[:24]
                print(f"{i:<3} {name:<25} {(b.get('bats') or '?'):<5} "
                      f"{b['best_position']:<10} {b['best_slot']:<10} "
                      f"{b['wOBA']:>7.3f} {b['raw_pa']:>5} {b['best_score']:>7.3f}")
            print()

        print("Sanity checks:")
        print("  - Each starter should have a position string (C/1B/2B/3B/SS/LF/CF/RF/DH).")
        print("  - No player should appear twice in either lineup.")
        print("  - No starter should appear in the bench list of the same vs-hand.")
        print("  - The lineup vs LHP can include different starters from vs RHP if")
        print("    the optimizer found platoon advantages.")
        print("  - DH should usually go to a strong bat with no defensive eligibility,")
        print("    or to the best bat overall.")


if __name__ == '__main__':
    main()
