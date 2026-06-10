#!/usr/bin/env python3
"""
tag_ccc_playoffs.py
===================

Re-applies the "playoffs" tag to any CCC game on or after the playoff
cutoff date. Idempotent — safe to run on every scrape.

Rule (per coach decision 2026-04-30):
    Any game where AT LEAST ONE team is in the CCC conference and
    game_date >= cutoff is tagged is_postseason=TRUE,
    is_conference_game=FALSE. Covers the CCC tournament + NAIA
    regionals where CCC teams travel to play non-CCC opponents.

Add this to daily_update.sh AFTER the box score scrapes so any games
that just landed in the DB inherit the postseason flag automatically.

Usage (server):
    cd /opt/pnw-baseball
    PYTHONPATH=backend python3 scripts/tag_ccc_playoffs.py

Or change the cutoff:
    PYTHONPATH=backend python3 scripts/tag_ccc_playoffs.py --cutoff 2026-05-01
"""

import argparse
import sys
import os
from datetime import date

# Make `app` importable when run from the project root.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection


# CCC tournament starts 2026-05-01. Anything from this date onward
# involving a CCC team is treated as a playoff game.
DEFAULT_CUTOFF = "2026-05-01"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cutoff", default=DEFAULT_CUTOFF,
                    help=f"ISO date (YYYY-MM-DD) — games on/after this "
                         f"date involving a CCC team are tagged. "
                         f"Default: {DEFAULT_CUTOFF}")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print which games would be tagged without committing")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()
        # Find the games we'd tag — for the dry-run output and so we
        # can report nicely after the update.
        cur.execute("""
            SELECT g.id, g.game_date,
                   ht.short_name AS home_short,
                   at.short_name AS away_short,
                   g.is_postseason, g.is_conference_game
            FROM games g
            JOIN teams ht ON ht.id = g.home_team_id
            JOIN teams at ON at.id = g.away_team_id
            WHERE g.game_date >= %s
              AND (
                g.home_team_id IN (
                  SELECT id FROM teams WHERE conference_id = (
                    SELECT id FROM conferences WHERE abbreviation = 'CCC'
                  )
                )
                OR g.away_team_id IN (
                  SELECT id FROM teams WHERE conference_id = (
                    SELECT id FROM conferences WHERE abbreviation = 'CCC'
                  )
                )
              )
              AND (g.is_postseason IS NOT TRUE OR g.is_conference_game IS NOT FALSE)
            ORDER BY g.game_date, g.id
        """, (args.cutoff,))
        candidates = list(cur.fetchall())

        if not candidates:
            print(f"No CCC games on/after {args.cutoff} need tagging. (Nothing changed.)")
            return

        print(f"Tagging {len(candidates)} CCC playoff game(s) (cutoff: {args.cutoff}):")
        for r in candidates[:20]:
            print(f"  game_id={r['id']} {r['game_date']} {r['away_short']} @ {r['home_short']}")
        if len(candidates) > 20:
            print(f"  ... and {len(candidates) - 20} more")

        if args.dry_run:
            print("\n[--dry-run] No changes committed.")
            return

        cur.execute("""
            UPDATE games
            SET is_postseason = TRUE, is_conference_game = FALSE
            WHERE game_date >= %s
              AND (
                home_team_id IN (
                  SELECT id FROM teams WHERE conference_id = (
                    SELECT id FROM conferences WHERE abbreviation = 'CCC'
                  )
                )
                OR away_team_id IN (
                  SELECT id FROM teams WHERE conference_id = (
                    SELECT id FROM conferences WHERE abbreviation = 'CCC'
                  )
                )
              )
        """, (args.cutoff,))
        conn.commit()
        print(f"\nUpdated {cur.rowcount} game(s).")


if __name__ == "__main__":
    main()
