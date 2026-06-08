#!/usr/bin/env python3
"""
Backfill players.bats / players.throws for the D1 Nuxt schools (UW, Oregon,
Oregon St., Wash. St.) from their Sidearm-Nuxt roster pages.

These four sites render the roster client-side from a `__NUXT_DATA__` devalue
payload. Each player object carries `firstName`, `lastName`, and a custom field
(`custom1` on every site checked) holding the combined "B/T" token like 'L/R'
(bats / throws). Our stats scraper (`scrape_d1.py`) never parsed the roster
payload, so these schools sit at 0% handedness in every season — even 2026.

We pull each season's roster page, union the handedness we find (any season with
a value wins), then fill any player row on that team missing BOTH bats and throws.
We never overwrite an existing value and never touch stats. Match is full-name
(normalized), with a unique-last-name fallback — safe because these rosters carry
full first names.

Seattle U is the 5th 0% D1 school but is WMT-backed (api.wmt.games), not Nuxt —
handled separately.

Usage:
    PYTHONPATH=backend python3 scripts/backfill_handedness_d1.py --dry-run
    PYTHONPATH=backend python3 scripts/backfill_handedness_d1.py
    PYTHONPATH=backend python3 scripts/backfill_handedness_d1.py --team "Oregon St." --seasons 2018-2026
"""
import argparse
import json
import logging
import re
import time
import unicodedata

import requests
from bs4 import BeautifulSoup

from app.models.database import get_connection

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("backfill_handedness_d1")

UA = {"User-Agent": "Mozilla/5.0 (compatible; pnw-baseball-handedness/1.0)"}
BT_RE = re.compile(r"^([LRSB])/([LR])$")

D1_NUXT = {
    "UW": "https://gohuskies.com",
    "Oregon": "https://goducks.com",
    "Oregon St.": "https://osubeavers.com",
    "Wash. St.": "https://wsucougars.com",
    "Seattle U": "https://goseattleu.com",
}


def _na(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s or "") if not unicodedata.combining(c))


def _norm(s):
    return re.sub(r"[^a-z]", "", _na(s).lower())


def parse_nuxt_roster(html):
    """Parse a Sidearm-Nuxt roster page. Returns {(first_lc, last_lc): (bats, throws)}.

    The roster lives in the `__NUXT_DATA__` devalue array: a flat list where
    objects reference their string values by index. Two schemas occur:
      * Modern: player object has camelCase firstName/lastName and a custom field
        (e.g. `custom1`) that references the combined B/T token directly.
      * Legacy: player object has snake_case first_name/last_name and a
        `profile_field_values` list; one member object holds {value: 'R/R'}.
    We resolve the name, then find the B/T token via either path.
    """
    soup = BeautifulSoup(html, "html.parser")
    node = soup.find("script", id="__NUXT_DATA__")
    if not node or not node.string:
        return {}
    try:
        data = json.loads(node.string)
    except Exception:  # noqa: BLE001
        return {}
    if not isinstance(data, list):
        return {}

    bt_idx = {i for i, v in enumerate(data) if isinstance(v, str) and BT_RE.match(v)}
    if not bt_idx:
        return {}

    def rs(idx):  # resolve a string by index
        if isinstance(idx, int) and 0 <= idx < len(data) and isinstance(data[idx], str):
            return data[idx]
        return ""

    def direct_bt(obj):  # B/T token referenced directly as a field value
        for idx in obj.values():
            if isinstance(idx, int) and idx in bt_idx:
                return data[idx]
        return None

    out = {}
    for v in data:
        if not isinstance(v, dict):
            continue
        first = rs(v.get("firstName")) or rs(v.get("first_name"))
        last = rs(v.get("lastName")) or rs(v.get("last_name"))
        if not first or not last:
            continue
        bt_val = direct_bt(v)
        if not bt_val:  # legacy: descend into list fields (profile_field_values)
            for idx in v.values():
                if isinstance(idx, int) and 0 <= idx < len(data) and isinstance(data[idx], list):
                    for m in data[idx]:
                        if isinstance(m, int) and 0 <= m < len(data) and isinstance(data[m], dict):
                            cand = direct_bt(data[m])
                            if cand:
                                bt_val = cand
                                break
                    if bt_val:
                        break
        if not bt_val:
            continue
        m = BT_RE.match(bt_val)
        if not m:
            continue
        out[(first.lower(), last.lower())] = (m.group(1), m.group(2))
    return out


def team_roster_handedness(base_url, seasons):
    """Union handedness across all given seasons' Nuxt roster pages."""
    merged = {}
    seen_sig = set()
    base = base_url.rstrip("/")
    # bare /roster (no year) holds the current roster; some sites 404 on /roster/<current-year>
    urls = [(None, f"{base}/sports/baseball/roster")] + [(yr, f"{base}/sports/baseball/roster/{yr}") for yr in seasons]
    for yr, url in urls:
        try:
            r = requests.get(url, headers=UA, timeout=30)
            if r.status_code != 200:
                continue
            parsed = parse_nuxt_roster(r.text)
        except Exception as e:  # noqa: BLE001
            log.warning("    %s year=%s error: %s", base_url, yr, str(e)[:80])
            parsed = {}
        if parsed:
            # detect a year-param that just echoes the current roster (dedupe identical sets)
            sig = (len(parsed), tuple(sorted(parsed.keys()))[:5])
            dup = sig in seen_sig
            seen_sig.add(sig)
            log.info("    %s: %d players with handedness%s", yr or "current", len(parsed), "  (dup)" if dup else "")
        for key, cand in parsed.items():
            if key not in merged:
                merged[key] = cand
        time.sleep(0.4)
    return merged


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="Report but write nothing")
    ap.add_argument("--team", help="Only this DB short_name (e.g. 'Oregon St.')")
    ap.add_argument("--seasons", default="2018-2026", help="Inclusive range, e.g. 2018-2026")
    args = ap.parse_args()

    lo, hi = (int(x) for x in args.seasons.split("-"))
    seasons = list(range(hi, lo - 1, -1))
    teams = {args.team: D1_NUXT[args.team]} if args.team else D1_NUXT

    tot_updated = tot_unmatched = 0
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

            log.info("%s (team_id=%s): %d players missing handedness — fetching Nuxt rosters", short, team_id, len(missing))
            hand = team_roster_handedness(base, seasons)
            if not hand:
                log.info("  no Nuxt roster handedness found for %s", short)
                continue

            by_last = {}
            for (fl, ll), bt in hand.items():
                by_last.setdefault(_norm(ll), []).append((_norm(fl), bt))
            exact = {(_norm(fl), _norm(ll)): bt for (fl, ll), bt in hand.items()}

            updated = 0
            for p in missing:
                fl, ll = _norm(p["first_name"]), _norm(p["last_name"])
                bt = exact.get((fl, ll))
                if bt is None:
                    cands = by_last.get(ll, [])
                    if len(cands) == 1:
                        bt = cands[0][1]
                    else:
                        same = [c for c in cands if c[0][:1] == fl[:1]]
                        if len(same) == 1:
                            bt = same[0][1]
                if bt is None:
                    tot_unmatched += 1
                    continue
                bats, throws = bt
                log.info("  %-24s -> bats=%s throws=%s", f"{p['first_name']} {p['last_name']}", bats, throws)
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
    log.info("DONE — players updated: %d, unmatched: %d%s",
             tot_updated, tot_unmatched, "  (DRY RUN)" if args.dry_run else "")


if __name__ == "__main__":
    main()
