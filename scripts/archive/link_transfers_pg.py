#!/usr/bin/env python3
"""
Detect and link player records that are the same person across different teams.
PostgreSQL version — connects to Supabase via DATABASE_URL.

Matching criteria:
  1. Exact first_name + last_name match (case-insensitive)
  2. Different team_id
  3. No overlapping seasons with stats at both teams
  4. Season gap of 0-2 years (back-to-back or gap year)

Usage:
    cd pnw-baseball
    PYTHONPATH=backend python3 scripts/link_transfers_pg.py                 # Dry run — show matches
    PYTHONPATH=backend python3 scripts/link_transfers_pg.py --link           # Actually create links
    PYTHONPATH=backend python3 scripts/link_transfers_pg.py --show           # Show existing links
    PYTHONPATH=backend python3 scripts/link_transfers_pg.py --unlink 123     # Remove a specific link
"""

import argparse
from collections import defaultdict
from app.models.database import get_connection


def ensure_table(cur):
    """Create the player_links table if it doesn't exist."""
    cur.execute("""
        CREATE TABLE IF NOT EXISTS player_links (
            id SERIAL PRIMARY KEY,
            canonical_id INTEGER NOT NULL REFERENCES players(id),
            linked_id INTEGER NOT NULL REFERENCES players(id),
            match_type TEXT DEFAULT 'auto',
            confidence REAL DEFAULT 1.0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(linked_id)
        )
    """)


def get_player_seasons(cur, player_id):
    """Get set of seasons where this player has batting or pitching stats."""
    cur.execute(
        "SELECT DISTINCT season FROM batting_stats WHERE player_id = %s", (player_id,)
    )
    bat = cur.fetchall()
    cur.execute(
        "SELECT DISTINCT season FROM pitching_stats WHERE player_id = %s", (player_id,)
    )
    pit = cur.fetchall()
    return set(r["season"] for r in bat) | set(r["season"] for r in pit)


def find_matches(cur):
    """Find player records that are likely the same person across teams."""
    cur.execute("""
        SELECT p.id, p.first_name, p.last_name, p.team_id, p.position,
               p.year_in_school, p.hometown, p.previous_school,
               t.short_name as team_short, d.level as division_level
        FROM players p
        JOIN teams t ON p.team_id = t.id
        JOIN conferences c ON t.conference_id = c.id
        JOIN divisions d ON c.division_id = d.id
    """)
    players = cur.fetchall()

    # Build a map of existing links so we can chain 3+ school players
    cur.execute("SELECT canonical_id, linked_id FROM player_links")
    existing_links = cur.fetchall()

    canonical_map = {}
    for link in existing_links:
        canonical_map[link["linked_id"]] = link["canonical_id"]
        canonical_map[link["canonical_id"]] = link["canonical_id"]

    def get_canonical(pid):
        seen = set()
        while pid in canonical_map and pid != canonical_map[pid]:
            if pid in seen:
                break
            seen.add(pid)
            pid = canonical_map[pid]
        return pid

    already_linked_as_linked = set(link["linked_id"] for link in existing_links)

    # Group by normalized name
    by_name = defaultdict(list)
    for p in players:
        key = (p["first_name"].strip().lower(), p["last_name"].strip().lower())
        by_name[key].append(dict(p))

    matches = []
    for name_key, group in by_name.items():
        if len(group) < 2:
            continue

        teams = set(p["team_id"] for p in group)
        if len(teams) < 2:
            continue

        # Get seasons for each player
        for p in group:
            p["seasons"] = get_player_seasons(cur, p["id"])

        # Compare all pairs
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                a, b = group[i], group[j]

                if a["team_id"] == b["team_id"]:
                    continue

                a_is_linked = a["id"] in already_linked_as_linked
                b_is_linked = b["id"] in already_linked_as_linked
                if a_is_linked and b_is_linked:
                    continue

                a_canonical = get_canonical(a["id"]) if a["id"] in canonical_map else None
                b_canonical = get_canonical(b["id"]) if b["id"] in canonical_map else None
                if a_canonical and b_canonical and a_canonical == b_canonical:
                    continue

                # Check for overlapping seasons
                overlap = a["seasons"] & b["seasons"]
                if overlap:
                    continue

                if not a["seasons"] or not b["seasons"]:
                    continue

                a_max = max(a["seasons"])
                a_min = min(a["seasons"])
                b_max = max(b["seasons"])
                b_min = min(b["seasons"])

                gap = min(abs(b_min - a_max), abs(a_min - b_max))
                if gap > 2:
                    continue

                # Compute confidence
                confidence = 0.7

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

                # Determine canonical (prefer: already-canonical, more recent, 4-year over JUCO, more seasons)
                if a_canonical and not b_is_linked:
                    canonical, linked = a, b
                    canonical = {**a, "_override_canonical_id": a_canonical}
                elif b_canonical and not a_is_linked:
                    canonical, linked = b, a
                    canonical = {**b, "_override_canonical_id": b_canonical}
                elif a_max > b_max:
                    canonical, linked = a, b
                elif b_max > a_max:
                    canonical, linked = b, a
                elif len(a["seasons"]) >= len(b["seasons"]):
                    canonical, linked = a, b
                else:
                    canonical, linked = b, a

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
    parser.add_argument("--min-confidence", type=float, default=0.7,
                        help="Minimum confidence to auto-link (default: 0.7)")
    args = parser.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()
        ensure_table(cur)

        if args.show:
            show_existing_links(cur)
            return

        if args.unlink:
            cur.execute("DELETE FROM player_links WHERE id = %s", (args.unlink,))
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

            print(f"  {i+1}. [{flag} {m['confidence']}] "
                  f"{c['first_name']} {c['last_name']}")
            print(f"       {c['team_short']} ({c['division_level']}) seasons: {c_seasons}")
            print(f"       {l['team_short']} ({l['division_level']}) seasons: {l_seasons}")
            if c.get("hometown"):
                print(f"       Hometown: {c['hometown']}")
            print()

        linkable = [m for m in matches if m["confidence"] >= args.min_confidence]

        if args.link:
            print(f"Creating {len(linkable)} links (confidence >= {args.min_confidence})...\n")
            for m in linkable:
                c = m["canonical"]
                l = m["linked"]
                canonical_id = c.get("_override_canonical_id", c["id"])
                try:
                    cur.execute("""
                        INSERT INTO player_links (canonical_id, linked_id, match_type, confidence)
                        VALUES (%s, %s, 'auto', %s)
                        ON CONFLICT (linked_id) DO NOTHING
                    """, (canonical_id, l["id"], m["confidence"]))
                    if cur.rowcount > 0:
                        print(f"  Linked: {c['first_name']} {c['last_name']} "
                              f"({c['team_short']} <- {l['team_short']})"
                              + (f" [chained to canonical #{canonical_id}]" if canonical_id != c["id"] else ""))
                    else:
                        print(f"  Already linked: {l['first_name']} {l['last_name']}")
                except Exception as e:
                    print(f"  Error linking {l['first_name']} {l['last_name']}: {e}")
            print(f"\nDone! Run with --show to see all links.")
        else:
            print(f"Dry run -- {len(linkable)} would be linked (confidence >= {args.min_confidence}).")
            print("Run with --link to create them.")


if __name__ == "__main__":
    main()
