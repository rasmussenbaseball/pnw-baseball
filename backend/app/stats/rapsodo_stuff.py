"""Stuff model (v1) — a transparent, research-grounded transfer model.

Not a trained GBM. Bullpen Rapsodo data has no outcomes, so instead of fitting
our own model we TRANSFER published effect sizes from the public Stuff+ literature
(Driveline 2021/2024, FanGraphs PitchingBot, tjStuff+) into a transparent linear
model centered on per-pitch-type anchors. 100 = average FOR THAT pitch type;
~10 points ≈ 1 SD; NOT comparable across pitch types (a 110 slider ≠ 110 sinker).
See RAPSODO_TOOL_DESIGN.md §9.

Grounded coefficients (provenance in comments):
  * Velocity ≈ 6 Stuff+ pts / mph, convex above ~96 mph (Driveline 2024).  [firm]
  * Extension → perceived velo: velo + 1.7*(ext - 6.3 ft) (Statcast).        [firm]
  * Secondaries graded on velo + movement DIFFERENTIAL from the pitcher's own
    fastball, weighted >= absolute movement (Driveline/tjStuff+).            [firm principle]
  * Within-type 100-centered scaling.                                        [firm]
  * Per-type ANCHORS below are COLLEGE-provisional estimates so college arms
    center near 100 (MLB means mis-center for college — Baseball America /
    CornBelters). RECALIBRATE from our own population once enough pitches land. [estimate]
"""
import math

VERSION = "v1"

# Per-type anchors: (velo mph, IVB in, arm-side HB in). arm_hb is arm-side-positive.
# COLLEGE-provisional — flagged for recalibration from real NWBB data.
_A = {
    "4-seam (ride)":    (90, 16, 8),
    "fastball (mixed)": (89, 14, 10),
    "sinker / 2-seam":  (88, 9, 16),
    "cutter":           (84, 7, -2),
    "slider":           (81, 1, -5),
    "gyro slider":      (82, 1, -2),
    "sweeper":          (79, 3, -13),
    "curveball":        (76, -9, -9),
    "changeup":         (81, 7, 14),
}
_FB_TYPES = {"4-seam (ride)", "fastball (mixed)", "sinker / 2-seam", "cutter"}
_REF_FB = (90, 16, 8)            # college-avg 4-seam, for centering secondary separations
_EXT_AVG = 6.3                   # league-avg extension (ft)


def _f(v):
    return float(v) if v is not None else None


def _perceived_velo(velo, ext):
    # +1.7 mph of effective velo per foot of extension over league average [firm]
    return velo + 1.7 * (ext - _EXT_AVG) if ext else velo


def _velo_pts(pv, mean, slope=6.0):
    pts = slope * (pv - mean)
    if pv > 96:                  # convex: velocity overpowers shape above ~96 [firm direction]
        pts += 4.0 * (pv - 96)
    return pts


def grade(entry, fb):
    """Stuff v1 for one arsenal centroid. fb = fastball centroid {velo,ivb,arm_hb}.
    Returns (score:int, components:dict) or (None, None)."""
    pitch = entry.get("pitch")
    a = _A.get(pitch)
    velo, ivb, hb = _f(entry.get("velo")), _f(entry.get("ivb")), _f(entry.get("arm_hb"))
    if a is None or velo is None or ivb is None or hb is None:
        return None, None
    pv = _perceived_velo(velo, _f(entry.get("ext")))
    comp = {}

    if pitch in _FB_TYPES:
        comp["velo"] = round(_velo_pts(pv, a[0]), 1)
        if pitch == "sinker / 2-seam":
            comp["run"] = round(1.2 * (hb - a[2]), 1)        # more arm-side run
            comp["drop"] = round(1.0 * (a[1] - ivb), 1)      # less ride = more sink
        elif pitch == "cutter":
            comp["shape"] = round(0.6 * (a[1] - ivb), 1)     # ride taken off
        else:  # 4-seam / mixed: reward ride + flat VAA
            comp["ride"] = round(1.5 * (ivb - a[1]), 1)
            vaa = _f(entry.get("vaa"))
            if vaa is not None:                              # flatter than -5 deg = whiffs up [firm rank]
                comp["vaa"] = round(max(-10, min(10, 6.0 * (vaa + 5))), 1)
    else:
        # Secondaries: own velo matters less; the DIFFERENTIAL off the fastball
        # carries the grade (tunneling-then-divergence).
        comp["velo"] = round(_velo_pts(pv, a[0], slope=3.0), 1)
        if fb and fb.get("velo") is not None and fb.get("ivb") is not None and fb.get("arm_hb") is not None:
            velo_sep = fb["velo"] - velo
            ref_vsep = _REF_FB[0] - a[0]
            comp["fb_velo_sep"] = round(1.5 * (velo_sep - ref_vsep), 1)
            move_diff = math.hypot(ivb - fb["ivb"], hb - fb["arm_hb"])
            ref_mdiff = math.hypot(a[1] - _REF_FB[1], a[2] - _REF_FB[2])
            comp["fb_move_sep"] = round(1.0 * (move_diff - ref_mdiff), 1)
            if pitch == "changeup":                          # kill ride vs FB, target ~8" [firm benchmark]
                comp["ride_kill"] = round(1.0 * ((fb["ivb"] - ivb) - 8), 1)

    score = 100 + sum(comp.values())
    return max(20, min(175, round(score))), comp


def fb_from_arsenal(arsenal):
    """Fastball anchor (most-thrown fastball, else hardest pitch) {velo,ivb,arm_hb}."""
    if not arsenal:
        return None
    fbs = [a for a in arsenal if a.get("pitch") in {"4-seam (ride)", "fastball (mixed)", "sinker / 2-seam"}]
    pick = (max(fbs, key=lambda a: a.get("count", 0)) if fbs
            else max(arsenal, key=lambda a: _f(a.get("velo")) or 0))
    return {"velo": _f(pick.get("velo")), "ivb": _f(pick.get("ivb")), "arm_hb": _f(pick.get("arm_hb"))}


def annotate(arsenal, fb):
    """Attach 'stuff' + 'stuff_components' to each arsenal entry in place."""
    for entry in arsenal:
        s, comp = grade(entry, fb)
        entry["stuff"] = s
        entry["stuff_components"] = comp
    return arsenal
