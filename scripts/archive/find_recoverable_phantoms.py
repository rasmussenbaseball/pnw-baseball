"""
For every phantom player record, check if a REAL player on the same
team would match its name once generational suffixes (Jr, Sr, II,
III, IV) are stripped from the real player's last_name. These are
phantoms that exist only because find_player_id doesn't strip
suffixes during matching.

Output drives the fix: shows how many phantoms we can convert back
to real-player references, and how many events that affects.

Run on Mac:
    cd ~/Desktop/pnw-baseball
    PYTHONPATH=backend python3 scripts/find_recoverable_phantoms.py
"""
from __future__ import annotations
import sys
import re
from app.models.database import get_connection


# Match trailing generational suffixes like "Scott II" or "Smith Jr."
SUFFIX_RE = re.compile(r"\s+(?:jr|sr|ii|iii|iv)\.?$", re.IGNORECASE)


def main() -> int:
    with get_connection() as conn:
        cur = conn.cursor()

        # Pull all phantoms with their team_id + name
        cur.execute("""
            SELECT id, team_id, first_name, last_name
            FROM players
            WHERE is_phantom = TRUE
        """)
        phantoms = list(cur.fetchall())
        print(f"Total phantom players: {len(phantoms)}")

        # For each phantom, check for a real player on the same team
        # whose last_name (suffix-stripped) matches the phantom.
        recoverable = []
        for p in phantoms:
            cur.execute("""
                SELECT id, first_name, last_name
                FROM players
                WHERE team_id = %s
                  AND is_phantom = FALSE
                  AND LOWER(first_name) = LOWER(%s)
                  AND (LOWER(last_name) = LOWER(%s)
                       OR LOWER(REGEXP_REPLACE(last_name,
                              '\\s+(jr|sr|ii|iii|iv)\\.?$', '', 'i')) = LOWER(%s))
                LIMIT 5
            """, (p["team_id"], p["first_name"] or "",
                  p["last_name"] or "", p["last_name"] or ""))
            real_matches = list(cur.fetchall())
            if real_matches:
                recoverable.append({
                    "phantom": p,
                    "real_matches": real_matches,
                })

        print(f"Recoverable phantoms (real player exists on same team): {len(recoverable)}")
        print()

        # Show first 20 with details
        for rec in recoverable[:20]:
            p = rec["phantom"]
            phantom_label = f"{p['first_name']} {p['last_name']}".strip()
            print(f"  phantom_id={p['id']:>6}  '{phantom_label}'  team_id={p['team_id']}")
            for rm in rec["real_matches"]:
                real_label = f"{rm['first_name']} {rm['last_name']}".strip()
                print(f"    → real_id={rm['id']:>6}  '{real_label}'")

        if len(recoverable) > 20:
            print(f"  ... and {len(recoverable) - 20} more")

        # Count affected events
        if recoverable:
            phantom_ids = [r["phantom"]["id"] for r in recoverable]
            cur.execute("""
                SELECT
                    SUM(CASE WHEN pitcher_player_id = ANY(%s) THEN 1 ELSE 0 END) AS pit_events,
                    SUM(CASE WHEN batter_player_id  = ANY(%s) THEN 1 ELSE 0 END) AS bat_events
                FROM game_events
            """, (phantom_ids, phantom_ids))
            r = cur.fetchone()
            print()
            print(f"Affected game_events:")
            print(f"  pitcher_player_id pointing to recoverable phantom: {r['pit_events'] or 0:,}")
            print(f"  batter_player_id pointing to recoverable phantom:  {r['bat_events'] or 0:,}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
