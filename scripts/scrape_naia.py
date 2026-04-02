#!/usr/bin/env python3
"""
NAIA (CCC) Baseball Stats Scraper
===================================

Scrapes batting, pitching, and roster data from CCC team athletics websites
(Sidearm Sports platform) and populates the PNW Baseball database.

All CCC teams use Sidearm Sports, which serves stats as server-rendered HTML
tables on each team's own athletics site.

Stats page: {team_url}/sports/baseball/stats
  - Contains Overall and Conference batting, pitching, and fielding tables
  - Batting columns: #, Player, AVG, OPS, GP-GS, AB, R, H, 2B, 3B, HR, RBI,
                      TB, SLG%, BB, HBP, SO, GDP, OB%, SF, SH, SB-ATT
  - Pitching columns: #, Player, ERA, WHIP, W-L, APP-GS, CG, SHO, SV, IP,
                       H, R, ER, BB, SO, 2B, 3B, HR, AB/B/AVG, WP, HBP, BK, SFA, SHA
  - Player names are in "Last, First" format

Roster page: {team_url}/sports/baseball/roster
  - Card-style layout with position, height, weight, bats/throws, hometown, etc.
  - Also accessible via JSON: /services/responsive-roster.ashx?sport_id=1&year={season}

Usage:
    cd pnw-baseball
    PYTHONPATH=backend python scripts/scrape_naia.py --season 2026
    PYTHONPATH=backend python scripts/scrape_naia.py --season 2026 --team lcsc
    PYTHONPATH=backend python scripts/scrape_naia.py --season 2026 --skip-rosters
"""

import sys
import os
import time
import random
import argparse
import logging
import re
import json
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import requests
from bs4 import BeautifulSoup, NavigableString

from app.models.database import get_connection, init_db, seed_divisions_and_conferences
from app.stats.advanced import (
    BattingLine, PitchingLine,
    compute_batting_advanced, compute_pitching_advanced, compute_college_war,
    normalize_position, DEFAULT_WEIGHTS,
)
from record_utils import extract_record_from_html, save_team_record

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("scrape_naia")

# ============================================================
# CCC Team Configuration
# ============================================================

# Map DB short_name -> team's Sidearm athletics base URL
CCC_TEAMS = {
    "LCSC":          "https://lcwarriors.com",
    "EOU":           "https://eousports.com",
    "OIT":           "https://oregontechowls.com",
    "C of I":        "https://yoteathletics.com",
    "Corban":        "https://corbanwarriors.com",
    "Bushnell":      "https://bushnellbeacons.com",
    "Warner Pacific": "https://wpuknights.com",
    "UBC":           "https://gothunderbirds.ca",
}

# Short aliases for CLI --team flag
TEAM_ALIASES = {
    "lcsc": "LCSC",
    "lewis-clark": "LCSC",
    "eou": "EOU",
    "eastern-oregon": "EOU",
    "oit": "OIT",
    "oregon-tech": "OIT",
    "cofi": "C of I",
    "college-of-idaho": "C of I",
    "corban": "Corban",
    "bushnell": "Bushnell",
    "warner": "Warner Pacific",
    "warner-pacific": "Warner Pacific",
    "ubc": "UBC",
    "british-columbia": "UBC",
}

USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
]


# ============================================================
# HTTP Fetching
# ============================================================

session = requests.Session()
last_request_time = 0


def fetch_page(url, retries=3):
    """Fetch a URL with rate limiting and retries."""
    global last_request_time

    for attempt in range(retries):
        try:
            elapsed = time.time() - last_request_time
            delay = random.uniform(2.0, 4.0)
            if elapsed < delay:
                time.sleep(delay - elapsed)

            headers = {
                "User-Agent": random.choice(USER_AGENTS),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
            }
            resp = session.get(url, headers=headers, timeout=30)
            last_request_time = time.time()
            resp.raise_for_status()
            logger.debug(f"Fetched {url} ({len(resp.text)} bytes)")
            return resp.text

        except requests.RequestException as e:
            logger.warning(f"  Attempt {attempt+1}/{retries} failed for {url}: {e}")
            if attempt < retries - 1:
                time.sleep(3 ** attempt)

    logger.error(f"All retries failed for {url}")
    return None


def fetch_json(url, params=None, retries=3):
    """Fetch a JSON endpoint with rate limiting and retries."""
    global last_request_time

    for attempt in range(retries):
        try:
            elapsed = time.time() - last_request_time
            delay = random.uniform(2.0, 4.0)
            if elapsed < delay:
                time.sleep(delay - elapsed)

            headers = {
                "User-Agent": random.choice(USER_AGENTS),
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "X-Requested-With": "XMLHttpRequest",
            }
            resp = session.get(url, headers=headers, params=params, timeout=30)
            last_request_time = time.time()
            resp.raise_for_status()
            return resp.json()

        except (requests.RequestException, ValueError) as e:
            logger.warning(f"  Attempt {attempt+1}/{retries} failed for JSON {url}: {e}")
            if attempt < retries - 1:
                time.sleep(3 ** attempt)

    logger.error(f"All retries failed for JSON {url}")
    return None


# ============================================================
# HTML Parsing — Sidearm Stats Tables
# ============================================================

def find_stats_tables(html):
    """
    Find the Overall batting and pitching tables in a Sidearm stats page.

    Sidearm stats pages have multiple table sections:
      - Individual Overall Batting Statistics
      - Individual Overall Pitching Statistics
      - Individual Overall Fielding Statistics
      - (then Conference versions of each)

    We want the Overall tables (not Conference).
    """
    soup = BeautifulSoup(html, "html.parser")

    batting_table = None
    pitching_table = None

    # Strategy: find all <table> elements that look like stat tables
    # Sidearm tables have class "sidearm-table" and are inside sections
    # We can identify batting vs pitching by the preceding heading text
    tables = soup.find_all("table")

    for table in tables:
        # Look for the heading/caption above the table
        # Walk up to find a heading or caption-like element
        heading_text = ""

        # Check for a caption element
        caption = table.find("caption")
        if caption:
            heading_text = caption.get_text(strip=True).lower()

        # Check preceding siblings/parent for heading text
        if not heading_text:
            prev = table.find_previous(["h2", "h3", "h4", "caption", "div"])
            if prev:
                heading_text = prev.get_text(strip=True).lower()

        # Get headers to identify table type
        thead = table.find("thead")
        if not thead:
            continue
        header_cells = thead.find_all(["th", "td"])
        header_text = " ".join(c.get_text(strip=True) for c in header_cells).lower()

        # Identify batting table: has "avg" and "ab" columns, but not "era"
        if "avg" in header_text and "ab" in header_text and "era" not in header_text:
            # Make sure this is "Overall" not "Conference"
            if "conference" not in heading_text:
                if batting_table is None:
                    batting_table = table
                    logger.debug(f"Found batting table (heading: {heading_text[:50]})")

        # Identify pitching table: has "era" and "ip" columns
        elif "era" in header_text and "ip" in header_text:
            if "conference" not in heading_text:
                if pitching_table is None:
                    pitching_table = table
                    logger.debug(f"Found pitching table (heading: {heading_text[:50]})")

    return batting_table, pitching_table


def parse_sidearm_table(table):
    """
    Parse a Sidearm HTML stats table into a list of dicts.

    Each row maps header names -> cell values.
    Skips totals/opponents rows.
    """
    if table is None:
        return []

    # Extract headers
    thead = table.find("thead")
    if not thead:
        return []

    raw_headers = []
    for cell in thead.find_all(["th", "td"]):
        text = cell.get_text(strip=True)
        # Some headers have sort links; extract the core text
        link = cell.find("a")
        if link:
            text = link.get_text(strip=True)
        raw_headers.append(text)

    if len(raw_headers) < 5:
        logger.warning(f"Table has too few headers: {raw_headers}")
        return []

    # Parse body rows
    rows = []
    tbody = table.find("tbody")
    trs = tbody.find_all("tr") if tbody else table.find_all("tr")[1:]

    for tr in trs:
        # Skip footer/totals rows
        tr_class = " ".join(tr.get("class", []))
        if "footer" in tr_class or "totals" in tr_class:
            continue

        cells = tr.find_all(["td", "th"])
        if len(cells) < 5:
            continue

        row = {}
        for i, cell in enumerate(cells):
            if i < len(raw_headers):
                header = raw_headers[i]

                # Special handling for Player column: Sidearm embeds
                # jersey number and first name as <span> children inside the
                # player <a> tag alongside the "Last, First" text node.
                # get_text() concatenates everything → "Bryce8Johnson, Bryce".
                # We extract only the direct text nodes of the <a> tag.
                if header.lower() == "player":
                    link = cell.find("a")
                    if link:
                        row["player_url"] = link.get("href", "")
                        pid = link.get("data-player-id") or cell.get("data-player-id")
                        if pid:
                            row["sidearm_player_id"] = pid

                        # Get only direct text nodes (skip span children)
                        direct_text = "".join(
                            child.strip()
                            for child in link.children
                            if isinstance(child, NavigableString)
                        ).strip()

                        if direct_text and "," in direct_text:
                            value = direct_text
                        else:
                            # Fallback: try regex to extract "Last, First" from full text
                            full_text = link.get_text(strip=True)
                            name_match = re.search(r'([A-Za-z\'\-\. ]+,\s*[A-Za-z\'\-\. ]+)$', full_text)
                            if name_match:
                                value = name_match.group(1)
                            else:
                                value = full_text
                    else:
                        value = cell.get_text(strip=True)
                else:
                    value = cell.get_text(strip=True)

                row[header] = value

        # Check if this is a totals/team row
        player_name = row.get("Player", "").strip()
        if player_name.lower() in ("totals", "total", "team", "opponents", "opponent", ""):
            continue

        rows.append(row)

    return rows


# ============================================================
# Roster Parsing
# ============================================================

def fetch_sidearm_roster_json(base_url, season_year):
    """
    Try the Sidearm JSON roster API first — much more reliable than HTML parsing.
    Returns dict keyed by "last, first" lowercase for matching with stats.
    """
    roster = {}

    # Sidearm responsive roster JSON endpoint
    # sport_id=1 is baseball on most Sidearm sites
    for sport_id in [1, 2, 3, 4, 5]:
        url = f"{base_url}/services/responsive-roster.ashx"
        params = {"sport_id": sport_id}
        if season_year:
            params["year"] = season_year
        data = fetch_json(url, params=params)
        if data and isinstance(data, list) and len(data) > 0:
            # Check if this looks like a baseball roster (has pitcher-related positions)
            sample_positions = [
                (p.get("position_long") or p.get("position_short") or "").upper()
                for p in data[:10]
            ]
            has_baseball = any(
                pos in ("P", "RHP", "LHP", "C", "1B", "2B", "3B", "SS", "OF",
                         "IF", "DH", "UTIL", "INF", "CF", "LF", "RF", "UT",
                         "PITCHER", "CATCHER")
                for pos in sample_positions
            )
            if has_baseball or len(data) > 15:
                logger.info(f"  Found JSON roster with sport_id={sport_id}: {len(data)} players")
                for p in data:
                    try:
                        first = (p.get("first_name") or "").strip()
                        last = (p.get("last_name") or "").strip()
                        if not first and not last:
                            # Try full_name field
                            full = (p.get("full_name") or "").strip()
                            if "," in full:
                                last, first = full.split(",", 1)
                                first, last = first.strip(), last.strip()
                            elif full:
                                parts = full.split()
                                first = parts[0] if parts else ""
                                last = " ".join(parts[1:]) if len(parts) > 1 else ""

                        if not last:
                            continue

                        key = f"{last}, {first}".lower()

                        # Extract headshot URL from JSON
                        headshot_url = None
                        for field in ["image", "headshot", "photo", "player_image", "profile_image",
                                     "roster_image", "thumbnail", "headshot_url", "photo_url", "image_url"]:
                            if p.get(field):
                                headshot_url = str(p.get(field)).strip()
                                break
                        # Make relative URLs absolute using base_url
                        if headshot_url and not headshot_url.startswith(("http://", "https://", "//")):
                            headshot_url = base_url.rstrip("/") + "/" + headshot_url.lstrip("/")

                        position = (
                            p.get("position_long")
                            or p.get("position_short")
                            or p.get("position")
                            or ""
                        ).strip()

                        height = (p.get("height") or "").strip()
                        weight_raw = p.get("weight") or ""
                        weight = safe_int(str(weight_raw).replace("lbs", "").strip())

                        year = (
                            p.get("year_long")
                            or p.get("academic_year")
                            or p.get("year")
                            or ""
                        ).strip()

                        hometown = (p.get("hometown") or "").strip()
                        high_school = (
                            p.get("highschool")
                            or p.get("high_school")
                            or p.get("previous_school")
                            or ""
                        ).strip()
                        previous_school = (p.get("previous_school") or "").strip()

                        jersey = (
                            p.get("jersey")
                            or p.get("uniform_number")
                            or ""
                        ).strip()

                        # Bats/throws: some APIs have separate fields, some have "B/T"
                        bats = (p.get("bats") or "").strip() or None
                        throws = (p.get("throws") or "").strip() or None
                        if not bats and not throws:
                            bt = p.get("bat_throw") or p.get("b_t") or ""
                            bt_match = re.search(r'([LRBS])/([LR])', bt)
                            if bt_match:
                                bats = bt_match.group(1)
                                throws = bt_match.group(2)

                        roster[key] = {
                            "full_name": f"{first} {last}",
                            "jersey": jersey,
                            "position": position,
                            "height": height,
                            "weight": weight or None,
                            "year": year,
                            "hometown": hometown,
                            "high_school": high_school,
                            "previous_school": previous_school,
                            "bats": bats,
                            "throws": throws,
                            "headshot_url": headshot_url,
                        }
                    except Exception as e:
                        logger.debug(f"Error parsing JSON roster entry: {e}")
                        continue

                return roster

    return roster


def parse_nuxt_roster(html, base_url=""):
    """
    Extract player roster data (including headshot URLs) from Nuxt 3 devalue payload.

    Modern Sidearm sites render rosters client-side from a __NUXT_DATA__ script tag.
    BeautifulSoup can't see the rendered DOM, but we can parse the payload directly.

    Returns dict keyed by "first last" (lowercase) with bio fields + headshot_url.
    """
    soup = BeautifulSoup(html, "html.parser")
    nuxt_script = soup.find("script", id="__NUXT_DATA__")
    if not nuxt_script or not nuxt_script.string:
        return {}

    try:
        data = json.loads(nuxt_script.string)
    except (json.JSONDecodeError, TypeError):
        return {}

    def resolve(idx):
        """Resolve a devalue index to its primitive value."""
        if not isinstance(idx, int) or idx < 0 or idx >= len(data):
            return None
        val = data[idx]
        if isinstance(val, (str, int, float, bool)) or val is None:
            return val
        if isinstance(val, list) and len(val) >= 2 and val[0] in (
            "ShallowReactive", "Reactive", "ShallowRef",
        ):
            return resolve(val[1])
        return None

    roster_by_name = {}

    for i, item in enumerate(data):
        if not isinstance(item, dict):
            continue
        if "players" not in item or "season" not in item or "sport" not in item:
            continue

        players_idx = item["players"]
        if not isinstance(players_idx, int) or players_idx >= len(data):
            continue
        players_arr = data[players_idx]
        if not isinstance(players_arr, list):
            continue

        for p_idx in players_arr:
            if not isinstance(p_idx, int) or p_idx >= len(data):
                continue
            player = data[p_idx]
            if not isinstance(player, dict):
                continue
            if "firstName" not in player or "lastName" not in player:
                continue

            first = resolve(player["firstName"]) or ""
            last = resolve(player["lastName"]) or ""
            if not first or not last:
                continue

            headshot = ""
            img_idx = player.get("image")
            if isinstance(img_idx, int) and img_idx < len(data):
                img_obj = data[img_idx]
                if isinstance(img_obj, dict):
                    for url_key in ("absoluteUrl", "url"):
                        url_idx = img_obj.get(url_key)
                        if url_idx is not None:
                            url_val = resolve(url_idx)
                            if url_val and isinstance(url_val, str) and "/" in url_val:
                                if url_val.startswith("http"):
                                    headshot = url_val
                                elif url_val.startswith("/"):
                                    headshot = base_url.rstrip("/") + url_val
                                break

            ft = resolve(player.get("heightFeet", -1))
            inches = resolve(player.get("heightInches", -1))
            height = f"{ft}-{inches}" if ft and inches else ""

            name_key = f"{first} {last}".lower()
            roster_by_name[name_key] = {
                "position": resolve(player.get("positionShort", -1)) or "",
                "jersey": resolve(player.get("jerseyNumber", -1)) or "",
                "year": resolve(player.get("academicYearShort", -1)) or "",
                "bats": "",
                "throws": "",
                "height": height,
                "weight": str(resolve(player.get("weight", -1)) or ""),
                "hometown": resolve(player.get("hometown", -1)) or "",
                "high_school": resolve(player.get("highSchool", -1)) or "",
                "previous_school": resolve(player.get("previousSchool", -1)) or "",
                "headshot_url": headshot,
            }

        if roster_by_name:
            break

    return roster_by_name


def parse_sidearm_roster(html, base_url=""):
    """
    Parse a Sidearm roster page HTML to extract player bio data.
    Returns dict keyed by "last, first" lowercase for matching.

    Uses multiple fallback strategies for different Sidearm HTML layouts:
    1. <li> elements with class containing "sidearm-roster-player"
    2. <div> elements with class containing "sidearm-roster-player"
    3. <table> based roster layouts
    """
    soup = BeautifulSoup(html, "html.parser")
    roster = {}

    # Strategy 1: Sidearm card layout — match ONLY <li class="sidearm-roster-player">
    # IMPORTANT: Must use exact class match, NOT regex, because regex would also
    # match child divs like "sidearm-roster-player-name" which contain the name
    # but NOT position/year, causing those to overwrite the real card's data.
    player_cards = soup.find_all("li", class_="sidearm-roster-player")
    if not player_cards:
        # Strategy 2: some Sidearm sites use div-based cards
        player_cards = soup.find_all("div", class_="sidearm-roster-player")
    if not player_cards:
        # Strategy 3: broader search for other roster layouts
        player_cards = soup.find_all(
            ["li", "div", "article"],
            class_=re.compile(r"^roster-player$|^roster_player$|^s-person-card$")
        )
    if not player_cards:
        # Strategy 4: look for roster table rows
        roster_table = soup.find("table", class_=re.compile(r"roster"))
        if roster_table:
            player_cards = roster_table.find_all("tr")[1:]  # skip header

    for card in player_cards:
        try:
            # Extract jersey number
            jersey_el = card.find(class_=re.compile(r"sidearm-roster-player-jersey-number|jersey|uniform"))
            jersey = jersey_el.get_text(strip=True) if jersey_el else ""

            # Extract name: target <h3><a> or <h4><a> which has clean "First Last"
            # IMPORTANT: card.find("a") returns the image link (empty text),
            # and the .sidearm-roster-player-name div contains jersey+name.
            # The clean name is always inside an <h3> or <h4> tag.
            name_el = (
                card.find("h3")
                or card.find("h4")
                or card.find("a", href=re.compile(r"/sports/baseball/roster/\w"))
            )
            if name_el:
                # If h3/h4, get the <a> inside it for clean text
                link = name_el.find("a") if name_el.name in ("h3", "h4") else name_el
                full_name = (link or name_el).get_text(strip=True)
            else:
                continue

            if not full_name or len(full_name) < 3:
                continue

            # Extract position — use the specific position span/class,
            # NOT the parent container which includes height/weight/B-T
            pos_el = card.find(class_="sidearm-roster-player-position")
            if pos_el:
                # Get just the first text line (long name like "Infield")
                # or the short abbreviation span
                pos_short = pos_el.find("span", class_=re.compile(r"hide-on"))
                if pos_short:
                    position = pos_short.get_text(strip=True)
                else:
                    # Get first meaningful text line
                    pos_text = pos_el.get_text(separator="\n", strip=True)
                    position = pos_text.split("\n")[0].strip() if pos_text else ""
            else:
                position = ""

            # Extract height
            height_el = card.find(class_="sidearm-roster-player-height")
            height = height_el.get_text(strip=True) if height_el else ""

            # Extract weight
            weight_el = card.find(class_="sidearm-roster-player-weight")
            weight_text = weight_el.get_text(strip=True) if weight_el else ""
            weight = safe_int(weight_text.replace("lbs", "").replace("lb", "").strip())

            # Extract year/class — use exact class to avoid matching unrelated elements
            year_el = (
                card.find(class_="sidearm-roster-player-academic-year")
                or card.find(class_="sidearm-roster-player-year")
            )
            year = year_el.get_text(strip=True) if year_el else ""

            # Extract hometown
            hometown_el = card.find(class_="sidearm-roster-player-hometown")
            hometown = hometown_el.get_text(strip=True) if hometown_el else ""

            # Extract high school
            hs_el = card.find(class_="sidearm-roster-player-highschool")
            high_school = hs_el.get_text(strip=True) if hs_el else ""

            # Extract previous school
            prev_el = card.find(class_="sidearm-roster-player-previous-school")
            previous_school = prev_el.get_text(strip=True) if prev_el else ""

            # Extract bats/throws from the full card text
            card_text = card.get_text()
            bt_match = re.search(r'([LRBS])/([LR])', card_text)
            bats = bt_match.group(1) if bt_match else None
            throws = bt_match.group(2) if bt_match else None

            # Extract headshot from <img> tag
            headshot_url = None
            img_tag = card.find("img")
            if img_tag:
                src = img_tag.get("src") or img_tag.get("data-src")
                if src:
                    src = src.strip()
                    # Skip placeholders/defaults
                    if src and not any(x in src.lower() for x in ["placeholder", "default", "no-photo", "no_photo"]):
                        # Make relative URLs absolute
                        if src.startswith("//"):
                            src = "https:" + src
                        elif src.startswith("/") and base_url:
                            src = base_url.rstrip("/") + src
                        headshot_url = src

            # Normalize name for matching (stats use "Last, First")
            # Roster names could be "First Last" or "Last, First"
            if "," in full_name:
                # Already "Last, First"
                key = full_name.lower().strip()
            else:
                parts = full_name.split()
                if len(parts) >= 2:
                    first = parts[0]
                    last = " ".join(parts[1:])
                    key = f"{last}, {first}".lower()
                else:
                    key = full_name.lower()

            roster[key] = {
                "full_name": full_name,
                "jersey": jersey,
                "position": position,
                "height": height,
                "weight": weight or None,
                "year": year,
                "hometown": hometown,
                "high_school": high_school,
                "previous_school": previous_school,
                "bats": bats,
                "throws": throws,
                "headshot_url": headshot_url,
            }

        except Exception as e:
            logger.debug(f"Error parsing roster card: {e}")
            continue

    return roster


# ============================================================
# Name & Value Parsing
# ============================================================

def parse_sidearm_name(name_str):
    """
    Parse Sidearm name format 'Last, First' into (first, last).
    Falls back to 'First Last' splitting if no comma.
    """
    if not name_str:
        return "", ""
    # Strip leading jersey numbers that may be concatenated (e.g., "35Jaha, Jackson")
    name = re.sub(r'^\d+', '', name_str).strip()

    if "," in name:
        parts = name.split(",", 1)
        last = parts[0].strip()
        first = parts[1].strip()
        return first, last
    else:
        parts = name.split(None, 1)
        if len(parts) == 2:
            return parts[0], parts[1]
        return name, ""


def split_compound(value, sep="-"):
    """Split compound fields like 'W-L', 'GP-GS', 'SB-ATT' into two ints."""
    if not value or value in ("-", "---", ""):
        return 0, 0
    parts = value.split(sep, 1)
    if len(parts) == 2:
        return safe_int(parts[0]), safe_int(parts[1])
    return safe_int(parts[0]), 0


def safe_int(val, default=0):
    """Safely convert to int."""
    if val is None or val == "" or val == "-" or val == "---":
        return default
    try:
        return int(str(val).strip().replace(",", ""))
    except (ValueError, TypeError):
        return default


def safe_float(val, default=0.0):
    """Safely convert to float."""
    if val is None or val == "" or val == "-" or val == "---" or val == "INF":
        return default
    try:
        return float(str(val).strip())
    except (ValueError, TypeError):
        return default


def normalize_year(year_str):
    """Normalize year/class strings from Sidearm."""
    if not year_str:
        return None
    y = year_str.strip().lower().replace(".", "").replace(" ", "")
    if y in ("sr", "senior"):
        return "Sr"
    if y in ("jr", "junior"):
        return "Jr"
    if y in ("so", "sophomore", "soph"):
        return "So"
    if y in ("fr", "freshman", "fresh"):
        return "Fr"
    if y in ("rsr", "rsenior", "gradstudent", "grad", "graduate"):
        return "Sr"
    if y in ("rjr", "rjunior"):
        return "Jr"
    if y in ("rso", "rsophomore", "rsoph"):
        return "R-So"
    if y in ("rfr", "rfreshman"):
        return "R-Fr"
    # Numeric years (UBC uses 1, 2, 3, 4, 5)
    if y in ("1", "1st"):
        return "Fr"
    if y in ("2", "2nd"):
        return "So"
    if y in ("3", "3rd"):
        return "Jr"
    if y in ("4", "4th", "5", "5th"):
        return "Sr"
    return None


# ============================================================
# Database Helpers
# ============================================================

def get_naia_team_id_map():
    """Build CCC team short_name -> team_id map."""
    short_to_id = {}
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT t.id, t.short_name, t.name
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE d.level = %s AND t.is_active = %s
        """, ('NAIA', 1))
        rows = cur.fetchall()
        for row in rows:
            short_to_id[row["short_name"]] = row["id"]

    logger.info(f"Found {len(short_to_id)} NAIA teams in database: {list(short_to_id.keys())}")
    return short_to_id


def insert_or_update_player(cur, first_name, last_name, team_id, **kwargs):
    """Insert or update a player record. Returns player_id."""
    cur.execute(
        "SELECT id FROM players WHERE first_name = %s AND last_name = %s AND team_id = %s",
        (first_name, last_name, team_id),
    )
    existing = cur.fetchone()

    if existing:
        player_id = existing["id"]
        updates = []
        params = []
        for field in ["position", "year_in_school", "jersey_number", "bats", "throws",
                       "height", "weight", "hometown", "high_school", "previous_school", "headshot_url"]:
            if kwargs.get(field):
                updates.append(f"{field} = COALESCE(%s, {field})")
                params.append(kwargs[field])
        # Set roster_year if provided (from roster scraping, not stats scraping)
        if kwargs.get("roster_year"):
            updates.append("roster_year = %s")
            params.append(kwargs["roster_year"])
        if updates:
            params.append(player_id)
            cur.execute(
                f"UPDATE players SET {', '.join(updates)}, updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                params,
            )
    else:
        cur.execute(
            """INSERT INTO players (first_name, last_name, team_id, position,
               year_in_school, jersey_number, bats, throws, height, weight, hometown, high_school, previous_school, headshot_url, roster_year)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                first_name, last_name, team_id,
                kwargs.get("position"),
                kwargs.get("year_in_school"),
                kwargs.get("jersey_number"),
                kwargs.get("bats"),
                kwargs.get("throws"),
                kwargs.get("height"),
                kwargs.get("weight"),
                kwargs.get("hometown"),
                kwargs.get("high_school"),
                kwargs.get("previous_school"),
                kwargs.get("headshot_url"),
                kwargs.get("roster_year"),
            ),
        )
        cur.execute("SELECT lastval() AS id")
        result = cur.fetchone()
        player_id = result["id"] if result else None

    return player_id


# ============================================================
# Main Scraping Logic
# ============================================================

def scrape_team(base_url, db_short, team_id, season_year, skip_roster=False):
    """
    Scrape all stats for a single CCC team.

    Returns (batting_count, pitching_count, error_count).
    """
    batting_count = 0
    pitching_count = 0
    error_count = 0

    # ---- Fetch stats page ----
    # UBC labels seasons by academic start year (their "2025" page = spring 2026 season).
    # So to get data for our season_year, we fetch season_year - 1 from their site.
    url_year = str(int(season_year) - 1) if db_short == "UBC" else season_year
    stats_url = f"{base_url}/sports/baseball/stats/{url_year}"
    logger.info(f"  Fetching stats: {stats_url}")
    stats_html = fetch_page(stats_url)

    if not stats_html:
        # Try without year (redirects to current)
        stats_url = f"{base_url}/sports/baseball/stats"
        logger.info(f"  Retrying without year: {stats_url}")
        stats_html = fetch_page(stats_url)

    if not stats_html:
        logger.error(f"  Failed to fetch stats page for {db_short}")
        return 0, 0, 1

    # ---- Extract team W-L record from stats page ----
    overall, conf = extract_record_from_html(stats_html)
    if not overall and f"/{url_year}" in stats_url:
        # Try stats page without year (some sites only show record on default page)
        fallback_stats = f"{base_url}/sports/baseball/stats"
        logger.info(f"  No record on stats page, trying without year: {fallback_stats}")
        fb_html = fetch_page(fallback_stats)
        if fb_html:
            overall, conf = extract_record_from_html(fb_html)
    if not overall:
        # Try schedule page (Nuxt-based Sidearm sites have record there)
        sched_url = f"{base_url}/sports/baseball/schedule/{url_year}"
        logger.info(f"  No record on stats page, trying schedule: {sched_url}")
        sched_html = fetch_page(sched_url)
        if sched_html:
            overall, conf = extract_record_from_html(sched_html)
    if overall:
        with get_connection() as rconn:
            save_team_record(rconn.cursor(), team_id, int(season_year), overall, conf)

    # ---- Parse tables ----
    batting_table, pitching_table = find_stats_tables(stats_html)

    batting_rows = parse_sidearm_table(batting_table)
    pitching_rows = parse_sidearm_table(pitching_table)

    # If season-specific URL returned empty tables, only fall back to current page
    # if we're scraping the CURRENT season. For historical seasons, skip to avoid
    # saving current-season data under the wrong year.
    if not batting_rows and not pitching_rows and f"/{url_year}" in stats_url:
        import datetime
        current_year = str(datetime.datetime.now().year)
        if season_year == current_year:
            fallback_url = f"{base_url}/sports/baseball/stats"
            logger.info(f"  No stats found for {season_year}, retrying without year: {fallback_url}")
            fallback_html = fetch_page(fallback_url)
            if fallback_html:
                batting_table, pitching_table = find_stats_tables(fallback_html)
                batting_rows = parse_sidearm_table(batting_table)
                pitching_rows = parse_sidearm_table(pitching_table)
        else:
            logger.warning(f"  No stats found for historical season {season_year} — skipping (won't fall back to current page)")

    logger.info(f"  Batting: {len(batting_rows)} players")
    logger.info(f"  Pitching: {len(pitching_rows)} players")

    # ---- Optionally fetch roster for bio data ----
    roster_by_name = {}
    if not skip_roster:
        roster_url = f"{base_url}/sports/baseball/roster"
        logger.info(f"  Fetching roster: {roster_url}")
        roster_html = fetch_page(roster_url)
        if roster_html:
            # Try Nuxt payload first (modern Sidearm sites are JS-rendered)
            roster_by_name = parse_nuxt_roster(roster_html, base_url)
            if roster_by_name:
                logger.info(f"  Parsed {len(roster_by_name)} players from Nuxt payload")
            else:
                # Fall back to BeautifulSoup HTML parsing
                roster_by_name = parse_sidearm_roster(roster_html, base_url)

        logger.info(f"  Roster: {len(roster_by_name)} players parsed")
        if roster_by_name:
            sample_keys = list(roster_by_name.keys())[:5]
            logger.info(f"  Roster sample keys: {sample_keys}")

    # ---- Process batting ----
    matched_count = 0
    unmatched_names = []
    with get_connection() as conn:
        cur = conn.cursor()
        for batter in batting_rows:
            try:
                player_name = batter.get("Player", "").strip()
                if not player_name:
                    continue

                first_name, last_name = parse_sidearm_name(player_name)
                if not last_name:
                    continue

                # Match to roster data
                roster_key = player_name.lower()
                roster_data = roster_by_name.get(roster_key, {})
                if roster_data:
                    matched_count += 1
                else:
                    unmatched_names.append(player_name)

                # Position from roster
                raw_position = roster_data.get("position", "")
                norm_pos = normalize_position(raw_position) or "UT"

                year_in_school = normalize_year(roster_data.get("year"))

                player_id = insert_or_update_player(
                    cur, first_name, last_name, team_id,
                    position=norm_pos or None,
                    year_in_school=year_in_school,
                    jersey_number=batter.get("#") or roster_data.get("jersey"),
                    bats=roster_data.get("bats"),
                    throws=roster_data.get("throws"),
                    height=roster_data.get("height"),
                    weight=roster_data.get("weight"),
                    hometown=roster_data.get("hometown"),
                    high_school=roster_data.get("high_school"),
                    previous_school=roster_data.get("previous_school"),
                    headshot_url=roster_data.get("headshot_url"),
                    roster_year=season_year,
                )

                # Parse batting stats
                gp, gs = split_compound(batter.get("GP-GS"))
                ab = safe_int(batter.get("AB"))
                r = safe_int(batter.get("R"))
                h = safe_int(batter.get("H"))
                doubles = safe_int(batter.get("2B"))
                triples = safe_int(batter.get("3B"))
                hr = safe_int(batter.get("HR"))
                rbi = safe_int(batter.get("RBI"))
                bb = safe_int(batter.get("BB"))
                hbp = safe_int(batter.get("HBP"))
                k = safe_int(batter.get("SO"))
                gdp = safe_int(batter.get("GDP"))
                sf = safe_int(batter.get("SF"))
                sh = safe_int(batter.get("SH"))
                sb, sb_att = split_compound(batter.get("SB-ATT"))
                cs = sb_att - sb if sb_att >= sb else 0

                # Compute PA
                pa = ab + bb + hbp + sf + sh

                if ab == 0 and gp == 0:
                    continue

                # Compute advanced stats
                line = BattingLine(
                    pa=pa, ab=ab, hits=h, doubles=doubles, triples=triples,
                    hr=hr, bb=bb, ibb=0, hbp=hbp, sf=sf, sh=sh, k=k,
                    sb=sb, cs=cs, gidp=gdp,
                )
                adv = compute_batting_advanced(line, division_level="NAIA")

                # Compute WAR
                war = compute_college_war(
                    batting=adv, position=norm_pos,
                    plate_appearances=pa, division_level="NAIA",
                )

                cur.execute(
                    """INSERT INTO batting_stats
                       (player_id, team_id, season, games, games_started,
                        plate_appearances, at_bats,
                        runs, hits, doubles, triples, home_runs, rbi, walks, strikeouts,
                        hit_by_pitch, sacrifice_flies, sacrifice_bunts, stolen_bases,
                        caught_stealing, grounded_into_dp, intentional_walks,
                        batting_avg, on_base_pct, slugging_pct, ops,
                        woba, wraa, wrc, wrc_plus, iso, babip, bb_pct, k_pct, offensive_war)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                               %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT(player_id, team_id, season) DO UPDATE SET
                        games=excluded.games, games_started=excluded.games_started,
                        plate_appearances=excluded.plate_appearances,
                        at_bats=excluded.at_bats, runs=excluded.runs, hits=excluded.hits,
                        doubles=excluded.doubles, triples=excluded.triples,
                        home_runs=excluded.home_runs, rbi=excluded.rbi, walks=excluded.walks,
                        strikeouts=excluded.strikeouts, hit_by_pitch=excluded.hit_by_pitch,
                        sacrifice_flies=excluded.sacrifice_flies,
                        sacrifice_bunts=excluded.sacrifice_bunts,
                        stolen_bases=excluded.stolen_bases,
                        caught_stealing=excluded.caught_stealing,
                        grounded_into_dp=excluded.grounded_into_dp,
                        batting_avg=excluded.batting_avg, on_base_pct=excluded.on_base_pct,
                        slugging_pct=excluded.slugging_pct, ops=excluded.ops,
                        iso=excluded.iso, babip=excluded.babip,
                        bb_pct=excluded.bb_pct, k_pct=excluded.k_pct,
                        updated_at=CURRENT_TIMESTAMP""",
                    (
                        player_id, team_id, season_year, gp, gs, pa, ab,
                        r, h, doubles, triples, hr, rbi, bb, k,
                        hbp, sf, sh, sb, cs, gdp, 0,
                        adv.batting_avg, adv.obp, adv.slg, adv.ops,
                        adv.woba, adv.wraa, adv.wrc, adv.wrc_plus,
                        adv.iso, adv.babip, adv.bb_pct, adv.k_pct, war.offensive_war,
                    ),
                )
                batting_count += 1

            except Exception as e:
                logger.error(f"  Error processing batter: {batter.get('Player')} ({db_short}) - {e}")
                error_count += 1

        logger.info(f"  Roster matched: {matched_count}/{len(batting_rows)} batters")
        if unmatched_names:
            logger.info(f"  Unmatched batters: {unmatched_names[:5]}")

        # ---- Process pitching ----
        for pitcher in pitching_rows:
            try:
                player_name = pitcher.get("Player", "").strip()
                if not player_name:
                    continue

                first_name, last_name = parse_sidearm_name(player_name)
                if not last_name:
                    continue

                roster_key = player_name.lower()
                roster_data = roster_by_name.get(roster_key, {})

                raw_position = roster_data.get("position", "P")
                pitch_pos = normalize_position(raw_position) or "P"
                year_in_school = normalize_year(roster_data.get("year"))

                player_id = insert_or_update_player(
                    cur, first_name, last_name, team_id,
                    position=pitch_pos,
                    year_in_school=year_in_school,
                    jersey_number=pitcher.get("#") or roster_data.get("jersey"),
                    bats=roster_data.get("bats"),
                    throws=roster_data.get("throws"),
                    height=roster_data.get("height"),
                    weight=roster_data.get("weight"),
                    hometown=roster_data.get("hometown"),
                    high_school=roster_data.get("high_school"),
                    previous_school=roster_data.get("previous_school"),
                    headshot_url=roster_data.get("headshot_url"),
                    roster_year=season_year,
                )

                # Parse pitching stats
                w, l = split_compound(pitcher.get("W-L"))
                app, pit_gs = split_compound(pitcher.get("APP-GS"))
                ip = safe_float(pitcher.get("IP"))
                h_allowed = safe_int(pitcher.get("H"))
                runs = safe_int(pitcher.get("R"))
                er = safe_int(pitcher.get("ER"))
                bb = safe_int(pitcher.get("BB"))
                k = safe_int(pitcher.get("SO"))
                hr_allowed = safe_int(pitcher.get("HR"))
                hbp = safe_int(pitcher.get("HBP"))
                wp = safe_int(pitcher.get("WP"))
                bk = safe_int(pitcher.get("BK"))
                cg = safe_int(pitcher.get("CG"))
                sv = safe_int(pitcher.get("SV"))

                # Parse SHO field (may be compound like "0-0" for SHO or just int)
                sho_raw = pitcher.get("SHO", "0")
                if "-" in str(sho_raw):
                    sho, _ = split_compound(sho_raw)
                else:
                    sho = safe_int(sho_raw)

                if ip == 0 and app == 0:
                    continue

                # Estimate batters faced
                if ip > 0:
                    outs = int(ip) * 3 + int(round((ip - int(ip)) * 10))
                    bf = outs + h_allowed + bb + hbp
                else:
                    bf = 0

                line = PitchingLine(
                    ip=ip, hits=h_allowed, er=er, runs=runs, bb=bb, ibb=0,
                    k=k, hr=hr_allowed, hbp=hbp, bf=bf, wp=wp,
                    wins=w, losses=l, saves=sv, games=app, gs=pit_gs,
                )
                adv = compute_pitching_advanced(line, division_level="NAIA")

                cur.execute(
                    """INSERT INTO pitching_stats
                       (player_id, team_id, season, games, games_started, wins, losses, saves,
                        complete_games, shutouts, innings_pitched, hits_allowed, runs_allowed,
                        earned_runs, walks, strikeouts, home_runs_allowed, hit_batters,
                        wild_pitches, batters_faced, intentional_walks,
                        era, whip, k_per_9, bb_per_9, h_per_9, hr_per_9, k_bb_ratio,
                        k_pct, bb_pct,
                        fip, xfip, siera, kwera, babip_against, lob_pct, pitching_war)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                               %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT(player_id, team_id, season) DO UPDATE SET
                        games=excluded.games, games_started=excluded.games_started,
                        wins=excluded.wins, losses=excluded.losses, saves=excluded.saves,
                        complete_games=excluded.complete_games,
                        innings_pitched=excluded.innings_pitched, hits_allowed=excluded.hits_allowed,
                        runs_allowed=excluded.runs_allowed,
                        earned_runs=excluded.earned_runs, walks=excluded.walks,
                        strikeouts=excluded.strikeouts, home_runs_allowed=excluded.home_runs_allowed,
                        hit_batters=excluded.hit_batters,
                        wild_pitches=excluded.wild_pitches, batters_faced=excluded.batters_faced,
                        era=excluded.era, whip=excluded.whip, k_per_9=excluded.k_per_9,
                        bb_per_9=excluded.bb_per_9, h_per_9=excluded.h_per_9,
                        hr_per_9=excluded.hr_per_9, k_bb_ratio=excluded.k_bb_ratio,
                        k_pct=excluded.k_pct, bb_pct=excluded.bb_pct,
                        babip_against=excluded.babip_against, lob_pct=excluded.lob_pct,
                        updated_at=CURRENT_TIMESTAMP""",
                    (
                        player_id, team_id, season_year, app, pit_gs, w, l, sv, cg, sho,
                        ip, h_allowed, runs, er, bb, k, hr_allowed, hbp, wp, bf, 0,
                        adv.era, adv.whip, adv.k_per_9, adv.bb_per_9, adv.h_per_9,
                        adv.hr_per_9, adv.k_bb_ratio,
                        adv.k_pct, adv.bb_pct,
                        adv.fip, adv.xfip, adv.siera, adv.kwera,
                        adv.babip_against, adv.lob_pct, adv.pitching_war,
                    ),
                )
                pitching_count += 1

            except Exception as e:
                logger.error(f"  Error processing pitcher: {pitcher.get('Player')} ({db_short}) - {e}")
                error_count += 1

    return batting_count, pitching_count, error_count


def process_all(season_year, team_filter=None, skip_rosters=False):
    """Scrape all CCC teams (or a single team if team_filter is set)."""
    team_id_map = get_naia_team_id_map()
    if not team_id_map:
        logger.error("No NAIA teams found in database. Run with --init-db first.")
        return

    total_batting = 0
    total_pitching = 0
    total_errors = 0

    for db_short, base_url in CCC_TEAMS.items():
        if team_filter and db_short != team_filter:
            continue

        team_id = team_id_map.get(db_short)
        if not team_id:
            logger.warning(f"Team {db_short} not in database, skipping")
            continue

        logger.info(f"{'='*50}")
        logger.info(f"Scraping {db_short} ({base_url})...")

        bc, pc, ec = scrape_team(base_url, db_short, team_id, season_year, skip_rosters)
        total_batting += bc
        total_pitching += pc
        total_errors += ec

    # Summary
    logger.info("=" * 60)
    logger.info(f"NAIA/CCC SCRAPE COMPLETE (season={season_year})")
    logger.info(f"  Batting:  {total_batting} players")
    logger.info(f"  Pitching: {total_pitching} players")
    logger.info(f"  Errors:   {total_errors}")
    logger.info("=" * 60)


# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="Scrape NAIA/CCC baseball stats from team athletics sites")
    parser.add_argument(
        "--season", type=int, required=True,
        help="Season year (e.g., 2026)"
    )
    parser.add_argument(
        "--team", type=str, default=None,
        help="Scrape a single team by alias (e.g., lcsc, eou, oit, corban)"
    )
    parser.add_argument(
        "--skip-rosters", action="store_true",
        help="Skip scraping roster pages (faster, but no bio data)"
    )
    parser.add_argument(
        "--init-db", action="store_true",
        help="Initialize/seed the database before scraping"
    )
    args = parser.parse_args()

    if args.init_db:
        init_db()
        seed_divisions_and_conferences()
        logger.info("Database initialized and seeded")

    team_filter = None
    if args.team:
        alias = args.team.lower().strip()
        team_filter = TEAM_ALIASES.get(alias)
        if not team_filter:
            # Try direct match against CCC_TEAMS keys
            for key in CCC_TEAMS:
                if key.lower() == alias:
                    team_filter = key
                    break
        if not team_filter:
            logger.error(f"Unknown team alias: '{args.team}'. Valid aliases: {list(TEAM_ALIASES.keys())}")
            sys.exit(1)
        logger.info(f"Filtering to single team: {team_filter}")

    logger.info(f"NAIA/CCC Baseball Scraper -- Season {args.season}")
    process_all(args.season, team_filter=team_filter, skip_rosters=args.skip_rosters)


if __name__ == "__main__":
    main()
