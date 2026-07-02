#!/usr/bin/env python3
"""
Classify batted-ball type and field zone from a Sidearm/Presto PBP
narrative.

Both Sidearm and Presto encode batted-ball type in the verb and field
zone in the "to X" tail of the narrative. This module turns those into
two simple categorical columns:

    bb_type    : 'GB' | 'FB' | 'LD' | 'PU' | None
    field_zone : 'LEFT' | 'CENTER' | 'RIGHT' | None

Pull / Center / Oppo is computed at API time by combining field_zone
with players.bats — no extra column needed.

NULL classification is OK for:
  - Strikeouts / walks / HBP / catcher_interference (no contact)
  - Sub-event rows
  - Narratives where the verb / location is missing or unparseable
    (the row is skipped silently rather than mis-classified)

Public function:
    classify(result_type, result_text) -> (bb_type, field_zone)

Standalone CLI for spot-checking:
    python3 scripts/classify_batted_ball.py --sample 30
"""

from __future__ import annotations
import re
from typing import Optional, Tuple


# ─────────────────────────────────────────────────────────────────
# Regex library
# ─────────────────────────────────────────────────────────────────

# Strip Presto's "(1 out)" / "(2 out)" / "(3 out)" inline markers — these
# appear at the end of some narratives and confuse downstream parsing.
_OUT_MARKER_RE = re.compile(r"\(\d\s*out\)", re.IGNORECASE)

# Strip count + pitch sequence: "(3-2 BBKBF)" anywhere near the end of
# the clause (with possible trailing period and whitespace).
_COUNT_TAIL_RE = re.compile(r"\s*\(\d-\d[^)]*\)\s*\.?\s*$")
# Also strip a plain trailing period (for narratives without a count tail)
_TRAILING_PERIOD_RE = re.compile(r"\s*\.\s*$")

# Full classification verb + location pattern.
# Captures: (verb, location-string-up-to-period-or-comma)
# Middle word is optional: "flied OUT to", "popped UP to", "singled to"
# (no middle word for hits / homered).
_VERB_LOC_RE = re.compile(
    r"\b(?P<verb>grounded|flied|lined|popped|fouled|"
    r"singled|doubled|tripled|homered)"
    r"(?:\s+(?:out|up))?\s+"
    # "to" / "into" / "up the" / "down the" / "through the"
    r"(?:to|into|up\s+the|down\s+the|through\s+the)\s+"
    # The location chunk: any letters/numbers/spaces until a sentence
    # break. Excludes commas (next clause) and periods.
    r"(?P<loc>[a-z0-9 ]+?)"
    r"(?=\s*(?:[,.;]|RBI|unassisted|sacrifice|advanced|scored|out\s+at|$))",
    re.IGNORECASE,
)

# For 'error' result_type — narrative is "reached on an error by X" or
# "reached on a fielding error by X" where X is the FIELDER position.
# The ball went toward that fielder, so X is a usable proxy for zone.
_ERROR_BY_RE = re.compile(
    r"reached\s+on\s+(?:an?\s+)?(?:\w+\s+)?error\s+by\s+(?P<loc>[a-z0-9, .]+?)"
    r"(?=\s*(?:[,.;(]|$))",
    re.IGNORECASE,
)

# Special sub-patterns we want to recognize for bb_type assignment
_GROUNDED_DP_RE = re.compile(r"\bgrounded\s+into\s+(?:double|triple)\s+play\b", re.I)

# Depth/trajectory keywords that strongly imply a fly ball trajectory.
# Tightened to avoid false positives: "deep" only counts when followed by
# an OF reference; "in front of" was removed (it usually flags LDs that
# fall in front of an outfielder, not flies).
_FB_KEYWORDS_RE = re.compile(
    r"(?:"
    # "deep to LF / deep into the gap / deep over" — fly-ball language only
    # when paired with an OF or directional reference.
    r"\bdeep\s+(?:to|into|over|down|toward(?:s)?)\s+"
        r"(?:lf|cf|rf|left|center|centerfield|right|the\s+gap|"
        r"the\s+(?:wall|fence|track))\b|"
    # Off-the-wall / fence — unambiguous FB
    r"\boff\s+the\s+(?:wall|fence|fences)\b|"
    # Warning track — unambiguous FB
    r"\bwarning\s+track\b|"
    # Hit "to the wall/fence/track" — unambiguous FB
    r"\bto\s+the\s+(?:wall|fence|track)\b|"
    # Bloop / dunk / Texas leaguer — soft FBs
    r"\bbloop(?:er|ed)?\b|"
    r"\bdunked?\b|"
    r"\btexas\s+leaguer\b|"
    # Over the head / wall / fence / fielder — fly trajectory
    r"\bover\s+the\s+(?:head|wall|fence|"
        r"(?:left|center|right)\s+fielder)\b|"
    # Between two outfielders — split-the-gap fly
    r"\bbetween\s+(?:the\s+)?(?:lf|cf|rf|"
        r"left\s+(?:fielder)?|"
        r"center\s+(?:fielder)?|"
        r"right\s+(?:fielder)?)\s+(?:and|&)"
    r")",
    re.IGNORECASE,
)


# ─────────────────────────────────────────────────────────────────
# Field zone classification
# ─────────────────────────────────────────────────────────────────

# Cleaned location -> zone. Each list element is matched as a
# whole-token / substring against the lowercased location string.
_ZONE_PATTERNS = [
    # LEFT: anything left-side
    ("LEFT",   ["lf", "left field", "left center", "left side", "lf line",
                "ss", "shortstop", "3b", "third base", "third"]),
    # RIGHT: anything right-side
    ("RIGHT",  ["rf", "right field", "right center", "right side", "rf line",
                "1b", "first base"]),
    # CENTER: middle / pitcher / catcher / 2b / "up the middle"
    ("CENTER", ["cf", "center field", "centerfield", "middle", "up the middle",
                "2b", "second base", "p", "pitcher", "c", "catcher"]),
]

# 10-zone fine classification for the spray chart (Option B from data audit).
# Order matters: gap zones (left center / right center) before LF/RF;
# specific positions before generic side names.
#
# OUTFIELD (5):  LF / LC / CF / RC / RF
# INFIELD  (5):  IF_3B / IF_SS / IF_MID / IF_1B / IF_C
#
# Zone meanings:
#   LF        — left field (incl. lf line, lf foul ground)
#   LC        — left-center gap
#   CF        — straight center
#   RC        — right-center gap
#   RF        — right field (incl. rf line, rf foul ground)
#   IF_3B     — 3rd base, third-base line, dribblers down the line
#   IF_SS     — shortstop, "left side" of infield
#   IF_MID    — 2nd base, pitcher, "up the middle"
#   IF_1B     — 1st base, "right side" of infield
#   IF_C      — catcher (foul pops behind plate)
#   IF_2B     — 2nd base / second baseman (the 3-4 hole side)
#   IF_MID    — pitcher, "up the middle" (dead center, through the box)
#
# Splitting IF_2B out of IF_MID (2026-07) gives a true 5-lane infield that
# matches 6-4-3 Charts (3B line, 5-6 hole, up-middle, 3-4 hole, 1B line),
# which is far more actionable for defensive shifts than lumping 2B with the
# pitcher/middle.
_ZONE_FINE_PATTERNS = [
    # Outfield gaps must beat OF positions
    ("LC", ["left center", "lf to left center", "cf to left center"]),
    ("RC", ["right center", "rf to right center", "cf to right center"]),
    ("LF", ["lf line", "lf foul", "lf",  "left field"]),
    ("RF", ["rf line", "rf foul", "rf",  "right field"]),
    ("CF", ["cf", "center field", "centerfield"]),
    # Infield positions
    ("IF_C",   ["catcher"]),
    ("IF_3B",  ["3b", "third base", "third", "3b line"]),
    ("IF_SS",  ["ss", "shortstop", "short", "left side"]),
    ("IF_2B",  ["2b", "second base", "second"]),
    ("IF_1B",  ["1b", "first base", "first", "right side", "1b line"]),
    ("IF_MID", ["up the middle", "middle", "pitcher"]),
]

# ── Fielder-notation → fine zone ──
# Scorekeeper number and abbreviation to the zone where the ball was FIELDED.
# 1=P 2=C 3=1B 4=2B 5=3B 6=SS 7=LF 8=CF 9=RF. Lets us recover a zone from
# fielding-sequence ("ss to 1b", "6-4-3"), error ("(E5)"), fielder's-choice,
# and double-play notation that has no "singled to X" location tail.
_NUM_ZONE = {
    "1": "IF_MID", "2": "IF_C", "3": "IF_1B", "4": "IF_2B", "5": "IF_3B",
    "6": "IF_SS", "7": "LF", "8": "CF", "9": "RF",
}
_ABBR_ZONE = {
    "p": "IF_MID", "pitcher": "IF_MID",
    "c": "IF_C", "catcher": "IF_C",
    "1b": "IF_1B", "first base": "IF_1B",
    "2b": "IF_2B", "second base": "IF_2B",
    "3b": "IF_3B", "third base": "IF_3B",
    "ss": "IF_SS", "shortstop": "IF_SS",
    "lf": "LF", "left field": "LF",
    "cf": "CF", "center field": "CF", "centerfield": "CF",
    "rf": "RF", "right field": "RF",
}
_COARSE_OF_FINE = {
    "LF": "LEFT", "LC": "LEFT", "IF_3B": "LEFT", "IF_SS": "LEFT",
    "CF": "CENTER", "IF_MID": "CENTER", "IF_2B": "CENTER", "IF_C": "CENTER",
    "RF": "RIGHT", "RC": "RIGHT", "IF_1B": "RIGHT",
}
# Remove any "(0-0 BBKF)" count/sequence groups so a count like "2-1" isn't
# mistaken for a "5-3" fielding sequence.
_COUNT_GROUP_RE = re.compile(r"\(\d-\d[^)]*\)")
# Numeric fielding sequence: 6-4-3 / 5-3 / 4-6-3. First digit = fielder.
_NUM_SEQ_RE = re.compile(r"\b([1-9])(?:-[1-9])+\b")
# Abbreviation putout: first "<pos> to" / "<pos> unassisted".
_ABBR_SEQ_RE = re.compile(
    r"\b(p|c|1b|2b|3b|ss|lf|cf|rf|pitcher|catcher|shortstop|"
    r"first base|second base|third base|left field|center field|right field)\b"
    r"\s*(?:to\b|unassisted\b)",
    re.IGNORECASE,
)
# Error code: (E5) → fielder 5.
_ECODE_RE = re.compile(r"\(e([1-9])\)", re.IGNORECASE)
# Error by fielder: "error by 3b" / "fielding error fielding by ss".
_ERROR_POS_RE = re.compile(
    r"error(?:\s+\w+)*?\s+by\s+(p|c|1b|2b|3b|ss|lf|cf|rf|pitcher|catcher|"
    r"shortstop|first base|second base|third base|left field|center field|"
    r"right field)\b",
    re.IGNORECASE,
)


def _coarse_from_fine(fine):
    return _COARSE_OF_FINE.get(fine) if fine else None


def _extract_fielder_zone(text):
    """Recover a fine zone from fielding-sequence / putout notation
    ("grounded out, ss to 1b" / "6-4-3" / "3b unassisted"). Returns the FIRST
    fielder's zone (where the ball was actually fielded), or None."""
    if not text:
        return None
    s = _COUNT_GROUP_RE.sub(" ", text.lower())
    m = _NUM_SEQ_RE.search(s)
    if m:
        return _NUM_ZONE.get(m.group(1))
    m = _ABBR_SEQ_RE.search(s)
    if m:
        return _ABBR_ZONE.get(m.group(1).lower())
    return None


def _extract_error_zone(text):
    """Zone for an 'error' result_type: prefer the (E#) code, then 'error by
    <pos>', then any fielding sequence."""
    if not text:
        return None
    m = _ECODE_RE.search(text)
    if m:
        return _NUM_ZONE.get(m.group(1))
    m = _ERROR_POS_RE.search(text)
    if m:
        return _ABBR_ZONE.get(m.group(1).lower())
    return _extract_fielder_zone(text)


# "fielder's choice hit to second base" / "choice to short" → location tail.
_HIT_TO_RE = re.compile(
    r"\b(?:hit\s+to|choice\s+to)\s+(?P<loc>[a-z0-9 ]+?)"
    r"(?=\s*(?:[,.;(]|$))",
    re.IGNORECASE,
)


def _extract_hit_to_zone(text):
    m = _HIT_TO_RE.search(text or "")
    return _classify_zone_fine(m.group("loc")) if m else None


def _classify_zone_fine(loc: str):
    """Return one of LF/LC/CF/RC/RF/IF_3B/IF_SS/IF_MID/IF_1B/IF_C, or None."""
    if not loc:
        return None
    s = loc.strip().lower()
    for zone, patterns in _ZONE_FINE_PATTERNS:
        for pat in patterns:
            if re.search(rf"\b{re.escape(pat)}\b", s):
                return zone
    # Single-letter fallbacks (location IS just "p" or "c")
    if s == "p":
        return "IF_MID"
    if s == "c":
        return "IF_C"
    return None


def _classify_zone(loc: str) -> Optional[str]:
    """Return 'LEFT' / 'CENTER' / 'RIGHT', or None if location string
    doesn't match any known field token. Order matters: 'left center'
    must match LEFT before CENTER (we want pull/oppo bias on the side).
    """
    if not loc:
        return None
    s = loc.strip().lower()
    # Strip any trailing junk (e.g. "lf foul ground")
    # Try each zone in order (LEFT before RIGHT before CENTER)
    for zone, patterns in _ZONE_PATTERNS:
        for pat in patterns:
            # Whole word boundary OR exact start match for short tokens
            if re.search(rf"\b{re.escape(pat)}\b", s):
                return zone
    return None


# ─────────────────────────────────────────────────────────────────
# Batted-ball type classification
# ─────────────────────────────────────────────────────────────────

def _classify_bb_type(verb: str, location: str, result_type: str,
                      result_text: str = "") -> Optional[str]:
    """Map (verb, location, result_type, result_text) -> 'GB'/'FB'/'LD'/'PU'/None.

    Rules:
      - Explicit verbs win first: grounded=GB, lined=LD, popped=PU,
        flied/fouled=FB, homered=FB.
      - Hits (singled/doubled/tripled) without an explicit batted-ball
        verb are inferred from location AND depth/trajectory keywords:
          * Hit to infield position → GB (most infield singles)
          * Depth/trajectory keyword present (deep, off the wall, bloop,
            shallow, over the head, etc.) → FB
          * Doubled / tripled to OF → FB (extra-base OF hits are mostly
            fly balls into the gap or down the line)
          * Singled to OF → LD (line drives are the modal classification
            for outfield singles)
    """
    v = (verb or "").lower()
    loc = (location or "").lower()
    text = result_text or ""

    # Explicit batted-ball verbs
    if v == "grounded":
        return "GB"
    if v == "lined":
        return "LD"
    if v == "popped":
        return "PU"
    if v in ("flied", "fouled"):
        return "FB"

    # Hits — disambiguate from location and depth keywords
    if v == "homered":
        return "FB"
    if v in ("singled", "doubled", "tripled"):
        # Infield positions → GB (true on most infield hits, ground singles
        # through the holes, soft choppers, etc.)
        if any(p in loc for p in ("ss", "shortstop", "3b", "third base",
                                  "2b", "second base", "1b", "first base",
                                  "p ", "pitcher", "left side",
                                  "right side", "up the middle")):
            # Doubles "up the middle" are nearly always liners through, not GBs
            if v == "doubled" and "up the middle" in loc:
                return "LD"
            return "GB"

        # OF hits: check for depth/trajectory keywords first. These
        # strongly imply a fly-ball arc (deep gap shots, blooped flares,
        # over-the-head flies, balls off the wall).
        if _FB_KEYWORDS_RE.search(text):
            return "FB"

        # No depth keyword: differentiate by hit type. Extra-base hits
        # (doubles, triples) to the OF default to FB — at the college
        # level the gap doubles and down-the-line shots are predominantly
        # fly balls. Singles to the OF default to LD (modal classification
        # for hard-hit OF singles).
        if v in ("doubled", "tripled"):
            return "FB"

        if any(p in loc for p in ("lf", "left field", "left center",
                                  "cf", "center field", "centerfield",
                                  "rf", "right field", "right center",
                                  "lf line", "rf line")):
            return "LD"
        return "LD"  # Catch-all for hits with parsable but unknown loc

    return None


# ─────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────

# result_types that COULD have a batted-ball component. We try
# classification on these only; everything else returns (None, None).
_CONTACT_TYPES = {
    "single", "double", "triple", "home_run",
    "ground_out", "fly_out", "line_out", "pop_out",
    "sac_fly", "sac_bunt",
    "fielders_choice",      # always GB by definition
    "error",                # often GB but could be FB/LD; parse if possible
    "double_play", "triple_play",   # always GB
}


def classify(result_type: str, result_text: str):
    """Return (bb_type, field_zone, field_zone_fine) — None for any
    field that can't be inferred. Backwards-compatible: callers using
    `bb, zone = classify(...)` still work because Python tuples unpack
    by position. We document the 3-tuple in derive scripts."""
    if not result_type or result_type not in _CONTACT_TYPES:
        return None, None, None
    if not result_text:
        return None, None, None

    # Special cases that bypass verb matching
    if result_type in ("double_play", "triple_play", "fielders_choice"):
        # Always GB. Find where the ball was fielded: "hit to <pos>" tail,
        # then the fielding sequence ("6-4-3" / "ss to 2b to 1b" — first
        # fielder is where the ball went), then any "into DP to <pos>".
        fine = _extract_hit_to_zone(result_text) or _extract_fielder_zone(result_text)
        if not fine:
            m = _VERB_LOC_RE.search(result_text)
            if m:
                fine = _classify_zone_fine(m.group("loc"))
        return "GB", _coarse_from_fine(fine), fine

    if result_type == "error":
        fine = _extract_error_zone(result_text)
        # Errors at infield positions are nearly always ground balls.
        # OF errors stay None (could be misplayed fly OR liner — ambiguous).
        bb = "GB" if (fine and fine.startswith("IF_")) else None
        return bb, _coarse_from_fine(fine), fine

    if result_type == "sac_fly":
        m = _VERB_LOC_RE.search(result_text)
        loc = m.group("loc") if m else None
        return "FB", _classify_zone(loc), _classify_zone_fine(loc)

    if result_type == "sac_bunt":
        m = _VERB_LOC_RE.search(result_text)
        loc = m.group("loc") if m else None
        return "GB", _classify_zone(loc), _classify_zone_fine(loc)

    # Find verb + location in the batter clause (text before first ;)
    batter_clause = result_text.split(";", 1)[0]
    batter_clause = _OUT_MARKER_RE.sub("", batter_clause)
    batter_clause = re.sub(r"\s+", " ", batter_clause).strip()
    batter_clause = _COUNT_TAIL_RE.sub("", batter_clause)
    batter_clause = _TRAILING_PERIOD_RE.sub("", batter_clause)

    m = _VERB_LOC_RE.search(batter_clause)
    if m:
        verb = m.group("verb")
        location = m.group("loc")
        bb = _classify_bb_type(verb, location, result_type, batter_clause)
        zone = _classify_zone(location)
        fine = _classify_zone_fine(location)
        # Backup the zone from a fielding sequence when "to X" didn't yield one
        # (e.g. "grounded out, ss to 1b" parses the verb but not the location).
        if not fine:
            fz = _extract_fielder_zone(batter_clause)
            if fz:
                fine, zone = fz, _coarse_from_fine(fz)
        return bb, zone, fine

    # Fallback: result_type implies bb_type but no "to X" location. Still try
    # to recover a zone from fielding-sequence notation ("ss to 1b", "6-4-3").
    bb_only = {
        "ground_out": "GB",
        "fly_out":    "FB",
        "line_out":   "LD",
        "pop_out":    "PU",
        "home_run":   "FB",
    }.get(result_type)
    if bb_only:
        fz = _extract_fielder_zone(batter_clause)
        return bb_only, _coarse_from_fine(fz), fz
    # Even hits ("singled" with no location) get a last-chance sequence parse.
    fz = _extract_fielder_zone(batter_clause)
    if fz:
        bb = "GB" if fz.startswith("IF_") else "LD"
        return bb, _coarse_from_fine(fz), fz
    # Bunt singles/hits with no fielder named are still ground balls.
    if "bunt" in batter_clause.lower():
        return "GB", None, None
    return None, None, None


# ─────────────────────────────────────────────────────────────────
# Pull / Center / Oppo helper (used by API code, not in DB)
# ─────────────────────────────────────────────────────────────────

def spray_for(field_zone: Optional[str], bats: Optional[str]) -> Optional[str]:
    """Return 'Pull' / 'Center' / 'Oppo' / None.
    R-handed batter pulls to LEFT, opps to RIGHT.
    L-handed batter pulls to RIGHT, opps to LEFT.
    Switch hitters and unknown handedness return None.
    """
    if not field_zone:
        return None
    if not bats:
        return None
    b = bats.upper()
    if b == "S":
        return None  # Switch hitters — would need pitcher hand to derive
    if field_zone == "CENTER":
        return "Center"
    if b == "R":
        return "Pull" if field_zone == "LEFT" else "Oppo"
    if b == "L":
        return "Pull" if field_zone == "RIGHT" else "Oppo"
    return None


# ─────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    import os
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    import psycopg2, psycopg2.extras
    from dotenv import load_dotenv
    from pathlib import Path

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")

    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=30)
    args = ap.parse_args()

    url = os.environ["DATABASE_URL"]
    if "sslmode" not in url:
        url += ("&" if "?" in url else "?") + "sslmode=require"
    conn = psycopg2.connect(url)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(f"""
        SELECT result_type, result_text FROM game_events
        WHERE result_type IN ('single','double','triple','home_run',
            'ground_out','fly_out','line_out','pop_out','sac_fly')
        ORDER BY RANDOM() LIMIT {int(args.sample)}
    """)
    print(f"{'BB':>3s} {'ZONE':>6s}  {'FINE':>6s}  {'TYPE':14s}  TEXT")
    print("-" * 100)
    for r in cur.fetchall():
        bb, z, fine = classify(r["result_type"], r["result_text"])
        bb_s = bb or "—"
        z_s = z or "—"
        fine_s = fine or "—"
        text = (r["result_text"] or "")[:80]
        print(f"{bb_s:>3s} {z_s:>6s}  {fine_s:>6s}  {r['result_type']:14s}  {text}")
