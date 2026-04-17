"""
Diagnostic: why is Nigel Fahland showing only 3 games in vs-RHP?

Usage (from Mac, repo root):
    PYTHONPATH=backend python3 scripts/check_fahland.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection  # noqa: E402


def main():
    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute("SELECT id FROM teams WHERE short_name ILIKE 'Bushnell' OR name ILIKE 'Bushnell%' LIMIT 1")
        team = cur.fetchone()
        tid = team["id"]

        # All Fahland rows for this team this season with opposing pitcher hand
        cur.execute(
            """
            SELECT g.id AS game_id, g.game_date, gb.batting_order, gb.position,
                   op.throws AS opp_throws,
                   g.home_team_id, g.away_team_id
            FROM game_batting gb
            JOIN games g ON g.id = gb.game_id
            LEFT JOIN LATERAL (
                SELECT gp.player_id, gp.team_id
                FROM game_pitching gp
                WHERE gp.game_id = g.id AND gp.is_starter = TRUE
                  AND gp.team_id <> %s
                LIMIT 1
            ) osp ON TRUE
            LEFT JOIN players op ON op.id = osp.player_id
            WHERE gb.team_id = %s
              AND g.season = 2026
              AND gb.player_name ILIKE '%%Fahland%%'
            ORDER BY g.game_date
            """,
            (tid, tid),
        )
        rows = cur.fetchall()

        print(f"\nTotal Fahland rows in 2026 for Bushnell: {len(rows)}\n")

        bo_counts = {}
        pos_counts = {}
        hand_buckets = {"R": 0, "L": 0, "?": 0}
        for r in rows:
            bo = r["batting_order"]
            pos = (r["position"] or "").upper()
            hand = r["opp_throws"] or "?"
            bo_counts[bo] = bo_counts.get(bo, 0) + 1
            pos_counts[pos] = pos_counts.get(pos, 0) + 1
            hand_buckets[hand if hand in ("R", "L") else "?"] += 1
            print(
                f"  {r['game_date']}  game_id={r['game_id']:<5} bo={bo:<3} pos={pos:<5} opp_SP_hand={hand}"
            )

        print(f"\nBy batting_order: {bo_counts}")
        print(f"By position:      {pos_counts}")
        print(f"By opp-SP hand:   vs RHP={hand_buckets['R']}  vs LHP={hand_buckets['L']}  unknown={hand_buckets['?']}")
        print(
            f"\nStarters (bo 1-9) vs RHP: "
            f"{sum(1 for r in rows if (r['batting_order'] or 0) <= 9 and (r['batting_order'] or 0) >= 1 and r['opp_throws'] == 'R')}"
        )
        print(
            f"Starters (bo 1-9) vs LHP: "
            f"{sum(1 for r in rows if (r['batting_order'] or 0) <= 9 and (r['batting_order'] or 0) >= 1 and r['opp_throws'] == 'L')}"
        )
        print(
            f"Subs (bo >= 100) vs RHP:  "
            f"{sum(1 for r in rows if (r['batting_order'] or 0) >= 100 and r['opp_throws'] == 'R')}"
        )


if __name__ == "__main__":
    main()
