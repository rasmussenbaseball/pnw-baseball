#!/usr/bin/env python3
"""
Repair corrupted home/away assignment for D1 team-seasons in the games table.

Background
----------
The D1 schedule parsers historically defaulted nearly every game to "home"
when they couldn't read an at/vs indicator (CLAUDE.md §10.16). The 2026-only
``fix_home_away.py`` re-read schedule pages, but:
  * those pages only serve the *current* season, so 2023-2025 was never fixed;
  * Oregon / Oregon St. / Wash. St. were missed even for 2026.

Result (status='final'):
  * Gonzaga / Oregon / Oregon St. / Portland / Wash. St. 2023-2025 (and OSU /
    Oregon / WSU 2026): ~50 home / ~5 away — implausible. **Labeling bug,
    full coverage.** Fixable here.
  * UW / Seattle U 2023-2025: 0 home, only road appearances scraped from other
    teams' sites. **Coverage gap** — needs a backfill scrape, NOT this script.

Also: ``is_neutral_site`` is FALSE for every D1 game, so early-season
tournament games at neutral parks are miscredited as home parks. We set it
from the Sidearm v2 API where available.

Authority
---------
The boxscore page is the permanent source of truth (schedule pages are not).
  * Tenant teams (UW/Oregon/OSU/WSU): the v2 JSON API gives
    ``thisTeamIsHomeTeam`` + ``isNeutral`` + ``venue`` directly.
  * Older Sidearm (Gonzaga/Portland): no API, but the rendered linescore lists
    the visitor first and home second. We match the boxscore's two scores
    against the game's known scores (baseball has no ties → definitive).

A pure home/away swap does NOT change any player's real team_id, so
game_batting / game_pitching / game_events need no edits (verified separately);
unlike the §10.2 team-identity case, the stat rows already point at the right
teams. We only rewrite the paired columns on the ``games`` row.

Usage
-----
    # 1. fetch every boxscore once, cache truth to disk (slow, ~20-30 min)
    PYTHONPATH=backend python3 scripts/repair_d1_home_away.py --collect

    # 2. show proposed changes from cache (fast, no writes)
    PYTHONPATH=backend python3 scripts/repair_d1_home_away.py --dry-run

    # 3. apply (writes games rows inside one transaction per team-season)
    PYTHONPATH=backend python3 scripts/repair_d1_home_away.py --apply
"""
import sys
import os
import re
import json
import time
import random
import argparse
import logging
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
sys.path.insert(0, str(Path(__file__).parent))

import requests
from app.models.database import get_connection
from scrape_boxscores import (
    SIDEARM_API_TENANTS, USER_AGENTS, fetch_page, parse_sidearm_boxscore,
)

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

# Domain -> our team_id.  These are the D1 PNW programs we scrape directly.
DOMAIN_TEAM = {
    "osubeavers.com": 3,
    "goducks.com": 2,
    "gozags.com": 483,
    "wsucougars.com": 4,
    "gohuskies.com": 1,
    "portlandpilots.com": 482,
    "goseattleu.com": 484,
}
TEAM_BASEURL = {
    3: "https://osubeavers.com",
    2: "https://goducks.com",
    483: "https://gozags.com",
    4: "https://wsucougars.com",
    1: "https://gohuskies.com",
    482: "https://portlandpilots.com",
    484: "https://goseattleu.com",
}

SEASONS = (2023, 2024, 2025, 2026)
CACHE_PATH = Path(__file__).parent.parent / "data" / "d1_home_away_truth.json"


def domain_of(url):
    return re.sub(r"https?://", "", url or "").split("/")[0].lower()


def boxscore_id(url):
    m = re.search(r"/boxscore/(\d+)", url or "") or re.search(r"[?&]id=(\d+)", url or "")
    return m.group(1) if m else None


def fetch_v2_api(base_url, bid, tenant):
    """Raw v2 boxscore JSON (has thisTeamIsHomeTeam / isNeutral / venue)."""
    api_url = f"{base_url}/api/v2/stats/boxscore/{bid}"
    try:
        resp = requests.get(
            api_url,
            headers={"tenant": tenant, "Accept": "application/json",
                     "User-Agent": random.choice(USER_AGENTS)},
            timeout=20,
        )
        if resp.status_code == 204:
            return None
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        logger.warning(f"    v2 API failed for {bid}: {e}")
        return None


def collect_truth(games):
    """Fetch each boxscore once; return {game_id: truth_dict}."""
    cache = {}
    if CACHE_PATH.exists():
        cache = {int(k): v for k, v in json.loads(CACHE_PATH.read_text()).items()}
        logger.info(f"Loaded {len(cache)} cached results from {CACHE_PATH}")

    total = len(games)
    for i, g in enumerate(games):
        gid = g["id"]
        if gid in cache and cache[gid].get("ok"):
            continue
        dom = domain_of(g["source_url"])
        base_url = f"https://{dom}"
        bid = boxscore_id(g["source_url"])
        rec = {"ok": False, "bid": bid, "domain": dom}

        if not bid:
            rec["error"] = "no_boxscore_id"
            cache[gid] = rec
            continue

        tenant = SIDEARM_API_TENANTS.get(base_url)
        if tenant:
            data = fetch_v2_api(base_url, bid, tenant)
            if data:
                rec.update(
                    ok=True, source="api",
                    this_is_home=bool(data.get("thisTeamIsHomeTeam")),
                    is_neutral=bool(data.get("isNeutral")),
                    home_score=data.get("homeTeamScore"),
                    away_score=data.get("visitingTeamScore"),
                    venue=(data.get("venue") or {}).get("location"),
                    home_name=data.get("homeTeamName"),
                    away_name=data.get("visitingTeamName"),
                )
            else:
                rec["error"] = "api_empty"
        else:
            html = fetch_page(g["source_url"], retries=2, delay_range=(1.0, 2.0))
            box = parse_sidearm_boxscore(html, base_url=base_url) if html else None
            if box and box.get("home_score") is not None and box.get("away_score") is not None:
                rec.update(
                    ok=True, source="html",
                    is_neutral=None,  # older Sidearm: not reliably available
                    home_score=box.get("home_score"),
                    away_score=box.get("away_score"),
                    venue=box.get("location"),
                )
            else:
                rec["error"] = "html_parse_failed"

        cache[gid] = rec
        if (i + 1) % 25 == 0:
            logger.info(f"  collected {i+1}/{total} (last gid={gid} {rec.get('source','-')} ok={rec['ok']})")
            CACHE_PATH.write_text(json.dumps({str(k): v for k, v in cache.items()}))

    CACHE_PATH.write_text(json.dumps({str(k): v for k, v in cache.items()}))
    ok = sum(1 for v in cache.values() if v.get("ok"))
    logger.info(f"Collected truth for {ok}/{len(cache)} games -> {CACHE_PATH}")
    return cache


def decide(g, truth):
    """Return (action, new_owner_is_home, set_neutral) for one game.

    action in {'ok','swap','neutral_only','skip'}.
    """
    owner = DOMAIN_TEAM[domain_of(g["source_url"])]
    cur_owner_is_home = (g["home_team_id"] == owner)
    if not truth or not truth.get("ok"):
        return ("skip", cur_owner_is_home, None)

    # ---- orientation truth ----
    owner_is_home = None
    if truth.get("source") == "api" and "this_is_home" in truth:
        owner_is_home = bool(truth["this_is_home"])
    else:
        # score-match: owner's real runs vs the boxscore's home/away scores
        owner_score = g["home_score"] if cur_owner_is_home else g["away_score"]
        opp_score = g["away_score"] if cur_owner_is_home else g["home_score"]
        bh, ba = truth.get("home_score"), truth.get("away_score")
        if None in (owner_score, opp_score, bh, ba) or owner_score == opp_score:
            owner_is_home = None  # can't decide
        elif owner_score == bh and opp_score == ba:
            owner_is_home = True
        elif owner_score == ba and opp_score == bh:
            owner_is_home = False
        else:
            owner_is_home = None  # scores don't reconcile -> don't touch

    if owner_is_home is None:
        return ("skip", cur_owner_is_home, None)

    # ---- neutral truth (api only) ----
    set_neutral = None
    if truth.get("is_neutral") is not None and bool(truth["is_neutral"]) != bool(g["is_neutral_site"]):
        set_neutral = bool(truth["is_neutral"])

    needs_swap = (owner_is_home != cur_owner_is_home)
    if needs_swap:
        return ("swap", owner_is_home, set_neutral)
    if set_neutral is not None:
        return ("neutral_only", owner_is_home, set_neutral)
    return ("ok", owner_is_home, None)


SWAP_SQL = """
    UPDATE games SET
        home_team_id   = away_team_id,   away_team_id   = home_team_id,
        home_team_name = away_team_name,  away_team_name = home_team_name,
        home_score     = away_score,      away_score     = home_score,
        home_hits      = away_hits,       away_hits      = home_hits,
        home_errors    = away_errors,     away_errors    = home_errors,
        home_lob       = away_lob,        away_lob       = home_lob,
        home_line_score = away_line_score, away_line_score = home_line_score,
        updated_at = now()
    WHERE id = %s
"""


def load_games():
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, season, game_date, home_team_id, away_team_id,
                   home_team_name, away_team_name, home_score, away_score,
                   is_neutral_site, location, source_url
            FROM games
            WHERE status='final' AND season = ANY(%s) AND source_url IS NOT NULL
            ORDER BY season, game_date, id
            """,
            (list(SEASONS),),
        )
        rows = cur.fetchall()
    # keep only games scraped from a D1 PNW domain we own
    return [dict(r) for r in rows if domain_of(r["source_url"]) in DOMAIN_TEAM]


def report_counts(label):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT t.short_name, g.season,
              SUM(CASE WHEN g.home_team_id=t.id THEN 1 ELSE 0 END) home,
              SUM(CASE WHEN g.away_team_id=t.id THEN 1 ELSE 0 END) away,
              SUM(CASE WHEN g.is_neutral_site THEN 1 ELSE 0 END) neut
            FROM teams t JOIN games g ON (g.home_team_id=t.id OR g.away_team_id=t.id)
            WHERE t.id = ANY(%s) AND g.status='final' AND g.season=ANY(%s)
            GROUP BY t.short_name, g.season ORDER BY t.short_name, g.season
            """,
            (list(DOMAIN_TEAM.values()), list(SEASONS)),
        )
        print(f"\n=== home/away/neutral counts {label} ===")
        print(f"{'team':12}{'szn':6}{'home':6}{'away':6}{'neut':6}")
        for r in cur.fetchall():
            print(f"{r['short_name']:12}{r['season']:<6}{r['home']:<6}{r['away']:<6}{r['neut']:<6}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--collect", action="store_true", help="fetch boxscores -> cache")
    ap.add_argument("--dry-run", action="store_true", help="show proposed changes")
    ap.add_argument("--apply", action="store_true", help="write changes to DB")
    args = ap.parse_args()

    games = load_games()
    logger.info(f"{len(games)} D1 games (status=final, {SEASONS[0]}-{SEASONS[-1]}) in scope")

    if args.collect:
        collect_truth(games)
        return

    if not CACHE_PATH.exists():
        logger.error("No truth cache. Run --collect first.")
        sys.exit(1)
    cache = {int(k): v for k, v in json.loads(CACHE_PATH.read_text()).items()}

    from collections import Counter
    actions = Counter()
    swaps, neutrals, skips = [], [], []
    for g in games:
        action, _, set_neutral = decide(g, cache.get(g["id"]))
        actions[action] += 1
        if action == "swap":
            swaps.append((g, set_neutral))
        elif action == "neutral_only":
            neutrals.append((g, set_neutral))
        elif action == "skip":
            skips.append(g)

    logger.info(f"\nActions: {dict(actions)}")
    logger.info(f"  swap (flip home/away): {len(swaps)}")
    logger.info(f"  neutral_only (flag only): {len(neutrals)}")
    logger.info(f"  skip (no truth / unreconciled): {len(skips)}")

    if skips:
        logger.info("\nSkipped sample (first 15):")
        for g in skips[:15]:
            t = cache.get(g["id"], {})
            logger.info(f"  gid={g['id']} {g['game_date']} {g['home_team_name']} vs {g['away_team_name']} "
                        f"err={t.get('error') or t.get('source')}")

    report_counts("BEFORE")

    if args.dry_run:
        logger.info("\nSwap sample (first 20):")
        for g, sn in swaps[:20]:
            logger.info(f"  gid={g['id']} {g['game_date']} cur: H={g['home_team_name']} A={g['away_team_name']} "
                        f"-> FLIP" + (f" +neutral={sn}" if sn is not None else ""))
        logger.info("\n(dry-run: no writes)")
        return

    if args.apply:
        with get_connection() as conn:
            cur = conn.cursor()
            for g, set_neutral in swaps:
                cur.execute(SWAP_SQL, (g["id"],))
                if set_neutral is not None:
                    cur.execute("UPDATE games SET is_neutral_site=%s WHERE id=%s", (set_neutral, g["id"]))
            for g, set_neutral in neutrals:
                cur.execute("UPDATE games SET is_neutral_site=%s, updated_at=now() WHERE id=%s",
                            (set_neutral, g["id"]))
            conn.commit()
        logger.info(f"\nApplied {len(swaps)} swaps + {len(neutrals)} neutral-only updates.")
        report_counts("AFTER")


if __name__ == "__main__":
    main()
