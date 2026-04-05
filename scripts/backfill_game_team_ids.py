#!/usr/bin/env python3
"""
Backfill missing home_team_id and away_team_id in the games table.

Some games have team names but no team_id because the opponent name
didn't match during scraping. This script re-runs the matching logic
against the current teams table to fill in the gaps.

Usage:
    cd /opt/pnw-baseball  (or ~/Desktop/pnw-baseball)
    PYTHONPATH=backend python3 scripts/backfill_game_team_ids.py
    PYTHONPATH=backend python3 scripts/backfill_game_team_ids.py --dry-run
"""

import sys
sys.path.insert(0, __import__("os").path.join(__import__("os").path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection

DRY_RUN = "--dry-run" in sys.argv


def get_team_id_by_name(cur, name):
    """Try to match a team name to a team_id using multiple strategies."""
    if not name:
        return None

    # 1. Exact short_name match
    cur.execute("SELECT id FROM teams WHERE LOWER(short_name) = LOWER(%s)", (name,))
    row = cur.fetchone()
    if row:
        return row["id"]

    # 2. school_name or name contains fragment
    cur.execute("""
        SELECT id, school_name, name FROM teams
        WHERE LOWER(school_name) LIKE LOWER(%s)
           OR LOWER(name) LIKE LOWER(%s)
    """, (f"%{name}%", f"%{name}%"))
    row = cur.fetchone()
    if row:
        return row["id"]

    # 3. Fragment contains school_name or name (reverse match)
    cur.execute("""
        SELECT id, school_name, name FROM teams
        WHERE LOWER(%s) LIKE '%%' || LOWER(school_name) || '%%'
           OR LOWER(%s) LIKE '%%' || LOWER(name) || '%%'
    """, (name, name))
    rows = cur.fetchall()
    if len(rows) == 1:
        return rows[0]["id"]

    # 4. Try stripping parenthetical suffixes: "Lewis-Clark State College (Idaho)" -> "Lewis-Clark State College"
    import re
    stripped = re.sub(r'\s*\(.*?\)\s*$', '', name).strip()
    if stripped != name:
        return get_team_id_by_name(cur, stripped)

    return None


def main():
    with get_connection() as conn:
        cur = conn.cursor()

        # Find all games with missing team IDs
        cur.execute("""
            SELECT id, home_team_name, home_team_id, away_team_name, away_team_id
            FROM games
            WHERE home_team_id IS NULL OR away_team_id IS NULL
            ORDER BY game_date DESC
        """)
        games = cur.fetchall()

        if not games:
            print("No games with missing team IDs!")
            return

        print(f"Found {len(games)} games with missing team IDs\n")

        fixed_home = 0
        fixed_away = 0
        still_missing = []

        for g in games:
            changed = False

            if g["home_team_id"] is None and g["home_team_name"]:
                team_id = get_team_id_by_name(cur, g["home_team_name"])
                if team_id:
                    if not DRY_RUN:
                        cur.execute("UPDATE games SET home_team_id = %s WHERE id = %s",
                                    (team_id, g["id"]))
                    print(f"  Game {g['id']}: home '{g['home_team_name']}' -> team_id {team_id}")
                    fixed_home += 1
                    changed = True

            if g["away_team_id"] is None and g["away_team_name"]:
                team_id = get_team_id_by_name(cur, g["away_team_name"])
                if team_id:
                    if not DRY_RUN:
                        cur.execute("UPDATE games SET away_team_id = %s WHERE id = %s",
                                    (team_id, g["id"]))
                    print(f"  Game {g['id']}: away '{g['away_team_name']}' -> team_id {team_id}")
                    fixed_away += 1
                    changed = True

            if not changed:
                missing_side = []
                if g["home_team_id"] is None:
                    missing_side.append(f"home='{g['home_team_name']}'")
                if g["away_team_id"] is None:
                    missing_side.append(f"away='{g['away_team_name']}'")
                still_missing.append((g["id"], ", ".join(missing_side)))

        if not DRY_RUN:
            conn.commit()

        prefix = "[DRY RUN] " if DRY_RUN else ""
        print(f"\n{prefix}Fixed: {fixed_home} home + {fixed_away} away = {fixed_home + fixed_away} total")

        if still_missing:
            print(f"\nStill unmatched ({len(still_missing)} games):")
            for gid, desc in still_missing[:20]:
                print(f"  Game {gid}: {desc}")
            if len(still_missing) > 20:
                print(f"  ... and {len(still_missing) - 20} more")


if __name__ == "__main__":
    main()
