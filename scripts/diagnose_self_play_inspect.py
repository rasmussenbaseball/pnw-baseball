#!/usr/bin/env python3
"""
Inspect what batter/pitcher rows are attached to self-play games.

The question: when the scraper couldn't resolve an opponent and fell back
to home_team_id == away_team_id, did it also write the OPPONENT's lineup
into game_batting/game_pitching with the scraping team's team_id?

If yes, those opponent players are polluting our PNW team/player stats.
If no, only half a box score got written and the self-play row is just
a cosmetic ghost we can safely delete.

Usage (on server):
    cd /opt/pnw-baseball
    PYTHONPATH=backend python3 scripts/diagnose_self_play_inspect.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
from app.models.database import get_connection


# A few representative self-play games to inspect.
SAMPLES = [
    (1108, "UBC", "Nelson Univ AZ", "3-27 UBC loss"),
    (700,  "WOU", "Cal State Monterey Bay", "10-9 WOU 3-22"),
    (1146, "Gonzaga", "Indiana State", "16-23 GON 3-15"),
    (1426, "UW", "UNLV?", "2-18 UW 3-31"),
    (1108, "UBC", "Nelson", "dup check"),
]


def main():
    with get_connection() as conn:
        cur = conn.cursor()
        _run(cur)


def _run(cur):
    print("Batter/pitcher rows on sample self-play games")
    print("=" * 80)

    seen = set()
    for gid, scraping_team, opponent_guess, note in SAMPLES:
        if gid in seen:
            continue
        seen.add(gid)

        cur.execute(
            """
            SELECT g.id, g.game_date, g.home_team_id, g.away_team_id,
                   g.home_score, g.away_score, g.source_url,
                   t.short_name
            FROM games g
            LEFT JOIN teams t ON t.id = g.home_team_id
            WHERE g.id = %s
            """,
            (gid,),
        )
        g = cur.fetchone()
        if not g:
            print(f"\n  gid={gid}  (missing)")
            continue

        print(f"\n{'=' * 80}")
        print(f"gid={gid}  {g['game_date']}  scraping_team={scraping_team}  opp_guess={opponent_guess}")
        print(f"  note: {note}")
        print(f"  home_team_id={g['home_team_id']} ({g['short_name']})  "
              f"away_team_id={g['away_team_id']}  score {g['home_score']}-{g['away_score']}")
        print(f"  url: {g['source_url']}")

        cur.execute(
            """
            SELECT team_id, COUNT(*) AS rows
            FROM game_batting
            WHERE game_id = %s
            GROUP BY team_id
            """,
            (gid,),
        )
        print(f"  game_batting team_id breakdown:")
        for r in cur.fetchall():
            print(f"    team_id={r['team_id']}  rows={r['rows']}")

        cur.execute(
            """
            SELECT player_name, at_bats, hits, home_runs, runs
            FROM game_batting
            WHERE game_id = %s
            ORDER BY batting_order NULLS LAST, at_bats DESC
            LIMIT 25
            """,
            (gid,),
        )
        print(f"  first 25 batters on this game (alphabetical):")
        for r in cur.fetchall():
            print(f"    {r['player_name']:<30} AB={r['at_bats']} H={r['hits']} HR={r['home_runs']} R={r['runs']}")

        cur.execute(
            """
            SELECT team_id, COUNT(*) AS rows
            FROM game_pitching
            WHERE game_id = %s
            GROUP BY team_id
            """,
            (gid,),
        )
        print(f"  game_pitching team_id breakdown:")
        for r in cur.fetchall():
            print(f"    team_id={r['team_id']}  rows={r['rows']}")

        cur.execute(
            """
            SELECT player_name, innings_pitched, earned_runs, strikeouts, decision
            FROM game_pitching
            WHERE game_id = %s
            ORDER BY pitch_order
            """,
            (gid,),
        )
        print(f"  pitchers on this game:")
        for r in cur.fetchall():
            print(f"    {r['player_name']:<30} IP={r['innings_pitched']} ER={r['earned_runs']} K={r['strikeouts']} dec={r['decision']}")


if __name__ == "__main__":
    main()
