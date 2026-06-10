#!/usr/bin/env python3
"""
Handedness backfill — fetch from a team's roster page and UPDATE players.bats/throws.

Built primarily to fix three PNW teams whose handedness gap was large:
  - Willamette       (PrestoSports site, school page DOES publish B/T)
  - Pacific          (Sidearm, school page omits B/T — needs alt source)
  - Warner Pacific   (Sidearm, school page omits B/T — needs alt source)

Each "source" is a function that returns a list of dicts:
  {first_name, last_name, jersey, bats, throws}

This file currently implements a Presto roster source (used by Willamette).
Pacific and Warner Pacific need NCAA / NAIA stats portal sources — added in
follow-up commits.

Usage
-----
Backfill one team in dry-run mode (recommended first):
    PYTHONPATH=backend python3 scripts/backfill_handedness.py \\
        --team Willamette --source presto-roster \\
        --url https://www.wubearcats.com/sports/bsb/2025-26/roster --dry-run

Same but actually write:
    PYTHONPATH=backend python3 scripts/backfill_handedness.py \\
        --team Willamette --source presto-roster \\
        --url https://www.wubearcats.com/sports/bsb/2025-26/roster
"""

import argparse
import logging
import re
import sys

import requests
from bs4 import BeautifulSoup

from app.models.database import get_connection


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("backfill_handedness")

USER_AGENT = "Mozilla/5.0 (compatible; pnw-baseball-handedness/0.1)"


def fetch_html(url):
    resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=30)
    resp.raise_for_status()
    return resp.text


# ─────────────────────────────────────────────────────────────────
# Source: PrestoSports roster page
# ─────────────────────────────────────────────────────────────────
#
# Presto roster pages (e.g. wubearcats.com/sports/bsb/2025-26/roster) put
# each player in a <tr>. Inside the row:
#   - The name lives in an <a aria-label="First Last: jersey number N: full bio">
#   - Handedness lives in <td data-field="bats_throws">R/R</td>
#   - Jersey lives in <td data-field="number">N</td>

ARIA_NAME_RE = re.compile(r"^(.+?):\s*jersey number", re.IGNORECASE)
HAND_RE = re.compile(r"^\s*([LRBS])\s*/\s*([LR])\s*$")


def parse_presto_roster(html):
    """Yield {first_name, last_name, jersey, bats, throws} dicts."""
    soup = BeautifulSoup(html, "html.parser")
    for tr in soup.find_all("tr"):
        bt_td = tr.find("td", attrs={"data-field": "bats_throws"})
        if not bt_td:
            continue
        bt_text = bt_td.get_text(" ", strip=True)
        # Strip the "B/T:" mobile label if present
        bt_text = re.sub(r"^B/T:\s*", "", bt_text, flags=re.IGNORECASE)
        m = HAND_RE.search(bt_text)
        if not m:
            # Empty cell — skip (player has no handedness listed)
            continue
        bats, throws = m.group(1).upper(), m.group(2).upper()

        # Find the player name from the anchor's aria-label
        full_name = None
        for a in tr.find_all("a", attrs={"aria-label": True}):
            label = a["aria-label"]
            n = ARIA_NAME_RE.match(label)
            if n:
                full_name = n.group(1).strip()
                break
        if not full_name:
            continue

        # Split into first / last (last word is last name; rest is first)
        parts = full_name.split()
        if len(parts) < 2:
            continue
        first_name = " ".join(parts[:-1])
        last_name = parts[-1]

        # Jersey (optional, useful as a tiebreaker)
        jersey = None
        num_td = tr.find("td", attrs={"data-field": "number"})
        if num_td:
            jt = re.sub(r"^No\.:\s*", "", num_td.get_text(" ", strip=True), flags=re.IGNORECASE)
            if jt.isdigit():
                jersey = int(jt)

        yield {
            "first_name": first_name,
            "last_name": last_name,
            "jersey": jersey,
            "bats": bats,
            "throws": throws,
        }


# ─────────────────────────────────────────────────────────────────
# DB update
# ─────────────────────────────────────────────────────────────────

def get_team_id(cur, team_short_name):
    cur.execute("SELECT id FROM teams WHERE short_name = %s", (team_short_name,))
    r = cur.fetchone()
    return r["id"] if r else None


def find_player(cur, team_id, first_name, last_name, jersey=None):
    """Try several name-match strategies. Returns player_id or None."""
    # Strategy 1: exact first + last (case-insensitive) on team
    cur.execute("""
        SELECT id, bats, throws FROM players
        WHERE team_id = %s
          AND LOWER(first_name) = LOWER(%s)
          AND LOWER(last_name) = LOWER(%s)
        LIMIT 2
    """, (team_id, first_name, last_name))
    rows = cur.fetchall()
    if len(rows) == 1:
        return rows[0]
    if len(rows) > 1 and jersey is not None:
        cur.execute("""
            SELECT id, bats, throws FROM players
            WHERE team_id = %s AND jersey_number = %s
              AND LOWER(last_name) = LOWER(%s)
            LIMIT 1
        """, (team_id, str(jersey), last_name))
        r = cur.fetchone()
        if r:
            return r

    # Strategy 2: last name only when unique on team
    cur.execute("""
        SELECT id, bats, throws FROM players
        WHERE team_id = %s AND LOWER(last_name) = LOWER(%s)
    """, (team_id, last_name))
    rows = cur.fetchall()
    if len(rows) == 1:
        return rows[0]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--team", required=True,
                    help="DB short_name of the team (e.g. 'Willamette')")
    ap.add_argument("--source", required=True,
                    choices=["presto-roster"],
                    help="Roster source format")
    ap.add_argument("--url", required=True, help="Roster URL to fetch")
    ap.add_argument("--dry-run", action="store_true",
                    help="Parse and report but write nothing")
    args = ap.parse_args()

    log.info(f"Fetching {args.url}")
    html = fetch_html(args.url)

    if args.source == "presto-roster":
        rows = list(parse_presto_roster(html))
    else:
        log.error(f"Unknown source: {args.source}")
        sys.exit(1)

    log.info(f"Parsed {len(rows)} rows with handedness")

    with get_connection() as conn:
        cur = conn.cursor()
        team_id = get_team_id(cur, args.team)
        if not team_id:
            log.error(f"Team not found: {args.team}")
            sys.exit(1)
        log.info(f"team_id={team_id} for {args.team}")

        updated = 0
        skipped = 0
        unmatched = []
        for r in rows:
            player = find_player(cur, team_id, r["first_name"], r["last_name"], r["jersey"])
            if not player:
                unmatched.append(f"{r['first_name']} {r['last_name']} (#{r['jersey']})")
                continue
            current_bats = player["bats"]
            current_throws = player["throws"]
            if current_bats == r["bats"] and current_throws == r["throws"]:
                skipped += 1
                continue
            log.info(f"  {r['first_name']:15} {r['last_name']:18}  "
                     f"{current_bats or '-'}/{current_throws or '-'} → {r['bats']}/{r['throws']}")
            if not args.dry_run:
                cur.execute("""
                    UPDATE players SET bats = %s, throws = %s WHERE id = %s
                """, (r["bats"], r["throws"], player["id"]))
            updated += 1

        if not args.dry_run:
            conn.commit()

        log.info("─" * 50)
        log.info(f"Updated: {updated}, already correct: {skipped}, unmatched: {len(unmatched)}")
        if unmatched:
            for u in unmatched:
                log.warning(f"  unmatched: {u}")


if __name__ == "__main__":
    main()
