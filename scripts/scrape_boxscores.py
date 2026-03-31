#!/usr/bin/env python3
"""
PNW Baseball — Box Score Scraper (All Levels)
================================================

Scrapes game results and box scores from all PNW team schedule pages
and populates the games, game_batting, and game_pitching tables.

Supports three platform types:
  1. Sidearm Sports (D1, D2, D3 most, NAIA)  — schedule page + box score pages
  2. PrestoSports (NWAC, Willamette)          — schedule AJAX + box score pages
  3. WMT Games API (Seattle U)                — game-level API endpoint

Workflow per team:
  1. Fetch the team's schedule/results page
  2. Parse each completed game: date, opponent, score, link to box score
  3. For each game, fetch the box score page
  4. Parse batting and pitching lines from the box score
  5. Upsert into games / game_batting / game_pitching tables
  6. Compute game-score metrics (quality starts, Bill James game score)

Usage:
    cd pnw-baseball
    PYTHONPATH=backend python3 scripts/scrape_boxscores.py --season 2026
    PYTHONPATH=backend python3 scripts/scrape_boxscores.py --season 2026 --division D1
    PYTHONPATH=backend python3 scripts/scrape_boxscores.py --season 2026 --team uw
    PYTHONPATH=backend python3 scripts/scrape_boxscores.py --season 2026 --team clark --division JUCO
    PYTHONPATH=backend python3 scripts/scrape_boxscores.py --season 2026 --dry-run
"""

import sys
import os
import time
import random
import argparse
import logging
import re
import json
from datetime import datetime, date
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import requests
from bs4 import BeautifulSoup

from app.models.database import get_connection

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("scrape_boxscores")

# ============================================================
# Constants — All PNW Teams by Division
# ============================================================

# D1: Sidearm Sports (Pac-12/WCC)
D1_TEAMS = {
    "UW":         ("https://gohuskies.com",       "baseball", "sidearm"),
    "Oregon":     ("https://goducks.com",          "baseball", "sidearm"),
    "Oregon St.": ("https://osubeavers.com",       "baseball", "sidearm"),
    "Wash. St.":  ("https://wsucougars.com",       "baseball", "sidearm"),
    "Gonzaga":    ("https://gozags.com",           "baseball", "sidearm"),
    "Portland":   ("https://portlandpilots.com",   "baseball", "sidearm"),
    "Seattle U":  ("https://goseattleu.com",       "baseball", "sidearm"),
}

# D2 (GNAC): Sidearm Sports
D2_TEAMS = {
    "CWU":   ("https://wildcatsports.com",  "baseball", "sidearm"),
    "SMU":   ("https://smusaints.com",       "baseball", "sidearm"),
    "MSUB":  ("https://msubsports.com",      "baseball", "sidearm"),
    "WOU":   ("https://wouwolves.com",        "baseball", "sidearm"),
    "NNU":   ("https://nnusports.com",        "baseball", "sidearm"),
}

# D3 (NWC): Sidearm + one PrestoSports
D3_TEAMS = {
    "UPS":       ("https://loggerathletics.com",      "baseball", "sidearm"),
    "PLU":       ("https://golutes.com",              "baseball", "sidearm"),
    "Whitman":   ("https://athletics.whitman.edu",    "baseball", "sidearm"),
    "Whitworth": ("https://whitworthpirates.com",     "baseball", "sidearm"),
    "L&C":       ("https://golcathletics.com",        "baseball", "sidearm"),
    "Pacific":   ("https://goboxers.com",             "baseball", "sidearm"),
    "Linfield":  ("https://golinfieldwildcats.com",   "baseball", "sidearm"),
    "GFU":       ("https://athletics.georgefox.edu",   "baseball", "sidearm"),
    "Willamette": ("https://www.wubearcats.com",      "bsb",     "presto"),
}

# NAIA (CCC): Sidearm Sports
NAIA_TEAMS = {
    "LCSC":          ("https://lcwarriors.com",       "baseball", "sidearm"),
    "EOU":           ("https://eousports.com",        "baseball", "sidearm"),
    "OIT":           ("https://oregontechowls.com",   "baseball", "sidearm"),
    "C of I":        ("https://yoteathletics.com",    "baseball", "sidearm"),
    "Corban":        ("https://corbanwarriors.com",   "baseball", "sidearm"),
    "Bushnell":      ("https://bushnellbeacons.com",  "baseball", "sidearm"),
    "Warner Pacific": ("https://wpuknights.com",      "baseball", "sidearm"),
    "UBC":           ("https://gothunderbirds.ca",    "baseball", "sidearm"),
}

# JUCO (NWAC): PrestoSports
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
    "GRC": "greenriver",
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

NWAC_TEAMS = {
    name: ("https://nwacsports.com", "bsb", "presto")
    for name in NWAC_TEAM_SLUGS
}

# Division groups
DIVISION_MAP = {
    "D1":   D1_TEAMS,
    "D2":   D2_TEAMS,
    "D3":   D3_TEAMS,
    "NAIA": NAIA_TEAMS,
    "JUCO": NWAC_TEAMS,
}

# CLI aliases for --team
TEAM_ALIASES = {
    "uw": "UW", "washington": "UW", "huskies": "UW",
    "oregon": "Oregon", "ducks": "Oregon",
    "osu": "Oregon St.", "beavers": "Oregon St.",
    "wsu": "Wash. St.", "cougars": "Wash. St.",
    "gonzaga": "Gonzaga", "zags": "Gonzaga",
    "portland": "Portland", "pilots": "Portland",
    "seattleu": "Seattle U", "seattle": "Seattle U",
    "cwu": "CWU", "smu": "SMU", "msub": "MSUB", "wou": "WOU", "nnu": "NNU",
    "ups": "UPS", "plu": "PLU", "whitman": "Whitman", "whitworth": "Whitworth",
    "lc": "L&C", "pacific": "Pacific", "linfield": "Linfield",
    "gfu": "GFU", "willamette": "Willamette",
    "lcsc": "LCSC", "eou": "EOU", "oit": "OIT",
    "corban": "Corban", "bushnell": "Bushnell",
    "clark": "Clark", "edmonds": "Edmonds", "everett": "Everett",
    "shoreline": "Shoreline", "spokane": "Spokane", "tacoma": "Tacoma",
    "bellevue": "Bellevue", "centralia": "Centralia",
    "clackamas": "Clackamas", "pierce": "Pierce",
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


def fetch_page(url, retries=3, delay_range=(1.5, 3.0)):
    """Fetch a URL with rate limiting and retries."""
    global last_request_time

    for attempt in range(retries):
        try:
            elapsed = time.time() - last_request_time
            delay = random.uniform(*delay_range)
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

    return None


# ============================================================
# Game Score Metrics
# ============================================================

def compute_bill_james_game_score(ip, h, er, bb, k, hr=0, unearn_runs=0):
    """
    Bill James Game Score formula (original version):
      Start with 50
      + 1 point per out recorded (3 * IP)
      + 2 points per inning completed after the 4th
      + 1 point per strikeout
      - 2 points per hit allowed
      - 4 points per earned run
      - 2 points per unearned run
      - 1 point per walk
    """
    if ip is None or ip == 0:
        return None

    outs = int(ip) * 3 + round((ip % 1) * 10)
    innings_completed = int(ip)

    score = 50
    score += outs                                   # +1 per out
    score += max(0, innings_completed - 4) * 2      # +2 per inning after 4th
    score += (k or 0)                               # +1 per K
    score -= (h or 0) * 2                           # -2 per hit
    score -= (er or 0) * 4                          # -4 per ER
    score -= (unearn_runs or 0) * 2                 # -2 per unearned run
    score -= (bb or 0)                              # -1 per walk

    return score


def is_quality_start(ip, er):
    """Quality start: 6+ IP and 3 or fewer earned runs."""
    if ip is None:
        return False
    return ip >= 6.0 and (er or 0) <= 3


def compute_team_game_score(winner_score, loser_score, innings=9):
    """
    Custom team-level game quality score.
    Higher = more dominant win or tighter game.
    Range roughly 0-100.

    Formula:
      - Base = 50
      - Margin factor: bigger margin of victory = higher score (for winner)
      - Tightness bonus: 1-run games get bonus points for competitiveness
      - Extra innings bonus: +5 per extra inning
    """
    if winner_score is None or loser_score is None:
        return None

    margin = abs(winner_score - loser_score)
    total_runs = winner_score + loser_score

    # Winner dominance score (max ~35 pts)
    dominance = min(margin * 5, 35)

    # Competitiveness score (tight games are more interesting)
    if margin <= 1:
        compete = 15
    elif margin <= 2:
        compete = 10
    elif margin <= 3:
        compete = 5
    else:
        compete = 0

    # Extra innings bonus
    extra_inn_bonus = max(0, (innings or 9) - 9) * 5

    return 50 + dominance + compete + extra_inn_bonus


# ============================================================
# Date Parsing
# ============================================================

def parse_game_date(date_str, season_year):
    """
    Parse date strings from various formats found on athletics sites.
    Returns a date object or None.

    Common formats:
      - "03/15/2026"
      - "Mar 15, 2026"
      - "March 15"
      - "3/15"
      - "03/15/26"
    """
    if not date_str:
        return None

    date_str = date_str.strip()

    # Normalize abbreviated months with periods: "Mar." -> "Mar", "Feb." -> "Feb"
    date_str = re.sub(r'(\b[A-Z][a-z]{2})\.', r'\1', date_str)

    # Try full date formats
    for fmt in ("%m/%d/%Y", "%b %d, %Y", "%B %d, %Y", "%m/%d/%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(date_str, fmt).date()
        except ValueError:
            continue

    # Try month/day only — infer year from season
    for fmt in ("%m/%d", "%b %d", "%B %d"):
        try:
            dt = datetime.strptime(date_str, fmt)
            # College baseball runs Jan-June typically
            year = season_year
            return dt.replace(year=year).date()
        except ValueError:
            continue

    # PrestoSports format: "Fri, Feb 14" or "Sat, Mar 1"
    m = re.match(r'\w+,\s*(\w+)\s+(\d+)', date_str)
    if m:
        try:
            dt = datetime.strptime(f"{m.group(1)} {m.group(2)}", "%b %d")
            return dt.replace(year=season_year).date()
        except ValueError:
            pass

    logger.debug(f"  Could not parse date: '{date_str}'")
    return None


def parse_score(score_str):
    """Parse a score string like 'W, 8-3' or 'L, 4-10' into (team_score, opp_score, result)."""
    if not score_str:
        return None, None, None

    score_str = score_str.strip()

    # Pattern: "W 8-3", "L 4-10", "W, 8-3", "T, 5-5"
    m = re.match(r'([WLT])\s*,?\s*(\d+)\s*-\s*(\d+)', score_str, re.I)
    if m:
        result = m.group(1).upper()
        s1 = int(m.group(2))
        s2 = int(m.group(3))
        return s1, s2, result

    # Just a score: "8-3"
    m = re.match(r'(\d+)\s*-\s*(\d+)', score_str)
    if m:
        s1 = int(m.group(1))
        s2 = int(m.group(2))
        result = 'W' if s1 > s2 else ('L' if s1 < s2 else 'T')
        return s1, s2, result

    return None, None, None


def parse_innings_pitched(ip_str):
    """Parse innings pitched like '6.2' into 6.666... (6 and 2/3)."""
    if not ip_str:
        return None
    try:
        ip_str = str(ip_str).strip()
        if '.' in ip_str:
            parts = ip_str.split('.')
            whole = int(parts[0])
            frac = int(parts[1]) if len(parts) > 1 else 0
            return whole + frac / 3.0
        return float(ip_str)
    except (ValueError, TypeError):
        return None


# ============================================================
# Sidearm Schedule Parser
# ============================================================

def build_sidearm_schedule_url(base_url, sport, season_year):
    """Build schedule URL for a Sidearm Sports site."""
    return f"{base_url}/sports/{sport}/schedule/{season_year}"


def parse_sidearm_schedule(html, base_url, season_year):
    """
    Parse a Sidearm Sports schedule page.
    Tries the new c-events__item format first, then falls back to the legacy
    <li> + <button> format.
    Returns list of game dicts.
    """
    if not html:
        return []

    # Try new Sidearm Vue/Nuxt format first (c-events__item containers)
    games = _parse_sidearm_schedule_v2(html, base_url, season_year)
    if games:
        logger.info(f"  Parsed {len(games)} completed games from Sidearm schedule (v2)")
        return games

    # Try s-game-card format (Oregon, OSU, WSU, etc.)
    games = _parse_sidearm_schedule_v3(html, base_url, season_year)
    if games:
        logger.info(f"  Parsed {len(games)} completed games from Sidearm schedule (v3/game-card)")
        return games

    # Fall back to legacy format
    soup = BeautifulSoup(html, "html.parser")
    games = []
    all_items = soup.find_all("li")

    for li in all_items:
        game = _parse_sidearm_list_item(li, base_url, season_year)
        if game and game.get("team_score") is not None:
            if games and games[-1].get("date") == game.get("date") and games[-1].get("opponent") == game.get("opponent"):
                game["game_number"] = games[-1].get("game_number", 1) + 1
            games.append(game)

    logger.info(f"  Parsed {len(games)} completed games from Sidearm schedule (legacy)")
    return games


def _parse_sidearm_schedule_v2(html, base_url, season_year):
    """
    Parse the modern Sidearm Nuxt/Vue schedule format (2025+).

    Each game is a <div class="c-events__item"> containing:
      - <time class="c-events__date" datetime="Mar. 20, 2026">
      - <div class="c-events__team--opponent"> with opponent name
      - <div class="c-events__team-score"> (two: team score, then opponent score)
      - <a href="/boxscore.aspx?id=..."> with aria-label containing game info
      - <span class="sr-only"> with text like "Completed Event: ... Loss , 0, to, 5"
    """
    soup = BeautifulSoup(html, "html.parser")
    games = []

    # Find all event items — the top-level game container has class
    # "c-events__item ... c-events__item--result" for completed games
    event_items = soup.find_all("div", class_=re.compile(r"c-events__item--result"))
    logger.info(f"  v2 parser: found {len(event_items)} result items in {len(html)} bytes")
    if not event_items:
        # Try broader match
        all_events = soup.find_all("div", class_=re.compile(r"c-events__item\s"))
        logger.info(f"  v2 parser: broader match found {len(all_events)} event items")
        if not all_events:
            return []
        event_items = all_events

    for item in event_items:
        game = {
            "is_conference": False,
            "innings": 9,
            "game_number": 1,
        }

        # ─── Check if this is a completed game (has a boxscore link) ───
        box_link = item.find("a", href=re.compile(r"boxscore", re.I))
        if not box_link:
            continue  # Future game or no box score

        href = box_link.get("href", "")
        if not href.startswith("http"):
            href = base_url.rstrip("/") + "/" + href.lstrip("/")
        game["box_score_url"] = href
        aria = box_link.get("aria-label", "")

        # ─── Extract date ───
        time_el = item.find("time", class_=re.compile(r"c-events__date"))
        if time_el and time_el.get("datetime"):
            game["date"] = parse_game_date(time_el["datetime"], season_year)
        elif aria:
            date_m = re.search(r'on\s+(\w+\s+\d+,?\s*\d{4})', aria)
            if date_m:
                game["date"] = parse_game_date(date_m.group(1), season_year)

        if not game.get("date"):
            continue

        # ─── Extract opponent ───
        opp_el = item.find("div", class_=re.compile(r"c-events__team--opponent"))
        if opp_el:
            opp_text = opp_el.get_text(strip=True)
            game["opponent"] = re.sub(r'^#\d+\s+', '', opp_text).strip()
        elif aria:
            opp_m = re.search(r'Boxscore for Baseball (?:vs\.?|at)\s+(.+?)\s+on\s+', aria)
            if opp_m:
                game["opponent"] = re.sub(r'^#\d+\s+', '', opp_m.group(1)).strip()

        if not game.get("opponent"):
            continue

        # ─── Extract scores ───
        score_divs = item.find_all("div", class_=re.compile(r"c-events__team-score"))
        if len(score_divs) >= 2:
            try:
                game["team_score"] = int(score_divs[0].get_text(strip=True))
                game["opp_score"] = int(score_divs[1].get_text(strip=True))
                if game["team_score"] > game["opp_score"]:
                    game["result"] = "W"
                elif game["team_score"] < game["opp_score"]:
                    game["result"] = "L"
                else:
                    game["result"] = "T"
            except ValueError:
                continue
        else:
            # Try parsing from sr-only text: "Completed Event: ... Loss , 0, to, 5"
            sr = item.find("span", class_="sr-only", string=re.compile(r"Completed Event", re.I))
            if sr:
                score_m = re.search(r'(Win|Loss|Tie)\s*,\s*(\d+)\s*,?\s*to\s*,?\s*(\d+)', sr.get_text(), re.I)
                if score_m:
                    game["team_score"] = int(score_m.group(2))
                    game["opp_score"] = int(score_m.group(3))
                    game["result"] = {"win": "W", "loss": "L", "tie": "T"}.get(score_m.group(1).lower(), "T")

        if game.get("team_score") is None:
            continue

        # ─── Extra innings ───
        postscore = item.find(class_=re.compile(r"postscore"))
        if postscore:
            inn_m = re.search(r'\((\d+)\)', postscore.get_text())
            if inn_m:
                game["innings"] = int(inn_m.group(1))

        # ─── Conference indicator ───
        if "*" in item.get_text():
            game["is_conference"] = True

        # ─── Detect doubleheaders ───
        if games and games[-1].get("date") == game.get("date") and games[-1].get("opponent") == game.get("opponent"):
            game["game_number"] = games[-1].get("game_number", 1) + 1

        games.append(game)

    return games


def _parse_sidearm_schedule_v3(html, base_url, season_year):
    """
    Parse the Sidearm 's-game-card' schedule format (Oregon, OSU, WSU, etc.).

    Each completed game is a <div class="s-game-card ..."> containing:
      - A score/time div with class 's-game-card__header__game-score-time'
        Text like "W, 6-2Feb 13(Fri) 3:05 p.m."
      - Links including one to the boxscore:
        <a href="/sports/baseball/stats/2026/opponent-slug/boxscore/ID">
        or <a href="/boxscore.aspx?id=ID">
        with optional aria-label like "Box Score of Team vs Opponent on Month Day"
      - Opponent name in <a> tag linking to opponent site, or in aria-label
    """
    soup = BeautifulSoup(html, "html.parser")
    games = []
    seen_urls = set()  # Deduplicate — page often has duplicate card layouts

    # Find all s-game-card containers
    all_cards = soup.find_all("div", class_=re.compile(r"\bs-game-card\b"))
    logger.info(f"  v3 parser: found {len(all_cards)} s-game-card elements in {len(html)} bytes")
    if not all_cards:
        return []

    for card in all_cards:
        game = {
            "is_conference": False,
            "innings": 9,
            "game_number": 1,
        }

        # ─── Find boxscore link ───
        box_link = card.find("a", href=re.compile(r"boxscore", re.I))
        if not box_link:
            continue  # Not a completed game or no box score

        href = box_link.get("href", "")
        if not href.startswith("http"):
            href = base_url.rstrip("/") + "/" + href.lstrip("/")
        if href in seen_urls:
            continue  # Skip duplicate card layout
        seen_urls.add(href)
        game["box_score_url"] = href
        aria = box_link.get("aria-label", "") or ""

        # ─── Extract result and scores from score-time text ───
        score_time_el = card.find(class_=re.compile(r"game-score-time"))
        if score_time_el:
            st_text = score_time_el.get_text(strip=True)
            # Pattern: "W, 6-2Feb 13(Fri) 3:05 p.m." or "L, 1-8Feb 14(Sat) 10 a.m."
            score_m = re.match(r'([WLT]),\s*(\d+)-(\d+)', st_text)
            if score_m:
                game["result"] = score_m.group(1)
                game["team_score"] = int(score_m.group(2))
                game["opp_score"] = int(score_m.group(3))

                # Extract date from remaining text after score
                rest = st_text[score_m.end():]
                # e.g. "Feb 13(Fri) 3:05 p.m." or "Mar. 20(Thu) 2 p.m."
                date_m = re.match(r'([A-Z][a-z]{2}\.?\s+\d{1,2})', rest)
                if date_m:
                    date_str = f"{date_m.group(1)}, {season_year}"
                    game["date"] = parse_game_date(date_str, season_year)

        # ─── Fallback date from aria-label ───
        if not game.get("date") and aria:
            # "Box Score of University of Oregon vs George Mason on February 13"
            date_m = re.search(r'on\s+(\w+\s+\d{1,2})', aria)
            if date_m:
                date_str = f"{date_m.group(1)}, {season_year}"
                game["date"] = parse_game_date(date_str, season_year)

        if not game.get("date") or game.get("team_score") is None:
            continue

        # ─── Extract opponent ───
        if aria:
            # "Box Score of University of Oregon vs George Mason on February 13"
            opp_m = re.search(r'(?:vs\.?|at)\s+(.+?)\s+on\s+', aria)
            if opp_m:
                game["opponent"] = re.sub(r'^#\d+\s+', '', opp_m.group(1)).strip()

        if not game.get("opponent"):
            # Try the team-event-info area — opponent name is usually in a link
            team_el = card.find(class_=re.compile(r"s-game-card__header__team-event-info"))
            if team_el:
                # First text link is usually the opponent
                opp_link = team_el.find("a")
                if opp_link:
                    game["opponent"] = re.sub(r'\s*\(GM\d+\)', '', opp_link.get_text(strip=True)).strip()

        if not game.get("opponent"):
            # Last resort: check team header area
            team_header = card.find(class_=re.compile(r"s-game-card__header__team\b"))
            if team_header:
                opp_link = team_header.find("a")
                if opp_link:
                    game["opponent"] = re.sub(r'\s*\(GM\d+\)', '', opp_link.get_text(strip=True)).strip()

        if not game.get("opponent"):
            continue

        # ─── Conference indicator ───
        if "*" in card.get_text():
            game["is_conference"] = True

        # ─── Extra innings ───
        st_text = score_time_el.get_text(strip=True) if score_time_el else ""
        inn_m = re.search(r'\((\d+)\s*inn', st_text, re.I)
        if inn_m:
            game["innings"] = int(inn_m.group(1))

        # ─── Detect doubleheaders ───
        if games and games[-1].get("date") == game.get("date") and games[-1].get("opponent") == game.get("opponent"):
            game["game_number"] = games[-1].get("game_number", 1) + 1

        games.append(game)

    return games


def _parse_sidearm_list_item(li, base_url, season_year):
    """
    Parse a single Sidearm schedule <li>.

    Each game <li> has a button whose text contains:
      "Hide/Show Additional Information For {Opponent} - {Month} {Day}, {Year}"
    Plus a short text node with the score (e.g. "0-5") and links to box scores.
    """
    game = {
        "is_conference": False,
        "innings": 9,
        "game_number": 1,
    }

    # ─── Extract opponent and date from the button label ───
    btn = li.find("button")
    if not btn:
        return game  # Not a game item

    btn_text = btn.get_text(strip=True)
    m = re.search(
        r'(?:Hide/Show.*?For|Information For)\s+(.+?)\s*-\s*(\w+ \d+,?\s*\d{4})',
        btn_text, re.I
    )
    if not m:
        return game  # Not a game button

    raw_opponent = m.group(1).strip()
    game["date"] = parse_game_date(m.group(2).strip(), season_year)

    # Check for shortened games: "(7 Inn.)" in opponent text
    inn_m = re.search(r'\((\d+)\s*Inn', raw_opponent, re.I)
    if inn_m:
        game["innings"] = int(inn_m.group(1))
        raw_opponent = re.sub(r'\s*\(\d+\s*Inn\.?\)', '', raw_opponent).strip()

    game["opponent"] = raw_opponent

    # ─── Extract score from short text nodes ───
    for el in li.find_all(True, recursive=True):
        text = el.get_text(strip=True)
        # Score pattern: standalone "0-5", "8-3", "W 8-3", etc. (short text)
        if 1 < len(text) < 15 and re.match(r'^[WLT]?\s*,?\s*\d+-\d+$', text, re.I):
            ts, os_val, result = parse_score(text)
            if ts is not None:
                game["team_score"] = ts
                game["opp_score"] = os_val
                game["result"] = result
                break

    # ─── Extract box score URL ───
    for link in li.find_all("a", href=True):
        href = link["href"]
        link_text = link.get_text(strip=True).lower()
        if "boxscore" in href.lower() or "box score" in link_text:
            if not href.startswith("http"):
                href = base_url.rstrip("/") + "/" + href.lstrip("/")
            game["box_score_url"] = href
            break

    # ─── Conference indicator ───
    if "*" in li.get_text():
        game["is_conference"] = True

    return game


# ============================================================
# PrestoSports Schedule Parser (NWAC + Willamette)
# ============================================================

def build_presto_schedule_url(base_url, sport, team_slug, presto_season):
    """Build PrestoSports schedule URL."""
    return f"{base_url}/sports/{sport}/{presto_season}/teams/{team_slug}?view=schedule"


def parse_presto_schedule(html, base_url, season_year):
    """
    Parse a PrestoSports team game-log page.

    PrestoSports "schedule" view is actually a game log with multiple stat tables:
      - Hitting table:  Date | Opponent | Score | ab | r | h | 2b | 3b | hr | rbi | bb | k | sb | cs
      - Pitching table: Date | Opponent | Score | w | l | sv | ip | h | r | er | era | whip | bb | k | hr

    We parse the Hitting table for game results + team batting, and the
    Pitching table for team pitching totals.  Games with no score ("-") are
    future/unplayed and are skipped.

    Returns list of game dicts with team-level stats embedded.
    """
    if not html:
        return []

    soup = BeautifulSoup(html, "html.parser")

    # ─── Locate the game-log stat tables ───
    # PrestoSports renders several tables.  We identify the hitting and
    # pitching game-log tables by inspecting headers.
    tables = soup.find_all("table")

    hitting_table = None
    pitching_table = None

    for table in tables:
        header_row = table.find("tr")
        if not header_row:
            continue
        header_text = header_row.get_text(strip=True).lower()
        # Hitting game log: has "date", "opponent", "score", and "ab"
        if "date" in header_text and "opponent" in header_text and "ab" in header_text:
            hitting_table = table
        # Pitching game log: has "date", "opponent", "score", and "ip"
        elif "date" in header_text and "opponent" in header_text and "ip" in header_text:
            pitching_table = table

    if not hitting_table:
        logger.warning("  Could not find hitting game-log table on PrestoSports page")
        return []

    # ─── Parse hitting game-log ───
    games = []
    rows = hitting_table.find_all("tr")

    # Get headers from first row
    header_cells = rows[0].find_all(["th", "td"])
    headers = [c.get_text(strip=True).lower() for c in header_cells]

    current_date = None

    for row in rows[1:]:
        cells = row.find_all(["td", "th"])
        if len(cells) < 4:
            continue

        # Build a dict keyed by header name
        vals = {}
        for i, cell in enumerate(cells):
            if i < len(headers):
                vals[headers[i]] = cell.get_text(strip=True)

        # Get score — skip rows with no result ("-" or empty)
        score_str = vals.get("score", "").strip()
        if not score_str or score_str == "-":
            # Still track date for future doubleheader pairing
            date_str = vals.get("date", "").strip()
            if date_str:
                d = parse_game_date(date_str, season_year)
                if d:
                    current_date = d
            continue

        ts, os_val, result = parse_score(score_str)
        if ts is None:
            continue

        # Date
        date_str = vals.get("date", "").strip()
        game_date = None
        if date_str:
            game_date = parse_game_date(date_str, season_year)
            if game_date:
                current_date = game_date
        if not game_date:
            game_date = current_date

        opponent = " ".join(vals.get("opponent", "").split())  # collapse whitespace
        if not opponent:
            continue

        # Skip summary rows (Overall, Conference, Home, Away, etc.)
        if opponent.lower() in ("overall", "conference", "home", "away", "neutral",
                                 "wins", "losses", "total", "february", "march",
                                 "april", "may", "june", "january", "exhibition"):
            continue

        game = {
            "date": game_date,
            "opponent": opponent,
            "team_score": ts,
            "opp_score": os_val,
            "result": result,
            "box_score_url": None,
            "is_conference": False,
            "innings": 9,
            "game_number": 1,
            # Team batting totals from game log
            "team_batting": {
                "ab": _safe_int(vals.get("ab")),
                "r": _safe_int(vals.get("r")),
                "h": _safe_int(vals.get("h")),
                "doubles": _safe_int(vals.get("2b")),
                "triples": _safe_int(vals.get("3b")),
                "hr": _safe_int(vals.get("hr")),
                "rbi": _safe_int(vals.get("rbi")),
                "bb": _safe_int(vals.get("bb")),
                "k": _safe_int(vals.get("k")),
                "sb": _safe_int(vals.get("sb")),
                "cs": _safe_int(vals.get("cs")),
                "hbp": _safe_int(vals.get("hbp")),
                "sf": _safe_int(vals.get("sf")),
                "sh": _safe_int(vals.get("sh")),
            },
        }

        # Detect extra innings from score or opponent text
        innings_m = re.search(r'\((\d+)\)', score_str + " " + opponent)
        if innings_m:
            game["innings"] = int(innings_m.group(1))

        # Check for doubleheader — if same date as previous game
        if games and games[-1].get("date") == game_date and games[-1].get("opponent") == opponent:
            game["game_number"] = games[-1].get("game_number", 1) + 1

        games.append(game)

    # ─── Merge pitching stats from pitching game-log ───
    if pitching_table and games:
        p_rows = pitching_table.find_all("tr")
        p_header_cells = p_rows[0].find_all(["th", "td"])
        p_headers = [c.get_text(strip=True).lower() for c in p_header_cells]

        game_idx = 0
        for row in p_rows[1:]:
            cells = row.find_all(["td", "th"])
            if len(cells) < 4:
                continue
            vals = {}
            for i, cell in enumerate(cells):
                if i < len(p_headers):
                    vals[p_headers[i]] = cell.get_text(strip=True)

            score_str = vals.get("score", "").strip()
            if not score_str or score_str == "-":
                continue

            opponent = " ".join(vals.get("opponent", "").split())
            if opponent.lower() in ("overall", "conference", "home", "away", "neutral",
                                     "wins", "losses", "total", "february", "march",
                                     "april", "may", "june", "january", "exhibition"):
                continue

            # Match to the corresponding game by index
            if game_idx < len(games):
                games[game_idx]["team_pitching"] = {
                    "ip": vals.get("ip", "0"),
                    "h": _safe_int(vals.get("h")),
                    "r": _safe_int(vals.get("r")),
                    "er": _safe_int(vals.get("er")),
                    "bb": _safe_int(vals.get("bb")),
                    "k": _safe_int(vals.get("k")),
                    "hr": _safe_int(vals.get("hr")),
                    "era": vals.get("era", ""),
                    "whip": vals.get("whip", ""),
                }
                game_idx += 1

    logger.info(f"  Parsed {len(games)} completed games from PrestoSports game log")
    return games


def _safe_int(val, default=0):
    """Convert a string to int, returning default on failure."""
    if val is None:
        return default
    try:
        return int(str(val).strip())
    except (ValueError, TypeError):
        return default


# ============================================================
# Box Score Page Parsers
# ============================================================

def parse_sidearm_boxscore(html, base_url=""):
    """
    Parse a Sidearm box score page.

    Returns:
      {
        "home_team": str,
        "away_team": str,
        "home_score": int,
        "away_score": int,
        "innings": int,
        "line_score": {"home": [...], "away": [...]},
        "batting": {"home": [...], "away": [...]},
        "pitching": {"home": [...], "away": [...]},
      }
    """
    if not html:
        return None

    soup = BeautifulSoup(html, "html.parser")
    result = {
        "batting": {"home": [], "away": []},
        "pitching": {"home": [], "away": []},
    }

    # ─── Find team names from the box score header ───
    team_names = []
    # Look for team name elements
    for el in soup.find_all(class_=re.compile(r"team-name|linescore.*team", re.I)):
        name = el.get_text(strip=True)
        if name and len(name) > 1:
            team_names.append(name)

    # Fallback: first two <h3> or <h4> in the page
    if len(team_names) < 2:
        for tag in soup.find_all(["h3", "h4"]):
            name = tag.get_text(strip=True)
            if name and len(name) > 1 and name not in team_names:
                team_names.append(name)
            if len(team_names) >= 2:
                break

    result["away_team"] = team_names[0] if len(team_names) > 0 else "Away"
    result["home_team"] = team_names[1] if len(team_names) > 1 else "Home"

    # ─── Parse line score table ───
    linescore_table = None
    for table in soup.find_all("table"):
        text = table.get_text()
        if re.search(r'\b[RHE]\b', text) and re.search(r'\d+\s+\d+\s+\d+', text):
            linescore_table = table
            break

    if linescore_table:
        rows = linescore_table.find_all("tr")
        line_scores = []
        for row in rows:
            cells = row.find_all(["td", "th"])
            if len(cells) < 4:
                continue
            # Extract inning-by-inning scores (skip team name and R/H/E totals)
            nums = []
            for cell in cells[1:]:  # Skip team name cell
                t = cell.get_text(strip=True)
                if t.isdigit():
                    nums.append(int(t))
                elif t == "X" or t == "x":
                    nums.append(None)  # Bottom of inning not played

            if len(nums) >= 4:  # At least some innings + R, H, E
                line_scores.append(nums)

        if len(line_scores) >= 2:
            # Last 3 values are R, H, E
            away_line = line_scores[0]
            home_line = line_scores[1]

            result["away_score"] = away_line[-3] if len(away_line) >= 3 else None
            result["home_score"] = home_line[-3] if len(home_line) >= 3 else None
            result["away_hits"] = away_line[-2] if len(away_line) >= 3 else None
            result["home_hits"] = home_line[-2] if len(home_line) >= 3 else None
            result["away_errors"] = away_line[-1] if len(away_line) >= 3 else None
            result["home_errors"] = home_line[-1] if len(home_line) >= 3 else None

            # Inning-by-inning (exclude R, H, E)
            result["line_score"] = {
                "away": [x for x in away_line[:-3] if x is not None],
                "home": [x for x in home_line[:-3] if x is not None],
            }
            result["innings"] = max(
                len(result["line_score"]["away"]),
                len(result["line_score"]["home"]),
                9
            )

    # ─── Parse batting tables ───
    batting_tables = _find_stat_tables(soup, "batting")
    for i, table in enumerate(batting_tables[:2]):
        side = "away" if i == 0 else "home"
        result["batting"][side] = _parse_batting_table(table)

    # ─── Parse pitching tables ───
    pitching_tables = _find_stat_tables(soup, "pitching")
    for i, table in enumerate(pitching_tables[:2]):
        side = "away" if i == 0 else "home"
        result["pitching"][side] = _parse_pitching_table(table)

    return result


def parse_presto_boxscore(html, base_url=""):
    """
    Parse a PrestoSports box score page.
    Very similar structure to Sidearm — table-based layout.
    """
    # PrestoSports box scores use the same general table structure
    # We can reuse the Sidearm parser with slight modifications
    return parse_sidearm_boxscore(html, base_url)


def _find_stat_tables(soup, stat_type):
    """
    Find batting or pitching stat tables in a box score page.
    Returns list of table elements.
    """
    tables = []

    # Method 1: Look for section headers
    for header in soup.find_all(["h2", "h3", "h4", "caption"]):
        text = header.get_text(strip=True).lower()
        if stat_type in text:
            # Find the next table after this header
            next_table = header.find_next("table")
            if next_table and next_table not in tables:
                tables.append(next_table)

    if tables:
        return tables

    # Method 2: Look for tables with characteristic column headers
    # Use individual cell text instead of concatenated header text to avoid
    # false substring matches (e.g. "player"+"ab" forming "era" in "playerab")
    for table in soup.find_all("table"):
        thead = table.find("thead") or table.find("tr")
        if not thead:
            continue
        # Get individual header cell texts for accurate matching
        cells = [c.get_text(strip=True).lower() for c in thead.find_all(["th", "td"])]

        if stat_type == "batting":
            if any(kw in cells for kw in ["ab", "at bats", "at bat"]):
                if "ip" not in cells and "era" not in cells:
                    tables.append(table)
        elif stat_type == "pitching":
            if any(kw in cells for kw in ["ip", "innings", "era"]):
                tables.append(table)

    return tables


def _parse_batting_table(table):
    """Parse a batting box score table into list of player stat dicts."""
    if not table:
        return []

    players = []
    rows = table.find_all("tr")

    # Get headers
    headers = []
    header_row = rows[0] if rows else None
    if header_row:
        for cell in header_row.find_all(["th", "td"]):
            headers.append(cell.get_text(strip=True).lower())

    # Map common header variations
    HEADER_MAP = {
        "player": "player", "name": "player", "hitters": "player", "batters": "player",
        "ab": "ab", "at bats": "ab",
        "r": "r", "runs": "r",
        "h": "h", "hits": "h",
        "2b": "2b", "doubles": "2b",
        "3b": "3b", "triples": "3b",
        "hr": "hr", "home runs": "hr",
        "rbi": "rbi",
        "bb": "bb", "walks": "bb",
        "so": "so", "k": "so", "strikeouts": "so",
        "hbp": "hbp", "hit by pitch": "hbp",
        "sf": "sf", "sac fly": "sf",
        "sh": "sh", "sac bunt": "sh", "sac": "sh",
        "sb": "sb", "stolen bases": "sb",
        "cs": "cs", "caught stealing": "cs",
        "lob": "lob", "left on base": "lob",
        "po": "po", "pos": "pos", "position": "pos",
    }

    mapped_headers = []
    for h in headers:
        h_clean = h.strip().lower()
        mapped_headers.append(HEADER_MAP.get(h_clean, h_clean))

    # Parse data rows
    for row in rows[1:]:
        cells = row.find_all(["td", "th"])
        if len(cells) < 3:
            continue

        # Skip total/summary rows
        text = row.get_text(strip=True).lower()
        if "total" in text or "team" in text:
            continue

        player = {}
        for i, cell in enumerate(cells):
            if i < len(mapped_headers):
                key = mapped_headers[i]
                val = cell.get_text(strip=True)

                if key == "player":
                    # Clean up player name (remove jersey number, position)
                    name = re.sub(r'^\d+\s*', '', val)  # Remove leading jersey #
                    name = re.sub(r'\s*(ph|pr|cr|dh|eh)\s*$', '', name, flags=re.I)  # Remove role suffixes
                    player["player_name"] = name.strip()

                    # Extract position if embedded
                    pos_m = re.search(r'\b(P|C|1B|2B|3B|SS|LF|CF|RF|DH|PH|PR)\b', val, re.I)
                    if pos_m:
                        player["position"] = pos_m.group(1).upper()
                elif key == "pos":
                    player["position"] = val.upper() if val else None
                else:
                    try:
                        player[key] = int(val) if val and val.lstrip('-').isdigit() else 0
                    except (ValueError, TypeError):
                        player[key] = 0

        if player.get("player_name"):
            players.append(player)

    return players


def _parse_pitching_table(table):
    """Parse a pitching box score table into list of pitcher stat dicts."""
    if not table:
        return []

    pitchers = []
    rows = table.find_all("tr")

    # Get headers
    headers = []
    header_row = rows[0] if rows else None
    if header_row:
        for cell in header_row.find_all(["th", "td"]):
            headers.append(cell.get_text(strip=True).lower())

    HEADER_MAP = {
        "player": "player", "name": "player", "pitchers": "player", "pitcher": "player",
        "ip": "ip", "innings pitched": "ip", "innings": "ip",
        "h": "h", "hits": "h",
        "r": "r", "runs": "r",
        "er": "er", "earned runs": "er",
        "bb": "bb", "walks": "bb",
        "so": "so", "k": "so", "strikeouts": "so",
        "hr": "hr", "home runs": "hr",
        "hbp": "hbp", "hit batters": "hbp",
        "wp": "wp", "wild pitches": "wp",
        "bf": "bf", "batters faced": "bf", "np": "np",
        "pitches": "pitches", "p-s": "pitches",
        "dec": "decision", "decision": "decision",
    }

    mapped_headers = []
    for h in headers:
        h_clean = h.strip().lower()
        mapped_headers.append(HEADER_MAP.get(h_clean, h_clean))

    # Parse data rows
    order = 0
    for row in rows[1:]:
        cells = row.find_all(["td", "th"])
        if len(cells) < 3:
            continue

        text = row.get_text(strip=True).lower()
        if "total" in text or "team" in text:
            continue

        pitcher = {}
        order += 1
        pitcher["pitch_order"] = order
        pitcher["is_starter"] = (order == 1)

        for i, cell in enumerate(cells):
            if i < len(mapped_headers):
                key = mapped_headers[i]
                val = cell.get_text(strip=True)

                if key == "player":
                    # Clean up name, detect decision
                    name = val
                    dec_m = re.search(r'\(([WLS])\s*,?\s*[\d-]*\)', name)
                    if dec_m:
                        pitcher["decision"] = dec_m.group(1).upper()
                        name = name[:dec_m.start()].strip()

                    # Also check for W/L/S suffix
                    for suffix in [" (W)", " (L)", " (S)", " (H)"]:
                        if name.upper().endswith(suffix):
                            pitcher["decision"] = suffix.strip(" ()")[0]
                            name = name[:-len(suffix)].strip()

                    name = re.sub(r'^\d+\s*', '', name)  # Remove jersey #
                    pitcher["player_name"] = name.strip()
                elif key == "ip":
                    pitcher["ip"] = parse_innings_pitched(val)
                elif key == "decision":
                    if val and val[0].upper() in "WLSH":
                        pitcher["decision"] = val[0].upper()
                else:
                    try:
                        pitcher[key] = int(val) if val and val.lstrip('-').isdigit() else 0
                    except (ValueError, TypeError):
                        pitcher[key] = 0

        if pitcher.get("player_name"):
            pitchers.append(pitcher)

    return pitchers


# ============================================================
# Database Operations
# ============================================================

def get_team_id_by_name(cur, short_name):
    """Look up team_id from short_name."""
    cur.execute("SELECT id FROM teams WHERE short_name = %s", (short_name,))
    row = cur.fetchone()
    return row["id"] if row else None


def get_team_id_by_school(cur, name_fragment):
    """Fuzzy lookup team by school_name or short_name."""
    cur.execute("""
        SELECT id, short_name FROM teams
        WHERE LOWER(short_name) = LOWER(%s)
           OR LOWER(school_name) LIKE LOWER(%s)
           OR LOWER(name) LIKE LOWER(%s)
        LIMIT 1
    """, (name_fragment, f"%{name_fragment}%", f"%{name_fragment}%"))
    row = cur.fetchone()
    return row["id"] if row else None


def find_player_id(cur, team_id, player_name, season):
    """Try to match a player by name on a given team."""
    if not player_name:
        return None

    # Normalize name
    name = player_name.strip()

    # Try "First Last" format
    parts = name.split(None, 1)
    if len(parts) == 2:
        first, last = parts
        cur.execute("""
            SELECT p.id FROM players p
            WHERE p.team_id = %s
              AND LOWER(p.first_name) = LOWER(%s) AND LOWER(p.last_name) = LOWER(%s)
            LIMIT 1
        """, (team_id, first, last))
        row = cur.fetchone()
        if row:
            return row["id"]

    # Try "Last, First" format
    if "," in name:
        parts = name.split(",", 1)
        last = parts[0].strip()
        first = parts[1].strip()
        cur.execute("""
            SELECT p.id FROM players p
            WHERE p.team_id = %s
              AND LOWER(p.first_name) = LOWER(%s) AND LOWER(p.last_name) = LOWER(%s)
            LIMIT 1
        """, (team_id, first, last))
        row = cur.fetchone()
        if row:
            return row["id"]

    # Fallback: partial match
    cur.execute("""
        SELECT p.id FROM players p
        WHERE p.team_id = %s
          AND LOWER(p.last_name) || ', ' || LOWER(p.first_name) LIKE LOWER(%s)
        LIMIT 1
    """, (team_id, f"%{name}%"))
    row = cur.fetchone()
    return row["id"] if row else None


def upsert_game(cur, game_data):
    """
    Insert or update a game record.
    Returns game_id.
    """
    source_url = game_data.get("source_url") or game_data.get("box_score_url") or ""

    # Check if game already exists
    if source_url:
        cur.execute("SELECT id FROM games WHERE source_url = %s", (source_url,))
        existing = cur.fetchone()
        if existing:
            game_id = existing["id"]
            # Update score if it changed
            cur.execute("""
                UPDATE games SET
                    home_score = COALESCE(%s, home_score),
                    away_score = COALESCE(%s, away_score),
                    home_hits = COALESCE(%s, home_hits),
                    away_hits = COALESCE(%s, away_hits),
                    home_errors = COALESCE(%s, home_errors),
                    away_errors = COALESCE(%s, away_errors),
                    home_line_score = COALESCE(%s, home_line_score),
                    away_line_score = COALESCE(%s, away_line_score),
                    innings = COALESCE(%s, innings),
                    game_score = COALESCE(%s, game_score),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = %s
            """, (
                game_data.get("home_score"), game_data.get("away_score"),
                game_data.get("home_hits"), game_data.get("away_hits"),
                game_data.get("home_errors"), game_data.get("away_errors"),
                json.dumps(game_data["home_line_score"]) if game_data.get("home_line_score") else None,
                json.dumps(game_data["away_line_score"]) if game_data.get("away_line_score") else None,
                game_data.get("innings"),
                game_data.get("game_score"),
                game_id,
            ))
            return game_id

    # Insert new game
    cur.execute("""
        INSERT INTO games (
            season, game_date, home_team_id, away_team_id,
            home_team_name, away_team_name,
            home_score, away_score, innings,
            is_conference_game, is_neutral_site,
            game_number, location,
            home_line_score, away_line_score,
            home_hits, home_errors, away_hits, away_errors,
            game_score, source_url, source_game_id, status
        ) VALUES (
            %s, %s, %s, %s,
            %s, %s,
            %s, %s, %s,
            %s, %s,
            %s, %s,
            %s, %s,
            %s, %s, %s, %s,
            %s, %s, %s, %s
        )
        RETURNING id
    """, (
        game_data.get("season"),
        game_data.get("game_date"),
        game_data.get("home_team_id"),
        game_data.get("away_team_id"),
        game_data.get("home_team_name"),
        game_data.get("away_team_name"),
        game_data.get("home_score"),
        game_data.get("away_score"),
        game_data.get("innings", 9),
        game_data.get("is_conference_game", False),
        game_data.get("is_neutral_site", False),
        game_data.get("game_number", 1),
        game_data.get("location"),
        json.dumps(game_data["home_line_score"]) if game_data.get("home_line_score") else None,
        json.dumps(game_data["away_line_score"]) if game_data.get("away_line_score") else None,
        game_data.get("home_hits"),
        game_data.get("home_errors"),
        game_data.get("away_hits"),
        game_data.get("away_errors"),
        game_data.get("game_score"),
        source_url or None,
        game_data.get("source_game_id"),
        game_data.get("status", "final"),
    ))
    row = cur.fetchone()
    return row["id"] if row else None


def insert_game_batting(cur, game_id, team_id, player_lines, season):
    """Insert batting lines for one team in a game."""
    for i, p in enumerate(player_lines):
        player_id = find_player_id(cur, team_id, p.get("player_name"), season) if team_id else None

        cur.execute("""
            INSERT INTO game_batting (
                game_id, team_id, player_id, player_name,
                batting_order, position,
                at_bats, runs, hits, doubles, triples, home_runs, rbi,
                walks, strikeouts, hit_by_pitch,
                sacrifice_flies, sacrifice_bunts,
                stolen_bases, caught_stealing, left_on_base
            ) VALUES (
                %s, %s, %s, %s,
                %s, %s,
                %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s,
                %s, %s,
                %s, %s, %s
            )
            ON CONFLICT (game_id, team_id, player_name, batting_order) DO UPDATE SET
                player_id = COALESCE(EXCLUDED.player_id, game_batting.player_id),
                at_bats = EXCLUDED.at_bats,
                runs = EXCLUDED.runs,
                hits = EXCLUDED.hits,
                doubles = EXCLUDED.doubles,
                triples = EXCLUDED.triples,
                home_runs = EXCLUDED.home_runs,
                rbi = EXCLUDED.rbi,
                walks = EXCLUDED.walks,
                strikeouts = EXCLUDED.strikeouts,
                hit_by_pitch = EXCLUDED.hit_by_pitch,
                sacrifice_flies = EXCLUDED.sacrifice_flies,
                sacrifice_bunts = EXCLUDED.sacrifice_bunts,
                stolen_bases = EXCLUDED.stolen_bases,
                caught_stealing = EXCLUDED.caught_stealing
        """, (
            game_id, team_id, player_id, p.get("player_name"),
            i + 1, p.get("position"),
            p.get("ab", 0), p.get("r", 0), p.get("h", 0),
            p.get("2b", 0), p.get("3b", 0), p.get("hr", 0), p.get("rbi", 0),
            p.get("bb", 0), p.get("so", 0), p.get("hbp", 0),
            p.get("sf", 0), p.get("sh", 0),
            p.get("sb", 0), p.get("cs", 0), p.get("lob", 0),
        ))


def insert_game_pitching(cur, game_id, team_id, pitcher_lines, season):
    """Insert pitching lines for one team in a game."""
    for p in pitcher_lines:
        player_id = find_player_id(cur, team_id, p.get("player_name"), season) if team_id else None
        ip = p.get("ip", 0) or 0
        er = p.get("er", 0) or 0
        h = p.get("h", 0) or 0
        bb = p.get("bb", 0) or 0
        k = p.get("so", 0) or 0
        hr = p.get("hr", 0) or 0

        # Compute game score for starter
        game_score_val = None
        if p.get("is_starter") and ip > 0:
            unearn = max(0, (p.get("r", 0) or 0) - er)
            game_score_val = compute_bill_james_game_score(ip, h, er, bb, k, hr, unearn)

        qs = is_quality_start(ip, er) if p.get("is_starter") else False

        cur.execute("""
            INSERT INTO game_pitching (
                game_id, team_id, player_id, player_name,
                pitch_order, is_starter, decision,
                innings_pitched, hits_allowed, runs_allowed, earned_runs,
                walks, strikeouts, home_runs_allowed,
                hit_batters, wild_pitches, batters_faced,
                pitches_thrown, strikes,
                game_score, is_quality_start
            ) VALUES (
                %s, %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                %s, %s,
                %s, %s
            )
            ON CONFLICT (game_id, team_id, player_name) DO UPDATE SET
                player_id = COALESCE(EXCLUDED.player_id, game_pitching.player_id),
                innings_pitched = EXCLUDED.innings_pitched,
                hits_allowed = EXCLUDED.hits_allowed,
                runs_allowed = EXCLUDED.runs_allowed,
                earned_runs = EXCLUDED.earned_runs,
                walks = EXCLUDED.walks,
                strikeouts = EXCLUDED.strikeouts,
                home_runs_allowed = EXCLUDED.home_runs_allowed,
                game_score = EXCLUDED.game_score,
                is_quality_start = EXCLUDED.is_quality_start
        """, (
            game_id, team_id, player_id, p.get("player_name"),
            p.get("pitch_order", 1), p.get("is_starter", False), p.get("decision"),
            ip, h, p.get("r", 0), er,
            bb, k, hr,
            p.get("hbp", 0), p.get("wp", 0), p.get("bf", 0),
            p.get("pitches", 0), p.get("strikes", 0),
            game_score_val, qs,
        ))


# ============================================================
# Main Scraping Logic — Per Team
# ============================================================

def scrape_team_boxscores(db_short, team_config, season_year, dry_run=False, since_date=None):
    """
    Scrape all box scores for a single team.
    Returns (games_found, games_scraped, errors).
    If since_date is set (YYYY-MM-DD string), only games on or after that date are processed.
    """
    base_url, sport, platform = team_config
    games_found = 0
    games_scraped = 0
    errors = 0

    logger.info(f"\n{'='*60}")
    logger.info(f"Scraping: {db_short} ({platform}) — Season {season_year}")
    logger.info(f"{'='*60}")

    # Look up team_id
    with get_connection() as conn:
        cur = conn.cursor()
        team_id = get_team_id_by_name(cur, db_short)
        if not team_id:
            logger.warning(f"  Team '{db_short}' not found in database — skipping")
            return 0, 0, 1

    # ─── Step 1: Fetch schedule page and parse game list ───
    if platform == "presto":
        # PrestoSports URL format
        if db_short in NWAC_TEAM_SLUGS:
            slug = NWAC_TEAM_SLUGS[db_short]
            # NWAC uses academic-year seasons (e.g., "2025-26")
            presto_season = f"{season_year - 1}-{str(season_year)[2:]}"
            schedule_url = build_presto_schedule_url(base_url, sport, slug, presto_season)
        elif db_short == "Willamette":
            presto_season = f"{season_year - 1}-{str(season_year)[2:]}"
            schedule_url = build_presto_schedule_url(base_url, sport, "willamette", presto_season)
        else:
            logger.error(f"  Unknown PrestoSports team: {db_short}")
            return 0, 0, 1

        logger.info(f"  Fetching schedule: {schedule_url}")
        html = fetch_page(schedule_url)
        schedule = parse_presto_schedule(html, base_url, season_year)
    else:
        # Sidearm Sports
        schedule_url = build_sidearm_schedule_url(base_url, sport, season_year)
        logger.info(f"  Fetching schedule: {schedule_url}")
        html = fetch_page(schedule_url)

        if not html:
            # Try without year
            schedule_url = f"{base_url}/sports/{sport}/schedule"
            logger.info(f"  Retrying without year: {schedule_url}")
            html = fetch_page(schedule_url)

        schedule = parse_sidearm_schedule(html, base_url, season_year)

    games_found = len(schedule)

    # Filter by --since date if provided
    if since_date:
        from datetime import date as dt_date
        try:
            cutoff = dt_date.fromisoformat(since_date)
        except ValueError:
            logger.error(f"  Invalid --since date: {since_date} (use YYYY-MM-DD)")
            return 0, 0, 1
        before = len(schedule)
        schedule = [g for g in schedule if g.get("date") and g["date"] >= cutoff]
        logger.info(f"  Found {before} total games, {len(schedule)} since {since_date}")
        games_found = len(schedule)
    else:
        logger.info(f"  Found {games_found} completed games on schedule")

    if dry_run:
        for g in schedule[:5]:
            logger.info(f"    {g.get('date')} vs {g.get('opponent')}: "
                       f"{g.get('team_score')}-{g.get('opp_score')} "
                       f"{'[box]' if g.get('box_score_url') else '[no box]'}")
        if games_found > 5:
            logger.info(f"    ... and {games_found - 5} more")
        return games_found, 0, 0

    # ─── Step 2: For each game, fetch box score and save ───
    for i, sched_game in enumerate(schedule):
        try:
            logger.info(f"  Game {i+1}/{games_found}: "
                       f"{sched_game.get('date')} vs {sched_game.get('opponent')} "
                       f"({sched_game.get('team_score')}-{sched_game.get('opp_score')})")

            # Determine home/away — if opponent starts with "at " or "@", we're away
            opponent = sched_game.get("opponent", "")
            is_away = opponent.lower().startswith(("at ", "@"))
            opponent_clean = re.sub(r'^(?:at |@ |vs\.?\s*)', '', opponent, flags=re.I).strip()

            # Build a unique source_url even if no box score page exists
            source_url = sched_game.get("box_score_url")
            if not source_url:
                # Synthesise a unique key from team + date + game number
                date_str = str(sched_game.get("date") or "nodate")
                gn = sched_game.get("game_number", 1)
                source_url = f"gamelog://{db_short}/{date_str}/{opponent_clean}/{gn}"

            # Build game data
            game_data = {
                "season": season_year,
                "game_date": sched_game.get("date"),
                "innings": sched_game.get("innings", 9),
                "is_conference_game": sched_game.get("is_conference", False),
                "game_number": sched_game.get("game_number", 1),
                "location": sched_game.get("location"),
                "source_url": source_url,
                "status": "final",
            }

            ts = sched_game["team_score"]
            os_score = sched_game["opp_score"]

            if is_away:
                game_data["away_team_id"] = team_id
                game_data["away_team_name"] = db_short
                game_data["home_team_name"] = opponent_clean
                game_data["away_score"] = ts
                game_data["home_score"] = os_score
            else:
                game_data["home_team_id"] = team_id
                game_data["home_team_name"] = db_short
                game_data["away_team_name"] = opponent_clean
                game_data["home_score"] = ts
                game_data["away_score"] = os_score

            # Try to resolve opponent team_id
            with get_connection() as conn:
                cur = conn.cursor()
                opp_id = get_team_id_by_school(cur, opponent_clean)
                if opp_id:
                    if is_away:
                        game_data["home_team_id"] = opp_id
                    else:
                        game_data["away_team_id"] = opp_id

            # Compute team game score
            winner = max(ts, os_score)
            loser = min(ts, os_score)
            game_data["game_score"] = compute_team_game_score(winner, loser, game_data["innings"])

            # ─── Embed team-level stats from game log (PrestoSports) ───
            team_bat = sched_game.get("team_batting")
            if team_bat:
                hits = team_bat.get("h", 0)
                if is_away:
                    game_data["away_hits"] = hits
                else:
                    game_data["home_hits"] = hits

            # ─── Fetch and parse box score (if a real URL is available) ───
            box_batting = {"home": [], "away": []}
            box_pitching = {"home": [], "away": []}

            real_box_url = sched_game.get("box_score_url")
            if real_box_url:
                logger.info(f"    Fetching box score: {real_box_url}")
                box_html = fetch_page(real_box_url, retries=2, delay_range=(1.0, 2.0))

                if box_html:
                    if platform == "presto":
                        box = parse_presto_boxscore(box_html, base_url)
                    else:
                        box = parse_sidearm_boxscore(box_html, base_url)

                    if box:
                        # Update game data with box score details
                        # NOTE: Do NOT override home_score/away_score from box score
                        # parsing — the schedule scores are reliable and the box score
                        # parser can mis-assign home/away when the scraping team's
                        # perspective differs from the box score page layout.
                        if box.get("home_hits") is not None:
                            game_data["home_hits"] = box["home_hits"]
                        if box.get("away_hits") is not None:
                            game_data["away_hits"] = box["away_hits"]
                        if box.get("home_errors") is not None:
                            game_data["home_errors"] = box["home_errors"]
                        if box.get("away_errors") is not None:
                            game_data["away_errors"] = box["away_errors"]
                        if box.get("line_score"):
                            game_data["home_line_score"] = box["line_score"].get("home")
                            game_data["away_line_score"] = box["line_score"].get("away")
                        if box.get("innings"):
                            game_data["innings"] = box["innings"]

                        box_batting = box.get("batting", box_batting)
                        box_pitching = box.get("pitching", box_pitching)

                        logger.info(f"    Box score: {len(box_batting.get('away', []))} away batters, "
                                   f"{len(box_batting.get('home', []))} home batters, "
                                   f"{len(box_pitching.get('away', []))} away pitchers, "
                                   f"{len(box_pitching.get('home', []))} home pitchers")
                else:
                    logger.warning(f"    Failed to fetch box score page")

            # ─── Save to database ───
            with get_connection() as conn:
                cur = conn.cursor()

                game_id = upsert_game(cur, game_data)
                if not game_id:
                    logger.warning(f"    Failed to upsert game")
                    errors += 1
                    continue

                # Insert batting lines
                home_team = game_data.get("home_team_id")
                away_team = game_data.get("away_team_id")

                if box_batting.get("home"):
                    insert_game_batting(cur, game_id, home_team, box_batting["home"], season_year)
                if box_batting.get("away"):
                    insert_game_batting(cur, game_id, away_team, box_batting["away"], season_year)

                # Insert pitching lines
                if box_pitching.get("home"):
                    insert_game_pitching(cur, game_id, home_team, box_pitching["home"], season_year)
                if box_pitching.get("away"):
                    insert_game_pitching(cur, game_id, away_team, box_pitching["away"], season_year)

                conn.commit()

            games_scraped += 1

        except Exception as e:
            logger.error(f"    Error processing game: {e}")
            import traceback
            traceback.print_exc()
            errors += 1

    logger.info(f"\n  {db_short}: {games_found} found, {games_scraped} scraped, {errors} errors")
    return games_found, games_scraped, errors


# ============================================================
# CLI Entry Point
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="Scrape box scores for PNW baseball teams")
    parser.add_argument("--season", type=int, required=True, help="Season year (e.g. 2026)")
    parser.add_argument("--division", type=str, default=None,
                       choices=["D1", "D2", "D3", "NAIA", "JUCO", "all"],
                       help="Division to scrape (default: all)")
    parser.add_argument("--team", type=str, default=None,
                       help="Specific team short_name or alias")
    parser.add_argument("--dry-run", action="store_true",
                       help="Parse schedules but don't fetch box scores or save to DB")
    parser.add_argument("--skip-boxscores", action="store_true",
                       help="Save game results from schedule only, don't fetch individual box scores")
    parser.add_argument("--since", type=str, default=None,
                       help="Only scrape games on or after this date (YYYY-MM-DD)")
    parser.add_argument("--verbose", "-v", action="store_true",
                       help="Enable debug logging")

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Determine which teams to scrape
    teams_to_scrape = {}  # {short_name: (base_url, sport, platform)}

    if args.team:
        # Single team
        team_name = TEAM_ALIASES.get(args.team.lower(), args.team)
        found = False
        for div_name, div_teams in DIVISION_MAP.items():
            if team_name in div_teams:
                teams_to_scrape[team_name] = div_teams[team_name]
                found = True
                break
        if not found:
            logger.error(f"Team '{args.team}' not found. Available teams:")
            for div_name, div_teams in DIVISION_MAP.items():
                logger.error(f"  {div_name}: {', '.join(div_teams.keys())}")
            sys.exit(1)
    elif args.division and args.division != "all":
        teams_to_scrape = dict(DIVISION_MAP[args.division])
    else:
        for div_teams in DIVISION_MAP.values():
            teams_to_scrape.update(div_teams)

    logger.info(f"Box Score Scraper — Season {args.season}")
    logger.info(f"Teams to scrape: {len(teams_to_scrape)}")
    if args.dry_run:
        logger.info("DRY RUN — will parse schedules but not save anything")

    # Scrape each team
    total_found = 0
    total_scraped = 0
    total_errors = 0

    for short_name, config in teams_to_scrape.items():
        found, scraped, errs = scrape_team_boxscores(
            short_name, config, args.season, dry_run=args.dry_run,
            since_date=args.since
        )
        total_found += found
        total_scraped += scraped
        total_errors += errs

    # Summary
    logger.info(f"\n{'='*60}")
    logger.info(f"SCRAPE COMPLETE")
    logger.info(f"  Teams: {len(teams_to_scrape)}")
    logger.info(f"  Games found: {total_found}")
    logger.info(f"  Games scraped: {total_scraped}")
    logger.info(f"  Errors: {total_errors}")
    logger.info(f"{'='*60}")


if __name__ == "__main__":
    main()
