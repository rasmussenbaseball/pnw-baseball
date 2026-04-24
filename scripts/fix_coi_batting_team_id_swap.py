#!/usr/bin/env python3
"""
Follow-up to fix_coi_score_swap.py.

For the 7 C of I games whose home_score/away_score were already swapped
back to correct, the underlying game_batting and game_pitching rows still
have team_id values pointing at the wrong team. Each row's player_id is
correct, but the team_id was tagged from the side of the box score the
scraper landed on, which was reversed.

This script swaps team_id on every game_batting and game_pitching row for
those 7 games: rows tagged with the home_team_id become tagged with the
away_team_id, and vice versa.

Affected games (same set as fix_coi_score_swap.py):
  831  2026-02-15 vs Pacific (HOME)
  936  2026-02-23 @ EOU (AWAY)
  974  2026-03-07 vs OIT (HOME)
  1197 2026-03-27 @ LCSC (AWAY)
  1324 2026-03-28 @ LCSC (AWAY)
  1325 2026-03-28 @ LCSC (AWAY)
  1413 2026-03-29 @ LCSC (AWAY)

Usage:
    PYTHONPATH=backend python3 scripts/fix_coi_batting_team_id_swap.py            # dry run
    PYTHONPATH=backend python3 scripts/fix_coi_batting_team_id_swap.py --apply    # commit
"""

import argparse
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection

GAME_IDS = [831, 936, 974, 1197, 1324, 1325, 1413]


def summarize(cur, label):
    """Print per-game team_id distribution + score-vs-batting consistency."""
    print(label)
    cur.execute("""
        SELECT g.id, g.game_date, g.home_team_id, g.away_team_id,
               g.home_score, g.away_score
        FROM games g
        WHERE g.id = ANY(%s)
        ORDER BY g.game_date, g.id
    """, (GAME_IDS,))
    games = [dict(r) for r in cur.fetchall()]

    for g in games:
        gid = g["id"]
        home_id = g["home_team_id"]
        away_id = g["away_team_id"]

        # Sum runs per team_id from game_batting for this game.
        cur.execute("""
            SELECT team_id, COALESCE(SUM(runs), 0) AS run_sum,
                   COUNT(*) AS rows
            FROM game_batting
            WHERE game_id = %s
            GROUP BY team_id
        """, (gid,))
        batting_by_team = {r["team_id"]: dict(r) for r in cur.fetchall()}

        # Pitching row counts only (no run column there).
        cur.execute("""
            SELECT team_id, COUNT(*) AS rows
            FROM game_pitching
            WHERE game_id = %s
            GROUP BY team_id
        """, (gid,))
        pitching_by_team = {r["team_id"]: dict(r) for r in cur.fetchall()}

        home_batting = batting_by_team.get(home_id, {"run_sum": 0, "rows": 0})
        away_batting = batting_by_team.get(away_id, {"run_sum": 0, "rows": 0})
        home_pitching = pitching_by_team.get(home_id, {"rows": 0})
        away_pitching = pitching_by_team.get(away_id, {"rows": 0})

        home_ok = home_batting["run_sum"] == g["home_score"]
        away_ok = away_batting["run_sum"] == g["away_score"]
        flag = "OK" if (home_ok and away_ok) else "MISMATCH"

        print(
            f"  id={gid:>5}  {g['game_date']}  "
            f"H(tid={home_id}) score={g['home_score']} "
            f"bat_sum={home_batting['run_sum']} bat_rows={home_batting['rows']} "
            f"pit_rows={home_pitching['rows']}  |  "
            f"A(tid={away_id}) score={g['away_score']} "
            f"bat_sum={away_batting['run_sum']} bat_rows={away_batting['rows']} "
            f"pit_rows={away_pitching['rows']}  [{flag}]"
        )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true",
                    help="Actually commit the team_id swap. Omit for a dry run.")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        summarize(cur, "BEFORE:")

        # Swap team_id on game_batting for the affected games.
        # Rows tagged with the home_team_id -> retag to away_team_id, and
        # vice versa. Done as a single UPDATE...FROM so each row is touched
        # at most once and Postgres atomic.
        cur.execute("""
            WITH g AS (
                SELECT id AS game_id, home_team_id, away_team_id
                FROM games
                WHERE id = ANY(%s)
            )
            UPDATE game_batting gb
            SET team_id = CASE
                WHEN gb.team_id = g.home_team_id THEN g.away_team_id
                WHEN gb.team_id = g.away_team_id THEN g.home_team_id
                ELSE gb.team_id
            END
            FROM g
            WHERE gb.game_id = g.game_id
        """, (GAME_IDS,))
        bat_rows = cur.rowcount

        cur.execute("""
            WITH g AS (
                SELECT id AS game_id, home_team_id, away_team_id
                FROM games
                WHERE id = ANY(%s)
            )
            UPDATE game_pitching gp
            SET team_id = CASE
                WHEN gp.team_id = g.home_team_id THEN g.away_team_id
                WHEN gp.team_id = g.away_team_id THEN g.home_team_id
                ELSE gp.team_id
            END
            FROM g
            WHERE gp.game_id = g.game_id
        """, (GAME_IDS,))
        pit_rows = cur.rowcount

        print()
        print(f"Swapped team_id on {bat_rows} game_batting rows "
              f"and {pit_rows} game_pitching rows.")
        print()
        summarize(cur, "AFTER:")

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
