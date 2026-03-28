#!/usr/bin/env python3
"""
Backfill player_id in game_batting and game_pitching tables
by matching player_name + team_id against the players table.

Also updates pitching_stats.quality_starts from game_pitching data.

Usage:
    cd pnw-baseball
    PYTHONPATH=backend python3 scripts/backfill_player_ids.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from app.models.database import get_connection


def backfill_game_pitching(cur):
    """Match game_pitching rows to players by name."""
    print("Step 1a: Backfilling player_id in game_pitching (name + team_id)...")

    # Match on "First Last" format (with team_id)
    cur.execute("""
        UPDATE game_pitching gp
        SET player_id = pl.id
        FROM players pl
        WHERE gp.player_id IS NULL
          AND gp.team_id = pl.team_id
          AND LOWER(TRIM(gp.player_name)) = LOWER(TRIM(pl.first_name) || ' ' || TRIM(pl.last_name))
    """)
    print(f"  Matched {cur.rowcount} rows via 'First Last' + team_id")

    # Match on "Last, First" format (with team_id)
    cur.execute("""
        UPDATE game_pitching gp
        SET player_id = pl.id
        FROM players pl
        WHERE gp.player_id IS NULL
          AND gp.team_id = pl.team_id
          AND LOWER(TRIM(gp.player_name)) = LOWER(TRIM(pl.last_name) || ', ' || TRIM(pl.first_name))
    """)
    print(f"  Matched {cur.rowcount} rows via 'Last, First' + team_id")

    # Match on "Last,First" format (with team_id)
    cur.execute("""
        UPDATE game_pitching gp
        SET player_id = pl.id
        FROM players pl
        WHERE gp.player_id IS NULL
          AND gp.team_id = pl.team_id
          AND LOWER(TRIM(gp.player_name)) = LOWER(TRIM(pl.last_name) || ',' || TRIM(pl.first_name))
    """)
    print(f"  Matched {cur.rowcount} rows via 'Last,First' + team_id")

    # --- Now try matching WITHOUT team_id for remaining unmatched ---
    # Only match when the name uniquely identifies one player
    print("\nStep 1b: Matching remaining by name only (unique names)...")

    # "First Last" format - name-only match (unique players only)
    cur.execute("""
        UPDATE game_pitching gp
        SET player_id = unique_pl.id
        FROM (
            SELECT LOWER(TRIM(first_name) || ' ' || TRIM(last_name)) AS full_name,
                   MIN(id) AS id
            FROM players
            GROUP BY LOWER(TRIM(first_name) || ' ' || TRIM(last_name))
            HAVING COUNT(*) = 1
        ) unique_pl
        WHERE gp.player_id IS NULL
          AND LOWER(TRIM(gp.player_name)) = unique_pl.full_name
    """)
    print(f"  Matched {cur.rowcount} rows via 'First Last' (unique name only)")

    # "Last, First" format - name-only match
    cur.execute("""
        UPDATE game_pitching gp
        SET player_id = unique_pl.id
        FROM (
            SELECT LOWER(TRIM(last_name) || ', ' || TRIM(first_name)) AS full_name,
                   MIN(id) AS id
            FROM players
            GROUP BY LOWER(TRIM(last_name) || ', ' || TRIM(first_name))
            HAVING COUNT(*) = 1
        ) unique_pl
        WHERE gp.player_id IS NULL
          AND LOWER(TRIM(gp.player_name)) = unique_pl.full_name
    """)
    print(f"  Matched {cur.rowcount} rows via 'Last, First' (unique name only)")

    # "Last,First" format - name-only match
    cur.execute("""
        UPDATE game_pitching gp
        SET player_id = unique_pl.id
        FROM (
            SELECT LOWER(TRIM(last_name) || ',' || TRIM(first_name)) AS full_name,
                   MIN(id) AS id
            FROM players
            GROUP BY LOWER(TRIM(last_name) || ',' || TRIM(first_name))
            HAVING COUNT(*) = 1
        ) unique_pl
        WHERE gp.player_id IS NULL
          AND LOWER(TRIM(gp.player_name)) = unique_pl.full_name
    """)
    print(f"  Matched {cur.rowcount} rows via 'Last,First' (unique name only)")

    # Check remaining
    cur.execute("SELECT COUNT(*) as cnt FROM game_pitching WHERE player_id IS NULL AND team_id IS NOT NULL")
    remaining = cur.fetchone()["cnt"]
    cur.execute("SELECT COUNT(*) as cnt FROM game_pitching WHERE player_id IS NOT NULL")
    total_matched = cur.fetchone()["cnt"]
    print(f"\n  Total matched: {total_matched}, remaining unmatched (with team_id): {remaining}")


def backfill_game_batting(cur):
    """Match game_batting rows to players by name."""
    print("\nStep 2: Backfilling player_id in game_batting...")

    for fmt_name, expr in [
        ("First Last", "LOWER(TRIM(pl.first_name) || ' ' || TRIM(pl.last_name))"),
        ("Last, First", "LOWER(TRIM(pl.last_name) || ', ' || TRIM(pl.first_name))"),
        ("Last,First", "LOWER(TRIM(pl.last_name) || ',' || TRIM(pl.first_name))"),
    ]:
        # With team_id
        cur.execute(f"""
            UPDATE game_batting gb
            SET player_id = pl.id
            FROM players pl
            WHERE gb.player_id IS NULL
              AND gb.team_id = pl.team_id
              AND LOWER(TRIM(gb.player_name)) = {expr}
        """)
        print(f"  Matched {cur.rowcount} rows via '{fmt_name}' + team_id")

    # Name-only for unique names
    for fmt_name, expr in [
        ("First Last", "LOWER(TRIM(first_name) || ' ' || TRIM(last_name))"),
        ("Last, First", "LOWER(TRIM(last_name) || ', ' || TRIM(first_name))"),
        ("Last,First", "LOWER(TRIM(last_name) || ',' || TRIM(first_name))"),
    ]:
        cur.execute(f"""
            UPDATE game_batting gb
            SET player_id = unique_pl.id
            FROM (
                SELECT {expr} AS full_name, MIN(id) AS id
                FROM players
                GROUP BY {expr}
                HAVING COUNT(*) = 1
            ) unique_pl
            WHERE gb.player_id IS NULL
              AND LOWER(TRIM(gb.player_name)) = unique_pl.full_name
        """)
        print(f"  Matched {cur.rowcount} rows via '{fmt_name}' (unique name only)")


def update_quality_starts(cur):
    """Update pitching_stats.quality_starts from game_pitching data."""
    print("\nStep 3: Updating pitching_stats.quality_starts from game logs...")

    # First reset all to 0 so re-runs are clean
    cur.execute("UPDATE pitching_stats SET quality_starts = 0 WHERE quality_starts != 0")
    print(f"  Reset {cur.rowcount} rows to 0")

    # Count QS per player using DISTINCT game_date to avoid duplicates.
    # Same real-world game can exist as multiple DB records (scraped from
    # both teams' sites), but a pitcher never starts twice on the same day.
    cur.execute("""
        UPDATE pitching_stats ps
        SET quality_starts = qs.cnt
        FROM (
            SELECT gp.player_id, g.season,
                   COUNT(DISTINCT g.game_date) FILTER (WHERE gp.is_quality_start = TRUE) AS cnt
            FROM game_pitching gp
            JOIN games g ON gp.game_id = g.id
            WHERE gp.player_id IS NOT NULL
            GROUP BY gp.player_id, g.season
        ) qs
        WHERE ps.player_id = qs.player_id
          AND ps.season = qs.season
          AND qs.cnt > 0
    """)
    print(f"  Updated quality_starts for {cur.rowcount} pitching_stats rows")

    # Show top QS
    cur.execute("""
        SELECT p.first_name, p.last_name, ps.quality_starts, t.short_name
        FROM pitching_stats ps
        JOIN players p ON ps.player_id = p.id
        JOIN teams t ON ps.team_id = t.id
        WHERE ps.season = 2026 AND ps.quality_starts > 0
        ORDER BY ps.quality_starts DESC
        LIMIT 10
    """)
    print("\n  Top QS leaders:")
    for row in cur.fetchall():
        print(f"    {row['first_name']} {row['last_name']} ({row['short_name']}): {row['quality_starts']} QS")


def backfill_player_ids():
    with get_connection() as conn:
        cur = conn.cursor()
        backfill_game_pitching(cur)
        backfill_game_batting(cur)
        update_quality_starts(cur)
        conn.commit()
        print("\nDone! All changes committed.")


if __name__ == "__main__":
    backfill_player_ids()
