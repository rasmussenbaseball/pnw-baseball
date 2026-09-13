"""Rapsodo adapter for the site-wide Stuff+ model (app/stats/stuff_core).

Rapsodo measures the same pitch differently from TrackMan, the device the
model is trained on. From the feature-drift diagnostic (the same arms on
both devices): Rapsodo's spin-based break reads ~3.2" hotter on |HB| and
its spin ~130 rpm lower than TrackMan's trajectory-based numbers, and it
frequently reports extension as 0. So before scoring we shrink |HB| by
3.2" (toward zero, never across it), add 130 rpm, and let the core impute
a missing extension with the family mean. Separation features are kept
REAL: the fastball reference is measured on the same device as the pitch,
so the device offset cancels inside the difference.

grade_pitch(model, rap_type, entry, fb) keeps its historical signature for
app/stats/rapsodo_stuff.py. entry = Rapsodo arsenal centroid (velo, ivb,
arm_hb, total_spin, rel_height, rel_side, ext); fb = {velo, ivb, arm_hb}.
"""
from . import stuff_core as core

HB_DRIFT_IN = 3.2
SPIN_DRIFT_RPM = 130.0


def _f(v):
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def _shrink_hb(hb):
    if hb is None:
        return None
    if hb >= 0:
        return max(0.0, hb - HB_DRIFT_IN)
    return min(0.0, hb + HB_DRIFT_IN)


def _to_core(ptype, e, spin_key):
    if not e:
        return None
    spin = _f(e.get(spin_key))
    return {
        "ptype": ptype,
        "velo": _f(e.get("velo")), "ivb": _f(e.get("ivb")),
        "hb_arm": _shrink_hb(_f(e.get("arm_hb"))),
        "spin": (spin + SPIN_DRIFT_RPM) if spin is not None else None,
        "ext": _f(e.get("ext")) or None,
        "rel_h": _f(e.get("rel_height")), "rel_s": _f(e.get("rel_side")),
    }


def grade_pitch(model, rap_type, entry, fb):
    """-> (grade:int, components:dict) or (None, None)."""
    model = model or core.load_model()
    if not model:
        return None, None
    ptype = core.canon_type(rap_type)
    if not ptype:
        return None, None
    ce = _to_core(ptype, entry, "total_spin")
    cf = _to_core(fb.get("pitch") or "fastball", fb, "total_spin") if fb else None
    if cf and cf.get("rel_h") is None:      # fb_from_arsenal carries only velo/ivb/arm_hb
        cf["rel_h"], cf["rel_s"], cf["ext"], cf["spin"] = ce.get("rel_h"), ce.get("rel_s"), ce.get("ext"), ce.get("spin")
    grade, comps, _ = core.score(ce, cf, model)
    if grade is None:
        return None, None
    return grade, comps
