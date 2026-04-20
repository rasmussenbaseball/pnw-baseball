#!/usr/bin/env python3
"""
Diagnose remaining NULL team_id rows in game_batting and game_pitching.

After the self-play backfill ran, 3209 + 917 rows still have team_id IS NULL.
These aren't from self-play games (we fixed those). Figure out what kind of
games these orphan rows are hanging off so we know whether they're in scope
for task #42 or a separate follow-up.

Usage (on server):
    cd /opt/pnw-baseball
    PYTHONPATH=backend python3 scripts/diagnose_null_orphans.py
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
    print("1) NULL team_id rows in game_batting — distribution by season")
    print("=" * 70)
    cur.execute(
        """
        SELECT g.season,
               COUNT(DISTINCT g.id) AS games,
               COUNT(*) AS null_rows
        FROM game_batting gb
        JOIN games g ON g.id = gb.game_id
        WHERE gb.team_id IS NULL
        GROUP BY g.season
        ORDER BY g.season DESC
        """
    )
    print(" season  games  null_rows")
    for r in cur.fetchall():
        print(f"  {str(r['season']):<6} {r['games']:>5}  {r['null_rows']:>6}")

    print()
    print("=" * 70)
    print("2) What kind of games do the orphan rows hang off of?")
    print("=" * 70)
    cur.execute(
        """
        SELECT
          CASE
            WHEN g.home_team_id = g.away_team_id THEN 'self-play'
            WHEN g.away_team_id IS NULL THEN 'no-away'
            WHEN g.home_team_id IS NULL THEN 'no-home'
            ELSE 'resolved'
          END AS kind,
          COUNT(DISTINCT g.id) AS games,
          COUNT(*) AS null_rows
        FROM game_batting gb
        JOIN games g ON g.id = gb.game_id
        WHERE gb.team_id IS NULL
        GROUP BY kind
        ORDER BY null_rows DESC
        """
    )
    print(" kind          games  null_rows")
    for r in cur.fetchall():
        print(f"  {r['kind']:<12} {r['games']:>5}  {r['null_rows']:>6}")

    print()
    print("=" * 70)
    print("3) Sample 15 games with remaining NULL batting rows (most recent)")
    print("=" * 70)
    cur.execute(
        """
        SELECT g.id, g.game_date, g.season,
               g.home_team_id, g.away_team_id,
               ht.short_name AS home, at.short_name AS away,
               COUNT(*) AS null_rows,
               g.source_url
        FROM game_batting gb
        JOIN games g ON g.id = gb.game_id
        LEFT JOIN teams ht ON ht.id = g.home_team_id
        LEFT JOIN teams at ON at.id = g.away_team_id
        WHERE gb.team_id IS NULL
        GROUP BY g.id, g.game_date, g.season, g.home_team_id, g.away_team_id,
                 ht.short_name, at.short_name, g.source_url
        ORDER BY g.game_date DESC
        LIMIT 15
        """
    )
    for r in cur.fetchall():
        home = r["home"] or "?"
        away = r["away"] or "?"
        print(
            f"  gid={r['id']:<5} {r['game_date']} s={r['season']} "
            f"home={r['home_team_id']}({home}) away={r['away_team_id']}({away}) "
            f"null={r['null_rows']}"
        )
        print(f"      {r['source_url']}")

    print()
    print("=" * 70)
    print("4) For 'resolved' games with NULL rows: are rows from a single team?")
    print("=" * 70)
    # If home team has real rows and away team has NULL, that's a partial
    # scrape — we could attribute the NULLs to the away team.
    cur.execute(
        """
        WITH null_games AS (
          SELECT DISTINCT g.id, g.home_team_id, g.away_team_id
          FROM game_batting gb
          JOIN games g ON g.id = gb.game_id
          WHERE gb.team_id IS NULL
            AND g.home_team_id IS NOT NULL
            AND g.away_team_id IS NOT NULL
            AND g.home_team_id <> g.away_team_id
        )
        SELECT ng.id, ng.home_team_id, ng.away_team_id,
               COUNT(*) FILTER (WHERE gb.team_id = ng.home_team_id) AS home_rows,
               COUNT(*) FILTER (WHERE gb.team_id = ng.away_team_id) AS away_rows,
               COUNT(*) FILTER (WHERE gb.team_id IS NULL) AS null_rows
        FROM null_games ng
        JOIN game_batting gb ON gb.game_id = ng.id
        GROUP BY ng.id, ng.home_team_id, ng.away_team_id
        ORDER BY ng.id DESC
        LIMIT 15
        """
    )
    print("  gid    home_tid  away_tid  home_rows  away_rows  null_rows")
    for r in cur.fetchall():
        print(
            f"  {r['id']:<6} {r['home_team_id']:<9} {r['away_team_id']:<9} "
            f"{r['home_rows']:<10} {r['away_rows']:<10} {r['null_rows']}"
        )

    print()
    print("=" * 70)
    print("5) Counts in game_pitching (same shape)")
    print("=" * 70)
    cur.execute(
        """
        SELECT
          CASE
            WHEN g.home_team_id = g.away_team_id THEN 'self-play'
            WHEN g.away_team_id IS NULL THEN 'no-away'
            WHEN g.home_team_id IS NULL THEN 'no-home'
            ELSE 'resolved'
          END AS kind,
          COUNT(DISTINCT g.id) AS games,
          COUNT(*) AS null_rows
        FROM game_pitching gp
        JOIN games g ON g.id = gp.game_id
        WHERE gp.team_id IS NULL
        GROUP BY kind
        ORDER BY null_rows DESC
        """
    )
    print(" kind          games  null_rows")
    for r in cur.fetchall():
        print(f"  {r['kind']:<12} {r['games']:>5}  {r['null_rows']:>6}")


if __name__ == "__main__":
    main()
