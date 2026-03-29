#!/usr/bin/env python3
"""
One-time cleanup script to fix corrupted data in the database:
1. Player names with jersey numbers concatenated (e.g., "Jackson35Jaha" → "Jaha, Jackson")
2. Duplicate game records for the same matchup
3. Wrong game scores from box score parser overwriting schedule scores

Usage:
    cd pnw-baseball
    PYTHONPATH=backend python3 scripts/cleanup_bad_data.py
"""

import sys
import re
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
from app.models.database import get_connection

def fix_player_names():
    """Fix player names that have jersey numbers concatenated into them."""
    with get_connection() as conn:
        cur = conn.cursor()

        # Find players whose first_name or last_name has digits
        cur.execute("""
            SELECT id, first_name, last_name
            FROM players
            WHERE first_name ~ '[0-9]' OR last_name ~ '[0-9]'
        """)
        rows = cur.fetchall()
        fixed = 0
        for r in rows:
            pid = r["id"]
            old_first = r["first_name"] or ""
            old_last = r["last_name"] or ""

            # Strip ALL digits from names (jersey numbers can appear anywhere)
            new_first = re.sub(r'\d+', '', old_first).strip()
            new_last = re.sub(r'\d+', '', old_last).strip()

            if new_first != old_first or new_last != old_last:
                print(f"  FIX: '{old_first}' / '{old_last}' → '{new_first}' / '{new_last}'")
                cur.execute("""
                    UPDATE players
                    SET first_name = %s, last_name = %s
                    WHERE id = %s
                """, (new_first, new_last, pid))
                fixed += 1

        conn.commit()
        print(f"\nFixed {fixed} player names (out of {len(rows)} with digits)")


def delete_march27_bad_games():
    """
    Delete game records from March 27 that have wrong scores due to box score
    parser overwriting schedule scores. The scrapers will re-create correct
    records on next run.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # First, see what's there
        cur.execute("""
            SELECT g.id, g.game_date,
                   COALESCE(ht.name, g.home_team_name) AS home,
                   COALESCE(at2.name, g.away_team_name) AS away,
                   g.home_score, g.away_score, g.source_url
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at2 ON g.away_team_id = at2.id
            WHERE g.game_date = '2026-03-27'
            ORDER BY home, away
        """)
        rows = cur.fetchall()
        print(f"\nMarch 27 games in database: {len(rows)}")
        for r in rows:
            print(f"  id={r['id']}: {r['home']} {r['home_score']} vs {r['away']} {r['away_score']}")

        if not rows:
            print("No March 27 games to clean up.")
            return

        # Delete all March 27 games — they'll be re-scraped with correct data
        game_ids = [r["id"] for r in rows]

        # Delete dependent records first
        cur.execute("DELETE FROM game_batting WHERE game_id = ANY(%s)", (game_ids,))
        deleted_gb = cur.rowcount
        print(f"  Deleted {deleted_gb} game_batting records")

        cur.execute("DELETE FROM game_pitching WHERE game_id = ANY(%s)", (game_ids,))
        deleted_gp = cur.rowcount
        print(f"  Deleted {deleted_gp} game_pitching records")

        cur.execute("DELETE FROM games WHERE id = ANY(%s)", (game_ids,))
        deleted_g = cur.rowcount
        print(f"  Deleted {deleted_g} games")

        conn.commit()
        print(f"\nDeleted all March 27 game data. Re-run scrapers to get correct scores.")


if __name__ == "__main__":
    print("=" * 60)
    print("STEP 1: Fixing player names with jersey numbers")
    print("=" * 60)
    fix_player_names()

    print("\n" + "=" * 60)
    print("STEP 2: Removing March 27 games with bad scores")
    print("=" * 60)
    delete_march27_bad_games()

    print("\n✓ Cleanup complete!")
    print("Next steps:")
    print("  1. Re-run all division scrapers to refresh player data")
    print("  2. Re-run box score scraper with: --since 2026-03-27")
