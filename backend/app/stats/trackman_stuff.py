"""Site-standard Stuff grades for TrackMan Suite arsenals.

Applies the WCL-trained TrackMan pitch-grade model (whiff+chase target,
fit by scripts/trackman/compute_pitch_grades.py, exported to
backend/data/rapsodo_stuff_model.json) to the suite's tm_pitches
centroids. Unlike app/stats/stuff_model.py (the Rapsodo ADAPTER, which
bandages device drift: |HB|-3.2, spin+130, neutralized separation
features), this scorer replicates the trainer's NATIVE feature build —
our rows ARE TrackMan, the model's home format, so the real separations
and unadjusted measurements apply.

Scale matches the site standard: 100 = average for that pitch type,
grade_sd (25) per model SD before shrink, capped 20-175. NOT comparable
across pitch types. Location+ comes from app/stats/rapsodo_location
(shared verbatim — plate coordinates are device-independent).
"""
import json
import math
import os

# Suite's normalized TaggedPitchType -> the model's TrackMan type names.
SUITE_TO_MODEL = {
    "Fastball": "Four Seam",
    "Sinker": "Sinker",
    "Cutter": "Cutter",
    "Slider": "Slider",
    "Sweeper": "Slider",
    "Curveball": "Curveball",
    "ChangeUp": "Changeup",
    "Splitter": "Splitter",
}
FB_FAMILY = {"Fastball", "Sinker", "Cutter"}

_Z_REF = 2.4  # must match compute_pitch_grades.Z_REF_FT

_MODEL_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "data", "rapsodo_stuff_model.json")
_model = None
_model_mtime = None


def _load_model():
    global _model, _model_mtime
    try:
        mt = os.path.getmtime(_MODEL_PATH)
    except OSError:
        return None
    if _model is None or mt != _model_mtime:
        with open(_MODEL_PATH) as f:
            _model = json.load(f)
        _model_mtime = mt
    return _model


def estimate_vaa(velo, ext, rel_height, ivb):
    """Location-neutral geometric VAA — identical to the trainer's."""
    if None in (velo, ext, rel_height, ivb):
        return None
    v0 = float(velo) * 1.4667
    if v0 <= 0:
        return None
    y0 = 60.5 - float(ext)
    vy = 0.955 * v0
    t = y0 / vy
    a_z = -32.17 + 2.0 * (float(ivb) / 12.0) / (t * t)
    vz0 = ((_Z_REF - float(rel_height)) - 0.5 * a_z * t * t) / t
    return math.degrees(math.atan2(vz0 + a_z * t, 0.92 * v0))


def grade_trackman(entry, fb):
    """Grade one tm arsenal centroid with the trained model.

    entry/fb: dicts with suite pitch type + velo, ivb, hb, spin, ext,
    rel_h, rel_s (floats or None). fb is the pitcher's fastball-family
    reference centroid (may be entry itself). Returns int grade or None."""
    model = _load_model()
    mt = SUITE_TO_MODEL.get(entry.get("ptype"))
    if not model or mt not in model.get("types", {}):
        return None
    m = model["types"][mt]
    F = model["features"]

    def f(v):
        return float(v) if v is not None else None

    velo, ivb, hb = f(entry.get("velo")), f(entry.get("ivb")), f(entry.get("hb"))
    spin, ext = f(entry.get("spin")), f(entry.get("ext"))
    rel_h, rel_s = f(entry.get("rel_h")), f(entry.get("rel_s"))
    if None in (velo, ivb, hb, spin, rel_h) or not ext:
        return None

    est_vaa = estimate_vaa(velo, ext, rel_h, ivb)
    if est_vaa is None:
        return None
    sc = m["slot_coef"]
    slot_eff = sc[0] + sc[1] * rel_h + sc[2] * abs(rel_s or 0.0) - m["slot_ybar"]
    vaa_adj = est_vaa - model.get("slot_alpha", 0.6) * slot_eff

    fb_velo = f(fb.get("velo")) if fb else velo
    fb_ivb = f(fb.get("ivb")) if fb else ivb
    fb_hb = f(fb.get("hb")) if fb else hb
    if fb_velo is None:
        fb_velo, fb_ivb, fb_hb = velo, ivb, hb

    feat = {
        "velo": velo,
        "vaa_adj": vaa_adj,
        "hb_abs": abs(hb),
        "spin": spin,
        "extension": ext,
        "rel_side_abs": abs(rel_s or 0.0),
        "velo_sep": fb_velo - velo,
        "ivb_sep": (fb_ivb if fb_ivb is not None else ivb) - ivb,
        "mov_sep": math.hypot(ivb - (fb_ivb if fb_ivb is not None else ivb),
                              hb - (fb_hb if fb_hb is not None else hb)),
    }
    means, stds, coef, mx, my = m["means"], m["stds"], m["coef"], m["mx"], m["my"]
    # Wider clamps than the Rapsodo adapter (its ±2.5/±2.8 guards exist for
    # out-of-distribution device drift): TrackMan rows are in-distribution,
    # and the tight clamps saturated everything elite to the same ~170 —
    # calibration vs the trainer's own WCL grades showed 147s and 172s both
    # mapping to 170. ±4 z / ±3.2 pz keeps absurd-input protection while
    # preserving top-end separation (validated: trainer 147 -> ~155 here).
    z = [max(-4.0, min(4.0, (feat[F[i]] - means[i]) / (stds[i] or 1.0))) for i in range(len(F))]
    pred = sum((z[i] - mx[i]) * coef[i] for i in range(len(F))) + my
    pz = max(-3.2, min(3.2, (pred - m["pred_mean"]) / (m["pred_std"] or 1.0)))
    grade = model["grade_mean"] + model["grade_sd"] * m["shrink"] * pz
    return max(20, min(175, round(grade)))
