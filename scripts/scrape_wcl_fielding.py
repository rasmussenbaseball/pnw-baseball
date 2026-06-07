#!/usr/bin/env python3
"""
WCL Season Fielding Scraper.

Pulls wclstats.com/sports/bsb/{season}/players?sort=fpct&pos=f&r=0
(Presto Sports league-wide fielding table — same engine NWAC uses)
and writes one row per player into summer_fielding_stats.

Match strategy mirrors the box-score resolver: try
summer_players(first_initial + last_name) within the WCL team match.
Creates summer_players stubs if not found, so summer_fielding_stats
has a player_id to attach to.

Usage:
    PYTHONPATH=backend python3 scripts/scrape_wcl_fielding.py
    PYTHONPATH=backend python3 scripts/scrape_wcl_fielding.py --season 2026
"""

import argparse
import logging
import random
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import requests
from bs4 import BeautifulSoup

from app.models.database import get_connection
from wcl_http import mount_retries, fetch as wcl_fetch


logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("scrape_wcl_fielding")

LEAGUE_ABBR = "WCL"
USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
]

HEADER_ALIASES = {
    "name":   "name",
    "team":   "team",
    "gp":     "games",
    "g":      "games",
    "tc":     "total_chances",
    "po":     "putouts",
    "a":      "assists",
    "e":      "errors",
    "pb":     "passed_balls",
    "f%":     "fielding_pct",
    "fpct":   "fielding_pct",
    "dp":     "double_plays",
    "sba":    "stolen_bases_against",
    "rcs":    "caught_stealing_by",
    "rcs%":   "cs_pct",
    "ci":     "catcher_interference",
}


def _norm(s):
    return re.sub(r"[^a-z]", "", (s or "").lower())


def get_session():
    s = requests.Session()
    s.headers.update({
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml",
        "Referer": "https://westcoastleague.com/",
    })
    mount_retries(s)
    return s


def fetch(session, season):
    url = (f"https://wclstats.com/sports/bsb/{season}/players"
           f"?sort=fpct&view=&pos=f&r=0")
    logger.info(f"GET {url}")
    r = wcl_fetch(session, url, timeout=45)
    r.raise_for_status()
    return r.text


def parse(html):
    """Find the fielding table by its header signature ('fpct' present)
    and return a list of dicts keyed by our DB column names."""
    soup = BeautifulSoup(html, "html.parser")
    target = None
    for t in soup.select("table"):
        headers = [th.get_text(strip=True).lower() for th in t.select("th")]
        if "f%" in headers or "fpct" in headers:
            target = t
            break
    if not target:
        return []

    headers = [th.get_text(strip=True).lower() for th in target.select("th")]
    col_keys = [HEADER_ALIASES.get(h, None) for h in headers]

    rows = []
    for tr in target.select("tbody tr"):
        cells = [td.get_text(" ", strip=True) for td in tr.select("td")]
        if len(cells) < len(headers):
            continue
        row = {}
        for i, key in enumerate(col_keys):
            if key:
                row[key] = cells[i]
        if not row.get("name"):
            continue
        rows.append(row)
    return rows


# ── DB helpers ─────────────────────────────────────────────────

def _league_id(cur, abbr):
    cur.execute("SELECT id FROM summer_leagues WHERE abbreviation = %s", (abbr,))
    row = cur.fetchone()
    if not row:
        raise RuntimeError(f"summer_leagues row for '{abbr}' missing")
    return row["id"]


def build_team_lookup(cur, league_id):
    cur.execute(
        "SELECT id, name, short_name FROM summer_teams WHERE league_id = %s",
        (league_id,),
    )
    out = {}
    for r in cur.fetchall():
        if r.get("name"):       out[_norm(r["name"])] = r["id"]
        if r.get("short_name"): out[_norm(r["short_name"])] = r["id"]
    return out


def resolve_team(team_lookup, name):
    key = _norm(name)
    if key in team_lookup:
        return team_lookup[key]
    for k, v in team_lookup.items():
        if k and (k in key or key in k) and len(k) >= 6:
            return v
    return None


def parse_name(raw):
    """Presto formats fielding cells as 'F Last' or 'F.\nLastname'."""
    norm = " ".join(raw.split())
    parts = norm.split()
    if len(parts) >= 2:
        first_initial = parts[0].rstrip(".").upper()[:1]
        last = " ".join(parts[1:])
        return first_initial, last
    return "", norm


def find_or_create_player(cur, team_id, first_initial, last_name):
    # Try exact initial + last match
    cur.execute(
        """
        SELECT id FROM summer_players
        WHERE team_id = %s AND LEFT(LOWER(first_name), 1) = LOWER(%s)
          AND LOWER(last_name) = LOWER(%s)
        LIMIT 1
        """,
        (team_id, first_initial, last_name),
    )
    row = cur.fetchone()
    if row:
        return row["id"]

    # Fall back to last-name-only if unique on team
    cur.execute(
        "SELECT id FROM summer_players WHERE team_id = %s AND LOWER(last_name) = LOWER(%s)",
        (team_id, last_name),
    )
    rows = cur.fetchall()
    if len(rows) == 1:
        return rows[0]["id"]

    # Create a stub so summer_fielding_stats has somewhere to land
    cur.execute(
        """
        INSERT INTO summer_players (first_name, last_name, team_id, position)
        VALUES (%s, %s, %s, %s)
        RETURNING id
        """,
        (first_initial, last_name, team_id, None),
    )
    return cur.fetchone()["id"]


def _to_int(v):
    if v in (None, "", "-", "—"):
        return 0
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def _to_pct(v):
    if v in (None, "", "-", "—"):
        return None
    try:
        # Presto sends 1.000, .983, etc.
        n = float(v)
        # CS% sometimes appears as "33.3"
        if n > 1.0:
            n = n / 100.0
        return n
    except (TypeError, ValueError):
        return None


def upsert(cur, *, player_id, team_id, season, data):
    cur.execute(
        """
        INSERT INTO summer_fielding_stats (
            player_id, team_id, season, position,
            games, total_chances, putouts, assists, errors,
            passed_balls, double_plays,
            stolen_bases_against, caught_stealing_by, catcher_interference,
            fielding_pct, cs_pct
        ) VALUES (%s, %s, %s, NULL, %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON CONFLICT (player_id, team_id, season, COALESCE(position, ''))
        DO UPDATE SET
            games = EXCLUDED.games,
            total_chances = EXCLUDED.total_chances,
            putouts = EXCLUDED.putouts,
            assists = EXCLUDED.assists,
            errors = EXCLUDED.errors,
            passed_balls = EXCLUDED.passed_balls,
            double_plays = EXCLUDED.double_plays,
            stolen_bases_against = EXCLUDED.stolen_bases_against,
            caught_stealing_by = EXCLUDED.caught_stealing_by,
            catcher_interference = EXCLUDED.catcher_interference,
            fielding_pct = EXCLUDED.fielding_pct,
            cs_pct = EXCLUDED.cs_pct,
            updated_at = CURRENT_TIMESTAMP
        """,
        (
            player_id, team_id, season,
            _to_int(data.get("games")),
            _to_int(data.get("total_chances")),
            _to_int(data.get("putouts")),
            _to_int(data.get("assists")),
            _to_int(data.get("errors")),
            _to_int(data.get("passed_balls")),
            _to_int(data.get("double_plays")),
            _to_int(data.get("stolen_bases_against")),
            _to_int(data.get("caught_stealing_by")),
            _to_int(data.get("catcher_interference")),
            _to_pct(data.get("fielding_pct")),
            _to_pct(data.get("cs_pct")),
        ),
    )


def run(season):
    session = get_session()
    html = fetch(session, season)
    rows = parse(html)
    logger.info(f"Parsed {len(rows)} fielding rows from WCL {season}")
    if not rows:
        logger.warning("No fielding rows — page format may have changed")
        return

    written = skipped = 0
    with get_connection() as conn:
        cur = conn.cursor()
        league_id = _league_id(cur, LEAGUE_ABBR)
        team_lookup = build_team_lookup(cur, league_id)
        for r in rows:
            tid = resolve_team(team_lookup, r.get("team", ""))
            if tid is None:
                skipped += 1
                continue
            first_initial, last = parse_name(r["name"])
            if not last:
                skipped += 1
                continue
            pid = find_or_create_player(cur, tid, first_initial, last)
            upsert(cur, player_id=pid, team_id=tid, season=season, data=r)
            written += 1
        conn.commit()

    logger.info(f"Wrote {written} rows · skipped {skipped} (no team match)")
    time.sleep(random.uniform(0.5, 1.2))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", type=int, default=2026)
    args = parser.parse_args()
    run(args.season)


if __name__ == "__main__":
    main()
