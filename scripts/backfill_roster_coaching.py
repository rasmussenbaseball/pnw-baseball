#!/usr/bin/env python3
"""
Backfill roster bio data and coaching staff information for PNW College Baseball.

This script:
1. Creates a coaches table in Postgres (if not exists)
2. Scrapes roster bio data (hometown, height, weight, high_school, previous_school)
   and updates existing player records
3. Scrapes coaching staff data from team websites and populates the coaches table

Usage:
    cd pnw-baseball
    PYTHONPATH=backend python3 scripts/backfill_roster_coaching.py
    PYTHONPATH=backend python3 scripts/backfill_roster_coaching.py --roster-only
    PYTHONPATH=backend python3 scripts/backfill_roster_coaching.py --coaches-only
    PYTHONPATH=backend python3 scripts/backfill_roster_coaching.py --team Oregon --season 2026
"""

import sys
import os
import argparse
import json
import re
import time
import random
import logging
from pathlib import Path
from urllib.parse import urljoin

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

import requests
from bs4 import BeautifulSoup
from app.models.database import get_connection

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("backfill_roster_coaching")

# ============================================================
# User Agents
# ============================================================

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
]

# Request session and rate limiting
session = requests.Session()
last_request_time = 0


# ============================================================
# HTTP Fetching with Rate Limiting
# ============================================================


def _rate_limit():
    """Enforce 2-3 second delay between requests."""
    global last_request_time
    elapsed = time.time() - last_request_time
    delay = random.uniform(2.0, 3.0)
    if elapsed < delay:
        time.sleep(delay - elapsed)
    last_request_time = time.time()


def fetch_page(url, retries=3):
    """Fetch a URL with rate limiting and retries."""
    for attempt in range(retries):
        try:
            _rate_limit()
            headers = {
                "User-Agent": random.choice(USER_AGENTS),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
            }
            resp = session.get(url, headers=headers, timeout=30)
            resp.raise_for_status()
            logger.debug(f"Fetched {url}")
            return resp.text
        except requests.RequestException as e:
            if attempt < retries - 1:
                logger.debug(f"  Attempt {attempt + 1}/{retries} failed: {e}")
                time.sleep(2 ** attempt)

    logger.warning(f"Failed to fetch {url} after {retries} retries")
    return None


def fetch_json(url, retries=3):
    """Fetch a JSON endpoint with rate limiting and retries."""
    for attempt in range(retries):
        try:
            _rate_limit()
            headers = {
                "User-Agent": random.choice(USER_AGENTS),
                "Accept": "application/json",
            }
            resp = session.get(url, headers=headers, timeout=30)
            resp.raise_for_status()
            logger.debug(f"Fetched JSON {url}")
            return resp.json()
        except requests.RequestException as e:
            if attempt < retries - 1:
                logger.debug(f"  Attempt {attempt + 1}/{retries} failed: {e}")
                time.sleep(2 ** attempt)

    logger.warning(f"Failed to fetch JSON {url}")
    return None


# ============================================================
# Nuxt Payload Parsing
# ============================================================


def _nuxt_resolve(data, idx, depth=0):
    """Resolve a Nuxt devalue reference index to its actual value."""
    if depth > 6 or not isinstance(idx, int) or idx < 0 or idx >= len(data):
        return None
    val = data[idx]
    if isinstance(val, (str, int, float, bool)) or val is None:
        return val
    if isinstance(val, list) and len(val) == 2 and isinstance(val[0], str) and val[0] in (
        "ShallowReactive", "Reactive", "ShallowRef",
    ):
        return _nuxt_resolve(data, val[1], depth + 1)
    return None


def parse_nuxt_roster(html, base_url=""):
    """
    Extract player roster bio data from Nuxt 3 devalue payload.
    Returns dict of {name_lower: {hometown, height, weight, high_school, previous_school}}.
    """
    soup = BeautifulSoup(html, "html.parser")
    nuxt_script = soup.find("script", id="__NUXT_DATA__")
    if not nuxt_script or not nuxt_script.string:
        return {}

    try:
        data = json.loads(nuxt_script.string)
    except (json.JSONDecodeError, TypeError):
        return {}

    roster = {}

    # Look for player objects with firstName, lastName
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            continue
        if "firstName" not in item or "lastName" not in item:
            continue

        first = _nuxt_resolve(data, item.get("firstName", 0))
        last = _nuxt_resolve(data, item.get("lastName", 0))

        if not (first and last and isinstance(first, str) and isinstance(last, str)):
            continue

        name_key = f"{first} {last}".lower()
        if name_key in roster:
            continue  # Skip duplicates

        hometown = _nuxt_resolve(data, item.get("hometown", 0))
        weight = _nuxt_resolve(data, item.get("weight", 0))
        height_ft = _nuxt_resolve(data, item.get("heightFeet", 0))
        height_in = _nuxt_resolve(data, item.get("heightInches", 0))
        high_school = _nuxt_resolve(data, item.get("highSchool", 0))
        previous_school = _nuxt_resolve(data, item.get("previousSchool", 0))

        # Build height string
        height = ""
        if height_ft:
            height = str(int(height_ft)) if isinstance(height_ft, (int, float)) else str(height_ft)
            if height_in:
                height += f"-{int(height_in)}" if isinstance(height_in, (int, float)) else f"-{height_in}"

        roster[name_key] = {
            "hometown": str(hometown) if hometown else None,
            "height": height if height else None,
            "weight": int(weight) if isinstance(weight, (int, float)) and weight else None,
            "high_school": str(high_school) if high_school else None,
            "previous_school": str(previous_school) if previous_school else None,
        }

    logger.info(f"  Nuxt roster: extracted {len(roster)} players with bio data")
    return roster


def parse_roster_html(html, base_url=""):
    """
    Parse Sidearm HTML roster page to extract player bio data.
    Returns dict of {name_lower: {hometown, height, weight, high_school, previous_school}}.
    """
    soup = BeautifulSoup(html, "html.parser")
    roster = {}

    # Look for roster cards/list items
    roster_cards = soup.find_all(["div", "article", "li"],
                                 class_=re.compile(r"sidearm-roster|roster.*card|card.*roster", re.I))

    if not roster_cards:
        roster_cards = soup.find_all(["div", "article"],
                                     class_=re.compile(r"roster|card", re.I))

    for card in roster_cards:
        try:
            # Extract player name
            name_elem = card.find(["h3", "h2", "a"], class_=re.compile(r"name|player", re.I))
            if not name_elem:
                name_elem = card.find("a")
            if not name_elem:
                continue

            player_name = name_elem.get_text(strip=True)
            if not player_name:
                continue

            # Try to parse name (Last, First format is common)
            name_parts = player_name.split(",")
            if len(name_parts) == 2:
                first = name_parts[1].strip()
                last = name_parts[0].strip()
            else:
                parts = player_name.split()
                if len(parts) >= 2:
                    first = parts[0]
                    last = " ".join(parts[1:])
                else:
                    continue

            name_key = f"{first} {last}".lower()
            if name_key in roster:
                continue

            # Extract bio fields from card
            hometown = None
            height = None
            weight = None
            high_school = None
            previous_school = None

            # Look for bio text patterns in the card
            bio_text = card.get_text()

            # Try to find specific field labels and values
            for elem in card.find_all(["p", "div", "span"]):
                text = elem.get_text(strip=True)
                text_lower = text.lower()

                if "hometown" in text_lower:
                    val = elem.find_next(["p", "div", "span"])
                    if val:
                        hometown = val.get_text(strip=True)
                elif "high school" in text_lower:
                    val = elem.find_next(["p", "div", "span"])
                    if val:
                        high_school = val.get_text(strip=True)
                elif "height" in text_lower and "weight" in text_lower:
                    # Often combined as "5-10, 185 lbs"
                    val = elem.find_next(["p", "div", "span"])
                    if val:
                        val_text = val.get_text(strip=True)
                        # Try to parse "5-10, 185" format
                        match = re.search(r"(\d+)-(\d+)[,\s]+(\d+)", val_text)
                        if match:
                            height = f"{match.group(1)}-{match.group(2)}"
                            weight = int(match.group(3))
                elif "height" in text_lower:
                    val = elem.find_next(["p", "div", "span"])
                    if val:
                        height = val.get_text(strip=True)
                elif "weight" in text_lower:
                    val = elem.find_next(["p", "div", "span"])
                    if val:
                        weight_text = val.get_text(strip=True)
                        match = re.search(r"(\d+)", weight_text)
                        if match:
                            weight = int(match.group(1))

            roster[name_key] = {
                "hometown": hometown,
                "height": height,
                "weight": weight,
                "high_school": high_school,
                "previous_school": previous_school,
            }

        except Exception as e:
            logger.debug(f"Error parsing roster card: {e}")
            continue

    logger.info(f"  HTML roster: extracted {len(roster)} players")
    return roster


# ============================================================
# Coaching Staff Scraping
# ============================================================


def parse_nuxt_coaches(html, base_url=""):
    """
    Extract coaching staff from Nuxt 3 devalue payload.
    Returns list of {name, title, role, photo_url, email, phone, bio, alma_mater}.
    """
    soup = BeautifulSoup(html, "html.parser")
    nuxt_script = soup.find("script", id="__NUXT_DATA__")
    if not nuxt_script or not nuxt_script.string:
        return []

    try:
        data = json.loads(nuxt_script.string)
    except (json.JSONDecodeError, TypeError):
        return []

    coaches = []
    seen_names = set()

    # Look for coach objects with title/role fields
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            continue

        # Check if this looks like a coach object
        if "firstName" not in item or "lastName" not in item:
            continue

        # Skip if it has batting/pitching stats (it's a player, not a coach)
        if "battingAverage" in item or "earnedRunAverage" in item:
            continue

        first = _nuxt_resolve(data, item.get("firstName", 0))
        last = _nuxt_resolve(data, item.get("lastName", 0))

        if not (first and last and isinstance(first, str) and isinstance(last, str)):
            continue

        name = f"{first} {last}"
        if name in seen_names:
            continue
        seen_names.add(name)

        title = _nuxt_resolve(data, item.get("title", 0))
        role_code = _nuxt_resolve(data, item.get("roleCode", 0))

        # Try to infer role from title
        role = None
        if title and isinstance(title, str):
            title_lower = title.lower()
            if "head coach" in title_lower:
                role = "head_coach"
            elif "pitching" in title_lower:
                role = "pitching"
            elif "hitting" in title_lower:
                role = "hitting"
            elif "assistant" in title_lower:
                role = "assistant"
            elif "volunteer" in title_lower:
                role = "volunteer"

        photo = _nuxt_resolve(data, item.get("photo", 0))
        if photo and isinstance(photo, str):
            # Make absolute URL if relative
            if photo.startswith("/"):
                photo = urljoin(base_url, photo)
        else:
            photo = None

        email = _nuxt_resolve(data, item.get("email", 0))
        phone = _nuxt_resolve(data, item.get("phone", 0))
        bio = _nuxt_resolve(data, item.get("bio", 0))
        alma_mater = _nuxt_resolve(data, item.get("almaMater", 0))

        coaches.append({
            "name": name,
            "title": str(title) if title else None,
            "role": role,
            "photo_url": photo,
            "email": str(email) if email else None,
            "phone": str(phone) if phone else None,
            "bio": str(bio) if bio else None,
            "alma_mater": str(alma_mater) if alma_mater else None,
        })

    logger.info(f"  Nuxt coaches: extracted {len(coaches)} staff members")
    return coaches


def parse_coaches_html(html, base_url=""):
    """
    Parse Sidearm HTML coaches page to extract coaching staff.
    Returns list of {name, title, role, photo_url, email, phone, bio, alma_mater}.
    """
    soup = BeautifulSoup(html, "html.parser")
    coaches = []
    seen_names = set()

    # Look for coach cards
    coach_cards = soup.find_all(["div", "article"],
                                class_=re.compile(r"sidearm.*coach|coach.*card", re.I))

    if not coach_cards:
        coach_cards = soup.find_all(["div", "article"],
                                    class_=re.compile(r"coach", re.I))

    for card in coach_cards:
        try:
            # Extract coach name
            name_elem = card.find(["h2", "h3", "a"], class_=re.compile(r"name|coach", re.I))
            if not name_elem:
                name_elem = card.find(["h2", "h3"])
            if not name_elem:
                continue

            name = name_elem.get_text(strip=True)
            if not name or name in seen_names:
                continue
            seen_names.add(name)

            # Extract title/role
            title = None
            title_elem = card.find(["span", "div", "p"], class_=re.compile(r"title|role", re.I))
            if title_elem:
                title = title_elem.get_text(strip=True)

            # Infer role
            role = None
            if title and isinstance(title, str):
                title_lower = title.lower()
                if "head coach" in title_lower:
                    role = "head_coach"
                elif "pitching" in title_lower:
                    role = "pitching"
                elif "hitting" in title_lower:
                    role = "hitting"
                elif "assistant" in title_lower:
                    role = "assistant"
                elif "volunteer" in title_lower:
                    role = "volunteer"

            # Extract photo
            photo_url = None
            img = card.find("img")
            if img and img.get("src"):
                photo_url = img["src"]
                if photo_url.startswith("/"):
                    photo_url = urljoin(base_url, photo_url)

            # Extract email and phone
            email = None
            phone = None
            for link in card.find_all("a"):
                href = link.get("href", "")
                text = link.get_text(strip=True)
                if href.startswith("mailto:"):
                    email = href.replace("mailto:", "").strip()
                elif href.startswith("tel:"):
                    phone = href.replace("tel:", "").strip()

            # Extract bio
            bio = None
            bio_elem = card.find(["p", "div"], class_=re.compile(r"bio|description|about", re.I))
            if bio_elem:
                bio = bio_elem.get_text(strip=True)

            coaches.append({
                "name": name,
                "title": title,
                "role": role,
                "photo_url": photo_url,
                "email": email,
                "phone": phone,
                "bio": bio,
                "alma_mater": None,  # Usually not in HTML
            })

        except Exception as e:
            logger.debug(f"Error parsing coach card: {e}")
            continue

    logger.info(f"  HTML coaches: extracted {len(coaches)} staff members")
    return coaches


# ============================================================
# Database Operations
# ============================================================


def create_coaches_table():
    """Create coaches table if it doesn't exist."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS coaches (
                    id SERIAL PRIMARY KEY,
                    team_id INTEGER REFERENCES teams(id),
                    name TEXT NOT NULL,
                    title TEXT,
                    role TEXT,
                    photo_url TEXT,
                    email TEXT,
                    phone TEXT,
                    bio TEXT,
                    alma_mater TEXT,
                    years_at_school INTEGER,
                    season INTEGER DEFAULT 2026,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(team_id, name, season)
                );
            """)
    logger.info("Coaches table created/verified")


def upsert_coaches(team_id, coaches_list, season=2026):
    """Insert or update coaches for a team."""
    if not coaches_list:
        return 0

    with get_connection() as conn:
        with conn.cursor() as cur:
            inserted = 0
            for coach in coaches_list:
                cur.execute("""
                    INSERT INTO coaches (team_id, name, title, role, photo_url, email, phone, bio, alma_mater, season)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (team_id, name, season) DO UPDATE
                    SET title = EXCLUDED.title,
                        role = EXCLUDED.role,
                        photo_url = EXCLUDED.photo_url,
                        email = EXCLUDED.email,
                        phone = EXCLUDED.phone,
                        bio = EXCLUDED.bio,
                        alma_mater = EXCLUDED.alma_mater,
                        updated_at = CURRENT_TIMESTAMP;
                """, (
                    team_id,
                    coach["name"],
                    coach.get("title"),
                    coach.get("role"),
                    coach.get("photo_url"),
                    coach.get("email"),
                    coach.get("phone"),
                    coach.get("bio"),
                    coach.get("alma_mater"),
                    season,
                ))
                inserted += 1

    return inserted


def update_player_roster_fields(team_id, roster_dict, season=2026):
    """
    Update player records with roster bio data.
    Only updates fields that are currently NULL.
    """
    if not roster_dict:
        return 0, 0, 0

    with get_connection() as conn:
        with conn.cursor() as cur:
            # Get all players for this team
            cur.execute("""
                SELECT id, name_lower FROM players
                WHERE team_id = %s
            """, (team_id,))

            players = cur.fetchall()
            updated_hometown = 0
            updated_dimensions = 0
            updated_school = 0

            for player in players:
                player_id = player["id"]
                name_key = player["name_lower"]

                if name_key not in roster_dict:
                    continue

                bio = roster_dict[name_key]

                # Update hometown if NULL
                if bio.get("hometown"):
                    cur.execute("""
                        UPDATE players
                        SET hometown = %s
                        WHERE id = %s AND hometown IS NULL
                    """, (bio["hometown"], player_id))
                    if cur.rowcount > 0:
                        updated_hometown += 1

                # Update height if NULL
                if bio.get("height"):
                    cur.execute("""
                        UPDATE players
                        SET height = %s
                        WHERE id = %s AND height IS NULL
                    """, (bio["height"], player_id))
                    if cur.rowcount > 0:
                        updated_dimensions += 1

                # Update weight if NULL
                if bio.get("weight"):
                    cur.execute("""
                        UPDATE players
                        SET weight = %s
                        WHERE id = %s AND weight IS NULL
                    """, (bio["weight"], player_id))

                # Update high_school if NULL
                if bio.get("high_school"):
                    cur.execute("""
                        UPDATE players
                        SET high_school = %s
                        WHERE id = %s AND high_school IS NULL
                    """, (bio["high_school"], player_id))
                    if cur.rowcount > 0:
                        updated_school += 1

                # Update previous_school if NULL
                if bio.get("previous_school"):
                    cur.execute("""
                        UPDATE players
                        SET previous_school = %s
                        WHERE id = %s AND previous_school IS NULL
                    """, (bio["previous_school"], player_id))

    return updated_hometown, updated_dimensions, updated_school


# ============================================================
# Main Processing
# ============================================================


def scrape_roster_for_team(team_id, team_name, stats_url, season=2026):
    """
    Scrape roster data for a team and update player records.
    Returns (hometown_updates, dimension_updates, school_updates).
    """
    if not stats_url:
        logger.warning(f"  {team_name}: no stats_url")
        return 0, 0, 0

    # Construct roster URL
    roster_url = stats_url.replace("/stats", "/roster")
    if not roster_url or roster_url == stats_url:
        # Fallback: try standard Sidearm pattern
        base_url = stats_url.split("/sports/")[0]
        roster_url = f"{base_url}/sports/baseball/roster/{season}"

    logger.info(f"  Scraping roster from {roster_url}")

    # Try JSON endpoint first
    json_url = f"{roster_url}/{season}?json"
    json_data = fetch_json(json_url)
    if json_data:
        # Parse JSON roster data (similar to Sidearm JSON format)
        roster_dict = {}
        try:
            if isinstance(json_data, list):
                players = json_data
            elif isinstance(json_data, dict) and "roster" in json_data:
                players = json_data["roster"]
            else:
                players = []

            for player in players:
                if not isinstance(player, dict):
                    continue
                first = player.get("first_name", "").strip()
                last = player.get("last_name", "").strip()
                if not (first and last):
                    continue

                name_key = f"{first} {last}".lower()
                roster_dict[name_key] = {
                    "hometown": player.get("hometown"),
                    "height": player.get("height"),
                    "weight": player.get("weight"),
                    "high_school": player.get("high_school"),
                    "previous_school": player.get("previous_school"),
                }

            if roster_dict:
                logger.info(f"    JSON: found {len(roster_dict)} players")
                return update_player_roster_fields(team_id, roster_dict, season)
        except Exception as e:
            logger.debug(f"    JSON parsing failed: {e}")

    # Try HTML page
    html = fetch_page(roster_url)
    if html:
        # Try Nuxt payload first
        roster_dict = parse_nuxt_roster(html, roster_url)
        if roster_dict:
            return update_player_roster_fields(team_id, roster_dict, season)

        # Fall back to HTML parsing
        roster_dict = parse_roster_html(html, roster_url)
        if roster_dict:
            return update_player_roster_fields(team_id, roster_dict, season)

    logger.warning(f"  {team_name}: failed to scrape roster")
    return 0, 0, 0


def scrape_coaches_for_team(team_id, team_name, stats_url, season=2026):
    """
    Scrape coaching staff for a team and populate coaches table.
    Returns count of coaches inserted/updated.
    """
    if not stats_url:
        logger.warning(f"  {team_name}: no stats_url")
        return 0

    # Construct coaches URL
    base_url = stats_url.split("/sports/")[0]
    coaches_url = f"{base_url}/sports/baseball/coaches"

    logger.info(f"  Scraping coaches from {coaches_url}")

    # Try JSON endpoint first
    json_url = f"{coaches_url}?json"
    json_data = fetch_json(json_url)
    if json_data:
        coaches_list = []
        try:
            if isinstance(json_data, list):
                staff = json_data
            elif isinstance(json_data, dict) and "coaches" in json_data:
                staff = json_data["coaches"]
            else:
                staff = []

            for coach in staff:
                if not isinstance(coach, dict):
                    continue
                name = coach.get("name")
                if not name:
                    continue

                coaches_list.append({
                    "name": name,
                    "title": coach.get("title"),
                    "role": coach.get("role"),
                    "photo_url": coach.get("photo_url"),
                    "email": coach.get("email"),
                    "phone": coach.get("phone"),
                    "bio": coach.get("bio"),
                    "alma_mater": coach.get("alma_mater"),
                })

            if coaches_list:
                logger.info(f"    JSON: found {len(coaches_list)} coaches")
                return upsert_coaches(team_id, coaches_list, season)
        except Exception as e:
            logger.debug(f"    JSON parsing failed: {e}")

    # Try HTML page
    html = fetch_page(coaches_url)
    if html:
        # Try Nuxt payload first
        coaches_list = parse_nuxt_coaches(html, coaches_url)
        if coaches_list:
            return upsert_coaches(team_id, coaches_list, season)

        # Fall back to HTML parsing
        coaches_list = parse_coaches_html(html, coaches_url)
        if coaches_list:
            return upsert_coaches(team_id, coaches_list, season)

    logger.warning(f"  {team_name}: failed to scrape coaches")
    return 0


# ============================================================
# Main Entry Point
# ============================================================


def main():
    parser = argparse.ArgumentParser(
        description="Backfill roster bio data and coaching staff information"
    )
    parser.add_argument(
        "--team",
        type=str,
        help="Filter to one team (short_name)",
    )
    parser.add_argument(
        "--season",
        type=int,
        default=2026,
        help="Season year (default 2026)",
    )
    parser.add_argument(
        "--roster-only",
        action="store_true",
        help="Only scrape roster data (skip coaches)",
    )
    parser.add_argument(
        "--coaches-only",
        action="store_true",
        help="Only scrape coaches (skip roster)",
    )
    args = parser.parse_args()

    # Create coaches table
    if not args.roster_only:
        create_coaches_table()

    # Get all teams with stats_url
    with get_connection() as conn:
        with conn.cursor() as cur:
            if args.team:
                cur.execute("""
                    SELECT id, name, short_name, stats_url, stats_format
                    FROM teams
                    WHERE short_name = %s AND stats_url IS NOT NULL
                """, (args.team,))
            else:
                cur.execute("""
                    SELECT id, name, short_name, stats_url, stats_format
                    FROM teams
                    WHERE stats_url IS NOT NULL
                    ORDER BY short_name
                """)

            teams = cur.fetchall()

    if not teams:
        logger.info("No teams to process")
        return

    logger.info(f"Processing {len(teams)} team(s)")

    total_hometown = 0
    total_dimensions = 0
    total_school = 0
    total_coaches = 0

    for idx, team in enumerate(teams, 1):
        team_id = team["id"]
        team_name = team["name"]
        short_name = team["short_name"]
        stats_url = team["stats_url"]

        logger.info(f"\n[{idx}/{len(teams)}] {team_name}")

        if not args.coaches_only:
            h, d, s = scrape_roster_for_team(team_id, team_name, stats_url, args.season)
            total_hometown += h
            total_dimensions += d
            total_school += s

        if not args.roster_only:
            c = scrape_coaches_for_team(team_id, team_name, stats_url, args.season)
            total_coaches += c

    logger.info("\n" + "=" * 60)
    logger.info(f"SUMMARY:")
    if not args.coaches_only:
        logger.info(f"  Updated {total_hometown} players with hometown data")
        logger.info(f"  Updated {total_dimensions} players with height/weight")
        logger.info(f"  Updated {total_school} players with high school data")
    if not args.roster_only:
        logger.info(f"  Scraped/updated {total_coaches} coaches")
    logger.info("=" * 60)


if __name__ == "__main__":
    main()
