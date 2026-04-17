"""
Delete all game_batting rows for one team in one season, so we can
re-scrape cleanly after the batting_order fix.

The scraper's ON CONFLICT key is (game_id, team_id, player_name,
batting_order). The old (buggy) data has batting_order values of
10, 11, 12, ... for what should be slots 1-9. If we just re-run the
scraper without wiping, the new (correct) rows land as NEW inserts
instead of updates -- producing duplicates. This script clears the
slate first.

Prints a dry-run preview first, then asks for confirmation before
deleting.

Usage (on Mac, from repo root):
    PYTHONPATH=backend python3 scripts/wipe_team_batting.py Bushnell
    PYTHONPATH=backend python3 scripts/wipe_team_batting.py Bushnell 2026
    PYTHONPATH=backend python3 scripts/wipe_team_batting.py Bushnell 2026 --yes
"""
import sys
import os
import argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection  # noqa: E402


def resolve_team(cur, arg):
    if arg.isdigit():
        cur.execute("SELECT id, name FROM teams WHERE id = %s", (int(arg),))
    else:
        cur.execute(
            "SELECT id, name FROM teams WHERE short_name ILIKE %s OR name ILIKE %s LIMIT 1",
            (arg, arg),
        )
    r = cur.fetchone()
    return dict(r) if r else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("team")
    ap.add_argument("season", nargs="?", type=int, default=2026)
    ap.add_argument("--yes", action="store_true",
                    help="Skip the confirmation prompt")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()
        team = resolve_team(cur, args.team)
        if not team:
            print(f"No team found for: {args.team}")
            return
        tid = team["id"]

        # Preview: how many rows, across how many games?
        cur.execute(
            """
            SELECT COUNT(*)          AS n_rows,
                   COUNT(DISTINCT gb.game_id) AS n_games
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            WHERE gb.team_id = %s
              AND g.season = %s
            """,
            (tid, args.season),
        )
        stats = dict(cur.fetchone())
        print(f"\n=== {team['name']} (id={tid}) season {args.season} ===")
        print(f"  {stats['n_rows']} game_batting rows across {stats['n_games']} games")

        if stats["n_rows"] == 0:
            print("  Nothing to delete.")
            return

        # Show a couple of sample rows so Nate can sanity-check before nuking
        cur.execute(
            """
            SELECT g.game_date, g.game_number,
                   gb.batting_order, gb.position, gb.player_name
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            WHERE gb.team_id = %s
              AND g.season = %s
            ORDER BY g.game_date DESC, g.game_number, gb.batting_order
            LIMIT 12
            """,
            (tid, args.season),
        )
        print("\n  Sample rows (most recent 12):")
        for r in cur.fetchall():
            print(f"    {r['game_date']} g#{r['game_number'] or 1}  "
                  f"order={r['batting_order']:<3} pos={r['position'] or '-':<5} "
                  f"{r['player_name']}")

        if not args.yes:
            print("\nType YES to delete these rows (anything else cancels): ", end="")
            ans = input().strip()
            if ans != "YES":
                print("Cancelled.")
                return

        cur.execute(
            """
            DELETE FROM game_batting
            WHERE team_id = %s
              AND game_id IN (SELECT id FROM games WHERE season = %s)
            """,
            (tid, args.season),
        )
        deleted = cur.rowcount
        conn.commit()
        print(f"\nDeleted {deleted} game_batting rows for {team['name']} {args.season}.")
        print("Safe to re-scrape now.")


if __name__ == "__main__":
    main()
