#!/usr/bin/env python3
"""
Pull every scraper-metadata-like column on the `games` table for the 7
known-flipped C of I games, side-by-side with the remaining 37 correct
C of I games. We look for: what distinguishes the 7 from the 37?

Run from backend dir:
    PYTHONPATH=backend python3 scripts/inspect_flipped_games_metadata.py
"""

import sys
import os
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection

FLIPPED_IDS = [831, 936, 974, 1197, 1324, 1325, 1413]
COI_TEAM_ID = 21


def main():
    with get_connection() as conn:
        cur = conn.cursor()

        # Dump every column on games so we can see what metadata we have.
        cur.execute("""
            SELECT column_name, data_type FROM information_schema.columns
            WHERE table_name = 'games'
            ORDER BY ordinal_position
        """)
        cols = [dict(r) for r in cur.fetchall()]
        print("games table columns:")
        for c in cols:
            print(f"  {c['column_name']:30s}  {c['data_type']}")
        print()

        # Pull every column we have for all 44 C of I games.
        cur.execute("""
            SELECT * FROM games
            WHERE season = 2026
              AND status = 'final'
              AND (home_team_id = %s OR away_team_id = %s)
              AND home_score IS NOT NULL
              AND away_score IS NOT NULL
            ORDER BY game_date, id
        """, (COI_TEAM_ID, COI_TEAM_ID))
        all_games = [dict(r) for r in cur.fetchall()]

        flipped = [g for g in all_games if g["id"] in FLIPPED_IDS]
        clean = [g for g in all_games if g["id"] not in FLIPPED_IDS]

        print(f"Flipped: {len(flipped)}   Clean: {len(clean)}   "
              f"Total: {len(all_games)}")
        print()

        # For each column, compare distributions between flipped and clean.
        print("Column-by-column comparison "
              "(values shown as distinct-value counts):")
        col_names = [c["column_name"] for c in cols]
        for col in col_names:
            fvals = [str(g.get(col)) for g in flipped]
            cvals = [str(g.get(col)) for g in clean]
            fu = Counter(fvals)
            cu = Counter(cvals)
            # Skip columns we expect to vary per-game
            if col in ("id", "game_date", "home_score", "away_score",
                       "source_url"):
                continue
            # If all-flipped share a value that no clean game shares, flag it.
            flipped_only = set(fu.keys()) - set(cu.keys())
            clean_only = set(cu.keys()) - set(fu.keys())
            if flipped_only or clean_only:
                print(f"  {col}:")
                print(f"    flipped distribution: {dict(fu)}")
                print(f"    clean distribution:   {dict(cu)}")
                print()

        # Print per-game URL for flipped vs a matched-opponent clean game.
        print()
        print("Flipped games (with source URL):")
        for g in flipped:
            print(f"  id={g['id']:>5}  {g['game_date']}  "
                  f"url={g.get('source_url')}")
        print()

        # For each flipped game, find a same-opponent clean game for contrast.
        print("Same-opponent CLEAN games for contrast:")
        for f in flipped:
            opp_id = (f["away_team_id"] if f["home_team_id"] == COI_TEAM_ID
                      else f["home_team_id"])
            opp_clean = [g for g in clean
                         if opp_id in (g["home_team_id"], g["away_team_id"])]
            if opp_clean:
                g = opp_clean[0]
                print(f"  flipped {f['id']} ({f['game_date']}) "
                      f"vs opp_id={opp_id} -> clean {g['id']} "
                      f"({g['game_date']}): url={g.get('source_url')}")
            else:
                print(f"  flipped {f['id']} -- no same-opponent clean game")


if __name__ == "__main__":
    main()
