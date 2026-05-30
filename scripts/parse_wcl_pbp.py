#!/usr/bin/env python3
"""
WCL (wclstats.com) play-by-play parser.

wclstats.com runs PrestoSports, so the play NARRATIVE grammar is the
exact StatCrew/Presto format the Sidearm + NWAC parsers already handle
("Player singled to left field, RBI (2-1 FBB); Runner scored."). What
differs is only the HTML container layout, so we reuse the result
classifiers from parse_pbp_events and just re-implement the DOM walk.

Layout differences vs. parse_presto_events (NWAC / Willamette):
  - NWAC wraps each inning in  <section aria-label="...Inning">  with two
    half-inning <table role="presentation"> inside.
  - WCL puts ALL half-inning <table role="presentation"> directly under
    one  <section aria-label="All Plays">  (no per-inning <section>), so
    parse_presto_events finds zero inning panels and bails.

Each WCL half-inning table:
  <table class="table" role="presentation">
    <tr><td><div class="caption"><h3>
        <span class="team-logo"><img.../>
          <span class="offscreen">Nanaimo NightOwls</span></span>
        Top of  1st  Inning
    </h3></div></td></tr>
    <tr><td class="text">Aiden Nykoluk grounded out to ss (0-0). (1 out)</td></tr>
    ...
    <tr class="totals"><td class="text"><strong>Inning Summary: </strong>...</td></tr>

Output: (events, meta) — identical shape to parse_presto_events so the
summer PBP orchestrator can consume it the same way.

CLI:
    python3 scripts/parse_wcl_pbp.py --url https://wclstats.com/.../20260529_nqq1.xml
    python3 scripts/parse_wcl_pbp.py --file local.html --first 20
"""

import argparse
import re
import sys
from collections import defaultdict
from pathlib import Path

import requests
from bs4 import BeautifulSoup

# Same shared grammar classifiers the NWAC/Sidearm parsers use. The
# narrative format is identical, so these work verbatim.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from parse_pbp_events import (
    classify_result,
    classify_subevent,
    classify_substitution,
    extract_batter_name,
    parse_count_seq,
    parse_rbi,
    PITCH_CHANGE_LEGACY_RE,
)


# "Top of 1st" / "Bottom of 9th" — the digit run after "of" is the inning.
HEADER_RE = re.compile(r"(Top|Bottom)\s+of\s+(\d+)", re.IGNORECASE)


def _find_half_inning_tables(soup):
    """Return the per-half-inning <table role="presentation"> elements.

    Primary: the tables under <section aria-label="All Plays">.
    Fallback: any presentation table whose <h3> matches the
    Top/Bottom-of-N header (covers minor markup drift).
    """
    allplays = soup.find("section", attrs={"aria-label": "All Plays"})
    if allplays:
        tables = allplays.find_all("table", attrs={"role": "presentation"})
        if tables:
            return tables
    tables = []
    for t in soup.find_all("table", attrs={"role": "presentation"}):
        h = t.find("h3")
        if h and HEADER_RE.search(h.get_text(" ", strip=True)):
            tables.append(t)
    return tables


def parse_wcl_pbp(html, starters=None, home_team_name=None, away_team_name=None):
    """Parse a wclstats.com box-score-with-plays HTML page.

    Args mirror parse_presto_events:
      starters: optional {team_name: starting_pitcher_name}
      home_team_name / away_team_name: canonical names used as a fallback
        for batting-team attribution when a header's offscreen span is
        missing (top → away bats, bottom → home bats).

    Returns (events, meta).
    """
    soup = BeautifulSoup(html, "html.parser")
    meta = {"has_pbp": False, "all_team_names": [], "skipped_rows": 0,
            "team_fallback_used": False}

    tables = _find_half_inning_tables(soup)
    if not tables:
        return [], meta

    # Discover team names from the half-inning headers' offscreen spans.
    team_names = set()
    for table in tables:
        h3 = table.find("h3")
        if not h3:
            continue
        offscreen = h3.find("span", class_="offscreen")
        if offscreen:
            t = offscreen.get_text(" ", strip=True)
            if t:
                team_names.add(t)

    if len(team_names) < 2:
        if home_team_name and away_team_name:
            team_names = {home_team_name, away_team_name}
            meta["team_fallback_used"] = True
        else:
            return [], meta

    meta["has_pbp"] = True
    meta["all_team_names"] = sorted(team_names)

    current_pitcher = {}
    if starters:
        for team, starter in starters.items():
            current_pitcher[team] = starter

    events = []
    skipped = 0

    for table in tables:
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
        batting_team = offscreen.get_text(" ", strip=True) if offscreen else None
        if not batting_team and home_team_name and away_team_name:
            batting_team = away_team_name if half == "top" else home_team_name
            meta["team_fallback_used"] = True
        if not batting_team:
            continue
        defending_candidates = team_names - {batting_team}
        if len(defending_candidates) != 1:
            continue
        defending_team = next(iter(defending_candidates))

        sequence_idx = 0
        for tr in table.find_all("tr"):
            if "totals" in (tr.get("class") or []):
                continue
            td = tr.find("td", class_="text")
            if not td:
                continue
            raw_text = td.get_text(" ", strip=True)
            if not raw_text:
                continue
            # Strip "(N out)" markers — not part of the play narrative.
            txt = re.sub(r"\(\d\s*out\)", "", raw_text).strip()
            if not txt:
                continue

            # Pitching change (legacy "X to p for Y" grammar)
            pc = PITCH_CHANGE_LEGACY_RE.match(txt)
            if pc:
                new_p, old_p = pc.group(1).strip(), pc.group(2).strip()
                current_pitcher.setdefault(defending_team, old_p)
                current_pitcher[defending_team] = new_p
                continue

            result_type, was_in_play = classify_result(txt)
            if not result_type:
                sub = classify_subevent(txt)
                if sub:
                    sequence_idx += 1
                    events.append(_event(inning, half, sequence_idx, batting_team,
                                         defending_team, None,
                                         current_pitcher.get(defending_team, "<UNKNOWN STARTER>"),
                                         result_type=sub, result_text=raw_text))
                    continue
                sub_swap = classify_substitution(txt)
                if sub_swap:
                    sub_type, _new, _old = sub_swap
                    sequence_idx += 1
                    events.append(_event(inning, half, sequence_idx, batting_team,
                                         defending_team, None,
                                         current_pitcher.get(defending_team, "<UNKNOWN STARTER>"),
                                         result_type=sub_type, result_text=raw_text))
                    continue
                skipped += 1
                continue

            balls, strikes, seq = parse_count_seq(txt)
            sequence_idx += 1
            batter_name = extract_batter_name(txt, result_type)
            pitcher_name = current_pitcher.get(defending_team, "<UNKNOWN STARTER>")
            pitches_thrown = (len(seq or "") + (1 if was_in_play else 0)
                              if seq is not None else None)
            events.append(_event(inning, half, sequence_idx, batting_team,
                                 defending_team, batter_name, pitcher_name,
                                 balls_before=balls or 0, strikes_before=strikes or 0,
                                 pitch_sequence=seq or "", pitches_thrown=pitches_thrown,
                                 was_in_play=was_in_play, result_type=result_type,
                                 result_text=raw_text, rbi=parse_rbi(txt)))

    meta["skipped_rows"] = skipped
    return events, meta


def _event(inning, half, sequence_idx, batting_team, defending_team, batter_name,
           pitcher_name, balls_before=0, strikes_before=0, pitch_sequence="",
           pitches_thrown=0, was_in_play=False, result_type=None, result_text="",
           rbi=0):
    return {
        "inning": inning,
        "half": half,
        "sequence_idx": sequence_idx,
        "batting_team_name": batting_team,
        "defending_team_name": defending_team,
        "batter_name": batter_name,
        "pitcher_name": pitcher_name,
        "balls_before": balls_before,
        "strikes_before": strikes_before,
        "pitch_sequence": pitch_sequence,
        "pitches_thrown": pitches_thrown,
        "was_in_play": was_in_play,
        "result_type": result_type,
        "result_text": result_text,
        "rbi": rbi,
    }


# ─────────────────────────────────────────────────────────────────
# CLI for local testing
# ─────────────────────────────────────────────────────────────────

USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def fetch_html(url):
    resp = requests.get(url, headers={"User-Agent": USER_AGENT,
                                      "Referer": "https://westcoastleague.com/"},
                        timeout=30)
    resp.raise_for_status()
    return resp.text


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--url", help="wclstats.com box-score URL")
    g.add_argument("--file", help="Local HTML file")
    ap.add_argument("--first", type=int, help="Print only first N events")
    args = ap.parse_args()

    if args.url:
        html = fetch_html(args.url)
    else:
        with open(args.file, "r", encoding="utf-8", errors="replace") as f:
            html = f.read()

    events, meta = parse_wcl_pbp(html)
    print("== Diagnostics ==")
    print(f"  has_pbp:  {meta['has_pbp']}")
    print(f"  teams:    {meta['all_team_names']}")
    print(f"  events:   {len(events)}")
    print(f"  skipped:  {meta['skipped_rows']}")
    print()

    by_type = defaultdict(int)
    for e in events:
        by_type[e["result_type"]] += 1
    print("== Result-type breakdown ==")
    for k, n in sorted(by_type.items(), key=lambda kv: -kv[1]):
        print(f"  {str(k):25} {n}")
    print()

    show = events if args.first is None else events[:args.first]
    print(f"== Sample events (first {len(show)}) ==")
    for e in show:
        ip = "X" if e["was_in_play"] else "."
        bn = (e["batter_name"] or "—")[:20]
        pn = (e["pitcher_name"] or "—")[:20]
        print(f"  T{e['inning']:>2} {e['half'][0]} #{e['sequence_idx']:>2}  "
              f"{e['balls_before']}-{e['strikes_before']} {e['pitch_sequence']:8} "
              f"[{ip}] {str(e['result_type']):20} {bn:20} off {pn:20} "
              f"({e['pitches_thrown']}p, {e['rbi']} RBI)")


if __name__ == "__main__":
    main()
