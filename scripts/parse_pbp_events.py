#!/usr/bin/env python3
"""
Phase 1 PBP parser — full per-plate-appearance event extraction.

Walks Sidearm box-score play-by-play, yields one dict per PA with all
the fields needed for the `game_events` table. Builds on the panel /
pitching-change scaffolding from parse_pbp_hr.py but produces full
event records instead of just HR counts.

Public function:
    parse_pbp_events(html, starters=None) -> (events_list, meta_dict)

Each event dict has these keys:
    inning, half ('top' | 'bottom'),
    sequence_idx,                 # order within the half-inning, 1-indexed
    batting_team_name,            # caption-derived; orchestrator maps to team_id
    defending_team_name,
    batter_name,                  # e.g. "Hartman,Max" or "Noah Meffert"
    pitcher_name,                 # current pitcher of defending side
    balls_before, strikes_before, # count BEFORE the PA-ending pitch
    pitch_sequence,               # e.g. "BBKBFFFB" (B/K/S/F/H letters), or "" if (0-0)
    pitches_thrown,               # len(pitch_sequence) + (1 if was_in_play else 0)
    was_in_play,                  # True for hits/outs in play, False for K/BB/HBP
    result_type,                  # see RESULT_TYPES below
    result_text,                  # full narrative line for debugging
    rbi,                          # parsed from "NRBI" in narrative

Standalone usage:
    python3 scripts/parse_pbp_events.py --file box.html
    python3 scripts/parse_pbp_events.py --url <sidearm boxscore url>
"""

import argparse
import re
import sys
from collections import defaultdict

import requests
from bs4 import BeautifulSoup


# ─────────────────────────────────────────────────────────────────
# Regex library
# ─────────────────────────────────────────────────────────────────

CAPTION_RE = re.compile(r"^\s*(.+?)\s*-\s*(Top|Bottom)\s+of\s+", re.IGNORECASE)

# Pitching change formats (both Sidearm versions)
PITCH_CHANGE_MODERN_RE = re.compile(
    r"^\s*([A-Z]{2,5})\s+pitching change:\s+(.+?)\s+replaces\s+(.+?)\.?\s*$"
)
PITCH_CHANGE_LEGACY_RE = re.compile(
    r"^\s*(.+?)\s+to\s+p\s+for\s+(.+?)\.?\s*$",
    re.IGNORECASE,
)

# Count + pitch sequence at end of every event line: "(3-2 BBKBFFFB)" or "(0-0)"
COUNT_SEQ_RE = re.compile(r"\((\d)-(\d)(?:\s+([A-Z]*))?\)")

# RBI: "RBI", "2RBI", "2 RBI", "4 RBI" — sometimes with a space, sometimes not
RBI_RE = re.compile(r"\b(\d+)\s*RBI\b", re.IGNORECASE)
SINGLE_RBI_RE = re.compile(r"\bRBI\b", re.IGNORECASE)


# ─────────────────────────────────────────────────────────────────
# Result-type classification
# ─────────────────────────────────────────────────────────────────
#
# Order matters: more specific patterns must match before general ones.
# Each entry is (compiled_regex, result_type, was_in_play).
#
# Compound results (e.g. "grounded into double play") collapse to the
# more interesting type. The loose "ground_out" / "fly_out" buckets
# mean exactly what the box score would call them.

RESULT_PATTERNS = [
    # Strikeouts (must check before "struck out" generic)
    (re.compile(r"\bstruck out swinging\b",       re.I), "strikeout_swinging", False),
    (re.compile(r"\bstruck out looking\b",        re.I), "strikeout_looking",  False),
    (re.compile(r"\bstruck out\b",                re.I), "strikeout_swinging", False),  # fallback when type isn't stated

    # Hit-by-pitch
    (re.compile(r"\bhit by pitch\b",              re.I), "hbp",                False),
    (re.compile(r"\bwas hit by pitch\b",          re.I), "hbp",                False),

    # Walks
    (re.compile(r"\bintentionally walked\b",      re.I), "intentional_walk",   False),
    (re.compile(r"\bwalked\b",                    re.I), "walk",               False),

    # Long hits before shorter (sub-string match safety)
    (re.compile(r"\bhomered\b",                   re.I), "home_run",           True),
    (re.compile(r"\btripled\b",                   re.I), "triple",             True),
    (re.compile(r"\bdoubled\b",                   re.I), "double",             True),
    (re.compile(r"\bsingled\b",                   re.I), "single",             True),

    # Sacrifice plays (must check before generic flied/grounded)
    (re.compile(r"\bsacrifice fly\b",             re.I), "sac_fly",            True),
    (re.compile(r"\bsac fly\b",                   re.I), "sac_fly",            True),
    (re.compile(r"\bsac bunt\b|\bsacrificed\b",   re.I), "sac_bunt",           True),

    # Special outs (DP first, then generic ground/fly/line/pop)
    (re.compile(r"\bgrounded into double play\b", re.I), "double_play",        True),
    (re.compile(r"\bgrounded into triple play\b", re.I), "triple_play",        True),

    # Generic outs
    (re.compile(r"\bgrounded out\b",              re.I), "ground_out",         True),
    (re.compile(r"\bflied out\b",                 re.I), "fly_out",            True),
    (re.compile(r"\blined out\b",                 re.I), "line_out",           True),
    (re.compile(r"\bpopped out\b|\bpopped up\b",  re.I), "pop_out",            True),
    (re.compile(r"\bfouled out\b",                re.I), "fly_out",            True),

    # Reached on …
    # The bare "fielder's choice" match (no "reached on" prefix) used
    # to be in this regex; we removed it because it was catching
    # runner-advance narratives like "Miles Bergman advanced to
    # second on a fielder's choice." — those are runner_other
    # sub-events, NOT batter PAs.  Real batter PAs always start with
    # "X reached on ..."; runner narratives start with "X advanced
    # to ..." and fall through to classify_subevent below.
    (re.compile(r"\breached on a fielder'?s choice\b|\breached on a fielders choice\b", re.I),
                                                         "fielders_choice",    True),
    # Same logic for errors — anchor on "reached" so a runner who
    # advances on an error doesn't get mis-classified as a PA.
    (re.compile(r"\breached (?:first |second |third )?on an? (?:fielding |throwing |muffed |dropped )?error\b", re.I),
                                                         "error",              True),

    # Catcher's interference is rare but real. Anchor on "reached
    # on" so any future runner-advance narrative referencing a
    # catcher's interference doesn't accidentally classify as a PA.
    (re.compile(r"\breached on catcher'?s interference\b", re.I), "catcher_interference", False),
]


def classify_result(text):
    """Return (result_type, was_in_play). Returns (None, None) if no event."""
    for pat, rtype, in_play in RESULT_PATTERNS:
        if pat.search(text):
            return rtype, in_play
    return None, None


# ─────────────────────────────────────────────────────────────────
# Sub-event classification
# ─────────────────────────────────────────────────────────────────
# Some PBP rows are not plate appearances — they are standalone
# happenings between PAs that affect base/out/score state:
#   stolen base, caught stealing (standalone), wild pitch, passed ball,
#   balk, pickoff, defensive indifference, runner-only advance.
# derive_event_state.py needs these as their own rows so the runner
# clauses can be applied to the base-state machine.
#
# Order matters: more specific (wild pitch / passed ball / balk) before
# generic stolen / caught-stealing / runner_other.
SUBEVENT_PATTERNS = [
    (re.compile(r"\bwild\s+pitch\b",                 re.I), "wild_pitch"),
    (re.compile(r"\bpassed\s+ball\b",                re.I), "passed_ball"),
    (re.compile(r"\bbalk\b",                         re.I), "balk"),
    (re.compile(r"\bcaught\s+stealing\b",            re.I), "caught_stealing"),
    (re.compile(r"\bstole\s+(?:second|third|home)\b", re.I), "stolen_base"),
    (re.compile(r"\bpicked\s+off\b",                 re.I), "pickoff"),
    # Catch-all: any runner movement / "out at" without one of the verbs above
    (re.compile(r"\b(?:advanced\s+to|scored|out\s+at)\b", re.I), "runner_other"),
]


def classify_subevent(text):
    """Return a sub-event result_type, or None if the row isn't a sub-event.

    Called only after classify_result returned None — so this never
    competes with PA classification.
    """
    # Failed pickoff attempts have no state change — don't waste a row.
    if re.search(r"failed\s+pickoff\s+attempt", text, re.I):
        return None
    for pat, stype in SUBEVENT_PATTERNS:
        if pat.search(text):
            return stype
    return None


# ─────────────────────────────────────────────────────────────────
# Substitution narrative classification (italic rows in PBP).
# ─────────────────────────────────────────────────────────────────
# Pinch runners are the only subs that affect base STATE — when "Jones
# pinch ran for Smith" appears, Jones takes Smith's spot on whichever
# base Smith was on. Pinch hitters don't need state work (the next PA
# already names the new batter). Defensive subs and position changes
# affect roster but not the bases.
#
# Pattern based on real Sidearm narratives sampled 2026-04-26:
#   "Braydon Olson pinch ran for Sam Mieszkowski-Lapping."
#   "Cadence Ueyama pinch ran for Jim O'Brien."
# Group 1 = new runner, group 2 = displaced runner.
PINCH_RUNNER_RE = re.compile(
    r"^(.+?)\s+(?:pinch|courtesy)\s+ran\s+for\s+(.+?)\.?\s*$",
    re.I,
)


def classify_substitution(text):
    """Detect substitution narratives that affect base STATE.

    Returns ('runner_sub', new_name, displaced_name) for pinch/courtesy
    runner subs. Returns None for everything else (pinch hitters,
    defensive subs, position changes, roster announcements) — those
    don't change which base has whom on it.
    """
    m = PINCH_RUNNER_RE.match((text or "").strip())
    if m:
        return ("runner_sub", m.group(1).strip(), m.group(2).strip())
    return None


# ─────────────────────────────────────────────────────────────────
# Per-row helpers
# ─────────────────────────────────────────────────────────────────

def extract_batter_name(text, result_type):
    """Pull the batter name from the start of the narrative.

    Sidearm narratives all start with 'Name {verb} ...' so we slice on
    the verb that triggered the classifier. We use a lookup table so we
    don't have to re-classify here.
    """
    # Use the result_type to know which verb to split on (mostly) —
    # except for some that don't begin with a verb like that.
    verb_anchors = {
        "home_run":            r"\bhomered\b",
        "triple":              r"\btripled\b",
        "double":              r"\bdoubled\b",
        "single":              r"\bsingled\b",
        "walk":                r"\b(?:was )?walked\b",
        # Sidearm narratives are "X was intentionally walked" — the
        # "was " prefix needs to be optionally consumed, otherwise
        # the extracted batter_name has " was" appended (which then
        # breaks any downstream code that does name-by-last-name match,
        # like the runner_sub state-machine swap).
        "intentional_walk":    r"\b(?:was )?intentionally walked\b",
        "hbp":                 r"\b(?:was )?hit by pitch\b",
        "strikeout_swinging":  r"\bstruck out\b",
        "strikeout_looking":   r"\bstruck out\b",
        "ground_out":          r"\bgrounded out\b",
        "double_play":         r"\bgrounded into double play\b",
        "triple_play":         r"\bgrounded into triple play\b",
        "fly_out":             r"\b(?:flied out|fouled out)\b",
        "line_out":            r"\blined out\b",
        "pop_out":             r"\bpopped (?:out|up)\b",
        # Sac fly narratives are "X flied out to lf, sacrifice fly,
        # RBI; Y scored." The classify_result regex anchors on
        # "sacrifice fly", but the BATTER name comes BEFORE the
        # verb ("flied out") — we need to anchor on whichever
        # play-verb appears at the start of the narrative, not on
        # the "sacrifice fly" tag (which comes after the verb).
        "sac_fly":             r"\b(?:flied out|fouled out|popped (?:out|up)|lined out|grounded out)\b",
        # Sac bunts most commonly start with "X sacrificed" but can
        # also start with a play verb. Cover both.
        "sac_bunt":            r"\b(?:sacrificed|grounded out|popped (?:out|up)|reached on|lined out)\b",
        # Anchored on "reached on" only — see RESULT_PATTERNS for why.
        # If a future Sidearm narrative uses a different phrasing for
        # the batter PA case, add it here, but do NOT fall back to a
        # bare "fielder's choice" / "error" match — that would catch
        # runner-advance narratives.
        "fielders_choice":     r"\breached on a fielder'?s choice\b|\breached on a fielders choice\b",
        "error":               r"\breached (?:first |second |third )?on an? (?:fielding |throwing |muffed |dropped )?error\b",
        # Catcher's interference narratives are "X reached on
        # catcher's interference" — anchor on "reached on" so we
        # don't slice off the trailing "reached on" as part of the
        # batter name.
        "catcher_interference": r"\breached on catcher'?s interference\b",
    }
    pattern = verb_anchors.get(result_type)
    if pattern:
        m = re.search(pattern, text, flags=re.IGNORECASE)
        if m:
            name = text[:m.start()].strip().rstrip(",").strip()
            # Defense in depth: strip trailing helping-verb fragments
            # ("was", "is", "were", "are") in case a future anchor we
            # add doesn't include the optional `(?:was )?` consumption.
            name = re.sub(r"\s+(?:was|is|were|are)$", "", name, flags=re.IGNORECASE)
            return name
    # Fallback: take everything before the first verb-like word
    parts = re.split(r"\s+(?=walked|homered|tripled|doubled|singled|struck|grounded|flied|lined|popped|reached|sacrificed)",
                     text, maxsplit=1)
    if parts:
        return parts[0].strip().rstrip(",").strip()
    return text.strip()[:60]


def parse_count_seq(text):
    """Return (balls_before, strikes_before, sequence) or (None, None, None).

    Some scorers (notably PLU's) print counts that include EVERY foul as
    a strike, producing impossible-looking counts like (0-4 KKF) on a
    flyout. Under standard baseball rules a count tops out at 3-2 before
    the PA-ending pitch — fouls past 2 strikes don't increment. We cap
    balls<=3 and strikes<=2 to normalize. The original count text and
    sequence are preserved in result_text for any future re-derivation.
    """
    m = COUNT_SEQ_RE.search(text)
    if not m:
        return None, None, None
    balls = min(int(m.group(1)), 3)
    strikes = min(int(m.group(2)), 2)
    seq = (m.group(3) or "").strip()
    return balls, strikes, seq


def parse_rbi(text):
    """Extract RBI count from narrative. Returns 0 if none mentioned."""
    m = RBI_RE.search(text)
    if m:
        return int(m.group(1))
    if SINGLE_RBI_RE.search(text):
        return 1
    return 0


# ─────────────────────────────────────────────────────────────────
# Main parser
# ─────────────────────────────────────────────────────────────────

def parse_pbp_events(html, starters=None):
    """Parse a Sidearm box-score HTML page into per-PA events.

    Args:
        html:     Page HTML
        starters: Optional dict {team_name: starter_pitcher_name} so any
                  event before the first pitching change on that side
                  has a real pitcher name (not "<UNKNOWN STARTER>").

    Returns:
        events: list of dicts (see module docstring)
        meta:   {has_pbp: bool, all_team_names: [str, ...], skipped_rows: int}
    """
    soup = BeautifulSoup(html, "html.parser")
    pbp_section = soup.find("section", id="play-by-play")
    meta = {"has_pbp": False, "all_team_names": [], "skipped_rows": 0}
    if not pbp_section:
        return [], meta

    all_div = pbp_section.find("div", id="inning-all")
    target = all_div if all_div else pbp_section

    # Discover team names from captions (always exactly two)
    team_names = set()
    for table in target.find_all("table", class_="play-by-play"):
        cap = table.find("caption")
        if cap:
            m = CAPTION_RE.match(cap.get_text(strip=True))
            if m:
                team_names.add(m.group(1).strip())
    if not team_names:
        return [], meta

    meta["has_pbp"] = True
    meta["all_team_names"] = sorted(team_names)

    # Per-team current-pitcher state, seeded with caller-provided starters
    current_pitcher = {}
    if starters:
        for team, starter in starters.items():
            current_pitcher[team] = starter

    events = []
    skipped = 0

    for table in target.find_all("table", class_="play-by-play"):
        cap = table.find("caption")
        if not cap:
            continue
        cap_text = cap.get_text(strip=True)
        m = CAPTION_RE.match(cap_text)
        if not m:
            continue
        batting_team = m.group(1).strip()
        half = "top" if m.group(2).lower() == "top" else "bottom"
        defending_candidates = team_names - {batting_team}
        if len(defending_candidates) != 1:
            continue
        defending_team = next(iter(defending_candidates))
        # Inning number from caption: "Top of 1st", "Bottom of 9th", etc.
        inning_match = re.search(r"of\s+(\d+)", cap_text, flags=re.IGNORECASE)
        inning = int(inning_match.group(1)) if inning_match else 0

        body = table.find("tbody")
        if not body:
            continue

        sequence_idx = 0
        for tr in body.find_all("tr"):
            first_td = tr.find("td")
            if not first_td:
                continue
            txt = first_td.get_text(" ", strip=True)
            if not txt:
                continue

            # ── Pitching change (modern or legacy) — update state, no event ──
            pc_modern = PITCH_CHANGE_MODERN_RE.match(txt)
            if pc_modern:
                _, new_p, old_p = pc_modern.group(1), pc_modern.group(2).strip(), pc_modern.group(3).strip()
                current_pitcher.setdefault(defending_team, old_p)
                current_pitcher[defending_team] = new_p
                continue

            classes = first_td.get("class") or []
            if "text-italic" in classes:
                pc_legacy = PITCH_CHANGE_LEGACY_RE.match(txt)
                if pc_legacy:
                    new_p, old_p = pc_legacy.group(1).strip(), pc_legacy.group(2).strip()
                    current_pitcher.setdefault(defending_team, old_p)
                    current_pitcher[defending_team] = new_p
                    continue
                # Italic but not a pitching change — could be a pinch
                # runner sub (which affects base state) or a fielding
                # sub / pinch hitter / mound visit (which don't).
                sub = classify_substitution(txt)
                if sub:
                    sub_type, _new_name, _old_name = sub
                    sequence_idx += 1
                    # Pinch runners come in BEFORE the next PA on the
                    # batting team. The pitcher hasn't changed, so we
                    # use the current pitcher as context for the row.
                    pitcher_name = current_pitcher.get(defending_team, "<UNKNOWN STARTER>")
                    events.append({
                        "inning": inning,
                        "half": half,
                        "sequence_idx": sequence_idx,
                        "batting_team_name": batting_team,
                        "defending_team_name": defending_team,
                        "batter_name": None,        # no batter for sub-event
                        "pitcher_name": pitcher_name,
                        "balls_before": 0,
                        "strikes_before": 0,
                        "pitch_sequence": "",
                        "pitches_thrown": 0,
                        "was_in_play": False,
                        "result_type": sub_type,
                        "result_text": txt,
                        "rbi": 0,
                    })
                    continue
                # Defensive sub, pinch hitter, mound visit, etc. —
                # nothing to record for state purposes.
                skipped += 1
                continue

            # ── Try to classify as a real PA event ──
            result_type, was_in_play = classify_result(txt)

            if not result_type:
                # Not a PA — try sub-event (standalone steal, WP, balk, etc.)
                sub = classify_subevent(txt)
                if sub:
                    sequence_idx += 1
                    pitcher_name = current_pitcher.get(defending_team, "<UNKNOWN STARTER>")
                    events.append({
                        "inning": inning,
                        "half": half,
                        "sequence_idx": sequence_idx,
                        "batting_team_name": batting_team,
                        "defending_team_name": defending_team,
                        "batter_name": None,            # no batter for sub-event
                        "pitcher_name": pitcher_name,
                        "balls_before": 0,
                        "strikes_before": 0,
                        "pitch_sequence": "",
                        "pitches_thrown": 0,
                        "was_in_play": False,
                        "result_type": sub,
                        "result_text": txt,
                        "rbi": 0,
                    })
                    continue
                # Mound visit, "(WSU)" notes, scoring summary echos, etc.
                skipped += 1
                continue

            balls, strikes, seq = parse_count_seq(txt)
            # Some non-events also have count strings, but we already
            # filtered those out via classify_result returning None.

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
                "result_text": txt,
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
    g.add_argument("--url",  help="Sidearm box-score URL")
    g.add_argument("--file", help="Local HTML file")
    ap.add_argument("--starter", action="append", default=[],
                    help='Seed starter as "Team Name=Pitcher Name" (repeatable)')
    ap.add_argument("--first", type=int, help="Print only first N events")
    args = ap.parse_args()

    if args.url:
        html = fetch_html(args.url)
    else:
        with open(args.file, "r", encoding="utf-8", errors="replace") as f:
            html = f.read()

    starters = {}
    for s in args.starter:
        if "=" in s:
            t, n = s.split("=", 1)
            starters[t.strip()] = n.strip()

    events, meta = parse_pbp_events(html, starters=starters)
    print(f"== Diagnostics ==")
    print(f"  has_pbp:     {meta['has_pbp']}")
    print(f"  teams:       {meta['all_team_names']}")
    print(f"  events:      {len(events)}")
    print(f"  skipped:     {meta['skipped_rows']}")
    print()

    by_type = defaultdict(int)
    for e in events:
        by_type[e["result_type"]] += 1
    print(f"== Result-type breakdown ==")
    for k, n in sorted(by_type.items(), key=lambda kv: -kv[1]):
        print(f"  {k:25} {n}")
    print()

    print(f"== Sample events ==")
    show = events if args.first is None else events[:args.first]
    for e in show:
        ip_marker = "X" if e["was_in_play"] else "."
        print(f"  T{e['inning']:>2} {e['half'][0]} #{e['sequence_idx']:>2}  "
              f"{e['balls_before']}-{e['strikes_before']} {e['pitch_sequence']:8} "
              f"[{ip_marker}] {e['result_type']:22} "
              f"{e['batter_name'][:20]:20} off {e['pitcher_name'][:20]:20} "
              f"({e['pitches_thrown']}p, {e['rbi']} RBI)")


if __name__ == "__main__":
    main()
