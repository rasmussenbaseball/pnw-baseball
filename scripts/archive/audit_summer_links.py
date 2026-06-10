#!/usr/bin/env python3
"""
Audit summer<->spring player links for TEMPORALLY-IMPOSSIBLE matches.

The name-based auto-linker (link_summer_to_spring.py) can match a spring
player to a same-named summer player from a season before that spring player
was even in college — e.g. Taylor Pearce (a 2026 freshman at Bushnell) got
linked to a 2024 Edmonton Riverhawks "Taylor Pearce", who must be a different
person. This finds and removes those.

Rule: estimate the spring player's college-entry year from their class
(Fr=0, So=1, Jr=2, Sr=3 years removed from their latest spring season). A
summer season earlier than (entry_year - 1) — i.e. more than the summer
before freshman year — is impossible for that player, so the link is wrong.
Players with an unknown class year are left alone (we can't be sure).

    PYTHONPATH=backend python3 scripts/audit_summer_links.py          # dry run
    PYTHONPATH=backend python3 scripts/audit_summer_links.py --fix    # delete bad links
"""
import argparse
import re
from app.models.database import get_connection

CLASS_OFFSET = {"fr": 0, "so": 1, "jr": 2, "sr": 3, "gr": 4}


def class_offset(year_in_school):
    """Years the player is removed from their college-entry year."""
    if not year_in_school:
        return None
    s = year_in_school.strip().lower()
    # handle 'r-so', 'rs jr', 'redshirt sophomore', 'freshman', etc.
    for key, off in CLASS_OFFSET.items():
        if re.search(rf"\b{key}", s) or s.startswith(key):
            return off
    if "fresh" in s: return 0
    if "soph" in s: return 1
    if "jun" in s: return 2
    if "sen" in s: return 3
    if "grad" in s: return 4
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fix", action="store_true", help="Delete the impossible links")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            WITH spring_seasons AS (
                SELECT player_id, MAX(season) AS latest FROM (
                    SELECT player_id, season FROM batting_stats
                    UNION SELECT player_id, season FROM pitching_stats) u
                GROUP BY player_id
            ),
            summer_seasons AS (
                SELECT u.player_id AS sp_id, MIN(u.season) AS first_s, MAX(u.season) AS last_s FROM (
                    SELECT player_id, season FROM summer_batting_stats
                    UNION SELECT player_id, season FROM summer_pitching_stats) u
                GROUP BY u.player_id
            )
            SELECT l.id AS link_id, l.spring_player_id, l.summer_player_id,
                   p.first_name, p.last_name, p.year_in_school, p.roster_year,
                   ss.latest AS latest_spring, su.first_s AS summer_first, su.last_s AS summer_last
            FROM summer_player_links l
            JOIN players p ON p.id = l.spring_player_id
            LEFT JOIN spring_seasons ss ON ss.player_id = l.spring_player_id
            LEFT JOIN summer_seasons su ON su.sp_id = l.summer_player_id
        """)
        links = cur.fetchall()

        bad = []
        for r in links:
            off = class_offset(r["year_in_school"])
            latest = r["latest_spring"] or r["roster_year"]
            if off is None or latest is None or r["summer_first"] is None:
                continue
            entry_year = latest - off
            if r["summer_first"] < entry_year - 1:
                bad.append((r, entry_year))

        print(f"\n=== {len(bad)} temporally-impossible summer link(s) ===\n")
        for r, entry in bad:
            print(f"  link#{r['link_id']}  {r['first_name']} {r['last_name']} "
                  f"({r['year_in_school']}, latest spring {r['latest_spring']}, est. college entry {entry}) "
                  f"-> summer player #{r['summer_player_id']} played summer {r['summer_first']}-{r['summer_last']}  [IMPOSSIBLE]")

        if args.fix and bad:
            ids = [r["link_id"] for r, _ in bad]
            cur.execute("DELETE FROM summer_player_links WHERE id = ANY(%s)", (ids,))
            conn.commit()
            print(f"\nDELETED {cur.rowcount} bad links.")
        elif bad:
            print("\nDry run. Re-run with --fix to delete these links.")
        cur.close()


if __name__ == "__main__":
    main()
