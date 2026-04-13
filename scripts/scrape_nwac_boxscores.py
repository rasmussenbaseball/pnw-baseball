#!/usr/bin/env python3
"""
PNW Baseball — NWAC Box Score Scraper
======================================

Fetches and parses NWAC box scores from PrestoSports via ScraperAPI.
Designed to run as a GitHub Actions workflow (daily) and as a one-time
backfill script.

Two modes:
  1. Daily mode (default): Queries the DB for NWAC games that have a
     source_url (box score link) but no game_batting rows yet, then
     fetches and parses each one.

  2. Backfill mode (--backfill): Fetches ALL box score URLs from the
     NWAC schedule page and processes every one that doesn't already
     have batting data in the DB. Includes --dry-run and --limit
     options to control costs.

Credit usage:
  Each box score fetch uses ScraperAPI with premium=true = 10 credits.
  Daily new games: ~4-8 games = 40-80 credits
  Full backfill: ~446 games = 4,460 credits

Usage:
    # Daily mode (from GitHub Actions or manually)
    PYTHONPATH=backend python3 scripts/scrape_nwac_boxscores.py

    # Backfill mode — dry run first to see what would be fetched
    PYTHONPATH=backend python3 scripts/scrape_nwac_boxscores.py --backfill --dry-run

    # Backfill — process 10 games to test
    PYTHONPATH=backend python3 scripts/scrape_nwac_boxscores.py --backfill --limit 10

    # Full backfill
    PYTHONPATH=backend python3 scripts/scrape_nwac_boxscores.py --backfill
"""

import sys
import os
import re
import time
import json
import logging
import argparse
from pathlib import Path
from datetime import datetime

# Add project paths
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
sys.path.insert(0, str(Path(__file__).parent))

import requests
from bs4 import BeautifulSoup

from app.models.database import get_connection
from parse_nwac_boxscore import parse_presto_xml_boxscore

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("scrape_nwac_boxscores")

# ── Config ──
SCRAPER_API_KEY = os.environ.get("SCRAPER_API_KEY", "")
SCRAPER_API_BASE = "https://api.scraperapi.com"
NWAC_BASE = "https://nwacsports.com"
SEASON = os.environ.get("SEASON_YEAR", "2026")
PRESTO_SEASON = f"{int(SEASON) - 1}-{SEASON[2:]}"  # e.g. "2025-26"


# ── ScraperAPI fetch ──

def fetch_via_scraper_api(url, premium=True, retries=2):
    """
    Fetch a URL through ScraperAPI with premium residential proxies.
    Returns HTML string or None on failure.
    """
    if not SCRAPER_API_KEY:
        logger.warning("No SCRAPER_API_KEY set — attempting direct fetch")
        try:
            r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=20)
            if r.status_code == 200 and len(r.text) > 5000:
                return r.text
            logger.warning(f"Direct fetch failed: {r.status_code}, {len(r.text)} bytes")
            return None
        except Exception as e:
            logger.error(f"Direct fetch error: {e}")
            return None

    params = {
        "api_key": SCRAPER_API_KEY,
        "url": url,
        "premium": "true" if premium else "false",
    }

    for attempt in range(retries + 1):
        try:
            r = requests.get(SCRAPER_API_BASE, params=params, timeout=60)
            if r.status_code == 200 and len(r.text) > 5000:
                return r.text
            logger.warning(f"ScraperAPI attempt {attempt + 1}: "
                          f"status={r.status_code}, size={len(r.text)}")
        except Exception as e:
            logger.warning(f"ScraperAPI attempt {attempt + 1} error: {e}")

        if attempt < retries:
            time.sleep(3 * (attempt + 1))

    return None


# ── Database helpers ──

def get_team_id_by_name(cur, team_name):
    """Look up team_id by short name (db_short)."""
    cur.execute("""
        SELECT id FROM teams
        WHERE short_name = %s OR name ILIKE %s
        LIMIT 1
    """, (team_name, f"%{team_name}%"))
    row = cur.fetchone()
    return row["id"] if row else None


def find_player_id(cur, team_id, player_name, season):
    """Try to match a player by name on a given team."""
    if not player_name or not team_id:
        return None

    name = player_name.strip()
    parts = name.split(None, 1)
    if len(parts) == 2:
        first, last = parts
        cur.execute("""
            SELECT p.id FROM players p
            WHERE p.team_id = %s
              AND LOWER(p.first_name) = LOWER(%s)
              AND LOWER(p.last_name) = LOWER(%s)
            LIMIT 1
        """, (team_id, first, last))
        row = cur.fetchone()
        if row:
            return row["id"]

    # Last name only match
    if len(parts) >= 2:
        last = parts[-1]
        cur.execute("""
            SELECT p.id FROM players p
            WHERE p.team_id = %s
              AND LOWER(p.last_name) = LOWER(%s)
        """, (team_id, last))
        rows = cur.fetchall()
        if len(rows) == 1:
            return rows[0]["id"]

    return None


def get_games_needing_boxscores(cur, season):
    """
    Find NWAC games that have a box score URL but no batting data yet.
    Returns list of dicts with id, source_url, game_date, home_team_name, away_team_name.
    """
    cur.execute("""
        SELECT g.id, g.source_url, g.game_date,
               g.home_team_name, g.away_team_name,
               g.home_team_id, g.away_team_id
        FROM games g
        JOIN teams ht ON g.home_team_id = ht.id
        WHERE g.season = %s
          AND g.status = 'final'
          AND g.source_url LIKE '%%nwacsports.com%%boxscores%%'
          AND ht.division = 'JUCO'
          AND NOT EXISTS (
              SELECT 1 FROM game_batting gb WHERE gb.game_id = g.id
          )
        ORDER BY g.game_date DESC
    """, (season,))
    return cur.fetchall()


def get_all_nwac_game_ids_with_batting(cur, season):
    """Get set of source_urls that already have batting data."""
    cur.execute("""
        SELECT g.source_url
        FROM games g
        JOIN game_batting gb ON gb.game_id = g.id
        WHERE g.season = %s
          AND g.source_url LIKE '%%nwacsports.com%%boxscores%%'
        GROUP BY g.source_url
    """, (season,))
    return {row["source_url"] for row in cur.fetchall()}


# ── Box score processing ──

def compute_bill_james_game_score(ip, h, er, bb, k, hr=0, unearn_runs=0):
    """Compute Bill James Game Score for a starting pitcher."""
    score = 50
    score += 3 * int(ip)  # full innings
    frac = ip - int(ip)
    if abs(frac - 0.1) < 0.05:
        score += 1
    elif abs(frac - 0.2) < 0.05:
        score += 2
    score -= 2 * h
    score -= 4 * er
    score -= 2 * (unearn_runs)
    score -= 2 * bb
    score += 1 * k
    score -= 6 * hr
    return max(0, score)


def is_quality_start(ip, er):
    """Check if a start qualifies as a quality start (6+ IP, 3 or fewer ER)."""
    return ip >= 6.0 and er <= 3


def process_boxscore(box_url, season_year, dry_run=False):
    """
    Fetch a single box score, parse it, and save to database.
    Returns True on success, False on failure.
    """
    logger.info(f"  Fetching: {box_url}")

    if dry_run:
        logger.info(f"  [DRY RUN] Would fetch and parse")
        return True

    html = fetch_via_scraper_api(box_url, premium=True)
    if not html:
        logger.error(f"  Failed to fetch {box_url}")
        return False

    # Parse the box score
    parsed = parse_presto_xml_boxscore(html, box_url)
    if not parsed:
        logger.error(f"  Failed to parse {box_url}")
        return False

    away_name = parsed.get("away_team_name", "Unknown")
    home_name = parsed.get("home_team_name", "Unknown")
    away_score = parsed.get("away_score", 0)
    home_score = parsed.get("home_score", 0)
    game_date = parsed.get("game_date")

    logger.info(f"  Parsed: {away_name} {away_score} @ {home_name} {home_score} ({game_date})")
    logger.info(f"    Batters: {len(parsed.get('away_batting', []))} away, "
                f"{len(parsed.get('home_batting', []))} home")
    logger.info(f"    Pitchers: {len(parsed.get('away_pitching', []))} away, "
                f"{len(parsed.get('home_pitching', []))} home")

    # Save to database
    with get_connection() as conn:
        cur = conn.cursor()

        # Find or create the game record
        # First try to match by source_url
        cur.execute("SELECT id, home_team_id, away_team_id FROM games WHERE source_url = %s",
                    (box_url,))
        game_row = cur.fetchone()

        if game_row:
            game_id = game_row["id"]
            home_team_id = game_row["home_team_id"]
            away_team_id = game_row["away_team_id"]
            logger.info(f"    Found existing game ID: {game_id}")
        else:
            # Try matching by date + team names
            cur.execute("""
                SELECT id, home_team_id, away_team_id FROM games
                WHERE game_date = %s
                  AND (home_team_name ILIKE %s OR away_team_name ILIKE %s)
                  AND (home_team_name ILIKE %s OR away_team_name ILIKE %s)
                LIMIT 1
            """, (game_date,
                  f"%{home_name}%", f"%{home_name}%",
                  f"%{away_name}%", f"%{away_name}%"))
            game_row = cur.fetchone()

            if game_row:
                game_id = game_row["id"]
                home_team_id = game_row["home_team_id"]
                away_team_id = game_row["away_team_id"]
                logger.info(f"    Matched existing game ID: {game_id} by date+teams")
                # Update source_url
                cur.execute("UPDATE games SET source_url = %s WHERE id = %s",
                            (box_url, game_id))
            else:
                logger.warning(f"    No matching game found for {away_name} @ {home_name} on {game_date}")
                logger.warning(f"    Skipping — game must exist in DB first (run schedule scraper)")
                return False

        # Update game-level stats (hits, errors, line scores)
        cur.execute("""
            UPDATE games SET
                home_hits = COALESCE(%s, home_hits),
                away_hits = COALESCE(%s, away_hits),
                home_errors = COALESCE(%s, home_errors),
                away_errors = COALESCE(%s, away_errors),
                home_line_score = COALESCE(%s, home_line_score),
                away_line_score = COALESCE(%s, away_line_score),
                innings = COALESCE(%s, innings),
                source_url = COALESCE(%s, source_url),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = %s
        """, (
            parsed.get("home_hits"), parsed.get("away_hits"),
            parsed.get("home_errors"), parsed.get("away_errors"),
            json.dumps(parsed["home_line_score"]) if parsed.get("home_line_score") else None,
            json.dumps(parsed["away_line_score"]) if parsed.get("away_line_score") else None,
            parsed.get("innings"),
            box_url,
            game_id,
        ))

        # Clear any existing batting/pitching data for this game
        cur.execute("DELETE FROM game_batting WHERE game_id = %s", (game_id,))
        cur.execute("DELETE FROM game_pitching WHERE game_id = %s", (game_id,))

        # Insert batting lines
        for side, team_id, batting in [
            ("away", away_team_id, parsed.get("away_batting", [])),
            ("home", home_team_id, parsed.get("home_batting", [])),
        ]:
            for i, p in enumerate(batting):
                player_id = find_player_id(cur, team_id, p.get("player_name"), season_year)
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

        # Insert pitching lines
        for side, team_id, pitching in [
            ("away", away_team_id, parsed.get("away_pitching", [])),
            ("home", home_team_id, parsed.get("home_pitching", [])),
        ]:
            for p in pitching:
                player_id = find_player_id(cur, team_id, p.get("player_name"), season_year)
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

        conn.commit()

    logger.info(f"    Saved successfully")
    return True


# ── Backfill: discover all box score URLs from schedule page ──

def discover_all_boxscore_urls(season_str):
    """
    Fetch the NWAC schedule page and extract all box score URLs.
    Returns list of full URLs.
    """
    schedule_url = f"{NWAC_BASE}/sports/bsb/{season_str}/schedule"
    logger.info(f"Fetching schedule page: {schedule_url}")

    html = fetch_via_scraper_api(schedule_url, premium=False)
    if not html:
        # Try direct fetch (schedule page might not need premium)
        try:
            r = requests.get(schedule_url, headers={"User-Agent": "Mozilla/5.0"}, timeout=20)
            html = r.text if r.status_code == 200 else None
        except Exception:
            pass

    if not html:
        logger.error("Failed to fetch schedule page")
        return []

    # Extract unique box score URLs
    pattern = rf'/sports/bsb/{re.escape(season_str)}/boxscores/\d{{8}}_\w+\.xml'
    matches = re.findall(pattern, html)
    unique = list(dict.fromkeys(matches))
    full_urls = [f"{NWAC_BASE}{path}" for path in unique]

    logger.info(f"Found {len(full_urls)} unique box score URLs")
    return full_urls


# ── Main ──

def main():
    parser = argparse.ArgumentParser(description="Scrape NWAC box scores")
    parser.add_argument("--backfill", action="store_true",
                        help="Backfill mode: discover and process ALL box scores")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be done without fetching or saving")
    parser.add_argument("--limit", type=int, default=0,
                        help="Max number of box scores to process (0 = unlimited)")
    parser.add_argument("--season", default=SEASON,
                        help="Season year (default: from SEASON_YEAR env or 2026)")
    args = parser.parse_args()

    season_year = int(args.season)
    presto_season = f"{season_year - 1}-{str(season_year)[2:]}"

    success = 0
    failed = 0
    skipped = 0

    if args.backfill:
        # ── Backfill mode ──
        logger.info(f"=== NWAC Box Score BACKFILL — Season {presto_season} ===")

        # Discover all box score URLs
        all_urls = discover_all_boxscore_urls(presto_season)
        if not all_urls:
            logger.error("No box score URLs found")
            return

        # Filter out games that already have batting data
        with get_connection() as conn:
            cur = conn.cursor()
            existing = get_all_nwac_game_ids_with_batting(cur, season_year)

        to_process = [u for u in all_urls if u not in existing]
        logger.info(f"Already have batting data: {len(existing)}")
        logger.info(f"Need to process: {len(to_process)}")
        logger.info(f"Estimated credits: {len(to_process) * 10}")

        if args.limit > 0:
            to_process = to_process[:args.limit]
            logger.info(f"Limited to {args.limit} games")

        if args.dry_run:
            logger.info(f"\n[DRY RUN] Would process {len(to_process)} box scores:")
            for url in to_process[:20]:
                logger.info(f"  {url}")
            if len(to_process) > 20:
                logger.info(f"  ... and {len(to_process) - 20} more")
            return

        # Process each box score
        total = len(to_process)
        for i, url in enumerate(to_process):
            logger.info(f"\n[{i + 1}/{total}] Processing box score")
            try:
                if process_boxscore(url, season_year, dry_run=args.dry_run):
                    success += 1
                else:
                    failed += 1
            except Exception as e:
                logger.error(f"  Error: {e}")
                import traceback
                traceback.print_exc()
                failed += 1

            # Rate limit: 1 request per 2 seconds to be safe
            if i < total - 1:
                time.sleep(2)

    else:
        # ── Daily mode ──
        logger.info(f"=== NWAC Box Score Scraper — Season {season_year} ===")

        with get_connection() as conn:
            cur = conn.cursor()
            games = get_games_needing_boxscores(cur, season_year)

        if not games:
            logger.info("No NWAC games need box score data — all up to date")
            return

        logger.info(f"Found {len(games)} games needing box scores")
        if args.limit > 0:
            games = games[:args.limit]
            logger.info(f"Limited to {args.limit} games")

        if args.dry_run:
            for g in games[:20]:
                logger.info(f"  {g['game_date']} — {g['away_team_name']} @ "
                           f"{g['home_team_name']} — {g['source_url']}")
            if len(games) > 20:
                logger.info(f"  ... and {len(games) - 20} more")
            return

        total = len(games)
        for i, game in enumerate(games):
            box_url = game["source_url"]
            logger.info(f"\n[{i + 1}/{total}] {game['game_date']} — "
                       f"{game['away_team_name']} @ {game['home_team_name']}")

            try:
                if process_boxscore(box_url, season_year):
                    success += 1
                else:
                    failed += 1
            except Exception as e:
                logger.error(f"  Error: {e}")
                import traceback
                traceback.print_exc()
                failed += 1

            # Rate limit
            if i < total - 1:
                time.sleep(2)

    logger.info(f"\n{'='*60}")
    logger.info(f"NWAC Box Score Summary: {success} success, {failed} failed, {skipped} skipped")
    logger.info(f"{'='*60}")


if __name__ == "__main__":
    main()
