#!/usr/bin/env python3
"""
NCAA D1 (PNW Region) Baseball Stats Scraper
=============================================

Scrapes batting, pitching, and roster data from PNW-region D1 team athletics
websites (Sidearm Sports platform) and populates the PNW Baseball database.

Teams: UW, Oregon, Oregon St., Wash. St., Gonzaga, Portland, Seattle U

Usage:
    cd pnw-baseball
    PYTHONPATH=backend python3 scripts/scrape_d1.py --season 2026
    PYTHONPATH=backend python3 scripts/scrape_d1.py --season 2026 --team uw
    PYTHONPATH=backend python3 scripts/scrape_d1.py --season 2026 --skip-rosters
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
logger = logging.getLogger("scrape_d1")

# ============================================================
# D1 Team Configuration
# ============================================================

# Map DB short_name -> team's Sidearm athletics base URL
D1_TEAMS = {
    "UW":         "https://gohuskies.com",
    "Oregon":     "https://goducks.com",
    "Oregon St.": "https://osubeavers.com",
    "Wash. St.":  "https://wsucougars.com",
    "Gonzaga":    "https://gozags.com",
    "Portland":   "https://portlandpilots.com",
    "Seattle U":  "https://goseattleu.com",  # Non-standard Sidearm — may need manual URL
}

# Teams whose stats pages don't follow standard Sidearm patterns
SKIP_TEAMS = set()  # Add team short_names here to skip (e.g., {"Seattle U"})

# Short aliases for CLI --team flag
TEAM_ALIASES = {
    "uw": "UW",
    "washington": "UW",
    "huskies": "UW",
    "oregon": "Oregon",
    "ducks": "Oregon",
    "uo": "Oregon",
    "osu": "Oregon St.",
    "oregon-state": "Oregon St.",
    "oregonst": "Oregon St.",
    "beavers": "Oregon St.",
    "wsu": "Wash. St.",
    "washst": "Wash. St.",
    "washington-state": "Wash. St.",
    "cougars": "Wash. St.",
    "gonzaga": "Gonzaga",
    "zags": "Gonzaga",
    "portland": "Portland",
    "pilots": "Portland",
    "seattleu": "Seattle U",
    "seattle": "Seattle U",
    "redhawks": "Seattle U",
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


def fetch_json(url, params=None, retries=2):
    """Fetch a JSON endpoint with rate limiting and retries."""
    global last_request_time

    for attempt in range(retries):
        try:
            elapsed = time.time() - last_request_time
            delay = random.uniform(1.0, 2.0)
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
# WMT Games API — Seattle U stats
# ============================================================

def extract_wmt_team_id(stats_html):
    """
    Extract the WMT Games team ID from the Nuxt data payload on a Seattle U stats page.
    The stats page embeds a URL like 'https://wmt.games/goseattleu/stats/season/614833'
    in its __NUXT_DATA__ script tag. We extract the numeric season team ID from that.
    """
    import re as _re
    match = _re.search(r'wmt\.games/goseattleu/stats/season/(\d+)', stats_html)
    if match:
        return match.group(1)
    return None


def fetch_wmt_players(wmt_team_id):
    """
    Fetch player stats from the WMT Games API for a given season team ID.
    Returns a list of player dicts from the API, or None on failure.
    """
    url = f"https://api.wmt.games/api/statistics/teams/{wmt_team_id}/players"
    params = {"per_page": "150"}
    data = fetch_json(url, params=params, retries=3)
    if data and "data" in data:
        return data["data"]
    return None


def wmt_to_batting_rows(wmt_players):
    """
    Convert WMT Games API player data into the standard batting row format
    used by the rest of the scraper (dicts with keys like Player, AB, H, etc.).
    Only includes players who have batting stats (non-zero AB or games).
    """
    rows = []
    for p in wmt_players:
        stats = _wmt_get_season_stats(p)
        if not stats:
            continue

        ab = _wmt_int(stats.get("sAtBats"))
        gp = _wmt_int(stats.get("sGames10523"))
        if ab == 0 and gp == 0:
            continue

        # Skip if this is a pitcher-only entry (no batting avg, 0 AB)
        if ab == 0 and stats.get("sBattingAverage") is None:
            continue

        name = f"{p['first_name']} {p['last_name']}"
        gs = _wmt_int(stats.get("sGamesStarted"))
        sb = _wmt_int(stats.get("sStolenBases"))
        cs = _wmt_int(stats.get("sCaughtStealing"))
        sb_att = sb + cs

        row = {
            "Player": name,
            "#": p.get("jersey_no", ""),
            "GP-GS": f"{gp}-{gs}",
            "AB": str(ab),
            "R": str(_wmt_int(stats.get("sRuns"))),
            "H": str(_wmt_int(stats.get("sHits"))),
            "2B": str(_wmt_int(stats.get("sDoubles"))),
            "3B": str(_wmt_int(stats.get("sTriples"))),
            "HR": str(_wmt_int(stats.get("sHomeRuns"))),
            "RBI": str(_wmt_int(stats.get("sRunsBattedIn"))),
            "BB": str(_wmt_int(stats.get("sWalks"))),
            "HBP": str(_wmt_int(stats.get("sHitByPitch"))),
            "SO": str(_wmt_int(stats.get("sStrikeoutsHitting"))),
            "GDP": str(_wmt_int(stats.get("sGroundedIntoDoublePlays"))),
            "SF": str(_wmt_int(stats.get("sSacrificeFlies"))),
            "SH": str(_wmt_int(stats.get("sSacrificeBunts"))),
            "SB-ATT": f"{sb}-{sb_att}",
            "_wmt_position": p.get("position_code", ""),
            "_wmt_class": p.get("class_short_descr", ""),
            "_wmt_height_ft": p.get("height_ft"),
            "_wmt_height_in": p.get("height_in"),
        }
        rows.append(row)

    return rows


def wmt_to_pitching_rows(wmt_players):
    """
    Convert WMT Games API player data into the standard pitching row format
    used by the rest of the scraper (dicts with keys like Player, IP, ERA, etc.).
    Only includes players who have pitching stats (non-zero IP or appearances).
    """
    rows = []
    for p in wmt_players:
        stats = _wmt_get_season_stats(p)
        if not stats:
            continue

        ip_raw = stats.get("sInningsPitched")
        app = _wmt_int(stats.get("sPitchingAppearances"))
        if (ip_raw is None or ip_raw == 0) and app == 0:
            continue

        # Skip if this player has no pitching-specific stats
        if stats.get("sERA") is None and ip_raw == 0:
            continue

        name = f"{p['first_name']} {p['last_name']}"
        w = _wmt_int(stats.get("sIndWon"))
        l = _wmt_int(stats.get("sIndLost"))
        gs = _wmt_int(stats.get("sGamesStartedPitching", stats.get("sGamesStarted", 0)))

        # Convert IP: WMT gives it as a float like 16.0 or 16.1 (for 16 1/3)
        # but sometimes as an integer. The rest of the scraper expects string format.
        ip = ip_raw if ip_raw is not None else 0
        # WMT uses whole number for IP — convert thirds properly
        # e.g., 16 innings + 1 out = reported as 16.333... but we need "16.1"
        if isinstance(ip, float) and ip != int(ip):
            whole = int(ip)
            frac = ip - whole
            # Map fractional innings to outs
            if abs(frac - 0.333) < 0.05 or abs(frac - 1/3) < 0.05:
                ip_str = f"{whole}.1"
            elif abs(frac - 0.667) < 0.05 or abs(frac - 2/3) < 0.05:
                ip_str = f"{whole}.2"
            else:
                ip_str = str(ip)
        else:
            ip_str = str(int(ip))

        row = {
            "Player": name,
            "#": p.get("jersey_no", ""),
            "W-L": f"{w}-{l}",
            "APP-GS": f"{app}-{gs}",
            "IP": ip_str,
            "H": str(_wmt_int(stats.get("sHits"))),
            "R": str(_wmt_int(stats.get("sRuns"))),
            "ER": str(_wmt_int(stats.get("sEarnedRuns"))),
            "BB": str(_wmt_int(stats.get("sWalks"))),
            "SO": str(_wmt_int(stats.get("sStrikeoutsPitching"))),
            "HR": str(_wmt_int(stats.get("sHomeRuns"))),
            "HBP": str(_wmt_int(stats.get("sHitByPitch"))),
            "WP": str(_wmt_int(stats.get("sWildPitches"))),
            "BK": str(_wmt_int(stats.get("sBalks"))),
            "CG": str(_wmt_int(stats.get("sCompleteGames"))),
            "SHO": str(_wmt_int(stats.get("sShutouts"))),
            "SV": str(_wmt_int(stats.get("sSaves"))),
            "ERA": str(_wmt_float(stats.get("sERA"))),
            "_wmt_position": p.get("position_code", "P"),
            "_wmt_class": p.get("class_short_descr", ""),
            "_wmt_height_ft": p.get("height_ft"),
            "_wmt_height_in": p.get("height_in"),
        }
        rows.append(row)

    return rows


def build_wmt_roster(wmt_players):
    """Build a roster dict (name.lower() -> bio dict) from WMT players."""
    roster = {}
    for p in wmt_players:
        first = p.get("first_name", "").strip()
        last = p.get("last_name", "").strip()
        if not (first and last):
            continue

        name_lower = f"{first} {last}".lower()
        roster[name_lower] = {
            "position": p.get("position_code", ""),
            "jersey": p.get("jersey_no", ""),
            "year": p.get("class_short_descr", ""),
            "bats": p.get("bats_code", ""),
            "throws": p.get("throws_code", ""),
            "height": _wmt_height_str(p.get("height_ft"), p.get("height_in")),
            "weight": p.get("weight", ""),
            "hometown": p.get("hometown", ""),
            "high_school": p.get("high_school", ""),
            "previous_school": "",
        }

    return roster


def _wmt_get_season_stats(wmt_player):
    """Extract season stats dict from a WMT player object."""
    if "season_stats" in wmt_player and isinstance(wmt_player["season_stats"], list):
        if wmt_player["season_stats"]:
            return wmt_player["season_stats"][0]
    return {}


def _wmt_int(val, default=0):
    """Safe int conversion for WMT data."""
    if val is None:
        return default
    try:
        return int(val)
    except (ValueError, TypeError):
        return default


def _wmt_float(val, default=0.0):
    """Safe float conversion for WMT data."""
    if val is None:
        return default
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


def _wmt_height_str(ft, inches):
    """Convert WMT height (ft, in) to height string."""
    if ft and inches:
        return f"{int(ft)}-{int(inches)}"
    elif ft:
        return str(int(ft))
    return ""


# ============================================================
# Sidearm Parsing
# ============================================================

def find_stats_tables(html):
    """Parse the stats HTML and return (batting_table, pitching_table) as BeautifulSoup table objects."""
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")

    batting_table = None
    pitching_table = None

    for table in tables:
        # Look for header rows to identify table type
        thead = table.find("thead")
        if not thead:
            thead = table
        header_text = " ".join([th.get_text(strip=True).lower() for th in thead.find_all("th")])

        if "at-bat" in header_text or "at bat" in header_text or ("h" in header_text and "ab" in header_text):
            if batting_table is None:
                batting_table = table
        if "era" in header_text or ("ip" in header_text and "w-l" in header_text):
            if pitching_table is None:
                pitching_table = table

    return batting_table, pitching_table


def parse_sidearm_table(table):
    """Parse a Sidearm stats HTML table into list of row dicts."""
    if not table:
        return []

    rows = []

    # Find header
    thead = table.find("thead")
    if not thead:
        return rows

    header_cells = thead.find_all("th")
    headers = [th.get_text(strip=True) for th in header_cells]

    # Parse body
    tbody = table.find("tbody")
    if not tbody:
        return rows

    for tr in tbody.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) != len(headers):
            continue

        row = {}
        for i, td in enumerate(tds):
            text = td.get_text(strip=True)
            row[headers[i]] = text

        rows.append(row)

    return rows


def parse_nuxt_batting(html):
    """Extract batting stats from Nuxt __NUXT_DATA__ payload."""
    # Look for __NUXT_DATA__ script tag
    soup = BeautifulSoup(html, "html.parser")
    script_tag = soup.find("script", {"id": "__NUXT_DATA__"})
    if not script_tag:
        return []

    try:
        json_str = script_tag.string
        if not json_str:
            return []

        data = json.loads(json_str)

        # Parse Nuxt compressed format: [key1, val1, key2, val2, ...]
        # Typical structure: find batting table data in the payload
        # This is highly specific to Sidearm's Nuxt template, so parsing varies

        rows = []
        # For now, return empty — would need specific Nuxt payload structure info
        return rows

    except (json.JSONDecodeError, KeyError, IndexError):
        return []


def parse_nuxt_pitching(html):
    """Extract pitching stats from Nuxt __NUXT_DATA__ payload."""
    return []  # Same as batting — would need specific structure


def fetch_sidearm_roster_json(base_url, season_year):
    """Try to fetch roster data from Sidearm JSON endpoint."""
    # Sidearm roster endpoint typically: /sports/baseball/roster/{year}?json
    roster_url = f"{base_url}/sports/baseball/roster/{season_year}?json"
    data = fetch_json(roster_url)

    if not data:
        return {}

    roster_by_name = {}
    try:
        # Expected structure from Sidearm JSON: list of player objects
        if isinstance(data, dict) and "roster" in data:
            players = data["roster"]
        elif isinstance(data, list):
            players = data
        else:
            return {}

        for player in players:
            if not isinstance(player, dict):
                continue

            first = player.get("first_name", "").strip()
            last = player.get("last_name", "").strip()
            if not (first and last):
                continue

            name_key = f"{first} {last}".lower()
            roster_by_name[name_key] = {
                "position": player.get("position", ""),
                "jersey": player.get("jersey_number", ""),
                "year": player.get("class", ""),
                "bats": player.get("bats", ""),
                "throws": player.get("throws", ""),
                "height": player.get("height", ""),
                "weight": player.get("weight", ""),
                "hometown": player.get("hometown", ""),
                "high_school": player.get("high_school", ""),
                "previous_school": player.get("previous_school", ""),
            }

    except (KeyError, TypeError, ValueError):
        return {}

    return roster_by_name


def parse_sidearm_roster(html):
    """Parse Sidearm roster HTML page to extract player bios."""
    soup = BeautifulSoup(html, "html.parser")
    roster = {}

    # Look for roster cards or list items
    # Sidearm rosters typically use <div class="sidearm-roster-card"> or similar
    roster_cards = soup.find_all(["div", "article"], class_=re.compile(r"roster|card", re.I))

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

            first_name, last_name = parse_sidearm_name(player_name)
            if not last_name:
                continue

            name_key = player_name.lower()

            # Extract other fields from card
            bio = {
                "position": _extract_field(card, "position"),
                "jersey": _extract_field(card, "jersey"),
                "year": _extract_field(card, ["year", "class", "grade"]),
                "bats": _extract_field(card, "bats"),
                "throws": _extract_field(card, "throws"),
                "height": _extract_field(card, "height"),
                "weight": _extract_field(card, "weight"),
                "hometown": _extract_field(card, ["hometown", "home"]),
                "high_school": _extract_field(card, ["high school", "hs"]),
                "previous_school": _extract_field(card, ["previous", "transfer"]),
            }

            roster[name_key] = bio

        except Exception as e:
            logger.debug(f"Error parsing roster card: {e}")
            continue

    return roster


def _extract_field(elem, labels):
    """Helper to extract a field value from a card given label(s)."""
    if isinstance(labels, str):
        labels = [labels]

    for label in labels:
        # Look for label text (case-insensitive)
        for span in elem.find_all(["span", "div", "p"], class_=re.compile(label, re.I)):
            # Return the next sibling or text after the label
            text = span.get_text(strip=True)
            if text.lower().startswith(label.lower()):
                rest = text[len(label):].strip().lstrip(":").strip()
                if rest:
                    return rest
            # Try next sibling
            next_el = span.find_next()
            if next_el:
                return next_el.get_text(strip=True)

    return ""


# ============================================================
# Name & Value Parsing
# ============================================================

def parse_sidearm_name(name_str):
    """Parse Sidearm name format 'Last, First' into (first, last)."""
    if not name_str:
        return "", ""
    name = name_str.strip()

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
    if val is None or val == "" or val == "-" or val == "---":
        return default
    try:
        return int(str(val).strip().replace(",", ""))
    except (ValueError, TypeError):
        return default


def safe_float(val, default=0.0):
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
    return None


# ============================================================
# Database Helpers
# ============================================================

def get_d1_team_id_map():
    """Build D1 team short_name -> team_id map."""
    short_to_id = {}
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT t.id, t.short_name, t.name
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE d.level = 'D1' AND t.is_active = 1
        """)
        rows = cur.fetchall()
        for row in rows:
            short_to_id[row["short_name"]] = row["id"]

    logger.info(f"Found {len(short_to_id)} D1 teams in database: {list(short_to_id.keys())}")
    return short_to_id


def insert_or_update_player(conn, first_name, last_name, team_id, **kwargs):
    """Insert or update a player record. Returns player_id."""
    cur = conn.cursor()
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
                       "height", "weight", "hometown", "high_school", "previous_school"]:
            if kwargs.get(field):
                updates.append(f"{field} = COALESCE(%s, {field})")
                params.append(kwargs[field])
        if updates:
            params.append(player_id)
            cur.execute(
                f"UPDATE players SET {', '.join(updates)}, updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                params,
            )
    else:
        cur.execute(
            """INSERT INTO players (first_name, last_name, team_id, position,
               year_in_school, jersey_number, bats, throws, height, weight, hometown, high_school, previous_school)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
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
            ),
        )
        cur.execute("SELECT lastval() as id")
        result = cur.fetchone()
        player_id = result["id"]

    return player_id


# ============================================================
# Main Scraping Logic
# ============================================================

DIVISION_LEVEL = "D1"


def scrape_team(base_url, db_short, team_id, season_year, skip_roster=False):
    """
    Scrape all stats for a single D1 team.
    Returns (batting_count, pitching_count, error_count).
    """
    batting_count = 0
    pitching_count = 0
    error_count = 0

    # ---- Seattle U: WMT Games API path ----
    wmt_success = False
    if db_short == "Seattle U":
        # Try season-specific URL first (each season has its own WMT team ID)
        stats_url = f"{base_url}/sports/baseball/stats/{season_year}"
        logger.info(f"  Fetching stats page (for WMT team ID): {stats_url}")
        stats_html = fetch_page(stats_url)
        if not stats_html:
            # Fall back to default (current season) page
            stats_url = f"{base_url}/sports/baseball/stats"
            logger.info(f"  Retrying without year: {stats_url}")
            stats_html = fetch_page(stats_url)

        wmt_team_id = extract_wmt_team_id(stats_html) if stats_html else None
        if wmt_team_id:
            logger.info(f"  Found WMT team ID: {wmt_team_id} — fetching from WMT Games API...")
            wmt_players = fetch_wmt_players(wmt_team_id)
            if wmt_players:
                batting_rows = wmt_to_batting_rows(wmt_players)
                pitching_rows = wmt_to_pitching_rows(wmt_players)
                roster_by_name = build_wmt_roster(wmt_players) if not skip_roster else {}
                wmt_success = True

                # Extract record from schedule page for Seattle U
                sched_url = f"{base_url}/sports/baseball/schedule/{season_year}"
                logger.info(f"  Fetching schedule for record: {sched_url}")
                sched_html = fetch_page(sched_url)
                if not sched_html:
                    sched_url = f"{base_url}/sports/baseball/schedule"
                    logger.info(f"  Retrying schedule without year: {sched_url}")
                    sched_html = fetch_page(sched_url)
                if sched_html:
                    overall, conf = extract_record_from_html(sched_html)
                    if overall:
                        with get_connection() as rconn:
                            save_team_record(rconn, team_id, int(season_year), overall, conf)

                logger.info(f"  WMT API — Batting: {len(batting_rows)} players, Pitching: {len(pitching_rows)} players")
                if roster_by_name:
                    logger.info(f"  WMT roster: {len(roster_by_name)} players")
            else:
                logger.warning(f"  WMT API returned no players — falling back to HTML parsing")
        else:
            logger.warning(f"  Could not find WMT team ID in page — falling back to HTML parsing")

    # ---- Fetch stats page (standard Sidearm path) — skip if WMT succeeded ----
    if not wmt_success:
        if db_short == "Seattle U":
            # Seattle U fallback — already have stats_html from above, or retry with year
            if not stats_html:
                stats_url = f"{base_url}/sports/baseball/stats/{season_year}"
                logger.info(f"  Retrying with year: {stats_url}")
                stats_html = fetch_page(stats_url)
        else:
            stats_url = f"{base_url}/sports/baseball/stats/{season_year}"
            logger.info(f"  Fetching stats: {stats_url}")
            stats_html = fetch_page(stats_url)

            if not stats_html:
                stats_url = f"{base_url}/sports/baseball/stats"
                logger.info(f"  Retrying without year: {stats_url}")
                stats_html = fetch_page(stats_url)

        if not stats_html:
            logger.error(f"  Failed to fetch stats page for {db_short}")
            return 0, 0, 1

        # ---- Extract team W-L record from stats page ----
        overall, conf = extract_record_from_html(stats_html)
        if not overall:
            # Nuxt-based Sidearm sites have record on schedule page instead
            sched_url = f"{base_url}/sports/baseball/schedule/{season_year}"
            logger.info(f"  No record on stats page, trying schedule: {sched_url}")
            sched_html = fetch_page(sched_url)
            if sched_html:
                overall, conf = extract_record_from_html(sched_html)
        if overall:
            with get_connection() as rconn:
                save_team_record(rconn, team_id, int(season_year), overall, conf)

        # ---- Parse tables ----
        batting_table, pitching_table = find_stats_tables(stats_html)

        batting_rows = parse_sidearm_table(batting_table)
        pitching_rows = parse_sidearm_table(pitching_table)

        # Only fall back to current page if scraping the CURRENT season.
        # For historical seasons, skip to avoid saving current data under wrong year.
        if not batting_rows and not pitching_rows and f"/{season_year}" in stats_url:
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

        # ---- Nuxt payload fallback for newer D1 Sidearm sites ----
        if not pitching_rows:
            logger.info(f"  No pitching HTML table found — trying Nuxt payload...")
            pitching_rows = parse_nuxt_pitching(stats_html)

        if not batting_rows:
            logger.info(f"  No batting HTML table found — trying Nuxt payload...")
            batting_rows = parse_nuxt_batting(stats_html)

        roster_by_name = {}

    logger.info(f"  Batting: {len(batting_rows)} players")
    logger.info(f"  Pitching: {len(pitching_rows)} players")

    # ---- Optionally fetch roster for bio data (skip if WMT already provided it) ----
    if not wmt_success and not skip_roster:
        # Try JSON roster first (D1 sites usually support this)
        roster_by_name = fetch_sidearm_roster_json(base_url, season_year)

        if not roster_by_name:
            roster_url = f"{base_url}/sports/baseball/roster"
            logger.info(f"  Fetching roster HTML: {roster_url}")
            roster_html = fetch_page(roster_url)
            if roster_html:
                roster_by_name = parse_sidearm_roster(roster_html)

        logger.info(f"  Roster: {len(roster_by_name)} players parsed")

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

                roster_key = player_name.lower()
                roster_data = roster_by_name.get(roster_key, {})
                if roster_data:
                    matched_count += 1
                else:
                    unmatched_names.append(player_name)

                raw_position = roster_data.get("position", "")
                norm_pos = normalize_position(raw_position) or "UT"
                year_in_school = normalize_year(roster_data.get("year"))

                player_id = insert_or_update_player(
                    conn, first_name, last_name, team_id,
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
                )

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

                pa = ab + bb + hbp + sf + sh

                if ab == 0 and gp == 0:
                    continue

                line = BattingLine(
                    pa=pa, ab=ab, hits=h, doubles=doubles, triples=triples,
                    hr=hr, bb=bb, ibb=0, hbp=hbp, sf=sf, sh=sh, k=k,
                    sb=sb, cs=cs, gidp=gdp,
                )
                adv = compute_batting_advanced(line, division_level=DIVISION_LEVEL)

                war = compute_college_war(
                    batting=adv, position=norm_pos,
                    plate_appearances=pa, division_level=DIVISION_LEVEL,
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
                        woba=excluded.woba, wraa=excluded.wraa, wrc=excluded.wrc,
                        wrc_plus=excluded.wrc_plus, iso=excluded.iso, babip=excluded.babip,
                        bb_pct=excluded.bb_pct, k_pct=excluded.k_pct,
                        offensive_war=excluded.offensive_war,
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
                    conn, first_name, last_name, team_id,
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
                )

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

                sho_raw = pitcher.get("SHO", "0")
                if "-" in str(sho_raw):
                    sho, _ = split_compound(sho_raw)
                else:
                    sho = safe_int(sho_raw)

                if ip == 0 and app == 0:
                    continue

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
                adv = compute_pitching_advanced(line, division_level=DIVISION_LEVEL)

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
                        fip=excluded.fip, xfip=excluded.xfip, siera=excluded.siera,
                        kwera=excluded.kwera,
                        babip_against=excluded.babip_against, lob_pct=excluded.lob_pct,
                        pitching_war=excluded.pitching_war,
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
    """Scrape all D1 teams (or a single team if team_filter is set)."""
    team_id_map = get_d1_team_id_map()
    if not team_id_map:
        logger.error("No D1 teams found in database.")
        return

    total_batting = 0
    total_pitching = 0
    total_errors = 0

    for db_short, base_url in D1_TEAMS.items():
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
    logger.info(f"D1 SCRAPE COMPLETE (season={season_year})")
    logger.info(f"  Batting:  {total_batting} players")
    logger.info(f"  Pitching: {total_pitching} players")
    logger.info(f"  Errors:   {total_errors}")
    logger.info("=" * 60)


# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="Scrape NCAA D1 PNW baseball stats from team athletics sites")
    parser.add_argument("--season", type=int, required=True, help="Season year (e.g., 2026)")
    parser.add_argument("--team", type=str, default=None, help="Scrape a single team by alias (e.g., uw, oregon, osu)")
    parser.add_argument("--skip-rosters", action="store_true", help="Skip scraping roster pages")
    parser.add_argument("--init-db", action="store_true", help="Initialize/seed the database before scraping")
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
            for key in D1_TEAMS:
                if key.lower() == alias:
                    team_filter = key
                    break
        if not team_filter:
            logger.error(f"Unknown team alias: '{args.team}'. Valid aliases: {list(TEAM_ALIASES.keys())}")
            sys.exit(1)
        logger.info(f"Filtering to single team: {team_filter}")

    logger.info(f"NCAA D1 PNW Baseball Scraper -- Season {args.season}")
    process_all(args.season, team_filter=team_filter, skip_rosters=args.skip_rosters)


if __name__ == "__main__":
    main()
