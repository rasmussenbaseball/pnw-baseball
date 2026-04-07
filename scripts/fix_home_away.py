#!/usr/bin/env python3
"""
Fix home/away assignments in the games table.

The box score scraper sometimes fails to detect whether a game was home or
away, defaulting to "home" for the scraping team.  This script re-checks
every game by looking at the opponent text stored in the schedule data and
swaps home/away where it was wrong.

Strategy:
  1. For each game where our tracked team is home_team_id, check if the
     away_team_name starts with "at " or "@ " — that would mean the scraper
     had the info but didn't use it.
  2. For games scraped from BOTH teams, if team A's record says A is home
     and team B's record also says B is home for the same game, pick the
     one with the correct structure (the away team's scrape is more
     reliable since they explicitly had "at" in their schedule).
  3. As a fallback, use the source_url field: gamelog:// URLs encode the
     opponent name which may start with "at".

Usage:
    cd /opt/pnw-baseball
    PYTHONPATH=backend python3 scripts/fix_home_away.py
"""
import sys
import re
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
from app.models.database import get_connection


def fix_home_away():
    with get_connection() as conn:
        cur = conn.cursor()

        # ── Step 1: Fix games where away_team_name reveals it was a road game ──
        # If home_team_name = "Bushnell" and away_team_name = "at LCSC" or
        # similar, the home/away is swapped.  But typically the "at" prefix
        # gets stripped during scraping.  So this is a long shot.
        print("Step 1: Checking for 'at' prefix in team names...")
        cur.execute("""
            UPDATE games
            SET home_team_id = away_team_id,
                away_team_id = home_team_id,
                home_team_name = away_team_name,
                away_team_name = home_team_name,
                home_score = away_score,
                away_score = home_score,
                home_hits = away_hits,
                away_hits = home_hits,
                home_errors = away_errors,
                away_errors = home_errors,
                home_line_score = away_line_score,
                away_line_score = home_line_score
            WHERE home_team_name ILIKE 'at %' OR home_team_name ILIKE '@ %'
        """)
        print(f"  Fixed {cur.rowcount} games with 'at' prefix in home_team_name")

        # ── Step 2: Fix using source_url gamelog:// format ──
        # gamelog:// URLs look like: gamelog://Bushnell/2026-02-06/at The Master's/1
        # If the opponent portion starts with "at ", the team was away.
        print("\nStep 2: Checking gamelog:// source URLs for 'at' prefix...")
        cur.execute("""
            SELECT id, source_url, home_team_id, away_team_id,
                   home_team_name, away_team_name,
                   home_score, away_score,
                   home_hits, away_hits,
                   home_errors, away_errors,
                   home_line_score, away_line_score
            FROM games
            WHERE source_url LIKE 'gamelog://%'
        """)
        swap_count = 0
        for row in cur.fetchall():
            url = row["source_url"]
            # Parse: gamelog://TeamShort/date/opponent/gamenum
            parts = url.replace("gamelog://", "").split("/")
            if len(parts) >= 3:
                opp_part = parts[2]
                if opp_part.lower().startswith(("at ", "@ ")):
                    # This was an away game but the team is listed as home.
                    # Swap home and away.
                    cur.execute("""
                        UPDATE games
                        SET home_team_id = away_team_id,
                            away_team_id = home_team_id,
                            home_team_name = away_team_name,
                            away_team_name = home_team_name,
                            home_score = away_score,
                            away_score = home_score,
                            home_hits = away_hits,
                            away_hits = home_hits,
                            home_errors = away_errors,
                            away_errors = home_errors,
                            home_line_score = away_line_score,
                            away_line_score = home_line_score
                        WHERE id = %s
                    """, (row["id"],))
                    swap_count += 1
        print(f"  Swapped {swap_count} games that had 'at' in source URL")

        # ── Step 3: Fix using duplicate game records ──
        # When the same game was scraped from both teams' sites, we have
        # two game records.  If both claim to be "home", the one from the
        # AWAY team's perspective is more reliable (they explicitly had
        # "at" in their schedule).  Find these duplicates and keep the
        # correct one's home/away assignment.
        print("\nStep 3: Checking duplicate game records for conflicting home/away...")
        cur.execute("""
            SELECT g1.id as g1_id, g2.id as g2_id,
                   g1.home_team_id as g1_home, g1.away_team_id as g1_away,
                   g2.home_team_id as g2_home, g2.away_team_id as g2_away,
                   g1.home_team_name as g1_home_name, g1.away_team_name as g1_away_name,
                   g2.home_team_name as g2_home_name, g2.away_team_name as g2_away_name,
                   g1.home_score as g1_hscore, g1.away_score as g1_ascore,
                   g2.home_score as g2_hscore, g2.away_score as g2_ascore
            FROM games g1
            JOIN games g2 ON g1.game_date = g2.game_date
                         AND g1.game_number = g2.game_number
                         AND g1.id < g2.id
            WHERE g1.home_team_id IS NOT NULL
              AND g2.home_team_id IS NOT NULL
              AND g1.home_team_id = g2.away_team_id
              AND g1.away_team_id = g2.home_team_id
              AND g1.season = 2026
        """)
        dup_rows = cur.fetchall()
        print(f"  Found {len(dup_rows)} correctly matched duplicate pairs (already consistent)")

        # Now find pairs where BOTH claim to be home for different teams
        cur.execute("""
            SELECT g1.id as g1_id, g2.id as g2_id,
                   g1.home_team_id as g1_home, g1.away_team_id as g1_away,
                   g2.home_team_id as g2_home, g2.away_team_id as g2_away,
                   g1.home_score as g1_hscore, g1.away_score as g1_ascore,
                   g2.home_score as g2_hscore, g2.away_score as g2_ascore
            FROM games g1
            JOIN games g2 ON g1.game_date = g2.game_date
                         AND g1.game_number = g2.game_number
                         AND g1.id < g2.id
            WHERE g1.home_team_id IS NOT NULL
              AND g2.home_team_id IS NOT NULL
              AND (
                  -- Both claim different teams are home, and the away sides
                  -- suggest the same matchup
                  (g1.home_team_id = g2.home_team_id AND g1.away_team_id = g2.away_team_id)
                  OR
                  -- Both say THEY are home (g1.home = A, g2.home = B, but
                  -- neither has the other as away — both default to home)
                  (g1.home_team_id != g2.home_team_id
                   AND g1.away_team_id IS NULL AND g2.away_team_id IS NULL
                   AND (g1.home_team_id = g2.away_team_id OR g2.home_team_id = g1.away_team_id
                        OR (g1.home_score = g2.away_score AND g1.away_score = g2.home_score)))
              )
              AND g1.season = 2026
            LIMIT 50
        """)
        conflict_rows = cur.fetchall()
        print(f"  Found {len(conflict_rows)} conflicting duplicate pairs")
        for r in conflict_rows[:5]:
            print(f"    Game {r['g1_id']} (home={r['g1_home']}) vs Game {r['g2_id']} (home={r['g2_home']})")

        # ── Step 4: Summary ──
        print("\n=== Summary ===")
        cur.execute("""
            SELECT t.short_name, COUNT(*) as home_games
            FROM games g
            JOIN teams t ON g.home_team_id = t.id
            WHERE g.season = 2026
            GROUP BY t.short_name
            ORDER BY home_games DESC
            LIMIT 20
        """)
        print("Teams with most 'home' games (suspicious if > 70% of total):")
        for r in cur.fetchall():
            print(f"  {r['short_name']}: {r['home_games']} home games")

        conn.commit()
        print("\nDone! Changes committed.")


if __name__ == "__main__":
    fix_home_away()
