#!/usr/bin/env python3
"""Scrape full 2026 WCL rosters from wclstats.com (Presto) for clean player
identity: full name + hometown (+ position, class year, B/T, ht/wt, jersey).

Why: summer_players names come from box scores, which abbreviate first names
("L Dykstra") and never carry hometown. Each team's Presto roster page
(/sports/bsb/2026/teams/<slug>?view=roster) has a roster table with full names
and hometowns. This pulls that and (with --commit) reconciles it into
summer_players: matches roster players to existing rows by last name + first
initial and fills in the full name + hometown + bio fields.

Dry run (default): fetch + parse all teams, print a summary, write the parsed
rosters to /tmp/wcl_rosters_2026.json. No DB writes.
    python3 scripts/scrape_wcl_rosters.py
    python3 scripts/scrape_wcl_rosters.py --team 3        # one team (summer_teams.id)
    PYTHONPATH=backend python3 scripts/scrape_wcl_rosters.py --commit   # write to DB
"""
import argparse
import json
import re
import sys
import time

import requests
from bs4 import BeautifulSoup

BASE = "https://wclstats.com/sports/bsb/2026/teams/{slug}?view=roster"

# summer_teams.id -> wclstats Presto slug (slugs taken from the teams index page
# logo filenames; Presto is case-insensitive on these).
TEAM_SLUGS = {
    1:  "bellinghambells",
    9:  "bendelks",
    10: "corvallisknights",
    2:  "edmontonriverhawks",
    3:  "kamloopsnorthpaws",
    4:  "kelownafalcons",
    12: "marionberries",
    5:  "nanaimonightowls",
    6:  "portangeleslefties",
    13: "portlandpickles",
    14: "ridgefieldraptors",
    15: "springfielddrifters",
    7:  "victoriaharbourcats",
    16: "wallawallasweets",
    8:  "wenatcheeapplesox",
    17: "yakimavalleypippins",
}

YEAR_MAP = {
    "fr": "Freshman", "so": "Sophomore", "jr": "Junior", "sr": "Senior",
    "gr": "Graduate", "gs": "Graduate", "r-fr": "Redshirt Freshman",
    "r-so": "Redshirt Sophomore", "r-jr": "Redshirt Junior", "r-sr": "Redshirt Senior",
}
SUFFIXES = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"}


def fetch(slug):
    s = requests.Session()
    s.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Referer": "https://westcoastleague.com/",
    })
    last = None
    for attempt in range(5):
        try:
            r = s.get(BASE.format(slug=slug), timeout=30)
            # wclstats rate-limits with HTTP 202 + an empty/short body. That's a
            # 2xx so raise_for_status() won't catch it — detect and retry with
            # exponential backoff so we don't silently parse an empty page.
            if r.status_code == 202 or len(r.text) < 5000:
                raise requests.HTTPError(f"rate-limited (status {r.status_code}, {len(r.text)}b)")
            r.raise_for_status()
            return r.text
        except Exception as e:
            last = e
            time.sleep(4 * (attempt + 1))   # 4, 8, 12, 16s
    raise last


def split_name(full):
    """'Tanner Mitchell' -> ('Tanner', 'Mitchell'); keep suffixes with last name."""
    full = re.sub(r"\s+", " ", (full or "").strip())
    if not full:
        return "", ""
    toks = full.split(" ")
    if len(toks) == 1:
        return "", toks[0]
    first = toks[0]
    last = " ".join(toks[1:])
    return first, last


def parse_roster(html):
    """Return list of player dicts from the roster table (headers include
    'Name' and 'Hometown')."""
    soup = BeautifulSoup(html, "html.parser")
    target = None
    for t in soup.find_all("table"):
        hdrs = [th.get_text(" ", strip=True).lower() for th in t.find_all("th")]
        if "name" in hdrs and "hometown" in hdrs:
            target = (t, hdrs)
            break
    if not target:
        return []
    table, hdrs = target
    idx = {h: i for i, h in enumerate(hdrs)}
    players = []
    for tr in table.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) < len(hdrs):
            continue
        cells = [td.get_text(" ", strip=True) for td in tds]

        def cell(key):
            i = idx.get(key)
            return cells[i].strip() if i is not None and i < len(cells) else ""

        name = cell("name")
        if not name or name == "#":
            continue
        first, last = split_name(name)
        yr_raw = cell("year").lower().strip()
        players.append({
            "jersey": cell("#") or None,
            "full_name": name,
            "first_name": first,
            "last_name": last,
            "position": cell("position") or None,
            "year_in_school": YEAR_MAP.get(yr_raw, cell("year") or None),
            "bats": (cell("bats") or None),
            "throws": (cell("throws") or None),
            "height": cell("height") or None,
            "weight": cell("weight") or None,
            "hometown": cell("hometown") or None,
        })
    return players


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--team", type=int, help="single summer_teams.id (debug)")
    ap.add_argument("--commit", action="store_true", help="write to DB (reconcile)")
    ap.add_argument("--out", default="/tmp/wcl_rosters_2026.json")
    args = ap.parse_args()

    teams = {args.team: TEAM_SLUGS[args.team]} if args.team else TEAM_SLUGS
    all_rosters = {}
    for tid, slug in teams.items():
        try:
            html = fetch(slug)
            roster = parse_roster(html)
            all_rosters[tid] = roster
            with_home = sum(1 for p in roster if p["hometown"])
            print(f"team {tid:>3} {slug:<22} {len(roster):>3} players, {with_home} with hometown")
            time.sleep(3)
        except Exception as e:
            print(f"team {tid:>3} {slug:<22} FAILED: {e}")
            all_rosters[tid] = []

    total = sum(len(r) for r in all_rosters.values())
    print(f"\nTOTAL: {total} roster players across {len(all_rosters)} teams")
    with open(args.out, "w") as f:
        json.dump(all_rosters, f, indent=2)
    print(f"wrote {args.out}")

    # show a sample
    if teams:
        first_tid = next(iter(all_rosters))
        print(f"\n--- sample (team {first_tid}) ---")
        for p in all_rosters[first_tid][:6]:
            print(f"  #{p['jersey']:<3} {p['full_name']:<24} {p['position'] or '':<4} "
                  f"{p['year_in_school'] or '':<10} {p['bats'] or '-'}/{p['throws'] or '-'}  {p['hometown'] or ''}")

    if args.commit:
        print("\n--commit reconciliation not yet wired; run dry first.")


if __name__ == "__main__":
    main()
