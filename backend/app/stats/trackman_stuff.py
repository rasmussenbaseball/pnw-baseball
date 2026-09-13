"""TrackMan Suite adapter for the site-wide Stuff+ model (app/stats/stuff_core).

The suite's rows ARE the model's training format (TrackMan V3, signed
HorzBreak / RelSide), so the only translation is flipping horizontal break
to arm-side positive: TrackMan reports +HB toward the pitcher's right, so a
right-hander's arm side is + and a left-hander's is -. Handedness comes from
the entry's `throws` when present, else from the sign of the release side
(a pitcher releases on his arm side).

entry / fb: dicts with ptype, velo, ivb, hb, spin, ext, rel_h, rel_s
(+ optional throws). fb is the pitcher's primary fastball centroid (may be
the entry itself). See stuff_core for the model and the 100-scale.
"""
from . import stuff_core as core

FB_FAMILY = core.FB_FAMILY


def _sign(entry):
    t = (entry.get("throws") or "").strip().upper()[:1]
    if t == "R":
        return 1.0
    if t == "L":
        return -1.0
    rs = entry.get("rel_s")
    try:
        rs = float(rs) if rs is not None else None
    except (TypeError, ValueError):
        rs = None
    return -1.0 if (rs is not None and rs < 0) else 1.0


def _to_core(entry, sign):
    hb = entry.get("hb")
    return {
        "ptype": entry.get("ptype"), "n": entry.get("n"),
        "velo": entry.get("velo"), "ivb": entry.get("ivb"),
        "hb_arm": (float(hb) * sign) if hb is not None else None,
        "spin": entry.get("spin"), "ext": entry.get("ext"),
        "rel_h": entry.get("rel_h"), "rel_s": entry.get("rel_s"),
    }


def grade_trackman_detail(entry, fb):
    """-> (grade, components, xrv) for one suite arsenal centroid."""
    sign = _sign(entry)
    return core.score(_to_core(entry, sign), _to_core(fb, sign) if fb else None)


def grade_trackman(entry, fb):
    """Stuff+ grade (int) for one suite arsenal centroid, or None."""
    return grade_trackman_detail(entry, fb)[0]
