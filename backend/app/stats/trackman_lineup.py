"""TrackMan lineup optimizer.

The site's Lineup Helper (stats/lineup_engine.py + split_stats.py) works
from box-score plate appearances: wOBA / OBP / SLG / K% / BB% with recency
decay and sample regression, then The Book's slot weights pick the order.
This module keeps that scaffolding (the same slot-weight matrix, the same
"best hitters at 2 and 4" logic) but feeds it a projection built from
TrackMan pitch data, which has four to five data points per plate
appearance instead of one:

  * Expected production instead of results. Every ball in play carries
    exit velocity, launch angle and direction, so a hitter is credited
    with the hit probability and total bases his contact DESERVED (the
    suite's xBA / xTB / xwOBAcon grids), not what the defense allowed.
    Contact quality stabilises in ~50 batted balls; AVG/SLG need 300+ PA.
  * Pitch-level K% and BB% priors. Whiff rate, chase rate, zone contact
    and swing rate are measured on every pitch. A regression fit on the
    whole tracked corpus (own hitters AND every opponent, the only
    TrackMan in the league) turns those into an expected K% and BB%,
    which then act as the prior the observed K% / BB% shrink toward.
  * Platoon splits from every pitch, not just every PA. A college hitter
    sees 5 to 15 PA against lefties in a fall. Run value per pitch,
    whiff and xwOBAcon by pitcher hand give several hundred observations
    instead; they update a published platoon prior (RHB lose ~6%, LHB
    ~10% of wOBA against same-side arms) with heavy shrinkage.
  * Swing decisions (SD+) and two-strike contact as table-setter terms.
  * A Monte Carlo run simulator (24 base-out states, standard runner
    advancement) prices each lineup in runs per game so the vs-RHP,
    vs-LHP and overall cards are comparable and the gain over a naive
    "sort by wOBA" order is stated.

Recency: every pitch is weighted exp(-ln2 * weeks_ago / 12) with a 0.15
floor, so spring games still count in October without outweighing the
fall. Shrinkage constants are stated inline and mirror split_stats.py
where the quantity is the same.
"""
from __future__ import annotations

import math
import random
from collections import defaultdict

from .lineup_engine import (SLOT_WEIGHTS, LG_OBP, LG_SLG, LG_ISO, LG_K_PCT, LG_BB_PCT,
                            LG_CONTACT_PCT, GB_PENALTY_THRESHOLD, score_player_for_slot)
from .trackman_xstats import xba, xtb, xwobacon
from .trackman_runvalue import pitch_run_value

POSITIONS = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"]
LINEUP_SLOTS = POSITIONS + ["DH"]
SWING_CALLS = {"StrikeSwinging", "FoulBall", "FoulBallFieldable", "FoulBallNotFieldable", "InPlay"}
LIVE_TYPES = ("game", "scrimmage", "intrasquad")

HALF_LIFE_WEEKS = 12.0
WEIGHT_FLOOR = 0.15

# shrinkage priors in PA / BBE / pitch equivalents
PRIOR_K_PA = 60          # K% stabilises ~60 PA (Carleton)
PRIOR_BB_PA = 120        # BB% ~120 PA
PRIOR_HBP_PA = 300
PRIOR_BIP = 60           # per-batted-ball expected hit / TB means
PRIOR_GB_BIP = 80
PRIOR_CONTACT_SW = 100   # contact per swing
PRIOR_SD_PITCH = 150     # SD+ shrink (matches swingdec)
PRIOR_PITCH_FIT = 150    # how many pitches before the pitch-level K/BB prior is fully trusted
PRIOR_PLATOON_PITCHES = 600
ACTUAL_BLEND = 0.25      # share of actual (regressed) BIP results blended into the expected ones

# Published platoon splits in wOBA fraction (The Book, scaled 1.2x for college):
# total gap between facing opposite- and same-side pitchers.
PLATOON_GAP = {"R": 0.065, "L": 0.105, "S": 0.0}
RHP_SHARE = 0.72         # share of PA a hitter sees against right-handers

WOBA_BB, WOBA_HBP = 0.69, 0.72

# per-BIP home-run / extra-base shaping (see pa_probabilities)
PA_TRIPLE_SHARE = 0.10   # share of non-HR extra-base hits that are triples


# ── weights and bookkeeping ───────────────────────────────────────────────

INTRASQUAD_WEIGHT = 0.6  # intrasquad PAs count less: own arms, wilder counts (21% BB in the corpus)


def recency_weight(session_date, today, session_type=None):
    if session_date is None:
        w = 1.0
    else:
        weeks = max(0.0, (today - session_date).days / 7.0)
        w = max(WEIGHT_FLOOR, math.exp(-math.log(2) * weeks / HALF_LIFE_WEEKS))
    return w * (INTRASQUAD_WEIGHT if session_type == "intrasquad" else 1.0)


def _shrink(obs_mean, n, prior_mean, k):
    """Empirical-Bayes shrink of a rate observed over n toward a prior worth k."""
    if n <= 0 or obs_mean is None:
        return prior_mean
    return (obs_mean * n + prior_mean * k) / (n + k)


def _pa_outcome(r):
    if r.get("k_or_bb") == "Strikeout":
        return "K"
    if r.get("k_or_bb") == "Walk":
        return "BB"
    if r.get("pitch_call") == "HitByPitch":
        return "HBP"
    if r.get("play_result") == "Sacrifice":
        return "Sac"
    if r.get("play_result") or r.get("pitch_call") == "InPlay":
        return "InPlay"
    return None


_RESULT_HIT = {"Single": (1, 1), "Double": (1, 2), "Triple": (1, 3), "HomeRun": (1, 4)}


def _bip_probs(ev, la, direction, side):
    """Per batted ball: (p_hit, p_1b, p_2b, p_3b, p_hr, tb, xwobacon)."""
    p_hit = min(1.0, max(0.0, xba(ev, la, direction, side)))
    tb = max(0.0, xtb(ev, la, direction, side))
    # home-run probability from the barrel geometry, capped by the hit probability
    if ev >= 100 and 22 <= la <= 36:
        p_hr = 0.85
    elif ev >= 96 and 20 <= la <= 38:
        p_hr = 0.45
    elif ev >= 92 and 18 <= la <= 40:
        p_hr = 0.12
    else:
        p_hr = 0.0
    p_hr = min(p_hr, p_hit)
    extra = max(0.0, tb - p_hit - 3 * p_hr)            # extra bases left for 2B/3B
    x = min(p_hit - p_hr, extra / (1.0 + PA_TRIPLE_SHARE))  # 2B+3B share
    p_3b = PA_TRIPLE_SHARE * x
    p_2b = x - p_3b
    p_1b = max(0.0, p_hit - p_hr - x)
    return p_hit, p_1b, p_2b, p_3b, p_hr, tb, xwobacon(ev, la, direction, side)


# ── per-hitter feature extraction ─────────────────────────────────────────

class HitterAgg:
    """Weighted pitch- and PA-level features for one hitter (one view)."""

    def __init__(self):
        self.pa_w = self.pa_n = 0.0
        self.k = self.bb = self.hbp = self.sac = 0.0
        self.bip_w = self.bip_n = 0.0
        self.x_hit = self.x_1b = self.x_2b = self.x_3b = self.x_hr = self.x_tb = self.x_wc = 0.0
        self.a_hit = self.a_tb = 0.0
        self.gb = self.air = self.pull_air = 0.0
        self.pitches_w = self.pitches_n = 0.0
        self.called = self.swings = self.whiffs = self.contact = 0.0
        self.oz = self.chase = self.iz = self.z_sw = self.z_ct = 0.0
        self.k2_sw = self.k2_ct = 0.0
        self.rv = 0.0
        self.rv_n = 0.0
        self.sd_rows = []
        self.ev = []
        self.triples = 0.0

    # pitch-level
    def add_pitch(self, r, w, rv_base):
        if not r.get("pitch_call"):
            return
        self.pitches_w += w
        self.pitches_n += 1
        self.called += w
        sw = r["pitch_call"] in SWING_CALLS
        if sw:
            self.swings += w
            if r["pitch_call"] == "StrikeSwinging":
                self.whiffs += w
            else:
                self.contact += w
            if r.get("strikes") == 2:
                self.k2_sw += w
                if r["pitch_call"] != "StrikeSwinging":
                    self.k2_ct += w
        if r.get("is_in_zone") is False:
            self.oz += w
            if sw:
                self.chase += w
        elif r.get("is_in_zone") is True:
            self.iz += w
            if sw:
                self.z_sw += w
                if r["pitch_call"] != "StrikeSwinging":
                    self.z_ct += w
        rv = pitch_run_value(r.get("balls"), r.get("strikes"), r.get("pitch_call"), r.get("play_result"))
        if rv is not None:
            self.rv += (rv - rv_base) * w
            self.rv_n += w
        self.sd_rows.append(r)

    # PA-level (terminal pitch of the PA)
    def add_pa(self, r, w, side):
        o = _pa_outcome(r)
        if o is None:
            return
        self.pa_w += w
        self.pa_n += 1
        if o == "K":
            self.k += w
            return
        if o == "BB":
            self.bb += w
            return
        if o == "HBP":
            self.hbp += w
            return
        if o == "Sac":
            self.sac += w
        ev = float(r["exit_speed"]) if r.get("exit_speed") is not None else None
        la = float(r["launch_angle"]) if r.get("launch_angle") is not None else None
        pr = r.get("play_result")
        self.bip_w += w
        self.bip_n += 1
        if ev is not None and la is not None:
            d = float(r["direction"]) if r.get("direction") is not None else None
            p_hit, p1, p2, p3, phr, tb, xwc = _bip_probs(ev, la, d, side)
            self.x_hit += p_hit * w; self.x_1b += p1 * w; self.x_2b += p2 * w; self.x_3b += p3 * w
            self.x_hr += phr * w; self.x_tb += tb * w; self.x_wc += xwc * w
            self.ev.append(ev)
            if la < 10:
                self.gb += w
            else:
                self.air += w
                if d is not None and side in ("L", "R") and d * (1.0 if side == "L" else -1.0) >= 10:
                    self.pull_air += w
        else:
            # untracked contact: credit the actual result so coverage gaps don't bias
            h, tb = _RESULT_HIT.get(pr, (0, 0))
            self.x_hit += h * w; self.x_tb += tb * w
            self.x_wc += {"Single": 0.89, "Double": 1.27, "Triple": 1.62, "HomeRun": 2.10}.get(pr, 0.0) * w
            if pr == "HomeRun":
                self.x_hr += w
            elif pr == "Triple":
                self.x_3b += w
            elif pr == "Double":
                self.x_2b += w
            elif pr == "Single":
                self.x_1b += w
        h, tb = _RESULT_HIT.get(pr, (0, 0))
        self.a_hit += h * w
        self.a_tb += tb * w
        if pr == "Triple":
            self.triples += w

    # raw rates (None when no sample)
    def rate(self, num, den):
        return (num / den) if den > 0 else None

    def features(self):
        """Pitch-level rates used by the K/BB fit and as display."""
        return {
            "whiff": self.rate(self.whiffs, self.swings),
            "chase": self.rate(self.chase, self.oz),
            "zone_contact": self.rate(self.z_ct, self.z_sw),
            "zone_swing": self.rate(self.z_sw, self.iz),
            "swing": self.rate(self.swings, self.called),
            "contact": self.rate(self.contact, self.swings),
            "k2_contact": self.rate(self.k2_ct, self.k2_sw),
            "rv100": (100 * self.rv / self.rv_n) if self.rv_n > 0 else None,
        }


def build_aggs(rows, today, rv_base, sd_model=None):
    """rows: pitch rows (own + opponents) with session_date, batter, batter_team,
    batter_side, pitcher_throws, pitch fields. Returns
    {(batter, team): {"all": HitterAgg, "R": HitterAgg, "L": HitterAgg, "side": 'L'|'R'|'S', ...}}."""
    out = {}
    pa_last = {}
    for r in rows:
        key = (r["batter"], r["batter_team"])
        h = out.get(key)
        if h is None:
            h = out[key] = {"all": HitterAgg(), "R": HitterAgg(), "L": HitterAgg(), "lg": HitterAgg(),
                            "sides": defaultdict(float), "last": None}
        w = recency_weight(r.get("session_date"), today, r.get("session_type"))
        hand = (r.get("pitcher_throws") or "")[:1]
        side = (r.get("batter_side") or "")[:1]
        if side in ("L", "R"):
            h["sides"][side] += 1
        d = r.get("session_date")
        if d and (h["last"] is None or d > h["last"]):
            h["last"] = d
        h["all"].add_pitch(r, w, rv_base)
        if hand in ("L", "R"):
            h[hand].add_pitch(r, w, rv_base)
        if r.get("session_type") != "intrasquad":
            h["lg"].add_pitch(r, 1.0, rv_base)
        pk = (key, r.get("session_id"), r.get("inning"), r.get("top_bottom"), r.get("pa_of_inning"))
        best = pa_last.get(pk)
        if best is None or (r.get("pitch_of_pa") or 0) >= (best[0].get("pitch_of_pa") or 0):
            pa_last[pk] = (r, w, hand)
    for (key, *_), (r, w, hand) in pa_last.items():
        h = out[key]
        side = (r.get("batter_side") or "")[:1] or _hitter_side(h)
        h["all"].add_pa(r, w, side)
        if hand in ("L", "R"):
            h[hand].add_pa(r, w, side)
        if r.get("session_type") != "intrasquad":
            h["lg"].add_pa(r, 1.0, side)
    for h in out.values():
        h["side"] = _hitter_side(h)
    return out


def _hitter_side(h):
    s = h["sides"]
    if s.get("L", 0) and s.get("R", 0):
        return "S" if min(s["L"], s["R"]) / (s["L"] + s["R"]) >= 0.2 else max(s, key=s.get)
    if s:
        return max(s, key=s.get)
    return "R"


# ── league context and the pitch-level K / BB fit ─────────────────────────

SPRING_WEIGHT = 0.5   # share of the prior environment taken from the spring box-score league line


def league_context(aggs, min_pa=1, spring=None):
    """League means over every hitter in the corpus (own and opponents),
    weighted by their PAs: the regression targets. Built from the "lg"
    aggregate, which counts games and scrimmages only (no intrasquads)
    with no recency decay, so the prior is a game environment.

    spring: {k, bb, hbp, bip_hit, bip_tb, season, level, pa} from the
    site's box scores for the level. Fall TrackMan ball runs hot on walks
    (13% vs 10.6% in NAIA spring 2026), so the prior every hitter shrinks
    toward is a 50/50 blend of the tracked corpus and the spring line.
    The raw corpus values are kept under fall_* for the pitch-level fit."""
    tot = HitterAgg()
    for h in aggs.values():
        a = h["lg"]
        if a.pa_n < min_pa:
            continue
        for f in ("pa_w", "k", "bb", "hbp", "sac", "bip_w", "x_hit", "x_1b", "x_2b", "x_3b", "x_hr", "x_tb", "x_wc",
                  "a_hit", "a_tb", "gb", "air", "pull_air", "called", "swings", "whiffs", "contact", "oz", "chase",
                  "iz", "z_sw", "z_ct", "k2_sw", "k2_ct"):
            setattr(tot, f, getattr(tot, f) + getattr(a, f))
    pa = tot.pa_w or 1.0
    bip = tot.bip_w or 1.0
    lg = {
        "k": tot.k / pa, "bb": tot.bb / pa, "hbp": tot.hbp / pa,
        "bip_hit": tot.x_hit / bip, "bip_1b": tot.x_1b / bip, "bip_2b": tot.x_2b / bip, "bip_3b": tot.x_3b / bip,
        "bip_hr": tot.x_hr / bip, "bip_tb": tot.x_tb / bip, "bip_wc": tot.x_wc / bip,
        "a_bip_hit": tot.a_hit / bip, "a_bip_tb": tot.a_tb / bip,
        "gb": tot.gb / max(1.0, tot.gb + tot.air),
        "contact": tot.contact / max(1.0, tot.swings),
        "k2_contact": tot.k2_ct / max(1.0, tot.k2_sw),
        "hitters": sum(1 for h in aggs.values() if h["lg"].pa_n >= 20),
    }
    for k in ("k", "bb", "hbp", "bip_hit", "bip_tb", "bip_wc"):
        lg["fall_" + k] = lg[k]
    if spring and spring.get("pa"):
        w = SPRING_WEIGHT
        for k in ("k", "bb", "hbp", "bip_hit", "bip_tb"):
            if spring.get(k) is not None:
                lg[k] = (1 - w) * lg[k] + w * spring[k]
        # no x-stats in box scores: move wOBAcon with total bases per ball in play
        if lg["fall_bip_tb"]:
            lg["bip_wc"] = lg["fall_bip_wc"] * (lg["bip_tb"] / lg["fall_bip_tb"])
        lg["spring"] = spring
        lg["spring_weight"] = w
    lg.update(_derive_line(lg["k"], lg["bb"], lg["hbp"], lg["bip_hit"], lg["bip_tb"], lg["bip_wc"]))
    return lg


def _derive_line(p_k, p_bb, p_hbp, bip_hit, bip_tb, bip_wc):
    p_bip = max(0.0, 1.0 - p_k - p_bb - p_hbp)
    ab = p_k + p_bip
    avg = p_bip * bip_hit / ab if ab else 0.0
    slg = p_bip * bip_tb / ab if ab else 0.0
    return {"avg": avg, "obp": p_bb + p_hbp + p_bip * bip_hit, "slg": slg, "iso": slg - avg,
            "woba": WOBA_BB * p_bb + WOBA_HBP * p_hbp + p_bip * bip_wc}


def fit_rate_model(aggs, target, feats, min_pa=20, ridge=1e-2):
    """PA-weighted least-squares fit of a PA-level rate (K% or BB%) on
    pitch-level features across every hitter with min_pa game/scrimmage
    PAs (own and opponents). Returns the coefficient dict + fit stats, or
    None when the corpus is too thin (<15 hitters)."""
    X, y, wts = [], [], []
    for h in aggs.values():
        a = h["lg"]
        if a.pa_n < min_pa:
            continue
        f = a.features()
        if any(f.get(k) is None for k in feats):
            continue
        X.append([1.0] + [f[k] for k in feats])
        y.append((a.k if target == "k" else a.bb) / a.pa_w)
        wts.append(a.pa_n)
    n = len(y)
    if n < 15:
        return None
    try:
        import numpy as np
        Xm, ym, W = np.array(X), np.array(y), np.array(wts, dtype=float)
        W = W / W.mean()
        reg = ridge * np.eye(Xm.shape[1]); reg[0, 0] = 0.0
        XtW = Xm.T * W
        beta = np.linalg.solve(XtW @ Xm + reg * n, XtW @ ym)
        pred = Xm @ beta
        ss_res = float((W * (ym - pred) ** 2).sum()); ss_tot = float((W * (ym - np.average(ym, weights=W)) ** 2).sum()) or 1.0
        return {"coef": {"intercept": float(beta[0]), **{k: float(b) for k, b in zip(feats, beta[1:])}},
                "r2": round(1 - ss_res / ss_tot, 3), "n": n, "features": feats}
    except Exception:
        return None


def _predict(fit, feats):
    if not fit:
        return None
    v = fit["coef"]["intercept"]
    for k in fit["features"]:
        if feats.get(k) is None:
            return None
        v += fit["coef"][k] * feats[k]
    return min(0.6, max(0.02, v))


# ── projection ────────────────────────────────────────────────────────────

def project(agg, lg, k_fit, bb_fit, sd_model=None, sd_sigma=None):
    """One view's regressed projection from a HitterAgg."""
    f = agg.features()
    pa = agg.pa_w
    # pitch-level priors, trusted in proportion to pitches seen
    xk = _predict(k_fit, f)
    xbb = _predict(bb_fit, f)
    # the fit's intercept lives at the fall-corpus level; slide it to the blended prior
    if xk is not None:
        xk = max(0.02, xk + (lg["k"] - lg.get("fall_k", lg["k"])))
    if xbb is not None:
        xbb = max(0.02, xbb + (lg["bb"] - lg.get("fall_bb", lg["bb"])))
    rel = agg.pitches_w / (agg.pitches_w + PRIOR_PITCH_FIT) if agg.pitches_w else 0.0
    prior_k = (xk * rel + lg["k"] * (1 - rel)) if xk is not None else lg["k"]
    prior_bb = (xbb * rel + lg["bb"] * (1 - rel)) if xbb is not None else lg["bb"]
    p_k = _shrink(agg.k / pa if pa else None, pa, prior_k, PRIOR_K_PA)
    p_bb = _shrink(agg.bb / pa if pa else None, pa, prior_bb, PRIOR_BB_PA)
    p_hbp = _shrink(agg.hbp / pa if pa else None, pa, lg["hbp"], PRIOR_HBP_PA)
    # per batted ball: expected (shrunk) blended with actual (shrunk harder)
    bw = agg.bip_w
    def bip(xnum, prior):
        return _shrink(xnum / bw if bw else None, bw, prior, PRIOR_BIP)
    x_hit, x_tb, x_wc = bip(agg.x_hit, lg["bip_hit"]), bip(agg.x_tb, lg["bip_tb"]), bip(agg.x_wc, lg["bip_wc"])
    a_hit = _shrink(agg.a_hit / bw if bw else None, bw, lg["a_bip_hit"], PRIOR_BIP * 3)
    a_tb = _shrink(agg.a_tb / bw if bw else None, bw, lg["a_bip_tb"], PRIOR_BIP * 3)
    bip_hit = (1 - ACTUAL_BLEND) * x_hit + ACTUAL_BLEND * a_hit
    bip_tb = (1 - ACTUAL_BLEND) * x_tb + ACTUAL_BLEND * a_tb
    bip_wc = x_wc + ACTUAL_BLEND * (a_tb - x_tb) * 0.35   # actual power leaks into wOBAcon a little
    # hit-type shape (normalised to the projected hit rate)
    raw = [bip(agg.x_1b, lg["bip_1b"]), bip(agg.x_2b, lg["bip_2b"]), bip(agg.x_3b, lg["bip_3b"]), bip(agg.x_hr, lg["bip_hr"])]
    s = sum(raw) or 1.0
    shape = [v / s for v in raw]
    line = _derive_line(p_k, p_bb, p_hbp, bip_hit, bip_tb, bip_wc)
    p_bip = max(0.0, 1.0 - p_k - p_bb - p_hbp)
    gb = _shrink(agg.gb / (agg.gb + agg.air) if (agg.gb + agg.air) > 0 else None, agg.gb + agg.air, lg["gb"], PRIOR_GB_BIP)
    contact = _shrink(f["contact"], agg.swings, lg["contact"], PRIOR_CONTACT_SW)
    k2 = _shrink(f["k2_contact"], agg.k2_sw, lg["k2_contact"], PRIOR_CONTACT_SW / 2)
    sd_plus = None
    if sd_model is not None and sd_sigma and agg.sd_rows:
        try:
            from . import trackman_swingdec as swingdec
            priced = [p for p in (sd_model.price(_sd_row(r)) for r in agg.sd_rows) if p]
            sm = swingdec.batter_summary(priced, sd_sigma)
            sd_plus = sm.get("sd_plus") if sm else None
        except Exception:
            sd_plus = None
    out = {
        "pa": round(agg.pa_n), "pa_w": round(pa, 1), "pitches": round(agg.pitches_n), "bbe": round(agg.bip_n),
        "k_pct": p_k, "bb_pct": p_bb, "hbp_pct": p_hbp,
        "avg": line["avg"], "obp": line["obp"], "slg": line["slg"], "iso": line["iso"], "woba": line["woba"],
        "xk_pitch": xk, "xbb_pitch": xbb,
        "bip_hit": bip_hit, "bip_tb": bip_tb, "bip_wc": bip_wc,
        "p_bip": p_bip, "hit_shape": shape,
        "gb_pct": gb, "contact_pct": contact, "k2_contact_pct": k2,
        "whiff_pct": f["whiff"], "chase_pct": f["chase"], "zone_contact_pct": f["zone_contact"],
        "rv100": f["rv100"], "sd_plus": sd_plus,
        "avg_ev": round(sum(agg.ev) / len(agg.ev), 1) if agg.ev else None,
        "obs_k_pct": agg.k / pa if pa else None, "obs_bb_pct": agg.bb / pa if pa else None,
        "obs_woba_bip": agg.x_wc / bw if bw else None,
    }
    return out


def _sd_row(r):
    """Same field map as the suite's _sd_row: the model reads is_swing /
    is_whiff, so leaving them out prices every pitch as a take."""
    return {"plate_loc_side": r.get("plate_loc_side", r.get("px")), "plate_loc_height": r.get("plate_loc_height", r.get("pz")),
            "balls": r.get("balls"), "strikes": r.get("strikes"), "pitch_call": r.get("pitch_call"),
            "play_result": r.get("play_result"), "batter_side": r.get("batter_side"), "pitcher_throws": r.get("pitcher_throws"),
            "ptype": r.get("ptype"), "is_swing": r.get("is_swing"), "is_whiff": r.get("is_whiff"),
            "exit_speed": r.get("exit_speed"), "launch_angle": r.get("launch_angle"), "direction": r.get("direction"),
            "rel_speed": r.get("rel_speed"), "session_type": r.get("session_type")}


def platoon_views(h, season, lg):
    """vs_RHP / vs_LHP projections: the season view scaled by a platoon
    factor whose prior is the published split for the hitter's side,
    updated by pitch-level run value against each hand (shrunk on the
    smaller hand's pitch count, 600-pitch prior)."""
    side = h["side"]
    gap = PLATOON_GAP.get(side, 0.065)
    # prior: facing the same side costs, opposite side gains, weighted so the
    # 72/28 exposure mix averages back to the season line
    if side == "L":
        prior = {"R": +gap * (1 - RHP_SHARE), "L": -gap * RHP_SHARE}
    elif side == "R":
        prior = {"R": -gap * (1 - RHP_SHARE), "L": +gap * RHP_SHARE}
    else:
        prior = {"R": 0.0, "L": 0.0}
    rv_r, rv_l = h["R"].features()["rv100"], h["L"].features()["rv100"]
    n_min = min(h["R"].rv_n, h["L"].rv_n)
    obs_gap = None
    if rv_r is not None and rv_l is not None and n_min > 0:
        # RV per 100 pitches -> wOBA fraction: ~3.9 pitches per PA, 1.25 runs per wOBA point
        d_woba = (rv_l - rv_r) / 100.0 * 3.9 * 1.25
        obs_gap = d_woba / max(0.25, season["woba"])      # fraction of wOBA, positive = better vs LHP
    w = n_min / (n_min + PRIOR_PLATOON_PITCHES) if n_min > 0 else 0.0
    prior_gap = prior["L"] - prior["R"]
    gap_hat = prior_gap if obs_gap is None else (w * max(-0.4, min(0.4, obs_gap)) + (1 - w) * prior_gap)
    d = {"R": -gap_hat * (1 - RHP_SHARE), "L": gap_hat * RHP_SHARE}
    views = {}
    for hand, dd in d.items():
        v = dict(season)
        v["woba"] = season["woba"] * (1 + dd)
        v["obp"] = season["obp"] * (1 + 0.6 * dd)
        v["slg"] = season["slg"] * (1 + 1.2 * dd)
        v["avg"] = season["avg"] * (1 + 0.8 * dd)
        v["iso"] = v["slg"] - v["avg"]
        v["k_pct"] = min(0.6, max(0.03, season["k_pct"] * (1 - 1.5 * dd)))
        v["bb_pct"] = min(0.4, max(0.02, season["bb_pct"] * (1 + dd)))
        v["bip_hit"] = season["bip_hit"] * (1 + 0.8 * dd)
        v["bip_tb"] = season["bip_tb"] * (1 + 1.2 * dd)
        v["p_bip"] = max(0.0, 1.0 - v["k_pct"] - v["bb_pct"] - v["hbp_pct"])
        v["platoon_adj"] = dd
        v["obs_rv100"] = rv_l if hand == "L" else rv_r
        v["obs_pitches"] = round(h[hand].pitches_n)
        v["obs_pa"] = round(h[hand].pa_n)
        views[hand] = v
    return views, {"side": side, "prior_gap": prior_gap, "obs_gap": obs_gap, "gap_hat": gap_hat,
                   "weight": round(w, 3), "pitches_min": round(n_min)}


# ── slot scoring with TrackMan extras ──────────────────────────────────────

# TrackMan-only additions to The Book slot score (runs per season):
#   SD+ : table setters who do not give away strikes (slots 1-2), smaller mid-order
#   2K contact : slot 2/3 hit with runners on and two strikes a lot
SD_WEIGHT = {1: 0.045, 2: 0.045, 3: 0.02, 4: 0.015, 5: 0.015, 6: 0.01, 7: 0.01, 8: 0.01, 9: 0.03}
K2_WEIGHT = {2: 15.0, 3: 10.0}


def slot_score(view, speed_z, slot):
    eng = {"OBP": view["obp"], "SLG": view["slg"], "ISO": view["iso"], "K_pct": view["k_pct"], "BB_pct": view["bb_pct"],
           "Contact_pct": view.get("contact_pct"), "GB_pct": view.get("gb_pct")}
    s = score_player_for_slot(eng, speed_z, slot)
    sdp = view.get("sd_plus")
    if sdp is not None:
        s += SD_WEIGHT[slot] * (sdp - 100)
    k2 = view.get("k2_contact_pct")
    if k2 is not None and slot in K2_WEIGHT:
        s += K2_WEIGHT[slot] * (k2 - 0.80)
    return s


def best_slot_score(view, speed_z):
    return max(slot_score(view, speed_z, s) for s in range(1, 10))


def select_starters(cands, view_key, speeds):
    """cands: [{player, eligible:set, views}] -> {position: cand} maximising the
    sum of best-slot scores, DH open to anyone. Backtracking over the
    scarcest position first; None when nine cannot be filled."""
    if len(cands) < 9:
        return None
    for c in cands:
        c["_sel"] = best_slot_score(c["views"][view_key], speeds.get(c["player"], 0.0))
    by_pos = {}
    for pos in LINEUP_SLOTS:
        lst = list(cands) if pos == "DH" else [c for c in cands if pos in c["eligible"]]
        lst.sort(key=lambda c: -c["_sel"])
        by_pos[pos] = lst
    order = sorted(LINEUP_SLOTS, key=lambda p: len(by_pos[p]))
    best = {"score": -1e18, "asg": None}
    # upper bound pruning: remaining positions' best available candidate
    def bt(i, used, score, asg):
        if i == len(order):
            if score > best["score"]:
                best["score"], best["asg"] = score, dict(asg)
            return
        bound = score + sum((by_pos[p][0]["_sel"] if by_pos[p] else 0.0) for p in order[i:])
        if bound <= best["score"]:
            return
        pos = order[i]
        for c in by_pos[pos]:
            if c["player"] in used:
                continue
            used.add(c["player"]); asg[pos] = c
            bt(i + 1, used, score + c["_sel"], asg)
            used.discard(c["player"]); del asg[pos]
    bt(0, set(), 0.0, {})
    return best["asg"]


def optimize_order(nine, view_key, speeds):
    """Exact linear assignment of 9 hitters to 9 slots by bitmask DP."""
    cost = [[slot_score(c["views"][view_key], speeds.get(c["player"], 0.0), s + 1) for s in range(9)] for c in nine]
    n = 9
    best = [-1e18] * (1 << n)
    choice = [None] * (1 << n)
    best[0] = 0.0
    for mask in range(1 << n):
        if best[mask] == -1e18:
            continue
        slot = bin(mask).count("1")       # next slot to fill (0-based)
        if slot >= n:
            continue
        for p in range(n):
            if mask & (1 << p):
                continue
            v = best[mask] + cost[p][slot]
            nm = mask | (1 << p)
            if v > best[nm]:
                best[nm], choice[nm] = v, p
    mask, perm = (1 << n) - 1, [None] * n
    while mask:
        p = choice[mask]
        perm[bin(mask).count("1") - 1] = p
        mask &= ~(1 << p)
    return perm, best[(1 << n) - 1], cost


# ── run simulator ──────────────────────────────────────────────────────────

def pa_probabilities(view):
    """Outcome distribution of one PA from a projection view."""
    p_bb = view["bb_pct"] + view["hbp_pct"]
    p_k = view["k_pct"]
    p_bip = max(0.0, 1.0 - p_bb - p_k)
    hit = min(0.95, view["bip_hit"])
    s1, s2, s3, shr = view["hit_shape"]
    return {"bb": p_bb, "k": p_k, "1b": p_bip * hit * s1, "2b": p_bip * hit * s2, "3b": p_bip * hit * s3,
            "hr": p_bip * hit * shr, "out": p_bip * (1 - hit), "gb": view.get("gb_pct") or 0.45}


def simulate_runs(nine_views, speeds=None, games=3000, seed=7, innings=9):
    """Monte Carlo runs per game for a batting order (list of 9 views).
    Standard advancement: single moves a runner on first to third 28% of the
    time and scores a runner on second 60%; a double scores the runner on
    first 42%; ground-ball outs with a runner on first and fewer than two
    outs turn two in proportion to the hitter's GB%; fly outs score a
    runner from third 25% (<2 outs). Speed shifts the extra-base rates."""
    rng = random.Random(seed)
    probs = [pa_probabilities(v) for v in nine_views]
    spd = speeds or [0.0] * 9
    cum = []
    for p in probs:
        keys = ["bb", "k", "1b", "2b", "3b", "hr", "out"]
        tot = sum(p[k] for k in keys) or 1.0
        acc, c = 0.0, []
        for k in keys:
            acc += p[k] / tot
            c.append((acc, k))
        cum.append(c)
    total = 0.0
    for _ in range(games):
        bo = 0
        runs = 0
        for _inn in range(innings):
            outs = 0
            bases = [None, None, None]   # index of runner (for speed) or None
            while outs < 3:
                i = bo % 9
                bo += 1
                u = rng.random()
                res = next(k for a, k in cum[i] if u <= a)
                if res == "k":
                    outs += 1
                elif res == "bb":
                    if bases[0] is not None:
                        if bases[1] is not None:
                            if bases[2] is not None:
                                runs += 1
                            bases[2] = bases[1]
                        bases[1] = bases[0]
                    bases[0] = i
                elif res == "hr":
                    runs += 1 + sum(1 for b in bases if b is not None)
                    bases = [None, None, None]
                elif res == "3b":
                    runs += sum(1 for b in bases if b is not None)
                    bases = [None, None, i]
                elif res == "2b":
                    if bases[2] is not None:
                        runs += 1
                    if bases[1] is not None:
                        runs += 1
                    nb = [None, i, None]
                    if bases[0] is not None:
                        if rng.random() < min(0.9, 0.42 + 0.06 * spd[bases[0]]):
                            runs += 1
                        else:
                            nb[2] = bases[0]
                    bases = nb
                elif res == "1b":
                    nb = [i, None, None]
                    if bases[2] is not None:
                        runs += 1
                    if bases[1] is not None:
                        if rng.random() < min(0.95, 0.60 + 0.07 * spd[bases[1]]):
                            runs += 1
                        else:
                            nb[2] = bases[1]
                    if bases[0] is not None:
                        if nb[2] is None and rng.random() < min(0.8, 0.28 + 0.06 * spd[bases[0]]):
                            nb[2] = bases[0]
                        else:
                            nb[1] = bases[0]
                    bases = nb
                else:  # out in play
                    gb = rng.random() < probs[i]["gb"]
                    if gb:
                        if bases[0] is not None and outs < 2 and rng.random() < 0.38:
                            outs += 2          # double play
                            bases[0] = None
                            if outs >= 3:
                                break
                            continue
                        outs += 1
                        if outs < 3 and bases[0] is not None and rng.random() < 0.15:
                            # fielder's choice / runner advances on a ground out
                            if bases[2] is not None:
                                runs += 1
                            bases = [None, bases[0], bases[1]]
                    else:
                        outs += 1
                        if outs < 3 and bases[2] is not None and rng.random() < 0.25:
                            runs += 1
                            bases[2] = None
        total += runs
    return total / games


# ── speed proxy ───────────────────────────────────────────────────────────

def speed_z(players, manual_bsr):
    """Within-team z of (SB - 0.5 CS) per time on first, plus triples per
    batted ball; players without a steal record sit at 0. Clamped to ±2."""
    prox, has = {}, {}
    for p in players:
        a = p["agg"]["all"]
        sb, cs = manual_bsr.get(p["player"], (0, 0))
        opps = a.x_1b + a.bb + a.hbp
        has[p["player"]] = bool(sb or cs)
        v = ((sb - 0.5 * cs) / opps) if opps > 0 and (sb or cs) else 0.0
        v += 0.6 * (a.triples / a.bip_w) if a.bip_w else 0.0
        prox[p["player"]] = v
    rated = [v for k, v in prox.items() if has[k]]
    if len(rated) < 3:
        return {k: 0.0 for k in prox}   # no steal log this season: speed is neutral
    m = sum(rated) / len(rated)
    sd = (sum((v - m) ** 2 for v in rated) / len(rated)) ** 0.5
    if sd == 0:
        return {k: 0.0 for k in prox}
    return {k: (max(-2.0, min(2.0, (v - m) / sd)) if has[k] else 0.0) for k, v in prox.items()}


# ── public: build the whole answer ────────────────────────────────────────

def build_lineups(hitters, view_keys=("R", "L", "all"), custom=None, games=3000):
    """hitters: [{player, side, eligible:set, views:{all,R,L}, speed_z, available, rated}]
    custom: {view_key: [nine player names]} forces the starters for that card.
    Returns {view_key: {starters, bench, order_score, runs_pg, naive_runs_pg}}."""
    speeds = {h["player"]: h.get("speed_z", 0.0) for h in hitters}
    out = {}
    for vk in view_keys:
        pool = [h for h in hitters if h.get("available", True) and h.get("rated", True)]
        forced = (custom or {}).get(vk)
        if forced:
            names = set(forced)
            pool = [h for h in hitters if h["player"] in names]
            if len(pool) != 9:
                out[vk] = {"error": f"custom lineup needs 9 known hitters, got {len(pool)}"}
                continue
        asg = select_starters(pool, vk, speeds)
        if not asg:
            out[vk] = {"error": "not enough eligible hitters to fill nine positions"}
            continue
        nine = list(asg.values())
        pos_of = {c["player"]: pos for pos, c in asg.items()}
        perm, score, cost = optimize_order(nine, vk, speeds)
        order = [nine[p] for p in perm]
        views = [c["views"][vk] for c in order]
        spd = [speeds.get(c["player"], 0.0) for c in order]
        runs = simulate_runs(views, spd, games=games)
        naive = sorted(nine, key=lambda c: -c["views"][vk]["woba"])
        naive_runs = simulate_runs([c["views"][vk] for c in naive], [speeds.get(c["player"], 0.0) for c in naive], games=games)
        starters = []
        for slot, c in enumerate(order, 1):
            v = c["views"][vk]
            starters.append({"slot": slot, "player": c["player"], "side": c["side"], "position": pos_of[c["player"]],
                             "score": round(cost[perm[slot - 1]][slot - 1], 2),
                             "best_slot": 1 + max(range(9), key=lambda s: cost[perm[slot - 1]][s]),
                             **_view_out(v), "speed_z": round(speeds.get(c["player"], 0.0), 2)})
        starter_names = {c["player"] for c in nine}
        bench = []
        for h in hitters:
            if h["player"] in starter_names or not h.get("available", True):
                continue
            v = h["views"][vk]
            sc = [(slot_score(v, speeds.get(h["player"], 0.0), s), s) for s in range(1, 10)]
            bs = max(sc)
            bench.append({"player": h["player"], "side": h["side"], "eligible": sorted(h["eligible"]),
                          "best_slot": bs[1], "best_score": round(bs[0], 2), "rated": h.get("rated", True), **_view_out(v)})
        bench.sort(key=lambda b: -b["best_score"])
        out[vk] = {"starters": starters, "bench": bench, "order_score": round(score, 2),
                   "runs_pg": round(runs, 2), "naive_runs_pg": round(naive_runs, 2),
                   "edge_per_game": round(runs - naive_runs, 2), "custom": bool(forced)}
    return out


def _view_out(v):
    r3 = lambda x: round(x, 3) if x is not None else None
    r1 = lambda x: round(100 * x, 1) if x is not None else None
    return {"woba": r3(v["woba"]), "obp": r3(v["obp"]), "slg": r3(v["slg"]), "iso": r3(v["iso"]), "avg": r3(v["avg"]),
            "k_pct": r1(v["k_pct"]), "bb_pct": r1(v["bb_pct"]), "gb_pct": r1(v.get("gb_pct")),
            "contact_pct": r1(v.get("contact_pct")), "k2_contact_pct": r1(v.get("k2_contact_pct")),
            "sd_plus": v.get("sd_plus"), "pa": v.get("pa"), "pitches": v.get("pitches"), "bbe": v.get("bbe"),
            "platoon_adj": round(100 * v.get("platoon_adj", 0.0), 1) if v.get("platoon_adj") is not None else None,
            "obs_pa": v.get("obs_pa"), "obs_rv100": r3(v.get("obs_rv100")) if v.get("obs_rv100") is not None else None,
            "whiff_pct": r1(v.get("whiff_pct")), "chase_pct": r1(v.get("chase_pct")),
            "avg_ev": v.get("avg_ev"), "xk_pitch": r1(v.get("xk_pitch")), "xbb_pitch": r1(v.get("xbb_pitch"))}
