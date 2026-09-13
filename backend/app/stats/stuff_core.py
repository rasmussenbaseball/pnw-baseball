"""NWBB Stuff+ — the ONE pitch-quality scorer used everywhere on the site.

Consumers (all route through score()):
  * TrackMan Suite arsenals            app/stats/trackman_stuff.py
  * Rapsodo Lab arsenals               app/stats/stuff_model.py (device-drift adapter)
  * WCL summer TrackMan cards          scripts/stuff/regrade_wcl.py -> trackman_pitches.pitch_grade

WHAT THE MODEL IS
  Fit by scripts/stuff/train_stuff_model.py on every live pitch in the
  TrackMan Suite corpus (games, scrimmages, intrasquads — college arms
  facing college hitters). The target is EXPECTED RUN VALUE per pitch,
  pitcher perspective: a ball, called strike, whiff or foul is priced at
  its count-neutral linear weight, and a ball in play is priced by what
  that exit velocity + launch angle is WORTH (xwOBAcon -> runs), not by
  what happened to it. So a sinker that lives on 68-mph ground balls is
  credited for that, a hanging slider that got popped up is not bailed out,
  and whiffs are one way to earn value rather than the whole target.

  Three ridge models (fastball / breaking / offspeed families) on a
  physical feature blend with quadratic + interaction terms — velocity,
  induced vertical break, arm-side horizontal break, spin, extension,
  release height/side, geometric (location-neutral) approach angle, total
  movement, and every pitch's SEPARATION from the pitcher's own primary
  fastball (velo gap, IVB gap, HB gap, movement distance, release
  consistency). Pitch location, count and platoon are fit as nuisance
  terms and held at their means when scoring, so the grade is shape only.
  The HB x IVB interaction is what lets a gyro slider (little sweep, late
  depth) and a sweeper both grade well while the dead-zone in between does
  not: sliders are NOT graded on sweep.

SCALE
  Per pitch type: 100 = the average pitch of that type in the college
  corpus, 15 points per SD of pitcher-level centroids. Capped 20-180. Not
  comparable across pitch types (a 110 changeup is a good changeup).

INPUT CONTRACT for score(entry, fb):
  entry = {ptype, velo (mph), ivb (in), hb_arm (in, arm-side positive),
           spin (rpm), ext (ft), rel_h (ft), rel_s (ft, sign ignored)}
  fb    = the pitcher's primary fastball in the same shape (None -> entry)
  Missing spin/ext/rel_h/rel_s are imputed with the family training mean;
  velo, ivb and hb_arm are required.
"""
import json
import math
import os

MODEL_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "data", "stuff_model.json")

# Every name the site uses for a pitch type -> the canonical suite name.
TYPE_ALIASES = {
    "fastball": "Fastball", "four seam": "Fastball", "fourseam": "Fastball", "four-seam": "Fastball",
    "fourseamfastball": "Fastball", "ff": "Fastball", "4s": "Fastball",
    "sinker": "Sinker", "two seam": "Sinker", "twoseam": "Sinker", "two-seam": "Sinker", "si": "Sinker",
    "cutter": "Cutter", "fc": "Cutter",
    "slider": "Slider", "sl": "Slider",
    "sweeper": "Sweeper", "st": "Sweeper",
    "curveball": "Curveball", "curve": "Curveball", "cu": "Curveball", "knuckle curve": "Curveball",
    "changeup": "ChangeUp", "change": "ChangeUp", "ch": "ChangeUp",
    "splitter": "Splitter", "split": "Splitter", "fs": "Splitter",
}
FAMILY_OF = {
    "Fastball": "fb", "Sinker": "fb",
    "Cutter": "br", "Slider": "br", "Sweeper": "br", "Curveball": "br",
    "ChangeUp": "os", "Splitter": "os",
}
FB_FAMILY = {"Fastball", "Sinker", "Cutter"}   # primary-fastball candidates

Z_REF_FT = 2.4          # plate-crossing height the geometric VAA is evaluated at
GRADE_MEAN, GRADE_SD, GRADE_LO, GRADE_HI = 100.0, 15.0, 20, 180
Z_CLAMP = 3.5           # grade z clamp (keeps absurd inputs from reading 250)
FEAT_CLAMP = 4.0        # per-feature z clamp before the linear model

# Feature order is the contract between the trainer and this scorer.
FEATURES = [
    # raw shape
    "velo", "ivb", "hb_arm", "spin", "ext", "rel_s_abs", "est_vaa",
    # curvature + interactions (gyro vs sweep, ride x velo, run x velo)
    "velo2", "ivb2", "hb2", "ivb_x_hb", "velo_x_ivb", "velo_x_hb",
    # separation from the pitcher's primary fastball
    "velo_diff", "ivb_diff", "hb_diff", "mov_dist", "rel_h_diff", "rel_s_diff",
    "velo_diff2", "mov_dist2", "ivb_diff_x_velo_diff",
]
# Feature -> tooltip component group.
GROUP_OF = {
    "velo": "velo", "velo2": "velo",
    "ivb": "movement", "hb_arm": "movement", "ivb2": "movement",
    "hb2": "movement", "ivb_x_hb": "movement", "velo_x_ivb": "movement", "velo_x_hb": "movement",
    "spin": "spin",
    "ext": "release", "rel_s_abs": "release", "est_vaa": "release",
    "velo_diff": "separation", "ivb_diff": "separation", "hb_diff": "separation",
    "mov_dist": "separation", "rel_h_diff": "separation", "rel_s_diff": "separation",
    "velo_diff2": "separation", "mov_dist2": "separation", "ivb_diff_x_velo_diff": "separation",
}

_model = None
_model_mtime = None


def canon_type(t):
    if not t:
        return None
    s = str(t).strip()
    if s in FAMILY_OF:
        return s
    return TYPE_ALIASES.get(s.lower().replace("_", " "))


def load_model(path=MODEL_PATH):
    global _model, _model_mtime
    try:
        mt = os.path.getmtime(path)
    except OSError:
        return None
    if _model is None or mt != _model_mtime:
        with open(path) as f:
            _model = json.load(f)
        _model_mtime = mt
    return _model


def pick_fastball(entries):
    """The pitcher's PRIMARY fastball reference from a list of arsenal
    entries (dicts with ptype + n): most-thrown of Fastball/Sinker/Cutter,
    ties and near-ties to the four-seam. None when there is no fastball."""
    fbs = [e for e in (entries or []) if canon_type(e.get("ptype")) in FB_FAMILY]
    if not fbs:
        return None     # no fastball on record: separations get imputed, not zeroed
    return max(fbs, key=lambda e: ((e.get("n") or 0) + (5 if canon_type(e.get("ptype")) == "Fastball" else 0),
                                   canon_type(e.get("ptype")) == "Fastball"))


def estimate_vaa(velo, ext, rel_h, ivb):
    """Location-neutral geometric vertical approach angle (deg, negative =
    downhill) at a fixed mid-zone crossing height."""
    if None in (velo, ext, rel_h, ivb):
        return None
    v0 = float(velo) * 1.4667
    if v0 <= 0:
        return None
    y0 = 60.5 - float(ext)
    vy = 0.955 * v0
    t = y0 / vy
    a_z = -32.17 + 2.0 * (float(ivb) / 12.0) / (t * t)
    vz0 = ((Z_REF_FT - float(rel_h)) - 0.5 * a_z * t * t) / t
    return math.degrees(math.atan2(vz0 + a_z * t, 0.92 * v0))


def _f(v):
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def build_features(entry, fb, impute=None):
    """Raw (unstandardized) feature dict for one pitch/centroid, or None if
    velo/ivb/hb_arm are missing. `impute` = {feature: value} fills missing
    spin/ext/rel_h/rel_s (the trainer passes family means)."""
    velo, ivb, hb = _f(entry.get("velo")), _f(entry.get("ivb")), _f(entry.get("hb_arm"))
    if None in (velo, ivb, hb):
        return None
    imp = impute or {}
    spin = _f(entry.get("spin"))
    ext = _f(entry.get("ext")) or None       # Rapsodo reports 0 when unknown
    rel_h = _f(entry.get("rel_h"))
    rel_s = _f(entry.get("rel_s"))
    if spin is None:
        spin = imp.get("spin")
    if ext is None:
        ext = imp.get("ext")
    if rel_h is None:
        rel_h = imp.get("rel_h")
    if rel_s is None:
        rel_s = imp.get("rel_s_abs")
    if None in (spin, ext, rel_h, rel_s):
        return None
    rel_s = abs(rel_s)
    vaa = estimate_vaa(velo, ext, rel_h, ivb)
    if vaa is None:
        return None

    ptype = canon_type(entry.get("ptype"))
    fb_ok = fb is not None and None not in (_f(fb.get("velo")), _f(fb.get("ivb")), _f(fb.get("hb_arm")))
    if fb_ok:
        fb_velo, fb_ivb, fb_hb = _f(fb["velo"]), _f(fb["ivb"]), _f(fb["hb_arm"])
        fb_rel_h = _f(fb.get("rel_h"))
        fb_rel_s = _f(fb.get("rel_s"))
        fb_rel_h = rel_h if fb_rel_h is None else fb_rel_h
        fb_rel_s = rel_s if fb_rel_s is None else abs(fb_rel_s)
        velo_diff, ivb_diff, hb_diff = fb_velo - velo, fb_ivb - ivb, fb_hb - hb
        mov_dist = math.hypot(ivb_diff, hb_diff)
        rel_h_diff, rel_s_diff = abs(rel_h - fb_rel_h), abs(rel_s - fb_rel_s)
    elif ptype in FB_FAMILY:
        # no other fastball on record: this IS the primary, separation is 0
        velo_diff = ivb_diff = hb_diff = mov_dist = rel_h_diff = rel_s_diff = 0.0
    else:
        # a secondary with no fastball to compare against (a reliever who
        # only threw sliders in the file, a WCL centroid whose fastball PDF
        # never came in): use the family's typical separation rather than
        # pretending the pitch separates from nothing.
        velo_diff = imp.get("velo_diff", 0.0)
        ivb_diff = imp.get("ivb_diff", 0.0)
        hb_diff = imp.get("hb_diff", 0.0)
        mov_dist = imp.get("mov_dist", math.hypot(ivb_diff, hb_diff))
        rel_h_diff = imp.get("rel_h_diff", 0.0)
        rel_s_diff = imp.get("rel_s_diff", 0.0)
    return {
        "velo": velo, "ivb": ivb, "hb_arm": hb, "spin": spin, "ext": ext, "rel_h": rel_h,
        "rel_s_abs": rel_s, "est_vaa": vaa, "rel_h": rel_h, "mov_mag": math.hypot(ivb, hb),
        "velo2": velo * velo, "ivb2": ivb * ivb, "hb2": hb * hb, "ivb_x_hb": ivb * hb,
        "velo_x_ivb": velo * ivb, "velo_x_hb": velo * hb,
        "velo_diff": velo_diff, "ivb_diff": ivb_diff, "hb_diff": hb_diff, "mov_dist": mov_dist,
        "rel_h_diff": rel_h_diff, "rel_s_diff": rel_s_diff,
        "velo_diff2": velo_diff * velo_diff, "mov_dist2": mov_dist * mov_dist,
        "ivb_diff_x_velo_diff": ivb_diff * velo_diff,
    }


def predict_xrv(entry, fb=None, model=None):
    """Model xRV (runs saved per 100 pitches vs the family's average pitch)
    plus per-feature contributions, or (None, None, None). Raw units — use
    score() for the 100-scale grade."""
    model = model or load_model()
    if not model:
        return None, None, None
    pt = canon_type(entry.get("ptype"))
    fam = (model.get("family_of") or FAMILY_OF).get(pt)
    fm = (model.get("families") or {}).get(fam) if fam else None
    if not fm:
        return None, None, None
    feats = build_features(entry, fb, impute=fm.get("impute"))
    if feats is None:
        return None, None, None
    names, means, stds, coef = fm["features"], fm["means"], fm["stds"], fm["coef"]
    contrib = {}
    pred = fm["intercept"]
    for i, name in enumerate(names):
        z = (feats[name] - means[i]) / (stds[i] or 1.0)
        z = max(-FEAT_CLAMP, min(FEAT_CLAMP, z))
        c = z * coef[i]
        contrib[name] = c
        pred += c
    # type intercept (fit as a dummy inside the family)
    pred += (fm.get("type_offsets") or {}).get(pt, 0.0)
    return pred, contrib, pt


def score(entry, fb=None, model=None):
    """-> (grade:int|None, components:{group: grade points}|None, xrv:float|None)."""
    model = model or load_model()
    pred, contrib, pt = predict_xrv(entry, fb, model)
    if pred is None:
        return None, None, None
    sc = (model.get("type_scale") or {}).get(pt)
    if not sc:
        return None, None, None
    sd = sc["sd"] or 1.0
    z = max(-Z_CLAMP, min(Z_CLAMP, (pred - sc["mean"]) / sd))
    grade = int(max(GRADE_LO, min(GRADE_HI, round(GRADE_MEAN + GRADE_SD * z))))
    pts = GRADE_SD / sd
    comps = {}
    for name, c in contrib.items():
        g = GROUP_OF.get(name, "other")
        comps[g] = comps.get(g, 0.0) + c * pts
    comps = {k: round(v, 1) for k, v in comps.items()}
    return grade, comps, round(pred, 3)
