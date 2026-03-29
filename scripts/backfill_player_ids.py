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


def clean_position_prefixes(cur):
    """
    Strip position-code prefixes from player_name in game_batting.
    The box-score scraper sometimes stores names like "ssIsaac Bateman",
    "cfChase Elliott", "bPeyton Rickard" (where "b" = 2B, "ss" = SS, etc.).
    We also extract the position into the position column if it's empty.
    """
    print("\nStep 1.5: Cleaning position prefixes from game_batting names...")

    # Known lowercase position prefixes that get stuck on names.
    # Order matters — check longer prefixes first so "ss" isn't caught by "s".
    # These are the common ones seen in box score scrapes.
    prefixes_sql = """
        CASE
            WHEN player_name ~ '^(dh)[A-Z]'  THEN 2
            WHEN player_name ~ '^(ss)[A-Z]'  THEN 2
            WHEN player_name ~ '^(cf)[A-Z]'  THEN 2
            WHEN player_name ~ '^(rf)[A-Z]'  THEN 2
            WHEN player_name ~ '^(lf)[A-Z]'  THEN 2
            WHEN player_name ~ '^(1b)[A-Z]'  THEN 2
            WHEN player_name ~ '^(2b)[A-Z]'  THEN 2
            WHEN player_name ~ '^(3b)[A-Z]'  THEN 2
            WHEN player_name ~ '^(pr)[A-Z]'  THEN 2
            WHEN player_name ~ '^(ph)[A-Z]'  THEN 2
            WHEN player_name ~ '^(dp)[A-Z]'  THEN 2
            WHEN player_name ~ '^(c)[A-Z]'   THEN 1
            WHEN player_name ~ '^(p)[A-Z]'   THEN 1
            WHEN player_name ~ '^(b)[A-Z]'   THEN 1
            ELSE 0
        END
    """

    # Map single-char prefixes to position codes
    pos_map_sql = """
        CASE LOWER(SUBSTRING(player_name FROM 1 FOR (
            CASE
                WHEN player_name ~ '^(dh)[A-Z]'  THEN 2
                WHEN player_name ~ '^(ss)[A-Z]'  THEN 2
                WHEN player_name ~ '^(cf)[A-Z]'  THEN 2
                WHEN player_name ~ '^(rf)[A-Z]'  THEN 2
                WHEN player_name ~ '^(lf)[A-Z]'  THEN 2
                WHEN player_name ~ '^(1b)[A-Z]'  THEN 2
                WHEN player_name ~ '^(2b)[A-Z]'  THEN 2
                WHEN player_name ~ '^(3b)[A-Z]'  THEN 2
                WHEN player_name ~ '^(pr)[A-Z]'  THEN 2
                WHEN player_name ~ '^(ph)[A-Z]'  THEN 2
                WHEN player_name ~ '^(dp)[A-Z]'  THEN 2
                WHEN player_name ~ '^(c)[A-Z]'   THEN 1
                WHEN player_name ~ '^(p)[A-Z]'   THEN 1
                WHEN player_name ~ '^(b)[A-Z]'   THEN 1
                ELSE 0
            END
        )))
            WHEN 'ss' THEN 'SS'
            WHEN 'cf' THEN 'CF'
            WHEN 'rf' THEN 'RF'
            WHEN 'lf' THEN 'LF'
            WHEN '1b' THEN '1B'
            WHEN '2b' THEN '2B'
            WHEN '3b' THEN '3B'
            WHEN 'dh' THEN 'DH'
            WHEN 'pr' THEN 'PR'
            WHEN 'ph' THEN 'PH'
            WHEN 'dp' THEN 'DH'
            WHEN 'c'  THEN 'C'
            WHEN 'p'  THEN 'P'
            WHEN 'b'  THEN '2B'
            ELSE NULL
        END
    """

    # Update: strip prefix from name, optionally set position if blank
    cur.execute(f"""
        UPDATE game_batting
        SET player_name = SUBSTRING(player_name FROM ({prefixes_sql}) + 1),
            position = COALESCE(NULLIF(position, ''), ({pos_map_sql}))
        WHERE ({prefixes_sql}) > 0
    """)
    print(f"  Cleaned {cur.rowcount} rows with position prefixes")


def clean_game_batting_names(cur):
    """Normalize messy player_name values before matching."""
    print("\nStep 1.6: Cleaning game_batting names...")

    # Strip any remaining position prefixes with slash format
    # e.g. "cf/rfJennings, Albert" → "Jennings, Albert"
    cur.execute(r"""
        UPDATE game_batting
        SET player_name = REGEXP_REPLACE(player_name,
            '^[a-z0-9/]+(?=[A-Z])', '')
        WHERE player_id IS NULL
          AND player_name ~ '^[a-z0-9/]+[A-Z]'
    """)
    print(f"  Stripped remaining position prefixes: {cur.rowcount} rows")

    # Normalize extra whitespace: "Shelor , Will" → "Shelor, Will"
    cur.execute(r"""
        UPDATE game_batting
        SET player_name = REGEXP_REPLACE(TRIM(player_name), '\s+', ' ', 'g')
        WHERE player_id IS NULL
          AND player_name ~ '\s{2,}'
    """)
    print(f"  Normalized extra whitespace: {cur.rowcount} rows")

    # Remove space before comma: "Shelor , Will" → "Shelor, Will"
    cur.execute(r"""
        UPDATE game_batting
        SET player_name = REPLACE(player_name, ' ,', ',')
        WHERE player_id IS NULL
          AND player_name LIKE '% ,%'
    """)
    print(f"  Removed space-before-comma: {cur.rowcount} rows")


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

    # ── "F. Last" initial format → match by first initial + last name + team ──
    print("\n  Step 2b: Matching 'F. Last' initial format...")
    cur.execute("""
        UPDATE game_batting gb
        SET player_id = pl.id
        FROM players pl
        WHERE gb.player_id IS NULL
          AND gb.team_id = pl.team_id
          AND gb.player_name ~ '^[A-Z]\. '
          AND LOWER(SUBSTRING(gb.player_name FROM 1 FOR 1)) = LOWER(SUBSTRING(pl.first_name FROM 1 FOR 1))
          AND LOWER(TRIM(SUBSTRING(gb.player_name FROM 4))) = LOWER(TRIM(pl.last_name))
    """)
    print(f"  Matched {cur.rowcount} rows via 'F. Last' + team_id")

    # "F. Last" without team — only if unique first-initial + last name
    cur.execute("""
        UPDATE game_batting gb
        SET player_id = unique_pl.id
        FROM (
            SELECT LOWER(SUBSTRING(first_name FROM 1 FOR 1)) AS initial,
                   LOWER(TRIM(last_name)) AS lname,
                   MIN(id) AS id
            FROM players
            GROUP BY LOWER(SUBSTRING(first_name FROM 1 FOR 1)), LOWER(TRIM(last_name))
            HAVING COUNT(*) = 1
        ) unique_pl
        WHERE gb.player_id IS NULL
          AND gb.player_name ~ '^[A-Z]\. '
          AND LOWER(SUBSTRING(gb.player_name FROM 1 FOR 1)) = unique_pl.initial
          AND LOWER(TRIM(SUBSTRING(gb.player_name FROM 4))) = unique_pl.lname
    """)
    print(f"  Matched {cur.rowcount} rows via 'F. Last' (unique name only)")


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
        clean_position_prefixes(cur)   # strip "ssIsaac" → "Isaac"
        clean_game_batting_names(cur)  # strip "cf/rf...", fix whitespace
        backfill_game_batting(cur)
        update_quality_starts(cur)

        # Summary stats
        cur.execute("SELECT COUNT(*) as cnt FROM game_batting WHERE player_id IS NOT NULL")
        matched = cur.fetchone()["cnt"]
        cur.execute("SELECT COUNT(*) as cnt FROM game_batting WHERE player_id IS NULL AND team_id IS NOT NULL")
        unmatched = cur.fetchone()["cnt"]
        print(f"\n  game_batting total matched: {matched}, unmatched (with team): {unmatched}")

        conn.commit()
        print("\nDone! All changes committed.")


if __name__ == "__main__":
    backfill_player_ids()
