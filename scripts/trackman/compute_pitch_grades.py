"""Compute a Stuff+-style PITCH GRADE for every trackman_pitches row.

Approach (a small, honest "learning" model — no black box):

1. ESTIMATED VAA. We have no measured vertical approach angle, so we compute a
   location-neutral geometric estimate from release height, extension, velo and
   induced vertical break (IVB), evaluated at a fixed reference plate height.
   Fixing the crossing height removes pitch *location* from the metric (the
   thing the user wanted), leaving a pure shape/geometry VAA.

2. FEATURES, standardized WITHIN pitch type (so "good IVB" is judged against
   other pitches of the same type): velo, ivb, |hb|, spin, extension, est_vaa,
   |rel_side|, rel_height.

3. LEARNED WEIGHTS. Within each pitch family (fastball / breaking / offspeed /
   undefined) we fit a ridge regression of whiff% on those standardized
   features, weighted by pitch_count (a 60-pitch sample counts more than a
   5-pitch one). Ridge lambda is chosen by count-weighted 5-fold CV. The fitted
   linear predictor IS the stuff signal.

4. GRADE. The predictor is re-standardized within pitch type to mean 100,
   sd 25, so ~95% of pitches land 50-150 and 100 = average for that pitch type
   (Stuff+ convention). Whiff is the training target; whiff AND chase are used
   to VALIDATE (out-of-fold correlation).

Usage:
    PYTHONPATH=backend python3 scripts/trackman/compute_pitch_grades.py            # report only
    PYTHONPATH=backend python3 scripts/trackman/compute_pitch_grades.py --commit   # write pitch_grade + est_vaa
"""
import math
import sys
from statistics import NormalDist

import numpy as np

from app.models.database import get_connection

COMMIT = "--commit" in sys.argv
MIN_PITCHES = 5
Z_REF_FT = 2.4          # reference plate-crossing height (mid-zone) for VAA
GRADE_MEAN, GRADE_SD = 100.0, 25.0

# Gradeable pitch types. "Undefined" is intentionally excluded — it's an
# unclassified grab-bag, not a real pitch shape, so it neither grades nor appears
# on the leaderboard.
FAMILY = {
    "Four Seam": "FB", "Sinker": "FB", "Cutter": "FB",
    "Slider": "BB", "Curveball": "BB",
    "Changeup": "OFF", "Splitter": "OFF",
}
# rel_height is intentionally excluded: est_vaa is computed from it (+ ivb/velo/
# ext), so keeping both creates severe multicollinearity and unstable weights.
# Separation features (vs the pitcher's own fastball) encode the domain rules:
#   velo_sep  — offspeed wants velo gap; sinker/cutter want SMALL gap (bridge).
#   ivb_sep   — changeup/splitter want big IVB drop vs the FB ("kill ride").
#   mov_sep   — cutter bridges, breaking balls should DIVERGE from the FB plane
#               (avoid predictable, in-line shapes).
FEATURES = ["velo", "ivb", "hb_abs", "spin", "extension", "est_vaa", "rel_side_abs",
            "velo_sep", "ivb_sep", "mov_sep"]
FB_TYPES = {"Four Seam", "Sinker", "Cutter"}

# Domain PRIORS (coefficient in z-target per z-feature units). The ridge shrinks
# toward THESE instead of toward zero, so known-but-noisy effects (spin & velo
# matter, especially on breaking balls; spin is killed on offspeed) survive even
# when the small-sample whiff/chase data is too weak to learn them. CV decides
# how much the data is allowed to override the prior.
PRIORS = {
    "Four Seam": {"velo": 0.10, "spin": 0.10, "ivb": 0.08, "est_vaa": 0.07},
    "Sinker":    {"velo": 0.05, "spin": 0.07, "ivb": -0.06, "hb_abs": 0.06, "ivb_sep": 0.06},
    "Cutter":    {"velo": 0.10, "spin": 0.06, "mov_sep": 0.10},
    "Slider":    {"velo": 0.11, "spin": 0.16, "hb_abs": 0.08, "mov_sep": 0.06},
    "Curveball": {"velo": 0.13, "spin": 0.18, "mov_sep": 0.06, "ivb": -0.06},
    "Changeup":  {"velo_sep": 0.12, "ivb_sep": 0.10, "spin": -0.12, "mov_sep": 0.05},
    "Splitter":  {"velo_sep": 0.10, "ivb_sep": 0.10, "spin": -0.12},
}


def prior_vec(pt):
    p = PRIORS.get(pt, {})
    return np.array([p.get(f, 0.0) for f in FEATURES], float)
# cv_r at/above which a pitch type earns FULL grade spread. Set low so every
# type with real (CV-positive) signal gets the same spread — that keeps the
# cross-type leaderboard fair (no type dominates the top just because its model
# happened to validate a bit higher). Only near-dead or tiny-sample types
# compress (the latter via the n/60 reliability factor below).
SHRINK_TARGET = 0.12


def estimate_vaa(velo, ext, rel_height, ivb):
    """Geometric vertical approach angle (degrees, negative = downward) at a
    fixed mid-zone crossing height. Constant-acceleration trajectory: IVB sets
    the Magnus vertical accel, gravity does the rest, solve for the release
    vertical velocity that crosses Z_REF_FT, then read the angle at the plate."""
    if None in (velo, ext, rel_height, ivb):
        return None
    v0 = float(velo) * 1.4667                 # mph -> ft/s
    if v0 <= 0:
        return None
    y0 = 60.5 - float(ext)                     # release distance to plate tip (ft)
    vy = 0.955 * v0                            # avg horizontal speed (≈ -9% drag over flight)
    t = y0 / vy
    a_magnus = 2.0 * (float(ivb) / 12.0) / (t * t)   # ft/s^2 from IVB (in -> ft)
    a_z = -32.17 + a_magnus
    dz = Z_REF_FT - float(rel_height)
    vz0 = (dz - 0.5 * a_z * t * t) / t
    vz_plate = vz0 + a_z * t
    vy_plate = 0.92 * v0                       # horizontal speed near the plate
    return math.degrees(math.atan2(vz_plate, vy_plate))


def wmean(x, w):
    return float(np.average(x, weights=w)) if len(x) else 0.0


def wstd(x, w):
    m = wmean(x, w)
    v = float(np.average((x - m) ** 2, weights=w))
    return math.sqrt(v) if v > 0 else 1.0


def wcorr(x, y, w):
    if len(x) < 3:
        return float("nan")
    mx, my = wmean(x, w), wmean(y, w)
    cov = np.average((x - mx) * (y - my), weights=w)
    vx = np.average((x - mx) ** 2, weights=w)
    vy = np.average((y - my) ** 2, weights=w)
    if vx <= 0 or vy <= 0:
        return float("nan")
    return float(cov / math.sqrt(vx * vy))


def ridge_fit(X, y, w, lam, b0=None):
    """Weighted ridge on already weighted-centered X, y, shrinking the slope
    coefficients toward prior b0 (default zero). Returns coef vector."""
    W = np.diag(w)
    A = X.T @ W @ X + lam * np.eye(X.shape[1])
    b = X.T @ W @ y
    if b0 is not None:
        b = b + lam * b0
    return np.linalg.solve(A, b)


def cv_lambda(X, y, w, grid, b0=None, folds=5):
    """Pick lambda by count-weighted k-fold out-of-fold correlation."""
    n = len(y)
    rng = np.arange(n)
    fold_id = rng % folds
    best_lam, best_r = grid[0], -1e9
    for lam in grid:
        preds = np.zeros(n)
        for f in range(folds):
            tr, te = fold_id != f, fold_id == f
            if tr.sum() < X.shape[1] + 2 or te.sum() == 0:
                continue
            mx = np.average(X[tr], axis=0, weights=w[tr])
            my = wmean(y[tr], w[tr])
            coef = ridge_fit(X[tr] - mx, y[tr] - my, w[tr], lam, b0)
            preds[te] = (X[te] - mx) @ coef + my
        r = wcorr(preds, y, w)
        if not math.isnan(r) and r > best_r:
            best_r, best_lam = r, lam
    return best_lam, best_r


def main():
    with get_connection() as conn:
        _run(conn)


def _run(conn):
    cur = conn.cursor()
    cur.execute(
        """SELECT id, summer_player_id, season, pitch_type, pitch_count, velo, spin,
                  ivb, hb, extension, rel_height, rel_side, whiff_pct, chase_pct
           FROM trackman_pitches"""
    )
    rows = [dict(r) for r in cur.fetchall()]

    # Per-pitcher primary fastball REFERENCE SHAPE (velo, ivb, hb) so we can
    # derive separation features. Prefer Four Seam, else any FB-family, else the
    # most-thrown pitch; tie-break on pitch_count.
    from collections import defaultdict
    by_pitcher = defaultdict(list)
    for r in rows:
        if r["velo"] is not None:
            by_pitcher[(r["summer_player_id"], r["season"])].append(r)
    fb_ref = {}
    for key, rs in by_pitcher.items():
        fbs = [r for r in rs if r["pitch_type"] in FB_TYPES]
        pool = fbs if fbs else rs
        best = max(pool, key=lambda r: (r["pitch_type"] == "Four Seam",
                                        r["pitch_type"] in FB_TYPES, r["pitch_count"] or 0))
        fb_ref[key] = best

    # Feature build + est_vaa for every row that has the physical inputs.
    gradeable = []
    for r in rows:
        r["est_vaa"] = estimate_vaa(r["velo"], r["extension"], r["rel_height"], r["ivb"])
        feats_ok = all(r.get(k) is not None for k in
                       ("velo", "ivb", "hb", "spin", "extension", "rel_height")) and r["est_vaa"] is not None
        r["_ok"] = feats_ok and (r["pitch_count"] or 0) >= MIN_PITCHES and r["pitch_type"] in FAMILY
        if r["_ok"]:
            r["hb_abs"] = abs(float(r["hb"]))
            r["rel_side_abs"] = abs(float(r["rel_side"])) if r["rel_side"] is not None else 0.0
            for k in ("velo", "ivb", "spin", "extension", "rel_height"):
                r[k] = float(r[k])
            fb = fb_ref.get((r["summer_player_id"], r["season"]))
            fb_velo = float(fb["velo"]) if fb and fb["velo"] is not None else r["velo"]
            fb_ivb = float(fb["ivb"]) if fb and fb["ivb"] is not None else r["ivb"]
            fb_hb = float(fb["hb"]) if fb and fb["hb"] is not None else float(r["hb"])
            r["velo_sep"] = fb_velo - r["velo"]
            r["ivb_sep"] = fb_ivb - r["ivb"]
            r["mov_sep"] = math.hypot(r["ivb"] - fb_ivb, float(r["hb"]) - fb_hb)
            gradeable.append(r)

    # Standardize each feature WITHIN pitch type.
    types = sorted({r["pitch_type"] for r in gradeable})
    norm = {}  # (ptype, feat) -> (mean, std) count-weighted
    for pt in types:
        sub = [r for r in gradeable if r["pitch_type"] == pt]
        w = np.array([r["pitch_count"] for r in sub], float)
        for f in FEATURES:
            x = np.array([r[f] for r in sub], float)
            norm[(pt, f)] = (wmean(x, w), wstd(x, w))
    for r in gradeable:
        r["_z"] = np.array([(r[f] - norm[(r["pitch_type"], f)][0]) / norm[(r["pitch_type"], f)][1]
                            for f in FEATURES], float)

    # Training target = a "stuff outcome" composite of whiff% and chase%, each
    # standardized within pitch type then averaged. Using BOTH bat-missing
    # signals denoises the target and rescues pitch types (e.g. curveballs) that
    # generate outs via chase below the zone more than via in-zone whiffs.
    for pt in types:
        sub = [r for r in gradeable if r["pitch_type"] == pt]
        w = np.array([r["pitch_count"] for r in sub], float)
        for col in ("whiff_pct", "chase_pct"):
            idx = [i for i, r in enumerate(sub) if r[col] is not None]
            if len(idx) >= 5:
                vals = np.array([float(sub[i][col]) for i in idx])
                ww = w[idx]
                m, s = wmean(vals, ww), wstd(vals, ww)
                for i in idx:
                    sub[i]["_z_" + col] = (float(sub[i][col]) - m) / s
    for r in gradeable:
        zs = [r[k] for k in ("_z_whiff_pct", "_z_chase_pct") if k in r]
        r["_target"] = float(np.mean(zs)) if zs else None

    # Fit a SEPARATE model PER PITCH TYPE. Two ways each pitch is unique:
    #   (1) coefficients — a four-seam and a sinker miss bats by opposite shapes;
    #   (2) the OUTCOME that signals "stuff" — fastballs do it via in-zone whiff,
    #       curveballs more via chase below the zone. So each type picks its own
    #       training target (whiff / chase / both) by cross-validation.
    # Ridge + CV'd lambda regularizes small-sample types toward a flat ~100.
    grid = [3, 10, 30, 100, 300, 1000, 3000]
    shrink = {}
    targets = {"whiff": "_z_whiff_pct", "chase": "_z_chase_pct", "stuff": "_target"}
    print(f"{'pitch_type':<11} {'n':>5} {'target':>7} {'lambda':>7} {'cv_r':>7} {'shrink':>7}   top weights")
    for pt in types:
        members = [r for r in gradeable if r["pitch_type"] == pt]
        b0 = prior_vec(pt)
        best = None  # (cv_r, target_name, lam, coef, mx, my)
        for tname, tkey in targets.items():
            tr = [r for r in members if r.get(tkey) is not None]
            if len(tr) < 20:
                continue
            X = np.array([r["_z"] for r in tr])
            y = np.array([r[tkey] for r in tr])
            w = np.array([r["pitch_count"] for r in tr], float)
            lam, cv_r = cv_lambda(X, y, w, grid, b0)
            if best is None or cv_r > best[0]:
                mx = np.average(X, axis=0, weights=w)
                my = wmean(y, w)
                coef = ridge_fit(X - mx, y - my, w, lam, b0)
                best = (cv_r, tname, lam, coef, mx, my, len(tr))
        if best is None:
            for r in members:
                r["_pred"] = 0.0
            shrink[pt] = 0.0
            print(f"{pt:<11} {len(members):>5}   (too few to fit — flat 100)")
            continue
        cv_r, tname, lam, coef, mx, my, ntr = best
        for r in members:
            r["_pred"] = float((r["_z"] - mx) @ coef + my)
        # Confidence = CV predictiveness, discounted by sample size so a tiny-n
        # type (e.g. 21 splitters) can't earn full grade spread off a lucky CV.
        reliability = min(1.0, ntr / 60.0)
        shrink[pt] = max(0.0, min(1.0, cv_r / SHRINK_TARGET)) * reliability
        short = {"hb_abs": "|hb|", "extension": "ext", "est_vaa": "vaa", "rel_side_abs": "|rs|",
                 "velo_sep": "vsep", "ivb_sep": "isep", "mov_sep": "msep"}
        top = sorted(zip(FEATURES, coef), key=lambda kv: -abs(kv[1]))
        wtxt = " ".join(f"{short.get(f, f)}{c:+.2f}" for f, c in top)
        print(f"{pt:<11} {ntr:>5} {tname:>7} {lam:>6.0f} {cv_r:>6.3f} {shrink[pt]:>5.2f}  {wtxt}")

    # Grade = predictor RANK-normalized within pitch type to an identical bell
    # curve (mean 100, sd 25), then scaled by the type's CV confidence. Using the
    # rank (not raw mean/sd) gives every pitch type the SAME grade distribution —
    # no type's skew or variance can flood the cross-type leaderboard — while the
    # confidence shrink keeps low-signal types (curveball) from promoting noise.
    nd = NormalDist()
    for pt in types:
        sub = [r for r in gradeable if r["pitch_type"] == pt]
        n = len(sub)
        order = sorted(range(n), key=lambda i: sub[i]["_pred"])
        for rank, i in enumerate(order):
            pctl = min(0.9995, max(0.0005, (rank + 0.5) / n))
            g = GRADE_MEAN + GRADE_SD * shrink[pt] * nd.inv_cdf(pctl)
            sub[i]["pitch_grade"] = round(max(20.0, min(180.0, g)), 1)

    # ---- Validation ----
    allr = gradeable
    g = np.array([r["pitch_grade"] for r in allr])
    w = np.array([r["pitch_count"] for r in allr], float)
    wh = np.array([float(r["whiff_pct"]) if r["whiff_pct"] is not None else np.nan for r in allr])
    ch = np.array([float(r["chase_pct"]) if r["chase_pct"] is not None else np.nan for r in allr])
    print("\n=== validation (count-weighted Pearson r) ===")
    mwh = ~np.isnan(wh)
    mch = ~np.isnan(ch)
    print(f"  grade vs whiff : {wcorr(g[mwh], wh[mwh], w[mwh]):.3f}  (n={mwh.sum()})")
    print(f"  grade vs chase : {wcorr(g[mch], ch[mch], w[mch]):.3f}  (n={mch.sum()})")
    print("  per pitch type (grade vs whiff):")
    for pt in types:
        idx = [i for i, r in enumerate(allr) if r["pitch_type"] == pt and r["whiff_pct"] is not None]
        if len(idx) >= 5:
            ii = np.array(idx)
            print(f"    {pt:<10} r={wcorr(g[ii], wh[ii], w[ii]):+.3f}  n={len(idx)}  "
                  f"grade {min(r['pitch_grade'] for r in allr if r['pitch_type']==pt):.0f}-"
                  f"{max(r['pitch_grade'] for r in allr if r['pitch_type']==pt):.0f}")

    if COMMIT:
        cur.execute("ALTER TABLE trackman_pitches ADD COLUMN IF NOT EXISTS pitch_grade numeric")
        cur.execute("ALTER TABLE trackman_pitches ADD COLUMN IF NOT EXISTS est_vaa numeric")
        cur.execute("UPDATE trackman_pitches SET pitch_grade = NULL")  # clear stale (e.g. now <5)
        n = 0
        for r in gradeable:
            cur.execute(
                "UPDATE trackman_pitches SET pitch_grade=%s, est_vaa=%s WHERE id=%s",
                (r["pitch_grade"], round(r["est_vaa"], 2), r["id"]),
            )
            n += 1
        # est_vaa for sub-5 rows too (harmless, useful), grade stays null
        for r in rows:
            if not r["_ok"] and r["est_vaa"] is not None:
                cur.execute("UPDATE trackman_pitches SET est_vaa=%s WHERE id=%s",
                            (round(r["est_vaa"], 2), r["id"]))
        conn.commit()
        print(f"\nCOMMITTED pitch_grade for {n} rows (>= {MIN_PITCHES} pitches).")
    else:
        print(f"\nDRY RUN — {len(gradeable)} gradeable rows. Re-run with --commit to write.")


if __name__ == "__main__":
    main()
