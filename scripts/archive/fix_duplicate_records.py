#!/usr/bin/env python3
"""
Find and fix duplicate team_season_stats records.

The scrape_records.py script scrapes CURRENT standings pages that don't have
season-specific URLs. When run for historical seasons, it saved current-year
data under the wrong year. This script detects and removes those duplicates.

Usage:
    cd pnw-baseball
    python3 scripts/fix_duplicate_records.py          # Dry run (show what would change)
    python3 scripts/fix_duplicate_records.py --fix     # Actually delete duplicates
"""

import sqlite3
import argparse
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
DB_PATH = PROJECT_ROOT / "backend" / "data" / "pnw_baseball.db"

# Fall back to data/ if backend/data doesn't exist
if not DB_PATH.exists():
    DB_PATH = PROJECT_ROOT / "data" / "pnw_baseball.db"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fix", action="store_true", help="Actually delete duplicates (default is dry-run)")
    args = parser.parse_args()

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    print("Scanning for duplicate team_season_stats records...\n")

    teams = conn.execute("""
        SELECT t.id, t.short_name, t.name
        FROM teams t WHERE t.is_active = 1
        ORDER BY t.short_name
    """).fetchall()

    duplicates_found = []

    for team in teams:
        tid = team["id"]
        rows = conn.execute("""
            SELECT season, wins, losses, conference_wins, conference_losses,
                   runs_scored, runs_allowed
            FROM team_season_stats
            WHERE team_id = ?
            ORDER BY season DESC
        """, (tid,)).fetchall()

        if len(rows) < 2:
            continue

        # Compare each season with the most recent (current) season
        current = rows[0]
        for older in rows[1:]:
            # Check if W-L and conf record match exactly
            if (current["wins"] == older["wins"] and
                current["losses"] == older["losses"] and
                current["conference_wins"] == older["conference_wins"] and
                current["conference_losses"] == older["conference_losses"] and
                current["wins"] is not None and current["wins"] > 0):

                # Check if the older season has real batting data (different from current)
                bat_current = conn.execute("""
                    SELECT COUNT(DISTINCT player_id) as cnt, SUM(plate_appearances) as pa
                    FROM batting_stats WHERE team_id = ? AND season = ?
                """, (tid, current["season"])).fetchone()

                bat_older = conn.execute("""
                    SELECT COUNT(DISTINCT player_id) as cnt, SUM(plate_appearances) as pa
                    FROM batting_stats WHERE team_id = ? AND season = ?
                """, (tid, older["season"])).fetchone()

                is_bat_dupe = (
                    bat_older["cnt"] == bat_current["cnt"] and
                    bat_older["pa"] == bat_current["pa"]
                )
                is_bat_missing = bat_older["cnt"] == 0
                has_real_batting = bat_older["cnt"] > 0 and not is_bat_dupe

                if is_bat_dupe or is_bat_missing:
                    # No real data for this season — safe to delete the whole row
                    status = "DUPLICATE (identical batting)" if is_bat_dupe else "DUPLICATE (no batting data)"
                    action = "delete"
                elif has_real_batting:
                    # Real player stats exist but W-L record was overwritten from current season
                    # Just clear the bad W-L record instead of deleting
                    status = "BAD RECORD (real roster but W-L copied from current season)"
                    action = "clear_record"
                else:
                    status = "UNKNOWN"
                    action = "skip"

                duplicates_found.append({
                    "team": team["short_name"],
                    "team_id": tid,
                    "current_season": current["season"],
                    "dup_season": older["season"],
                    "record": f"{current['wins']}-{current['losses']}",
                    "conf": f"{current['conference_wins']}-{current['conference_losses']}",
                    "status": status,
                    "action": action,
                })

    if not duplicates_found:
        print("No duplicates found!")
        conn.close()
        return

    print(f"Found {len(duplicates_found)} potential issues:\n")
    for d in duplicates_found:
        label = {"delete": "DELETE ROW", "clear_record": "CLEAR W-L", "skip": "SKIP"}[d["action"]]
        print(f"  {d['team']}: {d['dup_season']} matches {d['current_season']} "
              f"({d['record']}, conf {d['conf']}) — {d['status']} → {label}")

    fixable = [d for d in duplicates_found if d["action"] in ("delete", "clear_record")]

    if not fixable:
        print("\nNo fixable issues found.")
        conn.close()
        return

    to_delete = [d for d in fixable if d["action"] == "delete"]
    to_clear = [d for d in fixable if d["action"] == "clear_record"]

    if args.fix:
        if to_delete:
            print(f"\nDeleting {len(to_delete)} fake records...")
            for d in to_delete:
                conn.execute(
                    "DELETE FROM team_season_stats WHERE team_id = ? AND season = ?",
                    (d["team_id"], d["dup_season"])
                )
                print(f"  Deleted {d['team']} season {d['dup_season']}")

        if to_clear:
            print(f"\nClearing {len(to_clear)} bad W-L records (keeping the row for other stats)...")
            for d in to_clear:
                conn.execute("""
                    UPDATE team_season_stats
                    SET wins = 0, losses = 0, conference_wins = 0, conference_losses = 0
                    WHERE team_id = ? AND season = ?
                """, (d["team_id"], d["dup_season"]))
                print(f"  Cleared {d['team']} season {d['dup_season']} W-L record")

        conn.commit()
        print("\nDone!")
    else:
        print(f"\nDry run — would delete {len(to_delete)} rows, clear W-L on {len(to_clear)} rows.")
        print("Run with --fix to apply changes.")

    conn.close()


if __name__ == "__main__":
    main()
