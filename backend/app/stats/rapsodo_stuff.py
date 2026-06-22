"""Stuff+ SCAFFOLD (v0) — an experimental, transparent pitch-quality grade.

IMPORTANT: this is NOT a trained Stuff+ model. Real Stuff+ regresses pitch
shape onto run value / whiff outcomes; bullpen Rapsodo data has no hitters, so we
can't fit that here. This is a documented heuristic that scores a pitch's SHAPE
against MLB anchors (100 = MLB-average for that pitch family, ~10 points per
standard deviation), so we have a working number and the structure to swap in a
real model later (or recalibrate the anchors to the NWBB population as data
accumulates). Treat it as directional, college arms will sit below 100, and it
ignores command entirely. See RAPSODO_TOOL_DESIGN.md.

Pathway to a real model: accumulate enough located pitches + (ideally) outcome
tags, then fit a gradient-boosted model on run value with these same inputs and
the velo/movement differential from each pitcher's own fastball.
"""
VERSION = "v0"

# MLB-ish anchors: (mean, sd). Documented + adjustable; recalibrate later.
_FASTBALL = {"4-seam (ride)", "fastball (mixed)", "sinker / 2-seam", "cutter"}
_SECONDARY = {"slider", "sweeper", "gyro slider", "curveball", "changeup"}

_FB_VELO = (93.5, 2.5)
_FB_IVB = (15.0, 3.5)
_FB_EXT = (6.3, 0.4)
_SEC_VELO = (84.0, 3.0)
_SEC_MOVE = (14.0, 4.0)


def _f(v):
    return float(v) if v is not None else None


def _z(v, anchor):
    return (v - anchor[0]) / anchor[1]


def grade(entry, fb):
    """Stuff v0 for one arsenal centroid. `fb` = fastball centroid {velo,ivb,arm_hb}.
    Returns (score:int, components:dict) or (None, None) if ungradeable."""
    pitch = entry.get("pitch")
    velo = _f(entry.get("velo"))
    ivb = _f(entry.get("ivb"))
    hb = _f(entry.get("arm_hb"))
    if velo is None or pitch not in _FASTBALL | _SECONDARY:
        return None, None

    score = 100.0
    comp = {}
    if pitch in _FASTBALL:
        comp["velo"] = round(8 * _z(velo, _FB_VELO), 1)
        score += comp["velo"]
        if ivb is not None:
            comp["ride"] = round(6 * _z(ivb, _FB_IVB), 1)
            score += comp["ride"]
        ext = _f(entry.get("ext"))
        if ext:  # extension often unmeasured (0/None) on some devices
            comp["extension"] = round(3 * _z(ext, _FB_EXT), 1)
            score += comp["extension"]
    else:
        comp["velo"] = round(8 * _z(velo, _SEC_VELO), 1)
        score += comp["velo"]
        if ivb is not None and hb is not None:
            total_move = abs(ivb) + abs(hb)
            comp["movement"] = round(4 * _z(total_move, _SEC_MOVE), 1)
            score += comp["movement"]
        # reward velocity separation off the fastball (the secondary's job)
        if fb and fb.get("velo") is not None:
            sep = fb["velo"] - velo
            comp["fb_sep"] = round(max(0.0, min(10.0, sep - 8)) * 0.5, 1)
            score += comp["fb_sep"]

    return max(20, min(180, round(score))), comp


def fb_from_arsenal(arsenal):
    """Pick the fastball anchor (most-thrown fastball, else hardest pitch) and
    return its centroid {velo, ivb, arm_hb} for the secondary separation term."""
    if not arsenal:
        return None
    fbs = [a for a in arsenal if a.get("pitch") in _FASTBALL]
    pick = (max(fbs, key=lambda a: a.get("count", 0)) if fbs
            else max(arsenal, key=lambda a: _f(a.get("velo")) or 0))
    return {"velo": _f(pick.get("velo")), "ivb": _f(pick.get("ivb")), "arm_hb": _f(pick.get("arm_hb"))}


def annotate(arsenal, fb):
    """Attach a 'stuff' score + 'stuff_components' to each arsenal entry in place."""
    for entry in arsenal:
        s, comp = grade(entry, fb)
        entry["stuff"] = s
        entry["stuff_components"] = comp
    return arsenal
