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
from pathlib import Path

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
from app.models.database import get_connection

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("scrape_records")

PROJECT_ROOT = Path(__file__).parent.parent

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
        if not rows:
            continue

        # ── Find header row and identify column indices ──
        header_row = rows[0]
        header_cells = header_row.find_all(["td", "th"])
        headers = [c.get_text(strip=True).lower() for c in header_cells]

        # Find the column indices for conference and overall records
        conf_idx = None
        overall_idx = None
        for i, h in enumerate(headers):
            if h in ("conf", "conference", "ccc", "wcc", "gnac", "nwc", "league"):
                conf_idx = i
            elif h == "overall":
                overall_idx = i

        for row in rows[1:]:
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

            # If we found header indices, use them directly
            conf_rec = None
            overall_rec = None
            if conf_idx is not None and conf_idx < len(cells):
                conf_rec = parse_record(cells[conf_idx].get_text(strip=True))
            if overall_idx is not None and overall_idx < len(cells):
                overall_rec = parse_record(cells[overall_idx].get_text(strip=True))

            # Fallback: collect first two W-L patterns (conf first, overall second)
            if not conf_rec or not overall_rec:
                found = []
                for cell in cells:
                    text = cell.get_text(strip=True)
                    rec = parse_record(text)
                    if rec:
                        found.append(rec)
                if found:
                    if not conf_rec:
                        conf_rec = found[0]
                    if not overall_rec and len(found) >= 2:
                        overall_rec = found[1]
                    elif not overall_rec:
                        overall_rec = found[0]

            if conf_rec or overall_rec:
                records[team_name] = {
                    "conf": conf_rec or (0, 0),
                    "overall": overall_rec or conf_rec or (0, 0),
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
                    "overall": found[1] if len(found) >= 2 else found[0],
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

    # Method 1: Look for structured record elements (newer Sidearm sites like Oregon)
    # These have elements with class containing "record" and text like "OverallWins22Losses5"
    record_el = soup.find(class_=re.compile(r'schedule-record', re.I))
    if record_el:
        rec_text = record_el.get_text()
        # Pattern: "OverallWins22Losses5" or "Overall Wins 22 Losses 5"
        om = re.search(r'overall\s*wins?\s*(\d+)\s*loss(?:es)?\s*(\d+)', rec_text, re.I)
        if om:
            overall = (int(om.group(1)), int(om.group(2)))
        cm = re.search(r'conf\s*wins?\s*(\d+)\s*loss(?:es)?\s*(\d+)', rec_text, re.I)
        if cm:
            conference = (int(cm.group(1)), int(cm.group(2)))

    # Method 2: Plain text "Overall: 23-5" or "Overall 23-5" (older Sidearm sites)
    if not overall:
        text = soup.get_text()
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
    # D1 — PNW
    "gonzaga": "Gonzaga", "portland": "Portland", "seattle": "Seattle U",
    "seattle u": "Seattle U", "washington": "UW", "oregon state": "Oregon St.",
    "oregon st.": "Oregon St.", "oregon": "Oregon", "washington state": "Wash. St.",
    "washington st.": "Wash. St.",
    # D1 — Big Ten (alias from bigten.org → DB short_name)
    "ucla": "UCLA", "usc": "USC", "neb": "Nebraska", "ore": "Oregon",
    "pur": "Purdue", "osu": "Ohio St.", "wash": "UW", "ill": "Illinois",
    "iowa": "Iowa", "mich": "Michigan", "nu": "Northwestern", "ru": "Rutgers",
    "ind": "Indiana", "msu": "Michigan St.", "minn": "Minnesota",
    "psu": "Penn St.", "md": "Maryland",
    "nebraska": "Nebraska", "purdue": "Purdue", "ohio state": "Ohio St.",
    "ohio st.": "Ohio St.", "illinois": "Illinois", "iowa": "Iowa",
    "michigan state": "Michigan St.", "michigan st.": "Michigan St.",
    "michigan": "Michigan", "northwestern": "Northwestern", "rutgers": "Rutgers",
    "indiana": "Indiana", "minnesota": "Minnesota", "penn state": "Penn St.",
    "penn st.": "Penn St.", "maryland": "Maryland",
    # D1 — MWC
    "air force": "Air Force", "fresno state": "Fresno St.", "fresno st.": "Fresno St.",
    "grand canyon": "Grand Canyon", "nevada": "Nevada", "new mexico": "New Mexico",
    "san jose state": "San Jose St.", "san jose st.": "San Jose St.",
    "sdsu": "SDSU", "san diego state": "SDSU", "unlv": "UNLV",
    "utah state": "Utah St.", "utah st.": "Utah St.",
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
    "eastern oregon": "EOU", "eastern oregon university": "EOU",
    "lewis-clark state": "LCSC", "lcsc": "LCSC",
    "multnomah": "Multnomah", "oregon tech": "OIT", "oregon institute of technology": "OIT",
    "southern oregon": "SOU", "southern oregon university": "SOU",
    "ubc": "UBC", "british columbia": "UBC",
    "warner pacific": "Warner Pacific", "walla walla": "Walla Walla",
    # NWAC
    "bellevue": "Bellevue", "big bend": "Big Bend", "blue mountain": "Blue Mountain",
    "centralia": "Centralia", "chemeketa": "Chemeketa", "clackamas": "Clackamas",
    "clark": "Clark", "columbia basin": "Columbia Basin", "douglas": "Douglas",
    "edmonds": "Edmonds", "everett": "Everett", "green river": "GRC",
    "grays harbor": "Grays Harbor", "lane": "Lane", "linn-benton": "Linn-Benton",
    "lower columbia": "Lower Columbia", "mt. hood": "Mt. Hood", "mt hood": "Mt. Hood", "olympic": "Olympic",
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

    # Direct short_name match (exact)
    for t in db_teams:
        if t["short_name"].lower() == name_lower:
            return t

    # Direct full name match (exact)
    for t in db_teams:
        if t["name"].lower() == name_lower:
            return t

    # Alias match — try longest aliases first so "central washington" beats "washington"
    sorted_aliases = sorted(NAME_ALIASES.items(), key=lambda x: len(x[0]), reverse=True)
    for alias, short in sorted_aliases:
        if alias == name_lower:
            # Exact alias match
            for t in db_teams:
                if t["short_name"] == short:
                    return t

    # Alias substring match — only check if alias is IN the scraped name (not the reverse)
    for alias, short in sorted_aliases:
        if alias in name_lower:
            for t in db_teams:
                if t["short_name"] == short:
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

# MWC teams — scraped individually via Sidearm schedule pages
MWC_TEAMS = {
    "Air Force": "https://goairforcefalcons.com",
    "Fresno St.": "https://gobulldogs.com",
    "Grand Canyon": "https://gculopes.com",
    "Nevada": "https://nevadawolfpack.com",
    "New Mexico": "https://golobos.com",
    "San Jose St.": "https://sjsuspartans.com",
    "SDSU": "https://goaztecs.com",
    "UNLV": "https://unlvrebels.com",
    "Utah St.": "https://utahstateaggies.com",
}


def scrape_bigten_standings(season):
    """
    Scrape Big Ten baseball standings from bigten.org.

    The site uses Next.js with all data embedded in __NEXT_DATA__.
    Returns dict of team_alias -> {"overall": (w, l), "conf": (cw, cl)}
    """
    url = f"https://bigten.org/base/standings/{season}/"
    html = fetch(url)
    if not html:
        return {}

    soup = BeautifulSoup(html, "html.parser")
    nd = soup.find("script", id="__NEXT_DATA__")
    if not nd:
        logger.warning("Big Ten: no __NEXT_DATA__ found")
        return {}

    import json as _json
    try:
        data = _json.loads(nd.string)
    except Exception as e:
        logger.warning(f"Big Ten: failed to parse __NEXT_DATA__: {e}")
        return {}

    fallback = data.get("props", {}).get("pageProps", {}).get("fallback", {})
    standings_data = None
    for key in fallback:
        if "standings" in key:
            standings_data = fallback[key]
            break

    if not standings_data:
        logger.warning("Big Ten: no standings data in fallback")
        return {}

    results = {}
    for team in standings_data.get("data", []):
        alias = team.get("alias", "")
        # Flatten the data list into a dict
        d = {}
        for item in team.get("data", []):
            d.update(item)

        conf_record = d.get("conf_record", "")
        ovr_record = d.get("ovr_record", "")

        conf = parse_record(conf_record) if conf_record else (0, 0)
        ovr = parse_record(ovr_record) if ovr_record else (0, 0)

        if ovr:
            results[alias] = {"overall": ovr, "conf": conf or (0, 0)}

    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", type=int, default=2026)
    args = parser.parse_args()
    season = args.season

    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute("""
            SELECT t.id, t.short_name, t.name, c.division_id
            FROM teams t JOIN conferences c ON t.conference_id = c.id
            WHERE t.is_active = 1
        """)
        db_teams = [{"id": row["id"], "short_name": row["short_name"], "name": row["name"], "division_id": row["division_id"]} for row in cur.fetchall()]

        saved = 0
        not_found = []

        def save(team_id, short, w, l, cw, cl):
            nonlocal saved
            cur.execute("""
                INSERT INTO team_season_stats (team_id, season, wins, losses, conference_wins, conference_losses)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT(team_id, season) DO UPDATE SET
                    wins=excluded.wins, losses=excluded.losses,
                    conference_wins=excluded.conference_wins, conference_losses=excluded.conference_losses
            """, (team_id, season, w, l, cw, cl))
            saved += 1
            logger.info(f"  Saved {short}: {w}-{l} ({cw}-{cl})")

        # ── Step 1: Conference standings pages (fast, gets most teams) ──
        # IMPORTANT: These pages only show the CURRENT season standings.
        # They do NOT support historical seasons, so we must skip them
        # when scraping a past season to avoid inserting fake data.

        from datetime import date as _date
        _current_year = _date.today().year

        standings_sources = [
            ("WCC", "https://wccsports.com/standings.aspx?path=baseball"),
            ("GNAC", "https://gnacsports.com/standings.aspx?path=baseball"),
            ("NWC", "https://nwcsports.com/standings.aspx?path=baseball"),
            ("CCC", "https://cascadeconference.org/standings.aspx?path=baseball"),
        ]

        if season != _current_year:
            logger.info(f"\n--- Skipping conference standings (only show current year, requested {season}) ---")
        else:
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

        # ── Step 2b: Big Ten standings (from bigten.org) ──

        if season != _current_year:
            logger.info(f"\n--- Skipping Big Ten standings (only show current year) ---")
        else:
            logger.info(f"\n--- Fetching Big Ten standings ---")
            bigten_records = scrape_bigten_standings(season)
            logger.info(f"  Found {len(bigten_records)} teams")

            for team_alias, data in bigten_records.items():
                matched = match_team(team_alias, db_teams)
                if matched:
                    ov = data.get("overall", (0, 0))
                    cf = data.get("conf", (0, 0))
                    save(matched["id"], matched["short_name"], ov[0], ov[1], cf[0], cf[1])
                else:
                    logger.warning(f"  Could not match Big Ten team: {team_alias}")

        # ── Step 2c: MWC team pages (individual Sidearm schedule pages) ──

        if season != _current_year:
            logger.info(f"\n--- Skipping MWC team pages (only show current year) ---")
        else:
            logger.info(f"\n--- Fetching MWC team records ---")
            for short, base_url in MWC_TEAMS.items():
                team = next((t for t in db_teams if t["short_name"] == short), None)
                if not team:
                    logger.warning(f"  MWC team not in DB: {short}")
                    continue

                logger.info(f"  Trying {short}...")
                overall, conference = scrape_d1_team(base_url)
                if overall:
                    cf = conference or (0, 0)
                    save(team["id"], short, overall[0], overall[1], cf[0], cf[1])
                else:
                    logger.warning(f"  No record found for {short}")

        # ── Step 3: D1 individual team pages (only for PNW teams not yet found) ──
        # These pages also only show the current season.

        if season != _current_year:
            logger.info(f"\n--- Skipping D1 team pages (only show current year, requested {season}) ---")
        else:
            cur.execute(
                "SELECT team_id FROM team_season_stats WHERE season = %s AND (wins > 0 OR losses > 0)", (season,)
            )
            existing = cur.fetchall()
            found_ids = {r["team_id"] for r in existing}

            logger.info(f"\n--- Checking D1 PNW team pages for missing or 0-0 teams ---")
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
        cur.execute(
            "SELECT team_id FROM team_season_stats WHERE season = %s", (season,)
        )
        all_saved = cur.fetchall()
        saved_ids = {r["team_id"] for r in all_saved}
        missing = [t["short_name"] for t in db_teams if t["id"] not in saved_ids]

    print(f"\n{'='*50}")
    print(f"Done! {len(saved_ids)}/{len(db_teams)} teams have records.")
    if missing:
        print(f"\nStill missing ({len(missing)}): {', '.join(missing)}")
        print("\nTo manually add records, run:")
        print('  python3 scripts/add_record.py --team "TeamName" --record 20-5 --conf 12-3')


if __name__ == "__main__":
    main()
