#!/usr/bin/env python3
"""
PBP scraper — Phase 0 (HR allowed only)
========================================

Walks games whose play-by-play hasn't been scraped yet, re-fetches the
box-score URL we already have stored in `games.source_url`, parses the
play-by-play section to count HRs allowed per pitcher, and writes those
counts into `game_pitching.home_runs_allowed`.

Independent from `scrape_boxscores.py`. Designed to run once per night
(2 AM Pacific via cron) so we can wait for the official scorer to push
the StatCrew PBP file to Sidearm — that often lags the box-score totals
by hours.

Usage
-----
Default mode (run from cron — only games from last 14 days, max 3 attempts):
    PYTHONPATH=backend python3 scripts/scrape_pbp.py

Backfill all 2026 games (one-time historical pass):
    PYTHONPATH=backend python3 scripts/scrape_pbp.py --backfill --season 2026

Test on a single game (no DB writes):
    PYTHONPATH=backend python3 scripts/scrape_pbp.py --game-id 3539 --dry-run

Verbose per-game output:
    PYTHONPATH=backend python3 scripts/scrape_pbp.py --game-id 3539 --verbose
"""

import argparse
import logging
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from difflib import SequenceMatcher

import requests

# Project imports
from app.models.database import get_connection

# Local script imports — same scripts/ dir
sys.path.insert(0, "scripts")
from parse_pbp_hr import parse_pbp_hr  # noqa: E402
from scrape_boxscores import find_player_id  # noqa: E402


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("scrape_pbp")


USER_AGENT = "Mozilla/5.0 (compatible; pnw-baseball-pbp/0.1)"
RECENT_DAYS = 14
MAX_ATTEMPTS = 3


# ─────────────────────────────────────────────────────────────────
# HTML fetch
# ─────────────────────────────────────────────────────────────────

def fetch_html(url, timeout=30):
    headers = {"User-Agent": USER_AGENT}
    resp = requests.get(url, headers=headers, timeout=timeout)
    resp.raise_for_status()
    return resp.text


# ─────────────────────────────────────────────────────────────────
# Team-name → team_id mapping for one game
# ─────────────────────────────────────────────────────────────────

def _similarity(a, b):
    return SequenceMatcher(None, (a or "").lower(), (b or "").lower()).ratio()


def _best_score(pbp_name, candidate_strings):
    """Return the max SequenceMatcher ratio of pbp_name vs any candidate.

    None / empty candidates are skipped. Used so we can compare a PBP
    caption like "Eastern Oregon" against the team's stored
    home_team_name ('EOU'), full name ('Eastern Oregon Mountaineers'),
    school_name ('Eastern Oregon University'), and short_name ('EOU')
    — and pick the highest match. Without this, abbreviation-only
    home_team_name values fail the threshold and HRs get dropped.
    """
    best = 0.0
    for c in candidate_strings:
        if not c:
            continue
        s = _similarity(pbp_name, c)
        if s > best:
            best = s
    return best


def map_caption_to_team_id(pbp_team_names, home_team_id, home_variants, away_team_id, away_variants):
    """Match each PBP-caption team name to home_team_id or away_team_id.

    home_variants and away_variants are lists of strings the PBP name
    could plausibly equal — typically [team_name, full name, school
    name, short name]. We pick the side whose best variant scores
    higher (so an exact short-name match beats a weak partial on
    home_team_name).

    Returns dict: {pbp_name: team_id} for every name we resolved.
    """
    out = {}
    for pbp_name in pbp_team_names:
        s_home = _best_score(pbp_name, home_variants)
        s_away = _best_score(pbp_name, away_variants)
        if s_home >= s_away and s_home >= 0.5:
            out[pbp_name] = home_team_id
        elif s_away > s_home and s_away >= 0.5:
            out[pbp_name] = away_team_id
        # else: leave unresolved
    return out


# ─────────────────────────────────────────────────────────────────
# Per-game processing
# ─────────────────────────────────────────────────────────────────

def get_starters(cur, game_id):
    """Return {team_id: starter_name} from existing game_pitching rows."""
    cur.execute("""
        SELECT team_id, player_name
        FROM game_pitching
        WHERE game_id = %s AND is_starter = TRUE
    """, (game_id,))
    return {r["team_id"]: r["player_name"] for r in cur.fetchall()}


def process_game(cur, game, dry_run=False, verbose=False):
    """Scrape one game's PBP, return dict with stats.

    Always increments pbp_attempt_count. Sets pbp_scraped_at only when
    we successfully extracted at least one event (or confirmed there's
    legitimately no PBP available on the page).
    """
    gid = game["id"]
    url = game["source_url"]
    season = game["season"]

    result = {
        "game_id": gid,
        "url": url,
        "fetched": False,
        "had_pbp": False,
        "hr_events": 0,
        "pitchers_updated": 0,
        "unmatched_pitchers": [],
        "error": None,
    }

    # ── Fetch ──
    try:
        html = fetch_html(url)
        result["fetched"] = True
    except Exception as e:
        result["error"] = f"fetch:{type(e).__name__}:{e}"
        # Still bump attempt count so we eventually give up
        if not dry_run:
            cur.execute("""
                UPDATE games SET pbp_attempt_count = pbp_attempt_count + 1
                WHERE id = %s
            """, (gid,))
        return result

    # ── First-pass parse to get team-name list (no starters yet) ──
    _, _, meta = parse_pbp_hr(html)
    if not meta["has_pbp"]:
        # No PBP section present (e.g. Oregon, OSU, WSU home games).
        # Bump attempt count; mark scraped_at so we don't keep retrying
        # forever — after MAX_ATTEMPTS, the cron filter ignores the row.
        result["had_pbp"] = False
        if not dry_run:
            cur.execute("""
                UPDATE games SET pbp_attempt_count = pbp_attempt_count + 1
                WHERE id = %s
            """, (gid,))
        return result

    result["had_pbp"] = True

    # ── Map PBP team names → DB team_ids ──
    home_variants = [
        game["home_team_name"], game.get("home_db_name"),
        game.get("home_db_school"), game.get("home_db_short"),
    ]
    away_variants = [
        game["away_team_name"], game.get("away_db_name"),
        game.get("away_db_school"), game.get("away_db_short"),
    ]
    name_to_team = map_caption_to_team_id(
        meta["all_team_names"],
        game["home_team_id"], home_variants,
        game["away_team_id"], away_variants,
    )
    # Surface any caption names we couldn't resolve so they don't silently
    # drop their HR events.
    for n in meta["all_team_names"]:
        if n not in name_to_team:
            result["unmatched_pitchers"].append(f"<unmappable_team:{n!r}>")

    # ── Seed starters from game_pitching ──
    starters_by_team_id = get_starters(cur, gid)
    starters_by_pbp_name = {}
    for pbp_name, team_id in name_to_team.items():
        if team_id in starters_by_team_id:
            starters_by_pbp_name[pbp_name] = starters_by_team_id[team_id]

    # ── Second-pass parse with starters seeded ──
    hr_by_pitcher, events, _ = parse_pbp_hr(html, starters=starters_by_pbp_name)
    result["hr_events"] = len(events)

    if verbose:
        log.info(f"  game {gid}: {len(events)} HR events, {len(hr_by_pitcher)} pitchers credited")
        for e in events:
            log.info(f"    {e['batter']} ({e['batting_team']}) off "
                     f"{e['pitcher']} ({e['defending_team']})")

    # ── Write updates per pitcher ──
    # We invert the events list to also get the defending_team for each
    # HR — needed because hr_by_pitcher only carries pitcher name, but
    # name lookup is team-scoped.
    hr_by_team_pitcher = {}  # (team_id, pitcher_name) -> count
    for e in events:
        team_id = name_to_team.get(e["defending_team"])
        if not team_id:
            continue
        key = (team_id, e["pitcher"])
        hr_by_team_pitcher[key] = hr_by_team_pitcher.get(key, 0) + 1

    for (team_id, pitcher_name), n in hr_by_team_pitcher.items():
        if pitcher_name == "<UNKNOWN STARTER>":
            result["unmatched_pitchers"].append(f"<starter:team_id={team_id}>")
            continue
        pid = find_player_id(cur, team_id, pitcher_name, season)
        if not pid:
            result["unmatched_pitchers"].append(f"{pitcher_name}@team_id={team_id}")
            continue
        if dry_run:
            # Verify a game_pitching row exists for this pitcher in this
            # game, but don't write. Tells us if the name match goes all
            # the way through to a real row.
            cur.execute("""
                SELECT 1 FROM game_pitching
                WHERE game_id = %s AND team_id = %s AND player_id = %s
            """, (gid, team_id, pid))
            if cur.fetchone():
                result["pitchers_updated"] += 1
                if verbose:
                    log.info(f"    [dry-run] would update {pitcher_name} (player_id={pid}) +HR×{n}")
            else:
                result["unmatched_pitchers"].append(
                    f"{pitcher_name}@team_id={team_id} (no game_pitching row)"
                )
        else:
            cur.execute("""
                UPDATE game_pitching
                SET home_runs_allowed = %s
                WHERE game_id = %s AND team_id = %s AND player_id = %s
            """, (n, gid, team_id, pid))
            if cur.rowcount > 0:
                result["pitchers_updated"] += 1
            else:
                result["unmatched_pitchers"].append(
                    f"{pitcher_name}@team_id={team_id} (no game_pitching row)"
                )

    # ── Mark game complete ──
    if not dry_run:
        cur.execute("""
            UPDATE games
            SET pbp_scraped_at = NOW(),
                pbp_attempt_count = pbp_attempt_count + 1
            WHERE id = %s
        """, (gid,))

    return result


# ─────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────

def select_games(cur, args):
    """Build the games-to-scrape query based on CLI flags."""
    where = [
        "g.source_url IS NOT NULL",
        # NOTE: %% — psycopg2 treats % as parameter marker even inside
        # quoted strings, so each literal % in the LIKE pattern doubles.
        "g.source_url LIKE 'https://%%/sports/baseball/stats/%%/boxscore/%%'",
        "g.pbp_attempt_count < %s",
    ]
    params = [MAX_ATTEMPTS]

    if args.game_id:
        where.append("g.id = %s")
        params.append(args.game_id)
    else:
        if args.season:
            where.append("g.season = %s")
            params.append(args.season)
        if args.backfill:
            # All games in selected season, regardless of date.
            pass
        else:
            # Only games from last RECENT_DAYS days.
            where.append(f"g.game_date >= CURRENT_DATE - INTERVAL '{RECENT_DAYS} days'")

        # In all non-single-game modes, skip games we already scraped
        # (unless --rescrape).
        if not args.rescrape:
            where.append("g.pbp_scraped_at IS NULL")

    sql = f"""
        SELECT g.id, g.source_url, g.season, g.game_date,
               g.home_team_id, g.home_team_name,
               g.away_team_id, g.away_team_name,
               ht.name AS home_db_name, ht.school_name AS home_db_school, ht.short_name AS home_db_short,
               at.name AS away_db_name, at.school_name AS away_db_school, at.short_name AS away_db_short
        FROM games g
        JOIN teams ht ON ht.id = g.home_team_id
        JOIN teams at ON at.id = g.away_team_id
        WHERE {' AND '.join(where)}
        ORDER BY g.game_date DESC, g.id DESC
        {f'LIMIT {args.limit}' if args.limit else ''}
    """
    cur.execute(sql, params)
    return [dict(r) for r in cur.fetchall()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--backfill", action="store_true",
                    help="Process all games in season, not just recent")
    ap.add_argument("--rescrape", action="store_true",
                    help="Include games already marked pbp_scraped_at")
    ap.add_argument("--game-id", type=int,
                    help="Process exactly one game by id")
    ap.add_argument("--limit", type=int,
                    help="Cap total games processed")
    ap.add_argument("--dry-run", action="store_true",
                    help="Parse and report but write nothing")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()
        games = select_games(cur, args)
        log.info(f"{len(games)} games to process "
                 f"(backfill={args.backfill}, dry_run={args.dry_run})")

        totals = {
            "fetched": 0, "had_pbp": 0, "hr_events": 0,
            "pitchers_updated": 0, "unmatched": 0, "errors": 0,
        }

        for i, g in enumerate(games, 1):
            log.info(f"[{i}/{len(games)}] game_id={g['id']}  {g['game_date']}  "
                     f"{g['away_team_name']}@{g['home_team_name']}")
            try:
                r = process_game(cur, g, dry_run=args.dry_run, verbose=args.verbose)
            except Exception as e:
                log.exception(f"  exception: {e}")
                totals["errors"] += 1
                continue

            if r["error"]:
                log.warning(f"  error: {r['error']}")
                totals["errors"] += 1
            else:
                if r["fetched"]:
                    totals["fetched"] += 1
                if r["had_pbp"]:
                    totals["had_pbp"] += 1
                totals["hr_events"] += r["hr_events"]
                totals["pitchers_updated"] += r["pitchers_updated"]
                totals["unmatched"] += len(r["unmatched_pitchers"])
                if r["unmatched_pitchers"]:
                    log.warning(f"  unmatched: {r['unmatched_pitchers']}")
                else:
                    log.info(f"  ok: {r['hr_events']} HR events, "
                             f"{r['pitchers_updated']} pitchers updated")

            # Commit per-game so a later failure doesn't roll back
            # everything. Cheap given commit volume.
            if not args.dry_run:
                conn.commit()

            # Be polite — short pause between games. Different domains
            # within the loop, so one per second is plenty.
            time.sleep(0.5)

        log.info("─" * 60)
        log.info(f"DONE: fetched={totals['fetched']}, had_pbp={totals['had_pbp']}, "
                 f"hr_events={totals['hr_events']}, "
                 f"pitchers_updated={totals['pitchers_updated']}, "
                 f"unmatched={totals['unmatched']}, errors={totals['errors']}")


if __name__ == "__main__":
    main()
