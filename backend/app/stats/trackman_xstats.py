"""Expected-stats surfaces for TrackMan batted-ball data.

xBA / xTB / xwOBAcon as functions of exit velocity and launch angle,
via a compact lookup grid with bilinear interpolation. The grid encodes
the well-established Statcast-shaped contact-value surface (hits live in
the 10-30 degree sweet spot and scale hard with EV; grounders cap out as
singles; popups die regardless of EV). Values are RELATIVE contact
quality applied to college EV/LA — we present them as expected stats
"based on how the ball was hit," not as a claim about MLB equivalence.

Used by the Hitter Lab: per-PA outcomes fold together as
  xAVG   = sum(xBA over BIP) / AB                (K counts as 0-for-1)
  xSLG   = sum(xTB over BIP) / AB
  xwOBA  = (0.69*BB + 0.72*HBP + sum(xwOBAcon)) / (AB + BB + HBP + SF)
Untracked balls in play (no EV/LA) fall back to their ACTUAL outcome
value so partial tracking never silently deflates a hitter.
"""

# Grid axes
EV_AXIS = [60, 70, 80, 85, 90, 95, 100, 105, 110]           # mph
LA_AXIS = [-30, -10, 0, 10, 20, 30, 40, 50, 70]             # degrees

# xBA by [ev][la]
XBA = [
    # -30    -10     0     10     20     30     40     50     70
    [0.05,  0.15,  0.30,  0.45,  0.30,  0.10,  0.03,  0.01,  0.00],   # 60
    [0.08,  0.20,  0.38,  0.55,  0.45,  0.15,  0.04,  0.01,  0.00],   # 70
    [0.10,  0.24,  0.42,  0.55,  0.38,  0.12,  0.04,  0.01,  0.00],   # 80
    [0.12,  0.26,  0.45,  0.55,  0.38,  0.15,  0.05,  0.01,  0.00],   # 85
    [0.14,  0.28,  0.48,  0.60,  0.48,  0.25,  0.08,  0.02,  0.00],   # 90
    [0.16,  0.32,  0.52,  0.68,  0.62,  0.45,  0.18,  0.05,  0.01],   # 95
    [0.18,  0.36,  0.56,  0.76,  0.78,  0.68,  0.40,  0.12,  0.02],   # 100
    [0.20,  0.40,  0.60,  0.82,  0.90,  0.85,  0.60,  0.25,  0.05],   # 105
    [0.22,  0.42,  0.64,  0.86,  0.95,  0.93,  0.75,  0.40,  0.08],   # 110
]

# xTB (expected total bases) by [ev][la]
XTB = [
    [0.05,  0.16,  0.32,  0.50,  0.35,  0.12,  0.04,  0.01,  0.00],   # 60
    [0.08,  0.21,  0.40,  0.62,  0.55,  0.20,  0.05,  0.01,  0.00],   # 70
    [0.10,  0.25,  0.45,  0.65,  0.52,  0.18,  0.05,  0.01,  0.00],   # 80
    [0.13,  0.28,  0.48,  0.68,  0.58,  0.25,  0.08,  0.02,  0.00],   # 85
    [0.15,  0.30,  0.52,  0.78,  0.80,  0.50,  0.15,  0.04,  0.00],   # 90
    [0.17,  0.34,  0.56,  0.92,  1.15,  1.00,  0.45,  0.12,  0.02],   # 95
    [0.19,  0.38,  0.62,  1.10,  1.70,  1.80,  1.20,  0.35,  0.05],   # 100
    [0.21,  0.42,  0.68,  1.30,  2.40,  2.70,  2.10,  0.80,  0.15],   # 105
    [0.23,  0.45,  0.72,  1.50,  3.00,  3.30,  2.80,  1.40,  0.25],   # 110
]


def _interp(grid, ev, la):
    ev = max(EV_AXIS[0], min(EV_AXIS[-1], ev))
    la = max(LA_AXIS[0], min(LA_AXIS[-1], la))
    i = max(0, min(len(EV_AXIS) - 2, next(k for k in range(len(EV_AXIS) - 1) if ev <= EV_AXIS[k + 1])))
    j = max(0, min(len(LA_AXIS) - 2, next(k for k in range(len(LA_AXIS) - 1) if la <= LA_AXIS[k + 1])))
    tx = (ev - EV_AXIS[i]) / (EV_AXIS[i + 1] - EV_AXIS[i])
    ty = (la - LA_AXIS[j]) / (LA_AXIS[j + 1] - LA_AXIS[j])
    a = grid[i][j] * (1 - ty) + grid[i][j + 1] * ty
    b = grid[i + 1][j] * (1 - ty) + grid[i + 1][j + 1] * ty
    return a * (1 - tx) + b * tx


# ── College calibration layer ────────────────────────────────────
# The grids above encode the Statcast-SHAPED surface, but MLB gloves
# turn far more batted balls into outs than college defenses do —
# audited on 1,168 college BBE with outcomes (Bushnell corpus,
# 2026-08): the raw grid predicted .347 on contact vs .360 actual,
# and badly underpredicted soft contact (<80 mph: .174 predicted vs
# .244 actual — bloops and choppers become hits in this league).
# Fix: Platt-style logistic recalibration fit on those labeled BBE,
#   p_college = sigmoid(A + B * logit(p_grid) + C * (EV - 90) / 10)
# The negative EV term flattens the surface (metal bats + weaker
# defenses compress the EV effect). xTB scales by the same hit-prob
# ratio so the extra-base mix is preserved.
# REFIT when much more labeled data accrues: rerun the fit in the
# 2026-08-19 session notes (Newton logistic on [1, logit(grid), EV]).
import math as _math

CAL_A, CAL_B, CAL_C = 0.0484, 1.1007, -0.2190


def _calibrate(p_grid, ev):
    p = max(0.005, min(0.98, p_grid))
    z = CAL_A + CAL_B * _math.log(p / (1 - p)) + CAL_C * (ev - 90) / 10.0
    return 1.0 / (1.0 + _math.exp(-z))


def xba(ev, la):
    return _calibrate(_interp(XBA, ev, la), ev)


def xtb(ev, la):
    raw_ba = _interp(XBA, ev, la)
    raw_tb = _interp(XTB, ev, la)
    ratio = _calibrate(raw_ba, ev) / max(raw_ba, 1e-6)
    return raw_tb * ratio


def xwobacon(ev, la):
    """Contact wOBA from the xBA/xTB surfaces using linear weights
    (0.89 1B, 1.27 2B, 1.62 3B, 2.10 HR). Approximated from xBA and
    xTB: extra bases beyond first are valued at the marginal weights."""
    ba = xba(ev, la)
    tb = xtb(ev, la)
    extra = max(0.0, tb - ba)  # expected bases beyond singles
    return 0.89 * ba + 0.40 * extra


# Actual-outcome fallbacks for untracked balls in play
RESULT_BA = {"Single": 1, "Double": 1, "Triple": 1, "HomeRun": 1}
RESULT_TB = {"Single": 1, "Double": 2, "Triple": 3, "HomeRun": 4}
RESULT_WOBA = {"Single": 0.89, "Double": 1.27, "Triple": 1.62, "HomeRun": 2.10}


def batter_xstats(pas):
    """Fold per-PA outcomes into expected stats.

    Each PA dict: {outcome: 'K'|'BB'|'HBP'|'InPlay'|'Sac'|'Other',
                   ev, la, play_result}. Returns None without 20+ PAs.
    """
    ab = bb = hbp = sf = pa_n = 0
    s_xba = s_xtb = s_xwc = 0.0
    hits = tb_actual = 0
    tracked = bip = 0
    for p in pas:
        o = p["outcome"]
        if o == "Other":
            continue
        pa_n += 1
        if o == "BB":
            bb += 1
            continue
        if o == "HBP":
            hbp += 1
            continue
        if o == "Sac":
            sf += 1
            # sac flies keep their contact value in xwOBA's denominator
            if p.get("ev") is not None and p.get("la") is not None:
                s_xwc += xwobacon(p["ev"], p["la"])
                tracked += 1
            bip += 1
            continue
        ab += 1
        if o == "K":
            continue
        # ball in play
        bip += 1
        pr = p.get("play_result")
        if p.get("ev") is not None and p.get("la") is not None:
            s_xba += xba(p["ev"], p["la"])
            s_xtb += xtb(p["ev"], p["la"])
            s_xwc += xwobacon(p["ev"], p["la"])
            tracked += 1
        else:  # untracked: use the actual outcome so coverage gaps don't bias
            s_xba += RESULT_BA.get(pr, 0)
            s_xtb += RESULT_TB.get(pr, 0)
            s_xwc += RESULT_WOBA.get(pr, 0.0)
        hits += RESULT_BA.get(pr, 0)
        tb_actual += RESULT_TB.get(pr, 0)

    if pa_n < 20 or ab == 0:
        return None
    denom = ab + bb + hbp + sf
    return {
        "pa": pa_n, "ab": ab, "bb": bb, "hbp": hbp,
        "avg": round(hits / ab, 3),
        "xavg": round(s_xba / ab, 3),
        "slg": round(tb_actual / ab, 3),
        "xslg": round(s_xtb / ab, 3),
        "xwoba": round((0.69 * bb + 0.72 * hbp + s_xwc) / denom, 3),
        "tracked_bip": tracked, "bip": bip,
        "coverage_pct": round(100 * tracked / bip, 1) if bip else None,
    }
