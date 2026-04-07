#!/usr/bin/env python3
"""Quick diagnostic: why is Albert Jennings (and others) only partially matched?"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
from app.models.database import get_connection


def run():
    with get_connection() as conn:
        cur = conn.cursor()

        # 1. Find Albert Jennings in players table
        print("=== Albert Jennings in players table ===")
        cur.execute("SELECT id, team_id, first_name, last_name FROM players WHERE last_name ILIKE 'Jennings' AND first_name ILIKE 'Albert%'")
        for r in cur.fetchall():
            print(dict(r))

        # 2. All his game_batting rows (matched and unmatched)
        print("\n=== His game_batting rows ===")
        cur.execute("""
            SELECT gb.player_name, gb.player_id, gb.team_id as gb_team_id, t.short_name as gb_team,
                   g.game_date, g.opponent
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            LEFT JOIN teams t ON gb.team_id = t.id
            WHERE gb.player_name ILIKE '%Jennings%Albert%'
               OR gb.player_name ILIKE '%Albert%Jennings%'
            ORDER BY g.game_date
        """)
        for r in cur.fetchall():
            print(dict(r))

        # 3. Top 30 unmatched player names (most common)
        print("\n=== Top 30 unmatched player_name patterns (NULL player_id) ===")
        cur.execute("""
            SELECT gb.player_name, gb.team_id, t.short_name, COUNT(*) as cnt
            FROM game_batting gb
            LEFT JOIN teams t ON gb.team_id = t.id
            WHERE gb.player_id IS NULL AND gb.team_id IS NOT NULL
            GROUP BY gb.player_name, gb.team_id, t.short_name
            ORDER BY cnt DESC LIMIT 30
        """)
        for r in cur.fetchall():
            print(dict(r))

        # 4. Check if team_id mismatch is the issue
        print("\n=== Unmatched rows where player EXISTS but team_id differs ===")
        cur.execute("""
            SELECT gb.player_name, gb.team_id as box_team_id, t1.short_name as box_team,
                   p.id as player_id, p.team_id as player_team_id, t2.short_name as player_team
            FROM game_batting gb
            JOIN teams t1 ON gb.team_id = t1.id
            JOIN players p ON (
                LOWER(TRIM(gb.player_name)) = LOWER(TRIM(p.first_name) || ' ' || TRIM(p.last_name))
                OR LOWER(TRIM(gb.player_name)) = LOWER(TRIM(p.last_name) || ', ' || TRIM(p.first_name))
            )
            JOIN teams t2 ON p.team_id = t2.id
            WHERE gb.player_id IS NULL
              AND gb.team_id != p.team_id
            LIMIT 20
        """)
        for r in cur.fetchall():
            print(dict(r))

        # 5. Sample of unmatched names
        print("\n=== Sample unmatched names (random 20) ===")
        cur.execute("""
            SELECT DISTINCT gb.player_name, t.short_name
            FROM game_batting gb
            LEFT JOIN teams t ON gb.team_id = t.id
            WHERE gb.player_id IS NULL AND gb.team_id IS NOT NULL
            ORDER BY RANDOM() LIMIT 20
        """)
        for r in cur.fetchall():
            print(dict(r))


if __name__ == "__main__":
    run()
