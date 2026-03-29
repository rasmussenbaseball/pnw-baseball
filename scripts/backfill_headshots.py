#!/usr/bin/env python3
"""
One-time backfill script to scrape player headshot URLs from roster pages
for all teams across all divisions. This only updates the headshot_url column
on existing player records — it does NOT scrape stats.

Usage:
    cd pnw-baseball
    PYTHONPATH=backend python3 scripts/backfill_headshots.py
    PYTHONPATH=backend python3 scripts/backfill_headshots.py --division D1
    PYTHONPATH=backend python3 scripts/backfill_headshots.py --team "Oregon"
"""
import sys
import os
import argparse
import json
import re
import time
import logging
from urllib.parse import urljoin

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

import requests
from bs4 import BeautifulSoup
from app.models.database import get_connection

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("backfill_headshots")

# ============================================================
# Team URL configs — keyed by DB short_name
# Value is (base_url, sport_path, platform)
#   platform: "sidearm" | "presto"
# ============================================================

# D1 teams — PNW Sidearm athletics sites
D1_TEAMS = {
    "UW":           ("https://gohuskies.com",           "baseball", "sidearm"),
    "Oregon":       ("https://goducks.com",             "baseball", "sidearm"),
    "Oregon St.":   ("https://osubeavers.com",          "baseball", "sidearm"),
    "Wash. St.":    ("https://wsucougars.com",          "baseball", "sidearm"),
    "Gonzaga":      ("https://gozags.com",              "baseball", "sidearm"),
    "Portland":     ("https://portlandpilots.com",      "baseball", "sidearm"),
    "Seattle U":    ("https://goseattleu.com",          "baseball", "sidearm"),
}

# D2 teams — GNAC, Sidearm sites
D2_TEAMS = {
    "CWU":  ("https://wildcatsports.com",  "baseball", "sidearm"),
    "SMU":  ("https://smusaints.com",      "baseball", "sidearm"),
    "MSUB": ("https://msubsports.com",     "baseball", "sidearm"),
    "WOU":  ("https://wouwolves.com",      "baseball", "sidearm"),
    "NNU":  ("https://nnusports.com",      "baseball", "sidearm"),
}

# D3 teams — NWC, mix of Sidearm and PrestoSports
D3_TEAMS = {
    "UPS":       ("https://loggerathletics.com",    "baseball", "sidearm"),
    "PLU":       ("https://golutes.com",            "baseball", "sidearm"),
    "Whitman":   ("https://athletics.whitman.edu",  "baseball", "sidearm"),
    "Whitworth": ("https://whitworthpirates.com",   "baseball", "sidearm"),
    "L&C":       ("https://golcathletics.com",      "baseball", "sidearm"),
    "Pacific":   ("https://goboxers.com",           "baseball", "sidearm"),
    "Linfield":  ("https://golinfieldwildcats.com", "baseball", "sidearm"),
    "GFU":       ("https://athletics.georgefox.edu","baseball", "sidearm"),
    "Willamette":("https://www.wubearcats.com",     "bsb",     "presto"),
}

# NAIA teams — CCC, Sidearm sites
NAIA_TEAMS = {
    "LCSC":           ("https://lcwarriors.com",       "baseball", "sidearm"),
    "EOU":            ("https://eousports.com",        "baseball", "sidearm"),
    "OIT":            ("https://oregontechowls.com",   "baseball", "sidearm"),
    "C of I":         ("https://yoteathletics.com",    "baseball", "sidearm"),
    "Corban":         ("https://corbanwarriors.com",   "baseball", "sidearm"),
    "Bushnell":       ("https://bushnellbeacons.com",  "baseball", "sidearm"),
    "Warner Pacific": ("https://wpuknights.com",       "baseball", "sidearm"),
    "UBC":            ("https://gothunderbirds.ca",    "baseball", "sidearm"),
}

# NWAC teams — PrestoSports (nwacsports.com)
NWAC_BASE_URL = "https://nwacsports.com"
NWAC_TEAMS = {
    "Bellevue":         "bellevue",
    "Big Bend":         "bigbend",
    "Blue Mountain":    "bluemountain",
    "Centralia":        "centralia",
    "Chemeketa":        "chemeketa",
    "Clackamas":        "clackamas",
    "Clark":            "clark",
    "Columbia Basin":   "columbiabasin",
    "Douglas":          "douglas",
    "Edmonds":          "edmonds",
    "Everett":          "everett",
    "Grays Harbor":     "graysharbor",
    "Lane":             "lane",
    "Linn-Benton":      "linnbenton",
    "Lower Columbia":   "lowercolumbia",
    "Mt. Hood":         "mthood",
    "Olympic":          "olympic",
    "Pierce":           "pierce",
    "Shoreline":        "shoreline",
    "Skagit":           "skagitvalley",
    "SW Oregon":        "southwesternoregon",
    "Spokane":          "spokane",
    "Tacoma":           "tacoma",
    "Treasure Valley":  "treasurevalley",
    "Umpqua":           "umpqua",
    "Walla Walla":      "wallawalla",
    "Wenatchee Valley": "wenatcheevalley",
    "Yakima Valley":    "yakimavalley",
}

# Combine all Sidearm/standard teams into one lookup
ALL_TEAMS = {}
ALL_TEAMS.update(D1_TEAMS)
ALL_TEAMS.update(D2_TEAMS)
ALL_TEAMS.update(D3_TEAMS)
ALL_TEAMS.update(NAIA_TEAMS)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}


def fetch_page(url):
    """Fetch a URL with retries."""
    for attempt in range(2):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=15)
            resp.raise_for_status()
            return resp.text
        except Exception as e:
            if attempt == 1:
                logger.warning(f"  Failed to fetch {url}: {e}")
                return None
            time.sleep(1)
    return None


def fetch_json(url, params=None):
    """Fetch a URL and return parsed JSON, or None on failure."""
    for attempt in range(2):
        try:
            resp = requests.get(url, headers=HEADERS, params=params, timeout=15)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            if attempt == 1:
                logger.warning(f"  Failed to fetch JSON {url}: {e}")
                return None
            time.sleep(1)
    return None


def parse_nuxt_roster(html, base_url=""):
    """Extract player names and headshot URLs from Nuxt 3 devalue payload."""
    soup = BeautifulSoup(html, "html.parser")
    nuxt_script = soup.find("script", id="__NUXT_DATA__")
    if not nuxt_script or not nuxt_script.string:
        return {}

    try:
        data = json.loads(nuxt_script.string)
    except (json.JSONDecodeError, TypeError):
        return {}

    def resolve(idx):
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

    roster = {}
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
            if not isinstance(player, dict) or "firstName" not in player:
                continue

            first = resolve(player.get("firstName", -1)) or ""
            last = resolve(player.get("lastName", -1)) or ""
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

            if headshot:
                name_key = f"{first} {last}".lower()
                roster[name_key] = headshot

        if roster:
            break

    return roster


def parse_sidearm_json_roster(base_url, season_year=None):
    """Extract headshots from Sidearm JSON API (/services/responsive-roster.ashx)."""
    roster = {}

    for sport_id in [1, 2]:
        url = f"{base_url}/services/responsive-roster.ashx"
        params = {"sport_id": sport_id}
        if season_year:
            params["year"] = season_year

        data = fetch_json(url, params)
        if not data:
            continue

        players_list = None
        if isinstance(data, list):
            players_list = data
        elif isinstance(data, dict):
            for key in ("players", "roster", "data"):
                if key in data and isinstance(data[key], list):
                    players_list = data[key]
                    break
            if players_list is None and any(isinstance(v, list) for v in data.values()):
                for v in data.values():
                    if isinstance(v, list) and len(v) > 0:
                        players_list = v
                        break

        if not players_list:
            continue

        for p in players_list:
            if not isinstance(p, dict):
                continue

            first = ""
            last = ""
            for fn_key in ("first_name", "firstName", "first", "player_first_name"):
                if fn_key in p and p[fn_key]:
                    first = str(p[fn_key]).strip()
                    break
            for ln_key in ("last_name", "lastName", "last", "player_last_name"):
                if ln_key in p and p[ln_key]:
                    last = str(p[ln_key]).strip()
                    break

            if not first or not last:
                full = p.get("full_name") or p.get("name") or p.get("player_name") or ""
                if "," in full:
                    parts = full.split(",", 1)
                    last = parts[0].strip()
                    first = parts[1].strip()
                elif full:
                    parts = full.split(None, 1)
                    first = parts[0] if parts else ""
                    last = parts[1] if len(parts) > 1 else ""

            if not first or not last:
                continue

            # Look for headshot URL in common fields
            headshot = None
            for field in ("image", "headshot", "photo", "player_image", "profile_image",
                          "roster_image", "thumbnail", "headshot_url", "photo_url", "image_url"):
                if field in p:
                    val = p[field]
                    if val and isinstance(val, str) and val.strip():
                        headshot = val.strip()
                        if headshot.startswith("/") and not headshot.startswith("//"):
                            headshot = urljoin(base_url, headshot)
                        elif headshot.startswith("//"):
                            headshot = "https:" + headshot
                        break

            if headshot:
                name_key = f"{first} {last}".lower()
                roster[name_key] = headshot

        if roster:
            break

    return roster


def parse_sidearm_html_roster(html, base_url=""):
    """Extract headshot URLs from older Sidearm HTML roster pages."""
    soup = BeautifulSoup(html, "html.parser")
    roster = {}

    # Older Sidearm: <li class="sidearm-roster-player">
    cards = soup.find_all("li", class_=re.compile(r"sidearm-roster-player(?!s)", re.I))

    # Newer non-Nuxt: <div class="roster-card"> etc.
    if not cards:
        cards = soup.find_all(["div", "article", "li"], class_=re.compile(r"roster.*card|card.*roster|roster-player", re.I))

    for card in cards:
        # Find player name — try multiple strategies
        name = ""

        # Strategy 1: element with name/player class
        name_elem = card.find(["h3", "h2", "a"], class_=re.compile(r"name|player", re.I))
        if name_elem:
            name = name_elem.get_text(strip=True)

        # Strategy 2: find <a> tags with /roster/ href that have actual text
        if not name or len(name) < 3:
            for a_tag in card.find_all("a", href=re.compile(r"/roster/")):
                txt = a_tag.get_text(strip=True)
                if txt and len(txt) >= 3 and txt.lower() != "full bio":
                    name = txt
                    break

        if not name or len(name) < 3:
            continue

        # Find headshot image
        img = card.find("img")
        if not img:
            continue

        src = img.get("data-src") or img.get("src") or ""
        if not src or "placeholder" in src.lower() or "default" in src.lower() or src.startswith("data:"):
            continue

        if src.startswith("//"):
            src = "https:" + src
        elif src.startswith("/"):
            src = base_url.rstrip("/") + src

        # Parse name (could be "First Last" or "Last, First")
        if "," in name:
            parts = name.split(",", 1)
            first = parts[1].strip()
            last = parts[0].strip()
        else:
            parts = name.split(None, 1)
            first = parts[0] if len(parts) >= 1 else name
            last = parts[1] if len(parts) >= 2 else ""

        if first and last:
            name_key = f"{first} {last}".lower()
            roster[name_key] = src

    return roster


def parse_prestoports_roster(html, base_url=""):
    """Extract headshot URLs from PrestoSports roster/lineup pages."""
    soup = BeautifulSoup(html, "html.parser")
    roster = {}

    # PrestoSports uses tables; headshots may be in rows
    for tr in soup.find_all("tr"):
        img = tr.find("img")
        link = tr.find("a", href=re.compile(r"/players/"))
        if not link:
            continue

        name = link.get_text(strip=True)
        if not name or len(name) < 3:
            continue

        if img:
            src = img.get("data-src") or img.get("src") or ""
            if src and "placeholder" not in src.lower() and not src.startswith("data:"):
                if src.startswith("//"):
                    src = "https:" + src
                elif src.startswith("/"):
                    src = base_url.rstrip("/") + src

                parts = name.split(None, 1)
                first = parts[0] if len(parts) >= 1 else name
                last = parts[1] if len(parts) >= 2 else ""
                if first and last:
                    roster[f"{first} {last}".lower()] = src

    return roster


def scrape_headshots_sidearm(base_url, sport_path="baseball"):
    """Scrape a Sidearm-powered roster page for headshots. Tries JSON API, Nuxt, and HTML."""
    # Try JSON API first (works for many Sidearm sites)
    headshots = parse_sidearm_json_roster(base_url)
    if headshots:
        return headshots

    # Try roster HTML page
    roster_url = f"{base_url}/sports/{sport_path}/roster"
    html = fetch_page(roster_url)
    if not html:
        return {}

    # Try Nuxt payload (modern Sidearm / Vue)
    headshots = parse_nuxt_roster(html, base_url)
    if headshots:
        return headshots

    # Try older Sidearm HTML
    headshots = parse_sidearm_html_roster(html, base_url)
    return headshots


def scrape_headshots_presto(base_url, sport_path="bsb"):
    """Scrape a PrestoSports roster page for headshots."""
    roster_url = f"{base_url}/sports/{sport_path}/roster"
    html = fetch_page(roster_url)
    if not html:
        return {}
    return parse_prestoports_roster(html, base_url)


def scrape_headshots_nwac(team_slug):
    """Scrape an NWAC team's roster page for headshots."""
    # Try current season and previous
    import datetime
    year = datetime.datetime.now().year
    # NWAC uses academic year format: "2025-26"
    for y in [year, year - 1]:
        season_str = f"{y}-{str(y+1)[-2:]}"
        roster_url = f"{NWAC_BASE_URL}/sports/bsb/{season_str}/teams/{team_slug}?view=lineup&r=0&pos=h"
        html = fetch_page(roster_url)
        if html:
            headshots = parse_prestoports_roster(html, NWAC_BASE_URL)
            if headshots:
                return headshots
    return {}


def backfill_all(division=None, team_filter=None):
    """Backfill headshot URLs for all teams."""

    with get_connection() as conn:
        cur = conn.cursor()

        # Ensure column exists
        try:
            cur.execute("ALTER TABLE players ADD COLUMN headshot_url TEXT")
            conn.commit()
            logger.info("Added headshot_url column")
        except Exception:
            conn.rollback()

        # Get all teams with their base URLs
        query = """
            SELECT t.id, t.short_name, t.name, d.level as division
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE t.is_active = 1
        """
        params = []
        if division:
            query += " AND d.level = %s"
            params.append(division)
        if team_filter:
            query += " AND t.short_name = %s"
            params.append(team_filter)
        query += " ORDER BY d.level, t.short_name"

        cur.execute(query, params)
        teams = cur.fetchall()

        total_updated = 0
        total_teams = 0
        teams_with_headshots = 0
        skipped_teams = []

        for team in teams:
            team_id = team["id"]
            short_name = team["short_name"]
            div = team["division"]

            headshots = {}

            # Check if it's an NWAC team
            if short_name in NWAC_TEAMS:
                slug = NWAC_TEAMS[short_name]
                logger.info(f"  [{div}] {short_name} (NWAC / {slug})...")
                headshots = scrape_headshots_nwac(slug)

            # Check if it's a known Sidearm/Presto team
            elif short_name in ALL_TEAMS:
                base_url, sport_path, platform = ALL_TEAMS[short_name]
                logger.info(f"  [{div}] {short_name} ({base_url})...")

                if platform == "sidearm":
                    headshots = scrape_headshots_sidearm(base_url, sport_path)
                elif platform == "presto":
                    headshots = scrape_headshots_presto(base_url, sport_path)

            else:
                skipped_teams.append(f"{short_name} ({div})")
                continue

            total_teams += 1

            if not headshots:
                logger.info(f"    No headshots found")
                continue

            teams_with_headshots += 1
            team_updated = 0

            # Match headshots to players in database
            cur.execute(
                "SELECT id, first_name, last_name FROM players WHERE team_id = %s",
                (team_id,),
            )
            players = cur.fetchall()

            for p in players:
                first = p["first_name"] or ""
                last = p["last_name"] or ""
                name_key = f"{first} {last}".lower()

                url = headshots.get(name_key)
                if not url:
                    # Try reversed
                    url = headshots.get(f"{last} {first}".lower())

                if url:
                    cur.execute(
                        "UPDATE players SET headshot_url = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s AND (headshot_url IS NULL OR headshot_url = '')",
                        (url, p["id"]),
                    )
                    if cur.rowcount > 0:
                        team_updated += 1

            conn.commit()
            total_updated += team_updated
            logger.info(f"    Found {len(headshots)} headshots, updated {team_updated} players")

            # Be polite to servers
            time.sleep(0.5)

        logger.info(f"\n{'='*60}")
        logger.info(f"HEADSHOT BACKFILL COMPLETE")
        logger.info(f"  Teams processed: {total_teams}")
        logger.info(f"  Teams with headshots: {teams_with_headshots}")
        logger.info(f"  Players updated: {total_updated}")
        if skipped_teams:
            logger.info(f"  Teams skipped (no URL mapping): {', '.join(skipped_teams)}")
        logger.info(f"{'='*60}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill player headshot URLs")
    parser.add_argument("--division", help="Only process this division (e.g., D1)")
    parser.add_argument("--team", help="Only process this team (e.g., Oregon)")
    args = parser.parse_args()
    backfill_all(division=args.division, team_filter=args.team)
