#!/usr/bin/env python3
"""
Scrape national ratings from Pear Ratings and CollegeBaseballRatings (CBR).

Imports rating data for all PNW teams and stores it in national_ratings table.
Then computes composite rankings and cross-division comparisons.

Usage:
    cd pnw-baseball
    python3 scripts/scrape_national_ratings.py --season 2026
    python3 scripts/scrape_national_ratings.py --season 2026 --source pear
    python3 scripts/scrape_national_ratings.py --season 2026 --source cbr
    python3 scripts/scrape_national_ratings.py --season 2026 --composite-only

Pear Ratings: Uses their JSON API directly (no browser needed).
CBR: Uses server-rendered HTML (no browser needed).

Requires: requests, beautifulsoup4
"""

import sys
import os
import csv
import io
import time
import random
import argparse
import logging
import re
from pathlib import Path
from datetime import datetime

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
from app.models.database import get_connection

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("national_ratings")

PROJECT_ROOT = Path(__file__).parent.parent

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
})


def fetch(url, delay=(0.5, 1.5)):
    """Fetch URL with polite delay."""
    time.sleep(random.uniform(*delay))
    try:
        resp = session.get(url, timeout=20)
        if resp.status_code == 200:
            return resp.text
        logger.warning(f"  HTTP {resp.status_code} for {url}")
    except Exception as e:
        logger.warning(f"  Error fetching {url}: {e}")
    return None


# ============================================================
# TEAM NAME MAPPING
# ============================================================
# Maps our DB team_id to the names used by each external source.
# This is the critical piece — each source names teams differently.

# Our PNW teams by division:
# D1:   UW (1), Oregon (2), Oregon St. (3), Wash. St. (4),
#        Portland (482), Gonzaga (483), Seattle U (484)
# D2:   CWU (5), SMU (6), MSUB (7), WOU (8), NNU (9)
# D3:   UPS (10), PLU (11), Whitman (12), Whitworth (13),
#        Linfield (14), L&C (15), Willamette (16), Pacific (17), GFU (18)
# NAIA: EOU (19), OIT (20), C of I (21), LCSC (22), Corban (23),
#        Bushnell (24), UBC (5720), Warner Pacific (505)

PEAR_NAME_MAP = {
    # D1
    1: "Washington",
    2: "Oregon",
    3: "Oregon St.",
    4: "Washington St.",
    482: "Portland",
    483: "Gonzaga",
    484: "Seattle U",
    # D2
    5: "Central Wash.",
    6: "Saint Martin's",
    7: "Mont. St. Billings",
    8: "Western Ore.",
    9: "Northwest Nazarene",
    # D3
    10: "Puget Sound",
    11: "Pacific Lutheran",
    12: "Whitman",
    13: "Whitworth",
    14: "Linfield",
    15: "Lewis & Clark",
    16: "Willamette",
    17: "Pacific (OR)",
    18: "George Fox",
    # NAIA
    19: "Eastern Oregon",
    20: "Oregon Tech",
    21: "College of Idaho",
    22: "Lewis-Clark (ID)",
    23: "Corban",
    24: "Bushnell (OR)",
    5720: "British Columbia",
    505: "Warner Pacific",
}

CBR_NAME_MAP = {
    # D1 (CBR uses different naming)
    1: "Washington",
    2: "Oregon",
    3: "Oregon State",
    4: "Washington State",
    482: "Portland",
    483: "Gonzaga",
    484: "Seattle",
    # D2
    5: "Central Washington",
    6: "Saint Martin's",
    7: "MSU Billings",
    8: "Western Oregon",
    9: "Northwest Nazarene",
    # D3
    10: "Puget Sound",
    11: "Pacific Lutheran",
    12: "Whitman",
    13: "Whitworth",
    14: "Linfield",
    15: "Lewis & Clark",
    16: "Willamette",
    17: "Pacific (OR)",
    18: "George Fox",
    # NAIA
    19: "Eastern Oregon",
    20: "Oregon Tech",
    21: "College of Idaho",
    22: "Lewis-Clark State",
    23: "Corban",
    24: "Bushnell",
    5720: "British Columbia",
    505: "Warner Pacific",
}

# Division level -> Pear API endpoint path
PEAR_API_URLS = {
    "D1": "https://pearatings.com/api/cbase/stats",
    "D2": "https://pearatings.com/api/d2-cbase/stats",
    "D3": "https://pearatings.com/api/d3-cbase/stats",
    "NAIA": "https://pearatings.com/api/naia-cbase/stats",
}

# Division level -> CBR URL
CBR_URLS = {
    "D1": "https://www.collegebaseballratings.com/",
    "D2": "https://www.collegebaseballratings.com/d2ratings.php",
    "D3": "https://www.collegebaseballratings.com/d3ratings.php",
    "NAIA": "https://www.collegebaseballratings.com/naiaratings.php",
}


def get_pnw_teams(conn):
    """Get all PNW teams with their division info."""
    cur = conn.cursor()
    cur.execute("""
        SELECT t.id, t.short_name, t.school_name, d.level as division_level
        FROM teams t
        JOIN conferences c ON t.conference_id = c.id
        JOIN divisions d ON c.division_id = d.id
        WHERE t.is_active = 1
        ORDER BY d.level, t.short_name
    """)
    rows = cur.fetchall()
    return [dict(r) for r in rows]


# ============================================================
# PEAR RATINGS SCRAPER
# ============================================================

def scrape_pear_ratings(conn, season, teams_by_div):
    """
    Scrape Pear Ratings for all divisions using their JSON API.

    Pear's React frontend fetches data from API endpoints that return JSON.
    We call these APIs directly, which is much more reliable than HTML parsing.

    API fields: Team, Conference, Rating (TSR), NET (rank), NET_Score,
                PRR (rank), RQI (rank), SOS (rank), RemSOS, SOR, etc.
    D1 also has: RPI, ELO, ELO_Rank, NCSOS
    """
    logger.info("=" * 60)
    logger.info("SCRAPING PEAR RATINGS (JSON API)")
    logger.info("=" * 60)

    count = 0

    for div_level, api_url in PEAR_API_URLS.items():
        if div_level not in teams_by_div:
            continue

        url = f"{api_url}?season={season}"
        logger.info(f"\n  Fetching Pear {div_level}: {url}")

        time.sleep(random.uniform(1.0, 2.0))
        try:
            resp = session.get(url, timeout=20)
            if resp.status_code != 200:
                logger.error(f"  HTTP {resp.status_code} for Pear {div_level}")
                continue
            data = resp.json()
        except Exception as e:
            logger.error(f"  Error fetching Pear {div_level}: {e}")
            continue

        # The API returns {"stats": [...]} or just [...]
        stats = data.get("stats", data) if isinstance(data, dict) else data
        if not stats:
            logger.warning(f"  No data returned for Pear {div_level}")
            continue

        total_teams = len(stats)
        logger.info(f"  Got {total_teams} teams from Pear {div_level}")

        # Build lookup by team name (lowercase)
        pear_lookup = {}
        for entry in stats:
            name = entry.get("Team", "")
            pear_lookup[name.lower()] = entry

        # Match our PNW teams
        pnw_teams = teams_by_div.get(div_level, [])
        for team in pnw_teams:
            team_id = team["id"]
            pear_name = PEAR_NAME_MAP.get(team_id)
            if not pear_name:
                logger.warning(f"  No Pear name mapping for team {team_id} ({team['short_name']})")
                continue

            entry = pear_lookup.get(pear_name.lower())
            if not entry:
                # Try fuzzy match
                for key, val in pear_lookup.items():
                    if pear_name.lower() in key or key in pear_name.lower():
                        entry = val
                        break

            if entry:
                net_rank = entry.get("NET")
                net_score = entry.get("NET_Score")
                tsr = entry.get("Rating")
                rqi_rank = entry.get("RQI")
                sos_rank = entry.get("SOS")
                avg_ew = entry.get("avg_expected_wins")  # raw SOS-like metric

                with get_connection() as conn:
                    cur = conn.cursor()
                    cur.execute("""
                        INSERT INTO national_ratings
                        (team_id, season, source, national_rank, total_teams, rating,
                         sos, sos_rank, tsr, rqi, source_team_name)
                        VALUES (%s, %s, 'pear', %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (team_id, season, source) DO UPDATE SET
                            national_rank = EXCLUDED.national_rank,
                            total_teams = EXCLUDED.total_teams,
                            rating = EXCLUDED.rating,
                            sos = EXCLUDED.sos,
                            sos_rank = EXCLUDED.sos_rank,
                            tsr = EXCLUDED.tsr,
                            rqi = EXCLUDED.rqi,
                            source_team_name = EXCLUDED.source_team_name
                    """, (
                        team_id, season,
                        net_rank, total_teams,
                        net_score,
                        avg_ew,       # SOS stored as avg expected wins (raw value)
                        sos_rank,     # SOS rank within division
                        tsr,          # Team Strength Rating
                        rqi_rank,     # Resume Quality Index rank
                        pear_name,
                    ))
                count += 1
                logger.info(f"    ✓ {team['short_name']}: NET #{net_rank} "
                           f"(Score={net_score:.4f}, TSR={tsr:.2f}, "
                           f"RQI #{rqi_rank}, SOS #{sos_rank})")
            else:
                logger.warning(f"    ✗ Could not find '{pear_name}' in Pear {div_level}")

    logger.info(f"\n  Pear: imported {count} team ratings")
    return count


# ============================================================
# MASSEY RATINGS SCRAPER
# ============================================================
# Massey uses Cloudflare which blocks the requests library.
# We support two modes:
# 1. Direct HTTP fetch (may get 403)
# 2. Read from local text files saved from Chrome (--massey-dir)
#
# To save Massey pages for offline parsing:
#   1. Open each page in Chrome (e.g. masseyratings.com/cbase/naia/ratings)
#   2. Select All (Cmd+A), Copy (Cmd+C), paste into a text file
#   3. Save as massey_naia.txt, massey_d1.txt, massey_d2.txt, massey_d3.txt
#      in a directory, then pass --massey-dir /path/to/dir
#
# Massey page text format per team entry (concatenated, no spaces):
#   TeamNameConference W-L [+/-Δ] Rat(rank) Pwr(rank) Off(rank) Def(rank) HFA SoS(rank) SSF(rank) EW EL
# Example: "Lewis-Clark IDCascade CC22-30.88027.6915.6439.4913.070.24220.61190.6417.714.29"

def scrape_massey_ratings(conn, season, teams_by_div, massey_dir=None):
    """Scrape Massey Ratings for all divisions."""
    logger.info("=" * 60)
    logger.info("SCRAPING MASSEY RATINGS")
    logger.info("=" * 60)

    count = 0

    for div_level, div_slug in MASSEY_DIVISIONS.items():
        if div_level not in teams_by_div:
            continue

        page_text = None

        # Try reading from saved file first
        if massey_dir:
            filename = f"massey_{div_slug}.txt"
            filepath = Path(massey_dir) / filename
            if filepath.exists():
                logger.info(f"\n  Reading Massey {div_level} from {filepath}")
                page_text = filepath.read_text(encoding="utf-8")
            else:
                logger.warning(f"  File not found: {filepath}")

        # Fall back to HTTP fetch
        if not page_text:
            url = f"https://masseyratings.com/cbase/{div_slug}/ratings"
            logger.info(f"\n  Fetching Massey {div_level}: {url}")
            html = fetch(url, delay=(2.0, 3.0))
            if html:
                page_text = BeautifulSoup(html, "html.parser").get_text()
            else:
                logger.error(f"  Failed to fetch Massey {div_level} (Cloudflare block)")
                logger.info(f"  TIP: Save page text from Chrome and use --massey-dir")
                continue

        if not page_text or len(page_text) < 500:
            logger.warning(f"  Page text too short for Massey {div_level}, skipping")
            continue

        # Count total teams by counting W-L record patterns
        record_matches = re.findall(r'\b\d{1,2}-\d{1,2}\b', page_text)
        total_teams = len(record_matches)
        logger.info(f"  Estimated {total_teams} teams in Massey {div_level}")

        # Match our PNW teams directly by name
        pnw_teams = teams_by_div.get(div_level, [])
        for team in pnw_teams:
            team_id = team["id"]
            massey_name = MASSEY_NAME_MAP.get(team_id)
            if not massey_name:
                logger.warning(f"  No Massey name for {team_id} ({team['short_name']})")
                continue

            result = _find_massey_team(page_text, massey_name)
            if result:
                with get_connection() as conn:
                    cur = conn.cursor()
                    cur.execute("""
                        INSERT INTO national_ratings
                        (team_id, season, source, national_rank, total_teams, rating,
                         sos, sos_rank, power_rating, source_team_name)
                        VALUES (%s, %s, 'massey', %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (team_id, season, source) DO UPDATE SET
                            national_rank = EXCLUDED.national_rank,
                            total_teams = EXCLUDED.total_teams,
                            rating = EXCLUDED.rating,
                            sos = EXCLUDED.sos,
                            sos_rank = EXCLUDED.sos_rank,
                            power_rating = EXCLUDED.power_rating,
                            source_team_name = EXCLUDED.source_team_name
                    """, (
                        team_id, season,
                        result["rank"], total_teams,
                        result["rating"],
                        result.get("sos"),
                        result.get("sos_rank"),
                        result.get("power"),
                        massey_name,
                    ))
                count += 1
                logger.info(f"    ✓ {team['short_name']}: #{result['rank']} "
                           f"(Rat={result['rating']:.3f}, Pwr={result.get('power', 0):.2f}, "
                           f"SoS={result.get('sos', 0):.4f})")
            else:
                logger.warning(f"    ✗ Could not find '{massey_name}' in Massey {div_level}")

    logger.info(f"\n  Massey: imported {count} team ratings")
    return count


def _find_massey_team(page_text, team_name):
    """
    Find a specific team in Massey ratings page text and extract their data.

    Works with the INNERTEXT format (copy-paste from Chrome), where values
    are separated by whitespace (newlines, tabs). This is the format users
    will get when they copy-paste from Chrome.

    The sequence of tokens after the team name + conference + W-L record:
    Rating [Δ] RatRank Pwr PwrRank Off OffRank Def DefRank HFA SoS SoSRank SSF SSFRank EW EL

    Example tokens for Lewis-Clark ID:
    "22-3", "0.880", "2", "7.69", "1", "5.64", "3", "9.49", "1", "3.07",
    "0.24", "22", "0.61", "19", "0.64", "17.71", "4.29"
    """
    # Find the team name in the text
    idx = page_text.find(team_name)
    if idx < 0:
        # Try case-insensitive
        idx = page_text.lower().find(team_name.lower())
    if idx < 0:
        return None

    # Get a chunk of text after the team name (enough for all their data)
    chunk = page_text[idx:idx + 600]

    # Split into whitespace-delimited tokens
    tokens = chunk.split()

    # Find the W-L record token (format: "DD-DD" or "DD-DD-D")
    wl_idx = None
    for i, tok in enumerate(tokens):
        if re.match(r'^\d{1,2}-\d{1,2}(-\d)?$', tok):
            wl_idx = i
            break

    if wl_idx is None:
        return None

    # Extract number tokens after the W-L record
    # The rating and stats follow
    num_tokens = tokens[wl_idx + 1:]

    # Parse numbers from tokens, skipping non-numeric tokens
    nums = []
    for tok in num_tokens[:25]:  # We need about 15-17 numbers
        try:
            nums.append(float(tok))
        except ValueError:
            continue

    if len(nums) < 10:
        return None

    try:
        # First number is always the Rating (0.xxx)
        rating = nums[0]

        # Check for optional Δ (change in ranking)
        # If present, it's a small integer like +2, -5, +13
        # RatRank follows Δ (or comes directly after Rating if no Δ)
        idx = 1
        candidate = nums[1]

        # Distinguish Δ from RatRank:
        # Δ can be negative (-1, -5, etc.) — ranks are NEVER negative
        # After Δ: RatRank (integer), then Pwr (decimal like 7.69)
        # Without Δ: RatRank (integer), then Pwr (decimal)
        # Key: if nums[2] is decimal -> no Δ (nums[1]=rank, nums[2]=Pwr)
        #      if nums[2] is integer -> Δ present (nums[1]=Δ, nums[2]=rank)
        if nums[1] < 0:
            # Negative value is definitely Δ (ranks are always positive)
            idx = 2
        elif len(nums) > 2 and nums[2] == int(nums[2]):
            # nums[2] is integer (likely rank) -> nums[1] is Δ
            idx = 2
        else:
            # nums[2] is decimal (Pwr value) -> nums[1] is RatRank, no Δ
            idx = 1

        # Now nums[idx] = RatRank, nums[idx+1] = Pwr, ...
        rat_rank = int(nums[idx])
        power = nums[idx + 1]
        pwr_rank = int(nums[idx + 2])
        # idx+3=Off, idx+4=OffRank, idx+5=Def, idx+6=DefRank, idx+7=HFA
        # idx+8=SoS, idx+9=SoSRank
        sos = nums[idx + 8] if len(nums) > idx + 8 else None
        sos_rank_val = int(nums[idx + 9]) if len(nums) > idx + 9 else None

        return {
            "rank": rat_rank,
            "rating": rating,
            "power": power,
            "power_rank": pwr_rank,
            "sos": sos,
            "sos_rank": sos_rank_val,
        }
    except (ValueError, IndexError) as e:
        logger.debug(f"  Parse error for {team_name}: {e}")
        return None


# ============================================================
# COLLEGE BASEBALL RATINGS SCRAPER
# ============================================================

def scrape_cbr_ratings(conn, season, teams_by_div):
    """
    Scrape CollegeBaseballRatings for all divisions.

    CBR page format: Table with columns
    Rank | Team | Conf | CBR | W | L | SOR | SOS | WAB | Rank |
    vs 1-25 | vs 26-50 | vs 51-100 | vs 101-200 | Prev | +/- | Rk26
    """
    logger.info("=" * 60)
    logger.info("SCRAPING COLLEGE BASEBALL RATINGS")
    logger.info("=" * 60)

    count = 0

    for div_level, url in CBR_URLS.items():
        if div_level not in teams_by_div:
            continue

        logger.info(f"\n  Fetching CBR {div_level}: {url}")

        html = fetch(url, delay=(2.0, 3.0))
        if not html:
            logger.error(f"  Failed to fetch CBR {div_level}")
            continue

        soup = BeautifulSoup(html, "html.parser")
        text = soup.get_text()

        # Parse the table — CBR uses HTML tables
        tables = soup.find_all("table")
        if not tables:
            logger.warning(f"  No tables found on CBR {div_level} page")
            # Fall back to text parsing
            pnw_teams = teams_by_div.get(div_level, [])
            for team in pnw_teams:
                result = _find_cbr_team_text(text, CBR_NAME_MAP.get(team["id"], ""))
                if result:
                    _insert_cbr_result(conn, team, season, result)
                    count += 1
            continue

        # Find the main ratings table (largest one)
        main_table = max(tables, key=lambda t: len(t.find_all("tr")))
        rows = main_table.find_all("tr")

        # Get total teams
        total_teams = max(0, len(rows) - 1)  # minus header

        # Parse all rows into a lookup
        team_data = {}
        for row in rows[1:]:  # skip header
            cells = row.find_all(["td", "th"])
            if len(cells) < 8:
                continue

            try:
                rank_text = cells[0].get_text(strip=True)
                team_name = cells[1].get_text(strip=True)
                # conf = cells[2].get_text(strip=True)
                cbr_val = cells[3].get_text(strip=True)
                # wins = cells[4].get_text(strip=True)
                # losses = cells[5].get_text(strip=True)
                sor = cells[6].get_text(strip=True)
                sos = cells[7].get_text(strip=True)
                wab = cells[8].get_text(strip=True) if len(cells) > 8 else None

                rank = int(rank_text)
                team_data[team_name.lower()] = {
                    "rank": rank,
                    "cbr": float(cbr_val),
                    "sor": float(sor),
                    "sos": float(sos),
                    "wab": float(wab) if wab else None,
                    "total_teams": total_teams,
                    "team_name": team_name,
                }
            except (ValueError, IndexError):
                continue

        # Derive SOS ranks from raw SOS values (higher SOS = better = lower rank)
        all_sos_values = [(name, d["sos"]) for name, d in team_data.items() if d.get("sos") is not None]
        all_sos_values.sort(key=lambda x: x[1], reverse=True)  # highest SOS first
        sos_rank_lookup = {name: rank + 1 for rank, (name, _) in enumerate(all_sos_values)}

        # Assign SOS ranks back into team_data
        for name, d in team_data.items():
            d["sos_rank"] = sos_rank_lookup.get(name)

        # Match our PNW teams
        pnw_teams = teams_by_div.get(div_level, [])
        for team in pnw_teams:
            team_id = team["id"]
            cbr_name = CBR_NAME_MAP.get(team_id)
            if not cbr_name:
                continue

            # Try exact match first, then fuzzy
            result = team_data.get(cbr_name.lower())
            if not result:
                # Fuzzy match
                for key, data in team_data.items():
                    if cbr_name.lower() in key or key in cbr_name.lower():
                        result = data
                        break

            if result:
                _insert_cbr_result(conn, team, season, result)
                count += 1
                logger.info(f"    ✓ {team['short_name']}: #{result['rank']} "
                           f"(CBR={result['cbr']:.2f}, SOS={result['sos']:.3f}, "
                           f"SOS Rank #{result.get('sos_rank', '?')})")
            else:
                logger.warning(f"    ✗ Could not find {cbr_name} in CBR {div_level}")

    logger.info(f"\n  CBR: imported {count} team ratings")
    return count


def _insert_cbr_result(conn, team, season, result):
    """Insert a CBR result into national_ratings."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO national_ratings
            (team_id, season, source, national_rank, total_teams, rating,
             sos, sos_rank, power_rating, sor, wab, source_team_name)
            VALUES (%s, %s, 'cbr', %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (team_id, season, source) DO UPDATE SET
                national_rank = EXCLUDED.national_rank,
                total_teams = EXCLUDED.total_teams,
                rating = EXCLUDED.rating,
                sos = EXCLUDED.sos,
                sos_rank = EXCLUDED.sos_rank,
                power_rating = EXCLUDED.power_rating,
                sor = EXCLUDED.sor,
                wab = EXCLUDED.wab,
                source_team_name = EXCLUDED.source_team_name
        """, (
            team["id"], season,
            result["rank"], result.get("total_teams", 0),
            result.get("cbr"),
            result.get("sos"),          # raw SOS value
            result.get("sos_rank"),     # derived SOS rank within division
            result.get("cbr"),
            result.get("sor"),
            result.get("wab"),
            CBR_NAME_MAP.get(team["id"], team["short_name"]),
        ))


def _find_cbr_team_text(page_text, team_name):
    """Fallback: find CBR team in plain text."""
    if not team_name:
        return None

    escaped = re.escape(team_name)
    # CBR text format: "rank Team Conf CBR W L SOR SOS WAB ..."
    pattern = rf'(\d+)\s*{escaped}\s+\S+\s+([\d.-]+)\s+\d+\s+\d+\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)'
    match = re.search(pattern, page_text)

    if match:
        return {
            "rank": int(match.group(1)),
            "cbr": float(match.group(2)),
            "sor": float(match.group(3)),
            "sos": float(match.group(4)),
            "wab": float(match.group(5)),
        }
    return None


# ============================================================
# COMPOSITE RANKING CALCULATOR
# ============================================================

def compute_composite_rankings(conn, season):
    """
    Compute composite rankings from all imported national_ratings.

    For each PNW team:
    1. Average their national ranks across sources → composite_rank
    2. Average their SOS values across sources → composite_sos
    3. Compute national percentile (within division)
    4. Compute cross-division score (percentile-based, 0-100)
    """
    logger.info("=" * 60)
    logger.info("COMPUTING COMPOSITE RANKINGS")
    logger.info("=" * 60)

    with get_connection() as conn:
        cur = conn.cursor()
        # Get all PNW teams with division info
        cur.execute("""
            SELECT t.id, t.short_name, d.level as division_level
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE t.is_active = 1
        """)
        teams = cur.fetchall()

        count = 0

        for team in teams:
            team_id = team["id"]
            div_level = team["division_level"]

            # Skip JUCO — they use PPI only
            if div_level == "JUCO":
                continue

            # Get all ratings for this team
            cur.execute("""
                SELECT source, national_rank, total_teams, rating, sos, sos_rank
                FROM national_ratings
                WHERE team_id = %s AND season = %s
            """, (team_id, season))
            ratings = cur.fetchall()

            if not ratings:
                continue

            # Collect values per source
            ranks = []
            sos_ranks = []
            pear_rank = massey_rank = cbr_rank = rpi_rank = None
            pear_sos = massey_sos = cbr_sos = None
            pear_sos_rank = massey_sos_rank = cbr_sos_rank = None
            total_teams_in_div = 0

            for r in ratings:
                source = r["source"]

                if r["national_rank"]:
                    ranks.append(r["national_rank"])
                if r["sos_rank"] is not None:
                    sos_ranks.append(r["sos_rank"])
                if r["total_teams"] and r["total_teams"] > total_teams_in_div:
                    total_teams_in_div = r["total_teams"]

                if source == "pear":
                    pear_rank = r["national_rank"]
                    pear_sos = r["sos"]
                    pear_sos_rank = r["sos_rank"]
                elif source == "massey":
                    massey_rank = r["national_rank"]
                    massey_sos = r["sos"]
                    massey_sos_rank = r["sos_rank"]
                elif source == "cbr":
                    cbr_rank = r["national_rank"]
                    cbr_sos = r["sos"]
                    cbr_sos_rank = r["sos_rank"]

            if not ranks:
                continue

            # Composite values
            composite_rank = sum(ranks) / len(ranks)
            # Use SOS RANKS (not raw values) for composite — sources use different scales
            composite_sos_rank_val = sum(sos_ranks) / len(sos_ranks) if sos_ranks else None
            # Keep raw SOS values from each source for display purposes only
            composite_sos = None  # No longer average raw values (different scales)

            # National percentile (higher = better)
            # If ranked 5th out of 300, percentile = (300 - 5) / 300 * 100 = 98.3%
            if total_teams_in_div > 0:
                national_percentile = (total_teams_in_div - composite_rank) / total_teams_in_div * 100
                national_percentile = max(0, min(100, national_percentile))
            else:
                national_percentile = None

            # Cross-division score: same as national_percentile for now
            # This allows comparing a top NAIA team vs a mid D1 team
            cross_division_score = national_percentile

            cur.execute("""
                INSERT INTO composite_rankings
                (team_id, season, composite_rank, composite_percentile, composite_sos,
                 composite_sos_rank, num_sources,
                 pear_rank, massey_rank, cbr_rank, rpi_rank,
                 pear_sos, massey_sos, cbr_sos,
                 national_percentile, cross_division_score)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (team_id, season) DO UPDATE SET
                    composite_rank = EXCLUDED.composite_rank,
                    composite_percentile = EXCLUDED.composite_percentile,
                    composite_sos = EXCLUDED.composite_sos,
                    composite_sos_rank = EXCLUDED.composite_sos_rank,
                    num_sources = EXCLUDED.num_sources,
                    pear_rank = EXCLUDED.pear_rank,
                    massey_rank = EXCLUDED.massey_rank,
                    cbr_rank = EXCLUDED.cbr_rank,
                    rpi_rank = EXCLUDED.rpi_rank,
                    pear_sos = EXCLUDED.pear_sos,
                    massey_sos = EXCLUDED.massey_sos,
                    cbr_sos = EXCLUDED.cbr_sos,
                    national_percentile = EXCLUDED.national_percentile,
                    cross_division_score = EXCLUDED.cross_division_score
            """, (
                team_id, season,
                round(composite_rank, 1),
                round(national_percentile, 1) if national_percentile else None,
                composite_sos,  # None — raw values aren't comparable across sources
                round(composite_sos_rank_val, 1) if composite_sos_rank_val else None,
                len(ranks),
                pear_rank, massey_rank, cbr_rank, rpi_rank,
                round(pear_sos, 4) if pear_sos else None,
                round(massey_sos, 4) if massey_sos else None,
                round(cbr_sos, 4) if cbr_sos else None,
                round(national_percentile, 1) if national_percentile else None,
                round(cross_division_score, 1) if cross_division_score else None,
            ))
            count += 1

            rank_strs = []
            if pear_rank: rank_strs.append(f"P#{pear_rank}")
            if cbr_rank: rank_strs.append(f"C#{cbr_rank}")

            sos_strs = []
            if pear_sos_rank: sos_strs.append(f"P-SOS#{pear_sos_rank}")
            if cbr_sos_rank: sos_strs.append(f"C-SOS#{cbr_sos_rank}")

            sos_display = f" | SOS Rank #{composite_sos_rank_val:.1f} ({', '.join(sos_strs)})" if composite_sos_rank_val else ""

            logger.info(f"  {team['short_name']:20s} → Composite #{composite_rank:5.1f} "
                        f"({', '.join(rank_strs)}){sos_display} "
                        f"| Percentile: {national_percentile:.1f}%")

    logger.info(f"\n  Computed composite rankings for {count} teams")
    return count


# ============================================================
# MAIN
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="Scrape national ratings for PNW teams")
    parser.add_argument("--season", type=int, default=2026, help="Season year")
    parser.add_argument("--source", choices=["pear", "cbr", "all"], default="all",
                       help="Which source to scrape (default: all)")
    parser.add_argument("--composite-only", action="store_true",
                       help="Only recompute composite rankings (skip scraping)")
    args = parser.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()
        # Get PNW teams grouped by division
        all_teams = get_pnw_teams(conn)
        teams_by_div = {}
        for t in all_teams:
            div = t["division_level"]
            if div not in teams_by_div:
                teams_by_div[div] = []
            teams_by_div[div].append(t)

        logger.info(f"PNW teams by division:")
        for div, teams in sorted(teams_by_div.items()):
            logger.info(f"  {div}: {len(teams)} teams")

        if not args.composite_only:
            # Scrape ratings
            if args.source in ("pear", "all"):
                try:
                    scrape_pear_ratings(conn, args.season, teams_by_div)
                except Exception as e:
                    logger.error(f"Pear scraping failed: {e}")

            if args.source in ("cbr", "all"):
                try:
                    scrape_cbr_ratings(conn, args.season, teams_by_div)
                except Exception as e:
                    logger.error(f"CBR scraping failed: {e}")

        # Always compute composites
        compute_composite_rankings(conn, args.season)

        # Print summary
        logger.info("\n" + "=" * 60)
        logger.info("FINAL SUMMARY")
        logger.info("=" * 60)

        cur.execute("""
            SELECT cr.*, t.short_name, d.level as division_level
            FROM composite_rankings cr
            JOIN teams t ON cr.team_id = t.id
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE cr.season = %s
            ORDER BY d.level, cr.composite_rank
        """, (args.season,))
        results = cur.fetchall()

        current_div = None
        for r in results:
            if r["division_level"] != current_div:
                current_div = r["division_level"]
                logger.info(f"\n  ── {current_div} ──")

            ranks = []
            if r["pear_rank"]: ranks.append(f"P#{r['pear_rank']}")
            if r["massey_rank"]: ranks.append(f"M#{r['massey_rank']}")
            if r["cbr_rank"]: ranks.append(f"C#{r['cbr_rank']}")

            logger.info(f"  {r['short_name']:20s} Composite #{r['composite_rank']:6.1f} "
                        f"| {' '.join(ranks):30s} "
                        f"| Percentile: {r['national_percentile'] or 0:.1f}%")

    logger.info("\nDone!")


if __name__ == "__main__":
    main()
