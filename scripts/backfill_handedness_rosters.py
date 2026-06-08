#!/usr/bin/env python3
"""
Backfill players.bats / players.throws from archived Sidearm rosters.

Handedness is a STABLE per-player attribute, but our players rows only carry it
for players whose roster was scraped in a season we ran (mostly 2026). Players
whose careers ended earlier are blank (0% for 2023 and back). Sidearm sites,
though, keep per-season roster pages, and the responsive-roster JSON endpoint
accepts a ?year= param — so we can recover handedness for past seasons.

For each Sidearm four-year team we pull every season's roster, union the B/T we
find (any season with a value wins), then fill in any player row on that team
that is currently missing BOTH bats and throws. We never overwrite an existing
value and never touch stats.

NWAC (Presto) is intentionally excluded — their roster pages don't publish B/T.
WMT/Nuxt D1 sites (Oregon, Oregon St, UW, Wash St) don't expose the Sidearm
roster endpoint; they're listed best-effort and simply yield nothing.

Usage:
    PYTHONPATH=backend python3 scripts/backfill_handedness_rosters.py --dry-run
    PYTHONPATH=backend python3 scripts/backfill_handedness_rosters.py
    PYTHONPATH=backend python3 scripts/backfill_handedness_rosters.py --team Linfield --seasons 2019-2026
"""
import argparse
import logging
import re
import time

import requests
from bs4 import BeautifulSoup

from app.models.database import get_connection

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("backfill_handedness_rosters")

UA = {"User-Agent": "Mozilla/5.0 (compatible; pnw-baseball-handedness/1.0)"}
BT_RE = re.compile(r"^([LRSB])\s*/\s*([LR])$")

# Sidearm four-year programs: DB short_name -> athletics base URL.
# (NWAC/Presto + Willamette/Presto excluded; WMT D1 sites are best-effort.)
SIDEARM_TEAMS = {
    # GNAC (D2)
    "CWU": "https://wildcatsports.com", "SMU": "https://smusaints.com",
    "MSUB": "https://msubsports.com", "WOU": "https://wouwolves.com",
    "NNU": "https://nnusports.com",
    # NWC (D3)
    "UPS": "https://loggerathletics.com", "PLU": "https://golutes.com",
    "Whitman": "https://athletics.whitman.edu", "Whitworth": "https://whitworthpirates.com",
    "L&C": "https://golcathletics.com", "Pacific": "https://goboxers.com",
    "Linfield": "https://golinfieldwildcats.com", "GFU": "https://athletics.georgefox.edu",
    # CCC (NAIA)
    "LCSC": "https://lcwarriors.com", "EOU": "https://eousports.com",
    "OIT": "https://oregontechowls.com", "C of I": "https://yoteathletics.com",
    "Corban": "https://corbanwarriors.com", "Bushnell": "https://bushnellbeacons.com",
    "Warner Pacific": "https://wpuknights.com", "UBC": "https://gothunderbirds.ca",
    # D1 (best-effort; WMT/Nuxt sites yield nothing and are skipped gracefully)
    "Gonzaga": "https://gozags.com", "Portland": "https://portlandpilots.com",
}

def parse_roster_html(html):
    """Parse a Sidearm roster page. Returns {(first_lc,last_lc): (bats,throws)}.

    Sidearm renders each player as a `li.sidearm-roster-player` card. Handedness
    sits in a value span (class varies — bats/throws, custom1, etc.) as a "B/T"
    string like 'R/L', so we match the VALUE pattern anywhere in the card rather
    than a fixed class. The name span prefixes the jersey number ('2 Kyle Clay').
    """
    soup = BeautifulSoup(html, "html.parser")
    cards = soup.select("li.sidearm-roster-player") or soup.select(".sidearm-roster-player")
    out = {}
    for c in cards:
        bats = throws = None
        for el in c.find_all(["span", "td", "div"]):
            m = BT_RE.match(el.get_text(strip=True))
            if m:
                bats, throws = m.group(1), m.group(2)
                break
        if not bats and not throws:
            continue
        nm = c.select_one(".sidearm-roster-player-name") or c.find("a")
        name = nm.get_text(" ", strip=True) if nm else ""
        name = re.sub(r"^\s*#?\d+\s+", "", name).strip()  # drop leading jersey number
        parts = name.split()
        if len(parts) < 2:
            continue
        out[(parts[0].lower(), parts[-1].lower())] = (bats, throws)
    return out


def team_roster_handedness(base_url, seasons):
    """Union handedness across all given seasons' roster pages."""
    merged = {}
    for yr in seasons:
        url = f"{base_url.rstrip('/')}/sports/baseball/roster/{yr}"
        try:
            r = requests.get(url, headers=UA, timeout=30)
            if r.status_code != 200:
                continue
            parsed = parse_roster_html(r.text)
        except Exception as e:  # noqa: BLE001
            log.warning("    %s year=%s error: %s", base_url, yr, str(e)[:80])
            parsed = {}
        for key, cand in parsed.items():
            prev = merged.get(key)
            if prev is None or prev.count(None) > cand.count(None):
                merged[key] = cand
        if parsed:
            log.info("    year=%s: %d players with handedness", yr, len(parsed))
        time.sleep(0.4)
    return merged


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="Report but write nothing")
    ap.add_argument("--team", help="Only this DB short_name")
    ap.add_argument("--seasons", default="2019-2026", help="Inclusive range, e.g. 2019-2026")
    args = ap.parse_args()

    lo, hi = (int(x) for x in args.seasons.split("-"))
    seasons = list(range(hi, lo - 1, -1))  # newest first
    teams = {args.team: SIDEARM_TEAMS[args.team]} if args.team else SIDEARM_TEAMS

    tot_updated = tot_matched_full = tot_unmatched = 0
    with get_connection() as conn:
        conn.autocommit = False
        cur = conn.cursor()
        for short, base in teams.items():
            cur.execute("SELECT id FROM teams WHERE short_name = %s ORDER BY is_active DESC LIMIT 1", (short,))
            row = cur.fetchone()
            if not row:
                log.warning("  %s: team not found in DB", short)
                continue
            team_id = row["id"]

            # Players on this team currently missing BOTH bats and throws.
            cur.execute("""
                SELECT id, first_name, last_name
                FROM players
                WHERE team_id = %s
                  AND COALESCE(is_phantom, FALSE) = FALSE
                  AND (bats IS NULL OR bats = '') AND (throws IS NULL OR throws = '')
            """, (team_id,))
            missing = cur.fetchall()
            if not missing:
                log.info("%s (team_id=%s): no players missing handedness", short, team_id)
                continue

            log.info("%s (team_id=%s): %d players missing handedness — fetching rosters", short, team_id, len(missing))
            hand = team_roster_handedness(base, seasons)
            if not hand:
                log.info("  no roster handedness found for %s (likely non-Sidearm)", short)
                continue

            # last_name -> list of (first_lc, (bats,throws)) for unique-last fallback
            by_last = {}
            for (fl, ll), bt in hand.items():
                by_last.setdefault(ll, []).append((fl, bt))

            updated = 0
            for p in missing:
                fl, ll = (p["first_name"] or "").lower(), (p["last_name"] or "").lower()
                bt = hand.get((fl, ll))
                if bt is None:
                    cands = by_last.get(ll, [])
                    if len(cands) == 1:  # unique last name on roster
                        bt = cands[0][1]
                if bt is None:
                    tot_unmatched += 1
                    continue
                bats, throws = bt
                if bats is None and throws is None:
                    continue
                tot_matched_full += 1
                log.info("  %-22s -> bats=%s throws=%s", f"{p['first_name']} {p['last_name']}", bats or "-", throws or "-")
                if not args.dry_run:
                    cur.execute(
                        "UPDATE players SET bats = COALESCE(%s, bats), throws = COALESCE(%s, throws), "
                        "updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                        (bats, throws, p["id"]),
                    )
                updated += 1
            tot_updated += updated
            log.info("  %s: updated %d / %d missing", short, updated, len(missing))
            if not args.dry_run:
                conn.commit()

    log.info("=" * 56)
    log.info("DONE — players updated: %d, matched: %d, unmatched: %d%s",
             tot_updated, tot_matched_full, tot_unmatched, "  (DRY RUN)" if args.dry_run else "")


if __name__ == "__main__":
    main()
