"""
Smoke test for backend/app/stats/split_stats.py

Pulls the Pacific U (NWC) roster for 2026, runs the time-weighted regressed
split profile for each hitter with 30+ PAs, and prints a comparison table
so we can eyeball whether the numbers look sane.

Run from project root on your Mac:
    cd ~/Desktop/pnw-baseball
    python3 scripts/smoke_test_split_stats.py
"""

import sys
import os

# Add project root to path so the relative imports in backend/ resolve
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.app.models.database import get_connection
from backend.app.stats.split_stats import (
    compute_player_split_profile,
    compute_league_platoon_deltas,
)

SEASON = 2026
TEAM_NAME_LIKE = 'Pacific%'  # NWC Pacific University
DIVISION_LEVEL = 'NAIA'  # Pacific U is NWC D3, but our default weights for D3
                          # vs NAIA are very close. Adjust if you want exact match.


def main():
    with get_connection() as conn:
        cur = conn.cursor()

        # Find Pacific U team_id (the NWC one — there's also a D1 University of the Pacific)
        cur.execute(
            """
            SELECT t.id, t.name, d.level AS division_level
            FROM teams t
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE t.name LIKE %s AND d.level IN ('NAIA','D3')
            ORDER BY t.id
            """,
            (TEAM_NAME_LIKE,),
        )
        teams = cur.fetchall()
        if not teams:
            print(f"No team matching '{TEAM_NAME_LIKE}' found.")
            return
        # Prefer the NWC D3 one (per project_two_pacifics memory)
        team = next((t for t in teams if t['division_level'] == 'D3'), teams[0])
        print(f"\nTeam: {team['name']} (id={team['id']}, div={team['division_level']})\n")

        team_div = team['division_level']

        # League platoon deltas (computed once for this division/season)
        print("Computing league platoon deltas...")
        deltas = compute_league_platoon_deltas(cur, SEASON, division_level=team_div)
        print(f"  RHB delta vs RHP: {deltas['R']['R']:+.4f}  vs LHP: {deltas['R']['L']:+.4f}")
        print(f"  LHB delta vs RHP: {deltas['L']['R']:+.4f}  vs LHP: {deltas['L']['L']:+.4f}")
        print(f"  (Switch hitters: 0.0000)\n")

        # Find Pacific U hitters with 30+ PAs in 2026
        cur.execute(
            """
            SELECT p.id, p.first_name, p.last_name, p.bats, p.position,
                   COUNT(*) AS pa
            FROM game_events ge
            JOIN players p ON p.id = ge.batter_player_id
            JOIN games g ON g.id = ge.game_id
            WHERE p.team_id = %s
              AND g.season = %s
              AND ge.result_type IS NOT NULL
            GROUP BY p.id, p.first_name, p.last_name, p.bats, p.position
            HAVING COUNT(*) >= 30
            ORDER BY pa DESC
            """,
            (team['id'], SEASON),
        )
        hitters = cur.fetchall()

        if not hitters:
            print(f"No Pacific U hitters with 30+ PAs in {SEASON}.")
            return

        print(f"Found {len(hitters)} qualifying hitters.\n")

        # Header
        print(f"{'Player':<25} {'Bats':<5} {'PA':>5} | "
              f"{'Season wOBA':>12} | "
              f"{'vs-R obs':>10} {'vs-R reg':>10} {'(PAs)':>7} | "
              f"{'vs-L obs':>10} {'vs-L reg':>10} {'(PAs)':>7}")
        print("-" * 130)

        for h in hitters:
            profile = compute_player_split_profile(
                cur, h['id'], SEASON,
                division_level=team_div,
                league_deltas=deltas,
            )
            sv = profile['season_view']
            vr = profile['vs_RHP']
            vl = profile['vs_LHP']
            name = f"{h['first_name']} {h['last_name']}"[:24]
            print(f"{name:<25} {h['bats'] or '?':<5} {h['pa']:>5} | "
                  f"{sv['wOBA']:>12.3f} | "
                  f"{vr['observed_wOBA']:>10.3f} {vr['wOBA']:>10.3f} {vr['raw_pa']:>7} | "
                  f"{vl['observed_wOBA']:>10.3f} {vl['wOBA']:>10.3f} {vl['raw_pa']:>7}")

        print("\nSanity checks to eyeball:")
        print("  1. Season wOBA should be between ~.250 (weak) and ~.500 (elite).")
        print("  2. vs-L regressed wOBAs should generally be CLOSER to season wOBA")
        print("     than vs-L observed (regression is doing its job).")
        print("  3. RHB hitters with very few vs-LHP PAs should have regressed values")
        print("     within ~10-30 points of their season line.")
        print("  4. Recency: a player who's been hot in April should have a season")
        print("     wOBA HIGHER than their raw season slash from the box score.")


if __name__ == '__main__':
    main()
