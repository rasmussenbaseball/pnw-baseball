#!/usr/bin/env python3
"""
NWAC Baseball Stats Scraper
============================

Scrapes batting, extended hitting, pitching, and roster data from
nwacsports.com (PrestoSports) and populates the PNW Baseball database.

Key discovery: PrestoSports team pages load individual stats via an
AJAX template endpoint. This returns clean HTML with a single table
containing ALL players (not just qualified), with full names, position,
year, and all counting stats.

Template endpoint pattern:
  /sports/bsb/{season}/teams/{slug}?tmpl=brief-category-template&pos={pos}&r=0

Where pos= is:
  h  = individual batting     (#, Name, Yr, Pos, g, ab, r, h, 2b, 3b, hr, rbi, bb, k, sb, cs, avg, obp, slg)
  he = individual ext hitting  (#, Name, Yr, Pos, g, hbp, sf, sh, tb, xbh, hdp, go, fo, go/fo, pa)
  p  = individual pitching     (#, Name, Yr, Pos, app, gs, w, l, sv, cg, ip, h, r, er, bb, k, k/9, hr, era, whip)
  f  = individual fielding     (#, Name, Yr, Pos, g, tc, po, a, e, fpct, dp, sba, rcs, rcs%, pb, ci)

Roster comes from the main team page (Table 3):
  /sports/bsb/{season}/teams/{slug}?view=lineup&r=0&pos=h

Usage:
    cd pnw-baseball
    python3 scripts/scrape_nwac.py --season 2025-26 --init-db
    python3 scripts/scrape_nwac.py --season 2024-25
"""

import sys
import os
import time
import random
import argparse
import logging
import re
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

try:
    import cloudscraper
    _have_cloudscraper = True
except ImportError:
    _have_cloudscraper = False

import requests
from bs4 import BeautifulSoup

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
logger = logging.getLogger("scrape_nwac")

# ============================================================
# Constants
# ============================================================

BASE_URL = "https://nwacsports.com"

# Map NWAC website team names -> database short_name
NWAC_TEAM_MAP = {
    "Bellevue":        "Bellevue",
    "Big Bend":        "Big Bend",
    "Blue Mountain":   "Blue Mountain",
    "Centralia":       "Centralia",
    "Chemeketa":       "Chemeketa",
    "Clackamas":       "Clackamas",
    "Clark":           "Clark",
    "Columbia Basin":  "Columbia Basin",
    "Columbia Gorge":  None,
    "Douglas":         "Douglas",
    "Edmonds":         "Edmonds",
    "Everett":         "Everett",
    "Grays Harbor":    "Grays Harbor",
    "Gray Harbor":     "Grays Harbor",
    "Green River":     "GRC",
    "Highline":        None,
    "Klamath":         None,
    "Lane":            "Lane",
    "Linn-Benton":     "Linn-Benton",
    "Lower Columbia":  "Lower Columbia",
    "LCC":             "Lower Columbia",
    "Mt Hood":         "Mt. Hood",
    "MHCC":            "Mt. Hood",
    "Olympic":         "Olympic",
    "Peninsula":       None,
    "Pierce":          "Pierce",
    "Portland":        None,
    "Rogue":           None,
    "Shoreline":       "Shoreline",
    "Skagit Valley":   "Skagit",
    "South Puget Sound": None,
    "SW Oregon":       "SW Oregon",
    "Spokane":         "Spokane",
    "Tacoma":          "Tacoma",
    "Treasure Valley": "Treasure Valley",
    "Umpqua":          "Umpqua",
    "Walla Walla":     "Walla Walla",
    "Wenatchee Valley": "Wenatchee Valley",
    "Whatcom":         None,
    "Yakima Valley":   "Yakima Valley",
}

# NWAC team slugs for URLs (keyed by DB short_name)
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

USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
]


# ============================================================
# HTTP Fetching
# ============================================================

_DEFAULT_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}

if _have_cloudscraper:
    logger.info("Using cloudscraper (AWS WAF bypass enabled)")
    session = cloudscraper.create_scraper(
        browser={"browser": "chrome", "platform": "darwin", "mobile": False},
    )
else:
    logger.info("cloudscraper not available — falling back to requests.Session()")
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    })

session.headers.update(_DEFAULT_HEADERS)
last_request_time = 0
_session_warmed_for = None   # track which season we warmed for


def _warm_session(season_str=None):
    """Visit the NWAC baseball page for the target season to establish cookies."""
    global _session_warmed_for, last_request_time
    target = season_str or "2025-26"
    if _session_warmed_for == target:
        return
    logger.info(f"Warming session — visiting NWAC {target} page...")
    try:
        resp = session.get(f"{BASE_URL}/sports/bsb/{target}", timeout=30)
        last_request_time = time.time()
        logger.info(f"Session warmed for {target} ({len(resp.text)} bytes, cookies: {len(session.cookies)})")
        time.sleep(random.uniform(2.0, 4.0))
    except Exception as e:
        logger.warning(f"Session warmup failed: {e}")
    _session_warmed_for = target


def fetch_page(url, retries=3, season_str=None):
    """Fetch a URL with rate limiting and retries."""
    global last_request_time
    _warm_session(season_str)

    for attempt in range(retries):
        try:
            elapsed = time.time() - last_request_time
            delay = random.uniform(3.5, 6.0)
            if elapsed < delay:
                time.sleep(delay - elapsed)

            # Use AJAX-style headers for template endpoints
            extra = {}
            if "tmpl=" in url:
                extra["X-Requested-With"] = "XMLHttpRequest"
                extra["Sec-Fetch-Dest"] = "empty"
                extra["Sec-Fetch-Mode"] = "cors"
                extra["Referer"] = url.split("?")[0]

            resp = session.get(url, headers=extra, timeout=30)
            last_request_time = time.time()
            resp.raise_for_status()
            logger.info(f"Fetched {url} ({len(resp.text)} bytes, has_table={'<table' in resp.text})")
            if '<table' not in resp.text and len(resp.text) < 3000:
                logger.info(f"Response snippet: {resp.text[:300]}")
            return resp.text

        except requests.RequestException as e:
            logger.warning(f"  Attempt {attempt+1}/{retries} failed for {url}: {e}")
            if attempt < retries - 1:
                time.sleep(3 ** (attempt + 1))

    logger.error(f"All retries failed for {url}")
    return None


# ============================================================
# HTML Parsing
# ============================================================

def parse_template_table(html):
    """
    Parse the single table returned by the brief-category-template endpoint.

    Structure: #  | Name | Yr | Pos | stat1 | stat2 | ...
    - Cell [0] = jersey number
    - Cell [1] = player name (full, with link)
    - Cell [2] = year (Fr, So, Jr, Sr)
    - Cell [3] = position
    - Cells [4:] = stat values

    Returns list of dicts.
    """
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")
    if not tables:
        logger.warning("No table found in template response")
        return []

    table = tables[0]

    # Extract headers
    raw_headers = []
    thead = table.find("thead") or table.find("tr")
    if thead:
        for cell in thead.find_all(["th", "td"]):
            link = cell.find("a")
            if link:
                text = link.get_text(strip=True)
                if text.startswith("sort table using "):
                    text = text.replace("sort table using ", "")
                raw_headers.append(text.lower())
            else:
                raw_headers.append(cell.get_text(strip=True).lower())

    if len(raw_headers) < 5:
        logger.warning(f"Template table has too few headers: {raw_headers}")
        return []

    # Stat columns start at index 4 (skip #, name, yr, pos)
    stat_headers = raw_headers[4:]

    # Parse rows
    rows = []
    tbody = table.find("tbody")
    trs = tbody.find_all("tr") if tbody else table.find_all("tr")[1:]

    for tr in trs:
        cells = tr.find_all(["td", "th"])
        if len(cells) < 5:
            continue

        row = {}

        # Cell [0] = jersey number
        row["jersey"] = cells[0].get_text(strip=True)

        # Cell [1] = full player name
        name_cell = cells[1]
        name_link = name_cell.find("a")
        if name_link:
            row["name"] = " ".join(name_link.get_text(strip=True).split())
        else:
            row["name"] = " ".join(name_cell.get_text(strip=True).split())

        # Cell [2] = year
        row["year"] = cells[2].get_text(strip=True)

        # Cell [3] = position
        row["pos"] = cells[3].get_text(strip=True)

        # Cells [4:] = stat values
        for i, header in enumerate(stat_headers):
            cell_idx = i + 4
            if cell_idx < len(cells):
                row[header] = cells[cell_idx].get_text(strip=True)

        if row.get("name"):
            rows.append(row)

    return rows


def parse_roster_table(html):
    """
    Parse roster from a team page.
    Columns: #, Name, Position, Year, Status, Height, Weight, Bats, Throws, DOB, Hometown
    """
    soup = BeautifulSoup(html, "html.parser")
    main = soup.find("main") or soup

    tables = main.find_all("table")
    roster_table = None

    for t in tables:
        text = t.get_text()
        if "Position" in text and "Year" in text and "Hometown" in text:
            roster_table = t
            break

    if not roster_table:
        for t in tables:
            thead = t.find("thead") or t.find("tr")
            if thead:
                header_text = thead.get_text()
                if "Name" in header_text and ("Pos" in header_text or "Position" in header_text):
                    roster_table = t
                    break

    if not roster_table:
        logger.warning("No roster table found")
        return []

    headers = []
    thead = roster_table.find("thead")
    if thead:
        for cell in thead.find_all(["th", "td"]):
            headers.append(cell.get_text(strip=True).lower().replace(" ", "_"))
    else:
        first_row = roster_table.find("tr")
        if first_row:
            for cell in first_row.find_all(["th", "td"]):
                headers.append(cell.get_text(strip=True).lower().replace(" ", "_"))

    if not headers:
        return []

    rows = []
    tbody = roster_table.find("tbody")
    trs = tbody.find_all("tr") if tbody else roster_table.find_all("tr")[1:]

    for tr in trs:
        cells = tr.find_all(["td", "th"])
        if len(cells) < 3:
            continue

        row = {}
        for i, cell in enumerate(cells):
            if i < len(headers):
                value = cell.get_text(strip=True)
                row[headers[i]] = value
                link = cell.find("a")
                if link and "/players/" in (link.get("href", "")):
                    row["player_url"] = link["href"]

        # Check for headshot image in the row
        img = tr.find("img")
        if img:
            src = img.get("src") or img.get("data-src") or ""
            if src and "placeholder" not in src.lower() and "default" not in src.lower():
                if src.startswith("//"):
                    row["headshot_url"] = "https:" + src
                elif src.startswith("/"):
                    row["headshot_url"] = BASE_URL + src
                else:
                    row["headshot_url"] = src

        if row.get("name"):
            rows.append(row)

    return rows


# ============================================================
# Name parsing helpers
# ============================================================

def parse_full_name(name_str):
    """Parse a full name like 'Connor Mendez' into (first, last)."""
    if not name_str:
        return "", ""
    parts = name_str.strip().split(None, 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return name_str, ""


def normalize_year(year_str):
    """Normalize year/class strings to standard format: Fr, So, R-Fr, R-So."""
    if not year_str:
        return None
    y = year_str.strip()
    yl = y.lower().replace(".", "").replace(" ", "").replace("-", "").replace("_", "")

    # Detect junk (game scores like "W, 8-3" or "L, 10-0")
    if y.startswith(("W,", "L,")):
        return None

    # Redshirt sophomore
    if yl in ("rsso", "rssoph", "rssophomore", "so(rs)", "rsoph"):
        return "R-So"
    # Redshirt freshman
    if yl in ("rsfr", "rsfreshman"):
        return "R-Fr"
    # Sophomore
    if yl in ("so", "sophomore", "soph"):
        return "So"
    # Freshman
    if yl in ("fr", "freshman", "fresh"):
        return "Fr"

    return None


# ============================================================
# Database helpers
# ============================================================

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
    if val is None or val == "" or val == "-" or val == "---":
        return default
    try:
        return float(str(val).strip())
    except (ValueError, TypeError):
        return default


def get_team_id_map():
    """Build NWAC team name -> team_id and short_name -> team_id maps."""
    team_map = {}
    short_to_id = {}
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT t.id, t.short_name, t.name
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE d.level = 'JUCO' AND t.is_active = 1
        """)
        rows = cur.fetchall()

        for row in rows:
            short_to_id[row["short_name"]] = row["id"]

        for nwac_name, db_short in NWAC_TEAM_MAP.items():
            if db_short and db_short in short_to_id:
                team_map[nwac_name] = short_to_id[db_short]

    logger.info(f"Mapped {len(team_map)} NWAC teams to database IDs")
    return team_map, short_to_id


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
                       "height", "weight", "hometown", "headshot_url"]:
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
               year_in_school, jersey_number, bats, throws, height, weight, hometown, headshot_url, roster_year)
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
                kwargs.get("headshot_url"),
                kwargs.get("roster_year"),
            ),
        )
        cur.execute("SELECT lastval() AS id")
        result = cur.fetchone()
        player_id = result["id"]

    return player_id


# ============================================================
# Scraping functions using template endpoint
# ============================================================

def scrape_team_template(season_str, team_slug, pos):
    """
    Scrape individual stats from the AJAX template endpoint.
    pos: 'h' (batting), 'he' (ext hitting), 'p' (pitching), 'f' (fielding)
    Returns list of dicts from parse_template_table.
    """
    url = f"{BASE_URL}/sports/bsb/{season_str}/teams/{team_slug}?tmpl=brief-category-template&pos={pos}&r=0"
    html = fetch_page(url, season_str=season_str)
    if not html:
        return []
    return parse_template_table(html)


def scrape_team_roster(season_str, team_slug):
    """Scrape roster from the main team page."""
    url = f"{BASE_URL}/sports/bsb/{season_str}/teams/{team_slug}?view=lineup&r=0&pos=h"
    html = fetch_page(url, season_str=season_str)
    if not html:
        return []
    return parse_roster_table(html)


# ============================================================
# Data processing
# ============================================================

def process_all_data(season_str, season_year, skip_rosters=False):
    """
    Main processing function:
    1. For each team, scrape individual batting, ext hitting, pitching via template endpoint
    2. Optionally scrape roster for bio data
    3. Merge batting + extended hitting
    4. Insert into database with advanced stats computed
    """
    team_id_map, short_to_id = get_team_id_map()
    if not team_id_map:
        logger.error("No NWAC teams found in database. Run with --init-db first.")
        return

    batting_count = 0
    batting_errors = 0
    pitching_count = 0
    pitching_errors = 0

    with get_connection() as conn:
        cur = conn.cursor()
        for db_short, slug in NWAC_TEAM_SLUGS.items():
            team_id = short_to_id.get(db_short)
            if not team_id:
                logger.warning(f"  Team {db_short} not in database, skipping")
                continue

            logger.info(f"{'='*50}")
            logger.info(f"Scraping {db_short} ({slug})...")

            # ---- Extract team W-L record from team overview page ----
            team_page_url = f"{BASE_URL}/sports/bsb/{season_str}/teams/{slug}"
            team_page_html = fetch_page(team_page_url, season_str=season_str)
            if team_page_html:
                overall, conf_rec = extract_record_from_html(team_page_html)
                if overall:
                    save_team_record(cur, team_id, int(season_year), overall, conf_rec)

            # ---- Fetch all stat types via template endpoint ----
            batting_rows = scrape_team_template(season_str, slug, "h")
            logger.info(f"  Batting: {len(batting_rows)} players")

            ext_rows = scrape_team_template(season_str, slug, "he")
            logger.info(f"  Extended hitting: {len(ext_rows)} players")

            pitching_rows = scrape_team_template(season_str, slug, "p")
            logger.info(f"  Pitching: {len(pitching_rows)} players")

            roster = []
            if not skip_rosters:
                roster = scrape_team_roster(season_str, slug)
                logger.info(f"  Roster: {len(roster)} players")

            # ---- Build extended hitting lookup by name ----
            ext_lookup = {}
            for ext in ext_rows:
                name = ext.get("name", "").strip().lower()
                if name:
                    ext_lookup[name] = ext

            # ---- Build roster lookup by name ----
            roster_by_name = {}
            for r in roster:
                name = r.get("name", "").strip().lower()
                if name:
                    roster_by_name[name] = r

            # ---- Process batting ----
            for batter in batting_rows:
                try:
                    full_name = batter.get("name", "").strip()
                    if not full_name:
                        continue

                    first_name, last_name = parse_full_name(full_name)
                    if not last_name:
                        continue

                    roster_data = roster_by_name.get(full_name.lower(), {})

                    raw_year = batter.get("year") or roster_data.get("year")
                    year_in_school = normalize_year(raw_year)
                    raw_position = batter.get("pos") or roster_data.get("position")
                    position = raw_position  # store original for roster
                    norm_pos = normalize_position(raw_position) or "UT"  # for WAR calc

                    player_id = insert_or_update_player(
                        cur, first_name, last_name, team_id,
                        position=position or None,
                        year_in_school=year_in_school,
                        jersey_number=batter.get("jersey") or roster_data.get("#"),
                        bats=roster_data.get("bats"),
                        throws=roster_data.get("throws"),
                        height=roster_data.get("height"),
                        weight=safe_int(roster_data.get("weight")) or None,
                        hometown=roster_data.get("hometown"),
                        headshot_url=roster_data.get("headshot_url"),
                        roster_year=season_year,
                    )

                    # Batting counting stats
                    g = safe_int(batter.get("g"))
                    ab = safe_int(batter.get("ab"))
                    r = safe_int(batter.get("r"))
                    h = safe_int(batter.get("h"))
                    doubles = safe_int(batter.get("2b"))
                    triples = safe_int(batter.get("3b"))
                    hr = safe_int(batter.get("hr"))
                    rbi = safe_int(batter.get("rbi"))
                    bb = safe_int(batter.get("bb"))
                    k = safe_int(batter.get("k"))
                    sb = safe_int(batter.get("sb"))
                    cs = safe_int(batter.get("cs"))

                    # Extended hitting (matched by name)
                    ext = ext_lookup.get(full_name.lower(), {})
                    hbp = safe_int(ext.get("hbp"))
                    sf = safe_int(ext.get("sf"))
                    sh = safe_int(ext.get("sh"))
                    pa = safe_int(ext.get("pa"))
                    gidp = safe_int(ext.get("hdp"))

                    # Auto-compute PA if extended data missing
                    if pa == 0 and ab > 0:
                        pa = ab + bb + hbp + sf + sh

                    # Skip players with 0 AB and 0 games
                    if ab == 0 and g == 0:
                        continue

                    # Compute advanced stats
                    line = BattingLine(
                        pa=pa, ab=ab, hits=h, doubles=doubles, triples=triples,
                        hr=hr, bb=bb, ibb=0, hbp=hbp, sf=sf, sh=sh, k=k,
                        sb=sb, cs=cs, gidp=gidp,
                    )
                    adv = compute_batting_advanced(line, division_level="JUCO")

                    # Compute full college WAR with positional adjustment
                    war = compute_college_war(
                        batting=adv, position=norm_pos,
                        plate_appearances=pa, division_level="JUCO",
                    )

                    cur.execute(
                        """INSERT INTO batting_stats
                           (player_id, team_id, season, games, plate_appearances, at_bats,
                            runs, hits, doubles, triples, home_runs, rbi, walks, strikeouts,
                            hit_by_pitch, sacrifice_flies, sacrifice_bunts, stolen_bases,
                            caught_stealing, grounded_into_dp, intentional_walks,
                            batting_avg, on_base_pct, slugging_pct, ops,
                            woba, wraa, wrc, wrc_plus, iso, babip, bb_pct, k_pct, offensive_war)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                                   %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                           ON CONFLICT(player_id, team_id, season) DO UPDATE SET
                            games=excluded.games, plate_appearances=excluded.plate_appearances,
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
                            bb_pct=excluded.bb_pct, k_pct=excluded.k_pct, offensive_war=excluded.offensive_war,
                            updated_at=CURRENT_TIMESTAMP""",
                        (
                            player_id, team_id, season_year, g, pa, ab, r, h, doubles, triples, hr,
                            rbi, bb, k, hbp, sf, sh, sb, cs, gidp, 0,
                            adv.batting_avg, adv.obp, adv.slg, adv.ops,
                            adv.woba, adv.wraa, adv.wrc, adv.wrc_plus,
                            adv.iso, adv.babip, adv.bb_pct, adv.k_pct, war.offensive_war,
                        ),
                    )
                    batting_count += 1

                except Exception as e:
                    logger.error(f"  Error processing batting: {batter.get('name')} ({db_short}) - {e}")
                    batting_errors += 1

            # ---- Process pitching ----
            for pitcher in pitching_rows:
                try:
                    full_name = pitcher.get("name", "").strip()
                    if not full_name:
                        continue

                    first_name, last_name = parse_full_name(full_name)
                    if not last_name:
                        continue

                    roster_data = roster_by_name.get(full_name.lower(), {})

                    raw_year = pitcher.get("year") or roster_data.get("year")
                    year_in_school = normalize_year(raw_year)
                    position = pitcher.get("pos") or roster_data.get("position") or "P"

                    player_id = insert_or_update_player(
                        cur, first_name, last_name, team_id,
                        position=position,
                        year_in_school=year_in_school,
                        jersey_number=pitcher.get("jersey") or roster_data.get("#"),
                        bats=roster_data.get("bats"),
                        throws=roster_data.get("throws"),
                        height=roster_data.get("height"),
                        weight=safe_int(roster_data.get("weight")) or None,
                        hometown=roster_data.get("hometown"),
                        headshot_url=roster_data.get("headshot_url"),
                        roster_year=season_year,
                    )

                    # Pitching stats
                    g = safe_int(pitcher.get("app"))
                    gs = safe_int(pitcher.get("gs"))
                    w = safe_int(pitcher.get("w"))
                    l = safe_int(pitcher.get("l"))
                    sv = safe_int(pitcher.get("sv"))
                    cg = safe_int(pitcher.get("cg"))
                    ip = safe_float(pitcher.get("ip"))
                    h_allowed = safe_int(pitcher.get("h"))
                    runs = safe_int(pitcher.get("r"))
                    er = safe_int(pitcher.get("er"))
                    bb = safe_int(pitcher.get("bb"))
                    k = safe_int(pitcher.get("k"))
                    hr_allowed = safe_int(pitcher.get("hr"))

                    # Skip pitchers with 0 IP and 0 games
                    if ip == 0 and g == 0:
                        continue

                    # Estimate batters faced
                    if ip > 0:
                        outs = int(ip) * 3 + int(round((ip - int(ip)) * 10))
                        bf = outs + h_allowed + bb
                    else:
                        bf = 0

                    line = PitchingLine(
                        ip=ip, hits=h_allowed, er=er, runs=runs, bb=bb, ibb=0,
                        k=k, hr=hr_allowed, hbp=0, bf=bf, wp=0,
                        wins=w, losses=l, saves=sv, games=g, gs=gs,
                    )
                    adv = compute_pitching_advanced(line, division_level="JUCO")

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
                            player_id, team_id, season_year, g, gs, w, l, sv, cg, 0,
                            ip, h_allowed, runs, er, bb, k, hr_allowed, 0, 0, bf, 0,
                            adv.era, adv.whip, adv.k_per_9, adv.bb_per_9, adv.h_per_9,
                            adv.hr_per_9, adv.k_bb_ratio,
                            adv.k_pct, adv.bb_pct,
                            adv.fip, adv.xfip, adv.siera, adv.kwera,
                            adv.babip_against, adv.lob_pct, adv.pitching_war,
                        ),
                    )
                    pitching_count += 1

                except Exception as e:
                    logger.error(f"  Error processing pitching: {pitcher.get('name')} ({db_short}) - {e}")
                    pitching_errors += 1

    # ---- WAF safeguard ----
    if batting_count == 0 and pitching_count == 0:
        logger.warning("=" * 60)
        logger.warning("WARNING: Got 0 batting AND 0 pitching players!")
        logger.warning("This usually means the AWS WAF blocked all requests.")
        logger.warning("Existing NWAC data in the database is UNCHANGED.")
        logger.warning("Run the NWAC scrape from a local machine with Playwright to bypass the WAF.")
        logger.warning("=" * 60)
        return

    # ---- Summary ----
    logger.info("=" * 60)
    logger.info(f"SCRAPE COMPLETE for {season_str} (year={season_year})")
    logger.info(f"  Batting:  {batting_count} players (ALL from team template endpoint)")
    logger.info(f"  Pitching: {pitching_count} players (ALL from team template endpoint)")
    logger.info(f"  Errors:   {batting_errors + pitching_errors}")
    logger.info("=" * 60)


# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="Scrape NWAC baseball stats from nwacsports.com")
    parser.add_argument(
        "--season", type=str, required=True,
        help="Season string, e.g., '2025-26' or '2024-25'"
    )
    parser.add_argument(
        "--skip-rosters", action="store_true",
        help="Skip scraping team roster pages (faster, but no height/weight/bats/throws/hometown)"
    )
    parser.add_argument(
        "--init-db", action="store_true",
        help="Initialize/seed the database before scraping"
    )
    args = parser.parse_args()

    season_str = args.season
    try:
        parts = season_str.split("-")
        season_year = int(parts[0]) + 1
    except (ValueError, IndexError):
        logger.error(f"Invalid season format: '{season_str}'. Use format like '2025-26'")
        sys.exit(1)

    logger.info(f"NWAC Baseball Scraper -- Season {season_str} (year={season_year})")

    if args.init_db:
        init_db()
        seed_divisions_and_conferences()
        logger.info("Database initialized and seeded")

    process_all_data(season_str, season_year, skip_rosters=args.skip_rosters)


if __name__ == "__main__":
    main()
