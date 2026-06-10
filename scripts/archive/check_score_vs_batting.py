#!/usr/bin/env python3
"""
Cross-check games.home_score / games.away_score against the sum of
runs recorded in game_batting for the same game.

If a scraper flipped a final score (swapped home/away), the games row
will disagree with the batting lines it was built from. Those
disagreements are exactly the rows we need to fix.

Run for one team:
    PYTHONPATH=backend python3 scripts/check_score_vs_batting.py \
        --short-name "C of I" --season 2026
"""

import argparse
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--short-name", required=True)
    ap.add_argument("--season", type=int, default=2026)
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute(
            "SELECT id, short_name FROM teams WHERE short_name = %s",
            (args.short_name,),
        )
        t = cur.fetchone()
        if not t:
            print(f"No team with short_name = {args.short_name!r}")
            return
        tid = t["id"]
        print(f"Team: {t['short_name']}  (id={tid})  season={args.season}")
        print()

        # Pull every final game for this team with its two score columns.
        cur.execute("""
            SELECT g.id, g.game_date,
                   g.home_team_id, g.away_team_id,
                   g.home_score, g.away_score
            FROM games g
            WHERE g.season = %s
              AND g.status = 'final'
              AND (g.home_team_id = %s OR g.away_team_id = %s)
              AND g.home_score IS NOT NULL
              AND g.away_score IS NOT NULL
            ORDER BY g.game_date, g.id
        """, (args.season, tid, tid))
        games = [dict(r) for r in cur.fetchall()]

        # For each game, sum runs by team from game_batting.
        suspicious = []
        missing_batting = []
        header = (f"{'id':>7}  {'date':10}  "
                  f"{'gH':>3}-{'gA':<3}  "
                  f"{'bH':>3}-{'bA':<3}  status")
        print(header)
        for g in games:
            cur.execute("""
                SELECT team_id, COALESCE(SUM(runs), 0) AS r
                FROM game_batting
                WHERE game_id = %s
                GROUP BY team_id
            """, (g["id"],))
            by_team = {row["team_id"]: row["r"] for row in cur.fetchall()}
            h_runs = by_team.get(g["home_team_id"])
            a_runs = by_team.get(g["away_team_id"])

            if h_runs is None or a_runs is None:
                status = "NO BATTING"
                missing_batting.append(g)
            elif h_runs == g["home_score"] and a_runs == g["away_score"]:
                status = "ok"
            elif h_runs == g["away_score"] and a_runs == g["home_score"]:
                status = "FLIPPED"
                suspicious.append((g, h_runs, a_runs))
            else:
                status = f"DIFF (bat {h_runs}-{a_runs})"
                suspicious.append((g, h_runs, a_runs))

            bh = "?" if h_runs is None else str(h_runs)
            ba = "?" if a_runs is None else str(a_runs)
            print(f"{g['id']:>7}  {str(g['game_date']):10}  "
                  f"{g['home_score']:>3}-{g['away_score']:<3}  "
                  f"{bh:>3}-{ba:<3}  {status}")

        print()
        print(f"Total games checked: {len(games)}")
        print(f"Flipped / mismatched: {len(suspicious)}")
        print(f"Missing batting data: {len(missing_batting)}")

        if suspicious:
            print()
            print("SUSPICIOUS GAMES (games table score disagrees with batting):")
            for g, hr, ar in suspicious:
                print(f"  game_id={g['id']}  {g['game_date']}  "
                      f"games={g['home_score']}-{g['away_score']}  "
                      f"batting={hr}-{ar}")


if __name__ == "__main__":
    main()
