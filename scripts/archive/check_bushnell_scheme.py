"""
One-shot diagnostic: does the DB have ANY rows showing the new
batting_order scheme for Bushnell 2026?

New scheme: starters have batting_order 1..9, subs/non-batting
pitchers have batting_order >= 100.

Old scheme: everyone shares one running counter, so subs and
pitchers can sit at 10, 11, 12, etc.

Usage:
    PYTHONPATH=backend python3 scripts/check_bushnell_scheme.py
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection  # noqa: E402


def main():
    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute(
            "SELECT id FROM teams WHERE short_name ILIKE %s OR name ILIKE %s LIMIT 1",
            ("Bushnell", "Bushnell"),
        )
        r = cur.fetchone()
        if not r:
            print("No Bushnell team found.")
            return
        tid = r["id"]

        # Total rows for Bushnell 2026
        cur.execute(
            """
            SELECT COUNT(*) AS n
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            WHERE gb.team_id = %s AND g.season = 2026
            """,
            (tid,),
        )
        n_total = cur.fetchone()["n"]

        # Rows at batting_order >= 100 (new-scheme sub/pitcher marker)
        cur.execute(
            """
            SELECT COUNT(*) AS n
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            WHERE gb.team_id = %s AND g.season = 2026
              AND gb.batting_order >= 100
            """,
            (tid,),
        )
        n_new_scheme = cur.fetchone()["n"]

        # Rows at batting_order BETWEEN 10 AND 99 (old-scheme overflow)
        cur.execute(
            """
            SELECT COUNT(*) AS n
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            WHERE gb.team_id = %s AND g.season = 2026
              AND gb.batting_order BETWEEN 10 AND 99
            """,
            (tid,),
        )
        n_old_scheme = cur.fetchone()["n"]

        # Rows at batting_order 1..9 (either scheme — starters)
        cur.execute(
            """
            SELECT COUNT(*) AS n
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            WHERE gb.team_id = %s AND g.season = 2026
              AND gb.batting_order BETWEEN 1 AND 9
            """,
            (tid,),
        )
        n_1_9 = cur.fetchone()["n"]

        # How many distinct games
        cur.execute(
            """
            SELECT COUNT(DISTINCT gb.game_id) AS n
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            WHERE gb.team_id = %s AND g.season = 2026
            """,
            (tid,),
        )
        n_games = cur.fetchone()["n"]

        print(f"\nBushnell 2026 — game_batting breakdown")
        print(f"  Rows total              : {n_total}  (across {n_games} games)")
        print(f"  Starters (order 1..9)   : {n_1_9}")
        print(f"  Old-scheme (order 10-99): {n_old_scheme}  <-- should be 0 if fix ran")
        print(f"  New-scheme (order >=100): {n_new_scheme}  <-- should be >0 if fix ran")

        if n_new_scheme == 0 and n_old_scheme > 0:
            print("\n  VERDICT: DB contains ONLY old-scheme data. The fix has not run.")
        elif n_new_scheme > 0 and n_old_scheme == 0:
            print("\n  VERDICT: DB is clean. Fix ran on every game.")
        elif n_new_scheme > 0 and n_old_scheme > 0:
            print("\n  VERDICT: MIXED. Some games were re-scraped with the fix,")
            print("  others are still old-scheme.")
        else:
            print("\n  VERDICT: No batting rows at all.")


if __name__ == "__main__":
    main()
