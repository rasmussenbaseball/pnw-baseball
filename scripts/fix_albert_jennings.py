"""
One-time fix for Albert Jennings game log issues:
1. Add The Master's University as a team
2. Fix games 1047-1050 (Feb 6-7 vs The Master's): set home_team_id
3. Fix batting/pitching team_id for those games to 24 (Bushnell)
4. Swap home/away on games 2343-2346 (Mar 27-28 vs Corban)
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

from app.models.database import get_connection


def main():
    with get_connection() as conn:
        cur = conn.cursor()

        # --- Step 1: Add The Master's University ---
        # Check if already exists
        cur.execute("SELECT id FROM teams WHERE name ILIKE %s", ('%master%',))
        row = cur.fetchone()
        if row:
            masters_id = row['id']
            print(f"The Master's already exists with id={masters_id}")
        else:
            cur.execute("""
                INSERT INTO teams (name, school_name, short_name, mascot, city, state, is_active)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id
            """, (
                "The Master's Mustangs",
                "The Master's University",
                "The Master's",
                "Mustangs",
                "Santa Clarita",
                "CA",
                True
            ))
            masters_id = cur.fetchone()['id']
            print(f"Added The Master's University with id={masters_id}")

        # --- Step 2: Fix games 1047-1050 (Feb 6-7) ---
        # These have home_team_id=None, away_team_id=24 (Bushnell)
        # Bushnell traveled TO The Master's, so The Master's is home
        masters_game_ids = [1047, 1048, 1049, 1050]
        cur.execute("""
            UPDATE games
            SET home_team_id = %s
            WHERE id = ANY(%s) AND home_team_id IS NULL
        """, (masters_id, masters_game_ids))
        print(f"Fixed home_team_id on {cur.rowcount} games (set to The Master's id={masters_id})")

        # --- Step 3: Fix batting team_id for those games ---
        # Albert (player_id=2894) has team_id=None on these games
        cur.execute("""
            UPDATE game_batting
            SET team_id = 24
            WHERE game_id = ANY(%s) AND player_id = 2894 AND team_id IS NULL
        """, (masters_game_ids,))
        print(f"Fixed {cur.rowcount} game_batting rows (set team_id=24 Bushnell)")

        cur.execute("""
            UPDATE game_pitching
            SET team_id = 24
            WHERE game_id = ANY(%s) AND player_id = 2894 AND team_id IS NULL
        """, (masters_game_ids,))
        print(f"Fixed {cur.rowcount} game_pitching rows (set team_id=24 Bushnell)")

        # --- Step 4: Swap home/away on Corban games ---
        # Games 2343-2346 (Mar 27-28): Bushnell=home, Corban=away
        # But Corban was actually home, so swap them
        corban_game_ids = [2343, 2344, 2345, 2346]
        cur.execute("""
            UPDATE games
            SET home_team_id = away_team_id,
                away_team_id = home_team_id
            WHERE id = ANY(%s)
        """, (corban_game_ids,))
        print(f"Swapped home/away on {cur.rowcount} Corban games")

        # --- Verify ---
        print("\n--- Verification ---")
        cur.execute("""
            SELECT g.id, g.game_date,
                   ht.name as home_team, at.name as away_team
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at ON g.away_team_id = at.id
            WHERE g.id = ANY(%s)
            ORDER BY g.game_date
        """, (masters_game_ids + corban_game_ids,))
        for r in cur.fetchall():
            print(f"  Game {r['id']} ({r['game_date']}): Home={r['home_team']} vs Away={r['away_team']}")

        conn.commit()
        print("\nAll fixes committed successfully!")


if __name__ == "__main__":
    main()
