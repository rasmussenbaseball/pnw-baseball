#!/usr/bin/env python3
"""
PNW Baseball — Live Score Scraper
===================================

Fetches schedule pages from all PNW team websites and extracts
today's games with current scores and statuses.

Data source: Sidearm Sports schedule pages embed all game data in a
<script id="__NUXT_DATA__" type="application/json"> tag (Nuxt 3 devalue format).
We parse this to get structured game data including live scores.

For PrestoSports (NWAC) teams, we fall back to HTML parsing.

Output: writes a JSON file at backend/data/live_scores.json that the
API endpoint /games/live reads from.

Usage:
    cd pnw-baseball
    PYTHONPATH=backend python3 scripts/scrape_live_scores.py
    PYTHONPATH=backend python3 scripts/scrape_live_scores.py --season 2026
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

import requests
from bs4 import BeautifulSoup

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("scrape_live_scores")

# ============================================================
# Team Configuration (Sidearm teams only — they have __NUXT_DATA__)
# ============================================================

SIDEARM_TEAMS = {
    # D1
    "UW":         {"url": "https://gohuskies.com",       "sport": "baseball", "division": "D1"},
    "Oregon":     {"url": "https://goducks.com",          "sport": "baseball", "division": "D1"},
    "Oregon St.": {"url": "https://osubeavers.com",       "sport": "baseball", "division": "D1"},
    "Wash. St.":  {"url": "https://wsucougars.com",       "sport": "baseball", "division": "D1"},
    "Gonzaga":    {"url": "https://gozags.com",           "sport": "baseball", "division": "D1"},
    "Portland":   {"url": "https://portlandpilots.com",   "sport": "baseball", "division": "D1"},
    "Seattle U":  {"url": "https://goseattleu.com",       "sport": "baseball", "division": "D1"},
    # D2
    "CWU":   {"url": "https://wildcatsports.com",  "sport": "baseball", "division": "D2"},
    "SMU":   {"url": "https://smusaints.com",       "sport": "baseball", "division": "D2"},
    "MSUB":  {"url": "https://msubsports.com",      "sport": "baseball", "division": "D2"},
    "WOU":   {"url": "https://wouwolves.com",        "sport": "baseball", "division": "D2"},
    "NNU":   {"url": "https://nnusports.com",        "sport": "baseball", "division": "D2"},
    # D3
    "UPS":       {"url": "https://loggerathletics.com",      "sport": "baseball", "division": "D3"},
    "PLU":       {"url": "https://golutes.com",              "sport": "baseball", "division": "D3"},
    "Whitman":   {"url": "https://athletics.whitman.edu",    "sport": "baseball", "division": "D3"},
    "Whitworth": {"url": "https://whitworthpirates.com",     "sport": "baseball", "division": "D3"},
    "L&C":       {"url": "https://golcathletics.com",        "sport": "baseball", "division": "D3"},
    "Pacific":   {"url": "https://goboxers.com",             "sport": "baseball", "division": "D3"},
    "Linfield":  {"url": "https://golinfieldwildcats.com",   "sport": "baseball", "division": "D3"},
    "GFU":       {"url": "https://athletics.georgefox.edu",   "sport": "baseball", "division": "D3"},
    # NAIA
    "LCSC":          {"url": "https://lcwarriors.com",       "sport": "baseball", "division": "NAIA"},
    "EOU":           {"url": "https://eousports.com",        "sport": "baseball", "division": "NAIA"},
    "OIT":           {"url": "https://oregontechowls.com",   "sport": "baseball", "division": "NAIA"},
    "C of I":        {"url": "https://yoteathletics.com",    "sport": "baseball", "division": "NAIA"},
    "Corban":        {"url": "https://corbanwarriors.com",   "sport": "baseball", "division": "NAIA"},
    "Bushnell":      {"url": "https://bushnellbeacons.com",  "sport": "baseball", "division": "NAIA"},
    "Warner Pacific": {"url": "https://wpuknights.com",      "sport": "baseball", "division": "NAIA"},
    "UBC":           {"url": "https://gothunderbirds.ca",    "sport": "baseball", "division": "NAIA"},
}

USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
]

session = requests.Session()
last_request_time = 0


def fetch_page(url, retries=2, delay_range=(0.5, 1.5)):
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
            resp = session.get(url, headers=headers, timeout=20)
            last_request_time = time.time()
            resp.raise_for_status()
            return resp.text
        except requests.RequestException as e:
            logger.warning(f"  Attempt {attempt+1}/{retries} failed for {url}: {e}")
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
    logger.error(f"All retries failed for {url}")
    return None


# ============================================================
# Nuxt 3 Devalue Parser
# ============================================================

def parse_nuxt_data(html):
    """
    Extract and parse the __NUXT_DATA__ script tag from a Sidearm page.
    Returns the reconstructed Python object, or None on failure.

    Nuxt 3 uses 'devalue' serialization: a JSON array where index 0 is the
    root value, and subsequent entries are referenced by index. Special
    entries like ["ShallowReactive", idx] or ["Reactive", idx] are wrappers
    around the referenced value.
    """
    soup = BeautifulSoup(html, "html.parser")
    script = soup.find("script", id="__NUXT_DATA__")
    if not script:
        return None

    try:
        raw = json.loads(script.string)
    except (json.JSONDecodeError, TypeError):
        return None

    if not isinstance(raw, list) or len(raw) == 0:
        return None

    return _devalue_parse(raw)


def _devalue_parse(raw):
    """
    Parse a devalue-serialized array into a Python object.
    The format is: each element is either a literal value or a reference.
    Special arrays like ["ShallowReactive", idx] mean "the value at idx".
    Objects use alternating key/value pairs referenced by index.
    """
    cache = {}

    def resolve(idx):
        if idx in cache:
            return cache[idx]

        if idx >= len(raw):
            return None

        val = raw[idx]

        # Null/boolean/number/string are literal
        if val is None or isinstance(val, (bool, int, float, str)):
            cache[idx] = val
            return val

        # Arrays with special markers
        if isinstance(val, list):
            if len(val) >= 2 and isinstance(val[0], str):
                marker = val[0]
                if marker in ("ShallowReactive", "Reactive", "ShallowRef", "Ref"):
                    result = resolve(val[1])
                    cache[idx] = result
                    return result
                if marker == "Set":
                    result = []  # Use list instead of set (dicts aren't hashable)
                    for i in range(1, len(val)):
                        result.append(resolve(val[i]))
                    cache[idx] = result
                    return result
                if marker == "Map":
                    result = {}
                    for i in range(1, len(val), 2):
                        k = resolve(val[i])
                        v = resolve(val[i+1]) if i+1 < len(val) else None
                        result[k] = v
                    cache[idx] = result
                    return result
                if marker == "Date":
                    cache[idx] = val[1] if len(val) > 1 else None
                    return cache[idx]
                if marker in ("undefined", "NaN", "Infinity", "-Infinity", "-0"):
                    cache[idx] = None
                    return None

            # Regular array — each element is an index reference
            result = []
            cache[idx] = result  # Pre-cache to handle circular refs
            for ref_idx in val:
                if isinstance(ref_idx, int):
                    result.append(resolve(ref_idx))
                else:
                    result.append(ref_idx)
            return result

        # Objects — keys and values are index references
        if isinstance(val, dict):
            result = {}
            cache[idx] = result  # Pre-cache
            for k_ref, v_ref in val.items():
                try:
                    key = resolve(int(k_ref)) if isinstance(k_ref, str) and k_ref.isdigit() else k_ref
                    # Keys must be hashable — skip if they're dicts/lists
                    if isinstance(key, (dict, list)):
                        key = str(key)
                    if isinstance(v_ref, int):
                        result[key] = resolve(v_ref)
                    else:
                        result[key] = v_ref
                except (TypeError, ValueError):
                    continue
            return result

        cache[idx] = val
        return val

    try:
        return resolve(0)
    except Exception as e:
        logger.warning(f"  Devalue parse error: {e}")
        return None


def extract_games_from_nuxt(nuxt_data):
    """
    Navigate the parsed Nuxt data structure to extract game objects.
    Returns a list of game dicts from the schedule store.
    """
    if not nuxt_data or not isinstance(nuxt_data, dict):
        return []

    # Navigate: data -> pinia -> schedule -> schedules -> first key -> games
    pinia = nuxt_data.get("pinia", {})
    if not pinia:
        # Try state -> pinia
        state = nuxt_data.get("state", {})
        pinia = state.get("pinia", state)

    schedule = pinia.get("schedule", {})
    schedules = schedule.get("schedules", {})

    games = []
    for key, sched_obj in schedules.items():
        if isinstance(sched_obj, dict) and "games" in sched_obj:
            sched_games = sched_obj["games"]
            if isinstance(sched_games, list):
                games.extend(sched_games)

    return games


# ============================================================
# Game Filtering & Formatting
# ============================================================

def is_today_or_recent(game_date_str, today):
    """Check if a game date is today (for live) or within last 2 days (for recent results)."""
    if not game_date_str:
        return False, False

    try:
        # Parse ISO format: "2026-03-29T19:00:00"
        game_dt = datetime.fromisoformat(game_date_str.replace("Z", "+00:00"))
        game_date = game_dt.date()

        is_today = game_date == today
        is_recent = (today - game_date).days <= 2 and (today - game_date).days >= 0
        return is_today, is_recent
    except (ValueError, TypeError):
        return False, False


def format_game(game, team_name, team_info):
    """Format a raw Nuxt game object into our standardized format."""
    if not isinstance(game, dict):
        return None

    result = game.get("result", {}) or {}
    opponent = game.get("opponent", {})
    if isinstance(opponent, dict):
        opp_name = opponent.get("title", "Unknown")
        opp_image = opponent.get("image", "")
    else:
        opp_name = str(opponent) if opponent else "Unknown"
        opp_image = ""

    # Determine game status
    status_code = game.get("status", "")
    game_state = game.get("game_state", 0)
    game_state_display = game.get("game_state_display", "")

    if status_code == "O":
        status = "final"
    elif game_state_display and game_state_display not in ("SCHEDULED", ""):
        status = "live"
    elif game_state and game_state != 0:
        status = "live"
    else:
        status = "scheduled"

    # Location
    loc_indicator = game.get("location_indicator", "")
    if loc_indicator == "H":
        location = "home"
    elif loc_indicator == "A":
        location = "away"
    else:
        location = "neutral"

    # Line scores
    line_scores = None
    if isinstance(result, dict) and result.get("line_scores"):
        ls = result["line_scores"]
        if isinstance(ls, dict):
            line_scores = {
                "home_name": ls.get("home_short_name", ""),
                "away_name": ls.get("away_short_name", ""),
                "periods": ls.get("periods", 9),
                "home_scores": ls.get("period_home_score", []),
                "away_scores": ls.get("period_away_score", []),
            }

    formatted = {
        "id": game.get("id"),
        "team": team_name,
        "team_division": team_info.get("division", ""),
        "opponent": re.sub(r'^#\d+\s+', '', opp_name).strip(),
        "opponent_display": opp_name,  # Keep ranking prefix for display
        "opponent_image": opp_image,
        "date": game.get("date", ""),
        "time": game.get("time", ""),
        "status": status,
        "game_state_display": game_state_display,
        "location": location,
        "team_score": result.get("team_score") if isinstance(result, dict) else None,
        "opponent_score": result.get("opponent_score") if isinstance(result, dict) else None,
        "result_status": result.get("status") if isinstance(result, dict) else None,
        "line_scores": line_scores,
        "is_conference": game.get("conference", False),
    }

    return formatted


# ============================================================
# Main Scraping Logic
# ============================================================

def parse_html_schedule(html, team_name, team_info, today):
    """
    Fallback parser for older Sidearm sites that don't use Nuxt 3.
    Looks for game data in the rendered HTML using common Sidearm patterns.
    """
    soup = BeautifulSoup(html, "html.parser")
    games = []

    # Try multiple Sidearm HTML patterns
    # Pattern 1: c-events__item (newer non-Nuxt3 Sidearm)
    event_items = soup.find_all("div", class_=re.compile(r"c-events__item"))
    # Pattern 2: s-game-card (Oregon, OSU style)
    if not event_items:
        event_items = soup.find_all("div", class_=re.compile(r"\bs-game-card\b"))
    # Pattern 3: sidearm-schedule-game (legacy)
    if not event_items:
        event_items = soup.find_all("div", class_=re.compile(r"sidearm-schedule-game"))
    # Pattern 4: generic list items with score data
    if not event_items:
        event_items = soup.find_all("li", class_=re.compile(r"schedule|game", re.I))

    for item in event_items:
        try:
            game = _parse_html_game_item(item, team_name, team_info, today)
            if game:
                games.append(game)
        except Exception:
            continue

    logger.info(f"  {team_name}: HTML fallback found {len(games)} relevant games")
    return games


def _parse_html_game_item(item, team_name, team_info, today):
    """Parse a single game element from HTML."""
    text = item.get_text(" ", strip=True)

    # Look for date
    time_el = item.find("time")
    date_str = None
    if time_el:
        date_str = time_el.get("datetime") or time_el.get_text(strip=True)
    else:
        # Try to find date in a span or div
        date_el = item.find(class_=re.compile(r"date|time|when", re.I))
        if date_el:
            date_str = date_el.get_text(strip=True)

    if not date_str:
        return None

    # Parse the date
    game_date = None
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%b %d, %Y", "%B %d, %Y", "%m/%d/%Y",
                "%b. %d, %Y", "%b %d", "%B %d"):
        try:
            cleaned = re.sub(r'\s+', ' ', date_str.strip())
            cleaned = re.sub(r'(\b[A-Z][a-z]{2})\.', r'\1', cleaned)
            dt = datetime.strptime(cleaned.split('T')[0] if 'T' in cleaned else cleaned, fmt.replace('.', ''))
            if dt.year < 2000:
                dt = dt.replace(year=2026)
            game_date = dt.date()
            break
        except ValueError:
            continue

    if not game_date:
        # Try ISO format
        m = re.search(r'(\d{4}-\d{2}-\d{2})', date_str)
        if m:
            try:
                game_date = datetime.strptime(m.group(1), "%Y-%m-%d").date()
            except ValueError:
                return None

    if not game_date:
        return None

    # Check if today or recent
    days_diff = (today - game_date).days
    if days_diff < 0 and days_diff < -3:  # More than 3 days in future
        return None
    if days_diff > 2:  # More than 2 days ago
        return None

    # Find opponent
    opp_el = item.find(class_=re.compile(r"opponent|team-name", re.I))
    opponent = opp_el.get_text(strip=True) if opp_el else None
    if not opponent:
        # Try aria-label on links
        links = item.find_all("a", attrs={"aria-label": True})
        for link in links:
            label = link.get("aria-label", "")
            m = re.search(r'(?:vs\.?|at)\s+(.+?)(?:\s+on\s+|\s*$)', label, re.I)
            if m:
                opponent = m.group(1).strip()
                break

    if not opponent:
        return None

    # Clean opponent name (remove ranking prefix)
    opponent_display = opponent
    opponent = re.sub(r'^#\d+\s+', '', opponent).strip()

    # Find scores
    team_score = None
    opp_score = None
    status = "scheduled"

    score_els = item.find_all(class_=re.compile(r"score", re.I))
    if len(score_els) >= 2:
        try:
            team_score = int(re.search(r'\d+', score_els[0].get_text()).group())
            opp_score = int(re.search(r'\d+', score_els[1].get_text()).group())
            status = "final"
        except (ValueError, AttributeError):
            pass

    # Also check for "W, 8-3" or "L, 4-10" patterns in text
    if team_score is None:
        score_m = re.search(r'([WLT])\s*,?\s*(\d+)\s*-\s*(\d+)', text)
        if score_m:
            team_score = int(score_m.group(2))
            opp_score = int(score_m.group(3))
            status = "final"

    # Check for live indicators
    if re.search(r'\b(live|in progress|in\s*game|top|bot|bottom|mid)\b', text, re.I):
        status = "live"

    # Determine location
    location = "home"
    if re.search(r'\bat\b|\baway\b', text, re.I) or item.find(string=re.compile(r'^at$|^@', re.I)):
        location = "away"
    loc_el = item.find(class_=re.compile(r"location", re.I))
    if loc_el and re.search(r'at|away', loc_el.get_text(), re.I):
        location = "away"

    # Extract time
    time_text = ""
    time_display = item.find(class_=re.compile(r"time|start", re.I))
    if time_display:
        time_text = time_display.get_text(strip=True)

    is_today = game_date == today

    return {
        "id": None,
        "team": team_name,
        "team_division": team_info.get("division", ""),
        "opponent": opponent,
        "opponent_display": opponent_display,
        "opponent_image": "",
        "date": game_date.isoformat() + "T00:00:00",
        "time": time_text,
        "status": status,
        "game_state_display": "",
        "location": location,
        "team_score": str(team_score) if team_score is not None else None,
        "opponent_score": str(opp_score) if opp_score is not None else None,
        "result_status": None,
        "line_scores": None,
        "is_conference": False,
    }


def scrape_team_scores(team_name, team_info, season, today):
    """Scrape a single team's schedule page for today's and recent games."""
    base_url = team_info["url"]
    sport = team_info["sport"]
    url = f"{base_url}/sports/{sport}/schedule/{season}"

    logger.info(f"Fetching {team_name}: {url}")
    html = fetch_page(url)
    if not html:
        return []

    # Try Nuxt data extraction first
    nuxt_data = parse_nuxt_data(html)
    if nuxt_data:
        games = extract_games_from_nuxt(nuxt_data)
        logger.info(f"  {team_name}: extracted {len(games)} games from __NUXT_DATA__")

        today_games = []
        recent_games = []
        upcoming_games = []

        for game in games:
            if not isinstance(game, dict):
                continue

            game_date = game.get("date", "")
            is_today, is_recent = is_today_or_recent(game_date, today)

            formatted = format_game(game, team_name, team_info)
            if not formatted:
                continue

            if is_today:
                today_games.append(formatted)
            elif is_recent and formatted["status"] == "final":
                recent_games.append(formatted)
            else:
                # Check if upcoming (within next 3 days)
                try:
                    game_dt = datetime.fromisoformat(game_date.replace("Z", "+00:00")).date()
                    days_until = (game_dt - today).days
                    if 0 < days_until <= 3:
                        upcoming_games.append(formatted)
                except (ValueError, TypeError):
                    pass

        return today_games + recent_games[:3] + upcoming_games[:2]

    # Fallback: parse HTML for game data (older Sidearm sites)
    logger.info(f"  {team_name}: no __NUXT_DATA__, trying HTML fallback")
    return parse_html_schedule(html, team_name, team_info, today)


def main():
    parser = argparse.ArgumentParser(description="Scrape live scores for PNW baseball")
    parser.add_argument("--season", type=int, default=2026, help="Season year")
    args = parser.parse_args()

    # Use Pacific time for "today"
    import pytz
    pacific = pytz.timezone("US/Pacific")
    now_pacific = datetime.now(pacific)
    today = now_pacific.date()

    logger.info(f"=== Live Score Scraper — {today} (Pacific) ===")
    logger.info(f"Season: {args.season}")

    all_games = {
        "today": [],
        "recent": [],
        "upcoming": [],
        "last_updated": now_pacific.isoformat(),
        "date": str(today),
    }

    for team_name, team_info in SIDEARM_TEAMS.items():
        try:
            games = scrape_team_scores(team_name, team_info, args.season, today)
            for g in games:
                if g["status"] == "live" or is_today_or_recent(g["date"], today)[0]:
                    all_games["today"].append(g)
                elif g["status"] == "final":
                    all_games["recent"].append(g)
                else:
                    all_games["upcoming"].append(g)
        except Exception as e:
            logger.error(f"Error scraping {team_name}: {e}")
            continue

    # Deduplicate games (same matchup appears from both teams' perspectives)
    all_games["today"] = deduplicate_games(all_games["today"])
    all_games["recent"] = deduplicate_games(all_games["recent"])
    all_games["upcoming"] = deduplicate_games(all_games["upcoming"])

    # Sort: live games first, then by time
    all_games["today"].sort(key=lambda g: (
        0 if g["status"] == "live" else 1 if g["status"] == "scheduled" else 2,
        g.get("date", ""),
    ))
    all_games["recent"].sort(key=lambda g: g.get("date", ""), reverse=True)
    all_games["upcoming"].sort(key=lambda g: g.get("date", ""))

    # Write output
    output_path = Path(__file__).parent.parent / "backend" / "data" / "live_scores.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w") as f:
        json.dump(all_games, f, indent=2, default=str)

    logger.info(f"Wrote {len(all_games['today'])} today, "
                f"{len(all_games['recent'])} recent, "
                f"{len(all_games['upcoming'])} upcoming to {output_path}")


def deduplicate_games(games):
    """
    Remove duplicate games that appear from both teams' schedules.
    Keep the home team's version when possible.
    """
    seen = {}
    for g in games:
        # Create a key from the two teams and date
        teams = sorted([g["team"], g["opponent"]])
        date_key = g.get("date", "")[:10]  # Just the date part
        key = f"{teams[0]}_{teams[1]}_{date_key}"

        if key not in seen:
            seen[key] = g
        else:
            # Prefer home team's perspective
            if g["location"] == "home":
                seen[key] = g

    return list(seen.values())


if __name__ == "__main__":
    main()
