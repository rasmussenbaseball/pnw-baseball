"""Stuff model (v1.1) — a transparent, research-grounded transfer model.

Not a trained GBM. Bullpen Rapsodo data has no outcomes, so instead of fitting
our own model we TRANSFER published effect sizes from the public Stuff+ literature
(Driveline 2021/2024, FanGraphs PitchingBot, tjStuff+) into a transparent linear
model centered on per-pitch-type anchors. 100 = average FOR THAT pitch type;
~10 points ≈ 1 SD; NOT comparable across pitch types (a 110 slider ≠ 110 sinker).
See RAPSODO_TOOL_DESIGN.md §9.

v1.1 — SELF-CALIBRATION: the velocity anchor (mean + SD) is read from the
population, via backend/data/rapsodo_anchors.json (scripts/rapsodo/calibrate.py),
when we have enough samples. The velocity term is SD-scaled (Stuff+'s 100±10/SD
convention) so a wide college velo spread doesn't blow the scale up. Movement
anchors stay on college-provisional defaults for now because IVB/HB mix spin- and
trajectory-basis devices and need basis-aware calibration; movement terms are
also capped so a trajectory-basis device can't dominate a grade.

Grounded coefficients: velo ~per-SD (Driveline ~6 pts/mph at MLB SD); perceived
velo = velo + 1.7*(ext-6.3) [Statcast]; secondaries graded on the velo + movement
DIFFERENTIAL off the pitcher's own fastball [Driveline/tjStuff+].
"""
import json
import math
import os

VERSION = "v1.1"

# Per-type DEFAULT anchors: (velo mph, IVB in, arm-side HB in). College-provisional.
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
    "splitter":         (84, 5, 8),
}
_FB_TYPES = {"4-seam (ride)", "fastball (mixed)", "sinker / 2-seam", "cutter"}
_REF_FB = (90, 16, 8)            # college-avg 4-seam, for centering secondary separations
_EXT_AVG = 6.3                   # league-avg extension (ft)
_DEFAULT_VELO_SD = 3.5
_MIN_CALIB_N = 12                # min samples before trusting a calibrated velo anchor

_ANCHORS_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "data", "rapsodo_anchors.json")
_calib = None
_calib_mtime = None


def _load_calib():
    """Load population anchors, hot-reloading when the file changes (so the
    nightly recalibration takes effect without restarting the API)."""
    global _calib, _calib_mtime
    try:
        m = os.path.getmtime(_ANCHORS_PATH)
    except OSError:
        m = None
    if _calib is None or m != _calib_mtime:
        _calib_mtime = m
        try:
            with open(_ANCHORS_PATH) as fh:
                _calib = json.load(fh)
        except Exception:  # noqa: BLE001 — missing/bad file → use defaults
            _calib = {}
    return _calib


def reload_calibration():
    """Drop the cached anchors so the next grade() re-reads the JSON (call after
    recomputing it)."""
    global _calib
    _calib = None


def _velo_anchor(pitch):
    """(mean velo, velo SD) — calibrated from population data when we have enough
    samples, else the college-provisional default."""
    mean, sd = _A[pitch][0], _DEFAULT_VELO_SD
    c = _load_calib().get(pitch)
    if c and c.get("n", 0) >= _MIN_CALIB_N and c.get("velo") is not None:
        mean = c["velo"]
        if c.get("velo_sd"):
            sd = min(5.0, max(2.5, c["velo_sd"]))
    return mean, sd


def _f(v):
    return float(v) if v is not None else None


def _perceived_velo(velo, ext):
    # +1.7 mph of effective velo per foot of extension over league average [firm]
    return velo + 1.7 * (ext - _EXT_AVG) if ext else velo


def _velo_pts(pv, mean, sd, slope=9.0):
    # SD-scaled (~per Stuff+ 100±10/SD). Mild convex bump for genuine velo outliers.
    pts = slope * (pv - mean) / sd
    if pv > 95:
        pts += 1.5 * (pv - 95)
    return pts


def _cap(x, lo=-13.0, hi=13.0):
    return max(lo, min(hi, x))


def grade(entry, fb):
    """Stuff v1.1 for one arsenal centroid. fb = fastball centroid {velo,ivb,arm_hb}.
    Returns (score:int, components:dict) or (None, None)."""
    pitch = entry.get("pitch")
    if pitch not in _A:
        return None, None
    velo, ivb, hb = _f(entry.get("velo")), _f(entry.get("ivb")), _f(entry.get("arm_hb"))
    if velo is None or ivb is None or hb is None:
        return None, None
    velo_mean, velo_sd = _velo_anchor(pitch)
    ivb_mean, hb_mean = _A[pitch][1], _A[pitch][2]
    pv = _perceived_velo(velo, _f(entry.get("ext")))
    comp = {}

    if pitch in _FB_TYPES:
        comp["velo"] = round(_velo_pts(pv, velo_mean, velo_sd), 1)
        if pitch == "sinker / 2-seam":
            comp["run"] = round(_cap(1.2 * (hb - hb_mean)), 1)       # more arm-side run
            comp["drop"] = round(_cap(1.0 * (ivb_mean - ivb)), 1)    # less ride = more sink
        elif pitch == "cutter":
            comp["shape"] = round(_cap(0.6 * (ivb_mean - ivb)), 1)   # ride taken off
        else:  # 4-seam / mixed: reward ride + flat VAA
            comp["ride"] = round(_cap(1.5 * (ivb - ivb_mean)), 1)
            vaa = _f(entry.get("vaa"))
            if vaa is not None:                                      # flatter than -5 deg = whiffs up
                comp["vaa"] = round(_cap(6.0 * (vaa + 5), -10, 10), 1)
    else:
        # Secondaries: own velo matters less; the DIFFERENTIAL off the fastball
        # carries the grade (tunneling-then-divergence).
        comp["velo"] = round(_velo_pts(pv, velo_mean, velo_sd, slope=5.0), 1)
        if fb and all(fb.get(k) is not None for k in ("velo", "ivb", "arm_hb")):
            velo_sep = fb["velo"] - velo
            ref_vsep = _REF_FB[0] - velo_mean
            comp["fb_velo_sep"] = round(_cap(1.5 * (velo_sep - ref_vsep)), 1)
            move_diff = math.hypot(ivb - fb["ivb"], hb - fb["arm_hb"])
            ref_mdiff = math.hypot(ivb_mean - _REF_FB[1], hb_mean - _REF_FB[2])
            comp["fb_move_sep"] = round(_cap(1.0 * (move_diff - ref_mdiff)), 1)
            if pitch == "changeup":                                 # kill ride vs FB, target ~8"
                comp["ride_kill"] = round(_cap(1.0 * ((fb["ivb"] - ivb) - 8)), 1)

    return max(20, min(175, round(100 + sum(comp.values())))), comp


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
