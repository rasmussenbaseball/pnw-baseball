#!/usr/bin/env python3
"""
PBP scraper — Phase 1 (full per-PA event extraction)
=====================================================

Walks games whose play-by-play hasn't been scraped, re-fetches the
box-score URL from `games.source_url`, parses every plate appearance
into the `game_events` table, and (as a derived secondary write) keeps
`game_pitching.home_runs_allowed` in sync from those events.

Designed to run once per night (3 AM Pacific via cron) so we can wait
for the official scorer to push the StatCrew PBP file to Sidearm —
that often lags the box-score totals by hours.

Usage
-----
Default (cron mode — last 14 days, max 3 attempts, only unscraped games):
    PYTHONPATH=backend python3 scripts/scrape_pbp.py

Backfill all 2026 games (one-time historical pass):
    PYTHONPATH=backend python3 scripts/scrape_pbp.py --backfill --season 2026

Test on one game (no DB writes):
    PYTHONPATH=backend python3 scripts/scrape_pbp.py --game-id 3539 --dry-run

Re-scrape an already-scraped game:
    PYTHONPATH=backend python3 scripts/scrape_pbp.py --game-id 3539 --rescrape
"""

import argparse
import logging
import re
import sys
import time
import unicodedata
from difflib import SequenceMatcher

import requests
import psycopg2.extras

# Project imports
from app.models.database import get_connection

# Local script imports — same scripts/ dir
sys.path.insert(0, "scripts")
from parse_pbp_events import parse_pbp_events  # noqa: E402
from scrape_boxscores import find_player_id  # noqa: E402


def _normalize_name(name):
    """Strip apostrophes, dashes, accents, and extra whitespace from a name.

    Used so PBP names like "ONeil,Dillon" can match roster names like
    "O'Neil, Dillon" — and similar accent / punctuation variations.
    """
    if not name:
        return ""
    # Decompose accents (é → e + combining accent), then drop non-ASCII
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    # Strip any character that isn't a letter, comma, or whitespace
    s = re.sub(r"[^\w,\s]", "", s)
    # Collapse whitespace
    s = re.sub(r"\s+", " ", s).strip()
    return s


def find_player_id_with_fallback(cur, team_id, name, season):
    """find_player_id, then a normalized-name fallback if that misses.

    The fallback fetches all players on the team once per call, normalizes
    each name, and matches against the normalized input. This handles
    apostrophes (O'Neil/ONeil), accents (José/Jose), and similar.
    Returns (player_id, fallback_used) where fallback_used is True if the
    original lookup missed.
    """
    pid = find_player_id(cur, team_id, name, season)
    if pid:
        return pid, False
    norm_input = _normalize_name(name).lower()
    if not norm_input:
        return None, False
    cur.execute("""
        SELECT id, first_name, last_name FROM players WHERE team_id = %s
    """, (team_id,))
    candidates = []
    for r in cur.fetchall():
        # Normalize both "First Last" and "Last, First" forms
        first = r["first_name"] or ""
        last = r["last_name"] or ""
        forms = [
            _normalize_name(f"{first} {last}").lower(),
            _normalize_name(f"{last}, {first}").lower(),
            _normalize_name(f"{last},{first}").lower(),
            _normalize_name(last).lower(),  # last-name-only
        ]
        if any(f == norm_input for f in forms):
            candidates.append(r["id"])
    if len(candidates) == 1:
        return candidates[0], True
    return None, False


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
# Team-name → team_id mapping
# ─────────────────────────────────────────────────────────────────

def _similarity(a, b):
    return SequenceMatcher(None, (a or "").lower(), (b or "").lower()).ratio()


def _best_score(pbp_name, candidate_strings):
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

    BIPARTITE ASSIGNMENT: when there are exactly two PBP captions, force
    them to map to DIFFERENT team_ids. We compute all four (caption,
    team) similarity scores and pick the pairing that maximizes the
    total score subject to the constraint.

    This prevents short-abbreviation collisions like "CSUSB" mapping to
    CWU instead of "Cal State San Bernardino" because "CSUSB" vs "CWU"
    SequenceMatcher ratio (0.50) beats "CSUSB" vs "Cal State..." (0.28)
    on raw character similarity. Bipartite matching forces the lower-
    confidence caption onto the other team rather than letting both
    collide on the same side.

    For !=2 captions (rare/never), falls back to independent matching
    with the 0.5 threshold.
    """
    names = list(pbp_team_names)
    home_vars = [v for v in home_variants if v]
    away_vars = [v for v in away_variants if v]

    if len(names) == 2:
        n0, n1 = names
        s00 = _best_score(n0, home_vars)   # n0 → home
        s01 = _best_score(n0, away_vars)   # n0 → away
        s10 = _best_score(n1, home_vars)   # n1 → home
        s11 = _best_score(n1, away_vars)   # n1 → away
        # Two valid assignments under the must-be-different constraint:
        opt_a = s00 + s11   # n0=home, n1=away
        opt_b = s01 + s10   # n0=away, n1=home
        # Each assignment requires at least one side to clear a low bar
        # so we don't fabricate a match for two unrelated names. 0.3 is
        # well below the old 0.5 threshold but above noise.
        out = {}
        if opt_a >= opt_b and max(s00, s11) >= 0.3:
            out[n0] = home_team_id
            out[n1] = away_team_id
        elif opt_b > opt_a and max(s01, s10) >= 0.3:
            out[n0] = away_team_id
            out[n1] = home_team_id
        return out

    # Fallback (one or three+ captions — shouldn't happen for a normal
    # nine-inning game but handle gracefully).
    out = {}
    for pbp_name in names:
        s_home = _best_score(pbp_name, home_vars)
        s_away = _best_score(pbp_name, away_vars)
        if s_home >= s_away and s_home >= 0.5:
            out[pbp_name] = home_team_id
        elif s_away > s_home and s_away >= 0.5:
            out[pbp_name] = away_team_id
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
    """Scrape one game's PBP, write events to game_events, update HR-allowed.

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
        "events_total": 0,
        "events_inserted": 0,
        "batters_resolved": 0,
        "pitchers_resolved": 0,
        "hr_pitchers_updated": 0,
        "warnings": [],
        "error": None,
    }

    # ── Fetch ──
    try:
        html = fetch_html(url)
        result["fetched"] = True
    except Exception as e:
        result["error"] = f"fetch:{type(e).__name__}:{e}"
        if not dry_run:
            cur.execute("""
                UPDATE games SET pbp_attempt_count = pbp_attempt_count + 1
                WHERE id = %s
            """, (gid,))
        return result

    # ── First-pass parse to discover team names from captions ──
    _, meta = parse_pbp_events(html)
    if not meta["has_pbp"]:
        # No PBP section — Oregon/OSU/WSU home games etc. Bump counter so
        # we eventually give up after MAX_ATTEMPTS.
        if not dry_run:
            cur.execute("""
                UPDATE games SET pbp_attempt_count = pbp_attempt_count + 1
                WHERE id = %s
            """, (gid,))
        return result

    result["had_pbp"] = True

    # ── Map PBP captions → DB team_ids ──
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
    for n in meta["all_team_names"]:
        if n not in name_to_team:
            result["warnings"].append(f"<unmappable_team:{n!r}>")

    # ── Seed starters from game_pitching ──
    starters_by_team_id = get_starters(cur, gid)
    starters_by_pbp_name = {}
    for pbp_name, team_id in name_to_team.items():
        if team_id in starters_by_team_id:
            starters_by_pbp_name[pbp_name] = starters_by_team_id[team_id]

    # ── Second-pass parse with starters seeded ──
    events, _ = parse_pbp_events(html, starters=starters_by_pbp_name)
    result["events_total"] = len(events)

    # ── Resolve player_ids per event ──
    # batter is on batting_team; pitcher is on defending_team.
    # Cache lookups within one game to avoid hammering find_player_id.
    batter_cache = {}    # (team_id, name) -> player_id or None
    pitcher_cache = {}

    def resolve(name, team_id, cache):
        if not name or name == "<UNKNOWN STARTER>":
            return None
        key = (team_id, name)
        if key in cache:
            return cache[key]
        if not team_id:
            cache[key] = None
            return None
        pid, _used_fallback = find_player_id_with_fallback(cur, team_id, name, season)
        cache[key] = pid
        return pid

    enriched = []
    for ev in events:
        batting_team_id = name_to_team.get(ev["batting_team_name"])
        defending_team_id = name_to_team.get(ev["defending_team_name"])
        if not batting_team_id or not defending_team_id:
            continue   # team unmappable — already warned above
        batter_pid = resolve(ev["batter_name"], batting_team_id, batter_cache)
        pitcher_pid = resolve(ev["pitcher_name"], defending_team_id, pitcher_cache)
        if batter_pid:
            result["batters_resolved"] += 1
        if pitcher_pid:
            result["pitchers_resolved"] += 1
        enriched.append({
            **ev,
            "batting_team_id": batting_team_id,
            "defending_team_id": defending_team_id,
            "batter_player_id": batter_pid,
            "pitcher_player_id": pitcher_pid,
        })

    if verbose:
        log.info(f"  game {gid}: parsed {len(events)} events, "
                 f"{result['batters_resolved']} batter IDs, "
                 f"{result['pitchers_resolved']} pitcher IDs")

    # ── Write game_events (idempotent: DELETE then INSERT) ──
    if not dry_run and enriched:
        cur.execute("DELETE FROM game_events WHERE game_id = %s", (gid,))
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO game_events (
                game_id, inning, half, sequence_idx,
                batting_team_id, defending_team_id,
                batter_player_id, batter_name,
                pitcher_player_id, pitcher_name,
                balls_before, strikes_before, pitch_sequence,
                pitches_thrown, was_in_play,
                result_type, result_text, rbi
            ) VALUES %s
            """,
            [(
                gid, ev["inning"], ev["half"], ev["sequence_idx"],
                ev["batting_team_id"], ev["defending_team_id"],
                ev["batter_player_id"], ev["batter_name"],
                ev["pitcher_player_id"], ev["pitcher_name"],
                ev["balls_before"], ev["strikes_before"], ev["pitch_sequence"],
                ev["pitches_thrown"], ev["was_in_play"],
                ev["result_type"], ev["result_text"], ev["rbi"],
            ) for ev in enriched],
            page_size=200,
        )
        result["events_inserted"] = len(enriched)

    # ── Derived: update game_pitching.home_runs_allowed from events ──
    # Count HRs per (defending_team_id, pitcher_player_id) and UPDATE.
    # Pitchers we couldn't resolve are silently dropped — same OOC
    # behavior as Phase 0.
    hr_by_pp = {}   # (team_id, pitcher_pid) -> count
    for ev in enriched:
        if ev["result_type"] != "home_run":
            continue
        if not ev["pitcher_player_id"]:
            continue
        key = (ev["defending_team_id"], ev["pitcher_player_id"])
        hr_by_pp[key] = hr_by_pp.get(key, 0) + 1

    if not dry_run:
        for (team_id, pid), n in hr_by_pp.items():
            cur.execute("""
                UPDATE game_pitching
                SET home_runs_allowed = %s
                WHERE game_id = %s AND team_id = %s AND player_id = %s
            """, (n, gid, team_id, pid))
            if cur.rowcount > 0:
                result["hr_pitchers_updated"] += 1

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
# Game selection
# ─────────────────────────────────────────────────────────────────

def select_games(cur, args):
    where = [
        "g.source_url IS NOT NULL",
        # NOTE: %% — psycopg2 treats % as parameter marker even in quoted strings
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
        if not args.backfill:
            where.append(f"g.game_date >= CURRENT_DATE - INTERVAL '{RECENT_DAYS} days'")
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
                    help="Process all games in season, not just last 14 days")
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
            "fetched": 0, "had_pbp": 0,
            "events_total": 0, "events_inserted": 0,
            "batters_resolved": 0, "pitchers_resolved": 0,
            "hr_pitchers_updated": 0, "errors": 0,
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
                if r["fetched"]: totals["fetched"] += 1
                if r["had_pbp"]: totals["had_pbp"] += 1
                totals["events_total"] += r["events_total"]
                totals["events_inserted"] += r["events_inserted"]
                totals["batters_resolved"] += r["batters_resolved"]
                totals["pitchers_resolved"] += r["pitchers_resolved"]
                totals["hr_pitchers_updated"] += r["hr_pitchers_updated"]
                if r["warnings"]:
                    log.warning(f"  warnings: {r['warnings']}")
                else:
                    log.info(f"  ok: {r['events_total']} events, "
                             f"{r['batters_resolved']} batter IDs, "
                             f"{r['pitchers_resolved']} pitcher IDs, "
                             f"{r['hr_pitchers_updated']} HR pitcher updates")

            if not args.dry_run:
                conn.commit()

            time.sleep(0.5)

        log.info("─" * 60)
        log.info(
            f"DONE: fetched={totals['fetched']}, had_pbp={totals['had_pbp']}, "
            f"events_total={totals['events_total']}, events_inserted={totals['events_inserted']}, "
            f"batter_ids={totals['batters_resolved']}, pitcher_ids={totals['pitchers_resolved']}, "
            f"hr_updates={totals['hr_pitchers_updated']}, errors={totals['errors']}"
        )


if __name__ == "__main__":
    main()
