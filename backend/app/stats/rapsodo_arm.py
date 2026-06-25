"""Arm-slot / release profile from Rapsodo release data.

What's solid from this data: release point (height + side), release CONSISTENCY
(std dev — the engine of tunneling and command), extension, and approach angle.
We deliberately do NOT claim Statcast's pose-based "arm angle" (that needs shoulder
position we don't have); the slot label is a coarse estimate from release height.
See RAPSODO_TOOL_DESIGN.md.
"""
import math
from statistics import mean, pstdev


def _f(v):
    return float(v) if v is not None else None


# Estimated shoulder pivot (ft) for a geometric arm-angle approximation. Rapsodo
# gives the release point but not the shoulder (Statcast uses pose), so we anchor
# the pivot and measure the release point off it. Illustrative, not Statcast-exact.
_SHOULDER_H, _SHOULDER_X = 4.6, 0.4


def _arm_angle(rel_height, rel_side):
    """Approximate arm angle (deg from horizontal): ~vertical = over-the-top,
    ~0 = sidearm, negative = submarine. Geometric estimate off an anchored shoulder."""
    if rel_height is None or rel_side is None:
        return None
    dy = rel_height - _SHOULDER_H
    dx = max(0.05, abs(rel_side) - _SHOULDER_X)
    return round(max(-30.0, min(90.0, math.degrees(math.atan2(dy, dx)))))


def _slot_label(rel_height):
    """Coarse arm-slot bucket from release height (ft). Approximate — true slot
    also depends on the pitcher's stature and side; this is a useful shorthand."""
    if rel_height is None:
        return None
    if rel_height >= 6.2:
        return "over the top"
    if rel_height >= 5.7:
        return "high three-quarter"
    if rel_height >= 5.2:
        return "three-quarter"
    if rel_height >= 4.7:
        return "low three-quarter"
    return "sidearm"


def _consistency_label(h_sd, s_sd):
    """Release repeatability from the larger of the two release std devs (ft)."""
    worst = max(h_sd, s_sd)
    if worst <= 0.12:        # ~1.5 in
        return "very tight"
    if worst <= 0.20:        # ~2.4 in
        return "tight"
    if worst <= 0.30:        # ~3.6 in
        return "moderate"
    return "loose"


def arm_profile(pitches):
    """`pitches`: reliable (ok) pitch dicts with rel_height/rel_side/extension/vaa.
    Returns a release/arm-slot summary + per-pitch release points for the plot."""
    pts = [p for p in pitches
           if p.get("rel_height") is not None and p.get("rel_side") is not None]
    if not pts:
        return None
    hs = [_f(p["rel_height"]) for p in pts]
    ss = [_f(p["rel_side"]) for p in pts]
    rh, rs = mean(hs), mean(ss)
    h_sd = pstdev(hs) if len(hs) > 1 else 0.0
    s_sd = pstdev(ss) if len(ss) > 1 else 0.0
    exts = [_f(p["extension"]) for p in pts if p.get("extension") not in (None, 0)]
    vaas = [_f(p["vaa"]) for p in pts if p.get("vaa") is not None]
    return {
        "rel_height": round(rh, 2),
        "rel_side": round(rs, 2),
        "rel_height_sd": round(h_sd, 2),
        "rel_side_sd": round(s_sd, 2),
        "extension": round(mean(exts), 2) if exts else None,
        "vaa": round(mean(vaas), 2) if vaas else None,
        "slot": _slot_label(rh),
        "arm_angle": _arm_angle(rh, rs),
        "consistency": _consistency_label(h_sd, s_sd),
        "n": len(pts),
        "points": [
            {"pitch": p.get("pitch"), "rel_side": _f(p["rel_side"]), "rel_height": _f(p["rel_height"])}
            for p in pts
        ],
    }
