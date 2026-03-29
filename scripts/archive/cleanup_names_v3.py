#!/usr/bin/env python3
"""Fix the 7 skipped players from v2 cleanup — manual fixes for edge cases."""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
from app.models.database import get_connection

# These are the players that v2 couldn't auto-parse
MANUAL_FIXES = {
    7468: ("Gino", "Trippy Jr."),       # Was: 'Trippy' / 'Jr., GinoTrippy Jr., Gino'
    7588: ("Will", "Shelor"),            # Was: 'Shelor' / ', WillShelor , Will'
    7699: ("Zach", "Johansen"),          # Was: 'Johansen' / ', ZachJohansen , Zach'
    7700: ("Jax", "Copeland"),           # Was: 'Copeland' / ', JaxCopeland , Jax'
    7703: ("Bryce", "Mahlke"),           # Was: 'Mahlke' / ', BryceMahlke , Bryce'
    7713: ("Brandon", "Faire"),          # Was: 'Faire' / ', BrandonFaire , Brandon'
    7673: ("Nate", "Gray Jr."),          # Was: 'Gray' / 'Jr., NateGray Jr., Nate'
}

with get_connection() as conn:
    cur = conn.cursor()
    for pid, (first, last) in MANUAL_FIXES.items():
        cur.execute("SELECT first_name, last_name FROM players WHERE id = %s", (pid,))
        row = cur.fetchone()
        if row:
            print(f"  FIX id={pid}: '{row['first_name']}' / '{row['last_name']}' → '{first}' / '{last}'")
            cur.execute("UPDATE players SET first_name = %s, last_name = %s WHERE id = %s",
                        (first, last, pid))
        else:
            print(f"  SKIP id={pid}: not found")
    conn.commit()
    print(f"\nFixed {len(MANUAL_FIXES)} edge-case players")

# Also fix the "Utah Yaks U" team name issue (was "Utah Yaks 18U")
cur2 = conn.cursor()
# This one isn't a player name issue, skip it
print("Done!")
