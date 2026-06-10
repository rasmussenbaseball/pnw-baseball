"""
Phase D.5 — quick verification that aggregated WPA values look sane for
real players. Runs the same SQL the API will run.

Picks a few standout 2026 players from each side:
  - Logan Macy (player_id=2789, OIT SS) — known smoke-test hitter
  - Two PNW closers from the LI top-5 (Luke Ivanoff, Matt Palmateer)
  - One starter for comparison

Run on Mac:
    cd ~/Desktop/pnw-baseball
    PYTHONPATH=backend python3 scripts/verify_wpa_aggregates.py
"""

from __future__ import annotations
import sys

from app.models.database import get_connection


SEASON = 2026


def main() -> int:
    with get_connection() as conn:
        cur = conn.cursor()

        # Top hitters by total WPA
        cur.execute("""
            SELECT p.id, p.first_name, p.last_name, p.position,
                   t.short_name AS team,
                   SUM(ge.wpa_batter) AS total_wpa,
                   COUNT(ge.wpa_batter) AS wpa_pa,
                   MAX(ge.wpa_batter) AS peak_wpa
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            JOIN players p ON p.id = ge.batter_player_id
            JOIN teams t ON t.id = p.team_id
            WHERE g.season = %s AND ge.wpa_batter IS NOT NULL
            GROUP BY p.id, p.first_name, p.last_name, p.position, t.short_name
            HAVING COUNT(ge.wpa_batter) >= 50
            ORDER BY total_wpa DESC
            LIMIT 10
        """, (SEASON,))
        print("\n── Top 10 hitters by total WPA (min 50 PAs) ──")
        print(f"  {'WPA':>6}  {'PA':>4}  {'peak':>6}  player")
        for r in cur.fetchall():
            name = f"{r['first_name']} {r['last_name']}"
            print(f"  {r['total_wpa']:>+6.2f}  {r['wpa_pa']:>4}  "
                  f"{r['peak_wpa']:>+6.3f}  {name} ({r['team']}, {r['position'] or '?'})")

        # Bottom 10 — most negative WPA hitters (struggling)
        cur.execute("""
            SELECT p.id, p.first_name, p.last_name, p.position,
                   t.short_name AS team,
                   SUM(ge.wpa_batter) AS total_wpa,
                   COUNT(ge.wpa_batter) AS wpa_pa
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            JOIN players p ON p.id = ge.batter_player_id
            JOIN teams t ON t.id = p.team_id
            WHERE g.season = %s AND ge.wpa_batter IS NOT NULL
            GROUP BY p.id, p.first_name, p.last_name, p.position, t.short_name
            HAVING COUNT(ge.wpa_batter) >= 50
            ORDER BY total_wpa ASC
            LIMIT 5
        """, (SEASON,))
        print("\n── Bottom 5 hitters by total WPA (min 50 PAs) ──")
        for r in cur.fetchall():
            name = f"{r['first_name']} {r['last_name']}"
            print(f"  {r['total_wpa']:>+6.2f}  {r['wpa_pa']:>4}  "
                  f"{name} ({r['team']}, {r['position'] or '?'})")

        # Top 10 pitchers by total WPA
        cur.execute("""
            SELECT p.id, p.first_name, p.last_name, p.position,
                   t.short_name AS team,
                   SUM(ge.wpa_pitcher) AS total_wpa,
                   COUNT(ge.wpa_pitcher) AS wpa_pa,
                   MAX(ge.wpa_pitcher) AS peak_wpa
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            JOIN players p ON p.id = ge.pitcher_player_id
            JOIN teams t ON t.id = p.team_id
            WHERE g.season = %s AND ge.wpa_pitcher IS NOT NULL
            GROUP BY p.id, p.first_name, p.last_name, p.position, t.short_name
            HAVING COUNT(ge.wpa_pitcher) >= 50
            ORDER BY total_wpa DESC
            LIMIT 10
        """, (SEASON,))
        print("\n── Top 10 pitchers by total WPA (min 50 batters faced) ──")
        print(f"  {'WPA':>6}  {'PA':>4}  {'peak':>6}  player")
        for r in cur.fetchall():
            name = f"{r['first_name']} {r['last_name']}"
            print(f"  {r['total_wpa']:>+6.2f}  {r['wpa_pa']:>4}  "
                  f"{r['peak_wpa']:>+6.3f}  {name} ({r['team']}, {r['position'] or '?'})")

        # Logan Macy spot-check (the known Phase E player)
        cur.execute("""
            SELECT SUM(wpa_batter) AS total_wpa, COUNT(*) AS pa,
                   MAX(wpa_batter) AS peak, AVG(ABS(wpa_batter)) AS mean_abs
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE ge.batter_player_id = 2789 AND g.season = %s
              AND ge.wpa_batter IS NOT NULL
        """, (SEASON,))
        r = cur.fetchone()
        if r and r["pa"]:
            print(f"\n── Logan Macy (2789, OIT SS) sanity ──")
            print(f"  total_wpa: {r['total_wpa']:+.3f}  PAs: {r['pa']}  "
                  f"peak: {r['peak']:+.3f}  mean|WPA|: {r['mean_abs']:.4f}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
