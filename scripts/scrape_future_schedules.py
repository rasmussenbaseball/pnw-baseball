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
    """Build a mapping of team short_name -> (team_id, conference_id, division_level)."""
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
        team_map[r["short_name"]] = {
            "team_id": r["id"],
            "conference_id": r["conference_id"],
            "division_level": r["division_level"],
            "conference_name": r["conference_name"],
        }
    return team_map


# ============================================================
# Sidearm Schedule Extraction (full season, future games only)
# ============================================================

def extract_future_sidearm_games(team_name, team_info, season, today, team_map):
    """Extract all future scheduled games from a Sidearm team's schedule page."""
    base_url = team_info["url"]
    sport = team_info["sport"]
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

        # Resolve team IDs
        team_info_db = team_map.get(team_name, {})
        opp_info_db = team_map.get(opp_key, {})

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
    """Fallback: extract future games from legacy Sidearm HTML."""
    soup = BeautifulSoup(html, "html.parser")
    games = []

    game_items = soup.find_all("div", class_="sidearm-schedule-game")
    if not game_items:
        game_items = soup.find_all("div", class_=re.compile(r"sidearm-schedule-game\b"))

    for item in game_items:
        try:
            # Get date
            date_el = item.find(class_=re.compile(r"sidearm-schedule-game-opponent-date"))
            if not date_el:
                continue

            date_text = date_el.get_text(" ", strip=True)
            date_match = re.match(r'(\w+)\s+(\d+)', date_text)
            if not date_match:
                continue

            month_str = date_match.group(1)
            day_str = date_match.group(2)

            game_date = None
            for fmt in ("%b %d", "%B %d"):
                try:
                    dt = datetime.strptime(f"{month_str} {day_str}", fmt)
                    # Determine correct year
                    year = today.year
                    if dt.month < 3 and today.month > 8:
                        year += 1
                    game_date = dt.replace(year=year).date()
                    break
                except ValueError:
                    continue

            if not game_date or game_date <= today:
                continue

            # Check if game has a score (if so, it's already played)
            full_text = item.get_text(" ", strip=True)
            if re.search(r'[WLT],?\s*\d+\s*-\s*\d+', full_text):
                continue

            # Get opponent
            name_el = item.find(class_=re.compile(r"sidearm-schedule-game-opponent-name"))
            if not name_el:
                continue
            opp_link = name_el.find("a")
            opponent = opp_link.get_text(strip=True) if opp_link else name_el.get_text(strip=True)
            opponent = re.sub(r'\s*\(DH\)\s*', '', opponent).strip()
            opp_clean = re.sub(r'^#\d+\s+', '', opponent).strip()
            opp_key = normalize_team_name(opp_clean)

            # Location
            text_el = item.find(class_=re.compile(r"sidearm-schedule-game-opponent-text"))
            location = "home"
            if text_el and text_el.get_text(" ", strip=True).lower().startswith("at"):
                location = "away"

            # Conference
            is_conf = bool(item.find(class_=re.compile(r"conference")))

            team_info_db = team_map.get(team_name, {})
            opp_info_db = team_map.get(opp_key, {})

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

    api_key = os.environ.get("SCRAPER_API_KEY", "")
    if api_key:
        url = f"http://api.scraperapi.com?api_key={api_key}&url={schedule_url}"
        logger.info(f"Fetching NWAC schedule via ScraperAPI: {schedule_url}")
    else:
        url = schedule_url
        logger.info(f"Fetching NWAC schedule directly: {schedule_url}")

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

    current_date = None

    for row in rows:
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

        # Check status - skip completed games
        status_text = status_cell.get_text(strip=True) if status_cell else ""
        if "Final" in status_text:
            # Still extract date from this row for tracking
            if links_cell:
                link = links_cell.find("a", href=re.compile(r"boxscores/"))
                if link:
                    href = link.get("href", "")
                    date_match = re.search(r"boxscores/(\d{4})(\d{2})(\d{2})_", href)
                    if date_match:
                        try:
                            current_date = dt_module.date(
                                int(date_match.group(1)),
                                int(date_match.group(2)),
                                int(date_match.group(3)),
                            )
                        except ValueError:
                            pass
            continue

        # Parse date from links or date cell
        game_date = None
        if links_cell:
            link = links_cell.find("a", href=re.compile(r"boxscores/|(\d{8})"))
            if link:
                href = link.get("href", "")
                date_match = re.search(r"(\d{4})(\d{2})(\d{2})", href)
                if date_match:
                    try:
                        game_date = dt_module.date(
                            int(date_match.group(1)),
                            int(date_match.group(2)),
                            int(date_match.group(3)),
                        )
                        current_date = game_date
                    except ValueError:
                        pass

        # Try date cell if no date from links
        if not game_date:
            date_cell = row.find("td", class_="date")
            if date_cell:
                date_text = date_cell.get_text(strip=True)
                # Format varies: "Sun. 14", "Mon. 15", etc
                day_match = re.search(r'(\d+)', date_text)
                if day_match and current_date:
                    day = int(day_match.group(1))
                    try:
                        # Use current_date's month/year as base, advance if needed
                        test = current_date.replace(day=day)
                        if test < current_date:
                            # Probably next month
                            if current_date.month == 12:
                                test = test.replace(year=current_date.year + 1, month=1)
                            else:
                                test = test.replace(month=current_date.month + 1)
                        game_date = test
                        current_date = game_date
                    except ValueError:
                        pass

        if not game_date:
            game_date = current_date

        if not game_date or game_date <= today:
            continue

        # Conference game?
        is_conference = bool(away_team_cell.find("span", class_="notation"))

        # Resolve names
        away_db = resolve_nwac_name(away_name)
        home_db = resolve_nwac_name(home_name)

        away_info = team_map.get(away_db, {})
        home_info = team_map.get(home_db, {})

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
# Deduplication
# ============================================================

def deduplicate_future_games(games):
    """
    Remove duplicate games that appear from both teams' schedules.
    Uses (date, home, away) as the dedup key.
    """
    seen = {}
    deduped = []

    for g in games:
        # Normalize team names for dedup
        home = normalize_team_name(g["home_team"])
        away = normalize_team_name(g["away_team"])
        game_date = g["game_date"]

        # Create canonical key (sorted teams + date)
        key = (game_date, tuple(sorted([home, away])))

        if key not in seen:
            seen[key] = g
            deduped.append(g)
        else:
            # Prefer version with team IDs
            existing = seen[key]
            if not existing.get("home_team_id") and g.get("home_team_id"):
                seen[key] = g
                deduped[deduped.index(existing)] = g
            elif not existing.get("away_team_id") and g.get("away_team_id"):
                # Merge IDs
                existing["away_team_id"] = g["away_team_id"]

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

    # 3. Deduplicate
    before_count = len(all_games)
    all_games = deduplicate_future_games(all_games)
    logger.info(f"Deduplicated: {before_count} -> {len(all_games)} games")

    # 4. Sort by date
    all_games.sort(key=lambda g: g["game_date"])

    # 5. Write output
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
