#!/usr/bin/env python3
"""
Fix home/away assignments in the games table by re-reading schedule pages.

The box score scraper sometimes fails to detect whether a game was home or
away, defaulting to "home" for the scraping team.  This script re-fetches
each team's schedule page, extracts the correct home/away flags, and swaps
the games table where it was wrong.

Usage:
    cd /opt/pnw-baseball
    PYTHONPATH=backend python3 scripts/fix_home_away.py
"""
import sys
import re
import logging
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from app.models.database import get_connection

# Import schedule parsing functions from scrape_boxscores
from scrape_boxscores import (
    D1_TEAMS, D2_TEAMS, D3_TEAMS, NAIA_TEAMS, NWAC_TEAMS,
    NWAC_TEAM_SLUGS,
    fetch_page,
    parse_sidearm_schedule,
    parse_presto_schedule,
    build_sidearm_schedule_url,
    build_presto_schedule_url,
    get_team_id_by_name,
)

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

SEASON = 2026


def fetch_team_schedule(db_short, team_config):
    """Fetch and parse a team's schedule page. Returns list of game dicts."""
    base_url, sport, platform = team_config
    is_nwac = db_short in NWAC_TEAM_SLUGS

    if platform == "presto":
        if is_nwac:
            slug = NWAC_TEAM_SLUGS[db_short]
            presto_season = f"{SEASON - 1}-{str(SEASON)[2:]}"
            url = build_presto_schedule_url(base_url, sport, slug, presto_season)
        elif db_short == "Willamette":
            presto_season = f"{SEASON - 1}-{str(SEASON)[2:]}"
            url = build_presto_schedule_url(base_url, sport, "willamette", presto_season)
        else:
            return []
        html = fetch_page(url, use_nwac=is_nwac)
        return parse_presto_schedule(html, base_url, SEASON) if html else []
    else:
        url = build_sidearm_schedule_url(base_url, sport, SEASON)
        html = fetch_page(url)
        if not html:
            url = f"{base_url}/sports/{sport}/schedule"
            html = fetch_page(url)
        return parse_sidearm_schedule(html, base_url, SEASON) if html else []


def fix_home_away():
    # Combine all team configs (skip NWAC for now — WAF issues from server)
    all_teams = {}
    all_teams.update(D1_TEAMS)
    all_teams.update(D2_TEAMS)
    all_teams.update(D3_TEAMS)
    all_teams.update(NAIA_TEAMS)
    # Skip NWAC — server can't reach nwacsports.com due to WAF

    total_swapped = 0
    total_checked = 0

    for db_short, team_config in all_teams.items():
        logger.info(f"\n{'='*50}")
        logger.info(f"Processing: {db_short}")

        # Get team_id from DB
        with get_connection() as conn:
            cur = conn.cursor()
            team_id = get_team_id_by_name(cur, db_short)
            if not team_id:
                logger.warning(f"  Team not found in DB, skipping")
                continue

        # Fetch schedule
        schedule = fetch_team_schedule(db_short, team_config)
        if not schedule:
            logger.warning(f"  No schedule data, skipping")
            continue

        logger.info(f"  Found {len(schedule)} games on schedule")

        swapped = 0
        for game in schedule:
            game_date = game.get("date")
            if not game_date:
                continue

            # Check if is_away was detected
            if "is_away" not in game:
                # Try text-based fallback
                opp = game.get("opponent", "")
                opp_lower = opp.lower()
                if opp_lower.startswith(("at ", "@ ")):
                    is_away = True
                elif opp_lower.startswith("vs"):
                    is_away = False
                else:
                    continue  # Can't determine, skip
            else:
                is_away = game["is_away"]

            if not is_away:
                continue  # Home game — nothing to fix

            # This is an AWAY game for this team.
            # Check if the DB has this team as home_team_id (which would be wrong).
            game_number = game.get("game_number", 1)
            team_score = game.get("team_score")
            opp_score = game.get("opp_score")

            with get_connection() as conn:
                cur = conn.cursor()

                # Find the game in the DB: match by date + team as home + scores
                cur.execute("""
                    SELECT id, home_team_id, away_team_id,
                           home_score, away_score,
                           home_team_name, away_team_name
                    FROM games
                    WHERE game_date = %s
                      AND game_number = %s
                      AND home_team_id = %s
                      AND season = %s
                """, (game_date, game_number, team_id, SEASON))
                rows = cur.fetchall()

                if not rows:
                    continue  # Not found as home, might already be correct

                # Also try matching by score to avoid false positives
                for row in rows:
                    total_checked += 1
                    # Verify scores match (team_score = away_score since team is away)
                    if team_score is not None and opp_score is not None:
                        if not (row["home_score"] == opp_score and row["away_score"] == team_score):
                            # Scores don't match the "team is away" interpretation.
                            # Check if they match "team is home" (already correct).
                            if row["home_score"] == team_score and row["away_score"] == opp_score:
                                # Scores say team IS home but schedule says away.
                                # The scores were stored with team-as-home perspective.
                                # We need to swap both the IDs AND the scores.
                                pass  # Fall through to swap
                            else:
                                continue  # Scores don't match at all, skip

                    # Swap home and away
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
                    swapped += 1

                conn.commit()

        if swapped > 0:
            logger.info(f"  SWAPPED {swapped} games from home to away for {db_short}")
        total_swapped += swapped

    # Summary
    print(f"\n{'='*50}")
    print(f"Total games checked: {total_checked}")
    print(f"Total games swapped: {total_swapped}")

    # Verify: show home game counts per team
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT t.short_name,
                   SUM(CASE WHEN g.home_team_id = t.id THEN 1 ELSE 0 END) as home,
                   SUM(CASE WHEN g.away_team_id = t.id THEN 1 ELSE 0 END) as away
            FROM teams t
            JOIN games g ON g.home_team_id = t.id OR g.away_team_id = t.id
            WHERE g.season = 2026
            GROUP BY t.short_name, t.id
            HAVING COUNT(*) > 10
            ORDER BY SUM(CASE WHEN g.home_team_id = t.id THEN 1 ELSE 0 END) DESC
            LIMIT 20
        """)
        print("\nTeam home/away game counts after fix:")
        for r in cur.fetchall():
            print(f"  {r['short_name']}: {r['home']} home, {r['away']} away")


if __name__ == "__main__":
    fix_home_away()
