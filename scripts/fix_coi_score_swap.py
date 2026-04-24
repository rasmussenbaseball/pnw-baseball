#!/usr/bin/env python3
"""
Fix 7 C of I games (2026) where home_score and away_score are swapped,
causing losses to show as wins. Team_ids are already correct on these
rows, so we only swap the score columns.

Games:
  831  2026-02-15 vs Pacific (HOME)   should be L 9-2
  936  2026-02-23 @ EOU (AWAY)        should be L 11-5
  974  2026-03-07 vs OIT (HOME)       should be L 14-4
  1197 2026-03-27 @ LCSC (AWAY)       should be L 9-4
  1324 2026-03-28 @ LCSC (AWAY)       should be L 10-0
  1325 2026-03-28 @ LCSC (AWAY)       should be L 9-3
  1413 2026-03-29 @ LCSC (AWAY)       should be L 21-3

Usage:
    PYTHONPATH=backend python3 scripts/fix_coi_score_swap.py            # dry run
    PYTHONPATH=backend python3 scripts/fix_coi_score_swap.py --apply    # commit
"""

import argparse
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection

GAME_IDS = [831, 936, 974, 1197, 1324, 1325, 1413]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true",
                    help="Actually commit the swap. Omit for a dry run.")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        # Before
        cur.execute("""
            SELECT id, game_date, home_team_id, home_score,
                   away_team_id, away_score
            FROM games
            WHERE id = ANY(%s)
            ORDER BY game_date, id
        """, (GAME_IDS,))
        before = [dict(r) for r in cur.fetchall()]

        print("BEFORE:")
        for r in before:
            print(f"  id={r['id']:>5}  {r['game_date']}  "
                  f"home(tid={r['home_team_id']})={r['home_score']}  "
                  f"away(tid={r['away_team_id']})={r['away_score']}")

        # Do the swap.
        cur.execute("""
            UPDATE games
            SET home_score = away_score,
                away_score = home_score
            WHERE id = ANY(%s)
        """, (GAME_IDS,))
        updated = cur.rowcount

        # After
        cur.execute("""
            SELECT id, game_date, home_team_id, home_score,
                   away_team_id, away_score
            FROM games
            WHERE id = ANY(%s)
            ORDER BY game_date, id
        """, (GAME_IDS,))
        after = [dict(r) for r in cur.fetchall()]

        print()
        print(f"AFTER ({updated} rows updated in this transaction):")
        for r in after:
            print(f"  id={r['id']:>5}  {r['game_date']}  "
                  f"home(tid={r['home_team_id']})={r['home_score']}  "
                  f"away(tid={r['away_team_id']})={r['away_score']}")

        if args.apply:
            conn.commit()
            print()
            print("COMMITTED.")
        else:
            conn.rollback()
            print()
            print("DRY RUN — rolled back. Re-run with --apply to commit.")


if __name__ == "__main__":
    main()
