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
# Used to upgrade OF hits from the default LD/FB classification to FB
# when the narrative gives us extra signal.
_FB_KEYWORDS_RE = re.compile(
    r"\b(?:"
    r"deep|"                                  # "deep to left field"
    r"off\s+the\s+(?:wall|fence|fences)|"     # "off the wall"
    r"warning\s+track|"                       # "warning track"
    r"to\s+the\s+(?:wall|fence|track)|"       # "to the wall"
    r"bloop(?:er|ed)?|"                       # "bloop double"
    r"dunked?|"                                # "dunked into shallow"
    r"shallow|"                                # "shallow left"
    r"texas\s+leaguer|"                       # "Texas leaguer"
    r"in\s+front\s+of|"                       # "in front of the LF"
    r"over\s+the\s+(?:head|wall|fence|"        # "over the head", "over the wall"
        r"(?:left|center|right)\s+fielder)|"  # "over the right fielder"
    r"between\s+(?:the\s+)?(?:lf|cf|rf|"       # "between the LF and CF"
        r"left\s+(?:fielder)?|"
        r"center\s+(?:fielder)?|"
        r"right\s+(?:fielder)?)\s+(?:and|&)"
    r")\b",
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
    ("IF_SS",  ["ss", "shortstop", "left side"]),
    ("IF_1B",  ["1b", "first base", "right side", "1b line"]),
    ("IF_MID", ["2b", "second base", "up the middle", "middle", "pitcher"]),
]


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

        # No depth keyword: differentiate by hit type. Extra-base hits to
        # the OF are predominantly fly balls (gap doubles, down-the-line
        # triples) — singles to the OF are predominantly line drives.
        if v in ("doubled", "tripled"):
            return "FB"

        # Singled to OF: LD is the modal classification.
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
        # Always GB; try to find a field zone. DP narratives often start
        # "X grounded into double play SS to 2B to 1B" — the FIRST
        # position mentioned (SS here) is where the ball was hit.
        m = _VERB_LOC_RE.search(result_text)
        loc = m.group("loc") if m else None
        zone = _classify_zone(loc) if loc else None
        zone_fine = _classify_zone_fine(loc) if loc else None
        if not zone:
            m2 = re.search(r"\b(?:double\s+play|fielder'?s\s+choice|triple\s+play)\s+"
                           r"(?:to\s+)?([a-z0-9]+(?:\s+base)?)\b",
                           result_text, re.IGNORECASE)
            if m2:
                zone = _classify_zone(m2.group(1))
                zone_fine = _classify_zone_fine(m2.group(1))
        return "GB", zone, zone_fine

    if result_type == "error":
        m = _ERROR_BY_RE.search(result_text)
        loc = m.group("loc") if m else None
        zone = _classify_zone(loc) if loc else None
        fine = _classify_zone_fine(loc) if loc else None
        # Errors at infield positions are nearly always ground balls.
        # OF errors stay None (could be misplayed fly OR liner — ambiguous).
        bb = "GB" if (fine and fine.startswith("IF_")) else None
        return bb, zone, fine

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
        return bb, zone, fine

    # Fallback: result_type implies bb_type but no "to X" location.
    bb_only = {
        "ground_out": "GB",
        "fly_out":    "FB",
        "line_out":   "LD",
        "pop_out":    "PU",
        "home_run":   "FB",
    }.get(result_type)
    if bb_only:
        return bb_only, None, None
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
