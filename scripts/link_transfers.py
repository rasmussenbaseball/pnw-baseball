#!/usr/bin/env python3
"""
Detect and link player records that are the same person across different teams.

Matching criteria:
  1. Exact first_name + last_name match (case-insensitive)
  2. Different team_id
  3. No overlapping seasons with stats at both teams
  4. Season gap of 0-2 years (back-to-back or gap year)

Canonical selection priority (who shows up in search):
  1. Has current-season (2026) stats
  2. Higher division level (D1 > D2 > NAIA > D3 > JUCO)
  3. More recent seasons
  4. More total seasons

Safety: prevents circular references by never making a player canonical
if they are already linked to someone else, and never linking a player
who is already a canonical for others without merging the chains.

Usage:
    cd pnw-baseball
    PYTHONPATH=backend python3 scripts/link_transfers.py                 # Dry run
    PYTHONPATH=backend python3 scripts/link_transfers.py --link          # Create links
    PYTHONPATH=backend python3 scripts/link_transfers.py --show          # Show existing
    PYTHONPATH=backend python3 scripts/link_transfers.py --unlink 123    # Remove a link
    PYTHONPATH=backend python3 scripts/link_transfers.py --season 2026   # Set current season
"""

import argparse
from collections import defaultdict
from app.models.database import get_connection

CURRENT_SEASON = 2026
DIV_PRIORITY = {"D1": 5, "D2": 4, "NAIA": 3, "D3": 2, "JUCO": 1}


def get_player_seasons(cur, player_id):
    """Get set of seasons where this player has batting or pitching stats."""
    cur.execute(
        "SELECT DISTINCT season FROM batting_stats WHERE player_id = %s", (player_id,)
    )
    bat = {r["season"] for r in cur.fetchall()}
    cur.execute(
        "SELECT DISTINCT season FROM pitching_stats WHERE player_id = %s", (player_id,)
    )
    pit = {r["season"] for r in cur.fetchall()}
    return bat | pit


def build_link_state(cur):
    """Build canonical map and sets for safe link creation."""
    cur.execute("SELECT canonical_id, linked_id FROM player_links")
    rows = cur.fetchall()

    # linked_id → canonical_id
    linked_to_canonical = {}
    # canonical_id → set of linked_ids
    canonical_to_linked = defaultdict(set)

    for r in rows:
        linked_to_canonical[r["linked_id"]] = r["canonical_id"]
        canonical_to_linked[r["canonical_id"]].add(r["linked_id"])

    return linked_to_canonical, canonical_to_linked


def get_root_canonical(player_id, linked_to_canonical, max_depth=10):
    """Follow chain to root canonical. Returns None if cycle detected."""
    seen = set()
    pid = player_id
    for _ in range(max_depth):
        if pid not in linked_to_canonical:
            return pid
        if pid in seen:
            return None  # Cycle detected
        seen.add(pid)
        pid = linked_to_canonical[pid]
    return None  # Too deep, likely a problem


def find_matches(cur):
    """Find player records that are likely the same person across teams."""
    # Get all players with their teams
    cur.execute("""
        SELECT p.id, p.first_name, p.last_name, p.team_id, p.position,
               p.year_in_school, p.hometown, p.previous_school,
               t.short_name as team_short, d.level as division_level
        FROM players p
        JOIN teams t ON p.team_id = t.id
        JOIN conferences c ON t.conference_id = c.id
        JOIN divisions d ON c.division_id = d.id
    """)
    players = [dict(r) for r in cur.fetchall()]

    # Build link state
    linked_to_canonical, canonical_to_linked = build_link_state(cur)

    # Set of all player IDs that are already a linked_id
    already_linked = set(linked_to_canonical.keys())

    # Group by normalized name
    by_name = defaultdict(list)
    for p in players:
        key = (p["first_name"].strip().lower(), p["last_name"].strip().lower())
        by_name[key].append(p)

    matches = []
    for name_key, group in by_name.items():
        if len(group) < 2:
            continue

        # Only consider groups where players are on different teams
        teams = set(p["team_id"] for p in group)
        if len(teams) < 2:
            continue

        # Get seasons for each player
        for p in group:
            p["seasons"] = get_player_seasons(cur, p["id"])
            p["has_current"] = CURRENT_SEASON in p["seasons"]

        # Compare all pairs
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                a, b = group[i], group[j]

                # Skip if same team
                if a["team_id"] == b["team_id"]:
                    continue

                # Skip if both already linked
                a_is_linked = a["id"] in already_linked
                b_is_linked = b["id"] in already_linked
                if a_is_linked and b_is_linked:
                    # Check if they share the same root canonical
                    a_root = get_root_canonical(a["id"], linked_to_canonical)
                    b_root = get_root_canonical(b["id"], linked_to_canonical)
                    if a_root and b_root and a_root == b_root:
                        continue  # Already linked together
                    # Different chains — skip for safety (needs manual merge)
                    continue

                # If they already share a canonical, skip
                a_root = get_root_canonical(a["id"], linked_to_canonical)
                b_root = get_root_canonical(b["id"], linked_to_canonical)
                if a_root and b_root and a_root == b_root:
                    continue

                # Check for overlapping seasons
                overlap = a["seasons"] & b["seasons"]
                if overlap:
                    continue

                # Check season proximity
                if not a["seasons"] or not b["seasons"]:
                    continue

                a_max = max(a["seasons"])
                b_max = max(b["seasons"])
                gap = min(abs(b_max - min(a["seasons"])),
                          abs(a_max - min(b["seasons"])),
                          abs(b_max - a_max))
                if gap > 2:
                    continue

                # Compute confidence
                confidence = 0.7  # Base

                if (a.get("hometown") and b.get("hometown") and
                        a["hometown"].strip().lower() == b["hometown"].strip().lower()):
                    confidence += 0.15

                if a.get("previous_school") and b["team_short"]:
                    if b["team_short"].lower() in a["previous_school"].lower():
                        confidence += 0.15
                if b.get("previous_school") and a["team_short"]:
                    if a["team_short"].lower() in b["previous_school"].lower():
                        confidence += 0.15

                juco_levels = {"JUCO"}
                four_year = {"D1", "D2", "D3", "NAIA"}
                if ((a["division_level"] in juco_levels and b["division_level"] in four_year) or
                        (b["division_level"] in juco_levels and a["division_level"] in four_year)):
                    confidence += 0.1

                if gap <= 1:
                    confidence += 0.05

                confidence = min(confidence, 1.0)

                # ─── Canonical selection ───
                # Priority: current-season stats > division level > most recent > more seasons
                def canonical_score(p):
                    return (
                        1 if p["has_current"] else 0,
                        DIV_PRIORITY.get(p["division_level"], 0),
                        max(p["seasons"]) if p["seasons"] else 0,
                        len(p["seasons"]),
                    )

                if canonical_score(a) >= canonical_score(b):
                    canonical, linked = a, b
                else:
                    canonical, linked = b, a

                # ─── Safety checks ───
                # NEVER make someone canonical if they are already a linked_id
                if canonical["id"] in already_linked:
                    # Swap: try the other one
                    canonical, linked = linked, canonical

                if canonical["id"] in already_linked:
                    # Both are already linked — skip entirely
                    continue

                # If the linked player is already a canonical for others,
                # we need to re-point those to our canonical instead.
                # For safety, we'll just flag this and skip.
                if linked["id"] in canonical_to_linked and linked["id"] not in already_linked:
                    # linked is a canonical for others — this would create a chain
                    # We handle this by making our canonical the root
                    pass  # Will be handled during insertion

                # If canonical is already a canonical for other links, that's fine —
                # we just add another linked_id to it
                # If canonical already has a root canonical, use that root instead
                root = get_root_canonical(canonical["id"], linked_to_canonical)
                if root and root != canonical["id"]:
                    canonical = {**canonical, "_override_canonical_id": root}

                matches.append({
                    "canonical": canonical,
                    "linked": linked,
                    "confidence": round(confidence, 2),
                    "gap": gap,
                })

    matches.sort(key=lambda m: -m["confidence"])
    return matches


def show_existing_links(cur):
    """Show all existing player links."""
    cur.execute("""
        SELECT pl.id as link_id, pl.confidence, pl.match_type,
               p1.first_name as c_first, p1.last_name as c_last, t1.short_name as c_team,
               p2.first_name as l_first, p2.last_name as l_last, t2.short_name as l_team
        FROM player_links pl
        JOIN players p1 ON pl.canonical_id = p1.id
        JOIN players p2 ON pl.linked_id = p2.id
        JOIN teams t1 ON p1.team_id = t1.id
        JOIN teams t2 ON p2.team_id = t2.id
        ORDER BY p1.last_name, p1.first_name
    """)
    links = cur.fetchall()

    if not links:
        print("No existing player links.")
        return

    print(f"Existing links ({len(links)}):\n")
    for l in links:
        print(f"  [#{l['link_id']}] {l['c_first']} {l['c_last']} ({l['c_team']}) "
              f"<- {l['l_first']} {l['l_last']} ({l['l_team']}) "
              f"[{l['match_type']}, conf={l['confidence']}]")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--link", action="store_true", help="Actually create links")
    parser.add_argument("--show", action="store_true", help="Show existing links")
    parser.add_argument("--unlink", type=int, help="Remove a link by ID")
    parser.add_argument("--season", type=int, default=2026, help="Current season (default: 2026)")
    parser.add_argument("--min-confidence", type=float, default=0.7,
                        help="Minimum confidence to auto-link (default: 0.7)")
    args = parser.parse_args()

    global CURRENT_SEASON
    CURRENT_SEASON = args.season

    with get_connection() as conn:
        cur = conn.cursor()

        if args.show:
            show_existing_links(cur)
            return

        if args.unlink:
            cur.execute("DELETE FROM player_links WHERE id = %s", (args.unlink,))
            conn.commit()
            print(f"Removed link #{args.unlink}")
            return

        print("Scanning for transfer matches...\n")
        matches = find_matches(cur)

        if not matches:
            print("No new matches found.")
            return

        print(f"Found {len(matches)} potential matches:\n")
        for i, m in enumerate(matches):
            c = m["canonical"]
            l = m["linked"]
            c_seasons = sorted(c["seasons"])
            l_seasons = sorted(l["seasons"])
            flag = "HIGH" if m["confidence"] >= 0.85 else "MED" if m["confidence"] >= 0.7 else "LOW"
            current_marker = " *CURRENT*" if c.get("has_current") else ""

            print(f"  {i+1}. [{flag} {m['confidence']}] "
                  f"{c['first_name']} {c['last_name']}")
            print(f"       Canonical: {c['team_short']} ({c['division_level']}) "
                  f"seasons: {c_seasons}{current_marker}")
            print(f"       Linked:    {l['team_short']} ({l['division_level']}) "
                  f"seasons: {l_seasons}")
            if c.get("hometown"):
                print(f"       Hometown: {c['hometown']}")
            print()

        linkable = [m for m in matches if m["confidence"] >= args.min_confidence]

        if args.link:
            created = 0
            skipped = 0
            print(f"Creating links (confidence >= {args.min_confidence})...\n")

            # Rebuild link state fresh before inserting
            linked_to_canonical, canonical_to_linked = build_link_state(cur)

            for m in linkable:
                c = m["canonical"]
                l = m["linked"]
                canonical_id = c.get("_override_canonical_id", c["id"])

                # ── Final safety checks before INSERT ──
                # 1. canonical_id must NOT be a linked_id
                if canonical_id in linked_to_canonical:
                    print(f"  SKIP (canonical {canonical_id} is already linked): "
                          f"{c['first_name']} {c['last_name']}")
                    skipped += 1
                    continue

                # 2. linked_id must NOT already be a linked_id
                if l["id"] in linked_to_canonical:
                    print(f"  SKIP (already linked): "
                          f"{l['first_name']} {l['last_name']} ({l['team_short']})")
                    skipped += 1
                    continue

                # 3. If linked player is canonical for others, re-point them first
                if l["id"] in canonical_to_linked:
                    orphans = canonical_to_linked[l["id"]]
                    print(f"  Re-pointing {len(orphans)} existing links from "
                          f"{l['team_short']} to {c['team_short']}")
                    cur.execute("""
                        UPDATE player_links SET canonical_id = %s
                        WHERE canonical_id = %s
                    """, (canonical_id, l["id"]))
                    # Update local state
                    canonical_to_linked[canonical_id].update(orphans)
                    del canonical_to_linked[l["id"]]
                    for orphan_id in orphans:
                        linked_to_canonical[orphan_id] = canonical_id

                try:
                    cur.execute("""
                        INSERT INTO player_links (canonical_id, linked_id, match_type, confidence)
                        VALUES (%s, %s, 'auto', %s)
                    """, (canonical_id, l["id"], m["confidence"]))

                    # Update local state
                    linked_to_canonical[l["id"]] = canonical_id
                    canonical_to_linked[canonical_id].add(l["id"])

                    print(f"  Linked: {c['first_name']} {c['last_name']} "
                          f"({c['team_short']} <- {l['team_short']})")
                    created += 1
                except Exception as e:
                    print(f"  ERROR: {e}")
                    skipped += 1

            conn.commit()
            print(f"\nDone! Created {created} links, skipped {skipped}.")
        else:
            print(f"Dry run — {len(linkable)} would be linked "
                  f"(confidence >= {args.min_confidence}).")
            print("Run with --link to create them.")


if __name__ == "__main__":
    main()
