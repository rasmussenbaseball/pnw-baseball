#!/usr/bin/env python3
"""
Fix home/away assignments in the games table by re-reading schedule pages.

Sidearm Sports pages embed JSON-LD schema data with event names like:
  "Bushnell University At The Master's University" (away)
  "Bushnell University Vs Simpson University" (home)

This script parses that JSON to reliably determine home/away, then swaps
the games table where the assignment was wrong.

Usage:
    cd /opt/pnw-baseball
    PYTHONPATH=backend python3 scripts/fix_home_away.py
"""
import sys
import re
import json
import logging
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
sys.path.insert(0, str(Path(__file__).parent))

from app.models.database import get_connection
from scrape_boxscores import (
    D1_TEAMS, D2_TEAMS, D3_TEAMS, NAIA_TEAMS, NWAC_TEAMS,
    NWAC_TEAM_SLUGS,
    fetch_page,
    build_sidearm_schedule_url,
    build_presto_schedule_url,
    parse_presto_schedule,
    get_team_id_by_name,
)

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

SEASON = 2026


def parse_sidearm_json_ld(html):
    """Extract game home/away from Sidearm's embedded JSON-LD schema data.

    Returns list of dicts with: date, is_away, team_score, opp_score, game_number
    """
    if not html:
        return []

    games = []

    # Find all JSON-LD script blocks
    json_ld_pattern = re.findall(
        r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html, re.DOTALL
    )

    for block in json_ld_pattern:
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            continue

        # Handle both single objects and arrays
        items = data if isinstance(data, list) else [data]

        for item in items:
            if item.get("@type") != "SportsEvent":
                continue

            name = item.get("name", "")
            start_date = item.get("startDate", "")

            # Determine home/away from event name
            # "Team At Opponent" = away, "Team Vs Opponent" = home
            if " At " in name:
                is_away = True
            elif " Vs " in name or " vs " in name:
                is_away = False
            else:
                continue  # Can't determine

            # Parse date
            game_date = None
            if start_date:
                try:
                    dt = datetime.fromisoformat(start_date.replace("Z", "+00:00"))
                    game_date = dt.date()
                except (ValueError, TypeError):
                    # Try other formats
                    for fmt in ["%Y-%m-%dT%H:%M", "%Y-%m-%d"]:
                        try:
                            game_date = datetime.strptime(start_date[:len(fmt)+2], fmt).date()
                            break
                        except ValueError:
                            continue

            if not game_date:
                continue

            games.append({
                "date": game_date,
                "is_away": is_away,
                "name": name,
            })

    # Assign game numbers for doubleheaders (same date)
    from collections import Counter
    date_counts = Counter()
    for g in games:
        date_counts[g["date"]] += 1

    date_seen = Counter()
    for g in games:
        date_seen[g["date"]] += 1
        if date_counts[g["date"]] > 1:
            g["game_number"] = date_seen[g["date"]]
        else:
            g["game_number"] = 1

    return games


def fix_sidearm_team(db_short, team_config, team_id):
    """Fix home/away for a Sidearm team by parsing JSON-LD from their schedule."""
    base_url, sport, platform = team_config

    if platform != "sidearm":
        return 0

    url = build_sidearm_schedule_url(base_url, sport, SEASON)
    html = fetch_page(url)
    if not html:
        url = f"{base_url}/sports/{sport}/schedule"
        html = fetch_page(url)

    if not html:
        logger.warning(f"  Could not fetch schedule page")
        return 0

    games = parse_sidearm_json_ld(html)
    if not games:
        logger.warning(f"  No JSON-LD game data found")
        return 0

    away_games = [g for g in games if g["is_away"]]
    home_games = [g for g in games if not g["is_away"]]
    logger.info(f"  JSON-LD: {len(home_games)} home, {len(away_games)} away games detected")

    swapped = 0
    with get_connection() as conn:
        cur = conn.cursor()

        for game in away_games:
            if game["date"].year < 2026:
                continue  # Skip fall/preseason games

            # This is an AWAY game. Check if DB has this team as home.
            cur.execute("""
                SELECT id, home_team_id, away_team_id,
                       home_score, away_score
                FROM games
                WHERE game_date = %s
                  AND game_number = %s
                  AND home_team_id = %s
                  AND season = %s
            """, (game["date"], game["game_number"], team_id, SEASON))

            rows = cur.fetchall()
            for row in rows:
                # This game has our team as home, but it should be away. Swap.
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

    return swapped


def fix_presto_team(db_short, team_config, team_id):
    """Fix home/away for a PrestoSports team using the text-based parser."""
    base_url, sport, platform = team_config

    if platform != "presto":
        return 0

    is_nwac = db_short in NWAC_TEAM_SLUGS
    if is_nwac:
        # Skip NWAC -- server gets blocked by WAF
        return 0

    if db_short == "Willamette":
        presto_season = f"{SEASON - 1}-{str(SEASON)[2:]}"
        url = build_presto_schedule_url(base_url, sport, "willamette", presto_season)
    else:
        return 0

    html = fetch_page(url)
    if not html:
        return 0

    schedule = parse_presto_schedule(html, base_url, SEASON)
    if not schedule:
        return 0

    swapped = 0
    with get_connection() as conn:
        cur = conn.cursor()

        for game in schedule:
            game_date = game.get("date")
            if not game_date:
                continue

            # Check is_away from the parsed data
            opp = game.get("opponent", "")
            if game.get("is_away"):
                is_away = True
            elif opp.lower().startswith(("at ", "@ ")):
                is_away = True
            else:
                continue  # Not away or can't determine

            game_number = game.get("game_number", 1)

            cur.execute("""
                SELECT id FROM games
                WHERE game_date = %s
                  AND game_number = %s
                  AND home_team_id = %s
                  AND season = %s
            """, (game_date, game_number, team_id, SEASON))

            for row in cur.fetchall():
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

    return swapped


def fix_home_away():
    all_teams = {}
    all_teams.update(D1_TEAMS)
    all_teams.update(D2_TEAMS)
    all_teams.update(D3_TEAMS)
    all_teams.update(NAIA_TEAMS)
    # Add Willamette (PrestoSports)
    # Skip NWAC -- WAF blocks from server

    total_swapped = 0

    for db_short, team_config in all_teams.items():
        logger.info(f"\n{'='*50}")
        logger.info(f"Processing: {db_short}")

        with get_connection() as conn:
            cur = conn.cursor()
            team_id = get_team_id_by_name(cur, db_short)
            if not team_id:
                logger.warning(f"  Team not found in DB, skipping")
                continue

        base_url, sport, platform = team_config

        if platform == "sidearm":
            swapped = fix_sidearm_team(db_short, team_config, team_id)
        elif platform == "presto":
            swapped = fix_presto_team(db_short, team_config, team_id)
        else:
            swapped = 0

        if swapped > 0:
            logger.info(f"  SWAPPED {swapped} games for {db_short}")
        total_swapped += swapped

        # Be polite to servers
        time.sleep(0.5)

    print(f"\n{'='*50}")
    print(f"Total games swapped: {total_swapped}")

    # Summary
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
            ORDER BY t.short_name
        """)
        print("\nTeam home/away counts after fix:")
        for r in cur.fetchall():
            ratio = r['home'] / max(r['home'] + r['away'], 1) * 100
            flag = " ⚠️" if ratio > 70 else ""
            print(f"  {r['short_name']}: {r['home']} home, {r['away']} away ({ratio:.0f}% home){flag}")


if __name__ == "__main__":
    fix_home_away()
