#!/usr/bin/env python3
"""
Backfill historical D1 boxscores for coverage-gap teams (UW, Seattle U) by
driving the existing scraper with a game list harvested from the season STATS
page instead of the schedule page.

Why: Sidearm schedule pages only serve the *current* season, so UW/Seattle U
2023-2025 home games (vs untracked OOC opponents) were never ingested — they
appear in our DB only as road games scraped from other PNW teams' sites. But
the season stats page (/sports/baseball/stats/<year>) DOES serve history and
lists every game's boxscore id, and the v2 API serves any boxscore by id.

Approach: harvest boxscore ids from the stats page, fetch each via the v2 API
to build the schedule dicts the scraper expects, monkeypatch
parse_sidearm_schedule to return them, then call scrape_team_boxscores — reusing
all of its opponent-resolution / dedup / player-matching / batting-pitching
ingest logic. upsert_game dedups against games already present from opponents'
scrapes, so this only adds the missing ones.

Usage:
    PYTHONPATH=backend python3 scripts/backfill_d1_stats_page.py --team UW --season 2024 --dry-run
    PYTHONPATH=backend python3 scripts/backfill_d1_stats_page.py --team UW --season 2024 --apply
"""
import sys, re, json, random, argparse, logging
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
sys.path.insert(0, str(Path(__file__).parent))

import requests
import scrape_boxscores as sb
from scrape_boxscores import (
    SIDEARM_API_TENANTS, USER_AGENTS, fetch_page, D1_TEAMS, scrape_team_boxscores,
)

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)


def harvest_boxscore_ids(base_url, sport, season):
    """Return ordered unique boxscore ids from the season stats page."""
    html = fetch_page(f"{base_url}/sports/{sport}/stats/{season}") or ""
    ids = []
    seen = set()
    for m in re.finditer(r"/boxscore/(\d+)", html):
        bid = m.group(1)
        if bid not in seen:
            seen.add(bid)
            ids.append(bid)
    return ids, html


def api_boxscore(base_url, bid, tenant):
    try:
        r = requests.get(f"{base_url}/api/v2/stats/boxscore/{bid}",
                         headers={"tenant": tenant, "Accept": "application/json",
                                  "User-Agent": random.choice(USER_AGENTS)}, timeout=20)
        if r.status_code == 204:
            return None
        r.raise_for_status()
        return r.json()
    except Exception as e:
        logger.warning(f"  api fail {bid}: {e}")
        return None


def _parse_date(s):
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
        try:
            return datetime.strptime(s.strip(), fmt).date()
        except (ValueError, AttributeError):
            continue
    return None


def build_schedule(base_url, sport, season, tenant, db_short):
    """Build the schedule-dict list the scraper expects, from the stats page + API."""
    ids, _ = harvest_boxscore_ids(base_url, sport, season)
    logger.info(f"  {db_short} {season}: {len(ids)} boxscore ids on stats page")
    games = []
    for bid in ids:
        d = api_boxscore(base_url, bid, tenant)
        if not d:
            continue
        gdate = _parse_date(str((d.get("venue") or {}).get("date") or d.get("gameDate") or ""))
        if not gdate or gdate.year != season:
            continue  # stale/cross-season link
        is_home = bool(d.get("thisTeamIsHomeTeam"))
        hs, vs = sb._safe_int(d.get("homeTeamScore")), sb._safe_int(d.get("visitingTeamScore"))
        if hs is None or vs is None:
            continue
        team_score = hs if is_home else vs
        opp_score = vs if is_home else hs
        opponent = d.get("visitingTeamName") if is_home else d.get("homeTeamName")
        games.append({
            "date": gdate,
            "opponent": opponent,
            "team_score": team_score,
            "opp_score": opp_score,
            "is_away": not is_home,
            "is_conference": bool(d.get("isALeagueGame")),
            "innings": 9,
            "game_number": 1,
            "location": (d.get("venue") or {}).get("location"),
            "box_score_url": f"{base_url}/sports/{sport}/stats/{season}/x/boxscore/{bid}",
        })
    # assign game_number for doubleheaders
    from collections import Counter
    dc = Counter(g["date"] for g in games)
    seen = Counter()
    for g in sorted(games, key=lambda x: x["date"]):
        seen[g["date"]] += 1
        if dc[g["date"]] > 1:
            g["game_number"] = seen[g["date"]]
    return sorted(games, key=lambda x: (x["date"], x["game_number"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--team", required=True)
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    config = D1_TEAMS[args.team]
    base_url, sport, platform = config
    tenant = SIDEARM_API_TENANTS.get(base_url)
    if not tenant:
        logger.error(f"{args.team} ({base_url}) has no v2 API tenant — cannot backfill this way")
        sys.exit(1)

    schedule = build_schedule(base_url, sport, args.season, tenant, args.team)
    home = [g for g in schedule if not g["is_away"]]
    away = [g for g in schedule if g["is_away"]]
    logger.info(f"  built schedule: {len(schedule)} games ({len(home)} home, {len(away)} away)")
    for g in schedule[:8]:
        logger.info(f"    {g['date']} g{g['game_number']} {'@' if g['is_away'] else 'vs'} "
                    f"{g['opponent']} {g['team_score']}-{g['opp_score']} loc={g['location']}")

    if args.dry_run:
        logger.info("  (dry-run: not ingesting)")
        return

    if args.apply:
        # Drive the existing scraper with our harvested schedule.
        sb.parse_sidearm_schedule = lambda *a, **k: schedule
        sb._parse_sidearm_schedule_v3 = lambda *a, **k: schedule
        found, scraped, errors = scrape_team_boxscores(args.team, config, args.season)
        logger.info(f"  scrape_team_boxscores: found={found} scraped={scraped} errors={errors}")


if __name__ == "__main__":
    main()
