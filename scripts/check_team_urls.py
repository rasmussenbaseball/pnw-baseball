#!/usr/bin/env python3
"""
Dump the source_url and (parsed) slug for every final game involving a
team, so we can see the actual URL format and figure out how to detect
flips reliably. Prints id, date, stored home/away, W/L, slug, url.
"""

import argparse
import sys
import os
import re

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--short-name", required=True)
    ap.add_argument("--season", type=int, default=2026)
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute("SELECT id FROM teams WHERE short_name = %s",
                    (args.short_name,))
        t = cur.fetchone()
        if not t:
            print("no team")
            return
        tid = t["id"]

        cur.execute("""
            SELECT g.id, g.game_date,
                   g.home_team_id, g.away_team_id,
                   g.home_score, g.away_score,
                   g.source_url AS url,
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

        for r in rows:
            url = r["url"] or ""
            m = re.search(r"/stats/\d+/([^/]+)/boxscore", url)
            if not m:
                m = re.search(r"/stats/[^/]+/([^/]+)", url)
            slug = m.group(1) if m else "(no slug match)"

            is_home = r["home_team_id"] == tid
            side = "HOME" if is_home else "AWAY"
            our = r["home_score"] if is_home else r["away_score"]
            their = r["away_score"] if is_home else r["home_score"]
            res = "W" if our > their else ("L" if our < their else "T")

            print(f"id={r['id']:>5}  {r['game_date']}  {side}  "
                  f"stored: H={r['home_name']!s:<25} A={r['away_name']!s:<25}  "
                  f"{our}-{their} {res}")
            print(f"  slug: {slug}")
            print(f"  url:  {url}")
            print()


if __name__ == "__main__":
    main()
