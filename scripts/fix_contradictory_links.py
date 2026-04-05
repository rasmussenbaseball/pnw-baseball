#!/usr/bin/env python3
"""
Fix contradictory player_links entries.

Some players appear as BOTH canonical_id and linked_id, which causes
ALL of their entries to be hidden from search. This script:
1. Finds all contradictory links
2. Groups affected players by name
3. Picks the best canonical (highest division level, then highest player ID)
4. Deletes bad links and re-creates them cleanly

Usage:
    cd /opt/pnw-baseball
    PYTHONPATH=backend python3 scripts/fix_contradictory_links.py

Add --dry-run to preview changes without applying them.
"""

import sys
from collections import defaultdict
from app.models.database import get_connection

DRY_RUN = "--dry-run" in sys.argv

# Division priority: higher = more likely to be current team
DIV_PRIORITY = {"D1": 5, "D2": 4, "NAIA": 3, "D3": 2, "JUCO": 1}


def main():
    with get_connection() as conn:
        cur = conn.cursor()

        # Step 1: Find all player IDs involved in contradictory links
        # (appear as both canonical_id and linked_id)
        cur.execute("""
            SELECT DISTINCT pl1.canonical_id AS player_id
            FROM player_links pl1
            JOIN player_links pl2 ON pl1.canonical_id = pl2.linked_id
        """)
        contradictory_ids = {r["player_id"] for r in cur.fetchall()}

        if not contradictory_ids:
            print("No contradictory links found!")
            return

        print(f"Found {len(contradictory_ids)} players with contradictory links\n")

        # Step 2: For each contradictory player, find ALL related player IDs
        # (follow links in both directions to build full groups)
        all_related = set(contradictory_ids)
        for pid in contradictory_ids:
            cur.execute("""
                SELECT canonical_id, linked_id FROM player_links
                WHERE canonical_id = %s OR linked_id = %s
            """, (pid, pid))
            for r in cur.fetchall():
                all_related.add(r["canonical_id"])
                all_related.add(r["linked_id"])

        # Step 3: Get player details for all related players
        cur.execute("""
            SELECT p.id, p.first_name, p.last_name, t.short_name, t.id as team_id,
                   d.level as division_level
            FROM players p
            JOIN teams t ON p.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE p.id = ANY(%s)
        """, (list(all_related),))
        players = {r["id"]: dict(r) for r in cur.fetchall()}

        # Step 4: Group players by (first_name, last_name)
        groups = defaultdict(list)
        for pid, p in players.items():
            key = (p["first_name"].strip().lower(), p["last_name"].strip().lower())
            groups[key].append(p)

        # Step 5: For each group, pick canonical and fix links
        total_deleted = 0
        total_inserted = 0

        for name_key, group in sorted(groups.items()):
            if len(group) < 2:
                continue

            # Sort by division priority (desc), then player ID (desc = newer)
            group.sort(
                key=lambda p: (DIV_PRIORITY.get(p["division_level"], 0), p["id"]),
                reverse=True,
            )
            canonical = group[0]
            linked = group[1:]

            print(f"{canonical['first_name']} {canonical['last_name']}:")
            print(f"  Canonical: {canonical['short_name']} ({canonical['division_level']}, id={canonical['id']})")
            for lp in linked:
                print(f"  Linked:    {lp['short_name']} ({lp['division_level']}, id={lp['id']})")

            group_ids = [p["id"] for p in group]

            if not DRY_RUN:
                # Delete all existing links involving any player in this group
                cur.execute("""
                    DELETE FROM player_links
                    WHERE canonical_id = ANY(%s) OR linked_id = ANY(%s)
                """, (group_ids, group_ids))
                deleted = cur.rowcount
                total_deleted += deleted

                # Re-create clean links
                for lp in linked:
                    cur.execute("""
                        INSERT INTO player_links (canonical_id, linked_id, match_type, confidence)
                        VALUES (%s, %s, 'manual', 1.0)
                    """, (canonical["id"], lp["id"]))
                    total_inserted += 1

                print(f"  -> Deleted {deleted} bad links, inserted {len(linked)} clean links")
            else:
                print(f"  -> [DRY RUN] Would fix {len(linked)} links")

            print()

        if not DRY_RUN:
            conn.commit()
            print(f"DONE: Deleted {total_deleted} bad links, inserted {total_inserted} clean links")
        else:
            print(f"DRY RUN complete. Would fix {total_inserted} link groups.")


if __name__ == "__main__":
    main()
