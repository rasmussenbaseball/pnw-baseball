"""
Smoke test for backend/app/stats/lineup_engine.py

Pulls the top 9 hitters by PAs for Bushnell University in 2026, runs them
through the slot optimizer for vs RHP and vs LHP, and prints the resulting
batting orders so we can eyeball whether they look sensible.

Run from project root on your Mac:
    cd ~/Desktop/pnw-baseball
    python3 scripts/smoke_test_lineup_engine.py
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.app.models.database import get_connection
from backend.app.stats.split_stats import (
    compute_player_split_profile,
    compute_league_platoon_deltas,
)
from backend.app.stats.lineup_engine import optimize_both_lineups

SEASON = 2026
TEAM_NAME_LIKE = 'Bushnell%'


def main():
    with get_connection() as conn:
        cur = conn.cursor()

        # Find Bushnell team_id
        cur.execute(
            """
            SELECT t.id, t.name, d.level AS division_level, c.name AS conference
            FROM teams t
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE t.name LIKE %s
            ORDER BY t.id
            """,
            (TEAM_NAME_LIKE,),
        )
        teams = cur.fetchall()
        if not teams:
            print(f"No team matching '{TEAM_NAME_LIKE}' found.")
            return
        team = teams[0]
        team_id = team['id']
        team_div = team['division_level']
        print(f"\nTeam: {team['name']} (id={team_id}, div={team_div}, conf={team['conference']})\n")

        # Compute league deltas once
        print("Computing league platoon deltas...")
        deltas = compute_league_platoon_deltas(cur, SEASON, division_level=team_div)
        print(f"  RHB delta vs RHP: {deltas['R']['R']:+.4f}  vs LHP: {deltas['R']['L']:+.4f}")
        print(f"  LHB delta vs RHP: {deltas['L']['R']:+.4f}  vs LHP: {deltas['L']['L']:+.4f}\n")

        # Find top 9 Bushnell hitters by PA in 2026
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
            LIMIT 9
            """,
            (team_id, SEASON),
        )
        hitters = cur.fetchall()

        if len(hitters) < 9:
            print(f"Only {len(hitters)} qualifying hitters with 30+ PAs. Need 9.")
            return

        print(f"Top 9 Bushnell hitters by PA:\n")
        for h in hitters:
            print(f"  {h['first_name']} {h['last_name']:<20} {h['position'] or '?':<6} {h['bats'] or '?':<3} {h['pa']:>4} PA")
        print()

        # Build profiles for all 9
        print("Building split profiles...")
        profiles = []
        for h in hitters:
            prof = compute_player_split_profile(
                cur, h['id'], SEASON,
                division_level=team_div,
                league_deltas=deltas,
            )
            # Attach name for display
            prof['_display_name'] = f"{h['first_name']} {h['last_name']}"
            prof['_position'] = h['position'] or '?'
            profiles.append(prof)

        # Optimize both lineups
        print("Optimizing batting orders...\n")
        result = optimize_both_lineups(profiles)

        # Pretty-print
        print("=" * 90)
        print(f"OPTIMAL LINEUP vs RHP (total score: {result['vs_RHP']['total_score']:.3f})")
        print("=" * 90)
        _print_lineup(result['vs_RHP']['order'], profiles)

        print()
        print("=" * 90)
        print(f"OPTIMAL LINEUP vs LHP (total score: {result['vs_LHP']['total_score']:.3f})")
        print("=" * 90)
        _print_lineup(result['vs_LHP']['order'], profiles)

        print("\nSanity checks:")
        print("  1. The best hitter (highest season wOBA) should land at slot 2 or 4")
        print("     vs both hands (per The Book's #2-best-hitter rule).")
        print("  2. High-K, low-power hitters should NOT be at slot 1 — push them to 6-8.")
        print("  3. Slot 9 should be a legit OBP guy, not the worst hitter overall.")
        print("  4. The lineup vs RHP and vs LHP should mostly look the same, with")
        print("     1-2 swaps based on platoon splits (e.g., a LHB drops vs LHP).")


def _print_lineup(order, profiles):
    pid_to_prof = {p['player_id']: p for p in profiles}
    print(f"{'Slot':<5} {'Player':<25} {'Pos':<5} {'B':<3} {'wOBA':>7} {'(obs)':>7} {'K%':>6} {'BB%':>6} {'PA':>5} {'Score':>7}")
    print("-" * 90)
    for entry in order:
        prof = pid_to_prof[entry['player_id']]
        name = prof['_display_name'][:24]
        pos = prof['_position']
        bats = prof.get('bats') or '?'
        print(f"{entry['slot']:<5} {name:<25} {pos:<5} {bats:<3} "
              f"{entry['wOBA']:>7.3f} {entry['observed_wOBA']:>7.3f} "
              f"{entry['K_pct']:>6.3f} {entry['BB_pct']:>6.3f} "
              f"{entry['raw_pa']:>5} {entry['score']:>7.3f}")


if __name__ == '__main__':
    main()
