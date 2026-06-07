#!/usr/bin/env python3
"""
WCL Box-Score Scraper
=====================

Iterates `summer_games` rows that have a source_url but no per-game
batting/pitching writes yet, fetches each wclstats.com box score,
parses it with the existing NWAC Presto parser (it Just Works on
WCL — same engine), and writes:

  - score / hits / errors / line score onto summer_games
  - one summer_game_batting row per batter
  - one summer_game_pitching row per pitcher

Player resolution is best-effort. We try to match player_name against
summer_players (within team), but rows whose player_id can't be
resolved still get inserted with player_name only — a later resolver
patches player_id once Pointstreak rosters are pulled.

Usage:
    PYTHONPATH=backend python3 scripts/scrape_wcl_boxscores.py
    PYTHONPATH=backend python3 scripts/scrape_wcl_boxscores.py --season 2026
    PYTHONPATH=backend python3 scripts/scrape_wcl_boxscores.py --limit 3
    PYTHONPATH=backend python3 scripts/scrape_wcl_boxscores.py --rescrape  # ignore "already done" check
"""

import argparse
import json
import logging
import random
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import requests

from app.models.database import get_connection
from parse_nwac_boxscore import parse_presto_xml_boxscore
from wcl_http import mount_retries, fetch as wcl_fetch


logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("scrape_wcl_boxscores")

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


# ── DB helpers ─────────────────────────────────────────────────

def get_league_id(cur, abbr):
    cur.execute("SELECT id FROM summer_leagues WHERE abbreviation = %s", (abbr,))
    row = cur.fetchone()
    if not row:
        raise RuntimeError(f"summer_leagues row for '{abbr}' missing")
    return row["id"]


def games_needing_boxscore(cur, league_id, season, rescrape=False, limit=None):
    """Return summer_games rows whose box score we haven't ingested.

    Definition of "haven't ingested": no summer_game_batting rows exist
    for that game_id. (Rescrape mode ignores this check.)
    """
    if rescrape:
        cur.execute(
            """
            SELECT id, source_url, game_date, away_team_id, home_team_id,
                   away_team_name, home_team_name
            FROM summer_games
            WHERE league_id = %s AND season = %s
              AND source_url IS NOT NULL
            ORDER BY game_date DESC
            """,
            (league_id, season),
        )
    else:
        cur.execute(
            """
            SELECT g.id, g.source_url, g.game_date, g.away_team_id, g.home_team_id,
                   g.away_team_name, g.home_team_name
            FROM summer_games g
            LEFT JOIN summer_game_batting b ON b.game_id = g.id
            WHERE g.league_id = %s AND g.season = %s
              AND g.source_url IS NOT NULL
              AND b.id IS NULL
            GROUP BY g.id
            ORDER BY g.game_date DESC
            """,
            (league_id, season),
        )
    rows = cur.fetchall()
    return rows[:limit] if limit else rows


def _split_name(name):
    """Split a 'First Last' or 'Last, First' name into parts."""
    if not name:
        return "", ""
    name = name.strip()
    if "," in name:
        last, first = [p.strip() for p in name.split(",", 1)]
        return first, last
    parts = name.split()
    if len(parts) == 1:
        return "", parts[0]
    return parts[0], " ".join(parts[1:])


def build_player_lookup(cur, team_ids):
    """Map (team_id, normalized full name) -> summer_players.id.

    Names from box scores arrive as "F. Lastname" or "First Lastname";
    we register both forms so either resolves.
    """
    if not team_ids:
        return {}
    placeholders = ",".join(["%s"] * len(team_ids))
    cur.execute(
        f"SELECT id, team_id, first_name, last_name FROM summer_players "
        f"WHERE team_id IN ({placeholders})",
        list(team_ids),
    )
    lookup = {}
    for row in cur.fetchall():
        first = (row.get("first_name") or "").strip()
        last = (row.get("last_name") or "").strip()
        team_id = row["team_id"]
        pid = row["id"]
        if first and last:
            lookup[(team_id, _norm_name(f"{first} {last}"))] = pid
            lookup[(team_id, _norm_name(f"{first[0]} {last}"))] = pid
        elif last:
            lookup[(team_id, _norm_name(last))] = pid
    return lookup


def _norm_name(name):
    return re.sub(r"[^a-z]", "", (name or "").lower())


def resolve_player_id(player_lookup, team_id, player_name):
    if team_id is None or not player_name:
        return None
    return player_lookup.get((team_id, _norm_name(player_name)))


# ── Game-level writes ──────────────────────────────────────────

def update_game_header(cur, game_id, parsed):
    """Save score / hits / errors / line score / status."""
    line_away = parsed.get("away_line_score") or []
    line_home = parsed.get("home_line_score") or []
    cur.execute(
        """
        UPDATE summer_games
        SET status         = %s,
            away_score     = %s,
            home_score     = %s,
            away_hits      = %s,
            home_hits      = %s,
            away_errors    = %s,
            home_errors    = %s,
            away_line_score = %s,
            home_line_score = %s,
            innings        = %s,
            updated_at     = CURRENT_TIMESTAMP
        WHERE id = %s
        """,
        (
            parsed.get("status") or "final",
            _to_int(parsed.get("away_score")),
            _to_int(parsed.get("home_score")),
            _to_int(parsed.get("away_hits")),
            _to_int(parsed.get("home_hits")),
            _to_int(parsed.get("away_errors")),
            _to_int(parsed.get("home_errors")),
            json.dumps(line_away) if line_away else None,
            json.dumps(line_home) if line_home else None,
            _to_int(parsed.get("innings")) or len(line_away) or None,
            game_id,
        ),
    )


def _to_int(v):
    try:
        return int(v) if v not in (None, "", "—") else None
    except (TypeError, ValueError):
        return None


# ── Batting / pitching inserts ─────────────────────────────────

BATTING_KEYS = ("ab", "r", "h", "rbi", "bb", "so", "lob", "2b", "3b",
                "hr", "sb", "cs", "sf", "sh", "hbp")
PITCHING_KEYS = ("ip", "h", "r", "er", "bb", "so", "hr", "bf",
                 "wp", "hbp", "pitches", "strikes")


def insert_batting(cur, game_id, team_id, is_home, rows, player_lookup, order_start=1):
    """Upsert batter rows. order_start is 1-based batting order."""
    seen_pos = order_start - 1
    for batter in rows:
        seen_pos += 1
        name = (batter.get("player_name") or "").strip()
        if not name:
            continue
        pid = resolve_player_id(player_lookup, team_id, name)
        vals = {k: _to_int(batter.get(k)) or 0 for k in BATTING_KEYS}
        cur.execute(
            """
            INSERT INTO summer_game_batting (
                game_id, team_id, player_id, player_name, is_home, position, batting_order,
                ab, r, h, rbi, bb, so, lob, "2b", "3b", hr, sb, cs, sf, sh, hbp
            ) VALUES (%s,%s,%s,%s,%s,%s,%s, %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (game_id, is_home, player_name) DO UPDATE SET
                team_id      = EXCLUDED.team_id,
                player_id    = COALESCE(EXCLUDED.player_id, summer_game_batting.player_id),
                position     = EXCLUDED.position,
                batting_order = EXCLUDED.batting_order,
                ab=EXCLUDED.ab, r=EXCLUDED.r, h=EXCLUDED.h, rbi=EXCLUDED.rbi,
                bb=EXCLUDED.bb, so=EXCLUDED.so, lob=EXCLUDED.lob,
                "2b"=EXCLUDED."2b", "3b"=EXCLUDED."3b", hr=EXCLUDED.hr,
                sb=EXCLUDED.sb, cs=EXCLUDED.cs, sf=EXCLUDED.sf, sh=EXCLUDED.sh,
                hbp=EXCLUDED.hbp
            """,
            (
                game_id, team_id, pid, name, is_home,
                batter.get("position"), seen_pos,
                vals["ab"], vals["r"], vals["h"], vals["rbi"], vals["bb"],
                vals["so"], vals["lob"], vals["2b"], vals["3b"], vals["hr"],
                vals["sb"], vals["cs"], vals["sf"], vals["sh"], vals["hbp"],
            ),
        )


def insert_pitching(cur, game_id, team_id, is_home, rows, player_lookup):
    for pitcher in rows:
        name = (pitcher.get("player_name") or "").strip()
        if not name:
            continue
        pid = resolve_player_id(player_lookup, team_id, name)
        ip = pitcher.get("ip")
        try:
            ip_val = float(ip) if ip not in (None, "") else 0.0
        except (TypeError, ValueError):
            ip_val = 0.0
        vals = {k: _to_int(pitcher.get(k)) or 0 for k in PITCHING_KEYS if k != "ip"}
        cur.execute(
            """
            INSERT INTO summer_game_pitching (
                game_id, team_id, player_id, player_name, is_home,
                is_starter, pitch_order,
                ip, h, r, er, bb, so, hr, bf, wp, hbp, pitches, strikes, decision
            ) VALUES (%s,%s,%s,%s,%s,%s,%s, %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (game_id, is_home, player_name) DO UPDATE SET
                team_id      = EXCLUDED.team_id,
                player_id    = COALESCE(EXCLUDED.player_id, summer_game_pitching.player_id),
                is_starter   = EXCLUDED.is_starter,
                pitch_order  = EXCLUDED.pitch_order,
                ip=EXCLUDED.ip, h=EXCLUDED.h, r=EXCLUDED.r, er=EXCLUDED.er,
                bb=EXCLUDED.bb, so=EXCLUDED.so, hr=EXCLUDED.hr, bf=EXCLUDED.bf,
                wp=EXCLUDED.wp, hbp=EXCLUDED.hbp,
                pitches=EXCLUDED.pitches, strikes=EXCLUDED.strikes,
                decision=EXCLUDED.decision
            """,
            (
                game_id, team_id, pid, name, is_home,
                bool(pitcher.get("is_starter")),
                _to_int(pitcher.get("pitch_order")),
                ip_val,
                vals["h"], vals["r"], vals["er"], vals["bb"], vals["so"],
                vals["hr"], vals["bf"], vals["wp"], vals["hbp"],
                vals["pitches"], vals["strikes"],
                pitcher.get("decision"),
            ),
        )


# ── Entry point ────────────────────────────────────────────────

def scrape_game(session, cur, game):
    """Fetch + parse + write one summer_games row's box score."""
    url = game["source_url"]
    logger.info(f"  → {url}")
    r = wcl_fetch(session, url, timeout=30)
    r.raise_for_status()

    parsed = parse_presto_xml_boxscore(r.text, url)
    if not parsed:
        logger.warning(f"     no data parsed, skipping")
        return False

    # 1) Update game header
    update_game_header(cur, game["id"], parsed)

    # 2) Resolve players for both teams
    team_ids = [tid for tid in (game.get("away_team_id"), game.get("home_team_id")) if tid]
    player_lookup = build_player_lookup(cur, team_ids)

    # 3) Insert batting + pitching for both sides
    insert_batting(
        cur, game["id"], game.get("away_team_id"),
        is_home=False, rows=parsed.get("away_batting") or [],
        player_lookup=player_lookup,
    )
    insert_batting(
        cur, game["id"], game.get("home_team_id"),
        is_home=True, rows=parsed.get("home_batting") or [],
        player_lookup=player_lookup,
    )
    insert_pitching(
        cur, game["id"], game.get("away_team_id"),
        is_home=False, rows=parsed.get("away_pitching") or [],
        player_lookup=player_lookup,
    )
    insert_pitching(
        cur, game["id"], game.get("home_team_id"),
        is_home=True, rows=parsed.get("home_pitching") or [],
        player_lookup=player_lookup,
    )
    return True


def run(season, limit=None, rescrape=False, dry_run=False):
    session = get_session()
    success = failed = 0
    with get_connection() as conn:
        cur = conn.cursor()
        league_id = get_league_id(cur, LEAGUE_ABBR)
        games = games_needing_boxscore(cur, league_id, season,
                                       rescrape=rescrape, limit=limit)
        logger.info(f"{len(games)} game(s) to scrape "
                    f"(season {season}, rescrape={rescrape}, limit={limit})")

        for g in games:
            try:
                if dry_run:
                    logger.info(f"  [DRY] {g['game_date']}  {g['source_url']}")
                    continue
                if scrape_game(session, cur, g):
                    success += 1
                    conn.commit()
                else:
                    failed += 1
            except Exception as e:
                conn.rollback()
                failed += 1
                logger.error(f"  ! failed {g.get('source_url')}: {e}")
            time.sleep(random.uniform(0.8, 1.6))

    logger.info(f"Done — success: {success}, failed: {failed}")


def main():
    parser = argparse.ArgumentParser(description="Scrape WCL box scores")
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--rescrape", action="store_true",
                        help="Re-parse box scores even when batting rows already exist")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    run(args.season, limit=args.limit, rescrape=args.rescrape, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
