#!/usr/bin/env python3
"""
Audit the Phase A state derivation: for every 2026 game with events,
compare SUM(runs_on_play) against games.home_score + games.away_score.

Usage:
    PYTHONPATH=backend python3 scripts/audit_pbp_state.py
    PYTHONPATH=backend python3 scripts/audit_pbp_state.py --bad-only
    PYTHONPATH=backend python3 scripts/audit_pbp_state.py --bad-only --limit 20
"""

import argparse
import os
from pathlib import Path

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--bad-only", action="store_true",
                    help="Only print games where derived != actual")
    ap.add_argument("--limit", type=int, default=50,
                    help="Max number of bad rows to print")
    args = ap.parse_args()

    url = os.environ["DATABASE_URL"]
    if "sslmode" not in url:
        url += ("&" if "?" in url else "?") + "sslmode=require"

    conn = psycopg2.connect(url)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute(
        """
        SELECT
            g.id,
            g.game_date,
            g.home_team_name,
            g.away_team_name,
            (g.home_score + g.away_score)                                AS actual,
            (SELECT SUM(runs_on_play) FROM game_events WHERE game_id = g.id) AS derived,
            (SELECT COUNT(*) FROM game_events
              WHERE game_id = g.id
                AND result_type IN ('wild_pitch','passed_ball','balk',
                                    'stolen_base','caught_stealing',
                                    'pickoff','runner_other'))         AS subev_count,
            (SELECT MAX(state_derived_at) FROM game_events
              WHERE game_id = g.id)                                     AS derived_at
        FROM games g
        WHERE g.season = %s
          AND g.status = 'final'
          AND EXISTS (SELECT 1 FROM game_events WHERE game_id = g.id)
        ORDER BY g.game_date, g.id
        """,
        (args.season,),
    )
    rows = cur.fetchall()

    n_total = len(rows)
    n_ok = sum(1 for r in rows if r["actual"] == (r["derived"] or 0))
    n_bad = n_total - n_ok
    n_unenriched = sum(1 for r in rows if r["derived_at"] is None)
    n_with_subevs = sum(1 for r in rows if (r["subev_count"] or 0) > 0)

    print(f"Season {args.season}")
    print(f"  Games with events:    {n_total}")
    print(f"  Audit OK:             {n_ok}  ({n_ok / max(n_total,1):.1%})")
    print(f"  Audit MISMATCH:       {n_bad}")
    print(f"  Not yet state-derived:{n_unenriched}")
    print(f"  Have sub-event rows:  {n_with_subevs}")
    print()

    if args.bad_only and n_bad:
        print(f"First {min(args.limit, n_bad)} mismatched games:")
        printed = 0
        for r in rows:
            actual = r["actual"]
            derived = r["derived"] or 0
            if actual == derived:
                continue
            gap = actual - derived
            sub = r["subev_count"] or 0
            tag = " (no derive)" if r["derived_at"] is None else ""
            print(f"  game {r['id']:5d} {r['game_date']} "
                  f"{(r['away_team_name'] or '')[:18]:18s} @ "
                  f"{(r['home_team_name'] or '')[:18]:18s}  "
                  f"actual={actual:3d} derived={derived:3d} gap={gap:+d} "
                  f"subevs={sub}{tag}")
            printed += 1
            if printed >= args.limit:
                break

    conn.close()


if __name__ == "__main__":
    main()
