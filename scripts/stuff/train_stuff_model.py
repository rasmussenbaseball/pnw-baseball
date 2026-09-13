"""Train NWBB Stuff+ (the site-wide pitch-quality model) on the TrackMan
Suite's live pitches and export backend/data/stuff_model.json.

    PYTHONPATH=backend python3 scripts/stuff/train_stuff_model.py            # fit + report
    PYTHONPATH=backend python3 scripts/stuff/train_stuff_model.py --export   # + write the JSON
    ... --anchors "Gillespie,Courtney"                                        # print named arsenals

DESIGN (see app/stats/stuff_core.py for the scoring side)
  Rows     every pitch from game / scrimmage / intrasquad sessions across all
           suite owners with a usable shape (velo, IVB, HB) and a priced
           outcome. Bullpens and BP have no outcomes and are excluded.
  Target   expected run value, pitcher perspective, runs per 100 pitches:
             ball / called strike / whiff / foul / HBP -> the corpus-mean run
               value of that outcome (count-neutral linear weight)
             ball in play -> what the contact was WORTH: xwOBAcon(EV, LA)
               converted to runs (0.82 * wOBA - 0.26), minus the mean
               starting count value; untracked contact falls back to the
               actual result
  Features stuff_core.FEATURES (shape + curvature + separation from the
           pitcher's primary fastball) standardized within family, plus
           NUISANCE columns fit but not scored: attack zone (heart / shadow
           / chase / waste), plate height (+ squared), platoon. Holding
           those at their means makes the grade location-free.
  Model    ridge per family (fb / br / os) with type intercepts; lambda by
           pitcher-grouped 5-fold CV. Velocity is checked for monotonicity
           across the observed range and the curvature term dropped if it
           ever says harder is worse.
  Scale    per pitch type: 100 = the n-weighted mean pitcher centroid of
           that type, 15 points per SD of centroids (n >= 10 pitches).
  Checks   out-of-fold correlation (pitcher x type, n >= 20) of predicted
           xRV with actual RV/100, whiff%, and xwOBAcon allowed; plus the
           WCL centroid corpus (trackman_pitches) as a fully out-of-sample
           whiff% check.
"""
import json
import math
import os
import sys
from collections import defaultdict

import numpy as np

from app.models.database import get_connection
from app.stats import stuff_core as core
from app.stats.trackman_runvalue import COUNT_RV, TERMINAL_RV, attack_zone, pitch_run_value
from app.stats.trackman_xstats import xwobacon

EXPORT = "--export" in sys.argv
ANCHORS = next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--anchors" and i + 1 < len(sys.argv)), "")
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "backend", "data", "stuff_model.json")

# Cutters live with the fastballs (the site's FB_FAMILY convention): a
# college cutter is a bridge pitch whose value is separation off the heater
# while staying hard, the same logic that grades a sinker. Validated both
# ways — cutter-in-fastball wins the out-of-fold composite (breaking family
# r(RV) 0.36 vs 0.31, xwOBAcon 0.30 vs 0.14; fastball family about even).
CUTTER_FB = "--cutter-br" not in sys.argv
FAMILIES = {"fb": ["Fastball", "Sinker"] + (["Cutter"] if CUTTER_FB else []),
            "br": ([] if CUTTER_FB else ["Cutter"]) + ["Slider", "Sweeper", "Curveball"],
            "os": ["ChangeUp", "Splitter"]}
FAMILY_OF = {t: f for f, ts in FAMILIES.items() for t in ts}
# Offspeed has a quarter of the fastball sample; a leaner feature set keeps
# the ridge from chasing noise in interaction terms.
OS_FEATURES = ["velo", "ivb", "hb_arm", "spin", "ext", "rel_s_abs", "est_vaa",
               "velo_diff", "ivb_diff", "hb_diff", "mov_dist", "rel_h_diff", "rel_s_diff",
               "velo_diff2", "ivb_diff_x_velo_diff", "velo2", "ivb_x_hb"]
FAMILY_FEATURES = {"fb": list(core.FEATURES), "br": list(core.FEATURES), "os": OS_FEATURES}
NUISANCE = ["z_heart", "z_shadow", "z_chase", "z_waste", "plate_h", "plate_h2", "platoon"]
LAMBDAS = [3, 10, 30, 100, 300, 1000, 3000, 10000, 1e7]   # 1e7 ~ the prior alone
MSE_SLACK = 1.005   # lambdas within 0.5% of the best OOF MSE are ties; break by aggregate r
COMP_SLACK = 0.05   # accept a heavier ridge while the aggregate composite stays this close
FORCE_LAMBDA = {}   # family -> lambda override (debugging)
MIN_VALID_COMPOSITE = 0.05   # below this the data fit is noise; use the prior

# DOMAIN PRIORS (runs saved / 100 per SD of the feature, standardized within
# family). The ridge shrinks toward THESE rather than toward zero, so where
# the corpus is thin (offspeed: ~1k pitches) the fit falls back on what the
# public Stuff+ literature agrees on — velocity, separation off the fastball
# (velo gap, IVB kill, movement distance), release consistency — instead of
# on noise. Where the corpus is deep (fastballs, breaking balls) the data
# picks a small lambda and the prior barely matters.
PRIORS = {
    "fb": {"velo": 0.5, "ivb": 0.3, "spin": 0.1, "ext": 0.15, "est_vaa": 0.2,
           "mov_dist": 0.2, "ivb_diff": 0.1},
    "br": {"velo": 0.4, "ivb": -0.3, "spin": 0.2, "mov_dist": 0.3, "ivb_diff": 0.2,
           "ext": 0.1},
    # Offspeed directions checked against BOTH corpora before being trusted
    # (suite centroids, RV target; WCL centroids, whiff target): velo gap
    # +0.10/+0.26, IVB kill +0.13/+0.09, movement distance +0.17/+0.15,
    # spin -0.20/-0.11, arm-side run +0.11/+0.03. Release consistency and
    # approach angle disagreed between corpora and get ~nothing.
    "os": {"velo": 0.2, "velo_diff": 0.4, "ivb_diff": 0.35, "hb_arm": 0.15, "mov_dist": 0.25,
           "spin": -0.2, "rel_h_diff": -0.1, "rel_s_diff": -0.1, "ext": 0.1},
}
WOBA_TO_RUNS, RUNS_OUT = 0.82, -0.26      # linear weights: runs = 0.82*wOBA - 0.26
MIN_CENTROID_N = 10
MIN_AGG_N = 15

_EFF = "COALESCE(p.override_pitch_type, p.class_pitch_type, p.tagged_pitch_type, p.auto_pitch_type)"
_BALL = {"BallCalled", "BallinDirt", "BallIntentional", "AutomaticBall"}
_CALLED = {"StrikeCalled", "AutomaticStrike"}
_FOUL = {"FoulBall", "FoulBallFieldable", "FoulBallNotFieldable"}


def bucket(call):
    if call in _BALL:
        return "ball"
    if call in _CALLED:
        return "called"
    if call == "StrikeSwinging":
        return "whiff"
    if call in _FOUL:
        return "foul"
    if call == "HitByPitch":
        return "hbp"
    if call == "InPlay":
        return "inplay"
    return None


def load_rows():
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(f"""
            SELECT p.pitcher, p.pitcher_team, p.pitcher_throws, p.batter_side, {_EFF} AS ptype,
                   p.rel_speed AS velo, p.ivb, p.horz_break AS hb, p.spin_rate AS spin,
                   p.extension AS ext, p.rel_height AS rel_h, p.rel_side AS rel_s,
                   p.plate_loc_side, p.plate_loc_height, p.balls, p.strikes,
                   p.pitch_call, p.play_result, p.exit_speed, p.launch_angle, p.direction
            FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
            WHERE s.session_type IN ('game', 'scrimmage', 'intrasquad')
              AND p.pitcher IS NOT NULL AND {_EFF} IS NOT NULL AND {_EFF} <> 'Mistag'
              AND p.rel_speed IS NOT NULL AND p.ivb IS NOT NULL AND p.horz_break IS NOT NULL""")
        rows = [dict(r) for r in cur.fetchall()]
    for r in rows:
        for k in ("velo", "ivb", "hb", "spin", "ext", "rel_h", "rel_s", "plate_loc_side",
                  "plate_loc_height", "exit_speed", "launch_angle", "direction"):
            r[k] = float(r[k]) if r[k] is not None else None
        r["ptype"] = core.canon_type(r["ptype"])
    return [r for r in rows if r["ptype"]]


def load_wcl():
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""SELECT tp.id, tp.summer_player_id, tp.season, tp.pitch_type, tp.pitch_count,
                              tp.velo, tp.spin, tp.ivb, tp.hb, tp.extension AS ext, tp.rel_height AS rel_h,
                              tp.rel_side AS rel_s, tp.whiff_pct, sp.throws
                       FROM trackman_pitches tp LEFT JOIN summer_players sp ON sp.id = tp.summer_player_id""")
        return [dict(r) for r in cur.fetchall()]


def hand_sign(throws, rel_s):
    t = (throws or "").strip().upper()[:1]
    if t == "R":
        return 1.0
    if t == "L":
        return -1.0
    if rel_s is not None and rel_s != 0:
        return 1.0 if rel_s > 0 else -1.0
    return 1.0


def to_entry(r, sign):
    return {"ptype": r["ptype"], "n": r.get("n"), "velo": r["velo"], "ivb": r["ivb"],
            "hb_arm": r["hb"] * sign if r["hb"] is not None else None, "spin": r["spin"],
            "ext": r["ext"], "rel_h": r["rel_h"], "rel_s": r["rel_s"]}


def centroid(rows, ptype):
    keys = ("velo", "ivb", "hb", "spin", "ext", "rel_h", "rel_s")
    out = {"ptype": ptype, "n": len(rows)}
    for k in keys:
        vals = [r[k] for r in rows if r[k] is not None]
        out[k] = sum(vals) / len(vals) if vals else None
    return out


# ── target ───────────────────────────────────────────────────────────────
def build_target(rows):
    """Adds r['y'] (runs saved per 100, pitcher perspective) and r['bucket'].
    Returns the count-neutral outcome weights for the report."""
    rv_by_bucket, start_inplay = defaultdict(list), []
    for r in rows:
        b = bucket(r["pitch_call"])
        r["bucket"] = b
        if b is None:
            continue
        rv = pitch_run_value(r["balls"], r["strikes"], r["pitch_call"], r["play_result"])
        if b != "inplay":
            if rv is not None:
                rv_by_bucket[b].append(rv)
        elif (r["balls"], r["strikes"]) in COUNT_RV:
            start_inplay.append(COUNT_RV[(r["balls"], r["strikes"])])
    w = {b: float(np.mean(v)) for b, v in rv_by_bucket.items()}
    start_mean = float(np.mean(start_inplay)) if start_inplay else 0.0
    n_x = n_actual = 0
    for r in rows:
        b = r["bucket"]
        r["y"] = None
        if b is None:
            continue
        if b != "inplay":
            if b in w:
                r["y"] = -100.0 * w[b]
            continue
        ev, la = r["exit_speed"], r["launch_angle"]
        if ev is not None and la is not None:
            val = WOBA_TO_RUNS * xwobacon(ev, la, r["direction"], r["batter_side"]) + RUNS_OUT
            r["xw"] = xwobacon(ev, la, r["direction"], r["batter_side"])
            n_x += 1
        elif r["play_result"] in TERMINAL_RV:
            val = TERMINAL_RV[r["play_result"]]
            n_actual += 1
        else:
            continue
        r["y"] = -100.0 * (val - start_mean)
    print("Outcome weights (runs, batter view):", {k: round(v, 4) for k, v in w.items()},
          f"| in-play start mean {start_mean:.3f} | in-play priced by xwOBAcon {n_x}, by result {n_actual}")
    return w


# ── design matrices ──────────────────────────────────────────────────────
def family_impute(rows, fam, fb_ref):
    """Family means used to fill missing inputs at scoring time: spin /
    extension / release, and the typical separation off the fastball for a
    secondary that has no fastball reference (computed from non-fastball
    pitches that DO have one)."""
    sub = [r for r in rows if FAMILY_OF[r["ptype"]] == fam]
    imp = {}
    for k, key in (("spin", "spin"), ("ext", "ext"), ("rel_h", "rel_h")):
        v = [r[key] for r in sub if r[key] is not None]
        imp[k] = float(np.mean(v)) if v else None
    v = [abs(r["rel_s"]) for r in sub if r["rel_s"] is not None]
    imp["rel_s_abs"] = float(np.mean(v)) if v else None
    diffs = defaultdict(list)
    for r in sub:
        fb = fb_ref.get((r["pitcher"], r["pitcher_team"]))
        if r["ptype"] in core.FB_FAMILY or not fb:
            continue
        f = core.build_features(to_entry(r, r["sign"]), to_entry(fb, r["sign"]),
                                impute={"spin": imp["spin"] or 0.0, "ext": imp["ext"] or 6.0,
                                        "rel_h": imp["rel_h"] or 5.5, "rel_s_abs": imp["rel_s_abs"] or 1.5})
        if f:
            for k in ("velo_diff", "ivb_diff", "hb_diff", "mov_dist", "rel_h_diff", "rel_s_diff"):
                diffs[k].append(f[k])
    for k, v in diffs.items():
        imp[k] = float(np.mean(v))
    return imp


def design(rows, fam, fb_ref, imp):
    types = FAMILIES[fam]
    X, y, groups, meta = [], [], [], []
    for r in rows:
        if FAMILY_OF[r["ptype"]] != fam or r["y"] is None:
            continue
        sign = r["sign"]
        fb = fb_ref.get((r["pitcher"], r["pitcher_team"]))
        feats = core.build_features(to_entry(r, sign), to_entry(fb, sign) if fb else None, impute=imp)
        if feats is None:
            continue
        row = [feats[f] for f in FAMILY_FEATURES[fam]]
        # type dummies (all but the first type of the family)
        row += [1.0 if r["ptype"] == t else 0.0 for t in types[1:]]
        # nuisance: attack zone, plate height, platoon
        z = attack_zone(r["plate_loc_side"], r["plate_loc_height"])
        row += [1.0 if z == "heart" else 0.0, 1.0 if z == "shadow" else 0.0,
                1.0 if z == "chase" else 0.0, 1.0 if z == "waste" else 0.0]
        ph = r["plate_loc_height"] if r["plate_loc_height"] is not None else 2.5
        row += [ph, ph * ph]
        bs = (r["batter_side"] or "").upper()[:1]
        row += [1.0 if (bs and bs == ("R" if sign > 0 else "L")) else 0.0]
        X.append(row)
        y.append(r["y"])
        groups.append(r["pitcher"])
        meta.append(r)
    names = list(FAMILY_FEATURES[fam]) + [f"type_{t}" for t in types[1:]] + NUISANCE
    return np.array(X, float), np.array(y, float), np.array(groups), meta, names


def standardize(X, n_dummy_start):
    mu = X.mean(axis=0)
    sd = X.std(axis=0)
    sd[sd == 0] = 1.0
    Z = (X - mu) / sd
    return Z, mu, sd


def ridge(Z, y, lam, prior=None):
    """Ridge toward `prior` (zeros by default); intercept unpenalized."""
    n, p = Z.shape
    A = np.hstack([np.ones((n, 1)), Z])
    P = np.eye(p + 1) * lam
    P[0, 0] = 0.0
    bp = np.zeros(p + 1)
    if prior is not None:
        bp[1:] = prior
    beta = np.linalg.solve(A.T @ A + P, A.T @ y + P @ bp)
    return beta[0], beta[1:]


def grouped_folds(groups, k=5, seed=7):
    rng = np.random.default_rng(seed)
    uniq = np.array(sorted(set(groups)))
    rng.shuffle(uniq)
    assign = {g: i % k for i, g in enumerate(uniq)}
    return np.array([assign[g] for g in groups])


def cv(Z, y, groups, lam, prior=None, k=5):
    folds = grouped_folds(groups, k)
    oof = np.zeros_like(y)
    for f in range(k):
        tr, te = folds != f, folds == f
        b0, b = ridge(Z[tr], y[tr], lam, prior)
        oof[te] = b0 + Z[te] @ b
    return oof


def wcorr(a, b, w=None):
    a, b = np.asarray(a, float), np.asarray(b, float)
    if len(a) < 4 or a.std() == 0 or b.std() == 0:
        return float("nan")
    return float(np.corrcoef(a, b)[0, 1])


def aggregate_check(meta, oof, label, quiet=False, min_n=MIN_AGG_N):
    """Correlate OOF predicted xRV with observed outcomes at pitcher x type."""
    agg = defaultdict(lambda: {"p": [], "y": [], "sw": 0, "wh": 0, "xw": [], "n": 0})
    for r, p in zip(meta, oof):
        a = agg[(r["pitcher"], r["pitcher_team"], r["ptype"])]
        a["p"].append(p)
        a["y"].append(r["y"])
        a["n"] += 1
        if r["bucket"] in ("whiff", "foul", "inplay"):
            a["sw"] += 1
            a["wh"] += r["bucket"] == "whiff"
        if r.get("xw") is not None:
            a["xw"].append(r["xw"])
    keep = [a for a in agg.values() if a["n"] >= min_n]
    if len(keep) < 5:
        print(f"  {label}: too few centroids ({len(keep)})")
        return float("nan")
    P = [np.mean(a["p"]) for a in keep]
    Y = [np.mean(a["y"]) for a in keep]
    W = [(a["wh"] / a["sw"]) if a["sw"] >= 8 else None for a in keep]
    XW = [np.mean(a["xw"]) if len(a["xw"]) >= 5 else None for a in keep]
    r_rv = wcorr(P, Y)
    wi = [i for i, v in enumerate(W) if v is not None]
    xi = [i for i, v in enumerate(XW) if v is not None]
    r_wh = wcorr([P[i] for i in wi], [W[i] for i in wi])
    r_xw = wcorr([P[i] for i in xi], [XW[i] for i in xi])
    comp = float(np.nanmean([r_rv, r_wh, -r_xw]))
    if quiet:
        print(f"  | {len(keep)} centroids r(RV)={r_rv:+.3f} r(whiff)={r_wh:+.3f} r(xwOBAcon)={-r_xw:+.3f}  composite {comp:+.3f}")
        return comp
    print(f"  {label}: {len(keep)} pitcher-types  r(xRV, actual RV/100)={r_rv:+.3f}  "
          f"r(xRV, whiff%)={r_wh:+.3f} (n={len(wi)})  r(xRV, xwOBAcon allowed)={-r_xw:+.3f} (n={len(xi)}; sign flipped so + = good)")


def velo_monotone(fm_coef, names, mu, sd, velo_range, feats_mean):
    """d(pred)/d(velo) across the observed velocity range, holding other raw
    features at their means (only velo and velo2 move; the velo interactions
    are evaluated at mean ivb/hb)."""
    i_v, i_v2 = names.index("velo"), names.index("velo2")
    ivb_m, hb_m = feats_mean["ivb"], feats_mean["hb_arm"]
    slopes = []
    for v in np.linspace(velo_range[0], velo_range[1], 9):
        s = fm_coef[i_v] / sd[i_v] + fm_coef[i_v2] * 2 * v / sd[i_v2]
        if "velo_x_ivb" in names:
            i_vi = names.index("velo_x_ivb")
            s += fm_coef[i_vi] * ivb_m / sd[i_vi]
        if "velo_x_hb" in names:
            i_vh = names.index("velo_x_hb")
            s += fm_coef[i_vh] * hb_m / sd[i_vh]
        slopes.append(s)
    return min(slopes), max(slopes)


def fit_family(fam, rows, fb_ref):
    imp = family_impute(rows, fam, fb_ref)
    X, y, groups, meta, names = design(rows, fam, fb_ref, imp)
    print(f"\n== {fam} == {len(y)} pitches, {len(set(groups))} pitchers, "
          f"y mean {y.mean():+.2f} sd {y.std():.2f} (runs saved / 100)")
    Z, mu, sd = standardize(X, len(FAMILY_FEATURES[fam]))
    null_mse = float(((y - y.mean()) ** 2).mean())
    prior = np.array([PRIORS[fam].get(n, 0.0) for n in names])
    trials = []
    for lam in LAMBDAS:
        oof = cv(Z, y, groups, lam, prior)
        mse = float(((y - oof) ** 2).mean())
        print(f"  lambda {lam:>9.0f}: OOF MSE {mse:.3f}", end="")
        comp = aggregate_check(meta, oof, "", quiet=True)
        trials.append((lam, mse, oof, comp))
    # Pick lambda: among fits within MSE_SLACK of the best OOF MSE, take the
    # best aggregate composite, then walk toward MORE shrinkage while the
    # composite stays within COMP_SLACK of it. Small lambdas win the
    # composite by hundredths while blowing collinear weights up to +-5
    # runs/100 per SD, which is what extrapolates off a cliff on Rapsodo and
    # WCL inputs; a modestly heavier ridge costs almost nothing out of fold.
    min_mse = min(t[1] for t in trials)
    ties = [t for t in trials if t[1] <= min_mse * MSE_SLACK]
    comp_of = lambda t: (t[3] if not math.isnan(t[3]) else -9)
    best = max(ties, key=comp_of)
    pick = best
    for t in sorted(ties, key=lambda t: t[0]):
        if t[0] > pick[0] and comp_of(t) >= comp_of(best) - COMP_SLACK:
            pick = t
    if FORCE_LAMBDA.get(fam):
        pick = next(t for t in trials if t[0] == FORCE_LAMBDA[fam])
    elif comp_of(best) < MIN_VALID_COMPOSITE:
        # The data fit does not validate out of fold (offspeed today: ~1k
        # pitches, 20 centroids). Fall back to the literature prior rather
        # than ship weights that point the wrong way; the trainer will pick
        # a data fit automatically once the corpus can support one.
        pick = trials[-1]
        print(f"  data fit fails to validate (best composite {comp_of(best):+.3f}); using the prior-only fit")
    lam, mse, oof, _ = pick
    print(f"  ridge lambda {lam} | OOF MSE {mse:.3f} vs null {null_mse:.3f} "
          f"({100 * (1 - mse / null_mse):.2f}% explained at the pitch level; that is normal for stuff)")
    aggregate_check(meta, oof, "OOF pitcher x type")
    b0, b = ridge(Z, y, lam, prior)

    # velocity monotonicity: harder is never worse across the observed range
    feats_mean = {n: float(mu[i]) for i, n in enumerate(names)}
    velo_col = X[:, names.index("velo")]
    lo, hi = np.percentile(velo_col, 2), np.percentile(velo_col, 98)
    smin, smax = velo_monotone(b, names, mu, sd, (lo, hi), feats_mean)
    if smin < 0:
        print(f"  velo slope dips to {smin:+.3f} runs/100 per mph inside {lo:.1f}-{hi:.1f}; dropping velo^2 and refitting")
        Z2 = Z.copy()
        Z2[:, names.index("velo2")] = 0.0
        b0, b = ridge(Z2, y, lam, prior)
        b[names.index("velo2")] = 0.0
        smin, smax = velo_monotone(b, names, mu, sd, (lo, hi), feats_mean)
        if smin < 0:
            print(f"  still {smin:+.3f}; flooring the linear velo term at zero")
            b[names.index("velo")] = max(0.0, b[names.index("velo")])
    print(f"  velo slope {smin:+.3f}..{smax:+.3f} runs/100 per mph over {lo:.1f}-{hi:.1f} mph")

    # Fold the type dummies into per-type offsets; nuisance columns are
    # standardized (mean 0) so holding them at their means contributes 0.
    nf = len(FAMILY_FEATURES[fam])
    types = FAMILIES[fam]
    type_off = {types[0]: 0.0}
    for j, t in enumerate(types[1:]):
        i = nf + j
        # dummy standardized: contribution = (d - mu)/sd * b -> offset for d=1 minus d=0
        type_off[t] = float(b[i] / sd[i])
        b0 += float(-mu[i] / sd[i] * b[i])  # d=0 baseline folded into intercept
    core_coef = [float(b[i]) for i in range(nf)]
    out = {
        "features": list(FAMILY_FEATURES[fam]),
        "means": [float(mu[i]) for i in range(nf)],
        "stds": [float(sd[i]) for i in range(nf)],
        "coef": core_coef,
        "intercept": float(b0),
        "type_offsets": type_off,
        "impute": imp,
        "lambda": lam,
        "n_pitches": int(len(y)),
        "n_pitchers": int(len(set(groups))),
    }
    top = sorted(zip(names[:nf], core_coef), key=lambda t: -abs(t[1]))[:10]
    print("  top standardized weights (runs/100 per SD):", ", ".join(f"{n} {c:+.2f}" for n, c in top))
    return out, meta


def main():
    rows = load_rows()
    print(f"{len(rows)} live pitches with shape")
    # handedness sign per pitcher (arm-side positive)
    by_p = defaultdict(list)
    for r in rows:
        by_p[(r["pitcher"], r["pitcher_team"])].append(r)
    for key, rs in by_p.items():
        throws = next((r["pitcher_throws"] for r in rs if r["pitcher_throws"]), None)
        rel = [r["rel_s"] for r in rs if r["rel_s"] is not None]
        sign = hand_sign(throws, float(np.median(rel)) if rel else None)
        for r in rs:
            r["sign"] = sign
    # primary fastball centroid per pitcher
    fb_ref = {}
    for key, rs in by_p.items():
        by_t = defaultdict(list)
        for r in rs:
            by_t[r["ptype"]].append(r)
        cents = [centroid(v, t) for t, v in by_t.items()]
        fb = core.pick_fastball(cents)
        if fb:
            fb_ref[key] = fb
    build_target(rows)

    model = {"version": "v3-college-xrv", "grade_mean": core.GRADE_MEAN, "grade_sd": core.GRADE_SD,
             "families": {}, "type_scale": {}, "family_of": FAMILY_OF}
    all_meta = []
    for fam in FAMILIES:
        fm, meta = fit_family(fam, rows, fb_ref)
        model["families"][fam] = fm
        all_meta += meta

    # Per-type scale from pitcher centroids (the population coaches compare)
    by_pt = defaultdict(list)
    for r in rows:
        if r["y"] is not None:
            by_pt[(r["pitcher"], r["pitcher_team"], r["ptype"])].append(r)
    preds = defaultdict(list)
    for (pitcher, team, pt), rs in by_pt.items():
        if len(rs) < MIN_CENTROID_N:
            continue
        sign = rs[0]["sign"]
        c = centroid(rs, pt)
        fb = fb_ref.get((pitcher, team))
        pred, _, _ = core.predict_xrv(to_entry(c, sign), to_entry(fb, sign) if fb else None, model)
        if pred is not None:
            preds[pt].append((pred, len(rs)))
    fam_pool = defaultdict(list)
    for pt, lst in preds.items():
        fam_pool[FAMILY_OF[pt]] += lst
    for pt in core.FAMILY_OF:
        lst = preds.get(pt, [])
        pool = lst if len(lst) >= 8 else fam_pool[FAMILY_OF[pt]]
        if len(lst) < 3:
            lst = pool
        if not lst:
            continue
        p = np.array([x for x, _ in lst])
        w = np.array([n for _, n in lst], float)
        mean = float(np.average(p, weights=w))
        pp = np.array([x for x, _ in pool])
        ww = np.array([n for _, n in pool], float)
        sd = float(math.sqrt(np.average((pp - np.average(pp, weights=ww)) ** 2, weights=ww)))
        model["type_scale"][pt] = {"mean": mean, "sd": max(sd, 0.25), "n_centroids": len(lst)}
    print("\nType scale (xRV runs/100 at 100, SD):",
          {k: (round(v["mean"], 2), round(v["sd"], 2), v["n_centroids"]) for k, v in model["type_scale"].items()})

    # Grade distribution over centroids
    print("\nGrade distribution by type (pitcher centroids, n>=10):")
    for pt in core.FAMILY_OF:
        gs = []
        for (pitcher, team, t), rs in by_pt.items():
            if t != pt or len(rs) < MIN_CENTROID_N:
                continue
            c = centroid(rs, pt)
            fb = fb_ref.get((pitcher, team))
            g, _, _ = core.score(to_entry(c, rs[0]["sign"]), to_entry(fb, rs[0]["sign"]) if fb else None, model)
            if g is not None:
                gs.append(g)
        if gs:
            q = np.percentile(gs, [5, 25, 50, 75, 95])
            print(f"  {pt:10s} n={len(gs):3d}  p5 {q[0]:.0f}  p25 {q[1]:.0f}  med {q[2]:.0f}  p75 {q[3]:.0f}  p95 {q[4]:.0f}")

    # WCL out-of-sample check: grade the summer centroids, correlate with whiff%
    print("\nWCL centroid corpus (fully out of sample; whiff% only):")
    wcl = load_wcl()
    by_key = defaultdict(list)
    for r in wcl:
        r["ptype"] = core.canon_type(r["pitch_type"])
        if r["ptype"] and r["velo"] is not None:
            for k in ("velo", "spin", "ivb", "hb", "ext", "rel_h", "rel_s", "whiff_pct"):
                r[k] = float(r[k]) if r[k] is not None else None
            r["n"] = r["pitch_count"] or 0
            by_key[(r["summer_player_id"], r["season"])].append(r)
    per_type = defaultdict(lambda: ([], []))
    for key, rs in by_key.items():
        sign = hand_sign(rs[0]["throws"], next((r["rel_s"] for r in rs if r["rel_s"] is not None), None))
        fb = core.pick_fastball(rs)
        for r in rs:
            if (r["n"] or 0) < 20 or r["whiff_pct"] is None:
                continue
            g, _, _ = core.score(to_entry(r, sign), to_entry(fb, sign) if fb else None, model)
            if g is not None:
                per_type[r["ptype"]][0].append(g)
                per_type[r["ptype"]][1].append(r["whiff_pct"])
    for pt, (g, w) in sorted(per_type.items(), key=lambda kv: -len(kv[1][0])):
        print(f"  {pt:10s} n={len(g):3d}  r(grade, whiff%)={wcorr(g, w):+.3f}  mean grade {np.mean(g):.0f}")

    if ANCHORS:
        print("\nAnchor arsenals:")
        wants = [a.strip().lower() for a in ANCHORS.split(",") if a.strip()]
        for (pitcher, team), rs in sorted(by_p.items()):
            if not any(w in pitcher.lower() for w in wants):
                continue
            by_t = defaultdict(list)
            for r in rs:
                by_t[r["ptype"]].append(r)
            fb = fb_ref.get((pitcher, team))
            sign = rs[0]["sign"]
            line = []
            for t, v in sorted(by_t.items(), key=lambda kv: -len(kv[1])):
                if len(v) < 2:
                    continue
                c = centroid(v, t)
                g, comps, xrv = core.score(to_entry(c, sign), to_entry(fb, sign) if fb else None, model)
                ys = [r["y"] for r in v if r["y"] is not None]
                sw = sum(1 for r in v if r["bucket"] in ("whiff", "foul", "inplay"))
                wh = sum(1 for r in v if r["bucket"] == "whiff")
                line.append(f"{t} n={len(v)} {c['velo']:.1f}mph ivb {c['ivb']:.1f} hb {c['hb'] * sign:+.1f} -> "
                            f"{g} (xRV {xrv:+.2f}; actual RV/100 {np.mean(ys):+.2f}, whiff {100 * wh / sw if sw else 0:.0f}%) {comps}")
            print(f"  {pitcher} ({team})")
            for l in line:
                print("     ", l)

    if EXPORT:
        with open(OUT_PATH, "w") as f:
            json.dump(model, f, indent=1)
        print(f"\nwrote {os.path.abspath(OUT_PATH)}")


if __name__ == "__main__":
    main()
