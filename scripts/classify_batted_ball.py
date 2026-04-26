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

def _classify_bb_type(verb: str, location: str, result_type: str) -> Optional[str]:
    """Map (verb, location, result_type) -> 'GB'/'FB'/'LD'/'PU'/None.

    Conservative rules:
      - Explicit verbs win first: grounded=GB, lined=LD, popped=PU,
        flied/fouled=FB.
      - Hits without an explicit batted-ball verb (singled/doubled/
        tripled/homered) inferred from location:
          * HR → FB
          * Hit to infield position → GB (most infield singles)
          * Hit to OF → LD (default — could be FB but LD is more common
            on hits)
    """
    v = (verb or "").lower()
    loc = (location or "").lower()

    # Explicit batted-ball verbs
    if v == "grounded":
        return "GB"
    if v == "lined":
        return "LD"
    if v == "popped":
        return "PU"
    if v in ("flied", "fouled"):
        return "FB"

    # Hits — disambiguate from location
    if v == "homered":
        return "FB"
    if v in ("singled", "doubled", "tripled"):
        # Infield positions → GB (true on most infield hits)
        if any(p in loc for p in ("ss", "shortstop", "3b", "third base",
                                  "2b", "second base", "1b", "first base",
                                  "p ", "pitcher", "left side",
                                  "right side", "up the middle")):
            # But "up the middle" doubles are extremely rare; if a
            # double goes "up the middle" treat as LD.
            if v == "double" and "up the middle" in loc:
                return "LD"
            return "GB"
        # Outfield hits → LD by default. Doubles to gap are sometimes
        # FB, but LD is the modal classification.
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


def classify(result_type: str, result_text: str) -> Tuple[Optional[str], Optional[str]]:
    """Return (bb_type, field_zone) or (None, None) if not contact / unparseable."""
    if not result_type or result_type not in _CONTACT_TYPES:
        return None, None
    if not result_text:
        return None, None

    # Special cases that bypass verb matching
    if result_type in ("double_play", "triple_play", "fielders_choice"):
        # Always GB; try to find a field zone. DP narratives often start
        # "X grounded into double play SS to 2B to 1B" — the FIRST
        # position mentioned (SS here) is where the ball was hit.
        m = _VERB_LOC_RE.search(result_text)
        zone = _classify_zone(m.group("loc")) if m else None
        if not zone:
            # Try to pull from "p to 1b" / "ss to 2b" pattern: first token
            m2 = re.search(r"\b(?:double\s+play|fielder'?s\s+choice|triple\s+play)\s+"
                           r"(?:to\s+)?([a-z0-9]+(?:\s+base)?)\b",
                           result_text, re.IGNORECASE)
            if m2:
                zone = _classify_zone(m2.group(1))
        return "GB", zone

    if result_type == "error":
        # Pull field zone from "by X" — the position that committed the
        # error is a reasonable proxy for where the ball went.
        m = _ERROR_BY_RE.search(result_text)
        zone = _classify_zone(m.group("loc")) if m else None
        # Most reached-on-error are GB but not all. Without a verb we
        # leave bb_type NULL (already a small slice; ~125 events).
        return None, zone

    if result_type == "sac_fly":
        # Always FB by definition
        m = _VERB_LOC_RE.search(result_text)
        zone = _classify_zone(m.group("loc")) if m else None
        return "FB", zone

    if result_type == "sac_bunt":
        # Always GB (bunts are grounders)
        m = _VERB_LOC_RE.search(result_text)
        zone = _classify_zone(m.group("loc")) if m else None
        return "GB", zone

    # Find verb + location in the batter clause (text before first ;)
    batter_clause = result_text.split(";", 1)[0]
    # Normalize Presto noise: strip "(N out)" markers and collapse all
    # whitespace (including embedded newlines/tabs from the Presto cells)
    # to single spaces. THEN strip the count tail and any trailing period.
    batter_clause = _OUT_MARKER_RE.sub("", batter_clause)
    batter_clause = re.sub(r"\s+", " ", batter_clause).strip()
    batter_clause = _COUNT_TAIL_RE.sub("", batter_clause)
    batter_clause = _TRAILING_PERIOD_RE.sub("", batter_clause)

    m = _VERB_LOC_RE.search(batter_clause)
    if m:
        verb = m.group("verb")
        location = m.group("loc")
        bb = _classify_bb_type(verb, location, result_type)
        zone = _classify_zone(location)
        return bb, zone

    # Fallback: result_type implies bb_type but no "to X" location.
    # Common for terse scorer narratives like "Caden Taylor singled."
    # — we credit the bb_type but leave zone NULL.
    bb_only = {
        "ground_out": "GB",
        "fly_out":    "FB",
        "line_out":   "LD",
        "pop_out":    "PU",
        "home_run":   "FB",
    }.get(result_type)
    if bb_only:
        return bb_only, None
    if result_type in ("single", "double", "triple"):
        # Unknown contact type without location — leave bb NULL too.
        # (Could be GB or LD; admitting ignorance > guessing.)
        return None, None

    return None, None


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
    print(f"{'BB':>3s} {'ZONE':>6s}  {'TYPE':14s}  TEXT")
    print("-" * 100)
    for r in cur.fetchall():
        bb, z = classify(r["result_type"], r["result_text"])
        bb_s = bb or "—"
        z_s = z or "—"
        text = (r["result_text"] or "")[:80]
        print(f"{bb_s:>3s} {z_s:>6s}  {r['result_type']:14s}  {text}")
