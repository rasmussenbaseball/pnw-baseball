#!/usr/bin/env python3
"""Scrape season-level fielding stats from team Sidearm stats pages.

Why a separate scraper from scrape_boxscores.py:
- D1 schools with Sidearm JSON API endpoints expose per-game-per-position
  fielding via /api/v2/stats/boxscore/{id}. scrape_boxscores.py captures
  that into game_fielding and aggregate_fielding.py rolls it up.
- D2/D3/NAIA schools mostly DON'T have the JSON endpoint. Their per-game
  HTML box scores show Batting and Pitching tables but no Fielding table.
  However, their *season stats page* (/sports/baseball/stats/YYYY) does
  include an "Individual Overall Fielding Statistics" table with one row
  per player (positions collapsed). That's what this scraper pulls.
- Result: D1 gets per-position breakdowns; other Sidearm divisions get a
  single "All Positions" line per player. We store the latter with
  position='ALL' so the frontend can distinguish.

Run:
    cd /opt/pnw-baseball
    PYTHONPATH=backend python3 scripts/scrape_season_fielding.py --season 2026
    PYTHONPATH=backend python3 scripts/scrape_season_fielding.py --season 2026 --division D2
    PYTHONPATH=backend python3 scripts/scrape_season_fielding.py --season 2026 --team SMU

NWAC is not supported (their Presto pages don't expose fielding either,
documented in CLAUDE.md §10.18).
"""

from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup

# Make backend + scripts importable
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent / "backend"))
sys.path.insert(0, str(_HERE))

from app.models.database import get_connection  # noqa: E402
from scrape_boxscores import (  # noqa: E402
    D2_TEAMS, D3_TEAMS, NAIA_TEAMS,
    find_player_id, USER_AGENTS,
)


# Team groupings keyed by division
DIVISION_TEAMS = {
    "D2": D2_TEAMS,
    "D3": D3_TEAMS,
    "NAIA": NAIA_TEAMS,
}


def fetch_team_stats_page(base_url: str, season: int) -> str | None:
    """Fetch a Sidearm team's season stats page HTML."""
    url = f"{base_url}/sports/baseball/stats/{season}"
    headers = {
        "User-Agent": USER_AGENTS[0],
        "Accept": "text/html",
    }
    try:
        r = requests.get(url, headers=headers, timeout=30)
        if r.status_code == 200 and len(r.text) > 5000:
            return r.text
    except requests.RequestException as e:
        print(f"  fetch failed for {url}: {e}")
    return None


def parse_fielding_table(html: str) -> list[dict]:
    """Find the Individual Overall Fielding table and parse rows.

    Returns a list of dicts:
        { player_name, c, po, a, e, fld_pct, dp, sba, csb, pb, ci }
    Numeric values default to 0 on parse failure. fld_pct is float or None.
    """
    soup = BeautifulSoup(html, "html.parser")

    # Sidearm v3 marks the section with id="individual-overall-fielding"
    anchor = soup.find(id="individual-overall-fielding")
    table = anchor.find_next("table") if anchor else None

    # Fallback: scan headers for the Fielding section
    if table is None:
        for h in soup.find_all(["h2", "h3", "h4"]):
            t = h.get_text(strip=True).lower()
            if "individual overall fielding" in t or t == "fielding":
                table = h.find_next("table")
                if table:
                    break

    if table is None:
        return []

    # Header row → column index map
    first_row = table.find("tr")
    if not first_row:
        return []
    headers = [c.get_text(strip=True).upper() for c in first_row.find_all(["th", "td"])]

    # Build column index for each stat we care about.
    # Sidearm's header for "Player" column varies (sometimes "Player",
    # sometimes blank) — fall back to index 1.
    col = {}
    for i, h in enumerate(headers):
        col[h] = i
    # Index of player name column: usually 1 (after jersey #)
    name_idx = col.get("PLAYER", 1)

    def gi(row_cells: list[str], header: str) -> int:
        """Get integer at column named `header`, default 0."""
        idx = col.get(header)
        if idx is None or idx >= len(row_cells):
            return 0
        v = row_cells[idx].strip()
        try:
            return int(v)
        except ValueError:
            return 0

    def gf(row_cells: list[str], header: str) -> float | None:
        """Get float at column. Returns None on parse failure (so we don't
        confuse a parser miss with a true 0.000)."""
        idx = col.get(header)
        if idx is None or idx >= len(row_cells):
            return None
        v = row_cells[idx].strip()
        if not v or v == "-":
            return None
        try:
            return float(v)
        except ValueError:
            return None

    rows = []
    for tr in table.find_all("tr")[1:]:
        cells_raw = tr.find_all(["td", "th"])
        if not cells_raw:
            continue
        cell_texts = [c.get_text(strip=True) for c in cells_raw]
        if len(cell_texts) <= name_idx:
            continue
        name_raw = cell_texts[name_idx]
        # Sidearm sometimes duplicates the player name with the jersey
        # number embedded ("3Hoag, Isaac3Hoag, Isaac"). Clean it.
        name = _clean_player_name(name_raw)
        if not name or name.lower() == "totals":
            continue
        rows.append({
            "player_name": name,
            "c": gi(cell_texts, "C"),
            "po": gi(cell_texts, "PO"),
            "a": gi(cell_texts, "A"),
            "e": gi(cell_texts, "E"),
            "fld_pct": gf(cell_texts, "FLD%"),
            "dp": gi(cell_texts, "DP"),
            "sba": gi(cell_texts, "SBA"),
            "csb": gi(cell_texts, "CSB"),
            "pb": gi(cell_texts, "PB"),
            "ci": gi(cell_texts, "CI"),
        })
    return rows


def _clean_player_name(raw: str) -> str:
    """Strip jersey numbers and de-duplicate the doubled-up text Sidearm
    sometimes emits ("3Hoag, Isaac3Hoag, Isaac" → "Hoag, Isaac")."""
    if not raw:
        return ""
    # Remove leading digits (jersey number)
    s = re.sub(r"^\d+", "", raw).strip()
    # If the same name appears twice concatenated with a digit between,
    # take only the first half.
    m = re.match(r"^(.+?\b)\d+\1$", s)
    if m:
        s = m.group(1).strip()
    # Otherwise check the simpler case where the name just repeats
    half = len(s) // 2
    if half > 3 and s[:half].strip() == s[half:].strip():
        s = s[:half].strip()
    return s


def upsert_fielding_row(cur, *, player_id: int, team_id: int, season: int,
                       parsed: dict, games: int):
    """UPSERT one fielding_stats row with position='ALL'."""
    chances = parsed["po"] + parsed["a"] + parsed["e"]
    fld = parsed["fld_pct"]
    if fld is None and chances > 0:
        fld = round((parsed["po"] + parsed["a"]) / chances, 4)
    cs_pct = None
    if (parsed["sba"] + parsed["csb"]) > 0:
        cs_pct = round(parsed["csb"] / (parsed["sba"] + parsed["csb"]), 4)

    cur.execute(
        """
        INSERT INTO fielding_stats (
            player_id, team_id, season, position,
            games, putouts, assists, errors,
            double_plays, passed_balls,
            stolen_bases_against, caught_stealing_by,
            catchers_interference,
            fielding_pct, cs_pct
        ) VALUES (
            %s, %s, %s, 'ALL',
            %s, %s, %s, %s,
            %s, %s,
            %s, %s,
            %s,
            %s, %s
        )
        ON CONFLICT (player_id, season, position, team_id) DO UPDATE SET
            games = EXCLUDED.games,
            putouts = EXCLUDED.putouts,
            assists = EXCLUDED.assists,
            errors = EXCLUDED.errors,
            double_plays = EXCLUDED.double_plays,
            passed_balls = EXCLUDED.passed_balls,
            stolen_bases_against = EXCLUDED.stolen_bases_against,
            caught_stealing_by = EXCLUDED.caught_stealing_by,
            catchers_interference = EXCLUDED.catchers_interference,
            fielding_pct = EXCLUDED.fielding_pct,
            cs_pct = EXCLUDED.cs_pct,
            updated_at = now()
        """,
        (
            player_id, team_id, season,
            games,
            parsed["po"], parsed["a"], parsed["e"],
            parsed["dp"], parsed["pb"],
            parsed["sba"], parsed["csb"],
            parsed["ci"],
            fld, cs_pct,
        ),
    )


def _team_id_for_short(cur, short_name: str) -> int | None:
    cur.execute(
        "SELECT id FROM teams WHERE short_name = %s AND is_active = 1 LIMIT 1",
        (short_name,),
    )
    row = cur.fetchone()
    return row["id"] if row else None


def scrape_team(cur, short_name: str, team_config: tuple, season: int) -> int:
    """Scrape one team's fielding page. Returns rows upserted."""
    base_url, sport, platform = team_config
    if platform != "sidearm":
        return 0
    team_id = _team_id_for_short(cur, short_name)
    if not team_id:
        print(f"  {short_name}: no team_id resolved, skip")
        return 0

    print(f"  {short_name} <- {base_url}")
    html = fetch_team_stats_page(base_url, season)
    if not html:
        print(f"    fetch failed")
        return 0

    rows = parse_fielding_table(html)
    if not rows:
        print(f"    no fielding rows parsed")
        return 0

    # Games-played for each player so the fielding line says something
    # about sample size. Pull from batting_stats + pitching_stats so we
    # capture games played in any role.
    cur.execute(
        """
        SELECT player_id,
               GREATEST(MAX(games), 0) AS games
        FROM (
            SELECT player_id, COALESCE(games, 0) AS games
            FROM batting_stats WHERE team_id = %s AND season = %s
            UNION ALL
            SELECT player_id, COALESCE(games, 0) AS games
            FROM pitching_stats WHERE team_id = %s AND season = %s
        ) u
        GROUP BY player_id
        """,
        (team_id, season, team_id, season),
    )
    games_map = {r["player_id"]: r["games"] or 0 for r in cur.fetchall()}

    written = 0
    skipped = 0
    for parsed in rows:
        pid = find_player_id(cur, team_id, parsed["player_name"], season)
        if not pid:
            skipped += 1
            continue
        upsert_fielding_row(
            cur, player_id=pid, team_id=team_id, season=season,
            parsed=parsed, games=games_map.get(pid, 0),
        )
        written += 1
    print(f"    wrote {written}, skipped {skipped} unmatched")
    return written


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--division", type=str, default=None,
                    help="D2 / D3 / NAIA (omit for all three)")
    ap.add_argument("--team", type=str, default=None,
                    help="Single team short name (e.g. SMU)")
    args = ap.parse_args()

    targets: list[tuple[str, tuple]] = []
    div_filter = args.division.upper() if args.division else None
    for d, teams in DIVISION_TEAMS.items():
        if div_filter and d != div_filter:
            continue
        for short, cfg in teams.items():
            if args.team and short != args.team:
                continue
            targets.append((short, cfg))

    if not targets:
        print("No teams matched.")
        return 1

    print(f"Scraping season fielding for {len(targets)} teams, season {args.season}")
    total = 0
    with get_connection() as conn:
        cur = conn.cursor()
        for short, cfg in targets:
            try:
                total += scrape_team(cur, short, cfg, args.season)
                conn.commit()
            except Exception as e:
                print(f"  {short}: error {e}")
                conn.rollback()
            time.sleep(1.2)  # polite to the source

    print(f"\nDone. Wrote {total} fielding_stats rows total.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
