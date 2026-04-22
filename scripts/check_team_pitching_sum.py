#!/usr/bin/env python3
"""
Sanity check: what does SUM(pitching_stats) give for a team and season?

Bypasses the /team-stats endpoint entirely. This is what the team ERA *would*
be if /team-stats were a simple sum-of-player-stats query with no box-score
reconciliation layered on top.

Usage:
    cd /Users/naterasmussen/Desktop/pnw-baseball
    python3 scripts/check_team_pitching_sum.py --season 2026 --teams LCSC,UW,Seattle U,Gonzaga,Oregon
"""

import argparse
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
DATABASE_URL = os.environ["DATABASE_URL"]


def get_conn():
    url = DATABASE_URL
    if "sslmode" not in url:
        url += ("&" if "?" in url else "?") + "sslmode=require"
    conn = psycopg2.connect(url)
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def run(season, teams):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT t.short_name,
               COUNT(*)                                  AS pitchers,
               SUM(COALESCE(ps.innings_pitched, 0))      AS ip,
               SUM(COALESCE(ps.hits_allowed, 0))         AS h,
               SUM(COALESCE(ps.walks, 0))                AS bb,
               SUM(COALESCE(ps.hit_batters, 0))          AS hbp,
               SUM(COALESCE(ps.strikeouts, 0))           AS k,
               SUM(COALESCE(ps.earned_runs, 0))          AS er,
               SUM(COALESCE(ps.batters_faced, 0))        AS bf,
               SUM(COALESCE(ps.home_runs_allowed, 0))    AS hr
        FROM pitching_stats ps
        JOIN teams t ON ps.team_id = t.id
        WHERE ps.season = %s
          AND t.short_name = ANY(%s)
        GROUP BY t.short_name
        ORDER BY t.short_name
        """,
        (season, teams),
    )
    rows = cur.fetchall()
    if not rows:
        print("no rows")
        return

    print(f"{'team':<12} {'pitchers':<8} {'IP':<8} {'ER':<5} {'ERA':<6} "
          f"{'WHIP':<5} {'BAA':<6} {'K/9':<5}")
    for r in rows:
        ip = float(r["ip"] or 0)
        er = int(r["er"] or 0)
        h  = int(r["h"] or 0)
        bb = int(r["bb"] or 0)
        hbp = int(r["hbp"] or 0)
        k  = int(r["k"] or 0)
        bf = int(r["bf"] or 0)
        era  = (er * 9 / ip) if ip > 0 else 0.0
        whip = ((h + bb) / ip) if ip > 0 else 0.0
        k9   = (k * 9 / ip) if ip > 0 else 0.0
        # BAA = H / (BF - BB - HBP)
        baa_den = bf - bb - hbp
        baa = (h / baa_den) if baa_den > 0 else 0.0
        print(f"{r['short_name']:<12} {r['pitchers']:<8} {ip:<8.1f} {er:<5} "
              f"{era:<6.2f} {whip:<5.2f} {baa:<6.3f} {k9:<5.2f}")

    conn.close()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--season", type=int, required=True)
    p.add_argument("--teams", required=True,
                   help="Comma-separated team short_names, e.g. 'LCSC,UW,Seattle U'")
    args = p.parse_args()
    teams = [t.strip() for t in args.teams.split(",") if t.strip()]
    run(args.season, teams)


if __name__ == "__main__":
    main()
