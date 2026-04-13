#!/usr/bin/env python3
"""
Diagnose player matching issues in game_batting and game_pitching tables.

Run with: PYTHONPATH=backend python diagnose_player_matching.py
"""

import sys
from app.models.database import get_connection

def format_count(count):
    """Format a number with thousands separator."""
    return f"{count:,}"

def main():
    print("=" * 80)
    print("PLAYER MATCHING DIAGNOSIS")
    print("=" * 80)
    print()

    with get_connection() as conn:
        cur = conn.cursor()

        # ============================================================
        # Query 1: Count total rows vs NULL player_id for season 2026
        # ============================================================
        print("QUERY 1: Total rows vs NULL player_id (season 2026)")
        print("-" * 80)

        cur.execute("""
            SELECT
                'game_batting' as table_name,
                COUNT(*) as total_rows,
                SUM(CASE WHEN player_id IS NULL THEN 1 ELSE 0 END) as null_player_id_rows,
                ROUND(100.0 * SUM(CASE WHEN player_id IS NULL THEN 1 ELSE 0 END) / COUNT(*), 2) as pct_null
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            WHERE g.season = 2026
            UNION ALL
            SELECT
                'game_pitching' as table_name,
                COUNT(*) as total_rows,
                SUM(CASE WHEN player_id IS NULL THEN 1 ELSE 0 END) as null_player_id_rows,
                ROUND(100.0 * SUM(CASE WHEN player_id IS NULL THEN 1 ELSE 0 END) / COUNT(*), 2) as pct_null
            FROM game_pitching gp
            JOIN games g ON gp.game_id = g.id
            WHERE g.season = 2026
        """)

        for row in cur.fetchall():
            print(f"  Table: {row['table_name']}")
            print(f"    Total rows: {format_count(row['total_rows'])}")
            print(f"    NULL player_id: {format_count(row['null_player_id_rows'])}")
            print(f"    Percentage NULL: {row['pct_null']}%")
            print()

        # ============================================================
        # Query 2: Sample NULL player_ids grouped by team
        # ============================================================
        print("QUERY 2: Teams with most NULL player_ids (top 20)")
        print("-" * 80)

        cur.execute("""
            SELECT
                t.short_name,
                COUNT(*) as null_count,
                STRING_AGG(DISTINCT gb.player_name, ', ' ORDER BY gb.player_name) as sample_names
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            JOIN teams t ON gb.team_id = t.id
            WHERE g.season = 2026
            AND gb.player_id IS NULL
            GROUP BY t.short_name
            ORDER BY null_count DESC
            LIMIT 20
        """)

        teams_with_nulls = cur.fetchall()
        for row in teams_with_nulls:
            print(f"  {row['short_name']}: {format_count(row['null_count'])} NULL player_ids")
        print()

        # ============================================================
        # Query 3: Sample player names with NULL player_id for top 5 teams
        # ============================================================
        print("QUERY 3: Sample player names with NULL player_id (top 5 teams)")
        print("-" * 80)

        top_5_teams = [row['short_name'] for row in teams_with_nulls[:5]]

        for team_short_name in top_5_teams:
            print(f"\n  Team: {team_short_name}")
            cur.execute("""
                SELECT DISTINCT gb.player_name
                FROM game_batting gb
                JOIN games g ON gb.game_id = g.id
                JOIN teams t ON gb.team_id = t.id
                WHERE g.season = 2026
                AND gb.player_id IS NULL
                AND t.short_name = %s
                ORDER BY gb.player_name
                LIMIT 10
            """, (team_short_name,))

            names = cur.fetchall()
            for name_row in names:
                print(f"    - {name_row['player_name']}")

        print()

        # ============================================================
        # Query 4: Compare unmatched names with players table
        # ============================================================
        print("QUERY 4: Name format comparison (unmatched vs players table)")
        print("-" * 80)

        # Get sample player names from top 5 teams
        placeholders = ', '.join(['%s'] * len(top_5_teams))

        cur.execute(f"""
            SELECT DISTINCT gb.player_name, gb.team_id
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            JOIN teams t ON gb.team_id = t.id
            WHERE g.season = 2026
            AND gb.player_id IS NULL
            AND t.short_name IN ({placeholders})
            ORDER BY gb.player_name
            LIMIT 50
        """, top_5_teams)

        sample_rows = cur.fetchall()

        print(f"\n  Checking {len(sample_rows)} sample unmatched player names against players table...")
        print()

        for sample in sample_rows[:15]:  # Show first 15 samples
            player_name = sample['player_name']
            team_id = sample['team_id']

            # Look for players in the same team
            cur.execute("""
                SELECT
                    p.first_name,
                    p.last_name,
                    p.id
                FROM players p
                WHERE p.team_id = %s
                AND (
                    LOWER(CONCAT(p.first_name, ' ', p.last_name)) = LOWER(%s)
                    OR LOWER(CONCAT(p.last_name, ', ', p.first_name)) = LOWER(%s)
                    OR LOWER(CONCAT(p.last_name, ' ', p.first_name)) = LOWER(%s)
                )
                LIMIT 3
            """, (team_id, player_name, player_name, player_name))

            matches = cur.fetchall()

            if matches:
                print(f"  game_batting name: '{player_name}'")
                for match in matches:
                    print(f"    Potential match: {match['first_name']} {match['last_name']} (ID: {match['id']})")
            else:
                print(f"  game_batting name: '{player_name}' - NO MATCH in players table")

        print()

        # ============================================================
        # Query 5: Name format analysis (comma-separated vs space-separated)
        # ============================================================
        print("QUERY 5: Player name format analysis")
        print("-" * 80)

        cur.execute("""
            SELECT
                CASE
                    WHEN player_name LIKE '%,%' THEN 'Last, First (comma)'
                    ELSE 'First Last (space)'
                END as name_format,
                COUNT(*) as count,
                ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) as percentage
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            WHERE g.season = 2026
            AND gb.player_id IS NULL
            GROUP BY
                CASE
                    WHEN player_name LIKE '%,%' THEN 'Last, First (comma)'
                    ELSE 'First Last (space)'
                END
            ORDER BY count DESC
        """)

        for row in cur.fetchall():
            print(f"  {row['name_format']}: {format_count(row['count'])} rows ({row['percentage']}%)")

        print()

        # Also check the same for game_pitching
        cur.execute("""
            SELECT
                CASE
                    WHEN player_name LIKE '%,%' THEN 'Last, First (comma)'
                    ELSE 'First Last (space)'
                END as name_format,
                COUNT(*) as count,
                ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) as percentage
            FROM game_pitching gp
            JOIN games g ON gp.game_id = g.id
            WHERE g.season = 2026
            AND gp.player_id IS NULL
            GROUP BY
                CASE
                    WHEN player_name LIKE '%,%' THEN 'Last, First (comma)'
                    ELSE 'First Last (space)'
                END
            ORDER BY count DESC
        """)

        pitching_results = cur.fetchall()
        if pitching_results:
            print("  GAME_PITCHING (for comparison):")
            for row in pitching_results:
                print(f"    {row['name_format']}: {format_count(row['count'])} rows ({row['percentage']}%)")

        print()
        print("=" * 80)
        print("DIAGNOSIS COMPLETE")
        print("=" * 80)


if __name__ == '__main__':
    main()
