#!/usr/bin/env python3
"""
Diagnose self-play game records and suspicious team_id 5720.

Pass 2 of dedup found orphan games pointing to "valid" counterparts where
home_team_id == away_team_id — which is impossible in real baseball. This
script inspects:
  1) every self-play game (all seasons)
  2) every team_id that appears in self-play games
  3) details on team_id 5720
  4) what batting/pitching rows are hanging off these games

Usage (on server):
    cd /opt/pnw-baseball
    PYTHONPATH=backend python3 scripts/diagnose_self_play.py
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
    print("1) All self-play games (home_team_id == away_team_id)")
    print("=" * 70)
    cur.execute(
        """
        SELECT g.id, g.season, g.game_date, g.home_team_id, g.away_team_id,
               g.home_score, g.away_score, g.status, g.source_url,
               t.short_name, t.school_name
        FROM games g
        LEFT JOIN teams t ON t.id = g.home_team_id
        WHERE g.home_team_id IS NOT NULL
          AND g.home_team_id = g.away_team_id
        ORDER BY g.season DESC, g.game_date DESC
        """
    )
    rows = cur.fetchall()
    print(f"Found {len(rows)} self-play games")
    print()
    for r in rows:
        print(f"  gid={r['id']:>5}  {r['game_date']}  season={r['season']}  "
              f"team_id={r['home_team_id']:>5} ({r['short_name']})  "
              f"score {r['home_score']}-{r['away_score']}  {r['status']}")
        if r["source_url"]:
            print(f"         url: {r['source_url']}")
    print()

    print("=" * 70)
    print("2) Unique team_ids appearing in self-play games")
    print("=" * 70)
    cur.execute(
        """
        SELECT g.home_team_id,
               t.short_name,
               t.school_name,
               t.conference_id,
               COUNT(*) AS self_play_games
        FROM games g
        LEFT JOIN teams t ON t.id = g.home_team_id
        WHERE g.home_team_id IS NOT NULL
          AND g.home_team_id = g.away_team_id
        GROUP BY g.home_team_id, t.short_name, t.school_name, t.conference_id
        ORDER BY self_play_games DESC
        """
    )
    teams = cur.fetchall()
    print(f"{'team_id':>8}  {'short_name':<20} {'school_name':<30} {'conf':>5} {'games':>6}")
    print("-" * 80)
    for r in teams:
        sn = r["short_name"] or "(orphan — no team row)"
        scn = r["school_name"] or ""
        conf = r["conference_id"] or "-"
        print(f"{r['home_team_id']:>8}  {sn:<20} {scn:<30} {conf!s:>5} {r['self_play_games']:>6}")
    print()

    print("=" * 70)
    print("3) team_id 5720 detail")
    print("=" * 70)
    cur.execute(
        """
        SELECT t.id, t.short_name, t.school_name, t.conference_id,
               c.name AS conf_name, c.division_id
        FROM teams t
        LEFT JOIN conferences c ON c.id = t.conference_id
        WHERE t.id = 5720
        """
    )
    row = cur.fetchone()
    if row:
        print(f"  id={row['id']}  short={row['short_name']!r}  school={row['school_name']!r}")
        print(f"  conference_id={row['conference_id']}  conf_name={row['conf_name']!r}  division={row['division_id']!r}")
    else:
        print("  No teams row with id=5720 (orphan id in use by games/batting/pitching)")
    print()

    cur.execute("SELECT COUNT(*) AS cnt FROM games WHERE home_team_id = 5720 OR away_team_id = 5720")
    print(f"  games referencing 5720: {cur.fetchone()['cnt']}")
    cur.execute("SELECT COUNT(*) AS cnt FROM game_batting WHERE team_id = 5720")
    print(f"  game_batting rows with team_id=5720: {cur.fetchone()['cnt']}")
    cur.execute("SELECT COUNT(*) AS cnt FROM game_pitching WHERE team_id = 5720")
    print(f"  game_pitching rows with team_id=5720: {cur.fetchone()['cnt']}")
    cur.execute("SELECT COUNT(*) AS cnt FROM players WHERE team_id = 5720")
    print(f"  players with team_id=5720: {cur.fetchone()['cnt']}")
    cur.execute("SELECT COUNT(*) AS cnt FROM batting_stats WHERE team_id = 5720")
    print(f"  batting_stats rows with team_id=5720: {cur.fetchone()['cnt']}")
    cur.execute("SELECT COUNT(*) AS cnt FROM pitching_stats WHERE team_id = 5720")
    print(f"  pitching_stats rows with team_id=5720: {cur.fetchone()['cnt']}")
    print()

    print("=" * 70)
    print("4) Rows hanging off self-play games")
    print("=" * 70)
    if rows:
        sp_ids = [r["id"] for r in rows]
        cur.execute(
            "SELECT COUNT(*) AS cnt FROM game_batting WHERE game_id = ANY(%s)",
            (sp_ids,),
        )
        print(f"  game_batting rows on self-play games: {cur.fetchone()['cnt']}")
        cur.execute(
            "SELECT COUNT(*) AS cnt FROM game_pitching WHERE game_id = ANY(%s)",
            (sp_ids,),
        )
        print(f"  game_pitching rows on self-play games: {cur.fetchone()['cnt']}")
    else:
        print("  (no self-play games; nothing to count)")
    print()

    print("=" * 70)
    print("5) Highest team_ids in use (sanity check for phantom ids)")
    print("=" * 70)
    cur.execute(
        """
        SELECT id, short_name, school_name, conference_id
        FROM teams
        ORDER BY id DESC
        LIMIT 20
        """
    )
    for r in cur.fetchall():
        conf = r["conference_id"] or "-"
        print(f"  id={r['id']:>6}  {r['short_name']!s:<25} {r['school_name']!s:<35} conf={conf}")


if __name__ == "__main__":
    main()
