#!/usr/bin/env python3
"""
Second-pass name cleanup: properly re-parse player names where the last_name
field still contains a full "FirstLast, First" string after digit stripping.

Usage:
    cd pnw-baseball
    PYTHONPATH=backend python3 scripts/cleanup_names_v2.py
"""

import sys
import re
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
from app.models.database import get_connection


def fix_mangled_names():
    with get_connection() as conn:
        cur = conn.cursor()

        # Find players whose last_name contains a comma (meaning the full
        # "Last, First" raw string got stored there)
        cur.execute("""
            SELECT id, first_name, last_name
            FROM players
            WHERE last_name LIKE '%,%'
        """)
        rows = cur.fetchall()
        print(f"Found {len(rows)} players with commas in last_name")

        fixed = 0
        for r in rows:
            pid = r["id"]
            old_first = r["first_name"] or ""
            old_last = r["last_name"] or ""

            # The last_name field has something like "JacksonJaha, Jackson"
            # or "MikeyBell, Mikey" — it's "FirstLast, First" after digit strip.
            # Split on the comma to get the parts.
            if "," in old_last:
                parts = old_last.split(",", 1)
                combo = parts[0].strip()       # e.g. "JacksonJaha"
                first_name = parts[1].strip()   # e.g. "Jackson"

                # The combo is FirstName + LastName concatenated.
                # We know the first name, so strip it from the front of combo.
                if combo.lower().startswith(first_name.lower()) and len(combo) > len(first_name):
                    last_name = combo[len(first_name):]
                elif combo.lower().endswith(first_name.lower()) and len(combo) > len(first_name):
                    last_name = combo[:-len(first_name)]
                else:
                    # Can't reliably parse — skip
                    print(f"  SKIP: id={pid} first='{old_first}' last='{old_last}' — can't parse")
                    continue

                print(f"  FIX: '{old_first}' / '{old_last}' → '{first_name}' / '{last_name}'")
                cur.execute("""
                    UPDATE players SET first_name = %s, last_name = %s WHERE id = %s
                """, (first_name, last_name, pid))
                fixed += 1

        conn.commit()
        print(f"\nFixed {fixed} player names")


def fix_trailing_comma_first_names():
    """Fix first_name values that have trailing commas like 'Jaha,'"""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE players
            SET first_name = TRIM(TRAILING ',' FROM first_name)
            WHERE first_name LIKE '%,'
        """)
        count = cur.rowcount
        conn.commit()
        print(f"Stripped trailing commas from {count} first_name values")


if __name__ == "__main__":
    print("=== Pass 1: Re-parse mangled last_name fields ===")
    fix_mangled_names()
    print("\n=== Pass 2: Strip trailing commas from first_name ===")
    fix_trailing_comma_first_names()
    print("\nDone!")
