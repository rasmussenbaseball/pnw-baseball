#!/usr/bin/env python3
"""
Summer Ball Stats Scraper (WCL & PIL)
======================================

Scrapes batting and pitching stats from Pointstreak for the West Coast League
and Pacific International League.

Pointstreak URL patterns:
  Stats:    baseball.pointstreak.com/stats.html?leagueid=XXX&seasonid=XXX
  Teams:    baseball.pointstreak.com/teamlist.html?leagueid=XXX&seasonid=XXX
  Batting:  &view=batting   (default)
  Pitching: &view=pitching

Usage:
    cd pnw-baseball
    python3 scripts/scrape_summer.py --league WCL --season 2025
    python3 scripts/scrape_summer.py --league PIL --season 2024
    python3 scripts/scrape_summer.py --league WCL --season 2025 --pitching-only
    python3 scripts/scrape_summer.py --all   # scrape all leagues, all available seasons
"""

import sys
import os
import time
import random
import argparse
import logging
import re
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import requests
from bs4 import BeautifulSoup

from app.models.database import get_connection

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("scrape_summer")

# ============================================================
# Constants
# ============================================================

BASE_URL = "https://baseball.pointstreak.com"

USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
]

# League configs: league_abbreviation -> pointstreak league ID
LEAGUE_IDS = {
    "WCL": 145,
    "PIL": 259,
}

# Season ID mapping: (league_abbr, year) -> pointstreak season ID
SEASON_IDS = {
    # WCL
    ("WCL", 2025): 34070,
    ("WCL", 2024): 33874,
    ("WCL", 2023): 33635,
    ("WCL", 2022): 33339,
    ("WCL", 2021): 32634,
    ("WCL", 2019): 32132,
    # PIL
    ("PIL", 2024): 33867,
    ("PIL", 2023): 33866,
    ("PIL", 2022): 33235,
    ("PIL", 2021): 32892,
}


def get_session():
    """Create a requests session with random user agent."""
    s = requests.Session()
    s.headers.update({
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml",
    })
    return s


def polite_sleep():
    """Be polite to Pointstreak servers."""
    time.sleep(random.uniform(1.0, 2.5))


# ============================================================
# Team Scraping
# ============================================================

def scrape_teams(session, league_id, season_id):
    """
    Scrape team list from Pointstreak teamlist page.
    Returns list of dicts: {name, pointstreak_team_id, city, state}
    """
    url = f"{BASE_URL}/teamlist.html?leagueid={league_id}&seasonid={season_id}"
    logger.info(f"Fetching teams: {url}")
    resp = session.get(url, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    teams = []
    # Team links have href like: team_home.html?teamid=164781&seasonid=34070
    for link in soup.find_all("a", href=re.compile(r"team_home\.html\?teamid=\d+")):
        name = link.get_text(strip=True)
        if not name:
            continue
        href = link["href"]
        m = re.search(r"teamid=(\d+)", href)
        if not m:
            continue
        team_id = int(m.group(1))

        # Try to extract city from team name
        parts = name.rsplit(" ", 1)
        city = parts[0] if len(parts) > 1 else ""

        teams.append({
            "name": name,
            "pointstreak_team_id": team_id,
            "city": city,
        })

    logger.info(f"  Found {len(teams)} teams")
    return teams


def ensure_teams_in_db(cur, league_db_id, teams):
    """
    Ensure all teams exist in summer_teams table.
    Returns dict: pointstreak_team_id -> summer_teams.id
    """
    team_map = {}
    for t in teams:
        # Check if exists
        cur.execute(
            "SELECT id FROM summer_teams WHERE pointstreak_team_id = %s AND league_id = %s",
            (t["pointstreak_team_id"], league_db_id),
        )
        row = cur.fetchone()
        if row:
            team_map[t["pointstreak_team_id"]] = row["id"]
        else:
            # Generate short name from team name
            short = t["name"].split()[-1] if t["name"] else t["name"]
            cur.execute("""
                INSERT INTO summer_teams (name, short_name, city, league_id, pointstreak_team_id)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING id
            """, (t["name"], short, t["city"], league_db_id, t["pointstreak_team_id"]))
            team_map[t["pointstreak_team_id"]] = cur.fetchone()["id"]
            logger.info(f"  Created team: {t['name']} (PS ID {t['pointstreak_team_id']})")
    return team_map


# ============================================================
# Stats Scraping
# ============================================================

def scrape_batting_stats(session, league_id, season_id):
    """
    Scrape batting stats from Pointstreak.
    Returns list of dicts with raw stat values.
    """
    url = f"{BASE_URL}/stats.html?leagueid={league_id}&seasonid={season_id}&view=batting"
    logger.info(f"Fetching batting stats: {url}")
    resp = session.get(url, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    players = []
    # Find the stats table — it has headers: Player, Team, P, AVG, G, AB, ...
    tables = soup.find_all("table")
    stats_table = None
    for table in tables:
        headers = [th.get_text(strip=True) for th in table.find_all("th")]
        if "Player" in headers and "AVG" in headers and "AB" in headers:
            stats_table = table
            break

    if not stats_table:
        logger.warning("  Could not find batting stats table")
        return []

    # Parse header indices
    headers = [th.get_text(strip=True) for th in stats_table.find_all("th")]
    col_map = {h: i for i, h in enumerate(headers)}

    for row in stats_table.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) < 10:
            continue

        # Player name — first cell, may be a link
        player_cell = cells[col_map.get("Player", 0)]
        player_link = player_cell.find("a")
        player_name = player_link.get_text(strip=True) if player_link else player_cell.get_text(strip=True)
        if not player_name or player_name == "Player":
            continue

        # Extract Pointstreak player ID from link if available
        ps_player_id = None
        if player_link and player_link.get("href"):
            m = re.search(r"playerid=(\d+)", player_link["href"])
            if m:
                ps_player_id = int(m.group(1))

        # Team abbreviation — may be a link
        team_cell = cells[col_map.get("Team", 1)]
        team_link = team_cell.find("a")
        team_abbr = team_link.get_text(strip=True) if team_link else team_cell.get_text(strip=True)

        # Extract team ID from link
        ps_team_id = None
        if team_link and team_link.get("href"):
            m = re.search(r"teamid=(\d+)", team_link["href"])
            if m:
                ps_team_id = int(m.group(1))

        def safe_int(idx, default=0):
            try:
                return int(cells[idx].get_text(strip=True))
            except (ValueError, IndexError):
                return default

        def safe_float(idx, default=None):
            try:
                val = cells[idx].get_text(strip=True)
                return float(val) if val else default
            except (ValueError, IndexError):
                return default

        # Parse player name: "Last, F" format
        name_parts = player_name.split(",")
        if len(name_parts) == 2:
            last_name = name_parts[0].strip()
            first_name = name_parts[1].strip()
        else:
            # Might be "First Last" or just one name
            parts = player_name.strip().split()
            first_name = parts[0] if parts else ""
            last_name = " ".join(parts[1:]) if len(parts) > 1 else parts[0]

        position = cells[col_map.get("P", 2)].get_text(strip=True) if "P" in col_map else ""

        player = {
            "first_name": first_name,
            "last_name": last_name,
            "position": position,
            "team_abbr": team_abbr,
            "ps_player_id": ps_player_id,
            "ps_team_id": ps_team_id,
            "batting_avg": safe_float(col_map.get("AVG", 3)),
            "games": safe_int(col_map.get("G", 4)),
            "at_bats": safe_int(col_map.get("AB", 5)),
            "runs": safe_int(col_map.get("R", 6)),
            "hits": safe_int(col_map.get("H", 7)),
            "doubles": safe_int(col_map.get("2B", 8)),
            "triples": safe_int(col_map.get("3B", 9)),
            "home_runs": safe_int(col_map.get("HR", 10)),
            "rbi": safe_int(col_map.get("RBI", 11)),
            "walks": safe_int(col_map.get("BB", 12)),
            "hit_by_pitch": safe_int(col_map.get("HBP", 13)),
            "strikeouts": safe_int(col_map.get("SO", 14)),
            "sacrifice_flies": safe_int(col_map.get("SF", 15)),
            "sacrifice_bunts": safe_int(col_map.get("SH", 16)),
            "stolen_bases": safe_int(col_map.get("SB", 17)),
            "caught_stealing": safe_int(col_map.get("CS", 18)),
            "grounded_into_dp": safe_int(col_map.get("DP", 19)),
        }

        # Compute plate appearances
        player["plate_appearances"] = (
            player["at_bats"] + player["walks"] + player["hit_by_pitch"]
            + player["sacrifice_flies"] + player["sacrifice_bunts"]
        )

        players.append(player)

    logger.info(f"  Parsed {len(players)} batters")
    return players


def scrape_pitching_stats(session, league_id, season_id):
    """
    Scrape pitching stats from Pointstreak.
    Returns list of dicts with raw stat values.
    """
    url = f"{BASE_URL}/stats.html?leagueid={league_id}&seasonid={season_id}&view=pitching"
    logger.info(f"Fetching pitching stats: {url}")
    resp = session.get(url, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    players = []
    tables = soup.find_all("table")
    stats_table = None
    for table in tables:
        headers = [th.get_text(strip=True) for th in table.find_all("th")]
        if "Player" in headers and "ERA" in headers and "IP" in headers:
            stats_table = table
            break

    if not stats_table:
        logger.warning("  Could not find pitching stats table")
        return []

    headers = [th.get_text(strip=True) for th in stats_table.find_all("th")]
    col_map = {h: i for i, h in enumerate(headers)}

    for row in stats_table.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) < 10:
            continue

        player_cell = cells[col_map.get("Player", 0)]
        player_link = player_cell.find("a")
        player_name = player_link.get_text(strip=True) if player_link else player_cell.get_text(strip=True)
        if not player_name or player_name == "Player":
            continue

        ps_player_id = None
        if player_link and player_link.get("href"):
            m = re.search(r"playerid=(\d+)", player_link["href"])
            if m:
                ps_player_id = int(m.group(1))

        team_cell = cells[col_map.get("Team", 1)]
        team_link = team_cell.find("a")
        team_abbr = team_link.get_text(strip=True) if team_link else team_cell.get_text(strip=True)

        ps_team_id = None
        if team_link and team_link.get("href"):
            m = re.search(r"teamid=(\d+)", team_link["href"])
            if m:
                ps_team_id = int(m.group(1))

        def safe_int(idx, default=0):
            try:
                return int(cells[idx].get_text(strip=True))
            except (ValueError, IndexError):
                return default

        def safe_float(idx, default=None):
            try:
                val = cells[idx].get_text(strip=True)
                return float(val) if val else default
            except (ValueError, IndexError):
                return default

        name_parts = player_name.split(",")
        if len(name_parts) == 2:
            last_name = name_parts[0].strip()
            first_name = name_parts[1].strip()
        else:
            parts = player_name.strip().split()
            first_name = parts[0] if parts else ""
            last_name = " ".join(parts[1:]) if len(parts) > 1 else parts[0]

        player = {
            "first_name": first_name,
            "last_name": last_name,
            "team_abbr": team_abbr,
            "ps_player_id": ps_player_id,
            "ps_team_id": ps_team_id,
            "games": safe_int(col_map.get("G", 2)),
            "games_started": safe_int(col_map.get("GS", 3)),
            "complete_games": safe_int(col_map.get("CG", 4)),
            "innings_pitched": safe_float(col_map.get("IP", 5), 0),
            "hits_allowed": safe_int(col_map.get("H", 6)),
            "runs_allowed": safe_int(col_map.get("R", 7)),
            "earned_runs": safe_int(col_map.get("ER", 8)),
            "walks": safe_int(col_map.get("BB", 9)),
            "strikeouts": safe_int(col_map.get("SO", 10)),
            "wins": safe_int(col_map.get("W", 11)),
            "losses": safe_int(col_map.get("L", 12)),
            "saves": safe_int(col_map.get("SV", 13)),
            "home_runs_allowed": 0,  # Not always available
            "era": safe_float(col_map.get("ERA", -1)),
        }

        # Estimate batters faced if not available
        player["batters_faced"] = (
            player.get("hits_allowed", 0) + player.get("walks", 0)
            + player.get("strikeouts", 0) + player.get("hit_batters", 0)
        )

        players.append(player)

    logger.info(f"  Parsed {len(players)} pitchers")
    return players


# ============================================================
# Database Insertion
# ============================================================

def ensure_player_in_db(cur, player_data, team_db_id):
    """
    Find or create a summer_players record.
    Returns the summer_players.id.
    """
    ps_id = player_data.get("ps_player_id")

    # Try to find by Pointstreak player ID + team
    if ps_id:
        cur.execute(
            "SELECT id FROM summer_players WHERE pointstreak_player_id = %s AND team_id = %s",
            (ps_id, team_db_id),
        )
        row = cur.fetchone()
        if row:
            return row["id"]

    # Try to find by name + team
    cur.execute(
        "SELECT id FROM summer_players WHERE first_name = %s AND last_name = %s AND team_id = %s",
        (player_data["first_name"], player_data["last_name"], team_db_id),
    )
    row = cur.fetchone()
    if row:
        # Update Pointstreak ID if we have it
        if ps_id:
            cur.execute("UPDATE summer_players SET pointstreak_player_id = %s WHERE id = %s", (ps_id, row["id"]))
        return row["id"]

    # Create new player
    cur.execute("""
        INSERT INTO summer_players (first_name, last_name, team_id, position, pointstreak_player_id)
        VALUES (%s, %s, %s, %s, %s)
        RETURNING id
    """, (
        player_data["first_name"],
        player_data["last_name"],
        team_db_id,
        player_data.get("position", ""),
        ps_id,
    ))
    return cur.fetchone()["id"]


def save_batting_stats(cur, players, team_map, season_year):
    """Save batting stats to summer_batting_stats table."""
    inserted = 0
    updated = 0

    for p in players:
        ps_team_id = p.get("ps_team_id")
        if not ps_team_id or ps_team_id not in team_map:
            logger.warning(f"  Skipping {p['first_name']} {p['last_name']} — unknown team {p.get('team_abbr')}")
            continue

        team_db_id = team_map[ps_team_id]
        player_db_id = ensure_player_in_db(cur, p, team_db_id)

        # Compute basic rate stats
        pa = p.get("plate_appearances", 0)
        ab = p.get("at_bats", 0)
        hits = p.get("hits", 0)
        bb = p.get("walks", 0)
        hbp = p.get("hit_by_pitch", 0)
        sf = p.get("sacrifice_flies", 0)
        hr = p.get("home_runs", 0)
        doubles = p.get("doubles", 0)
        triples = p.get("triples", 0)

        avg = hits / ab if ab > 0 else None
        obp = (hits + bb + hbp) / (ab + bb + hbp + sf) if (ab + bb + hbp + sf) > 0 else None
        tb = hits + doubles + (2 * triples) + (3 * hr)
        slg = tb / ab if ab > 0 else None
        ops = (obp or 0) + (slg or 0) if obp is not None or slg is not None else None
        iso = (slg or 0) - (avg or 0) if slg is not None and avg is not None else None
        bb_pct = bb / pa if pa > 0 else None
        k_pct = p.get("strikeouts", 0) / pa if pa > 0 else None

        # BABIP
        so = p.get("strikeouts", 0)
        babip = (hits - hr) / (ab - so - hr + sf) if (ab - so - hr + sf) > 0 else None

        # Upsert
        cur.execute("""
            INSERT INTO summer_batting_stats (
                player_id, team_id, season,
                games, plate_appearances, at_bats, runs, hits,
                doubles, triples, home_runs, rbi, walks, strikeouts,
                hit_by_pitch, sacrifice_flies, sacrifice_bunts,
                stolen_bases, caught_stealing, grounded_into_dp,
                batting_avg, on_base_pct, slugging_pct, ops, iso, babip, bb_pct, k_pct
            ) VALUES (
                %s, %s, %s,
                %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s, %s, %s, %s, %s, %s
            )
            ON CONFLICT (player_id, team_id, season) DO UPDATE SET
                games = EXCLUDED.games,
                plate_appearances = EXCLUDED.plate_appearances,
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
                caught_stealing = EXCLUDED.caught_stealing,
                grounded_into_dp = EXCLUDED.grounded_into_dp,
                batting_avg = EXCLUDED.batting_avg,
                on_base_pct = EXCLUDED.on_base_pct,
                slugging_pct = EXCLUDED.slugging_pct,
                ops = EXCLUDED.ops,
                iso = EXCLUDED.iso,
                babip = EXCLUDED.babip,
                bb_pct = EXCLUDED.bb_pct,
                k_pct = EXCLUDED.k_pct,
                updated_at = CURRENT_TIMESTAMP
        """, (
            player_db_id, team_db_id, season_year,
            p.get("games", 0), pa, ab, p.get("runs", 0), hits,
            doubles, triples, hr, p.get("rbi", 0), bb, p.get("strikeouts", 0),
            hbp, sf, p.get("sacrifice_bunts", 0),
            p.get("stolen_bases", 0), p.get("caught_stealing", 0), p.get("grounded_into_dp", 0),
            avg, obp, slg, ops, iso, babip, bb_pct, k_pct,
        ))
        inserted += 1

    logger.info(f"  Saved {inserted} batting stat rows")


def save_pitching_stats(cur, players, team_map, season_year):
    """Save pitching stats to summer_pitching_stats table."""
    inserted = 0

    for p in players:
        ps_team_id = p.get("ps_team_id")
        if not ps_team_id or ps_team_id not in team_map:
            logger.warning(f"  Skipping {p['first_name']} {p['last_name']} — unknown team {p.get('team_abbr')}")
            continue

        team_db_id = team_map[ps_team_id]
        player_db_id = ensure_player_in_db(cur, p, team_db_id)

        ip = p.get("innings_pitched", 0) or 0
        er = p.get("earned_runs", 0)
        era = (er * 9) / ip if ip > 0 else None
        h_allowed = p.get("hits_allowed", 0)
        bb = p.get("walks", 0)
        whip = (h_allowed + bb) / ip if ip > 0 else None
        so = p.get("strikeouts", 0)
        k_per_9 = (so * 9) / ip if ip > 0 else None
        bb_per_9 = (bb * 9) / ip if ip > 0 else None
        h_per_9 = (h_allowed * 9) / ip if ip > 0 else None
        hr_per_9 = (p.get("home_runs_allowed", 0) * 9) / ip if ip > 0 else None
        k_bb = so / bb if bb > 0 else None
        bf = p.get("batters_faced", 0) or (h_allowed + bb + so)
        k_pct = so / bf if bf > 0 else None
        bb_pct = bb / bf if bf > 0 else None

        cur.execute("""
            INSERT INTO summer_pitching_stats (
                player_id, team_id, season,
                games, games_started, wins, losses, saves,
                complete_games, innings_pitched,
                hits_allowed, runs_allowed, earned_runs,
                walks, strikeouts, home_runs_allowed,
                batters_faced,
                era, whip, k_per_9, bb_per_9, h_per_9, hr_per_9,
                k_bb_ratio, k_pct, bb_pct
            ) VALUES (
                %s, %s, %s,
                %s, %s, %s, %s, %s,
                %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                %s,
                %s, %s, %s, %s, %s, %s,
                %s, %s, %s
            )
            ON CONFLICT (player_id, team_id, season) DO UPDATE SET
                games = EXCLUDED.games,
                games_started = EXCLUDED.games_started,
                wins = EXCLUDED.wins,
                losses = EXCLUDED.losses,
                saves = EXCLUDED.saves,
                complete_games = EXCLUDED.complete_games,
                innings_pitched = EXCLUDED.innings_pitched,
                hits_allowed = EXCLUDED.hits_allowed,
                runs_allowed = EXCLUDED.runs_allowed,
                earned_runs = EXCLUDED.earned_runs,
                walks = EXCLUDED.walks,
                strikeouts = EXCLUDED.strikeouts,
                home_runs_allowed = EXCLUDED.home_runs_allowed,
                batters_faced = EXCLUDED.batters_faced,
                era = EXCLUDED.era,
                whip = EXCLUDED.whip,
                k_per_9 = EXCLUDED.k_per_9,
                bb_per_9 = EXCLUDED.bb_per_9,
                h_per_9 = EXCLUDED.h_per_9,
                hr_per_9 = EXCLUDED.hr_per_9,
                k_bb_ratio = EXCLUDED.k_bb_ratio,
                k_pct = EXCLUDED.k_pct,
                bb_pct = EXCLUDED.bb_pct,
                updated_at = CURRENT_TIMESTAMP
        """, (
            player_db_id, team_db_id, season_year,
            p.get("games", 0), p.get("games_started", 0),
            p.get("wins", 0), p.get("losses", 0), p.get("saves", 0),
            p.get("complete_games", 0), ip,
            h_allowed, p.get("runs_allowed", 0), er,
            bb, so, p.get("home_runs_allowed", 0),
            bf,
            era, whip, k_per_9, bb_per_9, h_per_9, hr_per_9,
            k_bb, k_pct, bb_pct,
        ))
        inserted += 1

    logger.info(f"  Saved {inserted} pitching stat rows")


# ============================================================
# Main Scrape Logic
# ============================================================

def scrape_league_season(league_abbr, season_year, batting=True, pitching=True):
    """Scrape a single league + season combo."""
    key = (league_abbr, season_year)
    if key not in SEASON_IDS:
        logger.error(f"No season ID configured for {league_abbr} {season_year}")
        return

    league_id = LEAGUE_IDS[league_abbr]
    season_id = SEASON_IDS[key]

    logger.info(f"=== Scraping {league_abbr} {season_year} (seasonid={season_id}) ===")

    session = get_session()

    # Get league DB ID
    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute("SELECT id FROM summer_leagues WHERE abbreviation = %s", (league_abbr,))
        league_row = cur.fetchone()
        if not league_row:
            logger.error(f"League {league_abbr} not found in summer_leagues table. Run the migration first.")
            return
        league_db_id = league_row["id"]

        # Scrape and ensure teams
        teams = scrape_teams(session, league_id, season_id)
        polite_sleep()
        team_map = ensure_teams_in_db(cur, league_db_id, teams)
        conn.commit()

        # Scrape batting
        if batting:
            batters = scrape_batting_stats(session, league_id, season_id)
            polite_sleep()
            save_batting_stats(cur, batters, team_map, season_year)
            conn.commit()
            logger.info(f"  Batting stats committed")

        # Scrape pitching
        if pitching:
            pitchers = scrape_pitching_stats(session, league_id, season_id)
            polite_sleep()
            save_pitching_stats(cur, pitchers, team_map, season_year)
            conn.commit()
            logger.info(f"  Pitching stats committed")

    logger.info(f"=== Done: {league_abbr} {season_year} ===\n")


def main():
    parser = argparse.ArgumentParser(description="Scrape summer ball stats from Pointstreak")
    parser.add_argument("--league", type=str, choices=["WCL", "PIL"], help="League to scrape")
    parser.add_argument("--season", type=int, help="Season year (e.g. 2025)")
    parser.add_argument("--all", action="store_true", help="Scrape all configured leagues and seasons")
    parser.add_argument("--batting-only", action="store_true", help="Only scrape batting stats")
    parser.add_argument("--pitching-only", action="store_true", help="Only scrape pitching stats")
    args = parser.parse_args()

    batting = not args.pitching_only
    pitching = not args.batting_only

    if args.all:
        for (league, year) in sorted(SEASON_IDS.keys()):
            scrape_league_season(league, year, batting=batting, pitching=pitching)
    elif args.league and args.season:
        scrape_league_season(args.league, args.season, batting=batting, pitching=pitching)
    else:
        parser.error("Either --all or both --league and --season are required")


if __name__ == "__main__":
    main()
