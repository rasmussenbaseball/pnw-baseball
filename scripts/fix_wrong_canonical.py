#!/usr/bin/env python3
"""
Fix player_links where the canonical player has no 2026 stats
but a linked player does. Swaps the canonical to the player
with current-season stats.

Usage:
    cd /opt/pnw-baseball
    PYTHONPATH=backend python3 scripts/fix_wrong_canonical.py
    PYTHONPATH=backend python3 scripts/fix_wrong_canonical.py --dry-run
"""

import sys
from collections import defaultdict
from app.models.database import get_connection

DRY_RUN = "--dry-run" in sys.argv


def main():
    with get_connection() as conn:
        cur = conn.cursor()

        # Find all links where canonical has NO 2026 stats but linked player DOES
        cur.execute("""
            SELECT pl.id as link_id, pl.canonical_id, pl.linked_id,
                   cp.first_name, cp.last_name,
                   ct.short_name as canonical_team, lt.short_name as linked_team,
                   cd.level as canonical_div, ld.level as linked_div
            FROM player_links pl
            JOIN players cp ON pl.canonical_id = cp.id
            JOIN players lp ON pl.linked_id = lp.id
            JOIN teams ct ON cp.team_id = ct.id
            JOIN teams lt ON lp.team_id = lt.id
            JOIN conferences cc ON ct.conference_id = cc.id
            JOIN conferences lc ON lt.conference_id = lc.id
            JOIN divisions cd ON cc.division_id = cd.id
            JOIN divisions ld ON lc.division_id = ld.id
            LEFT JOIN batting_stats cbs ON cp.id = cbs.player_id AND cbs.season = 2026
            LEFT JOIN pitching_stats cps ON cp.id = cps.player_id AND cps.season = 2026
            LEFT JOIN batting_stats lbs ON lp.id = lbs.player_id AND lbs.season = 2026
            LEFT JOIN pitching_stats lps ON lp.id = lps.player_id AND lps.season = 2026
            WHERE (cbs.player_id IS NULL AND cps.player_id IS NULL)
              AND (lbs.player_id IS NOT NULL OR lps.player_id IS NOT NULL)
        """)
        wrong_links = cur.fetchall()

        if not wrong_links:
            print("All links look correct!")
            return

        # Group by canonical_id so we handle players with multiple links together
        groups = defaultdict(list)
        for row in wrong_links:
            groups[(row["canonical_id"], row["first_name"], row["last_name"])].append(row)

        print(f"Found {len(groups)} players needing canonical swap:\n")

        total_fixed = 0
        for (old_canonical_id, first_name, last_name), rows in sorted(groups.items(), key=lambda x: x[0][2]):
            # The new canonical should be the linked player with 2026 stats
            # (pick the first one — they should generally only have one current team)
            new_canonical_id = rows[0]["linked_id"]
            new_team = rows[0]["linked_team"]
            old_team = rows[0]["canonical_team"]

            print(f"{first_name} {last_name}: {old_team} -> {new_team}")

            if not DRY_RUN:
                # Get ALL player IDs in this group (canonical + all linked)
                cur.execute("""
                    SELECT linked_id FROM player_links WHERE canonical_id = %s
                """, (old_canonical_id,))
                all_linked_ids = [r["linked_id"] for r in cur.fetchall()]
                all_ids = [old_canonical_id] + all_linked_ids

                # Delete all existing links for this group
                cur.execute("""
                    DELETE FROM player_links
                    WHERE canonical_id = ANY(%s) OR linked_id = ANY(%s)
                """, (all_ids, all_ids))
                deleted = cur.rowcount

                # Re-create with new canonical
                for pid in all_ids:
                    if pid != new_canonical_id:
                        cur.execute("""
                            INSERT INTO player_links (canonical_id, linked_id, match_type, confidence)
                            VALUES (%s, %s, 'manual', 1.0)
                        """, (new_canonical_id, pid))

                print(f"  -> Deleted {deleted}, re-created {len(all_ids) - 1} links")
                total_fixed += 1
            else:
                print(f"  -> [DRY RUN] Would swap canonical")

        if not DRY_RUN:
            conn.commit()
            print(f"\nDONE: Fixed {total_fixed} players")
        else:
            print(f"\nDRY RUN complete. Would fix {total_fixed} players.")


if __name__ == "__main__":
    main()
