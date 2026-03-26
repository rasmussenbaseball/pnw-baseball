#!/usr/bin/env python3
"""
Scrape team W-L records from conference standings pages.
Much faster version — 1 retry, short delays, known-good URLs only.

Usage:
    cd pnw-baseball
    python3 scripts/scrape_records.py --season 2026
"""

import sys
import os
import time
import random
import argparse
import logging
import re
import sqlite3
from pathlib import Path

import requests
from bs4 import BeautifulSoup

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("scrape_records")

PROJECT_ROOT = Path(__file__).parent.parent
DB_PATH = PROJECT_ROOT / "backend" / "data" / "pnw_baseball.db"

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
})


def fetch(url):
    """Fetch URL — single attempt, short timeout."""
    try:
        time.sleep(random.uniform(0.3, 0.8))
        resp = session.get(url, timeout=15)
        if resp.status_code == 200:
            return resp.text
        logger.warning(f"  {resp.status_code} for {url}")
    except Exception as e:
        logger.warning(f"  Error: {e}")
    return None


def parse_record(text):
    """Parse '23-5' or '15-3-1' into (wins, losses)."""
    m = re.match(r'(\d+)\s*-\s*(\d+)', text.strip())
    return (int(m.group(1)), int(m.group(2))) if m else None


# ─── Conference standings scrapers (known-good URL patterns) ───

def scrape_sidearm_standings(url):
    """Scrape standings from Sidearm-hosted conference sites (WCC, GNAC, NWC, CCC)."""
    html = fetch(url)
    if not html:
        return {}

    soup = BeautifulSoup(html, "html.parser")
    records = {}

    # Sidearm standings tables have a consistent structure
    tables = soup.find_all("table")
    for table in tables:
        rows = table.find_all("tr")
        for row in rows:
            cells = row.find_all(["td", "th"])
            if len(cells) < 4:
                continue

            # Find the team name (usually in a link)
            link = row.find("a")
            if not link:
                continue
            team_name = link.get_text(strip=True)
            if not team_name or len(team_name) < 2:
                continue

            # Collect all W-L patterns from cells
            found = []
            for cell in cells:
                text = cell.get_text(strip=True)
                rec = parse_record(text)
                if rec:
                    found.append(rec)

            if found:
                # Sidearm standings: first record = conference, last = overall (usually)
                records[team_name] = {
                    "conf": found[0],
                    "overall": found[-1] if len(found) >= 2 else found[0],
                }

    return records


def scrape_nwac_standings(season):
    """Scrape NWAC standings from nwacstats.org (Presto Sports)."""
    records = {}
    url = f"https://nwacstats.org/sports/bsb/{season-1}-{str(season)[-2:]}/overall_standings"
    html = fetch(url)
    if not html:
        # Try alternate URL
        html = fetch(f"https://nwacstats.org/sports/bsb/{season-1}-{str(season)[-2:]}/conf_standings")
    if not html:
        return records

    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")
    for table in tables:
        rows = table.find_all("tr")
        for row in rows:
            cells = row.find_all(["td", "th"])
            if len(cells) < 3:
                continue
            link = row.find("a")
            if not link:
                continue
            team_name = link.get_text(strip=True)

            found = []
            for cell in cells:
                rec = parse_record(cell.get_text(strip=True))
                if rec:
                    found.append(rec)

            if found and team_name:
                records[team_name] = {
                    "conf": found[0],
                    "overall": found[-1] if len(found) >= 2 else found[0],
                }

    return records


def scrape_d1_team(base_url):
    """Scrape record from an individual D1 Sidearm team schedule page."""
    # Sidearm schedule pages show the record in a specific element
    html = fetch(f"{base_url}/sports/baseball/schedule")
    if not html:
        return None, None

    soup = BeautifulSoup(html, "html.parser")
    overall = None
    conference = None

    # Look for record text anywhere on the page
    text = soup.get_text()
    # Pattern: "Overall: 23-5" or "Overall 23-5"
    om = re.search(r'overall\s*[:\s]\s*(\d+-\d+)', text, re.I)
    if om:
        overall = parse_record(om.group(1))
    cm = re.search(r'conf(?:erence)?\s*[:\s]\s*(\d+-\d+)', text, re.I)
    if cm:
        conference = parse_record(cm.group(1))

    return overall, conference


# ─── Team name matching ───

# Map variations of team names to our DB short_name
NAME_ALIASES = {
    # D1
    "gonzaga": "Gonzaga", "portland": "Portland", "seattle": "Seattle U",
    "seattle u": "Seattle U", "washington": "UW", "oregon state": "Oregon St.",
    "oregon st.": "Oregon St.", "oregon": "Oregon", "washington state": "Wash. St.",
    "washington st.": "Wash. St.",
    # D2 (GNAC)
    "central washington": "CWU", "msu billings": "MSUB", "montana state billings": "MSUB",
    "northwest nazarene": "NNU", "saint martin's": "SMU", "saint martin": "SMU",
    "st. martin's": "SMU", "western oregon": "WOU",
    # D3 (NWC)
    "george fox": "GFU", "lewis & clark": "L&C", "lewis and clark": "L&C",
    "linfield": "Linfield", "pacific lutheran": "PLU", "pacific": "Pacific",
    "puget sound": "UPS", "whitman": "Whitman", "whitworth": "Whitworth",
    "willamette": "Willamette",
    # NAIA (CCC)
    "bushnell": "Bushnell", "college of idaho": "C of I", "corban": "Corban",
    "eastern oregon": "EOU", "lewis-clark state": "LCSC", "lcsc": "LCSC",
    "multnomah": "Multnomah", "oregon tech": "OIT", "southern oregon": "SOU",
    "ubc": "UBC", "british columbia": "UBC",
    "warner pacific": "Warner Pacific", "walla walla": "Walla Walla",
    # NWAC
    "bellevue": "Bellevue", "big bend": "Big Bend", "blue mountain": "Blue Mountain",
    "centralia": "Centralia", "chemeketa": "Chemeketa", "clackamas": "Clackamas",
    "clark": "Clark", "columbia basin": "Columbia Basin", "douglas": "Douglas",
    "edmonds": "Edmonds", "everett": "Everett", "green river": "GRC",
    "grays harbor": "Grays Harbor", "lane": "Lane", "linn-benton": "Linn-Benton",
    "lower columbia": "Lower Columbia", "mt. hood": "Mt. Hood", "olympic": "Olympic",
    "pierce": "Pierce", "shoreline": "Shoreline", "skagit valley": "Skagit",
    "skagit": "Skagit", "spokane": "Spokane",
    "spokane falls": "Spokane", "sw oregon": "SW Oregon",
    "southwestern oregon": "SW Oregon", "tacoma": "Tacoma",
    "treasure valley": "Treasure Valley", "umpqua": "Umpqua",
    "wenatchee valley": "Wenatchee Valley", "yakima valley": "Yakima Valley",
}


def match_team(name, db_teams):
    """Try to match a scraped team name to a DB team."""
    name_lower = name.lower().strip()

    # Direct short_name match
    for t in db_teams:
        if t["short_name"].lower() == name_lower:
            return t

    # Alias match
    for alias, short in NAME_ALIASES.items():
        if alias in name_lower or name_lower in alias:
            for t in db_teams:
                if t["short_name"] == short:
                    return t

    # Fuzzy: check if any DB team name is contained in the scraped name
    for t in db_teams:
        if t["short_name"].lower() in name_lower or name_lower in t["name"].lower():
            return t

    return None


# ─── D1 teams with their base URLs ───

D1_TEAMS = {
    "UW": "https://gohuskies.com",
    "Oregon": "https://goducks.com",
    "Oregon St.": "https://osubeavers.com",
    "Wash. St.": "https://wsucougars.com",
    "Gonzaga": "https://gozags.com",
    "Portland": "https://portlandpilots.com",
    "Seattle U": "https://goseattleu.com",
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", type=int, default=2026)
    args = parser.parse_args()
    season = args.season

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    db_teams = conn.execute("""
        SELECT t.id, t.short_name, t.name, c.division_id
        FROM teams t JOIN conferences c ON t.conference_id = c.id
        WHERE t.is_active = 1
    """).fetchall()

    saved = 0
    not_found = []

    def save(team_id, short, w, l, cw, cl):
        nonlocal saved
        conn.execute("""
            INSERT INTO team_season_stats (team_id, season, wins, losses, conference_wins, conference_losses)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(team_id, season) DO UPDATE SET
                wins=excluded.wins, losses=excluded.losses,
                conference_wins=excluded.conference_wins, conference_losses=excluded.conference_losses
        """, (team_id, season, w, l, cw, cl))
        conn.commit()
        saved += 1
        logger.info(f"  Saved {short}: {w}-{l} ({cw}-{cl})")

    # ── Step 1: Conference standings pages (fast, gets most teams) ──

    standings_sources = [
        ("WCC", "https://wccsports.com/standings.aspx?path=baseball"),
        ("GNAC", "https://gnacsports.com/standings.aspx?path=baseball"),
        ("NWC", "https://nwcsports.com/standings.aspx?path=baseball"),
        ("CCC", "https://cascadeconference.org/standings.aspx?path=baseball"),
    ]

    for conf_name, url in standings_sources:
        logger.info(f"\n--- Fetching {conf_name} standings ---")
        records = scrape_sidearm_standings(url)
        logger.info(f"  Found {len(records)} teams")

        for team_name, data in records.items():
            matched = match_team(team_name, db_teams)
            if matched:
                ov = data.get("overall", (0, 0))
                cf = data.get("conf", (0, 0))
                save(matched["id"], matched["short_name"], ov[0], ov[1], cf[0], cf[1])
            else:
                logger.warning(f"  Could not match: {team_name}")

    # ── Step 2: NWAC standings ──

    logger.info(f"\n--- Fetching NWAC standings ---")
    nwac_records = scrape_nwac_standings(season)
    logger.info(f"  Found {len(nwac_records)} teams")

    for team_name, data in nwac_records.items():
        matched = match_team(team_name, db_teams)
        if matched:
            ov = data.get("overall", (0, 0))
            cf = data.get("conf") or (0, 0)
            save(matched["id"], matched["short_name"], ov[0], ov[1], cf[0], cf[1])
        else:
            logger.warning(f"  Could not match NWAC team: {team_name}")

    # ── Step 3: D1 individual team pages (only for teams not yet found) ──

    found_ids = set()
    existing = conn.execute(
        "SELECT team_id FROM team_season_stats WHERE season = ?", (season,)
    ).fetchall()
    found_ids = {r["team_id"] for r in existing}

    logger.info(f"\n--- Checking D1 team pages for missing teams ---")
    for short, base_url in D1_TEAMS.items():
        team = next((t for t in db_teams if t["short_name"] == short), None)
        if not team or team["id"] in found_ids:
            continue

        logger.info(f"  Trying {short}...")
        overall, conference = scrape_d1_team(base_url)
        if overall:
            cf = conference or (0, 0)
            save(team["id"], short, overall[0], overall[1], cf[0], cf[1])
        else:
            not_found.append(short)
            logger.warning(f"  No record found for {short}")

    # ── Summary ──

    # Check what's still missing
    all_saved = conn.execute(
        "SELECT team_id FROM team_season_stats WHERE season = ?", (season,)
    ).fetchall()
    saved_ids = {r["team_id"] for r in all_saved}
    missing = [t["short_name"] for t in db_teams if t["id"] not in saved_ids]

    conn.close()

    print(f"\n{'='*50}")
    print(f"Done! {len(saved_ids)}/{len(db_teams)} teams have records.")
    if missing:
        print(f"\nStill missing ({len(missing)}): {', '.join(missing)}")
        print("\nTo manually add records, run:")
        print('  python3 scripts/add_record.py --team "TeamName" --record 20-5 --conf 12-3')


if __name__ == "__main__":
    main()
