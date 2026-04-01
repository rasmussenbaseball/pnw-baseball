#!/usr/bin/env python3
"""
One-time migration: Add roster_year column to players table
and backfill it for current season (2026) players based on
who has stats in 2026.
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))
from app.models.database import get_connection

def main():
    with get_connection() as conn:
        cur = conn.cursor()

        # Add roster_year column if it doesn't exist
        cur.execute("""
            ALTER TABLE players ADD COLUMN IF NOT EXISTS roster_year INTEGER
        """)
        conn.commit()
        print("Added roster_year column (or it already existed)")

        # Backfill: set roster_year = 2026 for all players who have
        # batting or pitching stats in 2026
        cur.execute("""
            UPDATE players SET roster_year = 2026
            WHERE id IN (
                SELECT DISTINCT player_id FROM batting_stats WHERE season = 2026
                UNION
                SELECT DISTINCT player_id FROM pitching_stats WHERE season = 2026
            )
        """)
        updated = cur.rowcount
        conn.commit()
        print(f"Backfilled roster_year=2026 for {updated} players with 2026 stats")

        # Show per-team counts
        cur.execute("""
            SELECT t.short_name, COUNT(*) as cnt
            FROM players p
            JOIN teams t ON p.team_id = t.id
            WHERE p.roster_year = 2026
            GROUP BY t.short_name
            ORDER BY cnt DESC
            LIMIT 20
        """)
        print("\nTop 20 teams by 2026 roster count:")
        for row in cur.fetchall():
            print(f"  {row['short_name']}: {row['cnt']}")

        cur.close()

if __name__ == "__main__":
    main()
