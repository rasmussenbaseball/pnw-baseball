"""
Patch any game_events where batter_name still has trailing " was".
These are events from games that couldn't be re-scraped during the
backfill (e.g. NWAC games whose source_url happens to point at the
XML box-score feed). Direct DB fix:

  1. Strip " was" / " is" / " were" / " are" from end of batter_name.
  2. Re-resolve batter_player_id using find_player_id_with_fallback
     against the cleaned name.
  3. Defensive: also clean any equivalent suffixes anywhere in the
     2026 game_events.

Run on Mac:
    cd ~/Desktop/pnw-baseball
    PYTHONPATH=backend python3 scripts/fix_was_stragglers.py
"""
from __future__ import annotations
import re
import sys

from app.models.database import get_connection
sys.path.insert(0, "scripts")
from scrape_pbp import find_player_id_with_fallback


SUFFIX_RE = re.compile(r"\s+(?:was|is|were|are)$", re.IGNORECASE)


def main() -> int:
    with get_connection() as conn:
        cur = conn.cursor()

        # Find all events with the stale suffix
        cur.execute("""
            SELECT ge.id, ge.game_id, ge.batter_name, ge.batting_team_id,
                   g.season
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = 2026
              AND (ge.batter_name LIKE '%% was'
                   OR ge.batter_name LIKE '%% is'
                   OR ge.batter_name LIKE '%% were'
                   OR ge.batter_name LIKE '%% are')
        """)
        bad = list(cur.fetchall())
        print(f"Found {len(bad)} events with stale helping-verb suffix")

        if not bad:
            print("Nothing to do.")
            return 0

        for r in bad:
            old_name = r["batter_name"]
            new_name = SUFFIX_RE.sub("", old_name).strip()
            # Try to resolve the cleaned name to a real player_id
            new_pid = None
            if r["batting_team_id"]:
                pid, _ = find_player_id_with_fallback(
                    cur, r["batting_team_id"], new_name,
                    season=r["season"], game_id=r["game_id"],
                )
                if pid:
                    new_pid = pid
            print(f"  event {r['id']}: '{old_name}' → '{new_name}'  pid={new_pid}")
            # Update batter_name; only update batter_player_id if we
            # found a real match (else leave existing).
            if new_pid:
                cur.execute("""
                    UPDATE game_events
                    SET batter_name = %s, batter_player_id = %s
                    WHERE id = %s
                """, (new_name, new_pid, r["id"]))
            else:
                cur.execute("""
                    UPDATE game_events SET batter_name = %s WHERE id = %s
                """, (new_name, r["id"]))

        conn.commit()
        print(f"Done — {len(bad)} events patched.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
