#!/usr/bin/env python3
"""
List every final game for a team with opponent short_name and flag
anything that looks like a duplicate row (same date + same opponent +
same score). Also shows the team's Sidearm record URL if stored, so we
can sanity-check the scraped 27-17 against what Sidearm actually says.

Usage:
    PYTHONPATH=backend python3 scripts/check_games_with_opponents.py \
        --short-name "C of I" --season 2026
"""

import argparse
import sys
import os
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--short-name", required=True)
    ap.add_argument("--season", type=int, default=2026)
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute("SELECT * FROM teams WHERE short_name = %s",
                    (args.short_name,))
        t = cur.fetchone()
        if not t:
            print(f"No team with short_name = {args.short_name!r}")
            return
        tid = t["id"]
        t = dict(t)
        print(f"Team: {t['short_name']}  (id={tid})  season={args.season}")
        # Show any URL-ish columns that might be the Sidearm record page.
        for k, v in t.items():
            if v and any(s in k.lower() for s in ("url", "site", "sidearm", "slug")):
                print(f"  {k}: {v}")
        print()

        # team_season_stats current record. Dump every column so we can see
        # whatever timestamp field it actually uses (updated_at, scraped_at,
        # etc).
        cur.execute("""
            SELECT *
            FROM team_season_stats
            WHERE team_id = %s AND season = %s
        """, (tid, args.season))
        rec = cur.fetchone()
        if rec:
            r = dict(rec)
            print(f"team_season_stats: {r.get('wins')}-{r.get('losses')}  "
                  f"(ties={r.get('ties')})")
            for k, v in r.items():
                if any(s in k.lower() for s in ("update", "scrape", "time", "stamp", "at")):
                    print(f"  {k}: {v}")
        else:
            print("team_season_stats: NO ROW")
        print()

        # Pull every final game with the opponent's short_name.
        cur.execute("""
            SELECT g.id, g.game_date,
                   g.home_team_id, g.away_team_id,
                   g.home_score, g.away_score,
                   g.status,
                   ht.short_name AS home_name,
                   at.short_name AS away_name
            FROM games g
            LEFT JOIN teams ht ON ht.id = g.home_team_id
            LEFT JOIN teams at ON at.id = g.away_team_id
            WHERE g.season = %s
              AND g.status = 'final'
              AND (g.home_team_id = %s OR g.away_team_id = %s)
              AND g.home_score IS NOT NULL
              AND g.away_score IS NOT NULL
            ORDER BY g.game_date, g.id
        """, (args.season, tid, tid))
        rows = [dict(r) for r in cur.fetchall()]

        # Header
        print(f"{'id':>7}  {'date':10}  {'side':4}  {'opp':<28}  "
              f"{'score':>7}  {'res':>3}")
        wins = losses = 0
        # fingerprint for duplicate detection
        fp_counts = Counter()
        per_opp = Counter()
        for r in rows:
            is_home = r["home_team_id"] == tid
            side = "HOME" if is_home else "AWAY"
            opp = (r["away_name"] if is_home else r["home_name"]) or "?"
            our = r["home_score"] if is_home else r["away_score"]
            their = r["away_score"] if is_home else r["home_score"]
            if our > their:
                res = "W"; wins += 1
            elif our < their:
                res = "L"; losses += 1
            else:
                res = "T"
            fp = (r["game_date"], opp, our, their, res)
            fp_counts[fp] += 1
            per_opp[opp] += 1
            print(f"{r['id']:>7}  {str(r['game_date']):10}  {side:4}  "
                  f"{opp:<28}  {str(our)+'-'+str(their):>7}  {res:>3}")

        print()
        print(f"Computed from games: {wins}-{losses}   "
              f"(total {wins+losses})")

        # Flag possible duplicates.
        dupes = [(fp, n) for fp, n in fp_counts.items() if n > 1]
        if dupes:
            print()
            print("POSSIBLE DUPLICATES (same date + opp + score + result):")
            for fp, n in dupes:
                date, opp, our, their, res = fp
                print(f"  {date}  vs {opp}  {our}-{their} {res}  "
                      f"x{n}")
        else:
            print("\nNo exact-duplicate fingerprints found.")

        print()
        print("Games per opponent (top 10):")
        for opp, n in per_opp.most_common(10):
            print(f"  {n:>3}  {opp}")


if __name__ == "__main__":
    main()
