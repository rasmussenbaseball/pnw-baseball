#!/usr/bin/env python3
"""
Merge duplicate player records created when name cleanup + re-scrape
produced new players alongside the renamed originals.

For each duplicate set: keep the LOWER id, delete the higher id's stats
(since the original already has the same stats), then delete the higher id.

Usage:
    cd pnw-baseball
    PYTHONPATH=backend python3 scripts/merge_duplicate_players.py
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
from app.models.database import get_connection

# Tables that have a player_id foreign key
PLAYER_FK_TABLES = [
    "batting_stats",
    "pitching_stats",
    "game_batting",
    "game_pitching",
]

with get_connection() as conn:
    cur = conn.cursor()

    # Find duplicate players (same first_name, last_name, team_id)
    cur.execute("""
        SELECT first_name, last_name, team_id,
               ARRAY_AGG(id ORDER BY id) AS player_ids
        FROM players
        GROUP BY first_name, last_name, team_id
        HAVING COUNT(*) > 1
    """)
    dupes = cur.fetchall()
    print(f"Found {len(dupes)} sets of duplicate players\n")

    total_deleted_rows = 0
    total_deleted_players = 0

    for d in dupes:
        ids = d["player_ids"]
        keep_id = ids[0]       # lowest id — the original
        remove_ids = ids[1:]   # higher ids — the duplicates

        name = f"{d['first_name']} {d['last_name']}"

        for rid in remove_ids:
            # Delete all stat rows belonging to the duplicate player.
            # The original player already has its own stats, so we just
            # remove the duplicate's data rather than trying to merge.
            for table in PLAYER_FK_TABLES:
                cur.execute(
                    f"DELETE FROM {table} WHERE player_id = %s",
                    (rid,)
                )
                removed = cur.rowcount
                if removed:
                    total_deleted_rows += removed

            # Delete the duplicate player record
            cur.execute("DELETE FROM players WHERE id = %s", (rid,))
            total_deleted_players += 1

    conn.commit()
    print(f"Done! Deleted {total_deleted_rows} orphaned stat rows and {total_deleted_players} duplicate players.")
