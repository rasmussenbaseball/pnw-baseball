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

# ── NWAC team slugs for individual team pages on PrestoSports ──
NWAC_TEAM_SLUGS = {
    "Bellevue": "bellevue",
    "Big Bend": "bigbend",
    "Blue Mountain": "bluemountain",
    "Centralia": "centralia",
    "Chemeketa": "chemeketa",
    "Clackamas": "clackamas",
    "Clark": "clark",
    "Columbia Basin": "columbiabasin",
    "Douglas": "douglas",
    "Edmonds": "edmonds",
    "Everett": "everett",
    "Grays Harbor": "graysharbor",
    "Lane": "lane",
    "Linn-Benton": "linnbenton",
    "Lower Columbia": "lowercolumbia",
    "Mt. Hood": "mthood",
    "Olympic": "olympic",
    "Pierce": "pierce",
    "Shoreline": "shoreline",
    "Skagit": "skagitvalley",
    "SW Oregon": "southwesternoregon",
    "Spokane": "spokane",
    "Tacoma": "tacoma",
    "Treasure Valley": "treasurevalley",
    "Umpqua": "umpqua",
    "Walla Walla": "wallawalla",
    "Wenatchee Valley": "wenatcheevalley",
    "Yakima Valley": "yakimavalley",
}

# ── NWAC opponent name mapping ──
NWAC_SCHEDULE_NAME_TO_DB = {
    "Skagit Valley": "Skagit",
    "Mt Hood": "Mt. Hood",
    "SW Oregon": "SW Oregon",
    "Southwestern Oregon": "SW Oregon",
    "Linn-Benton": "Linn-Benton",
}

NWAC_TEAMS_SET = set(NWAC_TEAM_SLUGS.keys())


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
# PrestoSports Game-Log Parser (shared by NWAC + Willamette)
# ============================================================

def parse_presto_future_games(html, team_db_name, season_year, today, team_map,
                              division, conf_teams_set=None):
    """
    Parse a PrestoSports team game-log page for future games.
    Future games have empty or "-" scores in the hitting table.

    Args:
        html: Page HTML
        team_db_name: DB short_name for this team (e.g., "Bellevue", "Willamette")
        season_year: Season year (e.g., 2026)
        today: Today's date
        team_map: Team ID lookup map
        division: Division level ("JUCO", "D3", etc.)
        conf_teams_set: Set of team names in same conference (for is_conference detection)
    """
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
        return []

    rows = hitting_table.find_all("tr")
    if len(rows) < 2:
        return []

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

        # Parse date (formats: "Apr 11", "Mon, Apr 11", "4/11/2026")
        date_str = vals.get("date", "").strip()
        if date_str:
            # Try "M/D/YYYY" format first
            slash_match = re.match(r'(\d{1,2})/(\d{1,2})/(\d{4})', date_str)
            if slash_match:
                try:
                    current_date = date(int(slash_match.group(3)),
                                        int(slash_match.group(1)),
                                        int(slash_match.group(2)))
                except ValueError:
                    pass
            else:
                # Try "DayName, Mon DD" or just "Mon DD"
                date_match = re.match(r'(?:\w+,?\s+)?(\w+)\s+(\d+)', date_str)
                if date_match:
                    month_str = date_match.group(1)
                    day_str = date_match.group(2)
                    for fmt in ("%b %d", "%B %d"):
                        try:
                            dt = datetime.strptime(f"{month_str} {day_str}", fmt)
                            year = season_year
                            if dt.month >= 8:
                                year = season_year - 1
                            current_date = dt.replace(year=year).date()
                            break
                        except ValueError:
                            continue

        # Check score - future games have "-" or empty
        score_str = vals.get("score", "").strip()
        if score_str and score_str != "-":
            continue

        if not current_date or current_date <= today:
            continue

        # Parse opponent
        opponent = " ".join(vals.get("opponent", "").split())  # collapse whitespace
        if not opponent:
            continue

        # Skip summary rows
        if opponent.lower() in ("overall", "conference", "home", "away",
                                "neutral", "total", "wins", "losses",
                                "february", "march", "april", "may", "june",
                                "january", "exhibition"):
            continue

        # Detect home/away
        location = "home"
        if opponent.lower().startswith("at "):
            location = "away"
            opponent = opponent[3:].strip()
        elif opponent.lower().startswith("vs "):
            opponent = opponent[3:].strip()

        # Clean opponent name
        opponent = re.sub(r'\s*\*+\s*$', '', opponent)  # trailing asterisks
        opponent = re.sub(r'^#\d+\s+', '', opponent).strip()  # rankings
        opponent = re.sub(r'\s*\(DH\)\s*', '', opponent).strip()

        # Skip postseason placeholders
        postseason_keywords = [
            "tournament", "championship", "world series", "opening round",
            "super regional", "playoff", "ncaa", "begins", "tba", "tbd",
        ]
        if any(kw in opponent.lower() for kw in postseason_keywords):
            continue

        # Try NWAC name resolution first, then general normalization
        opp_key = resolve_nwac_name(opponent)
        if opp_key == opponent:
            opp_key = normalize_team_name(opponent)

        # Conference game detection
        is_conference = False
        if conf_teams_set and opp_key in conf_teams_set:
            is_conference = True

        # Resolve team IDs
        team_info_db = resolve_team(team_map, team_db_name, division)
        opp_info = resolve_team(team_map, opp_key, division)

        if location == "home":
            home_team, away_team = team_db_name, opp_key
            home_id = team_info_db.get("team_id")
            away_id = opp_info.get("team_id")
        else:
            home_team, away_team = opp_key, team_db_name
            home_id = opp_info.get("team_id")
            away_id = team_info_db.get("team_id")

        games.append({
            "game_date": current_date.isoformat(),
            "home_team": home_team,
            "away_team": away_team,
            "home_team_id": home_id,
            "away_team_id": away_id,
            "is_conference": is_conference,
            "division": division,
            "source_team": team_db_name,
            "location": location,
        })

    return games


# ============================================================
# NWAC Schedule Extraction (individual team pages)
# ============================================================

def get_scraper_api_key():
    """Load ScraperAPI key from environment or .env file."""
    api_key = os.environ.get("SCRAPER_API_KEY", "")
    if not api_key:
        env_path = Path(__file__).parent.parent / ".env"
        if env_path.exists():
            with open(env_path) as f:
                for line in f:
                    if line.strip().startswith("SCRAPER_API_KEY="):
                        api_key = line.strip().split("=", 1)[1].strip().strip('"').strip("'")
                        break
    return api_key


def fetch_presto_page(url, api_key=None):
    """Fetch a PrestoSports page, using ScraperAPI if direct fetch fails."""
    # Try direct fetch first
    html = fetch_page(url)
    if html and len(html) > 2000:
        return html

    # Fallback to ScraperAPI
    if api_key:
        try:
            api_url = f"http://api.scraperapi.com?api_key={api_key}&url={url}"
            resp = requests.get(api_url, timeout=120)
            resp.raise_for_status()
            if len(resp.text) > 2000:
                return resp.text
        except Exception as e:
            logger.error(f"ScraperAPI failed for {url}: {e}")

    return None


def extract_future_nwac_games(season_year, today, team_map):
    """
    Extract future games from individual NWAC team schedule pages.
    Each team has a PrestoSports game-log page with their full season schedule.
    """
    season_str = f"{season_year - 1}-{str(season_year)[2:]}"
    api_key = get_scraper_api_key()

    if not api_key:
        logger.warning(
            "SCRAPER_API_KEY not set - NWAC games will likely be missing! "
            "Set it via: SCRAPER_API_KEY=your_key python3 scripts/scrape_future_schedules.py"
        )

    all_games = []
    for db_name, slug in NWAC_TEAM_SLUGS.items():
        url = f"https://nwacsports.com/sports/bsb/{season_str}/teams/{slug}?view=schedule"
        logger.info(f"Fetching NWAC {db_name}: {url}")

        html = fetch_presto_page(url, api_key)
        if not html:
            logger.warning(f"  {db_name}: failed to fetch schedule page")
            continue

        games = parse_presto_future_games(
            html, db_name, season_year, today, team_map,
            division="JUCO", conf_teams_set=NWAC_TEAMS_SET
        )
        all_games.extend(games)
        logger.info(f"  {db_name}: {len(games)} future games found")

        # Be nice to the server
        time.sleep(0.5)

    logger.info(f"NWAC total: {len(all_games)} future games from {len(NWAC_TEAM_SLUGS)} teams")
    return all_games


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
    Uses the shared parse_presto_future_games() parser.
    """
    presto_season = f"{season_year - 1}-{str(season_year)[2:]}"
    schedule_url = (
        f"https://www.wubearcats.com/sports/bsb/{presto_season}"
        f"/teams/willamette?view=schedule"
    )

    logger.info(f"Fetching Willamette schedule: {schedule_url}")

    api_key = get_scraper_api_key()
    html = fetch_presto_page(schedule_url, api_key)
    if not html:
        logger.warning("Willamette: failed to fetch schedule page")
        return []

    games = parse_presto_future_games(
        html, "Willamette", season_year, today, team_map,
        division="D3", conf_teams_set=NWC_TEAMS_SET_D3
    )
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

    # 4b. Validate is_conference: teams from different conferences can't play conf games
    # Build team_id -> conference_id lookup
    team_conf_map = {}
    for name, entry in team_map.items():
        if isinstance(entry, list):
            for e in entry:
                team_conf_map[e["team_id"]] = e["conference_id"]
        else:
            team_conf_map[entry["team_id"]] = entry["conference_id"]

    conf_fixes = 0
    for g in all_games:
        if g.get("is_conference"):
            home_id = g.get("home_team_id")
            away_id = g.get("away_team_id")
            if home_id and away_id:
                home_conf = team_conf_map.get(home_id)
                away_conf = team_conf_map.get(away_id)
                if home_conf and away_conf and home_conf != away_conf:
                    g["is_conference"] = False
                    conf_fixes += 1
    if conf_fixes:
        logger.info(f"Fixed {conf_fixes} games incorrectly marked as conference")

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
