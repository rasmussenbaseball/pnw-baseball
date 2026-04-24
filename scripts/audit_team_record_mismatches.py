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
    PYTHONPATH=backend python3 scripts/audit_team_record_mismatches.py --all-teams

Default behavior is PNW-only (state IN WA, OR, ID, MT, BC). OOC opponents
like UCLA only have a handful of games against PNW teams in our DB, so
their Overall record will always disagree with the games-table aggregation.
Pass --all-teams to include them anyway.
"""

import argparse
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection


PNW_STATES = ("WA", "OR", "ID", "MT", "BC")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--all-teams", action="store_true",
                    help="Include non-PNW opponents (default: PNW only)")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        # Every team that has a season row for this season.
        if args.all_teams:
            cur.execute("""
                SELECT t.id, t.short_name,
                       s.wins AS stats_wins, s.losses AS stats_losses
                FROM team_season_stats s
                JOIN teams t ON t.id = s.team_id
                WHERE s.season = %s
                ORDER BY t.short_name
            """, (args.season,))
        else:
            cur.execute("""
                SELECT t.id, t.short_name,
                       s.wins AS stats_wins, s.losses AS stats_losses
                FROM team_season_stats s
                JOIN teams t ON t.id = s.team_id
                WHERE s.season = %s
                  AND t.state = ANY(%s)
                ORDER BY t.short_name
            """, (args.season, list(PNW_STATES)))
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

        # Categorize each mismatch:
        #   score_swap: dW = -dL and both nonzero (true swap signature)
        #   missing_games: dW <= 0 and dL <= 0, at least one negative
        #     (games table is missing W and/or L vs season stats)
        #   extra_games: dW >= 0 and dL >= 0, at least one positive
        #     (games table has more W and/or L than season stats)
        #   other: any other shape (rare — partial swap + drift)
        score_swap = []
        missing_games = []
        extra_games = []
        other = []
        for r in mismatched:
            dw, dl = r["delta_wins"], r["delta_losses"]
            if dw != 0 and dw == -dl:
                score_swap.append(r)
            elif dw <= 0 and dl <= 0:
                missing_games.append(r)
            elif dw >= 0 and dl >= 0:
                extra_games.append(r)
            else:
                other.append(r)

        def print_section(title, items, formatter):
            if not items:
                return
            print()
            print(title)
            for r in items:
                print(f"  {r['short_name']:<28}  {formatter(r)}")

        print_section(
            "SCORE-SWAP candidates "
            "(dW = -dL — same shape as the C of I bug):",
            score_swap,
            lambda r: (
                f"~{abs(r['delta_wins'])} games "
                f"({'losses flipped to wins' if r['delta_wins'] > 0 else 'wins flipped to losses'})"
            ),
        )

        print_section(
            "MISSING games "
            "(season stats has more W and/or L than games table):",
            missing_games,
            lambda r: (
                f"missing ~{abs(r['delta_wins']) + abs(r['delta_losses'])} game(s) "
                f"(dW={r['delta_wins']:+d}, dL={r['delta_losses']:+d})"
            ),
        )

        print_section(
            "EXTRA games "
            "(games table has more W and/or L than season stats — "
            "duplicates or season stats stale):",
            extra_games,
            lambda r: (
                f"extra ~{r['delta_wins'] + r['delta_losses']} game(s) "
                f"(dW={r['delta_wins']:+d}, dL={r['delta_losses']:+d})"
            ),
        )

        print_section(
            "OTHER (mixed pattern — possible partial swap + missing/extra):",
            other,
            lambda r: f"dW={r['delta_wins']:+d}, dL={r['delta_losses']:+d}",
        )

        # Final scoreboard
        print()
        print(
            f"Summary: score_swap={len(score_swap)}  "
            f"missing={len(missing_games)}  "
            f"extra={len(extra_games)}  "
            f"other={len(other)}"
        )


if __name__ == "__main__":
    main()
