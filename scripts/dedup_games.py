#!/usr/bin/env python3
"""
Deduplicate games table.

Many games were scraped from both teams' websites, creating duplicate
game records. This script finds duplicates by matching on:
  - game_date
  - the two team_ids involved (home/away can be swapped)
  - score (accounting for home/away swap)
  - game_number (for doubleheaders)

For each set of duplicates, it keeps the record with the most box score
data and merges game_pitching / game_batting entries onto the surviving
game, then deletes the duplicate.

Usage:
    cd pnw-baseball
    PYTHONPATH=backend python3 scripts/dedup_games.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from app.models.database import get_connection


def find_duplicates(cur):
    """Find duplicate game pairs."""
    # A duplicate is two games on the same date with the same two teams
    # and the same score (possibly with home/away flipped).
    cur.execute("""
        SELECT g1.id AS id1, g2.id AS id2,
               g1.game_date, g1.home_team_id AS g1_home, g1.away_team_id AS g1_away,
               g1.home_score AS g1_hscore, g1.away_score AS g1_ascore,
               g2.home_team_id AS g2_home, g2.away_team_id AS g2_away,
               g2.home_score AS g2_hscore, g2.away_score AS g2_ascore,
               g1.game_number, g2.game_number AS g2_game_number
        FROM games g1
        JOIN games g2 ON g1.id < g2.id
            AND g1.game_date = g2.game_date
            AND g1.season = g2.season
            AND COALESCE(g1.game_number, 1) = COALESCE(g2.game_number, 1)
        WHERE (
            -- Same orientation: same home/away teams, same score
            (g1.home_team_id = g2.home_team_id AND g1.away_team_id = g2.away_team_id
             AND g1.home_score = g2.home_score AND g1.away_score = g2.away_score)
            OR
            -- Flipped orientation: teams swapped, scores swapped
            (g1.home_team_id = g2.away_team_id AND g1.away_team_id = g2.home_team_id
             AND g1.home_score = g2.away_score AND g1.away_score = g2.home_score)
            OR
            -- One side has NULL team_id: match by name + score
            (g1.home_team_id IS NOT NULL AND g2.home_team_id IS NOT NULL
             AND g1.home_score IS NOT NULL AND g2.home_score IS NOT NULL
             AND (
                 (g1.home_team_id = g2.home_team_id AND g1.home_score = g2.home_score AND g1.away_score = g2.away_score)
                 OR (g1.home_team_id = g2.away_team_id AND g1.home_score = g2.away_score AND g1.away_score = g2.home_score)
                 OR (g1.away_team_id = g2.home_team_id AND g1.away_score = g2.home_score AND g1.home_score = g2.away_score)
                 OR (g1.away_team_id = g2.away_team_id AND g1.away_score = g2.away_score AND g1.home_score = g2.home_score)
             ))
        )
        ORDER BY g1.game_date, g1.id
    """)
    return cur.fetchall()


def merge_and_delete(cur, keep_id, delete_id):
    """Move box score data from delete_id game to keep_id, then delete."""
    # Re-assign game_pitching rows (avoid conflicts)
    cur.execute("""
        UPDATE game_pitching
        SET game_id = %s
        WHERE game_id = %s
          AND player_name NOT IN (
              SELECT player_name FROM game_pitching WHERE game_id = %s
          )
    """, (keep_id, delete_id, keep_id))
    moved_pitching = cur.rowcount

    # Re-assign game_batting rows (avoid conflicts)
    cur.execute("""
        UPDATE game_batting
        SET game_id = %s
        WHERE game_id = %s
          AND player_name NOT IN (
              SELECT player_name FROM game_batting WHERE game_id = %s
          )
    """, (keep_id, delete_id, keep_id))
    moved_batting = cur.rowcount

    # Delete remaining (conflicting) box score rows for the duplicate
    cur.execute("DELETE FROM game_pitching WHERE game_id = %s", (delete_id,))
    cur.execute("DELETE FROM game_batting WHERE game_id = %s", (delete_id,))

    # Delete the duplicate game
    cur.execute("DELETE FROM games WHERE id = %s", (delete_id,))

    return moved_pitching, moved_batting


def main():
    with get_connection() as conn:
        cur = conn.cursor()

        print("Finding duplicate games...")
        dupes = find_duplicates(cur)
        print(f"Found {len(dupes)} duplicate pairs\n")

        if not dupes:
            print("No duplicates found!")
            return

        # Show some examples
        print("Examples:")
        for d in dupes[:5]:
            print(f"  Game {d['id1']} vs {d['id2']} on {d['game_date']}: "
                  f"teams {d['g1_home']}v{d['g1_away']} ({d['g1_hscore']}-{d['g1_ascore']}) "
                  f"/ {d['g2_home']}v{d['g2_away']} ({d['g2_hscore']}-{d['g2_ascore']})")

        # For each pair, keep the one with more box score data
        merged = 0
        for d in dupes:
            id1, id2 = d['id1'], d['id2']

            # Count box score rows for each
            cur.execute("SELECT COUNT(*) as cnt FROM game_pitching WHERE game_id = %s", (id1,))
            count1 = cur.fetchone()["cnt"]
            cur.execute("SELECT COUNT(*) as cnt FROM game_pitching WHERE game_id = %s", (id2,))
            count2 = cur.fetchone()["cnt"]

            # Keep the one with more data
            if count1 >= count2:
                keep_id, delete_id = id1, id2
            else:
                keep_id, delete_id = id2, id1

            mp, mb = merge_and_delete(cur, keep_id, delete_id)
            merged += 1

        print(f"\nMerged {merged} duplicate game pairs")

        # Now recount total games
        cur.execute("SELECT COUNT(*) as cnt FROM games")
        total = cur.fetchone()["cnt"]
        print(f"Total games remaining: {total}")

        conn.commit()
        print("Done! Changes committed.")


if __name__ == "__main__":
    main()
