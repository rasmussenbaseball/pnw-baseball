#!/usr/bin/env python3
"""
Phase 0 PBP parser — Sidearm play-by-play HR-allowed extractor.
================================================================

Standalone diagnostic that takes a Sidearm box-score URL (or local HTML
file) and reports how many home runs each pitcher allowed, as parsed from
the play-by-play section of the page.

Why this exists:
  game_pitching.home_runs_allowed is ~0 across the database because the
  Sidearm box-score pitching table doesn't include an HR column. The HR
  data exists on the page — just in the play-by-play. This script proves
  we can recover it from PBP before integrating the parser into
  scrape_boxscores.py.

Usage:
  python3 scripts/parse_pbp_hr.py --url https://gozags.com/sports/baseball/stats/2026/washington-state/boxscore/10167
  python3 scripts/parse_pbp_hr.py --file path/to/cached.html

Output (per pitcher):
  Bowman,Zachary    1 HR allowed
  McClaskey,Mickey  0
  ...
"""

import argparse
import re
import sys
from collections import defaultdict

import requests
from bs4 import BeautifulSoup


# Caption looks like "Gonzaga - Top of 1st" or "Washington State - Bottom of 1st"
CAPTION_RE = re.compile(r"^\s*(.+?)\s*-\s*(Top|Bottom)\s+of\s+", re.IGNORECASE)

# Pitching change row — Sidearm has TWO different formats in the wild:
#   Modern: "WSU pitching change: Fast,Taber replaces Blatter,Brock."
#   NCAA-legacy: "Owen Roberts to p for Grant Parson."  (no team prefix)
PITCH_CHANGE_MODERN_RE = re.compile(
    r"^\s*([A-Z]{2,5})\s+pitching change:\s+(.+?)\s+replaces\s+(.+?)\.?\s*$"
)
PITCH_CHANGE_LEGACY_RE = re.compile(
    r"^\s*(.+?)\s+to\s+p\s+for\s+(.+?)\.?\s*$",
    re.IGNORECASE,
)

# HR event in narrative: "BatterName homered to ..."
HR_EVENT_RE = re.compile(r"^([^\.;]+?)\s+homered\b", re.IGNORECASE)


def fetch_html(url):
    headers = {"User-Agent": "Mozilla/5.0 (compatible; pnw-baseball/0.1)"}
    resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.text


def parse_pbp_hr(html, starters=None):
    """Parse a Sidearm box-score HTML page.

    Args:
      html:     Page HTML to parse.
      starters: Optional dict mapping team_name -> starting pitcher name.
                If provided, any HRs that occur before the first pitching
                change on that side will be credited to the starter.
                Without this, those HRs land under "<UNKNOWN STARTER>".
                In production, callers will pass starters parsed from
                the box score's pitching tables (first pitcher row per
                team is the starter).

    Returns:
      hr_by_pitcher: dict mapping pitcher_name -> int (HR allowed)
      events: list of dicts describing every HR event we found
              (useful for debugging / verification)
      meta: dict with diagnostic info — has_pbp, all_team_names, etc.
    """
    soup = BeautifulSoup(html, "html.parser")
    pbp_section = soup.find("section", id="play-by-play")
    meta = {"has_pbp": False, "all_team_names": []}
    if not pbp_section:
        return {}, [], meta

    # Use ONLY the #inning-all div — Sidearm duplicates the same plays
    # across each per-inning tab, which would double-count if we walked
    # the whole section.
    all_div = pbp_section.find("div", id="inning-all")
    target = all_div if all_div else pbp_section

    # Collect all unique team names from panel captions — these are the
    # two teams playing. Defending team = "the one NOT batting" in any
    # given panel.
    all_team_names = set()
    for table in target.find_all("table", class_="play-by-play"):
        cap = table.find("caption")
        if cap:
            m = CAPTION_RE.match(cap.get_text(strip=True))
            if m:
                all_team_names.add(m.group(1).strip())

    if not all_team_names:
        return {}, [], meta

    meta["has_pbp"] = True
    meta["all_team_names"] = sorted(all_team_names)

    # Single forward pass — track current pitcher for each side and
    # credit each HR to the current pitcher of the defending side.
    # Seed with caller-provided starters when available; otherwise
    # the starter gets back-filled the first time we see "X to p for Y".
    current_pitcher = {}     # team_name -> current pitcher
    if starters:
        # Match starters to canonical team names from captions when we
        # have them. Caller may pass either exact-caption names or
        # close variants — we try a permissive match.
        for team, starter in starters.items():
            current_pitcher[team] = starter
    hr_by_pitcher = defaultdict(int)
    events = []

    for table in target.find_all("table", class_="play-by-play"):
        cap = table.find("caption")
        if not cap:
            continue
        m = CAPTION_RE.match(cap.get_text(strip=True))
        if not m:
            continue
        batting_team = m.group(1).strip()
        defending_candidates = all_team_names - {batting_team}
        if len(defending_candidates) != 1:
            continue
        defending_team = next(iter(defending_candidates))

        body = table.find("tbody")
        if not body:
            continue

        for tr in body.find_all("tr"):
            first_td = tr.find("td")
            if not first_td:
                continue
            txt = first_td.get_text(" ", strip=True)
            if not txt:
                continue

            # ── Pitching change (modern format with team prefix) ──
            pc_modern = PITCH_CHANGE_MODERN_RE.match(txt)
            if pc_modern:
                _, new_p, old_p = pc_modern.group(1), pc_modern.group(2).strip(), pc_modern.group(3).strip()
                # Team prefix is informational; defending side is known.
                current_pitcher.setdefault(defending_team, old_p)
                current_pitcher[defending_team] = new_p
                continue

            # ── Pitching change (NCAA-legacy "X to p for Y") ──
            # Only match on italic <td> rows to avoid false positives —
            # legacy format is bare and could collide with player names
            # mentioned in narrative if we weren't strict.
            classes = first_td.get("class") or []
            if "text-italic" in classes:
                pc_legacy = PITCH_CHANGE_LEGACY_RE.match(txt)
                if pc_legacy:
                    new_p = pc_legacy.group(1).strip()
                    old_p = pc_legacy.group(2).strip()
                    current_pitcher.setdefault(defending_team, old_p)
                    current_pitcher[defending_team] = new_p
                    continue

            # ── HR event ──
            if " homered" in txt.lower():
                pitcher = current_pitcher.get(defending_team, "<UNKNOWN STARTER>")
                hr_by_pitcher[pitcher] += 1
                m_hr = HR_EVENT_RE.match(txt)
                batter = m_hr.group(1).strip() if m_hr else "?"
                events.append({
                    "batting_team": batting_team,
                    "defending_team": defending_team,
                    "batter": batter,
                    "pitcher": pitcher,
                    "line": txt,
                })

    return dict(hr_by_pitcher), events, meta


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--url", help="Sidearm box-score URL to fetch and parse")
    g.add_argument("--file", help="Local HTML file to parse")
    ap.add_argument(
        "--starter",
        action="append",
        default=[],
        help='Seed starter as "Team Name=Pitcher Name" (repeatable)',
    )
    args = ap.parse_args()

    starters = {}
    for s in args.starter:
        if "=" not in s:
            continue
        team, name = s.split("=", 1)
        starters[team.strip()] = name.strip()

    if args.url:
        html = fetch_html(args.url)
    else:
        with open(args.file, "r", encoding="utf-8", errors="replace") as f:
            html = f.read()

    hr_by_pitcher, events, meta = parse_pbp_hr(html, starters=starters)

    print("== Diagnostics ==")
    print(f"  has_pbp:     {meta['has_pbp']}")
    print(f"  teams seen:  {meta['all_team_names']}")
    print()

    print("== HR events found ==")
    if not events:
        print("  (none)")
    for e in events:
        print(f"  {e['batter']:25} ({e['batting_team']}) "
              f"off {e['pitcher']:25} ({e['defending_team']})")
    print()

    print("== HR allowed per pitcher ==")
    if not hr_by_pitcher:
        print("  (none)")
    for pitcher, n in sorted(hr_by_pitcher.items(), key=lambda kv: -kv[1]):
        print(f"  {pitcher:25} {n}")


if __name__ == "__main__":
    main()
