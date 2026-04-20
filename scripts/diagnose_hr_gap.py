#!/usr/bin/env python3
"""
Diagnose the HR-in-game_pitching gap.

pitching_stats.home_runs_allowed pulls from season totals (correct), but
game_pitching rows for many pitchers show 0 HR even when they gave up HRs.
This script finds the pitchers with the largest gap between the two and
prints a sample source_url so we can inspect the Sidearm HTML.

Usage (on server):
    cd /opt/pnw-baseball
    PYTHONPATH=backend python3 scripts/diagnose_hr_gap.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
from app.models.database import get_connection


def main():
    with get_connection() as conn:
        cur = conn.cursor()
        _run(cur)


def _run(cur):
    print("=" * 70)
    print("1) HR gap overview by team (season 2026)")
    print("=" * 70)
    cur.execute(
        """
        SELECT
            t.short_name,
            COUNT(DISTINCT gp.game_id)             AS games,
            SUM(gp.home_runs_allowed)              AS gp_hr_sum,
            (
              SELECT COALESCE(SUM(ps.home_runs_allowed), 0)
              FROM pitching_stats ps
              WHERE ps.team_id = t.id AND ps.season = 2026
            )                                      AS ps_hr_sum
        FROM game_pitching gp
        JOIN teams t ON t.id = gp.team_id
        JOIN games g ON g.id = gp.game_id
        WHERE g.season = 2026 AND g.status = 'final'
        GROUP BY t.id, t.short_name
        ORDER BY (
          (SELECT COALESCE(SUM(ps.home_runs_allowed), 0)
           FROM pitching_stats ps
           WHERE ps.team_id = t.id AND ps.season = 2026)
          - SUM(gp.home_runs_allowed)
        ) DESC
        LIMIT 20
        """
    )
    rows = cur.fetchall()
    print(f"{'team':<22} {'games':>6} {'gp_hr':>6} {'ps_hr':>6} {'gap':>6}")
    print("-" * 50)
    for r in rows:
        gp_hr = r["gp_hr_sum"] or 0
        ps_hr = r["ps_hr_sum"] or 0
        gap = ps_hr - gp_hr
        print(f"{r['short_name']:<22} {r['games']:>6} {gp_hr:>6} {ps_hr:>6} {gap:>6}")

    print()
    print("=" * 70)
    print("2) Pitchers with large HR gap (ps vs gp) — season 2026")
    print("=" * 70)
    cur.execute(
        """
        SELECT
            ps.id                 AS ps_id,
            p.first_name || ' ' || p.last_name AS pitcher,
            t.short_name          AS team,
            ps.home_runs_allowed  AS ps_hr,
            COALESCE(SUM(gp.home_runs_allowed), 0) AS gp_hr,
            COUNT(gp.id)          AS gp_rows
        FROM pitching_stats ps
        JOIN players p ON p.id = ps.player_id
        JOIN teams t   ON t.id = ps.team_id
        LEFT JOIN game_pitching gp
               ON gp.player_id = ps.player_id
              AND gp.team_id   = ps.team_id
        LEFT JOIN games g ON g.id = gp.game_id AND g.season = 2026
        WHERE ps.season = 2026
          AND ps.home_runs_allowed > 0
        GROUP BY ps.id, p.first_name, p.last_name, t.short_name, ps.home_runs_allowed
        HAVING ps.home_runs_allowed - COALESCE(SUM(gp.home_runs_allowed), 0) > 0
        ORDER BY ps.home_runs_allowed - COALESCE(SUM(gp.home_runs_allowed), 0) DESC
        LIMIT 15
        """
    )
    pitchers = cur.fetchall()
    print(f"{'pitcher':<25} {'team':<18} {'ps_hr':>6} {'gp_hr':>6} {'gap':>5} {'rows':>5}")
    print("-" * 70)
    for r in pitchers:
        gap = (r["ps_hr"] or 0) - (r["gp_hr"] or 0)
        print(
            f"{r['pitcher']:<25} {r['team']:<18} "
            f"{r['ps_hr']:>6} {r['gp_hr']:>6} {gap:>5} {r['gp_rows']:>5}"
        )

    print()
    print("=" * 70)
    print("3) Sample source_urls (one per team with a gap)")
    print("=" * 70)
    cur.execute(
        """
        SELECT DISTINCT ON (t.id)
            t.short_name,
            g.game_date,
            g.source_url
        FROM games g
        JOIN game_pitching gp ON gp.game_id = g.id
        JOIN teams t ON t.id = gp.team_id
        WHERE g.season = 2026 AND g.status = 'final'
          AND g.source_url IS NOT NULL
          AND t.short_name IN ('WOU','Oregon','Oregon St.','Gonzaga','UW',
                               'Seattle U','Linfield','George Fox','PLU',
                               'LCSC','UBC','Bushnell','MSUB')
        ORDER BY t.id, g.game_date DESC
        """
    )
    urls = cur.fetchall()
    for r in urls:
        print(f"  {r['short_name']:<15} {r['game_date']}  {r['source_url']}")


if __name__ == "__main__":
    main()
