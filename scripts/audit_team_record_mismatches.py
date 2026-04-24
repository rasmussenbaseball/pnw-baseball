#!/usr/bin/env python3
"""
Audit every team for Overall-vs-games-table record mismatches — the same
kind that produced the C of I score-swap bug (see project_score_swap_bug).

For each team with a 2026 season row in team_season_stats, compute the
W-L tally from the games table and flag any disagreement with the
stored wins/losses. Prints a summary table so we can see scope at a
glance, then the exact per-team breakdown.

Usage:
    PYTHONPATH=backend python3 scripts/audit_team_record_mismatches.py
    PYTHONPATH=backend python3 scripts/audit_team_record_mismatches.py --season 2026
"""

import argparse
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        # Every team that has a season row for this season.
        cur.execute("""
            SELECT t.id, t.short_name,
                   s.wins AS stats_wins, s.losses AS stats_losses
            FROM team_season_stats s
            JOIN teams t ON t.id = s.team_id
            WHERE s.season = %s
            ORDER BY t.short_name
        """, (args.season,))
        teams = [dict(r) for r in cur.fetchall()]

        rows = []
        for t in teams:
            tid = t["id"]
            cur.execute("""
                SELECT
                    COUNT(*) FILTER (
                        WHERE (home_team_id = %s AND home_score > away_score)
                           OR (away_team_id = %s AND away_score > home_score)
                    ) AS games_wins,
                    COUNT(*) FILTER (
                        WHERE (home_team_id = %s AND home_score < away_score)
                           OR (away_team_id = %s AND away_score < home_score)
                    ) AS games_losses,
                    COUNT(*) FILTER (
                        WHERE (home_team_id = %s OR away_team_id = %s)
                          AND home_score = away_score
                    ) AS games_ties,
                    COUNT(*) AS total_games
                FROM games
                WHERE season = %s
                  AND status = 'final'
                  AND (home_team_id = %s OR away_team_id = %s)
                  AND home_score IS NOT NULL
                  AND away_score IS NOT NULL
            """, (tid, tid, tid, tid, tid, tid, args.season, tid, tid))
            g = dict(cur.fetchone() or {})
            t["games_wins"] = g.get("games_wins") or 0
            t["games_losses"] = g.get("games_losses") or 0
            t["games_ties"] = g.get("games_ties") or 0
            t["total_games"] = g.get("total_games") or 0
            t["delta_wins"] = t["games_wins"] - t["stats_wins"]
            t["delta_losses"] = t["games_losses"] - t["stats_losses"]
            rows.append(t)

        # Header
        hdr = (f"{'team':<28}  {'stats W-L':>10}  {'games W-L':>10}  "
               f"{'dW':>4}  {'dL':>4}  {'n':>4}")
        print(hdr)
        print("-" * len(hdr))

        mismatched = []
        for r in rows:
            sw_sl = f"{r['stats_wins']}-{r['stats_losses']}"
            gw_gl = f"{r['games_wins']}-{r['games_losses']}"
            flag = ""
            if r["delta_wins"] != 0 or r["delta_losses"] != 0:
                flag = "  <<<"
                mismatched.append(r)
            print(f"{r['short_name']:<28}  {sw_sl:>10}  {gw_gl:>10}  "
                  f"{r['delta_wins']:>+4}  {r['delta_losses']:>+4}  "
                  f"{r['total_games']:>4}{flag}")

        print()
        print(f"Teams with mismatches: {len(mismatched)} / {len(rows)}")

        if mismatched:
            print()
            print("Suspected score-swap counts per team "
                  "(each swap adds +1 win and -1 loss "
                  "OR -1 win and +1 loss):")
            for r in mismatched:
                # If stats say W-L and games say W+k, L-k, then k swaps
                # where stored score made a loss look like a win.
                # If stats say W-L and games say W-k, L+k, then k swaps
                # where stored score made a win look like a loss.
                swap_guess = max(abs(r["delta_wins"]), abs(r["delta_losses"]))
                direction = (
                    "losses flipped to wins" if r["delta_wins"] > 0
                    else "wins flipped to losses"
                )
                print(f"  {r['short_name']:<28}  ~{swap_guess} games "
                      f"({direction})")


if __name__ == "__main__":
    main()
