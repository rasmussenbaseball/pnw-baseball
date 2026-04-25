#!/usr/bin/env python3
"""
PrestoSports PBP parser — mirror of parse_pbp_events.py for NWAC.

Used by NWAC (nwacsports.com) and Willamette (wubearcats.com), and any
other team running PrestoSports. Narrative format is essentially the
same as Sidearm legacy (count + pitch sequence in parens, "X to p for Y"
pitching changes). HTML walking is different.

PrestoSports HTML structure:
  - PBP tab panel:  <section class="tab-panel plays clearfix active">
  - Inning sections: <section class="tab-panel ..." aria-label="...Inning">
  - Each inning has TWO half-inning <table role="presentation"> elements
  - Each half-inning has a header row with <h3> like "Top of 1st Inning"
    and <span class="offscreen">TeamName</span>
  - PA rows: <tr><td class="text">...narrative + (count seq)...</td></tr>
  - Out markers as inline text: "(1 out)", "(2 out)", "(3 out)"
  - Inning summary: <tr class="totals"> — skip
  - Scoring plays wrapped in <strong>
  - Pitching changes are PA-style rows with no count pattern
"""

import argparse
import re
import sys
from collections import defaultdict

import requests
from bs4 import BeautifulSoup


# Reuse classification + extraction from the Sidearm parser — same
# narrative grammar means the result-type regexes work as-is.
sys.path.insert(0, "scripts")
from parse_pbp_events import (
    classify_result,
    extract_batter_name,
    parse_count_seq,
    parse_rbi,
    PITCH_CHANGE_LEGACY_RE,
)


# Header h3 text looks like "Top of 1st Inning" or "Bottom of 9th Inning"
HEADER_RE = re.compile(r"(Top|Bottom)\s+of\s+(\d+)", re.IGNORECASE)


def parse_presto_events(html, starters=None):
    """Parse a PrestoSports box-score-with-plays HTML page.

    Args / Returns: identical signature to parse_pbp_events for the
    Sidearm parser so the orchestrator can use either interchangeably.
    """
    soup = BeautifulSoup(html, "html.parser")
    meta = {"has_pbp": False, "all_team_names": [], "skipped_rows": 0}

    # Find the All Plays section — has a <section> wrapping per-inning
    # tab-panels. The simplest reliable target: any tab-panel whose
    # aria-label contains "Inning" (multiple per game).
    inning_panels = soup.find_all(
        "section",
        attrs={"aria-label": re.compile(r"Inning", re.IGNORECASE)},
    )
    if not inning_panels:
        return [], meta

    # Discover the two team names from half-inning headers BEFORE the
    # main parse pass. Defending team is "the other one" per panel.
    team_names = set()
    for panel in inning_panels:
        for h3 in panel.find_all("h3"):
            offscreen = h3.find("span", class_="offscreen")
            if offscreen:
                t = offscreen.get_text(" ", strip=True)
                if t:
                    team_names.add(t)
    if len(team_names) < 2:
        return [], meta

    meta["has_pbp"] = True
    meta["all_team_names"] = sorted(team_names)

    current_pitcher = {}
    if starters:
        for team, starter in starters.items():
            current_pitcher[team] = starter

    events = []
    skipped = 0

    for panel in inning_panels:
        # Each panel has 2 half-inning <table role="presentation"> sections
        for table in panel.find_all("table", attrs={"role": "presentation"}):
            # Header row tells us batting team + Top/Bottom + inning number
            header = table.find("h3")
            if not header:
                continue
            header_text = header.get_text(" ", strip=True)
            m = HEADER_RE.search(header_text)
            if not m:
                continue
            half = "top" if m.group(1).lower() == "top" else "bottom"
            inning = int(m.group(2))
            offscreen = header.find("span", class_="offscreen")
            if not offscreen:
                continue
            batting_team = offscreen.get_text(" ", strip=True)
            defending_candidates = team_names - {batting_team}
            if len(defending_candidates) != 1:
                continue
            defending_team = next(iter(defending_candidates))

            sequence_idx = 0
            for tr in table.find_all("tr"):
                # Skip header row(s) and inning-summary row
                if "totals" in (tr.get("class") or []):
                    continue
                td = tr.find("td", class_="text")
                if not td:
                    continue
                # Strip the inline "(N out)" markers BEFORE parsing —
                # they're not part of the play narrative.
                raw_text = td.get_text(" ", strip=True)
                if not raw_text:
                    continue
                # Drop (N out) markers from end of text
                txt = re.sub(r"\(\d\s*out\)", "", raw_text).strip()

                # Pitching change row (legacy format only on Presto)
                pc = PITCH_CHANGE_LEGACY_RE.match(txt)
                if pc:
                    new_p, old_p = pc.group(1).strip(), pc.group(2).strip()
                    current_pitcher.setdefault(defending_team, old_p)
                    current_pitcher[defending_team] = new_p
                    continue

                # Try to classify as a real PA event
                result_type, was_in_play = classify_result(txt)
                if not result_type:
                    skipped += 1
                    continue

                balls, strikes, seq = parse_count_seq(txt)
                sequence_idx += 1
                batter_name = extract_batter_name(txt, result_type)
                pitcher_name = current_pitcher.get(defending_team, "<UNKNOWN STARTER>")
                pitches_thrown = (len(seq or "")
                                  + (1 if was_in_play else 0)
                                  if seq is not None else None)

                events.append({
                    "inning": inning,
                    "half": half,
                    "sequence_idx": sequence_idx,
                    "batting_team_name": batting_team,
                    "defending_team_name": defending_team,
                    "batter_name": batter_name,
                    "pitcher_name": pitcher_name,
                    "balls_before": balls or 0,
                    "strikes_before": strikes or 0,
                    "pitch_sequence": seq or "",
                    "pitches_thrown": pitches_thrown,
                    "was_in_play": was_in_play,
                    "result_type": result_type,
                    "result_text": raw_text,  # keep out markers in the audit string
                    "rbi": parse_rbi(txt),
                })

    meta["skipped_rows"] = skipped
    return events, meta


# ─────────────────────────────────────────────────────────────────
# CLI for local testing
# ─────────────────────────────────────────────────────────────────

USER_AGENT = "Mozilla/5.0 (compatible; pnw-baseball/0.1)"


def fetch_html(url):
    resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=30)
    resp.raise_for_status()
    return resp.text


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--url",  help="NWAC/Presto box-score URL (will append ?view=plays)")
    g.add_argument("--file", help="Local HTML file")
    ap.add_argument("--first", type=int, help="Print only first N events")
    args = ap.parse_args()

    if args.url:
        url = args.url if "view=plays" in args.url else (args.url + "?view=plays")
        html = fetch_html(url)
    else:
        with open(args.file, "r", encoding="utf-8", errors="replace") as f:
            html = f.read()

    events, meta = parse_presto_events(html)
    print("== Diagnostics ==")
    print(f"  has_pbp:     {meta['has_pbp']}")
    print(f"  teams:       {meta['all_team_names']}")
    print(f"  events:      {len(events)}")
    print(f"  skipped:     {meta['skipped_rows']}")
    print()

    by_type = defaultdict(int)
    for e in events:
        by_type[e["result_type"]] += 1
    print("== Result-type breakdown ==")
    for k, n in sorted(by_type.items(), key=lambda kv: -kv[1]):
        print(f"  {k:25} {n}")
    print()

    show = events if args.first is None else events[:args.first]
    print(f"== Sample events (first {len(show)}) ==")
    for e in show:
        ip = "X" if e["was_in_play"] else "."
        print(f"  T{e['inning']:>2} {e['half'][0]} #{e['sequence_idx']:>2}  "
              f"{e['balls_before']}-{e['strikes_before']} {e['pitch_sequence']:8} "
              f"[{ip}] {e['result_type']:22} "
              f"{e['batter_name'][:20]:20} off {e['pitcher_name'][:20]:20} "
              f"({e['pitches_thrown']}p, {e['rbi']} RBI)")


if __name__ == "__main__":
    main()
