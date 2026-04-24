#!/usr/bin/env python3
"""
Diagnose a team's overall record vs its home/away-split record.

The team page graphic displays "Overall" from team_season_stats but
"Home" and "Away" from an on-the-fly aggregate over the games table.
When those two numbers disagree it means one source is wrong, usually
either:
  (a) games table has rows with flipped scores / team_ids, or
  (b) team_season_stats.wins/losses is stale vs the games table.

This script prints both tallies side by side and lists every game the
team played so you can eyeball which individual rows are the problem.

Usage:
    PYTHONPATH=backend python3 scripts/diagnose_record_mismatch.py \
        --short-name "College of Idaho" --season 2026
"""

import argparse
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--short-name", required=True,
                    help='Team short_name, e.g. "College of Idaho"')
    ap.add_argument("--season", type=int, default=2026)
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        # 1. Resolve the team.
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

        # 2. team_season_stats values (what "Overall" shows).
        cur.execute("""
            SELECT wins, losses, ties, conference_wins, conference_losses
            FROM team_season_stats
            WHERE team_id = %s AND season = %s
        """, (tid, args.season))
        rec = cur.fetchone()
        if rec:
            r = dict(rec)
            print("team_season_stats (Overall on graphic):")
            print(f"  W-L: {r['wins']}-{r['losses']}  "
                  f"(ties={r['ties']}, conf {r['conference_wins']}-{r['conference_losses']})")
        else:
            print("team_season_stats: NO ROW FOUND")
        print()

        # 3. Home/away split computed from games table (same as team page endpoint).
        cur.execute("""
            SELECT
                COUNT(*) FILTER (WHERE home_team_id = %s AND home_score > away_score) AS home_wins,
                COUNT(*) FILTER (WHERE home_team_id = %s AND home_score < away_score) AS home_losses,
                COUNT(*) FILTER (WHERE away_team_id = %s AND away_score > home_score) AS away_wins,
                COUNT(*) FILTER (WHERE away_team_id = %s AND away_score < home_score) AS away_losses,
                COUNT(*) FILTER (WHERE (home_team_id = %s OR away_team_id = %s)
                                   AND home_score = away_score) AS ties,
                COUNT(*) AS total_games
            FROM games
            WHERE season = %s
              AND status = 'final'
              AND (home_team_id = %s OR away_team_id = %s)
              AND home_score IS NOT NULL
              AND away_score IS NOT NULL
        """, (tid, tid, tid, tid, tid, tid, args.season, tid, tid))
        splits = dict(cur.fetchone() or {})
        hw = splits.get("home_wins") or 0
        hl = splits.get("home_losses") or 0
        aw = splits.get("away_wins") or 0
        al = splits.get("away_losses") or 0
        ties = splits.get("ties") or 0
        total = splits.get("total_games") or 0
        print("games table split (Home/Away on graphic):")
        print(f"  Home: {hw}-{hl}   Away: {aw}-{al}   Total: {hw+hl+aw+al}  "
              f"(ties={ties}, rows={total})")
        print()

        # 4. If mismatch, dump every game so we can see which rows look wrong.
        if rec and (r["wins"] != hw + aw or r["losses"] != hl + al):
            print("MISMATCH DETECTED. Listing every final game for this team")
            print("(sorted by date). Look for flipped scores or unexpected rows.")
            print()
            cur.execute("""
                SELECT id, game_date,
                       home_team_id, away_team_id,
                       home_score, away_score,
                       is_conference, is_postseason, status
                FROM games
                WHERE season = %s
                  AND status = 'final'
                  AND (home_team_id = %s OR away_team_id = %s)
                  AND home_score IS NOT NULL
                  AND away_score IS NOT NULL
                ORDER BY game_date, id
            """, (args.season, tid, tid))
            rows = cur.fetchall()
            print(f"{'id':>7} {'date':10} {'side':4} {'score':>7} {'opp_id':>6} "
                  f"{'result':>6} {'conf':>4} {'post':>4}")
            wins_check = losses_check = 0
            for r in rows:
                r = dict(r)
                is_home = r["home_team_id"] == tid
                side = "HOME" if is_home else "AWAY"
                our = r["home_score"] if is_home else r["away_score"]
                their = r["away_score"] if is_home else r["home_score"]
                opp = r["away_team_id"] if is_home else r["home_team_id"]
                if our > their:
                    result = "W"
                    wins_check += 1
                elif our < their:
                    result = "L"
                    losses_check += 1
                else:
                    result = "T"
                print(f"{r['id']:>7} {str(r['game_date']):10} {side:4} "
                      f"{our}-{their:>3} {opp:>6} {result:>6} "
                      f"{'Y' if r['is_conference'] else 'N':>4} "
                      f"{'Y' if r['is_postseason'] else 'N':>4}")
            print()
            print(f"  games-table tally: {wins_check}-{losses_check}")


if __name__ == "__main__":
    main()
