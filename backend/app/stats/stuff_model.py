"""Apply the WCL TrackMan pitch-grade model (trained on whiff+chase) to Rapsodo
pitches. The model is fit by scripts/trackman/compute_pitch_grades.py and exported
to backend/data/rapsodo_stuff_model.json; here we replicate its feature build and
score a Rapsodo arsenal centroid against the fitted per-pitch-type weights.

The VAA estimate below is the TrackMan model's LOCATION-NEUTRAL formula (fixed
mid-zone crossing height) — it must stay identical to estimate_vaa() in
compute_pitch_grades.py or the transfer is biased. Rapsodo's own location-aware
VAA (rapsodo_parse) is for display/dead-zone, NOT for this model.
"""
import math

_Z_REF = 2.4   # reference plate-crossing height (must match compute_pitch_grades.Z_REF_FT)

# Rapsodo re-classified labels -> the model's TrackMan pitch types.
RAPSODO_TO_MODEL = {
    "4-seam (ride)": "Four Seam", "fastball (mixed)": "Four Seam",
    "sinker / 2-seam": "Sinker", "cutter": "Cutter",
    "slider": "Slider", "gyro slider": "Slider", "sweeper": "Slider",
    "curveball": "Curveball", "changeup": "Changeup", "splitter": "Splitter",
}


def _f(v):
    return float(v) if v is not None else None


def estimate_vaa(velo, ext, rel_height, ivb):
    """Location-neutral geometric VAA (deg). Copy of compute_pitch_grades.estimate_vaa."""
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


def grade_pitch(model, rap_type, entry, fb):
    """Grade one Rapsodo arsenal centroid with the trained model. Returns
    (grade:int, components:dict) or (None, None) if the model can't score it."""
    mt = RAPSODO_TO_MODEL.get(rap_type)
    if not model or mt not in model.get("types", {}):
        return None, None
    m = model["types"][mt]
    F = model["features"]
    velo, ivb, hb = _f(entry.get("velo")), _f(entry.get("ivb")), _f(entry.get("arm_hb"))
    spin = _f(entry.get("total_spin"))
    rel_h, rel_s = _f(entry.get("rel_height")), _f(entry.get("rel_side"))
    ext = _f(entry.get("ext"))
    if velo is None or ivb is None or hb is None or spin is None or rel_h is None:
        return None, None
    if not ext:                                   # Rapsodo often reports 0/None
        ext = m["means"][F.index("extension")]    # impute the type's mean extension

    est_vaa = estimate_vaa(velo, ext, rel_h, ivb)
    if est_vaa is None:
        return None, None
    sc = m["slot_coef"]
    slot_eff = sc[0] + sc[1] * rel_h + sc[2] * abs(rel_s or 0.0) - m["slot_ybar"]
    vaa_adj = est_vaa - model.get("slot_alpha", 0.6) * slot_eff

    fbv = _f(fb.get("velo")) if fb else velo
    fbivb = _f(fb.get("ivb")) if fb else ivb
    fbhb = _f(fb.get("arm_hb")) if fb else hb
    feat = {
        "velo": velo, "vaa_adj": vaa_adj, "hb_abs": abs(hb), "spin": spin,
        "extension": ext, "rel_side_abs": abs(rel_s or 0.0),
        "velo_sep": (fbv or velo) - velo, "ivb_sep": (fbivb if fbivb is not None else ivb) - ivb,
        "mov_sep": math.hypot(ivb - (fbivb if fbivb is not None else ivb), hb - (fbhb if fbhb is not None else hb)),
    }
    means, stds, coef, mx, my = m["means"], m["stds"], m["coef"], m["mx"], m["my"]
    # Clamp feature z-scores: Rapsodo measures break/extension differently than
    # the TrackMan training set, so an out-of-distribution input must not be
    # allowed to extrapolate the linear model off a cliff.
    z = [max(-2.5, min(2.5, (feat[F[i]] - means[i]) / (stds[i] or 1.0))) for i in range(len(F))]
    pred = sum((z[i] - mx[i]) * coef[i] for i in range(len(F))) + my
    pz = max(-2.8, min(2.8, (pred - m["pred_mean"]) / (m["pred_std"] or 1.0)))
    scale = model["grade_sd"] * m["shrink"]
    grade = model["grade_mean"] + scale * pz
    comp = {F[i]: round((z[i] - mx[i]) * coef[i] / (m["pred_std"] or 1.0) * scale, 1)
            for i in range(len(F)) if abs((z[i] - mx[i]) * coef[i]) >= 0.04}
    return max(20, min(175, round(grade))), comp
