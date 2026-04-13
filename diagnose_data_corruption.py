#!/usr/bin/env python3
"""
Deep dive into data corruption patterns in player names.

Run with: PYTHONPATH=backend python diagnose_data_corruption.py
"""

import re
from app.models.database import get_connection

def main():
    print("=" * 80)
    print("DATA CORRUPTION ANALYSIS - Player Name Patterns")
    print("=" * 80)
    print()

    with get_connection() as conn:
        cur = conn.cursor()

        # ============================================================
        # Analyze 'b' prefix corruption
        # ============================================================
        print("ANALYSIS 1: 'b' Prefix Corruption")
        print("-" * 80)

        cur.execute("""
            SELECT
                COUNT(*) as count,
                CASE
                    WHEN player_name LIKE 'b%' THEN 'Prefixed with b'
                    WHEN player_name LIKE 'B%' THEN 'Prefixed with B (uppercase)'
                    ELSE 'Other'
                END as pattern
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            WHERE g.season = 2026
            AND gb.player_id IS NULL
            AND (player_name LIKE 'b%' OR player_name LIKE 'B%')
            GROUP BY pattern
        """)

        corruption_results = cur.fetchall()
        total_corrupted = sum([row['count'] for row in corruption_results])
        print(f"\nTotal rows with b/B prefix corruption: {total_corrupted:,}")
        for row in corruption_results:
            pct = 100.0 * row['count'] / total_corrupted if total_corrupted > 0 else 0
            print(f"  {row['pattern']}: {row['count']:,} ({pct:.1f}%)")

        # Show samples
        print("\n  Sample corrupted names:")
        cur.execute("""
            SELECT DISTINCT player_name
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            WHERE g.season = 2026
            AND gb.player_id IS NULL
            AND player_name LIKE 'b%'
            ORDER BY player_name
            LIMIT 30
        """)

        for row in cur.fetchall():
            print(f"    {row['player_name']}")

        # ============================================================
        # Analyze abbreviated vs full names
        # ============================================================
        print()
        print("ANALYSIS 2: Name Abbreviation Patterns")
        print("-" * 80)

        cur.execute("""
            SELECT
                CASE
                    WHEN player_name ~ '^[A-Z]\. ' THEN 'Initial. Last (single initial)'
                    WHEN player_name ~ '^[A-Z]{2,} ' THEN 'Abbrev Last (2+ letters)'
                    WHEN player_name ~ ', ' THEN 'Last, First (comma)'
                    WHEN player_name ~ '^[A-Z][a-z]+ [A-Z]' THEN 'First Last (full)'
                    ELSE 'Other'
                END as name_pattern,
                COUNT(*) as count
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            WHERE g.season = 2026
            AND gb.player_id IS NULL
            GROUP BY name_pattern
            ORDER BY count DESC
        """)

        print("\nPlayer name patterns (NULL player_id only):")
        total_nulls = 0
        for row in cur.fetchall():
            print(f"  {row['name_pattern']}: {row['count']:,}")
            total_nulls += row['count']

        # ============================================================
        # Analyze special characters and suffixes
        # ============================================================
        print()
        print("ANALYSIS 3: Special Characters and Suffixes")
        print("-" * 80)

        cur.execute("""
            SELECT
                CASE
                    WHEN player_name LIKE '% III%' THEN 'Suffix: III'
                    WHEN player_name LIKE '% II%' THEN 'Suffix: II'
                    WHEN player_name LIKE '% Jr%' THEN 'Suffix: Jr'
                    WHEN player_name LIKE '% Sr%' THEN 'Suffix: Sr'
                    WHEN player_name LIKE '%-%' THEN 'Hyphenated'
                    WHEN player_name ~ '''' THEN 'Contains apostrophe'
                    ELSE 'No special chars'
                END as special_pattern,
                COUNT(*) as count
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            WHERE g.season = 2026
            AND gb.player_id IS NULL
            GROUP BY special_pattern
            ORDER BY count DESC
        """)

        print("\nSpecial character patterns:")
        for row in cur.fetchall():
            print(f"  {row['special_pattern']}: {row['count']:,}")

        # Show samples with suffixes
        print("\n  Sample names with suffixes:")
        cur.execute("""
            SELECT DISTINCT player_name
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            WHERE g.season = 2026
            AND gb.player_id IS NULL
            AND (player_name LIKE '% III%' OR player_name LIKE '% II%' OR player_name LIKE '% Jr%')
            ORDER BY player_name
            LIMIT 20
        """)

        for row in cur.fetchall():
            print(f"    {row['player_name']}")

        # ============================================================
        # Check for duplicate player names with different player_ids
        # ============================================================
        print()
        print("ANALYSIS 4: Matched vs Unmatched - Same Name Different player_id")
        print("-" * 80)

        cur.execute("""
            SELECT
                gb.player_name,
                gb.team_id,
                COUNT(DISTINCT gb.player_id) as distinct_player_ids,
                SUM(CASE WHEN gb.player_id IS NULL THEN 1 ELSE 0 END) as null_count,
                SUM(CASE WHEN gb.player_id IS NOT NULL THEN 1 ELSE 0 END) as matched_count
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            WHERE g.season = 2026
            GROUP BY gb.player_name, gb.team_id
            HAVING COUNT(DISTINCT gb.player_id) > 1
            ORDER BY matched_count DESC, null_count DESC
            LIMIT 20
        """)

        results = cur.fetchall()
        if results:
            print("\nPlayer names with MULTIPLE different player_ids (data inconsistency):")
            for row in results:
                print(f"  '{row['player_name']}' (team_id {row['team_id']})")
                print(f"    Distinct player_ids: {row['distinct_player_ids']}")
                print(f"    NULL: {row['null_count']}, Matched: {row['matched_count']}")
        else:
            print("\nNo duplicate name inconsistencies found (good sign)")

        # ============================================================
        # Look for obvious non-matching issues
        # ============================================================
        print()
        print("ANALYSIS 5: Sample Comparison of NULL vs Matched Same Names")
        print("-" * 80)

        cur.execute("""
            WITH player_name_summary AS (
                SELECT
                    player_name,
                    team_id,
                    SUM(CASE WHEN player_id IS NULL THEN 1 ELSE 0 END) as null_rows,
                    SUM(CASE WHEN player_id IS NOT NULL THEN 1 ELSE 0 END) as matched_rows,
                    COUNT(DISTINCT CASE WHEN player_id IS NOT NULL THEN player_id END) as distinct_matches
                FROM game_batting gb
                JOIN games g ON gb.game_id = g.id
                WHERE g.season = 2026
                GROUP BY player_name, team_id
            )
            SELECT *
            FROM player_name_summary
            WHERE null_rows > 0
            AND matched_rows > 0
            ORDER BY matched_rows DESC
            LIMIT 15
        """)

        results = cur.fetchall()
        if results:
            print("\nSame player name appearing BOTH matched and unmatched:")
            for row in results:
                print(f"  '{row['player_name']}' (team {row['team_id']})")
                print(f"    NULL rows: {row['null_rows']}, Matched rows: {row['matched_rows']}, Distinct IDs: {row['distinct_matches']}")
        else:
            print("\nNo split names found (each name is consistently NULL or matched)")

        print()
        print("=" * 80)
        print("CORRUPTION ANALYSIS COMPLETE")
        print("=" * 80)


if __name__ == '__main__':
    main()
