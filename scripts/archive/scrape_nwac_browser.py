#!/usr/bin/env python3
"""
NWAC Box Score Scraper — Browser-based (Playwright)
=====================================================
Uses a real Chromium browser to bypass AWS WAF on nwacsports.com.
Run this on your Mac when you need a full backfill of NWAC game data.

Usage:
    cd ~/Desktop/pnw-baseball
    pip install playwright
    python -m playwright install chromium
    PYTHONPATH=backend python3 scripts/scrape_nwac_browser.py --season 2026

Daily updates should use GitHub Actions (which handles incremental scrapes).
This script is for one-time backfills when the WAF blocks automated tools.
"""

import sys
import os
import time
import random
import argparse
import logging
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from app.models.database import get_connection

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("nwac_browser")

# Import the existing parsers and DB functions from scrape_boxscores
sys.path.insert(0, str(Path(__file__).parent))
from scrape_boxscores import (
    NWAC_TEAM_SLUGS,
    parse_presto_schedule,
    upsert_game,
    get_team_id_by_name,
    get_team_id_by_school,
    compute_team_game_score,
)

BASE_URL = "https://nwacsports.com"


def main():
    parser = argparse.ArgumentParser(description="NWAC browser-based box score scraper")
    parser.add_argument("--season", type=int, default=2026, help="Season year")
    parser.add_argument("--team", type=str, default=None, help="Single team slug (e.g. 'clark')")
    parser.add_argument("--headless", action="store_true", help="Run browser in headless mode")
    args = parser.parse_args()

    season_year = args.season
    season_str = f"{season_year - 1}-{str(season_year)[2:]}"

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Playwright not installed. Run:")
        print("  pip install playwright")
        print("  python -m playwright install chromium")
        sys.exit(1)

    # Determine which teams to scrape
    if args.team:
        slug_lookup = {v: k for k, v in NWAC_TEAM_SLUGS.items()}
        if args.team in slug_lookup:
            teams = {slug_lookup[args.team]: args.team}
        elif args.team in NWAC_TEAM_SLUGS:
            teams = {args.team: NWAC_TEAM_SLUGS[args.team]}
        else:
            print(f"Unknown team: {args.team}")
            print(f"Available: {', '.join(NWAC_TEAM_SLUGS.values())}")
            sys.exit(1)
    else:
        teams = dict(NWAC_TEAM_SLUGS)

    logger.info(f"NWAC Browser Scraper — Season {season_year}")
    logger.info(f"Teams to scrape: {len(teams)}")

    total_found = 0
    total_scraped = 0
    total_errors = 0

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=args.headless)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        # Warm up — visit the main NWAC page first
        logger.info("Warming browser session...")
        page.goto(f"{BASE_URL}/sports/bsb/{season_str}", wait_until="networkidle", timeout=30000)
        time.sleep(2)

        for db_short, slug in teams.items():
            logger.info(f"\n{'='*60}")
            logger.info(f"Scraping: {db_short} ({slug})")

            # Look up team_id
            with get_connection() as conn:
                cur = conn.cursor()
                team_id = get_team_id_by_name(cur, db_short)
                if not team_id:
                    logger.warning(f"  Team '{db_short}' not found in database — skipping")
                    total_errors += 1
                    continue

            # Fetch schedule page via real browser
            schedule_url = f"{BASE_URL}/sports/bsb/{season_str}/teams/{slug}?view=schedule"
            logger.info(f"  Fetching: {schedule_url}")

            try:
                page.goto(schedule_url, wait_until="networkidle", timeout=30000)
                time.sleep(random.uniform(1.5, 3.0))
                html = page.content()
                logger.info(f"  Got {len(html)} bytes")
            except Exception as e:
                logger.error(f"  Failed to load page: {e}")
                total_errors += 1
                continue

            if "<table" not in html:
                logger.warning(f"  No tables found in response — skipping")
                total_errors += 1
                continue

            # Parse schedule using existing parser
            schedule = parse_presto_schedule(html, BASE_URL, season_year)
            found = len(schedule)
            logger.info(f"  Found {found} completed games")
            total_found += found

            if not schedule:
                continue

            # Insert games into database
            scraped = 0
            with get_connection() as conn:
                cur = conn.cursor()

                for sched_game in schedule:
                    try:
                        opponent = sched_game.get("opponent", "")
                        # Determine home/away
                        is_away = opponent.startswith("at ") or opponent.startswith("At ")
                        if is_away:
                            opponent_clean = opponent[3:].strip()
                        else:
                            opponent_clean = opponent.lstrip("vs ").strip()
                            # Remove leading "vs" or "vs."
                            if opponent_clean.lower().startswith("vs"):
                                opponent_clean = opponent_clean[2:].lstrip(". ")

                        # Clean opponent name
                        opponent_clean = opponent_clean.rstrip(" *#")

                        ts = sched_game["team_score"]
                        os_score = sched_game["opp_score"]

                        game_data = {
                            "season": season_year,
                            "game_date": sched_game.get("date"),
                            "innings": sched_game.get("innings", 9),
                            "is_conference_game": sched_game.get("is_conference", False),
                            "game_number": sched_game.get("game_number", 1),
                            "status": "final",
                        }

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

                        # Resolve opponent team_id (prefer same division)
                        opp_id = get_team_id_by_school(cur, opponent_clean, prefer_division_of_team_id=team_id)
                        if opp_id:
                            if is_away:
                                game_data["home_team_id"] = opp_id
                            else:
                                game_data["away_team_id"] = opp_id

                        # Game score
                        winner = max(ts, os_score)
                        loser = min(ts, os_score)
                        game_data["game_score"] = compute_team_game_score(winner, loser, game_data["innings"])

                        game_id = upsert_game(cur, game_data)
                        if game_id:
                            scraped += 1
                    except Exception as e:
                        logger.error(f"    Error processing game: {e}")
                        total_errors += 1

                conn.commit()

            total_scraped += scraped
            logger.info(f"  {db_short}: {found} found, {scraped} scraped")

            # Delay between teams
            time.sleep(random.uniform(2.0, 5.0))

        browser.close()

    logger.info(f"\n{'='*60}")
    logger.info(f"SCRAPE COMPLETE")
    logger.info(f"  Teams: {len(teams)}")
    logger.info(f"  Games found: {total_found}")
    logger.info(f"  Games scraped: {total_scraped}")
    logger.info(f"  Errors: {total_errors}")
    logger.info(f"{'='*60}")


if __name__ == "__main__":
    main()
