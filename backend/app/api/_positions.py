"""Canonical display formatting for player positions.

Summer/WCL rosters come from Pointstreak with wildly inconsistent position
strings (lowercase, mixed case, "Of", "rhp/lhp", "Util", etc.). normalize_position
maps any of them to a single canonical, all-caps form (LF, C, RHP/LHP, INF, …)
so the site shows positions the same way everywhere.
"""
import re

_POS_ALIASES = {
    # pitchers
    "p": "P", "rhp": "RHP", "lhp": "LHP", "sp": "SP", "rp": "RP", "pitcher": "P",
    # catcher
    "c": "C", "catcher": "C",
    # infield
    "1b": "1B", "2b": "2B", "3b": "3B", "ss": "SS",
    "inf": "INF", "if": "INF", "infield": "INF", "infielder": "INF",
    "mif": "INF", "cif": "INF",
    # outfield
    "lf": "LF", "cf": "CF", "rf": "RF",
    "of": "OF", "outfield": "OF", "outfielder": "OF",
    # other
    "dh": "DH",
    "ut": "UT", "utl": "UT", "util": "UT", "utility": "UT", "uti": "UT",
    "ph": "PH", "pr": "PR",
}


def normalize_position(pos):
    """'rhp/lhp' -> 'RHP/LHP', 'Of' -> 'OF', 'util' -> 'UT'. Unknown tokens are
    upper-cased and kept. Returns the input unchanged when falsy."""
    if not pos:
        return pos
    parts = [p.strip() for p in re.split(r"[/,]+", str(pos)) if p.strip()]
    out, seen = [], set()
    for p in parts:
        key = p.lower().replace(".", "").replace(" ", "")
        norm = _POS_ALIASES.get(key, p.upper())
        if norm not in seen:
            seen.add(norm)
            out.append(norm)
    return "/".join(out)
