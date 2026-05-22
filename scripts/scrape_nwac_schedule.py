#!/usr/bin/env python3
"""
NWAC Schedule Scraper — Game Results via ScraperAPI
====================================================
Fetches the NWAC master baseball schedule page through ScraperAPI
(bypasses AWS WAF) and upserts game results into the database.

This script is designed to run daily via GitHub Actions.

Usage (local):
    PYTHONPATH=backend SCRAPER_API_KEY=your_key python3 scripts/scrape_nwac_schedule.py

Usage (GitHub Actions):
    Runs automatically on schedule — see .github/workflows/nwac-schedule.yml
"""

import sys
import os
import re
import json
import logging
from pathlib import Path

# Setup path for imports
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
sys.path.insert(0, str(Path(__file__).parent))

import requests
from bs4 import BeautifulSoup
from app.models.database import get_connection
from scrape_boxscores import (
    get_team_id_by_name,
    get_team_id_by_school,
    upsert_game,
    compute_team_game_score,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("nwac_schedule")

# ── Team name mapping: schedule page display name → DB short_name ──
# Most names match directly, but some differ
SCHEDULE_NAME_TO_DB = {
    "Skagit Valley": "Skagit",
    "Mt Hood": "Mt. Hood",
    "SW Oregon": "SW Oregon",
    "Linn-Benton": "Linn-Benton",
}

# All NWAC member teams (DB short_names) for identifying conference matchups
NWAC_TEAMS = {
    "Bellevue", "Big Bend", "Blue Mountain", "Centralia", "Chemeketa",
    "Clackamas", "Clark", "Columbia Basin", "Douglas", "Edmonds",
    "Everett", "Grays Harbor", "Lane", "Linn-Benton",
    "Lower Columbia", "Mt. Hood", "Olympic", "Pierce", "Shoreline",
    "Skagit", "SW Oregon", "Spokane", "Tacoma", "Treasure Valley",
    "Umpqua", "Walla Walla", "Wenatchee Valley", "Yakima Valley",
}

# NWAC playoff bracket prefixes. Two flavors appear in front of team
# names during the postseason:
#   • Regional seeds: N1-N4, S1-S4, E1-E4, W1-W4  (e.g. "E4 Yakima Valley")
#   • Super-regional winner codes: NSR/SSR/ESR/WSR (e.g. "WSR Pierce")
# Both label the 8-team championship field on the composite scoreboard.
SEED_PREFIX_RE = re.compile(r"^[NSEW](?:[1-4]|SR)\s+", re.IGNORECASE)


def strip_seed_prefix(name):
    """Strip NWAC playoff seed prefix (e.g. "E4 Yakima Valley" → "Yakima
    Valley", "WSR Pierce" → "Pierce")."""
    if not name:
        return name
    return SEED_PREFIX_RE.sub("", name).strip()


def is_tbd_opponent(name):
    """
    Detect TBD opponent rows like "W4 Clark/S3 Umpqua" — meaning the
    opponent is the winner of that single-elim game. These appear on the
    schedule for the #2 seed that hosts the super regional. They aren't
    real matchups yet and should be skipped until the bracket advances.
    """
    return name and "/" in name


def resolve_team_name(display_name):
    """Convert schedule page display name to DB short_name."""
    # Strip leading "vs "/"at " location indicators first — the composite
    # scoreboard shows tournament games as e.g. "vs N1 Everett" — then the
    # NWAC playoff seed prefix ("E4 Yakima Valley" → "Yakima Valley",
    # "WSR Pierce" → "Pierce").
    name = re.sub(r"^(?:at|vs)\.?\s+", "", display_name or "", flags=re.IGNORECASE).strip()
    name = strip_seed_prefix(name)
    # Check explicit mapping next
    if name in SCHEDULE_NAME_TO_DB:
        return SCHEDULE_NAME_TO_DB[name]
    # Most names match directly
    if name in NWAC_TEAMS:
        return name
    # Return as-is for non-NWAC teams (opponents)
    return name


def scraperapi_fetch(api_key, target_url, min_size=3000, label="page"):
    """GET target_url through ScraperAPI, escalating proxy tiers if the
    NWAC AWS WAF returns its tiny challenge page.

    The NWAC site blocks datacenter IPs intermittently — a standard
    ScraperAPI request usually works but sometimes comes back as a ~2 KB
    challenge page. When that happens we retry on the premium (residential)
    and then ultra-premium proxy pools, which get past the WAF reliably.

    Returns the page HTML, or None if every tier was blocked.
    """
    tiers = [
        ("standard", {}),
        ("premium", {"premium": "true"}),
        ("ultra_premium", {"ultra_premium": "true"}),
    ]
    last_size = 0
    for tier_name, extra in tiers:
        params = {"api_key": api_key, "url": target_url}
        params.update(extra)
        try:
            resp = requests.get("http://api.scraperapi.com", params=params, timeout=120)
            resp.raise_for_status()
        except Exception as e:
            logger.warning(f"{label}: ScraperAPI {tier_name} request failed: {e}")
            continue
        last_size = len(resp.text)
        if last_size >= min_size and "captcha" not in resp.text.lower():
            logger.info(f"{label}: got {last_size:,} bytes via {tier_name} proxy")
            return resp.text
        logger.warning(f"{label}: blocked via {tier_name} proxy (size={last_size})")
    logger.warning(f"{label}: all proxy tiers blocked (last size={last_size})")
    return None


def fetch_schedule(api_key, season_year):
    """Fetch the NWAC master schedule page via ScraperAPI."""
    season_str = f"{season_year - 1}-{str(season_year)[2:]}"
    schedule_url = f"https://nwacsports.com/sports/bsb/{season_str}/schedule"

    logger.info(f"Fetching NWAC schedule: {schedule_url}")

    html = scraperapi_fetch(api_key, schedule_url, min_size=5000, label="Schedule page")
    if html is None:
        raise RuntimeError("Schedule page blocked on all ScraperAPI proxy tiers.")
    return html


def _infer_date_from_cell(date_text, current_date, season_year):
    """
    Infer a full date from the schedule page date cell text.

    Date cells show e.g. "Tue. 8" or "Sun. 14" — day-of-week + day number only.
    We infer the month from the current_date context (schedule is chronological).
    """
    import datetime

    # Extract day number from text like "Tue. 8" or "Sun 14"
    day_match = re.search(r'(\d+)', date_text)
    if not day_match:
        return None

    day = int(day_match.group(1))

    if current_date:
        # Start from the month of the last known date
        month = current_date.month
        year = current_date.year

        # If the new day < current day, we've rolled into the next month
        if day < current_date.day - 15:  # Allow for reasonable date jumps
            month += 1
            if month > 12:
                month = 1
                year += 1

        try:
            return datetime.date(year, month, day)
        except ValueError:
            pass

    # Fallback: try common baseball months (Feb-Jun) in the season year
    for month in (2, 3, 4, 5, 6):
        try:
            candidate = datetime.date(season_year, month, day)
            return candidate
        except ValueError:
            continue

    return None


def parse_schedule_page(html, season_year):
    """
    Parse the NWAC master schedule HTML table into game dicts.

    Each row has:
      - date cell (day-of-week + day number only, e.g. "Sun. 14")
      - away team + conference indicator (*)
      - away score (class contains 'awayresult')
      - home team
      - home score (class contains 'homeresult')
      - status (Final, Final - 7 innings, etc.)
      - links (box score URL containing full date as YYYYMMDD)

    Dates are extracted from box score URLs when available (most reliable),
    then inferred from date cells using context for scheduled games.
    """
    import datetime

    soup = BeautifulSoup(html, "html.parser")
    games = []

    rows = soup.find_all("tr")
    logger.info(f"Found {len(rows)} table rows total")

    current_date = None
    games_final = 0
    games_scheduled = 0
    games_skipped = 0

    # Get today's date in Pacific time for filtering scheduled games
    try:
        from zoneinfo import ZoneInfo
        today = datetime.datetime.now(ZoneInfo("America/Los_Angeles")).date()
    except Exception:
        today = datetime.date.today()

    for row in rows:
        cells = row.find_all("td")
        if len(cells) < 4:
            continue

        # Extract components by class name
        away_team_cell = row.find("td", class_="awayteam")
        home_team_cell = row.find("td", class_="hometeam")
        away_score_cell = row.find("td", class_=re.compile(r"awayresult"))
        home_score_cell = row.find("td", class_=re.compile(r"homeresult"))
        status_cell = row.find("td", class_="status")
        links_cell = row.find("td", class_="links")
        date_cell = row.find("td", class_=re.compile(r"date|day"))

        # Must have both teams
        if not away_team_cell or not home_team_cell:
            continue

        # Parse team names (strip conference *, ^, #, and whitespace)
        away_name = away_team_cell.get_text(strip=True).rstrip("*^# ").strip()
        home_name = home_team_cell.get_text(strip=True).rstrip("*^# ").strip()

        if not away_name or not home_name:
            continue

        # Skip TBD playoff opponents like "W4 Clark/S3 Umpqua"
        if is_tbd_opponent(away_name) or is_tbd_opponent(home_name):
            logger.info(f"SKIP(tbd-opp): {away_name} @ {home_name}")
            games_skipped += 1
            continue

        # Check if conference game (has * notation)
        is_conference = bool(away_team_cell.find("span", class_="notation"))

        # Parse status
        status_text = status_cell.get_text(strip=True) if status_cell else ""
        is_final = "Final" in status_text

        # Parse scores (may be empty for scheduled games)
        away_score = None
        home_score = None
        if away_score_cell and home_score_cell:
            away_score_text = away_score_cell.get_text(strip=True)
            home_score_text = home_score_cell.get_text(strip=True)
            try:
                away_score = int(away_score_text)
                home_score = int(home_score_text)
            except (ValueError, TypeError):
                pass

        # For final games, require valid scores
        if is_final and (away_score is None or home_score is None):
            logger.info(f"SKIP(no-scores): {away_name} @ {home_name} status='{status_text}'")
            games_skipped += 1
            continue

        # Parse innings from status (e.g., "Final - 7 innings")
        innings = 9 if is_final else None
        if is_final:
            innings_match = re.search(r"(\d+)\s*inning", status_text)
            if innings_match:
                innings = int(innings_match.group(1))

        # Parse box score URL and extract date from it
        box_score_url = None
        game_date = None

        if links_cell:
            link = links_cell.find("a", href=re.compile(r"boxscores/"))
            if link:
                href = link.get("href", "")
                if href.startswith("/"):
                    box_score_url = f"https://nwacsports.com{href}"
                elif href.startswith("http"):
                    box_score_url = href

                # Extract date from URL: /boxscores/YYYYMMDD_xxxx.xml
                date_match = re.search(r"boxscores/(\d{4})(\d{2})(\d{2})_", href)
                if date_match:
                    try:
                        game_date = datetime.date(
                            int(date_match.group(1)),
                            int(date_match.group(2)),
                            int(date_match.group(3)),
                        )
                        current_date = game_date
                    except ValueError:
                        pass

        # For scheduled games, try to get date from the date cell
        if not game_date and date_cell:
            date_text = date_cell.get_text(strip=True)
            if date_text:
                inferred = _infer_date_from_cell(date_text, current_date, season_year)
                if inferred:
                    game_date = inferred
                    current_date = game_date

        # Fall back to current_date for games without box score links
        if not game_date:
            game_date = current_date
            if not is_final and game_date:
                logger.debug(f"Date fallback for scheduled: {away_name} @ {home_name} → {game_date} (from last known date)")

        if not game_date:
            logger.info(f"SKIP(no-date): {away_name} @ {home_name} final={is_final} status='{status_text}'")
            games_skipped += 1
            continue

        # For scheduled games, only include recent and upcoming (not old unscored games)
        # Use a 3-day buffer since date inference from date cells can be off by a day
        import datetime as _dt_mod
        if not is_final and game_date < today - _dt_mod.timedelta(days=3):
            logger.info(f"SKIP(old-sched): {away_name} @ {home_name} on {game_date}")
            games_skipped += 1
            continue

        # Resolve team names to DB short_names
        away_db_name = resolve_team_name(away_name)
        home_db_name = resolve_team_name(home_name)

        # Detect doubleheaders — check ALL previous games, not just the last one
        game_number = 1
        for prev in games:
            if (prev["game_date"] == game_date
                    and prev["away_team_name"] == away_db_name
                    and prev["home_team_name"] == home_db_name):
                game_number = max(game_number, prev["game_number"] + 1)

        game = {
            "season": season_year,
            "game_date": game_date,
            "away_team_name": away_db_name,
            "home_team_name": home_db_name,
            "away_score": away_score,
            "home_score": home_score,
            "innings": innings,
            "is_conference_game": is_conference,
            "game_number": game_number,
            "status": "final" if is_final else "scheduled",
            "source_url": box_score_url,
        }

        games.append(game)
        if is_final:
            games_final += 1
        else:
            games_scheduled += 1

    logger.info(f"Parsed {games_final} final + {games_scheduled} scheduled games, skipped {games_skipped}")
    return games


def resolve_team_ids(cur, games):
    """Look up team IDs for all games. Modifies games in place."""
    # Cache lookups to avoid repeated queries
    id_cache = {}

    for game in games:
        for role in ["away", "home"]:
            name = game[f"{role}_team_name"]

            if name in id_cache:
                team_id = id_cache[name]
            else:
                # Try exact match by short_name first
                team_id = get_team_id_by_name(cur, name)
                if not team_id:
                    # Fuzzy match by school name
                    team_id = get_team_id_by_school(cur, name)
                id_cache[name] = team_id

            if team_id:
                game[f"{role}_team_id"] = team_id


def fetch_composite_today(api_key, season_year):
    """
    Fetch today's games from the NWAC composite schedule page.

    The composite page (nwacsports.com/sports/bsb/composite) defaults to
    showing today's games and updates much faster than the master schedule
    page. This catches same-day results that the schedule page misses.
    """
    import datetime
    try:
        from zoneinfo import ZoneInfo
        today = datetime.datetime.now(ZoneInfo("America/Los_Angeles")).date()
    except Exception:
        today = datetime.date.today()

    composite_url = "https://nwacsports.com/sports/bsb/composite"
    logger.info(f"Fetching NWAC composite page for today ({today}): {composite_url}")

    html = scraperapi_fetch(api_key, composite_url, min_size=3000, label="Composite page")
    if html is None:
        return []

    soup = BeautifulSoup(html, "html.parser")
    games = []

    # Each game is in an .event-box div containing two .team divs
    event_boxes = soup.select(".event-box")
    logger.info(f"Found {len(event_boxes)} event boxes on composite page")

    for box in event_boxes:
        teams = box.select(".team")
        if len(teams) != 2:
            continue

        # Parse team names and scores
        team_data = []
        for team_div in teams:
            name_el = team_div.select_one(".team-name a") or team_div.select_one(".team-name")
            score_el = team_div.select_one(".result")
            name = name_el.get_text(" ", strip=True) if name_el else ""
            # Strip "at " prefix from home team (handles "at\nTeam" and "at Team")
            name = re.sub(r"^at\s+", "", name).strip()
            # Strip conference indicators
            name = name.rstrip("*^# ").strip()
            score = None
            if score_el:
                try:
                    score = int(score_el.get_text(strip=True))
                except (ValueError, TypeError):
                    pass
            team_data.append({"name": name, "score": score})

        away, home = team_data[0], team_data[1]
        if not away["name"] or not home["name"]:
            continue

        # Skip TBD playoff opponents like "W4 Clark/S3 Umpqua"
        if is_tbd_opponent(away["name"]) or is_tbd_opponent(home["name"]):
            logger.info(f"SKIP(tbd-opp): {away['name']} @ {home['name']}")
            continue

        # Get box score URL and extract date
        box_link = box.select_one("a[href*='boxscore']")
        box_score_url = None
        game_date = today  # Default to today since this is the composite/today page

        if box_link:
            href = box_link.get("href", "")
            if href.startswith("/"):
                box_score_url = f"https://nwacsports.com{href}"
            elif href.startswith("http"):
                box_score_url = href

            # Extract date from URL: /boxscores/YYYYMMDD_xxxx.xml
            date_match = re.search(r"boxscores/(\d{4})(\d{2})(\d{2})_", href)
            if date_match:
                try:
                    game_date = datetime.date(
                        int(date_match.group(1)),
                        int(date_match.group(2)),
                        int(date_match.group(3)),
                    )
                except ValueError:
                    pass

        # Get status (Final, Final - 7 innings, etc.)
        status_el = box.select_one(".event-status") or box.select_one("[class*='status']")
        status_text = status_el.get_text(strip=True) if status_el else ""
        # A game is complete ONLY when its status explicitly reads "Final".
        # Do NOT treat "both scores present" as final: an in-progress game
        # (e.g. 3-2 in the 5th) also shows both scores, and recording it as
        # final would push a non-final result onto the bracket/odds before
        # the game is actually over. Mirrors the schedule-page parser.
        is_final = "final" in status_text.lower()

        # A final game must have real scores; skip if the box hasn't posted
        # them yet (don't write a scoreless "final").
        if is_final and (away["score"] is None or home["score"] is None):
            logger.info(f"SKIP(no-scores): {away['name']} @ {home['name']} status='{status_text}'")
            continue

        # We record NON-final games too (status='scheduled'), as long as the
        # composite gave us a box-score URL. The composite is the ONLY page
        # that lists NWAC postseason games and it only shows the CURRENT day,
        # so capturing the (permanent) box-score URL now lets the box-score
        # scraper finalize a late game later by fetching the URL directly —
        # even after the composite has rolled over to the next day. Without a
        # URL there's nothing to come back to, so skip those.
        if not is_final and not box_score_url:
            continue

        # Parse innings from status
        innings = 9
        innings_match = re.search(r"(\d+)\s*inning", status_text)
        if innings_match:
            innings = int(innings_match.group(1))

        # Resolve team names
        away_db_name = resolve_team_name(away["name"])
        home_db_name = resolve_team_name(home["name"])

        # Check for conference game (name had * suffix)
        is_conference = away_db_name in NWAC_TEAMS and home_db_name in NWAC_TEAMS

        # Detect doubleheaders
        game_number = 1
        for prev in games:
            if (prev["game_date"] == game_date
                    and prev["away_team_name"] == away_db_name
                    and prev["home_team_name"] == home_db_name):
                game_number = max(game_number, prev["game_number"] + 1)

        games.append({
            "season": season_year,
            "game_date": game_date,
            "away_team_name": away_db_name,
            "home_team_name": home_db_name,
            # Only store scores for FINAL games; a scheduled/in-progress row
            # keeps null scores so a live score never reaches the bracket.
            "away_score": away["score"] if is_final else None,
            "home_score": home["score"] if is_final else None,
            "innings": innings,
            "is_conference_game": is_conference,
            "game_number": game_number,
            "status": "final" if is_final else "scheduled",
            "source_url": box_score_url,
        })

    n_final = sum(1 for g in games if g["status"] == "final")
    logger.info(f"Parsed {len(games)} games from composite page "
                f"({n_final} final, {len(games) - n_final} scheduled w/ box-score URL)")
    return games


def main():
    api_key = os.environ.get("SCRAPER_API_KEY")
    if not api_key:
        logger.error("SCRAPER_API_KEY environment variable not set")
        sys.exit(1)

    season_year = int(os.environ.get("SEASON_YEAR", "2026"))
    logger.info(f"NWAC Schedule Scraper — Season {season_year}")

    # ── 1. Fetch composite page for today's games (fast-updating) ──
    composite_games = fetch_composite_today(api_key, season_year)

    # ── 2. Fetch master schedule page for full season ──
    # The full-season schedule page is sometimes WAF-blocked (ScraperAPI
    # returns a tiny challenge page). When that happens we must NOT abort:
    # the composite page above already has today's completed games, which
    # is what live updates (e.g. tournament results) depend on. Treat a
    # schedule-page failure as a soft miss and continue with composite only.
    games = []
    try:
        html = fetch_schedule(api_key, season_year)
        games = parse_schedule_page(html, season_year)
    except Exception as e:
        logger.warning(
            f"Schedule page unavailable ({e}); continuing with "
            f"{len(composite_games)} composite game(s) only."
        )

    if not games and not composite_games:
        logger.warning("No games found on either page")
        return

    # Merge composite games into the main list — composite games take priority
    # for today since they update faster than the schedule page
    composite_urls = {g["source_url"] for g in composite_games if g.get("source_url")}
    # Remove schedule-page games that duplicate composite games (same box score URL)
    games = [g for g in games if g.get("source_url") not in composite_urls]
    all_games = composite_games + games

    logger.info(f"Processing {len(all_games)} games ({len(composite_games)} from composite, {len(games)} from schedule)...")

    # Resolve team IDs and upsert into database
    inserted = 0
    updated = 0
    errors = 0

    with get_connection() as conn:
        cur = conn.cursor()

        # Resolve all team IDs
        resolve_team_ids(cur, all_games)

        for game in all_games:
            try:
                # Compute game score (only for final games with scores)
                if game["status"] == "final" and game["home_score"] is not None and game["away_score"] is not None:
                    winner_score = max(game["home_score"], game["away_score"])
                    loser_score = min(game["home_score"], game["away_score"])
                    game["game_score"] = compute_team_game_score(
                        winner_score, loser_score, game["innings"] or 9
                    )

                # Check if this game already exists
                existing = None
                if game.get("source_url"):
                    cur.execute(
                        "SELECT id FROM games WHERE source_url = %s",
                        (game["source_url"],),
                    )
                    existing = cur.fetchone()

                game_id = upsert_game(cur, game)
                if game_id:
                    if existing:
                        updated += 1
                    else:
                        inserted += 1
            except Exception as e:
                logger.error(f"Error processing game {game['game_date']} "
                           f"{game['away_team_name']} @ {game['home_team_name']}: {e}")
                errors += 1

        conn.commit()

    logger.info("=" * 60)
    logger.info("SCRAPE COMPLETE")
    logger.info(f"  Total games: {len(all_games)} ({len(composite_games)} composite + {len(games)} schedule)")
    logger.info(f"  Inserted: {inserted}")
    logger.info(f"  Updated: {updated}")
    logger.info(f"  Errors: {errors}")

    # Log unresolved teams
    unresolved = set()
    for game in all_games:
        if not game.get("away_team_id"):
            unresolved.add(game["away_team_name"])
        if not game.get("home_team_id"):
            unresolved.add(game["home_team_name"])

    if unresolved:
        logger.info(f"  Unresolved teams ({len(unresolved)}): {sorted(unresolved)}")

    logger.info("=" * 60)


if __name__ == "__main__":
    main()
