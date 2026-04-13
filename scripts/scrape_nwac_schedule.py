#!/usr/bin/env python3
"""
NWAC Schedule Scraper — Game Results via ScraperAPI
====================================================
Fetches the NWAC master baseball schedule page through ScraperAPI
(bypasses AWS WAF) and upserts game results into the database.

This script is designed to run daily via GitHub Actions.

Usage (local):
    PYTHONPATH=backend SCRAPER_API_KEY=your_key python3 scripts/scrape_nwac_schedule.py

Usage (GitHub Actions):
    Runs automatically on schedule — see .github/workflows/nwac-schedule.yml
"""

import sys
import os
import re
import json
import logging
from pathlib import Path

# Setup path for imports
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
sys.path.insert(0, str(Path(__file__).parent))

import requests
from bs4 import BeautifulSoup
from app.models.database import get_connection
from scrape_boxscores import (
    get_team_id_by_name,
    get_team_id_by_school,
    upsert_game,
    compute_team_game_score,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("nwac_schedule")

# ── Team name mapping: schedule page display name → DB short_name ──
# Most names match directly, but some differ
SCHEDULE_NAME_TO_DB = {
    "Skagit Valley": "Skagit",
    "Mt Hood": "Mt. Hood",
    "SW Oregon": "SW Oregon",
    "Linn-Benton": "Linn-Benton",
}

# All NWAC member teams (DB short_names) for identifying conference matchups
NWAC_TEAMS = {
    "Bellevue", "Big Bend", "Blue Mountain", "Centralia", "Chemeketa",
    "Clackamas", "Clark", "Columbia Basin", "Douglas", "Edmonds",
    "Everett", "Grays Harbor", "Lane", "Linn-Benton",
    "Lower Columbia", "Mt. Hood", "Olympic", "Pierce", "Shoreline",
    "Skagit", "SW Oregon", "Spokane", "Tacoma", "Treasure Valley",
    "Umpqua", "Walla Walla", "Wenatchee Valley", "Yakima Valley",
}


def resolve_team_name(display_name):
    """Convert schedule page display name to DB short_name."""
    # Check explicit mapping first
    if display_name in SCHEDULE_NAME_TO_DB:
        return SCHEDULE_NAME_TO_DB[display_name]
    # Most names match directly
    if display_name in NWAC_TEAMS:
        return display_name
    # Return as-is for non-NWAC teams (opponents)
    return display_name


def fetch_schedule(api_key, season_year):
    """Fetch the NWAC master schedule page via ScraperAPI."""
    season_str = f"{season_year - 1}-{str(season_year)[2:]}"
    schedule_url = f"https://nwacsports.com/sports/bsb/{season_str}/schedule"

    logger.info(f"Fetching NWAC schedule: {schedule_url}")

    url = (
        f"http://api.scraperapi.com"
        f"?api_key={api_key}"
        f"&url={schedule_url}"
    )

    resp = requests.get(url, timeout=120)
    resp.raise_for_status()

    if len(resp.text) < 5000 or "captcha" in resp.text.lower():
        raise RuntimeError(
            f"Schedule page appears blocked (size={len(resp.text)}). "
            "ScraperAPI may need premium mode for this page."
        )

    logger.info(f"Got {len(resp.text):,} bytes")
    return resp.text


def _infer_date_from_cell(date_text, current_date, season_year):
    """
    Infer a full date from the schedule page date cell text.

    Date cells show e.g. "Tue. 8" or "Sun. 14" — day-of-week + day number only.
    We infer the month from the current_date context (schedule is chronological).
    """
    import datetime

    # Extract day number from text like "Tue. 8" or "Sun 14"
    day_match = re.search(r'(\d+)', date_text)
    if not day_match:
        return None

    day = int(day_match.group(1))

    if current_date:
        # Start from the month of the last known date
        month = current_date.month
        year = current_date.year

        # If the new day < current day, we've rolled into the next month
        if day < current_date.day - 15:  # Allow for reasonable date jumps
            month += 1
            if month > 12:
                month = 1
                year += 1

        try:
            return datetime.date(year, month, day)
        except ValueError:
            pass

    # Fallback: try common baseball months (Feb-Jun) in the season year
    for month in (2, 3, 4, 5, 6):
        try:
            candidate = datetime.date(season_year, month, day)
            return candidate
        except ValueError:
            continue

    return None


def parse_schedule_page(html, season_year):
    """
    Parse the NWAC master schedule HTML table into game dicts.

    Each row has:
      - date cell (day-of-week + day number only, e.g. "Sun. 14")
      - away team + conference indicator (*)
      - away score (class contains 'awayresult')
      - home team
      - home score (class contains 'homeresult')
      - status (Final, Final - 7 innings, etc.)
      - links (box score URL containing full date as YYYYMMDD)

    Dates are extracted from box score URLs when available (most reliable),
    then inferred from date cells using context for scheduled games.
    """
    import datetime

    soup = BeautifulSoup(html, "html.parser")
    games = []

    rows = soup.find_all("tr")
    logger.info(f"Found {len(rows)} table rows total")

    current_date = None
    games_final = 0
    games_scheduled = 0
    games_skipped = 0

    # Get today's date in Pacific time for filtering scheduled games
    try:
        from zoneinfo import ZoneInfo
        today = datetime.datetime.now(ZoneInfo("America/Los_Angeles")).date()
    except Exception:
        today = datetime.date.today()

    for row in rows:
        cells = row.find_all("td")
        if len(cells) < 4:
            continue

        # Extract components by class name
        away_team_cell = row.find("td", class_="awayteam")
        home_team_cell = row.find("td", class_="hometeam")
        away_score_cell = row.find("td", class_=re.compile(r"awayresult"))
        home_score_cell = row.find("td", class_=re.compile(r"homeresult"))
        status_cell = row.find("td", class_="status")
        links_cell = row.find("td", class_="links")
        date_cell = row.find("td", class_=re.compile(r"date|day"))

        # Must have both teams
        if not away_team_cell or not home_team_cell:
            continue

        # Parse team names (strip conference *, ^, #, and whitespace)
        away_name = away_team_cell.get_text(strip=True).rstrip("*^# ").strip()
        home_name = home_team_cell.get_text(strip=True).rstrip("*^# ").strip()

        if not away_name or not home_name:
            continue

        # Check if conference game (has * notation)
        is_conference = bool(away_team_cell.find("span", class_="notation"))

        # Parse status
        status_text = status_cell.get_text(strip=True) if status_cell else ""
        is_final = "Final" in status_text

        # Parse scores (may be empty for scheduled games)
        away_score = None
        home_score = None
        if away_score_cell and home_score_cell:
            away_score_text = away_score_cell.get_text(strip=True)
            home_score_text = home_score_cell.get_text(strip=True)
            try:
                away_score = int(away_score_text)
                home_score = int(home_score_text)
            except (ValueError, TypeError):
                pass

        # For final games, require valid scores
        if is_final and (away_score is None or home_score is None):
            games_skipped += 1
            continue

        # Parse innings from status (e.g., "Final - 7 innings")
        innings = 9 if is_final else None
        if is_final:
            innings_match = re.search(r"(\d+)\s*inning", status_text)
            if innings_match:
                innings = int(innings_match.group(1))

        # Parse box score URL and extract date from it
        box_score_url = None
        game_date = None

        if links_cell:
            link = links_cell.find("a", href=re.compile(r"boxscores/"))
            if link:
                href = link.get("href", "")
                if href.startswith("/"):
                    box_score_url = f"https://nwacsports.com{href}"
                elif href.startswith("http"):
                    box_score_url = href

                # Extract date from URL: /boxscores/YYYYMMDD_xxxx.xml
                date_match = re.search(r"boxscores/(\d{4})(\d{2})(\d{2})_", href)
                if date_match:
                    try:
                        game_date = datetime.date(
                            int(date_match.group(1)),
                            int(date_match.group(2)),
                            int(date_match.group(3)),
                        )
                        current_date = game_date
                    except ValueError:
                        pass

        # For scheduled games, try to get date from the date cell
        if not game_date and date_cell:
            date_text = date_cell.get_text(strip=True)
            if date_text:
                inferred = _infer_date_from_cell(date_text, current_date, season_year)
                if inferred:
                    game_date = inferred
                    current_date = game_date

        # Fall back to current_date for games without box score links
        if not game_date:
            game_date = current_date
            if not is_final and game_date:
                logger.debug(f"Date fallback for scheduled: {away_name} @ {home_name} → {game_date} (from last known date)")

        if not game_date:
            logger.warning(f"No date for game: {away_name} @ {home_name} -- skipping")
            games_skipped += 1
            continue

        # For scheduled games, only include recent and upcoming (not old unscored games)
        # Use a 3-day buffer since date inference from date cells can be off by a day
        import datetime as _dt_mod
        if not is_final and game_date < today - _dt_mod.timedelta(days=3):
            logger.debug(f"Skipping old scheduled: {away_name} @ {home_name} on {game_date}")
            games_skipped += 1
            continue

        # Resolve team names to DB short_names
        away_db_name = resolve_team_name(away_name)
        home_db_name = resolve_team_name(home_name)

        # Detect doubleheaders — check ALL previous games, not just the last one
        game_number = 1
        for prev in games:
            if (prev["game_date"] == game_date
                    and prev["away_team_name"] == away_db_name
                    and prev["home_team_name"] == home_db_name):
                game_number = max(game_number, prev["game_number"] + 1)

        game = {
            "season": season_year,
            "game_date": game_date,
            "away_team_name": away_db_name,
            "home_team_name": home_db_name,
            "away_score": away_score,
            "home_score": home_score,
            "innings": innings,
            "is_conference_game": is_conference,
            "game_number": game_number,
            "status": "final" if is_final else "scheduled",
            "source_url": box_score_url,
        }

        games.append(game)
        if is_final:
            games_final += 1
        else:
            games_scheduled += 1

    logger.info(f"Parsed {games_final} final + {games_scheduled} scheduled games, skipped {games_skipped}")
    return games


def resolve_team_ids(cur, games):
    """Look up team IDs for all games. Modifies games in place."""
    # Cache lookups to avoid repeated queries
    id_cache = {}

    for game in games:
        for role in ["away", "home"]:
            name = game[f"{role}_team_name"]

            if name in id_cache:
                team_id = id_cache[name]
            else:
                # Try exact match by short_name first
                team_id = get_team_id_by_name(cur, name)
                if not team_id:
                    # Fuzzy match by school name
                    team_id = get_team_id_by_school(cur, name)
                id_cache[name] = team_id

            if team_id:
                game[f"{role}_team_id"] = team_id


def main():
    api_key = os.environ.get("SCRAPER_API_KEY")
    if not api_key:
        logger.error("SCRAPER_API_KEY environment variable not set")
        sys.exit(1)

    season_year = int(os.environ.get("SEASON_YEAR", "2026"))
    logger.info(f"NWAC Schedule Scraper — Season {season_year}")

    # Fetch schedule page
    html = fetch_schedule(api_key, season_year)

    # Parse games
    games = parse_schedule_page(html, season_year)

    if not games:
        logger.warning("No games found on schedule page")
        return

    logger.info(f"Processing {len(games)} games...")

    # Resolve team IDs and upsert into database
    inserted = 0
    updated = 0
    errors = 0

    with get_connection() as conn:
        cur = conn.cursor()

        # Resolve all team IDs
        resolve_team_ids(cur, games)

        for game in games:
            try:
                # Compute game score (only for final games with scores)
                if game["status"] == "final" and game["home_score"] is not None and game["away_score"] is not None:
                    winner_score = max(game["home_score"], game["away_score"])
                    loser_score = min(game["home_score"], game["away_score"])
                    game["game_score"] = compute_team_game_score(
                        winner_score, loser_score, game["innings"] or 9
                    )

                # Check if this game already exists
                existing = None
                if game.get("source_url"):
                    cur.execute(
                        "SELECT id FROM games WHERE source_url = %s",
                        (game["source_url"],),
                    )
                    existing = cur.fetchone()

                game_id = upsert_game(cur, game)
                if game_id:
                    if existing:
                        updated += 1
                    else:
                        inserted += 1
            except Exception as e:
                logger.error(f"Error processing game {game['game_date']} "
                           f"{game['away_team_name']} @ {game['home_team_name']}: {e}")
                errors += 1

        conn.commit()

    logger.info("=" * 60)
    logger.info("SCRAPE COMPLETE")
    logger.info(f"  Total games: {len(games)}")
    logger.info(f"  Inserted: {inserted}")
    logger.info(f"  Updated: {updated}")
    logger.info(f"  Errors: {errors}")

    # Log unresolved teams
    unresolved = set()
    for game in games:
        if not game.get("away_team_id"):
            unresolved.add(game["away_team_name"])
        if not game.get("home_team_id"):
            unresolved.add(game["home_team_name"])

    if unresolved:
        logger.info(f"  Unresolved teams ({len(unresolved)}): {sorted(unresolved)}")

    logger.info("=" * 60)


if __name__ == "__main__":
    main()
