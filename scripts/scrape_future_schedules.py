#!/usr/bin/env python3
"""
PNW Baseball - Future Schedule Scraper
=========================================
Scrapes all remaining (unplayed) games for every PNW team from their
schedule pages. Sidearm teams use Nuxt data; NWAC uses PrestoSports HTML.

Output: backend/data/future_schedules.json

Usage:
    cd pnw-baseball
    PYTHONPATH=backend python3 scripts/scrape_future_schedules.py
    PYTHONPATH=backend python3 scripts/scrape_future_schedules.py --season 2026
"""

import sys
import os
import time
import random
import argparse
import logging
import re
import json
from datetime import datetime, date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
sys.path.insert(0, str(Path(__file__).parent))

import requests
from bs4 import BeautifulSoup
from app.models.database import get_connection

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("scrape_future_schedules")

# ── Reuse team config + helpers from scrape_live_scores ──
from scrape_live_scores import (
    SIDEARM_TEAMS,
    TEAM_NAME_ALIASES,
    TEAM_LOGOS,
    normalize_team_name,
    fetch_page,
    parse_nuxt_data,
    extract_games_from_nuxt,
)

# URL overrides for teams with non-standard schedule URL patterns
SCHEDULE_URL_OVERRIDES = {
    "Seattle U": "{base_url}/sports/baseball/schedule/season/{season}",
}

# ── NWAC team name mapping (from scrape_nwac_schedule) ──
NWAC_SCHEDULE_NAME_TO_DB = {
    "Green River": "GRC",
    "Skagit Valley": "Skagit",
    "Mt Hood": "Mt. Hood",
    "SW Oregon": "SW Oregon",
    "Linn-Benton": "Linn-Benton",
}

NWAC_TEAMS_SET = {
    "Bellevue", "Big Bend", "Blue Mountain", "Centralia", "Chemeketa",
    "Clackamas", "Clark", "Columbia Basin", "Douglas", "Edmonds",
    "Everett", "Grays Harbor", "GRC", "Lane", "Linn-Benton",
    "Lower Columbia", "Mt. Hood", "Olympic", "Pierce", "Shoreline",
    "Skagit", "SW Oregon", "Spokane", "Tacoma", "Treasure Valley",
    "Umpqua", "Walla Walla", "Wenatchee Valley", "Yakima Valley",
}


def resolve_nwac_name(display_name):
    """Convert NWAC schedule display name to DB short_name."""
    if display_name in NWAC_SCHEDULE_NAME_TO_DB:
        return NWAC_SCHEDULE_NAME_TO_DB[display_name]
    if display_name in NWAC_TEAMS_SET:
        return display_name
    return display_name


# ============================================================
# Team ID Lookup
# ============================================================

def build_team_id_map():
    """Build a mapping of team short_name -> list of (team_id, conference_id, division_level).

    Some names are shared across divisions (e.g., 'Pacific' exists in both D1 and D3).
    We store all entries and resolve by division when looking up.
    """
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT t.id, t.short_name, t.conference_id,
                   d.level as division_level, c.name as conference_name
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE t.is_active = 1
        """)
        rows = cur.fetchall()

    team_map = {}
    for row in rows:
        r = dict(row)
        entry = {
            "team_id": r["id"],
            "conference_id": r["conference_id"],
            "division_level": r["division_level"],
            "conference_name": r["conference_name"],
        }
        name = r["short_name"]
        if name not in team_map:
            team_map[name] = entry
        else:
            # Store multiple entries as a list
            existing = team_map[name]
            if isinstance(existing, list):
                existing.append(entry)
            else:
                team_map[name] = [existing, entry]
    return team_map


def resolve_team(team_map, name, preferred_division=None):
    """Look up a team by name, preferring the given division if there are duplicates."""
    entry = team_map.get(name)
    if entry is None:
        return {}
    if isinstance(entry, dict):
        return entry
    # Multiple entries - pick by division
    if preferred_division:
        for e in entry:
            if e["division_level"] == preferred_division:
                return e
    # Fallback: prefer non-D1 (our focus is D2/D3/NAIA/JUCO)
    for e in entry:
        if e["division_level"] != "D1":
            return e
    return entry[0]


# ============================================================
# Sidearm Schedule Extraction (full season, future games only)
# ============================================================

def extract_future_sidearm_games(team_name, team_info, season, today, team_map):
    """Extract all future scheduled games from a Sidearm team's schedule page."""
    base_url = team_info["url"]
    sport = team_info["sport"]

    # Check for URL override (e.g., Seattle U uses /schedule/season/YYYY)
    if team_name in SCHEDULE_URL_OVERRIDES:
        url = SCHEDULE_URL_OVERRIDES[team_name].format(
            base_url=base_url, sport=sport, season=season
        )
    else:
        url = f"{base_url}/sports/{sport}/schedule/{season}"

    logger.info(f"Fetching {team_name}: {url}")
    html = fetch_page(url)
    if not html:
        return []

    nuxt_data = parse_nuxt_data(html)
    if not nuxt_data:
        logger.warning(f"  {team_name}: no __NUXT_DATA__ found, trying HTML fallback")
        return extract_future_html_games(html, team_name, team_info, today, team_map)

    games = extract_games_from_nuxt(nuxt_data)
    logger.info(f"  {team_name}: extracted {len(games)} total games from Nuxt data")

    future_games = []
    for game in games:
        if not isinstance(game, dict):
            continue

        # Check status - "O" means over/final
        status_code = game.get("status", "")
        if status_code == "O":
            continue

        # Parse date
        game_date_str = game.get("date", "")
        if not game_date_str:
            continue

        try:
            game_dt = datetime.fromisoformat(game_date_str.replace("Z", "+00:00")).date()
        except (ValueError, TypeError):
            continue

        # Only future games
        if game_dt <= today:
            continue

        # Parse opponent
        opponent = game.get("opponent", {})
        if isinstance(opponent, dict):
            opp_name = opponent.get("title", "Unknown")
        else:
            opp_name = str(opponent) if opponent else "Unknown"

        opp_clean = re.sub(r'^#\d+\s+', '', opp_name).strip()

        # Skip postseason placeholder entries
        postseason_keywords = [
            "tournament", "championship", "world series", "opening round",
            "super regional", "college world", "playoff",
            "naia opening", "naia world", "ncaa",
            "begins", "tba", "tbd",
        ]
        if any(kw in opp_clean.lower() for kw in postseason_keywords):
            continue

        opp_key = normalize_team_name(opp_clean)

        # Location
        loc_indicator = game.get("location_indicator", "")
        if loc_indicator == "H":
            location = "home"
        elif loc_indicator == "A":
            location = "away"
        else:
            location = "neutral"

        # Conference game?
        is_conference = game.get("conference", False)

        # Resolve team IDs (prefer matching division for duplicate names)
        div = team_info.get("division", "")
        team_info_db = resolve_team(team_map, team_name, div)
        opp_info_db = resolve_team(team_map, opp_key, div)

        if location == "home":
            home_team = team_name
            away_team = opp_key
            home_id = team_info_db.get("team_id")
            away_id = opp_info_db.get("team_id")
        else:
            home_team = opp_key
            away_team = team_name
            home_id = opp_info_db.get("team_id")
            away_id = team_info_db.get("team_id")

        future_games.append({
            "game_date": game_dt.isoformat(),
            "home_team": home_team,
            "away_team": away_team,
            "home_team_id": home_id,
            "away_team_id": away_id,
            "is_conference": is_conference,
            "division": team_info.get("division", ""),
            "source_team": team_name,
            "location": location,
        })

    logger.info(f"  {team_name}: {len(future_games)} future games found")
    return future_games


def extract_future_html_games(html, team_name, team_info, today, team_map):
    """
    Fallback: extract future games from legacy Sidearm HTML.

    Sidearm schedule pages use <li> elements with these key classes:
      - sidearm-schedule-game-upcoming   = future/scheduled game
      - sidearm-schedule-game-completed  = already played
    Some sites duplicate games for mobile/desktop layouts, so we deduplicate
    by (date, opponent) within a single team's page.
    """
    soup = BeautifulSoup(html, "html.parser")
    games = []
    seen_game_ids = set()  # Dedup using data-game-id when available

    # Method 1 (best): Find <li> elements with the "upcoming" class
    upcoming_items = soup.find_all("li", class_=re.compile(r"sidearm-schedule-game-upcoming"))

    # Method 2 (fallback): Find all game divs, skip ones marked completed
    if not upcoming_items:
        all_items = soup.find_all("div", class_="sidearm-schedule-game")
        upcoming_items = []
        for item in all_items:
            # Walk up to parent <li> and check if it's completed
            parent_li = item.find_parent("li")
            if parent_li:
                classes = " ".join(parent_li.get("class", []))
                if "completed" in classes:
                    continue
            # Also skip if there's a final result marker inside
            if item.find(class_=re.compile(r"result-final|game-result")):
                full_text = item.get_text(" ", strip=True)
                if re.search(r'[WLT],?\s*\d+\s*-\s*\d+', full_text):
                    continue
            upcoming_items.append(item)

    for item in upcoming_items:
        try:
            # Get date element
            date_el = item.find(class_=re.compile(r"sidearm-schedule-game-opponent-date"))
            if not date_el:
                continue

            date_text = date_el.get_text(" ", strip=True)
            # Strip periods from month abbreviations: "Apr." -> "Apr"
            date_text_clean = date_text.replace(".", "")
            date_match = re.match(r'(\w+)\s+(\d+)', date_text_clean)
            if not date_match:
                continue

            month_str = date_match.group(1)
            day_str = date_match.group(2)

            game_date = None
            for fmt in ("%b %d", "%B %d"):
                try:
                    dt = datetime.strptime(f"{month_str} {day_str}", fmt)
                    year = today.year
                    # Handle Jan/Feb games when we're in Oct+ (next calendar year)
                    if dt.month < 3 and today.month > 8:
                        year += 1
                    game_date = dt.replace(year=year).date()
                    break
                except ValueError:
                    continue

            if not game_date or game_date <= today:
                continue

            # Get opponent
            name_el = item.find(class_=re.compile(r"sidearm-schedule-game-opponent-name"))
            if not name_el:
                continue
            opp_link = name_el.find("a")
            opponent = opp_link.get_text(strip=True) if opp_link else name_el.get_text(strip=True)
            opponent = re.sub(r'\s*\(DH\)\s*', '', opponent).strip()
            opp_clean = re.sub(r'^#\d+\s+', '', opponent).strip()
            if not opp_clean:
                continue

            # Skip postseason placeholder entries (not real games)
            postseason_keywords = [
                "tournament", "championship", "world series", "opening round",
                "super regional", "college world", "playoff",
                "naia opening", "naia world", "ncaa",
                "begins", "tba", "tbd",
            ]
            opp_lower = opp_clean.lower()
            if any(kw in opp_lower for kw in postseason_keywords):
                continue

            opp_key = normalize_team_name(opp_clean)

            # Dedup using data-game-id (handles both mobile/desktop dupes
            # and doubleheaders correctly). Each real game has a unique ID.
            # If no data-game-id, let all games through (cross-team dedup
            # will handle duplicates later).
            game_id = None
            if hasattr(item, 'get'):
                game_id = item.get("data-game-id")
            if not game_id:
                parent_li = item.find_parent("li") if item.name != "li" else item
                if parent_li and hasattr(parent_li, 'get'):
                    game_id = parent_li.get("data-game-id")

            if game_id:
                if game_id in seen_game_ids:
                    continue
                seen_game_ids.add(game_id)

            # Location
            text_el = item.find(class_=re.compile(r"sidearm-schedule-game-opponent-text"))
            location = "home"
            if text_el and text_el.get_text(" ", strip=True).lower().startswith("at"):
                location = "away"

            # Conference
            is_conf = bool(item.find(class_=re.compile(r"conference")))

            div = team_info.get("division", "")
            team_info_db = resolve_team(team_map, team_name, div)
            opp_info_db = resolve_team(team_map, opp_key, div)

            if location == "home":
                home_team, away_team = team_name, opp_key
                home_id = team_info_db.get("team_id")
                away_id = opp_info_db.get("team_id")
            else:
                home_team, away_team = opp_key, team_name
                home_id = opp_info_db.get("team_id")
                away_id = team_info_db.get("team_id")

            games.append({
                "game_date": game_date.isoformat(),
                "home_team": home_team,
                "away_team": away_team,
                "home_team_id": home_id,
                "away_team_id": away_id,
                "is_conference": is_conf,
                "division": team_info.get("division", ""),
                "source_team": team_name,
                "location": location,
            })
        except Exception:
            continue

    logger.info(f"  {team_name}: HTML fallback found {len(games)} future games")
    return games


# ============================================================
# NWAC Schedule Extraction
# ============================================================

def extract_future_nwac_games(season_year, today, team_map):
    """
    Extract future games from the NWAC master schedule page.
    Uses ScraperAPI if SCRAPER_API_KEY is set, otherwise tries direct fetch.
    """
    import datetime as dt_module

    season_str = f"{season_year - 1}-{str(season_year)[2:]}"
    schedule_url = f"https://nwacsports.com/sports/bsb/{season_str}/schedule"

    # Try to load ScraperAPI key from environment or .env file
    api_key = os.environ.get("SCRAPER_API_KEY", "")
    if not api_key:
        env_path = Path(__file__).parent.parent / ".env"
        if env_path.exists():
            with open(env_path) as f:
                for line in f:
                    if line.strip().startswith("SCRAPER_API_KEY="):
                        api_key = line.strip().split("=", 1)[1].strip().strip('"').strip("'")
                        break

    if api_key:
        url = f"http://api.scraperapi.com?api_key={api_key}&url={schedule_url}"
        logger.info(f"Fetching NWAC schedule via ScraperAPI: {schedule_url}")
    else:
        logger.warning(
            "SCRAPER_API_KEY not set - NWAC games will be missing! "
            "Set it via: SCRAPER_API_KEY=your_key python3 scripts/scrape_future_schedules.py"
        )
        url = schedule_url
        logger.info(f"Fetching NWAC schedule directly (will likely fail): {schedule_url}")

    try:
        resp = requests.get(url, timeout=120)
        resp.raise_for_status()
        html = resp.text
    except Exception as e:
        logger.error(f"Failed to fetch NWAC schedule: {e}")
        return []

    if len(html) < 5000:
        logger.warning("NWAC schedule page too small, may be blocked")
        return []

    soup = BeautifulSoup(html, "html.parser")
    games = []
    rows = soup.find_all("tr")
    logger.info(f"NWAC: Found {len(rows)} table rows")

    # Month name -> number mapping
    MONTH_MAP = {
        "january": 1, "february": 2, "march": 3, "april": 4,
        "may": 5, "june": 6, "july": 7, "august": 8,
        "september": 9, "october": 10, "november": 11, "december": 12,
    }

    current_month = None  # Tracked from month header rows
    current_year = season_year  # Academic year: fall = year-1, spring = year
    current_day = None  # Last seen day number (for doubleheaders with empty date cells)

    for row in rows:
        # Check for month header row: <tr class="month-title ...">
        row_classes = " ".join(row.get("class", []))
        if "month-title" in row_classes:
            month_text = row.get_text(strip=True).lower()
            for mname, mnum in MONTH_MAP.items():
                if mname in month_text:
                    current_month = mnum
                    # Determine year: fall months (Aug-Dec) = season_year - 1
                    if mnum >= 8:
                        current_year = season_year - 1
                    else:
                        current_year = season_year
                    current_day = None
                    logger.debug(f"NWAC: Month header -> {month_text} ({current_year}-{current_month:02d})")
                    break
            continue

        cells = row.find_all("td")
        if len(cells) < 4:
            continue

        away_team_cell = row.find("td", class_="awayteam")
        home_team_cell = row.find("td", class_="hometeam")
        status_cell = row.find("td", class_="status")
        links_cell = row.find("td", class_="links")

        if not away_team_cell or not home_team_cell:
            continue

        away_name = away_team_cell.get_text(strip=True).rstrip("*^# ").strip()
        home_name = home_team_cell.get_text(strip=True).rstrip("*^# ").strip()

        if not away_name or not home_name:
            continue

        # Parse date from date cell (uses month from header rows)
        date_cell = row.find("td", class_="date")
        if date_cell:
            date_text = date_cell.get_text(strip=True)
            day_match = re.search(r'(\d+)', date_text)
            if day_match:
                current_day = int(day_match.group(1))

        # Also try extracting date from boxscore links (for completed games)
        if links_cell:
            link = links_cell.find("a", href=re.compile(r"boxscores/"))
            if link:
                href = link.get("href", "")
                date_match = re.search(r"boxscores/(\d{4})(\d{2})(\d{2})_", href)
                if date_match:
                    current_month = int(date_match.group(2))
                    current_day = int(date_match.group(3))
                    current_year = int(date_match.group(1))

        # Build game_date from tracked month + day
        game_date = None
        if current_month and current_day:
            try:
                game_date = dt_module.date(current_year, current_month, current_day)
            except ValueError:
                pass

        # Check status - skip completed games
        status_text = status_cell.get_text(strip=True) if status_cell else ""
        if "Final" in status_text:
            continue

        if not game_date or game_date <= today:
            continue

        # Conference game?
        is_conference = bool(away_team_cell.find("span", class_="notation"))

        # Resolve names
        away_db = resolve_nwac_name(away_name)
        home_db = resolve_nwac_name(home_name)

        away_info = resolve_team(team_map, away_db, "JUCO")
        home_info = resolve_team(team_map, home_db, "JUCO")

        games.append({
            "game_date": game_date.isoformat(),
            "home_team": home_db,
            "away_team": away_db,
            "home_team_id": home_info.get("team_id"),
            "away_team_id": away_info.get("team_id"),
            "is_conference": is_conference,
            "division": "JUCO",
            "source_team": "NWAC",
            "location": "home",
        })

    logger.info(f"NWAC: {len(games)} future games found")
    return games


# ============================================================
# Willamette (PrestoSports) Schedule Extraction
# ============================================================

# NWC team names for conference game detection
NWC_TEAMS_SET_D3 = {
    "UPS", "PLU", "Whitman", "Whitworth", "L&C", "Pacific",
    "Linfield", "GFU", "Willamette",
}

def extract_future_willamette_games(season_year, today, team_map):
    """
    Extract future games for Willamette from their PrestoSports schedule page.
    Willamette uses wubearcats.com with PrestoSports, not Sidearm.
    The game-log page has a hitting table where future games show score = "-".
    """
    presto_season = f"{season_year - 1}-{str(season_year)[2:]}"
    schedule_url = (
        f"https://www.wubearcats.com/sports/bsb/{presto_season}"
        f"/teams/willamette?view=schedule"
    )

    logger.info(f"Fetching Willamette schedule: {schedule_url}")
    try:
        resp = requests.get(schedule_url, timeout=30, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        })
        resp.raise_for_status()
        html = resp.text
    except Exception as e:
        logger.error(f"Failed to fetch Willamette schedule: {e}")
        return []

    if len(html) < 2000:
        logger.warning("Willamette schedule page too small")
        return []

    soup = BeautifulSoup(html, "html.parser")

    # Find the hitting game-log table (has "date", "opponent", "ab" headers)
    tables = soup.find_all("table")
    hitting_table = None
    for table in tables:
        header_row = table.find("tr")
        if not header_row:
            continue
        header_text = header_row.get_text(strip=True).lower()
        if "date" in header_text and "opponent" in header_text and "ab" in header_text:
            hitting_table = table
            break

    if not hitting_table:
        logger.warning("Willamette: Could not find hitting game-log table")
        return []

    rows = hitting_table.find_all("tr")
    if len(rows) < 2:
        return []

    # Get headers
    header_cells = rows[0].find_all(["th", "td"])
    headers = [c.get_text(strip=True).lower() for c in header_cells]

    games = []
    current_date = None

    for row in rows[1:]:
        cells = row.find_all(["td", "th"])
        if len(cells) < 3:
            continue

        vals = {}
        for i, cell in enumerate(cells):
            if i < len(headers):
                vals[headers[i]] = cell.get_text(strip=True)

        # Parse date (format: "Mon, Feb 1" or "Sat, Mar 15")
        date_str = vals.get("date", "").strip()
        if date_str:
            # Try parsing "DayName, Mon DD" format
            date_match = re.match(r'\w+,?\s+(\w+)\s+(\d+)', date_str)
            if date_match:
                month_str = date_match.group(1)
                day_str = date_match.group(2)
                for fmt in ("%b %d", "%B %d"):
                    try:
                        dt = datetime.strptime(f"{month_str} {day_str}", fmt)
                        year = season_year
                        # Fall games (Aug-Dec) use season_year - 1
                        if dt.month >= 8:
                            year = season_year - 1
                        current_date = dt.replace(year=year).date()
                        break
                    except ValueError:
                        continue

        # Check score - future games have "-" or empty
        score_str = vals.get("score", "").strip()
        if score_str and score_str != "-":
            # Game already played, skip
            continue

        if not current_date or current_date <= today:
            continue

        # Parse opponent
        opponent = vals.get("opponent", "").strip()
        if not opponent:
            continue

        # Skip summary rows
        if opponent.lower() in ("overall", "conference", "home", "away",
                                "neutral", "total", "wins", "losses"):
            continue

        # Detect home/away: "at Team" or "vs Team" or just "Team"
        location = "home"
        if opponent.lower().startswith("at "):
            location = "away"
            opponent = opponent[3:].strip()
        elif opponent.lower().startswith("vs "):
            opponent = opponent[3:].strip()

        # Clean opponent name
        opponent = re.sub(r'\s*\*+\s*$', '', opponent)  # Remove trailing asterisks
        opponent = re.sub(r'^#\d+\s+', '', opponent).strip()  # Remove rankings

        # Skip postseason placeholders
        postseason_keywords = [
            "tournament", "championship", "world series", "opening round",
            "super regional", "playoff", "ncaa", "begins", "tba", "tbd",
        ]
        if any(kw in opponent.lower() for kw in postseason_keywords):
            continue

        opp_key = normalize_team_name(opponent)

        # Conference game = opponent is an NWC team
        is_conference = opp_key in NWC_TEAMS_SET_D3

        # Resolve team IDs
        willamette_info = resolve_team(team_map, "Willamette", "D3")
        opp_info = resolve_team(team_map, opp_key, "D3")

        if location == "home":
            home_team, away_team = "Willamette", opp_key
            home_id = willamette_info.get("team_id")
            away_id = opp_info.get("team_id")
        else:
            home_team, away_team = opp_key, "Willamette"
            home_id = opp_info.get("team_id")
            away_id = willamette_info.get("team_id")

        games.append({
            "game_date": current_date.isoformat(),
            "home_team": home_team,
            "away_team": away_team,
            "home_team_id": home_id,
            "away_team_id": away_id,
            "is_conference": is_conference,
            "division": "D3",
            "source_team": "Willamette",
            "location": location,
        })

    logger.info(f"Willamette: {len(games)} future games found")
    return games


# ============================================================
# Deduplication
# ============================================================

def deduplicate_future_games(games):
    """
    Remove duplicate games that appear from both teams' schedules,
    while preserving doubleheaders (multiple games on the same date
    between the same two teams).

    Strategy: Group games by (date, team_pair). For each group, count
    how many games each source_team reported. The real game count is
    the max from any single source. Keep that many, preferring entries
    with team IDs filled in.
    """
    from collections import defaultdict

    # Group games by (date, team_pair)
    groups = defaultdict(list)
    for g in games:
        home = normalize_team_name(g["home_team"])
        away = normalize_team_name(g["away_team"])
        key = (g["game_date"], tuple(sorted([home, away])))
        groups[key].append(g)

    deduped = []
    for key, group in groups.items():
        # Count how many games each source team reported for this matchup/date
        source_counts = defaultdict(int)
        for g in group:
            source_counts[g.get("source_team", "")] += 1

        # The real number of games is the max reported by any single source
        real_count = max(source_counts.values()) if source_counts else 1

        # Sort group to prefer entries with team IDs
        group.sort(key=lambda g: (
            1 if g.get("home_team_id") and g.get("away_team_id") else 0
        ), reverse=True)

        # Keep up to real_count games, merge IDs where possible
        kept = []
        for g in group:
            if len(kept) >= real_count:
                # Try to merge IDs into existing kept games
                for k in kept:
                    if not k.get("home_team_id") and g.get("home_team_id"):
                        k["home_team_id"] = g["home_team_id"]
                    if not k.get("away_team_id") and g.get("away_team_id"):
                        k["away_team_id"] = g["away_team_id"]
                continue
            kept.append(g)

        deduped.extend(kept)

    return deduped


# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="Scrape future schedules for PNW baseball")
    parser.add_argument("--season", type=int, default=2026, help="Season year")
    args = parser.parse_args()

    import pytz
    pacific = pytz.timezone("US/Pacific")
    now_pacific = datetime.now(pacific)
    today = now_pacific.date()

    logger.info(f"=== Future Schedule Scraper - {today} (Pacific) ===")
    logger.info(f"Season: {args.season}")

    # Build team ID map from database
    team_map = build_team_id_map()
    logger.info(f"Loaded {len(team_map)} active teams from database")

    all_games = []

    # 1. Scrape Sidearm teams (D1, D2, D3, NAIA)
    for team_name, team_info in SIDEARM_TEAMS.items():
        try:
            games = extract_future_sidearm_games(
                team_name, team_info, args.season, today, team_map
            )
            all_games.extend(games)
        except Exception as e:
            logger.error(f"Error scraping {team_name}: {e}")
            continue

    # 2. Scrape NWAC schedule
    try:
        nwac_games = extract_future_nwac_games(args.season, today, team_map)
        all_games.extend(nwac_games)
    except Exception as e:
        logger.error(f"Error scraping NWAC schedule: {e}")

    # 3. Scrape Willamette (PrestoSports - not in Sidearm)
    try:
        wil_games = extract_future_willamette_games(args.season, today, team_map)
        all_games.extend(wil_games)
    except Exception as e:
        logger.error(f"Error scraping Willamette schedule: {e}")

    # 4. Deduplicate
    before_count = len(all_games)
    all_games = deduplicate_future_games(all_games)
    logger.info(f"Deduplicated: {before_count} -> {len(all_games)} games")

    # 5. Sort by date
    all_games.sort(key=lambda g: g["game_date"])

    # 6. Write output
    output = {
        "last_updated": now_pacific.isoformat(),
        "season": args.season,
        "total_games": len(all_games),
        "games": all_games,
    }

    output_path = Path(__file__).parent.parent / "backend" / "data" / "future_schedules.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2, default=str)

    logger.info(f"Wrote {len(all_games)} future games to {output_path}")

    # Summary by division
    by_div = {}
    for g in all_games:
        d = g.get("division", "Unknown")
        by_div[d] = by_div.get(d, 0) + 1
    for d, count in sorted(by_div.items()):
        logger.info(f"  {d}: {count} games")


if __name__ == "__main__":
    main()
