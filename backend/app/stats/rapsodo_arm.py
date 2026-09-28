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


# Estimated shoulder-pivot HEIGHT (ft) for a geometric arm-angle approximation.
# Rapsodo gives the release point but not the shoulder (Statcast uses pose), so we
# anchor the pivot at the body midline (horizontal) and this height (vertical) and
# measure the release point off it. Illustrative, not Statcast-exact. Anchoring at
# the midline (no horizontal offset) keeps the angle stable for pitchers who
# release near the centerline (a side offset there collapses dx → a false ~90°).
_SHOULDER_H = 4.6


def _arm_angle(rel_height, rel_side):
    """Geometric arm angle off the site's calibrated shoulder anchor (see
    stats/pitch_shape.arm_angle; the TrackMan lab blends this with the
    fastball's movement direction, Rapsodo has only the release point)."""
    from .pitch_shape import geo_arm_angle
    v = geo_arm_angle(rel_height, abs(rel_side) if rel_side is not None else None)
    return round(v) if v is not None else None


def _slot_label(rel_height, rel_side=None):
    """Arm-slot bucket from the geometric arm angle (same bands as the
    TrackMan suite's slot chip)."""
    from .pitch_shape import geo_arm_angle, slot_label
    lab = slot_label(geo_arm_angle(rel_height, abs(rel_side) if rel_side is not None else None))
    return lab["label"] if lab else None


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
        "slot": _slot_label(rh, rs),
        "arm_angle": _arm_angle(rh, rs),
        "consistency": _consistency_label(h_sd, s_sd),
        "n": len(pts),
        "points": [
            {"pitch": p.get("pitch"), "rel_side": _f(p["rel_side"]), "rel_height": _f(p["rel_height"])}
            for p in pts
        ],
    }
