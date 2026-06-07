#!/usr/bin/env python3
"""
WCL Schedule Scraper
====================

Walks wclstats.com/sports/bsb/{season}/schedule and writes one row per
game to `summer_games`. The schedule page renders every game in the
season — completed (with a `data-boxscore` URL), in-progress ("Live
stats"), and scheduled ahead — as a `.card.event-row` div. We extract:

  - boxscore URL (idempotency key — also drives box-score scraper)
  - date (parsed from the URL: 20260528_e3rm → 2026-05-28)
  - aria-label string ("May 28 06:35 PM: <away> at <home>: <status>")
  - classes flag (exhibition / conf / playoff)

For games with a box score the row gets `status='final'`. Otherwise
'scheduled' (or 'in_progress' if the link says "Live stats").

Teams are resolved against summer_teams via fuzzy name match. Names
that don't match are saved as-is — the box-score scraper or season
roster sync will create the team row later, and we'll re-link.

Usage:
    PYTHONPATH=backend python3 scripts/scrape_wcl_schedule.py
    PYTHONPATH=backend python3 scripts/scrape_wcl_schedule.py --season 2026
    PYTHONPATH=backend python3 scripts/scrape_wcl_schedule.py --dry-run
"""

import argparse
import logging
import random
import re
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import requests
from bs4 import BeautifulSoup

from app.models.database import get_connection
from wcl_http import mount_retries, fetch as wcl_fetch


logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("scrape_wcl_schedule")

BASE_URL = "https://wclstats.com"
LEAGUE_ABBR = "WCL"
USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
]


def get_session():
    s = requests.Session()
    s.headers.update({
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml",
        "Referer": "https://westcoastleague.com/",
    })
    mount_retries(s)
    return s


# ── Schedule HTML parsing ──────────────────────────────────────

_DATE_FROM_BOXURL = re.compile(r"/boxscores/(\d{8})_([a-z0-9]+)\.xml", re.IGNORECASE)
_ARIA_RE = re.compile(
    r"^Baseball event: (?P<date>[A-Za-z]+ \d+) (?P<time>\d{1,2}:\d{2} [AP]M):\s*"
    r"(?P<away>.+?) at (?P<home>.+?):\s*(?P<status>.+)$"
)


def _classify_status(status_text, class_list):
    """Map the schedule card to one of our status enum strings."""
    s = (status_text or "").lower()
    if "live stats" in s or "in progress" in s:
        return "in_progress"
    if "box score" in s or "recap" in s or "has-recap" in class_list:
        return "final"
    if "ppd" in s or "postponed" in s:
        return "postponed"
    return "scheduled"


def _classify_game_type(class_list):
    """Conference / exhibition / playoff inferred from div classes."""
    if "exhibition" in class_list:
        return "exhibition"
    if "playoff" in class_list:
        return "playoff"
    if "conf" in class_list:
        return "conference"
    return "regular"


def fetch_schedule(session, season):
    url = f"{BASE_URL}/sports/bsb/{season}/schedule"
    logger.info(f"GET {url}")
    # ScraperAPI's cheap tiers sometimes 200 with a contentless shell; require
    # the schedule's game cards so fetch() escalates proxy tiers until the real
    # page arrives (otherwise we'd parse 0 games and silently no-op).
    r = wcl_fetch(session, url, timeout=30, must_contain="event-row")
    r.raise_for_status()
    return r.text


def parse_schedule(html, season):
    """Return a list of dicts, one per game card on the schedule page."""
    soup = BeautifulSoup(html, "html.parser")
    games = []
    seen_box_urls = set()

    for card in soup.select("div.card.event-row"):
        classes = card.get("class") or []
        box_url = card.get("data-boxscore") or None

        # Several anchors inside the card carry aria-label (team
        # schedule, ical, etc.). We only want the one describing the
        # game itself — its label starts with "Baseball event:".
        aria_label = None
        for a in card.find_all("a", attrs={"aria-label": True}):
            lbl = a.get("aria-label", "").strip()
            if lbl.startswith("Baseball event:"):
                aria_label = lbl
                break

        away_name = None
        home_name = None
        time_str = None
        status_text = None
        if aria_label:
            m = _ARIA_RE.match(aria_label.strip())
            if m:
                away_name = m.group("away").strip()
                home_name = m.group("home").strip()
                time_str = m.group("time").strip()
                status_text = m.group("status").strip()

        # Date comes from box-score URL when present; otherwise we
        # rely on the schedule page rendering the year correctly in
        # nearby <time> elements.
        game_date = None
        box_code = None
        if box_url:
            m = _DATE_FROM_BOXURL.search(box_url)
            if m:
                game_date = datetime.strptime(m.group(1), "%Y%m%d").date()
                box_code = f"{m.group(1)}_{m.group(2)}"
        if game_date is None:
            time_tag = card.find("time", attrs={"datetime": True})
            if time_tag:
                raw = time_tag["datetime"]
                # Format is usually "2026-06-04T19:05:00-07:00"
                try:
                    game_date = datetime.fromisoformat(raw[:10]).date()
                except ValueError:
                    pass

        canonical_box_url = f"{BASE_URL}{box_url}" if box_url else None

        # Dedup on box URL when available, otherwise on (date, away, home)
        dedup_key = canonical_box_url or (game_date, away_name, home_name, time_str)
        if dedup_key in seen_box_urls:
            continue
        seen_box_urls.add(dedup_key)

        # Skip cards we can't identify at all (junk rows)
        if not (game_date and away_name and home_name):
            continue

        games.append({
            "season": season,
            "game_date": game_date,
            "game_time": time_str,
            "away_team_name": away_name,
            "home_team_name": home_name,
            "status": _classify_status(status_text, classes),
            "game_type": _classify_game_type(classes),
            "source_url": canonical_box_url,
            "boxscore_code": box_code,
            "aria_label": aria_label,
        })

    games.sort(key=lambda g: (g["game_date"], g.get("game_time") or ""))
    return games


# ── DB writes ──────────────────────────────────────────────────

def get_league_id(cur, abbr):
    cur.execute("SELECT id FROM summer_leagues WHERE abbreviation = %s", (abbr,))
    row = cur.fetchone()
    if not row:
        raise RuntimeError(
            f"summer_leagues row for '{abbr}' missing — run migrate_summer_stats.sql first"
        )
    return row["id"]


def _normalize_name(name):
    """Lowercase + strip punct for fuzzy team match."""
    return re.sub(r"[^a-z0-9]+", "", (name or "").lower())


def build_team_lookup(cur, league_id):
    """Return dict normalized_name -> summer_teams.id for fuzzy match."""
    cur.execute(
        "SELECT id, name, short_name FROM summer_teams WHERE league_id = %s",
        (league_id,),
    )
    lookup = {}
    for row in cur.fetchall():
        tid = row["id"]
        if row.get("name"):
            lookup[_normalize_name(row["name"])] = tid
        if row.get("short_name"):
            lookup[_normalize_name(row["short_name"])] = tid
    return lookup


def resolve_team_id(team_lookup, name):
    """Best-effort name → summer_teams.id. Returns None if no match."""
    if not name:
        return None
    key = _normalize_name(name)
    if key in team_lookup:
        return team_lookup[key]
    # Fallback: longest-prefix match (handles "Northwest Star Nighthawks"
    # vs stored "NW Star Nighthawks", etc.)
    for k, v in team_lookup.items():
        if k and (k in key or key in k) and len(k) >= 6:
            return v
    return None


def upsert_game(cur, league_id, game, team_lookup):
    """Insert a new game or refresh status / scores on an existing row."""
    away_id = resolve_team_id(team_lookup, game["away_team_name"])
    home_id = resolve_team_id(team_lookup, game["home_team_name"])

    # When we already have a box-score URL the source_url is the
    # idempotency key. For scheduled games (no box URL yet) we fall
    # back to (league, season, date, away, home) — boxscore_code
    # arrives later when the game is played.
    if game["source_url"]:
        cur.execute(
            "SELECT id FROM summer_games WHERE source_url = %s",
            (game["source_url"],),
        )
    else:
        cur.execute(
            """
            SELECT id FROM summer_games
            WHERE league_id = %s AND season = %s AND game_date = %s
              AND away_team_name = %s AND home_team_name = %s
              AND source_url IS NULL
            """,
            (league_id, game["season"], game["game_date"],
             game["away_team_name"], game["home_team_name"]),
        )
    existing = cur.fetchone()

    if existing:
        cur.execute(
            """
            UPDATE summer_games
            SET status         = %s,
                game_date      = %s,
                away_team_id   = COALESCE(%s, away_team_id),
                home_team_id   = COALESCE(%s, home_team_id),
                away_team_name = %s,
                home_team_name = %s,
                source_url     = COALESCE(%s, source_url),
                boxscore_code  = COALESCE(%s, boxscore_code),
                updated_at     = CURRENT_TIMESTAMP
            WHERE id = %s
            """,
            (game["status"], game["game_date"], away_id, home_id,
             game["away_team_name"], game["home_team_name"],
             game["source_url"], game["boxscore_code"], existing["id"]),
        )
        return existing["id"], "updated"

    cur.execute(
        """
        INSERT INTO summer_games (
            league_id, season, game_date, status,
            away_team_id, home_team_id,
            away_team_name, home_team_name,
            source_url, boxscore_code
        ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        RETURNING id
        """,
        (league_id, game["season"], game["game_date"], game["status"],
         away_id, home_id,
         game["away_team_name"], game["home_team_name"],
         game["source_url"], game["boxscore_code"]),
    )
    return cur.fetchone()["id"], "inserted"


# ── Entry point ────────────────────────────────────────────────

def run(season, dry_run=False):
    session = get_session()
    html = fetch_schedule(session, season)
    games = parse_schedule(html, season)
    logger.info(f"Parsed {len(games)} games from {season} schedule")

    counts = {"inserted": 0, "updated": 0, "scheduled": 0, "final": 0, "in_progress": 0}
    for g in games:
        counts[g["status"]] = counts.get(g["status"], 0) + 1

    logger.info(
        f"Status breakdown — final: {counts.get('final', 0)} · "
        f"in_progress: {counts.get('in_progress', 0)} · "
        f"scheduled: {counts.get('scheduled', 0)}"
    )

    if dry_run:
        for g in games[:5]:
            logger.info(f"  {g['game_date']} {g['away_team_name']} @ {g['home_team_name']} "
                        f"[{g['status']}, {g['game_type']}]")
        if len(games) > 5:
            logger.info(f"  ... and {len(games) - 5} more")
        return

    with get_connection() as conn:
        cur = conn.cursor()
        league_id = get_league_id(cur, LEAGUE_ABBR)
        team_lookup = build_team_lookup(cur, league_id)
        for g in games:
            _, action = upsert_game(cur, league_id, g, team_lookup)
            counts[action] = counts.get(action, 0) + 1
        conn.commit()

    logger.info(
        f"DB writes — inserted: {counts.get('inserted', 0)} · "
        f"updated: {counts.get('updated', 0)}"
    )
    time.sleep(random.uniform(0.5, 1.2))


def main():
    parser = argparse.ArgumentParser(description="Scrape WCL schedule")
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--dry-run", action="store_true",
                        help="Parse + print, do not write to DB")
    args = parser.parse_args()
    run(args.season, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
