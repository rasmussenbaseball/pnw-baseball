#!/usr/bin/env python3
"""
NWAC Historical Scraper (Playwright-based)
==========================================

Uses a visible browser to bypass the AWS WAF "Human Verification" challenge.
You solve the CAPTCHA once, then the script fetches all team stats automatically.

Runs LOCALLY on your Mac and writes directly to the Supabase database.

Usage:
    export DATABASE_URL='postgresql://...'  # Set your Supabase connection string
    cd pnw-baseball
    PYTHONPATH=backend python3 scripts/scrape_nwac_historical.py --season 2018-19
    PYTHONPATH=backend python3 scripts/scrape_nwac_historical.py --all
"""

import sys
import os
import time
import argparse
import logging
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup

from app.models.database import get_connection
from app.stats.advanced import (
    BattingLine, PitchingLine,
    compute_batting_advanced, compute_pitching_advanced, compute_college_war,
    normalize_position, DEFAULT_WEIGHTS,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("scrape_nwac_historical")

# ============================================================
# Constants (same as scrape_nwac.py)
# ============================================================

BASE_URL = "https://nwacsports.com"

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

# Seasons to scrape with --all
ALL_SEASONS = [
    "2018-19",
    "2019-20",  # COVID — may have partial/no data
    "2020-21",  # COVID — season likely cancelled
    "2017-18",
    "2016-17",
    "2015-16",
]


# ============================================================
# Helpers
# ============================================================

def safe_int(val, default=0):
    if val is None or val == "" or val == "-" or val == "---":
        return default
    try:
        return int(str(val).strip().replace(",", ""))
    except (ValueError, TypeError):
        return default


def safe_float(val, default=0.0):
    if val is None or val == "" or val == "-" or val == "---":
        return default
    try:
        return float(str(val).strip())
    except (ValueError, TypeError):
        return default


def parse_full_name(name_str):
    if not name_str:
        return "", ""
    parts = name_str.strip().split(None, 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return name_str, ""


def normalize_year(year_str):
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
    if yl in ("so", "sophomore", "soph"):
        return "So"
    if yl in ("fr", "freshman", "fresh"):
        return "Fr"
    return None


def parse_template_table(html):
    """Parse the table from the brief-category-template endpoint."""
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")
    if not tables:
        return []

    table = tables[0]
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
        return []

    stat_headers = raw_headers[4:]
    rows = []
    tbody = table.find("tbody")
    trs = tbody.find_all("tr") if tbody else table.find_all("tr")[1:]

    for tr in trs:
        cells = tr.find_all(["td", "th"])
        if len(cells) < 5:
            continue
        row = {}
        row["jersey"] = cells[0].get_text(strip=True)
        name_cell = cells[1]
        name_link = name_cell.find("a")
        if name_link:
            row["name"] = " ".join(name_link.get_text(strip=True).split())
        else:
            row["name"] = " ".join(name_cell.get_text(strip=True).split())
        row["year"] = cells[2].get_text(strip=True)
        row["pos"] = cells[3].get_text(strip=True)
        for i, header in enumerate(stat_headers):
            cell_idx = i + 4
            if cell_idx < len(cells):
                row[header] = cells[cell_idx].get_text(strip=True)
        if row.get("name"):
            rows.append(row)
    return rows


# ============================================================
# Playwright-based fetching
# ============================================================

class PlaywrightFetcher:
    """Uses a real browser to fetch pages, bypassing the AWS WAF."""

    def __init__(self):
        self.pw = None
        self.browser = None
        self.context = None
        self.page = None
        self.last_request_time = 0

    def start(self):
        """Launch a visible browser."""
        self.pw = sync_playwright().start()
        self.browser = self.pw.chromium.launch(headless=False)
        self.context = self.browser.new_context(
            viewport={"width": 1400, "height": 900},
            locale="en-US",
        )
        self.page = self.context.new_page()
        logger.info("Browser launched")

    def solve_captcha(self, season_str):
        """Navigate to NWAC and wait for user to solve the CAPTCHA."""
        url = f"{BASE_URL}/sports/bsb/{season_str}"
        logger.info(f"Navigating to {url} — please solve the CAPTCHA if prompted...")
        self.page.goto(url, wait_until="domcontentloaded", timeout=60000)

        # Wait for the WAF challenge to be solved (title changes)
        attempt = 0
        while True:
            title = self.page.title()
            if "human verification" not in title.lower() and "challenge" not in title.lower():
                logger.info(f"CAPTCHA solved! Page title: {title}")
                break
            attempt += 1
            if attempt % 10 == 0:
                logger.info(f"  Still waiting for CAPTCHA... ({attempt}s)")
            time.sleep(1)

        time.sleep(2)  # let cookies settle
        cookies = self.context.cookies()
        logger.info(f"Session established with {len(cookies)} cookies")

    def fetch(self, url):
        """Fetch a URL using the browser. Returns HTML string or None."""
        elapsed = time.time() - self.last_request_time
        delay = 2.0  # polite delay between requests
        if elapsed < delay:
            time.sleep(delay - elapsed)

        try:
            self.page.goto(url, wait_until="domcontentloaded", timeout=30000)
            self.last_request_time = time.time()

            # Brief wait for content
            time.sleep(0.5)
            html = self.page.content()

            has_table = "<table" in html
            logger.info(f"Fetched {url} ({len(html)} bytes, has_table={has_table})")

            # Check if we hit WAF again
            if "human verification" in html.lower() and not has_table:
                logger.warning("Hit WAF again — waiting for re-solve...")
                while True:
                    title = self.page.title()
                    if "human verification" not in title.lower():
                        break
                    time.sleep(1)
                html = self.page.content()

            return html
        except Exception as e:
            logger.error(f"Failed to fetch {url}: {e}")
            return None

    def close(self):
        if self.browser:
            self.browser.close()
        if self.pw:
            self.pw.stop()


# ============================================================
# Database operations
# ============================================================

def get_team_id_map():
    """Build NWAC short_name -> team_id map."""
    short_to_id = {}
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT t.id, t.short_name
            FROM teams t
            JOIN conferences c ON t.conference_id = c.id
            JOIN divisions d ON c.division_id = d.id
            WHERE d.level = 'JUCO' AND t.is_active = 1
        """)
        for row in cur.fetchall():
            short_to_id[row["short_name"]] = row["id"]

    logger.info(f"Found {len(short_to_id)} NWAC teams in database")
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
        for field in ["position", "year_in_school", "jersey_number"]:
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
               year_in_school, jersey_number)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (first_name, last_name, team_id,
             kwargs.get("position"), kwargs.get("year_in_school"),
             kwargs.get("jersey_number")),
        )
        cur.execute("SELECT lastval() AS id")
        result = cur.fetchone()
        player_id = result["id"]

    return player_id


# ============================================================
# Main scraping logic
# ============================================================

def scrape_season(fetcher, season_str, season_year):
    """Scrape all NWAC teams for a given season."""
    short_to_id = get_team_id_map()
    if not short_to_id:
        logger.error("No NWAC teams in database!")
        return

    batting_total = 0
    pitching_total = 0

    with get_connection() as conn:
        cur = conn.cursor()

        for db_short, slug in NWAC_TEAM_SLUGS.items():
            team_id = short_to_id.get(db_short)
            if not team_id:
                logger.warning(f"  {db_short} not in database, skipping")
                continue

            logger.info(f"{'='*50}")
            logger.info(f"Scraping {db_short} ({slug})...")

            # --- Batting ---
            bat_url = f"{BASE_URL}/sports/bsb/{season_str}/teams/{slug}?tmpl=brief-category-template&pos=h&r=0"
            bat_html = fetcher.fetch(bat_url)
            batting_rows = parse_template_table(bat_html) if bat_html else []
            logger.info(f"  Batting: {len(batting_rows)} players")

            # --- Extended hitting ---
            ext_url = f"{BASE_URL}/sports/bsb/{season_str}/teams/{slug}?tmpl=brief-category-template&pos=he&r=0"
            ext_html = fetcher.fetch(ext_url)
            ext_rows = parse_template_table(ext_html) if ext_html else []
            logger.info(f"  Extended hitting: {len(ext_rows)} players")

            # --- Pitching ---
            pitch_url = f"{BASE_URL}/sports/bsb/{season_str}/teams/{slug}?tmpl=brief-category-template&pos=p&r=0"
            pitch_html = fetcher.fetch(pitch_url)
            pitching_rows = parse_template_table(pitch_html) if pitch_html else []
            logger.info(f"  Pitching: {len(pitching_rows)} players")

            # Build extended hitting lookup by name
            ext_lookup = {}
            for ext in ext_rows:
                name = ext.get("name", "").strip().lower()
                if name:
                    ext_lookup[name] = ext

            # --- Process batting ---
            for batter in batting_rows:
                try:
                    cur.execute("SAVEPOINT sp_player")

                    full_name = batter.get("name", "").strip()
                    if not full_name:
                        continue
                    first_name, last_name = parse_full_name(full_name)
                    if not last_name:
                        continue

                    raw_year = batter.get("year")
                    year_in_school = normalize_year(raw_year)
                    raw_position = batter.get("pos")
                    norm_pos = normalize_position(raw_position) or "UT"

                    player_id = insert_or_update_player(
                        cur, first_name, last_name, team_id,
                        position=raw_position or None,
                        year_in_school=year_in_school,
                        jersey_number=batter.get("jersey"),
                    )

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

                    ext = ext_lookup.get(full_name.lower(), {})
                    hbp = safe_int(ext.get("hbp"))
                    sf = safe_int(ext.get("sf"))
                    sh = safe_int(ext.get("sh"))
                    pa = safe_int(ext.get("pa"))
                    gidp = safe_int(ext.get("hdp"))

                    if pa == 0 and ab > 0:
                        pa = ab + bb + hbp + sf + sh

                    if ab == 0 and g == 0:
                        continue

                    # Compute advanced stats
                    line = BattingLine(
                        pa=pa, ab=ab, hits=h, doubles=doubles, triples=triples,
                        hr=hr, bb=bb, ibb=0, hbp=hbp, sf=sf, sh=sh, k=k,
                        sb=sb, cs=cs, gidp=gidp,
                    )
                    adv = compute_batting_advanced(line, division_level="JUCO")
                    war_result = compute_college_war(
                        batting=adv, position=norm_pos,
                        plate_appearances=pa, division_level="JUCO",
                    )
                    war = war_result.offensive_war

                    cur.execute("""
                        INSERT INTO batting_stats
                            (player_id, team_id, season, games, plate_appearances, at_bats,
                             runs, hits, doubles, triples, home_runs, rbi, walks, strikeouts,
                             hit_by_pitch, sacrifice_flies, sacrifice_bunts, stolen_bases,
                             caught_stealing, grounded_into_dp,
                             batting_avg, on_base_pct, slugging_pct, ops,
                             woba, wraa, wrc, wrc_plus, iso, babip,
                             bb_pct, k_pct, offensive_war)
                        VALUES
                            (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                             %s, %s, %s, %s, %s, %s,
                             %s, %s, %s, %s,
                             %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (player_id, team_id, season) DO UPDATE SET
                            games=EXCLUDED.games, plate_appearances=EXCLUDED.plate_appearances,
                            at_bats=EXCLUDED.at_bats,
                            runs=EXCLUDED.runs, hits=EXCLUDED.hits,
                            doubles=EXCLUDED.doubles, triples=EXCLUDED.triples,
                            home_runs=EXCLUDED.home_runs, rbi=EXCLUDED.rbi,
                            walks=EXCLUDED.walks, strikeouts=EXCLUDED.strikeouts,
                            hit_by_pitch=EXCLUDED.hit_by_pitch,
                            sacrifice_flies=EXCLUDED.sacrifice_flies,
                            sacrifice_bunts=EXCLUDED.sacrifice_bunts,
                            stolen_bases=EXCLUDED.stolen_bases,
                            caught_stealing=EXCLUDED.caught_stealing,
                            grounded_into_dp=EXCLUDED.grounded_into_dp,
                            batting_avg=EXCLUDED.batting_avg,
                            on_base_pct=EXCLUDED.on_base_pct,
                            slugging_pct=EXCLUDED.slugging_pct,
                            ops=EXCLUDED.ops, woba=EXCLUDED.woba,
                            wraa=EXCLUDED.wraa, wrc=EXCLUDED.wrc,
                            wrc_plus=EXCLUDED.wrc_plus, iso=EXCLUDED.iso,
                            babip=EXCLUDED.babip, bb_pct=EXCLUDED.bb_pct,
                            k_pct=EXCLUDED.k_pct,
                            offensive_war=EXCLUDED.offensive_war,
                            updated_at=CURRENT_TIMESTAMP
                    """, (
                        player_id, team_id, season_year, g, pa, ab, r, h, doubles,
                        triples, hr, rbi, bb, k,
                        hbp, sf, sh, sb, cs, gidp,
                        adv.batting_avg, adv.obp, adv.slg, adv.ops,
                        adv.woba, adv.wraa, adv.wrc,
                        adv.wrc_plus, adv.iso, adv.babip,
                        adv.bb_pct, adv.k_pct, war,
                    ))
                    batting_total += 1

                    cur.execute("RELEASE SAVEPOINT sp_player")

                except Exception as e:
                    logger.error(f"  Error processing batter {batter.get('name')}: {e}")
                    try:
                        cur.execute("ROLLBACK TO SAVEPOINT sp_player")
                    except Exception:
                        pass

            # --- Process pitching ---
            for pitcher in pitching_rows:
                try:
                    cur.execute("SAVEPOINT sp_player")

                    full_name = pitcher.get("name", "").strip()
                    if not full_name:
                        continue
                    first_name, last_name = parse_full_name(full_name)
                    if not last_name:
                        continue

                    raw_year = pitcher.get("year")
                    year_in_school = normalize_year(raw_year)
                    raw_position = pitcher.get("pos") or "P"
                    norm_pos = normalize_position(raw_position) or "P"

                    player_id = insert_or_update_player(
                        cur, first_name, last_name, team_id,
                        position=raw_position,
                        year_in_school=year_in_school,
                        jersey_number=pitcher.get("jersey"),
                    )

                    app = safe_int(pitcher.get("app"))
                    gs = safe_int(pitcher.get("gs"))
                    w = safe_int(pitcher.get("w"))
                    l = safe_int(pitcher.get("l"))
                    sv = safe_int(pitcher.get("sv"))
                    cg = safe_int(pitcher.get("cg"))
                    ip = safe_float(pitcher.get("ip"))
                    p_h = safe_int(pitcher.get("h"))
                    p_r = safe_int(pitcher.get("r"))
                    er = safe_int(pitcher.get("er"))
                    p_bb = safe_int(pitcher.get("bb"))
                    p_k = safe_int(pitcher.get("k"))
                    p_hr = safe_int(pitcher.get("hr"))

                    if ip == 0 and app == 0:
                        continue

                    # Convert IP from baseball format (6.1 = 6 1/3)
                    ip_whole = int(ip)
                    ip_frac = ip - ip_whole
                    ip_thirds = round(ip_frac * 10)
                    outs = ip_whole * 3 + ip_thirds
                    real_ip = outs / 3.0

                    # Estimate batters faced from pitching line
                    p_hbp = safe_int(pitcher.get("hbp", 0))
                    bf = outs + p_h + p_bb + p_hbp

                    era = safe_float(pitcher.get("era"))

                    line = PitchingLine(
                        ip=real_ip, hits=p_h, er=er, bb=p_bb,
                        k=p_k, hr=p_hr, hbp=p_hbp, bf=bf,
                    )
                    adv = compute_pitching_advanced(line, division_level="JUCO")
                    war_result = compute_college_war(
                        pitching=adv, position=norm_pos,
                        innings_pitched=real_ip, division_level="JUCO",
                    )
                    war = war_result.pitching_war

                    whip = (p_h + p_bb) / real_ip if real_ip > 0 else 0

                    cur.execute("""
                        INSERT INTO pitching_stats
                            (player_id, team_id, season, games, games_started,
                             wins, losses, saves, complete_games,
                             innings_pitched, hits_allowed, runs_allowed,
                             earned_runs, walks, strikeouts,
                             home_runs_allowed, hit_batters, batters_faced,
                             era, whip,
                             fip, babip_against, k_per_9, bb_per_9,
                             h_per_9, hr_per_9, k_pct, bb_pct,
                             k_bb_ratio, pitching_war)
                        VALUES
                            (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                             %s, %s, %s, %s, %s, %s,
                             %s, %s,
                             %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (player_id, team_id, season) DO UPDATE SET
                            games=EXCLUDED.games,
                            games_started=EXCLUDED.games_started,
                            wins=EXCLUDED.wins, losses=EXCLUDED.losses,
                            saves=EXCLUDED.saves,
                            complete_games=EXCLUDED.complete_games,
                            innings_pitched=EXCLUDED.innings_pitched,
                            hits_allowed=EXCLUDED.hits_allowed,
                            runs_allowed=EXCLUDED.runs_allowed,
                            earned_runs=EXCLUDED.earned_runs,
                            walks=EXCLUDED.walks,
                            strikeouts=EXCLUDED.strikeouts,
                            home_runs_allowed=EXCLUDED.home_runs_allowed,
                            hit_batters=EXCLUDED.hit_batters,
                            batters_faced=EXCLUDED.batters_faced,
                            era=EXCLUDED.era, whip=EXCLUDED.whip,
                            fip=EXCLUDED.fip,
                            babip_against=EXCLUDED.babip_against,
                            k_per_9=EXCLUDED.k_per_9, bb_per_9=EXCLUDED.bb_per_9,
                            h_per_9=EXCLUDED.h_per_9, hr_per_9=EXCLUDED.hr_per_9,
                            k_pct=EXCLUDED.k_pct, bb_pct=EXCLUDED.bb_pct,
                            k_bb_ratio=EXCLUDED.k_bb_ratio,
                            pitching_war=EXCLUDED.pitching_war,
                            updated_at=CURRENT_TIMESTAMP
                    """, (
                        player_id, team_id, season_year, app, gs, w, l, sv, cg,
                        real_ip, p_h, p_r, er, p_bb, p_k, p_hr, p_hbp, bf,
                        era, whip,
                        adv.fip, adv.babip_against,
                        adv.k_per_9, adv.bb_per_9,
                        adv.h_per_9, adv.hr_per_9,
                        adv.k_pct, adv.bb_pct,
                        adv.k_bb_ratio, war,
                    ))
                    pitching_total += 1

                    cur.execute("RELEASE SAVEPOINT sp_player")

                except Exception as e:
                    logger.error(f"  Error processing pitcher {pitcher.get('name')}: {e}")
                    try:
                        cur.execute("ROLLBACK TO SAVEPOINT sp_player")
                    except Exception:
                        pass

        conn.commit()

    logger.info(f"{'='*60}")
    logger.info(f"SEASON {season_str} COMPLETE (year={season_year})")
    logger.info(f"  Batting:  {batting_total} players")
    logger.info(f"  Pitching: {pitching_total} players")
    logger.info(f"{'='*60}")

    return batting_total, pitching_total


# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="Scrape NWAC historical stats using Playwright")
    parser.add_argument("--season", type=str, help="Season string, e.g., '2018-19'")
    parser.add_argument("--all", action="store_true", help="Scrape all pre-2022 seasons")
    args = parser.parse_args()

    if not args.season and not args.all:
        parser.error("Specify --season or --all")

    if not os.environ.get("DATABASE_URL"):
        print("ERROR: DATABASE_URL environment variable not set.")
        print("Run: export DATABASE_URL='postgresql://...'  (your Supabase connection string)")
        sys.exit(1)

    seasons = ALL_SEASONS if args.all else [args.season]

    fetcher = PlaywrightFetcher()
    fetcher.start()

    try:
        for season_str in seasons:
            parts = season_str.split("-")
            season_year = int(parts[0]) + 1

            logger.info(f"\n{'#'*60}")
            logger.info(f"# NWAC Season: {season_str} (year={season_year})")
            logger.info(f"{'#'*60}")

            # Solve CAPTCHA for this season
            fetcher.solve_captcha(season_str)

            batting, pitching = scrape_season(fetcher, season_str, season_year)

            if batting == 0 and pitching == 0:
                logger.warning(f"No data found for {season_str} — season may not exist or was cancelled")
    finally:
        fetcher.close()

    logger.info("\nAll done!")


if __name__ == "__main__":
    main()
