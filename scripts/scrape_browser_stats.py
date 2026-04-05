#!/usr/bin/env python3
"""
Browser-based Stats Scraper for Seattle U, Willamette, and NWAC
================================================================

Uses Playwright to fetch pages that block regular HTTP requests.
Handles three teams:
  - Seattle U (Sidearm, JS-rendered stats page)
  - Willamette (PrestoSports with similar pattern to NWAC)
  - NWAC (PrestoSports template endpoint)

This script does NOT rely on importing functions from other scrapers
to avoid circular dependencies. Instead, it includes all parsing logic inline.

Usage:
    cd pnw-baseball
    pip install playwright
    python -m playwright install chromium
    PYTHONPATH=backend python3 scripts/scrape_browser_stats.py --season 2026
    PYTHONPATH=backend python3 scripts/scrape_browser_stats.py --season 2026 --team "Seattle U"
    PYTHONPATH=backend python3 scripts/scrape_browser_stats.py --season 2026 --headless
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

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import requests
from bs4 import BeautifulSoup, NavigableString

from app.models.database import get_connection
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
logger = logging.getLogger("scrape_browser_stats")

# ============================================================
# Team Configuration
# ============================================================

TEAMS_CONFIG = {
    "Seattle U": {
        "base_url": "https://goseattleu.com",
        "stats_path": "/sports/baseball/stats",
        "schedule_path": "/sports/baseball/schedule",
        "division": "D1",
        "platform": "wmt_api",
        "wmt_domain": "goseattleu",
        "wmt_team_ids": {2026: 614833},  # season -> WMT team_id
    },
    "Willamette": {
        "base_url": "https://www.wubearcats.com",
        "sport_path": "bsb",
        "slug": "willamette",
        "division": "D3",
        "platform": "presto",
    },
    "NWAC": {
        "base_url": "https://nwacsports.com",
        "sport_path": "bsb",
        "division": "JUCO",
        "platform": "presto",
    },
}

# NWAC team slugs (key = DB short_name, value = URL slug)
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
# Helper Functions
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


def parse_ip(ip_str):
    """Convert innings pitched string like '45.1' to float (45.333)."""
    try:
        parts = str(ip_str).split(".")
        whole = int(parts[0])
        thirds = int(parts[1]) if len(parts) > 1 else 0
        return whole + thirds / 3.0
    except (ValueError, IndexError, TypeError):
        return 0.0


def parse_full_name(name_str):
    """Parse full name like 'Connor Mendez' into (first, last)."""
    if not name_str:
        return "", ""
    parts = name_str.strip().split(None, 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return name_str, ""


def normalize_year(year_str):
    """Normalize year/class strings: Fr, So, Jr, Sr, R-Fr, R-So, etc."""
    if not year_str:
        return None
    y = year_str.strip()
    yl = y.lower().replace(".", "").replace(" ", "").replace("-", "").replace("_", "")

    if y.startswith(("W,", "L,")):
        return None

    if yl in ("rsso", "rssoph", "rssophomore", "so(rs)", "rsoph"):
        return "R-So"
    if yl in ("rsfr", "rsfreshman"):
        return "R-Fr"
    if yl in ("sr", "senior"):
        return "Sr"
    if yl in ("jr", "junior"):
        return "Jr"
    if yl in ("so", "sophomore", "soph"):
        return "So"
    if yl in ("fr", "freshman", "fresh"):
        return "Fr"

    return None


def split_compound(compound_str):
    """Split compound stats like '25-30' into (25, 30)."""
    if not compound_str:
        return 0, 0
    parts = str(compound_str).split("-")
    try:
        return int(parts[0]), int(parts[1]) if len(parts) > 1 else int(parts[0])
    except (ValueError, IndexError):
        return 0, 0


# ============================================================
# PrestoSports Parsing (for Willamette and NWAC)
# ============================================================

def parse_presto_template_table(html):
    """
    Parse PrestoSports brief-category-template HTML table.
    Returns list of dicts with keys: jersey, name, year, pos, and stat columns.
    """
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")
    if not tables:
        logger.warning("No table found in PrestoSports response")
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
        logger.warning(f"PrestoSports table has too few headers: {raw_headers}")
        return []

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

        # Cell [1] = player name
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


# ============================================================
# Sidearm HTML Parsing (for Seattle U)
# ============================================================

def find_stats_tables(html):
    """Find Overall batting and pitching tables in Sidearm stats page."""
    soup = BeautifulSoup(html, "html.parser")

    batting_table = None
    pitching_table = None

    tables = soup.find_all("table")

    for table in tables:
        heading_text = ""
        caption = table.find("caption")
        if caption:
            heading_text = caption.get_text(strip=True).lower()

        if not heading_text:
            prev = table.find_previous(["h2", "h3", "h4", "caption", "div"])
            if prev:
                heading_text = prev.get_text(strip=True).lower()

        thead = table.find("thead")
        if not thead:
            continue
        header_cells = thead.find_all(["th", "td"])
        header_text = " ".join(c.get_text(strip=True) for c in header_cells).lower()

        if "avg" in header_text and "ab" in header_text and "era" not in header_text:
            if "conference" not in heading_text and batting_table is None:
                batting_table = table

        elif "era" in header_text and "ip" in header_text:
            if "conference" not in heading_text and pitching_table is None:
                pitching_table = table

    return batting_table, pitching_table


def parse_sidearm_table(table):
    """Parse Sidearm HTML stats table into list of dicts."""
    if table is None:
        return []

    thead = table.find("thead")
    if not thead:
        return []

    raw_headers = []
    for cell in thead.find_all(["th", "td"]):
        text = cell.get_text(strip=True)
        link = cell.find("a")
        if link:
            text = link.get_text(strip=True)
        raw_headers.append(text)

    if len(raw_headers) < 5:
        return []

    rows = []
    tbody = table.find("tbody")
    trs = tbody.find_all("tr") if tbody else table.find_all("tr")[1:]

    for tr in trs:
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
                if header.lower() == "player":
                    link = cell.find("a")
                    if link:
                        row["player_url"] = link.get("href", "")

                    direct_text = "".join(
                        child.strip()
                        for child in link.children
                        if isinstance(child, NavigableString)
                    ).strip() if link else ""

                    if direct_text and "," in direct_text:
                        value = direct_text
                    else:
                        full_text = cell.get_text(strip=True)
                        name_match = re.search(r'([A-Za-z\'\-\. ]+,\s*[A-Za-z\'\-\. ]+)$', full_text)
                        if name_match:
                            value = name_match.group(1)
                        else:
                            value = full_text
                else:
                    value = cell.get_text(strip=True)

                row[header] = value

        player_name = row.get("Player", "").strip()
        if player_name.lower() in ("totals", "total", "team", "opponents", "opponent", ""):
            continue

        rows.append(row)

    return rows


# ============================================================
# Database Operations
# ============================================================

def get_team_id_by_short_name(cur, short_name):
    """Look up team_id by short_name."""
    cur.execute("SELECT id FROM teams WHERE short_name = %s AND is_active = 1", (short_name,))
    row = cur.fetchone()
    return row["id"] if row else None


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
        for field in ["year_in_school", "jersey_number", "bats", "throws",
                      "height", "weight", "hometown", "headshot_url"]:
            if kwargs.get(field):
                updates.append(f"{field} = COALESCE(%s, {field})")
                params.append(kwargs[field])
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
        cur.execute("SELECT lastval() as id")
        result = cur.fetchone()
        player_id = result["id"]

    return player_id


def insert_batting_stats(cur, player_id, team_id, season, batting_data):
    """Insert or update batting stats."""
    cur.execute(
        """INSERT INTO batting_stats
           (player_id, team_id, season, games, at_bats, runs, hits,
            doubles, triples, home_runs, rbi, walks, strikeouts,
            stolen_bases, caught_stealing, batting_avg, on_base_pct, slugging_pct,
            ops, iso, babip, woba, wrc_plus, bb_pct, k_pct, offensive_war)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT(player_id, team_id, season) DO UPDATE SET
            games=excluded.games, at_bats=excluded.at_bats, runs=excluded.runs,
            hits=excluded.hits, doubles=excluded.doubles, triples=excluded.triples,
            home_runs=excluded.home_runs, rbi=excluded.rbi, walks=excluded.walks,
            strikeouts=excluded.strikeouts, stolen_bases=excluded.stolen_bases,
            caught_stealing=excluded.caught_stealing, batting_avg=excluded.batting_avg,
            on_base_pct=excluded.on_base_pct, slugging_pct=excluded.slugging_pct,
            ops=excluded.ops, iso=excluded.iso, babip=excluded.babip,
            woba=excluded.woba, wrc_plus=excluded.wrc_plus, bb_pct=excluded.bb_pct,
            k_pct=excluded.k_pct, offensive_war=excluded.offensive_war,
            updated_at=CURRENT_TIMESTAMP""",
        (
            player_id, team_id, season,
            batting_data.get("games", 0),
            batting_data.get("ab", 0),
            batting_data.get("r", 0),
            batting_data.get("h", 0),
            batting_data.get("2b", 0),
            batting_data.get("3b", 0),
            batting_data.get("hr", 0),
            batting_data.get("rbi", 0),
            batting_data.get("bb", 0),
            batting_data.get("k", 0),
            batting_data.get("sb", 0),
            batting_data.get("cs", 0),
            batting_data.get("avg", 0.0),
            batting_data.get("obp", 0.0),
            batting_data.get("slg", 0.0),
            batting_data.get("ops", 0.0),
            batting_data.get("iso", 0.0),
            batting_data.get("babip", 0.0),
            batting_data.get("woba", 0.0),
            batting_data.get("wrc_plus", 0.0),
            batting_data.get("bb_pct", 0.0),
            batting_data.get("k_pct", 0.0),
            batting_data.get("war", 0.0),
        ),
    )


def insert_pitching_stats(cur, player_id, team_id, season, pitching_data):
    """Insert or update pitching stats."""
    cur.execute(
        """INSERT INTO pitching_stats
           (player_id, team_id, season, games, games_started, wins, losses,
            innings_pitched, hits_allowed, runs_allowed, earned_runs, walks, strikeouts,
            home_runs_allowed, batters_faced, era, whip, k_per_9, k_pct, bb_pct)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT(player_id, team_id, season) DO UPDATE SET
            games=excluded.games, games_started=excluded.games_started,
            wins=excluded.wins, losses=excluded.losses, innings_pitched=excluded.innings_pitched,
            hits_allowed=excluded.hits_allowed, runs_allowed=excluded.runs_allowed,
            earned_runs=excluded.earned_runs,
            walks=excluded.walks, strikeouts=excluded.strikeouts,
            home_runs_allowed=excluded.home_runs_allowed,
            batters_faced=excluded.batters_faced,
            era=excluded.era, whip=excluded.whip, k_per_9=excluded.k_per_9,
            k_pct=excluded.k_pct, bb_pct=excluded.bb_pct,
            updated_at=CURRENT_TIMESTAMP""",
        (
            player_id, team_id, season,
            pitching_data.get("games", 0),
            pitching_data.get("gs", 0),
            pitching_data.get("w", 0),
            pitching_data.get("l", 0),
            pitching_data.get("ip", 0.0),
            pitching_data.get("h", 0),
            pitching_data.get("r", 0),
            pitching_data.get("er", 0),
            pitching_data.get("bb", 0),
            pitching_data.get("k", 0),
            pitching_data.get("hr", 0),
            pitching_data.get("bf", 0),
            pitching_data.get("era", 0.0),
            pitching_data.get("whip", 0.0),
            pitching_data.get("k9", 0.0),
            pitching_data.get("k_pct", 0.0),
            pitching_data.get("bb_pct", 0.0),
        ),
    )


# ============================================================
# Scraping Functions (using Playwright)
# ============================================================

def scrape_with_playwright(url, headless=False):
    """Fetch a URL using Playwright and return the rendered HTML."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        logger.error("Playwright not installed. Run: pip install playwright && python -m playwright install chromium")
        return None

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=headless)
            context = browser.new_context(
                user_agent=random.choice(USER_AGENTS)
            )
            page = context.new_page()

            logger.info(f"  Loading {url}...")
            page.goto(url, wait_until="networkidle", timeout=30000)
            time.sleep(random.uniform(1.0, 2.0))

            html = page.content()
            page.close()
            context.close()
            browser.close()

            logger.info(f"  Got {len(html)} bytes")
            return html

    except Exception as e:
        logger.error(f"  Playwright failed: {e}")
        return None


def scrape_seattle_u(season, season_year, headless=False):
    """Scrape Seattle U stats using the WMT Games API (no browser needed)."""
    config = TEAMS_CONFIG["Seattle U"]
    db_team_id = None

    with get_connection() as conn:
        cur = conn.cursor()
        db_team_id = get_team_id_by_short_name(cur, "Seattle U")

    if not db_team_id:
        logger.warning("Seattle U not found in database — skipping")
        return 0, 0

    logger.info("="*60)
    logger.info("Scraping: Seattle U (via WMT Games API)")

    # Get WMT team_id for this season
    wmt_team_id = config["wmt_team_ids"].get(season)
    if not wmt_team_id:
        # Try to discover it from the school endpoint
        logger.info("  Looking up WMT team_id for season %d...", season)
        try:
            r = requests.get(
                f"https://api.wmt.games/api/schools/{config['wmt_domain']}",
                headers={"User-Agent": random.choice(USER_AGENTS)},
                timeout=15,
            )
            school_data = r.json().get("data", {})
            school_id = school_data.get("statistic_configuration", {}).get("school_id")
            if school_id:
                # Search for the baseball team in this season
                r2 = requests.get(
                    f"https://api.wmt.games/api/statistics/teams",
                    params={"filter[org_id]": school_id, "filter[sport_code]": "MBA",
                            "filter[season_academic_year]": season, "per_page": 5},
                    headers={"User-Agent": random.choice(USER_AGENTS)},
                    timeout=15,
                )
                teams = r2.json().get("data", [])
                if teams:
                    wmt_team_id = teams[0]["id"]
                    logger.info(f"  Found WMT team_id: {wmt_team_id}")
        except Exception as e:
            logger.warning(f"  Could not discover WMT team_id: {e}")

    if not wmt_team_id:
        logger.error("No WMT team_id for Seattle U season %d — skipping", season)
        return 0, 0

    # Fetch all players with stats from WMT API
    api_url = f"https://api.wmt.games/api/statistics/teams/{wmt_team_id}/players?per_page=150"
    logger.info(f"  Fetching: {api_url}")

    try:
        resp = requests.get(api_url, headers={"User-Agent": random.choice(USER_AGENTS)}, timeout=30)
        resp.raise_for_status()
        players = resp.json().get("data", [])
    except Exception as e:
        logger.error(f"  API request failed: {e}")
        return 0, 0

    logger.info(f"  Got {len(players)} players from WMT API")

    # Also fetch team record (wins/losses)
    try:
        team_resp = requests.get(
            f"https://api.wmt.games/api/statistics/teams/{wmt_team_id}",
            headers={"User-Agent": random.choice(USER_AGENTS)}, timeout=15,
        )
        team_data = team_resp.json().get("data", {})
        wins = team_data.get("wins", 0)
        losses = team_data.get("losses", 0)
        if wins or losses:
            overall = (wins, losses)
            with get_connection() as conn:
                save_team_record(conn.cursor(), db_team_id, season_year, overall, None)
                conn.commit()
            logger.info(f"  Record: {wins}-{losses}")
    except Exception as e:
        logger.warning(f"  Could not fetch team record: {e}")

    batting_count = 0
    pitching_count = 0

    with get_connection() as conn:
        cur = conn.cursor()

        for player in players:
            try:
                first_name = player.get("first_name", "").strip()
                last_name = player.get("last_name", "").strip()
                if not last_name:
                    continue

                raw_pos = player.get("position_code", "")
                norm_pos = normalize_position(raw_pos) or "UT"
                year_class = player.get("class_short_descr", "")
                year_in_school = normalize_year(year_class)
                jersey = player.get("jersey_no")

                player_id = insert_or_update_player(
                    cur, first_name, last_name, db_team_id,
                    position=norm_pos,
                    year_in_school=year_in_school,
                    jersey_number=jersey,
                    roster_year=season,
                )

                # Extract season stats
                stat_data = player.get("statistic", {})
                if not stat_data or not stat_data.get("data"):
                    continue
                season_data = stat_data["data"].get("season")
                if not season_data or not season_data.get("columns"):
                    continue

                stats = season_data["columns"][0].get("statistic", {})
                gp = season_data.get("gamesPlayed", 0)
                gs = season_data.get("gamesStarted", 0)

                # Determine if this player has pitching stats
                has_pitching = stats.get("sInningsPitched") is not None and stats.get("sInningsPitched", 0) > 0
                has_batting = stats.get("sAtBats") is not None and stats.get("sAtBats", 0) > 0

                # Process batting stats
                if has_batting:
                    ab = safe_int(stats.get("sAtBats"))
                    h = safe_int(stats.get("sHits"))
                    r = safe_int(stats.get("sRuns"))
                    d2 = safe_int(stats.get("sDoubles"))
                    d3 = safe_int(stats.get("sTriples"))
                    hr = safe_int(stats.get("sHomeRuns"))
                    rbi = safe_int(stats.get("sRunsBattedIn"))
                    bb = safe_int(stats.get("sWalks"))
                    hbp = safe_int(stats.get("sHitByPitch"))
                    k = safe_int(stats.get("sStrikeoutsHitting"))
                    sb = safe_int(stats.get("sStolenBases"))
                    cs = safe_int(stats.get("sCaughtStealing"))
                    sf = safe_int(stats.get("sSacrificeFlies"))
                    sh = safe_int(stats.get("sSacrificeHits"))
                    pa = safe_int(stats.get("cPlateAppearances")) or (ab + bb + hbp + sf + sh)

                    line = BattingLine(
                        pa=pa, ab=ab, hits=h, doubles=d2, triples=d3,
                        hr=hr, bb=bb, hbp=hbp, sf=sf, sh=sh, k=k,
                        sb=sb, cs=cs
                    )
                    adv = compute_batting_advanced(line, division_level="D1")
                    war = compute_college_war(
                        batting=adv, position=norm_pos,
                        plate_appearances=pa, division_level="D1",
                    )

                    batting_data = {
                        "games": gp, "ab": ab, "r": r, "h": h,
                        "2b": d2, "3b": d3, "hr": hr, "rbi": rbi,
                        "bb": bb, "k": k, "sb": sb, "cs": cs,
                        "avg": adv.batting_avg, "obp": adv.obp,
                        "slg": adv.slg, "ops": adv.ops, "iso": adv.iso,
                        "babip": adv.babip, "woba": adv.woba,
                        "wrc_plus": adv.wrc_plus, "bb_pct": adv.bb_pct,
                        "k_pct": adv.k_pct, "war": war.offensive_war,
                    }
                    insert_batting_stats(cur, player_id, db_team_id, season_year, batting_data)
                    batting_count += 1

                # Process pitching stats
                if has_pitching:
                    ip = safe_float(stats.get("sInningsPitched"))
                    p_h = safe_int(stats.get("sHitsAllowed"))
                    p_r = safe_int(stats.get("sRunsAllowed"))
                    er = safe_int(stats.get("sEarnedRuns"))
                    p_bb = safe_int(stats.get("sBasesOnBallsAllowed"))
                    p_k = safe_int(stats.get("sStrikeouts"))
                    p_hr = safe_int(stats.get("sHomeRunsAllowed"))
                    p_hbp = safe_int(stats.get("sHitBattersPitching"))
                    w = safe_int(stats.get("sIndWon"))
                    l = safe_int(stats.get("sIndLost"))
                    sv = safe_int(stats.get("sSaves"))
                    p_gp = safe_int(stats.get("sPitchingAppearances")) or gp
                    p_gs = safe_int(stats.get("sPitcherGamesStarted")) or gs
                    p_bf = safe_int(stats.get("sBattersFaced"))

                    # Estimate BF if not provided by API
                    if not p_bf and ip > 0:
                        outs = int(ip) * 3 + int(round((ip - int(ip)) * 10))
                        p_bf = outs + p_h + p_bb + p_hbp

                    line = PitchingLine(
                        ip=ip, hits=p_h, runs=p_r, er=er, bb=p_bb, k=p_k, hr=p_hr,
                        hbp=p_hbp, bf=p_bf,
                    )
                    adv = compute_pitching_advanced(line)

                    pitching_data = {
                        "games": p_gp, "gs": p_gs, "w": w, "l": l,
                        "ip": ip, "h": p_h, "r": p_r, "er": er,
                        "bb": p_bb, "k": p_k, "hr": p_hr,
                        "bf": p_bf,
                        "era": adv.era, "whip": adv.whip,
                        "k9": adv.k_per_9, "k_pct": adv.k_pct,
                        "bb_pct": adv.bb_pct,
                    }
                    insert_pitching_stats(cur, player_id, db_team_id, season_year, pitching_data)
                    pitching_count += 1

            except Exception as e:
                logger.warning(f"    Error processing {player.get('first_name')} {player.get('last_name')}: {e}")

        conn.commit()

    return batting_count, pitching_count


def scrape_presto_team(team_name, team_db_short, slug, season, season_year, headless=False):
    """Scrape PrestoSports team (Willamette or NWAC team)."""
    is_nwac = team_name == "NWAC"

    if is_nwac:
        config = TEAMS_CONFIG["NWAC"]
        base_url = config["base_url"]
    else:
        config = TEAMS_CONFIG["Willamette"]
        base_url = config["base_url"]

    # Get team_id from database
    team_id = None
    with get_connection() as conn:
        cur = conn.cursor()
        team_id = get_team_id_by_short_name(cur, team_db_short)

    if not team_id:
        logger.warning(f"{team_db_short} not found in database — skipping")
        return 0, 0

    logger.info("="*60)
    logger.info(f"Scraping: {team_db_short} ({team_name})")

    batting_count = 0
    pitching_count = 0

    # PrestoSports season format: 2026 -> "2025-26"
    season_str = f"{season - 1}-{str(season)[2:]}"

    # Batting stats
    batting_url = f"{base_url}/sports/{config['sport_path']}/{season_str}/teams/{slug}?tmpl=brief-category-template&pos=h&r=0"
    logger.info(f"  Fetching batting: {batting_url}")
    batting_html = scrape_with_playwright(batting_url, headless=headless)
    batting_rows = parse_presto_template_table(batting_html) if batting_html else []

    # Extended hitting stats
    ext_url = f"{base_url}/sports/{config['sport_path']}/{season_str}/teams/{slug}?tmpl=brief-category-template&pos=he&r=0"
    logger.info(f"  Fetching extended hitting: {ext_url}")
    ext_html = scrape_with_playwright(ext_url, headless=headless)
    ext_rows = parse_presto_template_table(ext_html) if ext_html else []

    # Pitching stats
    pitching_url = f"{base_url}/sports/{config['sport_path']}/{season_str}/teams/{slug}?tmpl=brief-category-template&pos=p&r=0"
    logger.info(f"  Fetching pitching: {pitching_url}")
    pitching_html = scrape_with_playwright(pitching_url, headless=headless)
    pitching_rows = parse_presto_template_table(pitching_html) if pitching_html else []

    # Record
    team_page_url = f"{base_url}/sports/{config['sport_path']}/{season_str}/teams/{slug}"
    team_page_html = scrape_with_playwright(team_page_url, headless=headless)
    if team_page_html:
        overall, conf = extract_record_from_html(team_page_html)
        if overall:
            with get_connection() as conn:
                save_team_record(conn.cursor(), team_id, season, overall, conf)

    logger.info(f"  Batting: {len(batting_rows)} players")
    logger.info(f"  Extended hitting: {len(ext_rows)} players")
    logger.info(f"  Pitching: {len(pitching_rows)} players")

    # Build extended hitting lookup
    ext_lookup = {}
    for ext in ext_rows:
        name = ext.get("name", "").strip().lower()
        if name:
            ext_lookup[name] = ext

    # Process batting
    with get_connection() as conn:
        cur = conn.cursor()

        for batter in batting_rows:
            try:
                full_name = batter.get("name", "").strip()
                if not full_name:
                    continue

                first_name, last_name = parse_full_name(full_name)
                if not last_name:
                    continue

                raw_year = batter.get("year")
                year_in_school = normalize_year(raw_year)
                raw_pos = batter.get("pos")
                norm_pos = normalize_position(raw_pos) or "UT"

                player_id = insert_or_update_player(
                    cur, first_name, last_name, team_id,
                    position=norm_pos,
                    year_in_school=year_in_school,
                    jersey_number=batter.get("jersey"),
                    roster_year=season,
                )

                # Batting stats
                g = safe_int(batter.get("g"))
                ab = safe_int(batter.get("ab"))
                r = safe_int(batter.get("r"))
                h = safe_int(batter.get("h"))
                d2 = safe_int(batter.get("2b"))
                d3 = safe_int(batter.get("3b"))
                hr = safe_int(batter.get("hr"))
                rbi = safe_int(batter.get("rbi"))
                bb = safe_int(batter.get("bb"))
                k = safe_int(batter.get("k"))
                sb = safe_int(batter.get("sb"))
                cs = safe_int(batter.get("cs"))

                # Extended hitting from ext table
                ext = ext_lookup.get(full_name.lower(), {})
                hbp = safe_int(ext.get("hbp"))
                sf = safe_int(ext.get("sf"))
                sh = safe_int(ext.get("sh"))

                if ab == 0 and g == 0:
                    continue

                pa = ab + bb + hbp + sf + sh

                # Compute advanced stats
                line = BattingLine(
                    pa=pa, ab=ab, hits=h, doubles=d2, triples=d3,
                    hr=hr, bb=bb, hbp=hbp, sf=sf, sh=sh, k=k,
                    sb=sb, cs=cs
                )
                div_level = "D3" if "Willamette" in team_name else "JUCO"
                adv = compute_batting_advanced(line, division_level=div_level)

                war = compute_college_war(
                    batting=adv, position=norm_pos,
                    plate_appearances=pa, division_level=div_level,
                )

                batting_data = {
                    "games": g,
                    "ab": ab,
                    "r": r,
                    "h": h,
                    "2b": d2,
                    "3b": d3,
                    "hr": hr,
                    "rbi": rbi,
                    "bb": bb,
                    "k": k,
                    "sb": sb,
                    "cs": cs,
                    "avg": adv.batting_avg,
                    "obp": adv.obp,
                    "slg": adv.slg,
                    "ops": adv.ops,
                    "iso": adv.iso,
                    "babip": adv.babip,
                    "woba": adv.woba,
                    "wrc_plus": adv.wrc_plus,
                    "bb_pct": adv.bb_pct,
                    "k_pct": adv.k_pct,
                    "war": war.offensive_war,
                }

                insert_batting_stats(cur, player_id, team_id, season, batting_data)
                batting_count += 1

            except Exception as e:
                logger.warning(f"    Error processing batter {batter.get('name')}: {e}")

        # Process pitching
        for pitcher in pitching_rows:
            try:
                full_name = pitcher.get("name", "").strip()
                if not full_name:
                    continue

                first_name, last_name = parse_full_name(full_name)
                if not last_name:
                    continue

                raw_year = pitcher.get("year")
                year_in_school = normalize_year(raw_year)
                raw_pos = pitcher.get("pos")
                norm_pos = normalize_position(raw_pos) or "P"

                player_id = insert_or_update_player(
                    cur, first_name, last_name, team_id,
                    position=norm_pos,
                    year_in_school=year_in_school,
                    jersey_number=pitcher.get("jersey"),
                    roster_year=season,
                )

                # Pitching stats
                gp = safe_int(pitcher.get("app"))
                gs = safe_int(pitcher.get("gs"))
                w = safe_int(pitcher.get("w"))
                l = safe_int(pitcher.get("l"))
                ip = parse_ip(pitcher.get("ip"))
                h = safe_int(pitcher.get("h"))
                r = safe_int(pitcher.get("r"))
                er = safe_int(pitcher.get("er"))
                bb = safe_int(pitcher.get("bb"))
                k = safe_int(pitcher.get("k"))
                hr = safe_int(pitcher.get("hr"))
                hbp = safe_int(pitcher.get("hb") or pitcher.get("hbp"))

                if ip == 0 and gp == 0:
                    continue

                # Estimate batters faced: outs + hits + walks + HBP
                if ip > 0:
                    outs = int(ip) * 3 + int(round((ip - int(ip)) * 10))
                    bf = outs + h + bb + hbp
                else:
                    bf = 0

                line = PitchingLine(
                    ip=ip, hits=h, runs=r, er=er, bb=bb, k=k, hr=hr, hbp=hbp, bf=bf
                )
                div_level = "D3" if "Willamette" in team_name else "JUCO"
                adv = compute_pitching_advanced(line)

                pitching_data = {
                    "games": gp,
                    "gs": gs,
                    "w": w,
                    "l": l,
                    "ip": ip,
                    "h": h,
                    "r": r,
                    "er": er,
                    "bb": bb,
                    "k": k,
                    "hr": hr,
                    "bf": bf,
                    "era": adv.era,
                    "whip": adv.whip,
                    "k9": adv.k_per_9,
                    "k_pct": adv.k_pct,
                    "bb_pct": adv.bb_pct,
                }

                insert_pitching_stats(cur, player_id, team_id, season, pitching_data)
                pitching_count += 1

            except Exception as e:
                logger.warning(f"    Error processing pitcher {pitcher.get('name')}: {e}")

        conn.commit()

    return batting_count, pitching_count


# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="Browser-based stats scraper for Seattle U, Willamette, NWAC")
    parser.add_argument("--season", type=int, default=2026, help="Season year (default: 2026)")
    parser.add_argument("--team", type=str, default=None, help="Single team to scrape (Seattle U, Willamette, or NWAC)")
    parser.add_argument("--headless", action="store_true", help="Run browser in headless mode")
    args = parser.parse_args()

    season = args.season
    season_year = season

    logger.info(f"Browser Stats Scraper — Season {season}")
    logger.info(f"Headless: {args.headless}")
    logger.info("")

    teams_to_scrape = []

    if args.team:
        if args.team == "Seattle U":
            teams_to_scrape.append(("Seattle U", None, None))
        elif args.team == "Willamette":
            teams_to_scrape.append(("Willamette", "Willamette", "willamette"))
        elif args.team == "NWAC":
            # Add all NWAC teams
            for db_short, slug in NWAC_TEAM_SLUGS.items():
                teams_to_scrape.append(("NWAC", db_short, slug))
        else:
            logger.error(f"Unknown team: {args.team}")
            return
    else:
        # Default: all three
        teams_to_scrape.append(("Seattle U", None, None))
        teams_to_scrape.append(("Willamette", "Willamette", "willamette"))
        for db_short, slug in NWAC_TEAM_SLUGS.items():
            teams_to_scrape.append(("NWAC", db_short, slug))

    total_batting = 0
    total_pitching = 0

    for team_name, team_db_short, slug in teams_to_scrape:
        try:
            if team_name == "Seattle U":
                b, p = scrape_seattle_u(season, season_year, headless=args.headless)
            else:
                b, p = scrape_presto_team(team_name, team_db_short, slug, season, season_year, headless=args.headless)

            total_batting += b
            total_pitching += p

        except Exception as e:
            logger.error(f"Error scraping {team_name}: {e}", exc_info=True)

    logger.info("")
    logger.info("="*60)
    logger.info(f"DONE — Total: {total_batting} batting, {total_pitching} pitching")


if __name__ == "__main__":
    main()
