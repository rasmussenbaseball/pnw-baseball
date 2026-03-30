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
        # Check if exists by pointstreak_team_id
        cur.execute(
            "SELECT id FROM summer_teams WHERE pointstreak_team_id = %s AND league_id = %s",
            (t["pointstreak_team_id"], league_db_id),
        )
        row = cur.fetchone()
        if row:
            team_map[t["pointstreak_team_id"]] = row["id"]
            continue

        # Also check by name (same team may have different PS IDs across seasons)
        cur.execute(
            "SELECT id FROM summer_teams WHERE name = %s AND league_id = %s",
            (t["name"], league_db_id),
        )
        row = cur.fetchone()
        if row:
            team_map[t["pointstreak_team_id"]] = row["id"]
            continue

        # New team — insert
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

def _parse_table(soup, required_headers):
    """Find a stats table containing all required_headers. Returns (table, col_map) or (None, None)."""
    for table in soup.find_all("table"):
        headers = [th.get_text(strip=True) for th in table.find_all("th")]
        if all(h in headers for h in required_headers):
            col_map = {}
            for i, h in enumerate(headers):
                if h not in col_map:
                    col_map[h] = i
            return table, col_map
    return None, None


def _parse_player_rows(table, col_map):
    """Yield (cells, player_name, ps_player_id, first_name, last_name) for each valid row."""
    min_cols = max(col_map.values()) + 1 if col_map else 5
    for row in table.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) < min_cols:
            continue

        player_cell = cells[col_map["Player"]]
        player_link = player_cell.find("a")
        player_name = player_link.get_text(strip=True) if player_link else player_cell.get_text(strip=True)
        if not player_name or player_name in ("Player", "Totals", "TOTALS", "Total"):
            continue

        # Pointstreak player ID from link
        ps_player_id = None
        if player_link and player_link.get("href"):
            m = re.search(r"playerid=(\d+)", player_link["href"])
            if m:
                ps_player_id = int(m.group(1))

        # Parse "Last, F" name format
        name_parts = player_name.split(",")
        if len(name_parts) == 2:
            last_name = name_parts[0].strip()
            first_name = name_parts[1].strip()
        else:
            parts = player_name.strip().split()
            first_name = parts[0] if parts else ""
            last_name = " ".join(parts[1:]) if len(parts) > 1 else parts[0]

        yield cells, player_name, ps_player_id, first_name, last_name


def scrape_team_batting(session, ps_team_id, season_id, team_name):
    """Scrape batting stats for a single team (all players, no qualification filter)."""
    url = f"{BASE_URL}/team_stats.html?teamid={ps_team_id}&seasonid={season_id}"
    logger.info(f"  Batting: {team_name}")
    resp = session.get(url, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    # Team page batting table has: Player, P, AVG, G, AB, R, H, 2B, 3B, HR, RBI, BB, HBP, SO, SF, SH, SB, CS, DP, E
    table, col_map = _parse_table(soup, ["Player", "AVG", "AB"])
    if not table:
        logger.warning(f"    Could not find batting table for {team_name}")
        return []

    players = []
    for cells, _name, ps_player_id, first_name, last_name in _parse_player_rows(table, col_map):
        def safe_int(col_name, default=0):
            idx = col_map.get(col_name)
            if idx is None:
                return default
            try:
                return int(cells[idx].get_text(strip=True))
            except (ValueError, IndexError):
                return default

        def safe_float(col_name, default=None):
            idx = col_map.get(col_name)
            if idx is None:
                return default
            try:
                val = cells[idx].get_text(strip=True)
                return float(val) if val else default
            except (ValueError, IndexError):
                return default

        position = cells[col_map["P"]].get_text(strip=True) if "P" in col_map else ""

        player = {
            "first_name": first_name,
            "last_name": last_name,
            "position": position,
            "ps_player_id": ps_player_id,
            "ps_team_id": ps_team_id,
            "batting_avg": safe_float("AVG"),
            "games": safe_int("G"),
            "at_bats": safe_int("AB"),
            "runs": safe_int("R"),
            "hits": safe_int("H"),
            "doubles": safe_int("2B"),
            "triples": safe_int("3B"),
            "home_runs": safe_int("HR"),
            "rbi": safe_int("RBI"),
            "walks": safe_int("BB"),
            "hit_by_pitch": safe_int("HBP"),
            "strikeouts": safe_int("SO"),
            "sacrifice_flies": safe_int("SF"),
            "sacrifice_bunts": safe_int("SH"),
            "stolen_bases": safe_int("SB"),
            "caught_stealing": safe_int("CS"),
            "grounded_into_dp": safe_int("DP"),
        }

        player["plate_appearances"] = (
            player["at_bats"] + player["walks"] + player["hit_by_pitch"]
            + player["sacrifice_flies"] + player["sacrifice_bunts"]
        )

        players.append(player)

    logger.info(f"    {len(players)} batters")
    return players


def scrape_team_pitching(session, ps_team_id, season_id, team_name):
    """Scrape pitching stats for a single team (all players, no qualification filter)."""
    url = f"{BASE_URL}/team_stats.html?teamid={ps_team_id}&seasonid={season_id}&view=pitching"
    logger.info(f"  Pitching: {team_name}")
    resp = session.get(url, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    # Team page pitching table: Player, G, GS, CG, IP, H, R, ER, BB, SO, W, L, SV, 2B, 3B, ERA
    table, col_map = _parse_table(soup, ["Player", "ERA", "IP"])
    if not table:
        logger.warning(f"    Could not find pitching table for {team_name}")
        return []

    players = []
    for cells, _name, ps_player_id, first_name, last_name in _parse_player_rows(table, col_map):
        def safe_int(col_name, default=0):
            idx = col_map.get(col_name)
            if idx is None:
                return default
            try:
                return int(cells[idx].get_text(strip=True))
            except (ValueError, IndexError):
                return default

        def safe_float(col_name, default=None):
            idx = col_map.get(col_name)
            if idx is None:
                return default
            try:
                val = cells[idx].get_text(strip=True)
                return float(val) if val else default
            except (ValueError, IndexError):
                return default

        player = {
            "first_name": first_name,
            "last_name": last_name,
            "ps_player_id": ps_player_id,
            "ps_team_id": ps_team_id,
            "games": safe_int("G"),
            "games_started": safe_int("GS"),
            "complete_games": safe_int("CG"),
            "innings_pitched": safe_float("IP", 0),
            "hits_allowed": safe_int("H"),
            "runs_allowed": safe_int("R"),
            "earned_runs": safe_int("ER"),
            "walks": safe_int("BB"),
            "strikeouts": safe_int("SO"),
            "wins": safe_int("W"),
            "losses": safe_int("L"),
            "saves": safe_int("SV"),
            "home_runs_allowed": 0,  # Not on team page
            "era": safe_float("ERA"),
        }

        # Estimate batters faced
        player["batters_faced"] = (
            player.get("hits_allowed", 0) + player.get("walks", 0)
            + player.get("strikeouts", 0)
        )

        players.append(player)

    logger.info(f"    {len(players)} pitchers")
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

        # Scrape each team individually (gets ALL players, not just qualified)
        total_batters = 0
        total_pitchers = 0
        for t in teams:
            ps_tid = t["pointstreak_team_id"]

            if batting:
                batters = scrape_team_batting(session, ps_tid, season_id, t["name"])
                polite_sleep()
                # Attach ps_team_id so save function can look up team
                for b in batters:
                    b["ps_team_id"] = ps_tid
                save_batting_stats(cur, batters, team_map, season_year)
                total_batters += len(batters)

            if pitching:
                pitchers = scrape_team_pitching(session, ps_tid, season_id, t["name"])
                polite_sleep()
                for p in pitchers:
                    p["ps_team_id"] = ps_tid
                save_pitching_stats(cur, pitchers, team_map, season_year)
                total_pitchers += len(pitchers)

            conn.commit()

        logger.info(f"  Total: {total_batters} batters, {total_pitchers} pitchers")

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
