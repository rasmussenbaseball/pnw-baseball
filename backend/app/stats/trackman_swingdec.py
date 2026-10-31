"""Swing decision model (SD+) for the TrackMan Suite.

Every pitch a hitter sees is a choice between two expected run values:

  take_rv  = p_cs * RV(strike | count) + (1 - p_cs) * RV(ball | count)
  swing_rv = p_whiff * RV(strike | count) + p_foul * RV(foul | count)
           + p_inplay * (RV_contact - RV(count))

p_cs is the called-strike probability at that location for that batter
side (fit on the coach's umpired takes; the fixed TrackMan zone on
intrasquads). The swing outcome probabilities and the contact run value
are kernel-smoothed maps over plate location, split by pitch family
(fastball / breaking / offspeed), two-strike flag and platoon matchup,
each map shrunk toward its pooled family map and then toward the corpus.
Velocity enters as a one-parameter logistic shift on whiff probability
within a family. Count enters through the Tango run-value ladder, so a
3-0 take and an 0-2 take are priced very differently.

The decision value of a pitch is the run value of what the hitter did
minus what the league's own swing policy would have earned on that
pitch (league swing probability at that location and count group times
swing_rv, plus the complement times take_rv). That makes the league
average zero by construction and credits a hitter for swinging at
hittable pitches more often than his peers and for laying off pitches
they chase. "Correct" is the side of max(swing_rv, take_rv) within a
small tolerance; "regret" is chosen minus best.

SD+ = 100 + 10 x (shrunk decision runs per 100 pitches) / (SD across the
corpus's qualified hitters). 100 is the average bat in the coach's data,
10 points is one standard deviation. Shrinkage is n / (n + 150) pitches.

This is the Driveline / Swing+ 2.0 / TJStats family of models (swing
value vs take value per pitch, judged against the better option or the
league policy) with Savant's count ladder, built on the ~10k live pitches
a college unit produces in a fall rather than Statcast volume, hence the
kernel smoothing and the hierarchical shrinkage instead of boosted trees.
All probabilities are LEAGUE contact ability: SD+ asks whether the
decision was right for an average bat in this corpus, not whether this
hitter's own bat would have cashed it.
"""
import math
import numpy as np

from .trackman_runvalue import COUNT_RV, TERMINAL_RV, pitch_run_value
from .trackman_xstats import xwobacon

# grid over the plate: x in [-2, 2] (batter-relative, + = inside), z in [0, 5]
GX0, GX1, GZ0, GZ1, CELL = -2.0, 2.0, 0.0, 5.0, 0.1
NX, NZ = int(round((GX1 - GX0) / CELL)), int(round((GZ1 - GZ0) / CELL))
HALF_W, Z_LO, Z_HI = 0.83, 1.5, 3.5

FAMILY = {"Fastball": "fb", "Four-Seam": "fb", "Four Seam": "fb", "Sinker": "fb", "Cutter": "fb",
          "Slider": "br", "Sweeper": "br", "Curveball": "br", "Knuckle Curve": "br", "Slurve": "br",
          "ChangeUp": "os", "Changeup": "os", "Splitter": "os"}
FAMILIES = ("fb", "br", "os")
COUNT_GROUPS = ("first", "ahead", "even", "behind", "two_k")
SHRINK_PITCHES = 150.0       # batter-level: n / (n + 150)
SHRINK_COUNT = 40.0          # per-count rows
CORRECT_TOL = 0.015          # runs: inside this the two options are a coin flip
HITTABLE_GAP = 0.02          # swing_rv - take_rv above this = a hittable pitch

_STRIKES = {"StrikeCalled", "StrikeSwinging", "AutomaticStrike"}
_FOULS = {"FoulBall", "FoulBallFieldable", "FoulBallNotFieldable"}


def _fam(ptype):
    return FAMILY.get(ptype or "", "fb" if not ptype else None)


def _count_group(b, s):
    if b == 0 and s == 0:
        return "first"
    if s == 2:
        return "two_k"
    if b > s:
        return "ahead"
    if s > b:
        return "behind"
    return "even"


def _xrel(px, side):
    """Batter-relative horizontal: + = toward the hitter (inside).
    TrackMan +side is toward the right-handed box."""
    return px if side == "Right" else -px


def _cell(xr, pz):
    i = int((xr - GX0) / CELL)
    j = int((pz - GZ0) / CELL)
    return min(max(i, 0), NX - 1), min(max(j, 0), NZ - 1)


def _gauss_kernel(sigma_ft):
    r = int(math.ceil(3 * sigma_ft / CELL))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) * CELL / sigma_ft) ** 2)
    return k / k.sum()


def _smooth(grid, sigma_ft):
    """Separable Gaussian smoothing with edge renormalisation."""
    k = _gauss_kernel(sigma_ft)
    r = len(k) // 2
    pad = np.pad(grid, ((r, r), (r, r)), mode="constant")
    tmp = np.zeros_like(pad)
    for d, w in enumerate(k):
        tmp[r:-r, :] += w * pad[d:d + grid.shape[0], :]
    out = np.zeros_like(grid)
    for d, w in enumerate(k):
        out += w * tmp[r:-r, d:d + grid.shape[1]]
    return out


class RateMap:
    """num/den grid -> smoothed rate with a prior map (or scalar) and weight k."""

    def __init__(self, sigma, k):
        self.sigma, self.k = sigma, k
        self.num = np.zeros((NX, NZ))
        self.den = np.zeros((NX, NZ))
        self.rate = None

    def add(self, xr, pz, y, w=1.0):
        i, j = _cell(xr, pz)
        self.num[i, j] += w * y
        self.den[i, j] += w

    def fit(self, prior):
        ns, ds = _smooth(self.num, self.sigma), _smooth(self.den, self.sigma)
        pr = prior if isinstance(prior, np.ndarray) else np.full((NX, NZ), float(prior))
        self.rate = (ns + self.k * pr) / (ds + self.k)
        self.support = ds
        return self

    def at(self, xr, pz):
        i, j = _cell(xr, pz)
        return float(self.rate[i, j])

    def total_rate(self, fallback=0.0):
        return float(self.num.sum() / self.den.sum()) if self.den.sum() > 0 else fallback


def _rulebook_cs(xr, pz, scale):
    """Called-strike probability from the rulebook box with a logistic edge."""
    dx = abs(xr) - HALF_W
    dz = max(Z_LO - pz, pz - Z_HI)
    ox, oz = max(dx, 0.0), max(dz, 0.0)
    d = math.hypot(ox, oz) if (ox > 0 or oz > 0) else max(dx, dz)
    return 1.0 / (1.0 + math.exp((d - 0.11) / scale))     # 50/50 about 1.3 in outside


def contact_rv(row):
    """Run value of a ball in play relative to an average PA: the xwOBAcon
    model where the ball was tracked, the scored result otherwise."""
    ev, la = row.get("exit_speed"), row.get("launch_angle")
    if ev is not None and la is not None:
        xw = xwobacon(float(ev), float(la), row.get("direction"), (row.get("batter_side") or "")[:1] or None)
        return -0.26 + 0.79 * xw          # linear-weight fit: out -.26 ... HR 1.40
    v = TERMINAL_RV.get(row.get("play_result") or "")
    return v if v is not None else -0.10  # untagged ball in play: a little worse than average


class SwingDecisionModel:
    def __init__(self):
        self.cs = {}          # batter side -> RateMap (umpired takes)
        self.cs_grid_rule = {}
        self.swing = {}       # count group -> RateMap of league swing probability
        self.out = {}         # (fam, two_k, matchup) -> {"whiff": RateMap, "foul": RateMap, "con": RateMap}
        self.out_pool = {}    # (fam, two_k) pooled across matchups
        self.velo = {}        # fam -> (mean, sd, beta)
        self.count_base = {}  # (b, s) -> league swing/chase/whiff rates
        self.n_fit = 0
        self.dv_base = 0.0    # corpus mean raw decision value per pitch (centering)
        self.sigma = None     # SD of shrunk DV/100 across qualified hitters
        self.sigma_count = {} # (b, s) -> SD of shrunk per-count DV/100

    # ── fitting ──
    def fit(self, rows):
        rows = [r for r in rows if r.get("plate_loc_side") is not None and r.get("plate_loc_height") is not None
                and r.get("balls") is not None and r.get("strikes") is not None and r.get("pitch_call")]
        self.n_fit = len(rows)
        rule_grid = {}
        for side in ("Right", "Left"):
            g = np.zeros((NX, NZ))
            for i in range(NX):
                for j in range(NZ):
                    g[i, j] = _rulebook_cs(GX0 + (i + 0.5) * CELL, GZ0 + (j + 0.5) * CELL, 0.175)
            rule_grid[side] = g
            self.cs[side] = RateMap(sigma=0.2, k=8)
        for g in COUNT_GROUPS:
            self.swing[g] = RateMap(sigma=0.25, k=20)
        for fam in FAMILIES:
            for tk in (False, True):
                self.out_pool[(fam, tk)] = {k: RateMap(sigma=0.3, k=15) for k in ("whiff", "foul", "con")}
                for mu in ("same", "opp"):
                    self.out[(fam, tk, mu)] = {k: RateMap(sigma=0.3, k=25) for k in ("whiff", "foul", "con")}
        velo_pts = {f: [] for f in FAMILIES}
        cb = {}
        for r in rows:
            side = r.get("batter_side") or "Right"
            xr, pz = _xrel(float(r["plate_loc_side"]), side), float(r["plate_loc_height"])
            b, s = int(r["balls"]), int(r["strikes"])
            call = r["pitch_call"]
            swung = bool(r.get("is_swing"))
            fam = _fam(r.get("ptype"))
            # called strike map: umpired takes only
            if call in ("StrikeCalled", "BallCalled") and r.get("session_type") in ("game", "scrimmage"):
                self.cs[side].add(xr, pz, 1.0 if call == "StrikeCalled" else 0.0)
            # league swing policy
            self.swing[_count_group(b, s)].add(xr, pz, 1.0 if swung else 0.0)
            # per-count baselines
            c = cb.setdefault((b, s), {"n": 0, "sw": 0, "oz": 0, "ch": 0, "wh": 0})
            c["n"] += 1; c["sw"] += swung
            if r.get("is_in_zone") is False:
                c["oz"] += 1; c["ch"] += 1 if r.get("is_chase") else 0
            if swung:
                c["wh"] += 1 if r.get("is_whiff") else 0
            # swing outcomes
            if swung and fam:
                tk = s == 2
                mu = "same" if (r.get("pitcher_throws") or "Right") == side else "opp"
                whiff = call == "StrikeSwinging" or bool(r.get("is_whiff"))
                foul = call in _FOULS
                inplay = call == "InPlay"
                if not (whiff or foul or inplay):
                    continue
                for store in (self.out[(fam, tk, mu)], self.out_pool[(fam, tk)]):
                    store["whiff"].add(xr, pz, 1.0 if whiff else 0.0)
                    store["foul"].add(xr, pz, 1.0 if foul else 0.0)
                    if inplay:
                        store["con"].add(xr, pz, contact_rv(r))
                if r.get("rel_speed") is not None:
                    velo_pts[fam].append((float(r["rel_speed"]), 1.0 if whiff else 0.0, xr, pz, tk, mu))
        for side in ("Right", "Left"):
            self.cs[side].fit(rule_grid[side])
            self.cs_grid_rule[side] = rule_grid[side]
        for g in COUNT_GROUPS:
            self.swing[g].fit(self.swing[g].total_rate(0.45))
        for fam in FAMILIES:
            for tk in (False, True):
                pool = self.out_pool[(fam, tk)]
                pool["whiff"].fit(pool["whiff"].total_rate(0.25))
                pool["foul"].fit(pool["foul"].total_rate(0.35))
                pool["con"].fit(pool["con"].total_rate(0.0))
                for mu in ("same", "opp"):
                    m = self.out[(fam, tk, mu)]
                    m["whiff"].fit(pool["whiff"].rate)
                    m["foul"].fit(pool["foul"].rate)
                    m["con"].fit(pool["con"].rate)
        # velocity effect on whiff within family: logit shift per SD of velo
        for fam in FAMILIES:
            pts = velo_pts[fam]
            if len(pts) < 60:
                self.velo[fam] = (None, None, 0.0)
                continue
            vs = np.array([p[0] for p in pts])
            mean, sd = float(vs.mean()), float(vs.std() or 1.0)
            beta = 0.0
            for _ in range(8):                      # 1-D Newton with offset = map logit
                g = h = 0.0
                for v, y, xr, pz, tk, mu in pts:
                    p0 = min(max(self.out[(fam, tk, mu)]["whiff"].at(xr, pz), 0.02), 0.98)
                    z = math.log(p0 / (1 - p0)) + beta * (v - mean) / sd
                    p = 1 / (1 + math.exp(-z))
                    g += (y - p) * (v - mean) / sd
                    h += p * (1 - p) * ((v - mean) / sd) ** 2
                if h <= 0:
                    break
                step = g / h
                beta += step
                if abs(step) < 1e-5:
                    break
            self.velo[fam] = (mean, sd, max(-1.0, min(1.0, beta)))
        self.count_base = {k: {"n": v["n"], "swing_pct": round(100 * v["sw"] / v["n"], 1) if v["n"] else None,
                               "chase_pct": round(100 * v["ch"] / v["oz"], 1) if v["oz"] else None,
                               "whiff_pct": round(100 * v["wh"] / v["sw"], 1) if v["sw"] else None}
                           for k, v in cb.items()}
        # Centering + scale: price the fit rows themselves. Raw DV is not
        # zero-mean (hitters swing more than the smoothed league rate when a
        # pitch is good within a cell), so the corpus mean is subtracted and
        # the SD of shrunk per-hitter DV/100 becomes the SD+ unit.
        by = {}
        raw = []
        for r in rows:
            pr = self.price(r, center=False)
            if pr is None:
                continue
            raw.append(pr["dv"])
            if r.get("batter"):
                by.setdefault(r["batter"], []).append(pr)
        self.dv_base = sum(raw) / len(raw) if raw else 0.0
        for ps in by.values():
            for p in ps:
                p["dv"] -= self.dv_base
        self.sigma = league_sigma(by)
        for b in range(4):
            for s in range(3):
                vals = []
                for ps in by.values():
                    sub = [p for p in ps if p["balls"] == b and p["strikes"] == s]
                    if len(sub) >= 15:
                        n = len(sub)
                        vals.append((100 * sum(p["dv"] for p in sub) / n) * n / (n + SHRINK_COUNT))
                if len(vals) >= 5:
                    self.sigma_count[(b, s)] = float(np.std(vals)) or None
        return self

    # ── scoring ──
    def price(self, r, center=True):
        """Per-pitch decision pricing, or None when the pitch cannot be priced."""
        if (r.get("plate_loc_side") is None or r.get("plate_loc_height") is None
                or r.get("balls") is None or r.get("strikes") is None or not r.get("pitch_call")):
            return None
        b, s = int(r["balls"]), int(r["strikes"])
        if (b, s) not in COUNT_RV:
            return None
        side = r.get("batter_side") or "Right"
        xr, pz = _xrel(float(r["plate_loc_side"]), side), float(r["plate_loc_height"])
        fam = _fam(r.get("ptype")) or "fb"
        tk = s == 2
        mu = "same" if (r.get("pitcher_throws") or "Right") == side else "opp"
        rv_strike = pitch_run_value(b, s, "StrikeCalled")
        rv_ball = pitch_run_value(b, s, "BallCalled")
        rv_foul = pitch_run_value(b, s, "FoulBall")
        start = COUNT_RV[(b, s)]
        if r.get("session_type") == "intrasquad":
            p_cs = _rulebook_cs(xr, pz, 0.04)
        else:
            p_cs = self.cs[side if side in self.cs else "Right"].at(xr, pz)
        take_rv = p_cs * rv_strike + (1 - p_cs) * rv_ball
        m = self.out[(fam, tk, mu)]
        p_wh = m["whiff"].at(xr, pz)
        mean, sd, beta = self.velo.get(fam, (None, None, 0.0))
        if mean is not None and r.get("rel_speed") is not None and beta:
            p0 = min(max(p_wh, 0.02), 0.98)
            z = math.log(p0 / (1 - p0)) + beta * (float(r["rel_speed"]) - mean) / sd
            p_wh = 1 / (1 + math.exp(-z))
        p_foul = min(m["foul"].at(xr, pz), 1 - p_wh)
        p_ip = max(0.0, 1 - p_wh - p_foul)
        swing_rv = p_wh * rv_strike + p_foul * rv_foul + p_ip * (m["con"].at(xr, pz) - start)
        swung = bool(r.get("is_swing"))
        chosen = swing_rv if swung else take_rv
        p_sw = self.swing[_count_group(b, s)].at(xr, pz)
        league = p_sw * swing_rv + (1 - p_sw) * take_rv
        best = max(swing_rv, take_rv)
        gap = swing_rv - take_rv
        in_zone = abs(xr) <= HALF_W and Z_LO <= pz <= Z_HI
        return {"dv": chosen - league - (self.dv_base if center else 0.0), "regret": chosen - best,
                "swing_rv": swing_rv, "take_rv": take_rv,
                "p_cs": p_cs, "p_swing_lg": p_sw, "swung": swung, "gap": gap,
                "correct": (gap > 0) == swung or abs(gap) <= CORRECT_TOL,
                "hittable": gap > HITTABLE_GAP, "should_take": gap < -HITTABLE_GAP,
                "in_zone": in_zone, "balls": b, "strikes": s,
                "chase": (not in_zone) and swung, "whiff": swung and (r.get("pitch_call") == "StrikeSwinging" or bool(r.get("is_whiff")))}


def batter_summary(priced, sigma, k=SHRINK_PITCHES):
    """Aggregate priced pitches for one hitter. `sigma` = corpus SD of shrunk
    DV/100 (from league_sigma), so SD+ reads 100 +- 10 per SD."""
    n = len(priced)
    if not n:
        return None
    dv = sum(p["dv"] for p in priced)
    dv100 = 100 * dv / n
    shr = dv100 * n / (n + k)
    z = [p for p in priced if p["in_zone"]]
    o = [p for p in priced if not p["in_zone"]]
    hitt = [p for p in priced if p["hittable"]]
    bad = [p for p in priced if p["should_take"]]

    def plus(v):
        return round(100 + 10 * v / sigma) if sigma else None

    return {
        "pitches": n, "dv": round(dv, 2), "dv100": round(dv100, 2), "dv100_shrunk": round(shr, 2),
        "sd_plus": plus(shr),
        "sd_zone": plus((100 * sum(p["dv"] for p in z) / len(z)) * len(z) / (len(z) + k)) if z else None,
        "sd_chase": plus((100 * sum(p["dv"] for p in o) / len(o)) * len(o) / (len(o) + k)) if o else None,
        "correct_pct": round(100 * sum(1 for p in priced if p["correct"]) / n, 1),
        "hittable_take_pct": round(100 * sum(1 for p in hitt if not p["swung"]) / len(hitt), 1) if hitt else None,
        "bad_swing_pct": round(100 * sum(1 for p in bad if p["swung"]) / len(bad), 1) if bad else None,
        "regret100": round(100 * sum(p["regret"] for p in priced) / n, 2),
    }


def by_count(priced, sigma, league_counts=None, k=SHRINK_COUNT, sigma_count=None):
    out = []
    for b in range(4):
        for s in range(3):
            ps = [p for p in priced if p["balls"] == b and p["strikes"] == s]
            n = len(ps)
            base = (league_counts or {}).get((b, s), {})
            row = {"count": f"{b}-{s}", "pitches": n, "lg_swing_pct": base.get("swing_pct"),
                   "lg_chase_pct": base.get("chase_pct"), "lg_whiff_pct": base.get("whiff_pct")}
            if n:
                sw = [p for p in ps if p["swung"]]
                oz = [p for p in ps if not p["in_zone"]]
                dv100 = 100 * sum(p["dv"] for p in ps) / n
                shr = dv100 * n / (n + k)
                row.update({
                    "swing_pct": round(100 * len(sw) / n, 1),
                    "chase_pct": round(100 * sum(1 for p in oz if p["swung"]) / len(oz), 1) if oz else None,
                    "whiff_pct": round(100 * sum(1 for p in sw if p["whiff"]) / len(sw), 1) if sw else None,
                    "dv100": round(dv100, 2),
                    "sd_plus": round(100 + 10 * shr / ((sigma_count or {}).get((b, s)) or sigma)) if sigma else None,
                    "correct_pct": round(100 * sum(1 for p in ps if p["correct"]) / n, 1),
                })
            out.append(row)
    return out


def league_sigma(priced_by_batter, min_pitches=100, k=SHRINK_PITCHES):
    """SD of shrunk DV/100 across qualified hitters; the unit of SD+."""
    vals = []
    for ps in priced_by_batter.values():
        n = len(ps)
        if n >= min_pitches:
            vals.append((100 * sum(p["dv"] for p in ps) / n) * n / (n + k))
    if len(vals) < 5:
        return None
    arr = np.array(vals)
    return float(arr.std()) or None
