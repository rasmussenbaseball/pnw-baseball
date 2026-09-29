"""NWBB player projections, v2 engine (September 2026).

Empirical-Bayes component model. Every rate stat is projected in CENTERED
space (rate minus its level-season league mean), then re-anchored to the
destination level's environment. The design follows the standard projection
literature (Marcel / Tango reliability, Carleton stabilization, Zimmerman's
college work, Davenport-style level translation) with every constant fit on
our own data instead of borrowed from MLB.

Pipeline for one player:
  1. History = every spring season (any level) + every linked WCL summer
     season, each centered on its own league-season mean and de-parked.
  2. Level translation: each season is moved onto the destination level's
     scale with an additive offset per component. Offsets are solved by
     weighted least squares from three sources: direct movers (last JUCO
     season -> first four-year season, aging-corrected, any gap <= 3),
     the West Coast League bridge (players from every level share the same
     summer league, so spring-vs-WCL deltas compare levels on a common
     scale), and a weak published prior for JUCO -> D1.
  3. Weighted average (5/4/3 by recency x sample size; translated seasons
     discounted) and shrinkage toward a hierarchical prior mean
     (level-season mean + class-year offset + program offset) with a
     ballast M = E[sampling variance] / Var(true talent), estimated per
     level and component by the method of moments. Nothing is regressed
     toward "average" by a fixed amount; the data says how much.
  4. Component-specific class-year aging (delta method on our own pairs,
     shrunk toward the pooled estimate).
  5. Play-by-play refinement: last season's pitch-level rates (whiff,
     contact, GB/LD/FB, air-pull, swing, strike) move the estimate through
     sign-constrained residual regressions fit on our own pairs.
  6. Reconstruction of the slash line / ERA from the components, re-parked
     at the destination home park, plus a posterior standard deviation for
     honest P10/P90 bands.

No quantile mapping, no post-hoc stretching, no floors or ceilings beyond
physical bounds. Point projections are narrower than actual outcomes because
single seasons are half noise; the range of outcomes carries the upside.

Run the backtest with scripts/projections/backtest_v2.py.
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from derive_constants import load_batting, load_pitching, norm_class  # noqa: E402
from backtest import load_pbp_peripherals  # noqa: E402
import park  # noqa: E402

# ── components ───────────────────────────────────────────────────────
BAT = ["k_pct", "bb_pct", "hbp_pct", "hr_pa", "iso", "babip", "woba"]
PIT = ["k_pct", "bb_pct", "hr_bf", "babip_against", "er_rate", "whip_rate"]
# which column holds each component's denominator (events)
DENOM = {"bat": {"k_pct": "pa", "bb_pct": "pa", "hbp_pct": "pa", "hr_pa": "pa", "iso": "ab",
                 "babip": "bip", "woba": "pa"},
         "pit": {"k_pct": "bf", "bb_pct": "bf", "hr_bf": "bf", "babip_against": "bip",
                 "er_rate": "bf", "whip_rate": "bf"}}


def dn(side, stat):
    return DENOM[side][stat]
PBP_BAT = ["p_whiff", "p_swing", "p_gb", "p_ld", "p_fb", "p_airpull"]
PBP_PIT = ["p_strike", "p_whiff", "p_gb", "p_fb"]
# peripheral -> components it may move, with the required sign of the effect
# on the component (a higher whiff rate can only raise K%, etc.)
REFINE_BAT = {"k_pct": {"p_whiff": +1, "p_swing": +1}, "bb_pct": {"p_swing": -1, "p_whiff": -1},
              "iso": {"p_airpull": +1, "p_fb": +1}, "hr_pa": {"p_airpull": +1, "p_fb": +1},
              "babip": {"p_ld": +1, "p_gb": +1, "p_fb": -1}}
REFINE_PIT = {"k_pct": {"p_whiff": +1, "p_strike": +1}, "bb_pct": {"p_strike": -1},
              "hr_bf": {"p_fb": +1, "p_gb": -1}, "er_rate": {"p_whiff": -1, "p_strike": -1, "p_gb": -1}}

import os as _os
RECENCY = {1: 5.0, 2: 4.0, 3: 3.0}
TRANSLATED_DISCOUNT = float(_os.getenv("V2_TRANS_DISCOUNT", "0.80"))   # a translated season counts this much
OFFSET_SCALE = float(_os.getenv("V2_OFFSET_SCALE", "1.0"))            # scale on level offsets (tuning knob)
PRIOR_MODE = _os.getenv("V2_PRIOR", "normal")                           # "normal" | "mixture" (elite / regular)
PT_COVARIATE = _os.getenv("V2_PT", "0") == "1"                          # playing-time term in the prior (backtest-neutral; off)
CALIBRATE = _os.getenv("V2_CALIB", "0") == "1"                          # piecewise (above/below prior) slope calibration (off: no gain)
AGE_PER_ROW = _os.getenv("V2_AGEROW", "1") == "1"
# Reliability curve steepness. The backtest shows hitters with <150 PA of
# history are over-trusted (calibration slope ~0.83) and 150-600 PA hitters
# under-trusted (~1.2): the constant-M curve n/(n+M) is too flat in n. The
# ballast becomes M * (M_REF/n)^gamma, so thin samples shrink harder and
# established ones less. gamma=0 is the plain empirical-Bayes curve.
M_GAMMA = {"bat": float(_os.getenv("V2_MEXP_BAT", "0.6")), "pit": float(_os.getenv("V2_MEXP_PIT", "0"))}
M_REF = 150.0
# Talent-drift (Kalman) mode. Each player's true talent is an AR(1) state:
# theta_t = phi * theta_{t-1} + innovation, observed each season through a
# one-season effect (health, role, lineup, park-within-season: variance
# sig_s2, NOT sampling noise) plus sampling noise ev/n. Same-level pair
# covariances decay with the gap (wOBA ~0.82 at 1 season, ~0.67 at 3;
# pitcher ER/BF ~0.48 / ~0.31), which a constant-talent model cannot
# represent: it over-trusts one big season and under-trusts a long record.
DRIFT = _os.getenv("V2_DRIFT", "1") == "1"
# Joint (multivariate) shrinkage of the component vector. Component talents
# are correlated (power hitters strike out and walk more, high-K pitchers
# allow fewer hits), so shrinking each alone ignores the information the
# other components carry and over-compresses the rebuilt headline (wOBA
# from components was calibrated at 1.29 with drift alone).
JOINT = _os.getenv("V2_JOINT", "1") == "1"
JOINT_COMPS = {"bat": ["k_pct", "bb_pct", "hbp_pct", "hr_pa", "iso", "babip"],
               "pit": ["k_pct", "bb_pct", "hr_bf", "babip_against"]}
CORR_SHRINK = 300              # talent-correlation trust n/(n+300)
M_SCALE = {"bat": float(_os.getenv("V2_MSCALE_BAT", "1")), "pit": float(_os.getenv("V2_MSCALE_PIT", "1"))}                       # age every history season from ITS class to the target class
_rw = [float(x) for x in _os.getenv("V2_RECENCY", "5,4,3").split(",")]
RECENCY = {i + 1: w for i, w in enumerate(_rw)}
SUMMER_DISCOUNT = 0.55         # a WCL season (short, wood bat) vs a spring season
CLASS_NEXT = {"Fr": "So", "So": "Jr", "Jr": "Sr", "Sr": "Sr+", "Sr+": "Sr+"}
CLASS_ORDER = ["Fr", "So", "Jr", "Sr", "Sr+"]
COVID = {2020}
FOUR_YEAR = ("D1", "D2", "D3", "NAIA")
LEVELS = ("D1", "D2", "D3", "NAIA", "JUCO")
MIN_N_STAT = 40                # minimum sample for a season to inform constants
TIER_SHRINK = 80               # class-year offset trust n/(n+80)
TEAM_SHRINK = 150              # program offset trust n/(n+150)
AGING_SHRINK = 60              # per-level aging trust vs pooled n/(n+60)
REFINE_SHRINK = 120            # peripheral beta trust n/(n+120)
PRIOR_JUCO_D1 = {              # Zimmerman (THT 2016), JUCO regulars -> D1: treated as ~25 pairs
    "woba": -0.053, "k_pct": +0.044, "bb_pct": -0.006, "iso": -0.045,
}
PRIOR_JUCO_D1_N = 25
WOBA_W = {"bb": 0.69, "hbp": 0.72, "1b": 0.88, "2b": 1.25, "3b": 1.58, "hr": 2.00}
# Outcome-band multiplier on the model's own sd, calibrated so the P10-P90 band
# covers ~80% of next-season results in the 2023-2026 backtest (backtest_v2.py).
SD_CAL = {"bat": 1.56, "pit": 1.10}   # backtest_v2 implied band multipliers (drift+joint, 2026-09-29)


# ── loading ─────────────────────────────────────────────────────────
def _add_bat_cols(df):
    df["hbp_pct"] = df["hbp"] / df["pa"].clip(lower=1)
    df["bip"] = (df["ab"] - df["k"] - df["hr"] + df["sf"]).clip(lower=0)
    df["n_contact"] = (df["ab"] - df["k"] + df["sf"]).clip(lower=0)
    # per-event second moments, for sampling variance of the non-binary stats
    df["iso_m2"] = (df["d2"] + 4 * df["d3"] + 9 * df["hr"]) / df["ab"].clip(lower=1)
    s1 = df["h"] - df["d2"] - df["d3"] - df["hr"]
    w = WOBA_W
    df["woba_m2"] = (w["bb"] ** 2 * df["bb"] + w["hbp"] ** 2 * df["hbp"] + w["1b"] ** 2 * s1
                     + w["2b"] ** 2 * df["d2"] + w["3b"] ** 2 * df["d3"] + w["hr"] ** 2 * df["hr"]) / df["pa"].clip(lower=1)
    return df


def _add_pit_cols(df):
    # Data guard: some NWAC season rows carry a batters-faced count that does
    # not match the line (2026: Pevny 282 BF on 13 IP, Gutierrez 359 BF on 0.1
    # IP). Rebuild BF from outs + H + BB + HBP when the stored value is off by
    # more than 20%, and drop rows that are internally impossible.
    if "outs" in df.columns and "ha" in df.columns:
        est = df["outs"] + df["ha"] + df["bb"] + df["hb"]
        ratio = df["bf"] / est.clip(lower=1)
        bad = (ratio < 0.8) | (ratio > 1.25)
        fixable = bad & (df["outs"] >= 9)
        df = df[~(bad & ~fixable)].copy()
        est = df["outs"] + df["ha"] + df["bb"] + df["hb"]
        ratio = df["bf"] / est.clip(lower=1)
        fixable = ((ratio < 0.8) | (ratio > 1.25)) & (df["outs"] >= 9)
        df.loc[fixable, "bf"] = est[fixable]
        df["k_pct"] = df["k"] / df["bf"].clip(lower=1)
        df["bb_pct"] = df["bb"] / df["bf"].clip(lower=1)
        df["hr_bf"] = df["hr"] / df["bf"].clip(lower=1)
        df["whip_rate"] = (df["ha"] + df["bb"]) / df["bf"].clip(lower=1)
        if "er" in df.columns:
            df["era_rate"] = df["er"] / df["bf"].clip(lower=1)
        df["wt_n"] = df["bf"]
    df["bip"] = (df["bf"] - df["k"] - df["bb"] - df["hb"] - df["hr"]).clip(lower=0)
    df["babip_against"] = np.where(df["bip"] >= 15, (df["ha"] - df["hr"]) / df["bip"].clip(lower=1), np.nan)
    if "era_rate" in df.columns:
        df["er_rate"] = df["era_rate"]          # derive_constants names it era_rate
    return df


def load_spring(cur, min_n=1):
    """Spring rows for both sides with team ids, class per season and park info."""
    bat = _add_bat_cols(load_batting(cur, min_pa=min_n))
    pit = _add_pit_cols(load_pitching(cur, min_bf=min_n))
    # team_id per (raw_pid, season) side
    for side, tbl, df in (("bat", "batting_stats", bat), ("pit", "pitching_stats", pit)):
        cur.execute(f"SELECT player_id, season, team_id FROM {tbl}")
        lookup = {}
        for r in cur.fetchall():
            lookup.setdefault((r["player_id"], r["season"]), r["team_id"])
        df["team_id"] = [lookup.get((int(a), int(b))) for a, b in zip(df["raw_pid"], df["season"])]
    cur.execute("SELECT id, bats FROM players")
    bats = {r["id"]: (r["bats"] or "").upper()[:1] for r in cur.fetchall()}
    bat["bats"] = bat["raw_pid"].map(bats)
    return bat, pit


def load_summer(cur):
    """Linked WCL seasons keyed to the spring canonical id, both sides, level 'WCL'."""
    cur.execute("""
        WITH canon AS (SELECT linked_id AS player_id, canonical_id FROM player_links)
        SELECT COALESCE(c.canonical_id, l.spring_player_id) AS pid, sb.season,
               sb.plate_appearances AS pa, sb.at_bats AS ab, sb.hits AS h,
               sb.doubles AS d2, sb.triples AS d3, sb.home_runs AS hr,
               sb.walks AS bb, sb.strikeouts AS k, sb.hit_by_pitch AS hbp,
               sb.sacrifice_flies AS sf
        FROM summer_player_links l
        JOIN summer_batting_stats sb ON sb.player_id = l.summer_player_id
        JOIN summer_teams st ON st.id = sb.team_id AND st.league_id = 1
        LEFT JOIN canon c ON c.player_id = l.spring_player_id
        WHERE sb.plate_appearances >= 25
    """)
    sb = pd.DataFrame(cur.fetchall())
    if not sb.empty:
        for c in sb.columns:
            if c != "pid":
                sb[c] = pd.to_numeric(sb[c], errors="coerce").fillna(0)
        sb["k_pct"] = sb["k"] / sb["pa"]; sb["bb_pct"] = sb["bb"] / sb["pa"]
        sb["hr_pa"] = sb["hr"] / sb["pa"]
        sb["iso"] = (sb["d2"] + 2 * sb["d3"] + 3 * sb["hr"]) / sb["ab"].clip(lower=1)
        s1 = sb["h"] - sb["d2"] - sb["d3"] - sb["hr"]
        w = WOBA_W
        sb["woba"] = (w["bb"] * sb["bb"] + w["hbp"] * sb["hbp"] + w["1b"] * s1 + w["2b"] * sb["d2"]
                      + w["3b"] * sb["d3"] + w["hr"] * sb["hr"]) / sb["pa"].clip(lower=1)
        sb = _add_bat_cols(sb)
        sb["babip"] = np.where(sb["bip"] >= 15, (sb["h"] - sb["hr"]) / sb["bip"].clip(lower=1), np.nan)
        sb["level"] = "WCL"; sb["wt_n"] = sb["pa"]; sb["cls"] = None
        sb["team_id"] = None; sb["raw_pid"] = sb["pid"]; sb["bats"] = None
    cur.execute("""
        WITH canon AS (SELECT linked_id AS player_id, canonical_id FROM player_links)
        SELECT COALESCE(c.canonical_id, l.spring_player_id) AS pid, sp.season,
               sp.batters_faced AS bf, sp.strikeouts AS k, sp.walks AS bb,
               sp.home_runs_allowed AS hr, sp.hits_allowed AS ha, sp.hit_batters AS hb,
               sp.earned_runs AS er, sp.innings_pitched AS ip_notation
        FROM summer_player_links l
        JOIN summer_pitching_stats sp ON sp.player_id = l.summer_player_id
        JOIN summer_teams st ON st.id = sp.team_id AND st.league_id = 1
        LEFT JOIN canon c ON c.player_id = l.spring_player_id
        WHERE sp.batters_faced >= 25
    """)
    sp = pd.DataFrame(cur.fetchall())
    if not sp.empty:
        for c in sp.columns:
            if c != "pid":
                sp[c] = pd.to_numeric(sp[c], errors="coerce").fillna(0)
        sp["k_pct"] = sp["k"] / sp["bf"]; sp["bb_pct"] = sp["bb"] / sp["bf"]
        sp["hr_bf"] = sp["hr"] / sp["bf"]
        sp = _add_pit_cols(sp)
        sp["babip_against"] = np.where(sp["bip"] >= 15, (sp["ha"] - sp["hr"]) / sp["bip"].clip(lower=1), np.nan)
        sp["whip_rate"] = (sp["ha"] + sp["bb"]) / sp["bf"]
        sp["er_rate"] = sp["er"] / sp["bf"]
        sp["level"] = "WCL"; sp["wt_n"] = sp["bf"]; sp["cls"] = None
        sp["team_id"] = None; sp["raw_pid"] = sp["pid"]
    return sb, sp


def load_pbp(cur):
    b = load_pbp_peripherals(cur, "bat")
    p = load_pbp_peripherals(cur, "pit")
    return b, p


# ── environment: league means, centering, park ───────────────────────
def league_means(df, stats, side):
    out = {}
    for (lv, ssn), g in df.groupby(["level", "season"]):
        g = g[g["wt_n"] >= MIN_N_STAT]
        d = {}
        for s in stats:
            v = g[s].dropna()
            if len(v) >= 8:
                d[s] = float(np.average(v, weights=g.loc[v.index, dn(side, s)].clip(lower=1)))
        out[(lv, ssn)] = d
    return out


def env_mean(means, level, season, stat):
    """Most recent available league mean for (level, stat) at or before season."""
    for back in range(0, 6):
        d = means.get((level, season - back))
        if d and stat in d:
            return d[stat]
    return None


def _park_adjust(df, side):
    """De-park: divide HR-ish rates by the home park's HR multiplier and
    BABIP/ER-ish rates by the run multiplier (each already at home share)."""
    df = df.copy()
    if side == "bat":
        hm = np.array([park.hr_mult(int(t), b, None) if pd.notna(t) else 1.0 for t, b in zip(df["team_id"], df["bats"])])
        rm = np.array([park.run_mult(int(t)) if pd.notna(t) else 1.0 for t in df["team_id"]])
        df["hr_pa"] = df["hr_pa"] / hm
        df["iso"] = df["iso"] / np.sqrt(hm)          # ISO is ~half HR-driven
        df["babip"] = df["babip"] / np.sqrt(rm)
        df["woba"] = df["woba"] / np.power(rm, 0.6)  # wOBA moves ~60% as much as runs
    else:
        rm = np.array([park.run_mult(int(t)) if pd.notna(t) else 1.0 for t in df["team_id"]])
        hm = np.array([park.pit_hr_mult(int(t)) if pd.notna(t) else 1.0 for t in df["team_id"]])
        df["hr_bf"] = df["hr_bf"] / hm
        df["er_rate"] = df["er_rate"] / rm
        df["babip_against"] = df["babip_against"] / np.sqrt(rm)
        df["whip_rate"] = df["whip_rate"] / np.sqrt(rm)
    return df


def center(df, stats, means):
    df = df.copy()
    for s in stats:
        mu = np.array([ (means.get((lv, ssn)) or {}).get(s, np.nan) for lv, ssn in zip(df["level"], df["season"]) ], dtype=float)
        df[f"{s}_c"] = df[s] - mu
    return df


# ── sampling variance per event ──────────────────────────────────────
def samp_var(row, stat):
    """Variance of ONE event for this stat, from the row's own rates."""
    v = row.get(stat)
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return np.nan
    if stat == "iso":
        return max(row.get("iso_m2", 0.0) - v * v, 1e-4)
    if stat == "woba":
        return max(row.get("woba_m2", 0.0) - v * v, 1e-4)
    if stat in ("er_rate", "whip_rate"):
        return max(1.3 * v, 1e-4)      # runs/baserunners per BF are over-dispersed counts
    p = min(max(v, 0.005), 0.995)
    return p * (1 - p)


def _row_ev(row, stat):
    """samp_var for the drift filter: NaN (caller falls back to the pooled
    per-event variance) when the row lacks the second-moment column the
    stat needs. Summer rows carry no woba_m2/iso_m2; without this guard
    samp_var floors at 1e-4 and the filter trusts a WCL season ~fully."""
    if stat in ("iso", "woba"):
        m2 = row.get(f"{stat}_m2")
        if m2 is None or (isinstance(m2, float) and math.isnan(m2)) or m2 <= 0:
            return np.nan
    return samp_var(row, stat)


def _weights(df, stat, side):
    n = df[dn(side, stat)].clip(lower=1).to_numpy(float)
    return n


# ── constants (fit on training seasons only) ─────────────────────────
def fit_constants(bat, pit, summer_bat, summer_pit, target):
    """Everything the projection needs, fit on seasons < target."""
    C = {"target": target}
    for side, df, sdf, stats in (("bat", bat, summer_bat, BAT), ("pit", pit, summer_pit, PIT)):
        train = df[(df["season"] < target)].copy()
        strain = sdf[sdf["season"] < target].copy() if sdf is not None and not sdf.empty else sdf
        train = _park_adjust(train, side)
        means = league_means(train, stats, side)
        smeans = league_means(strain, stats, side) if strain is not None and not strain.empty else {}
        means.update(smeans)
        tc = center(train, stats, means)
        sc = center(strain, stats, means) if strain is not None and not strain.empty else strain
        q = tc[tc["wt_n"] >= MIN_N_STAT]
        C[side] = {
            "means": means, "train_c": tc, "summer_c": sc,
            "ballast": _ballasts(q, stats, side),
            "tier": _tier_offsets(q, stats, side),
            "team": _team_offsets(q, stats, target, side),
            "aging": _aging(q, stats, side),
            "pt_slope": _pt_slopes(tc, stats, side),
            "mixture": _mixture_priors(q, stats, side),
            "calib": _calibration(q, stats, side),
        }
        C[side]["drift"] = _drift_tune(q, stats, side, C[side]["ballast"])
        C[side]["talent_cov"] = _talent_cov(q, JOINT_COMPS[side], C[side]["drift"])
        C[side]["offsets"] = _level_offsets(q, sc, stats, C[side]["aging"], side)
    return C


def _ballasts(q, stats, side):
    """Method of moments per (level, stat): M = E[per-event var] / Var(true)."""
    out = {}
    groups = [("ALL", q)] + [(lv, g) for lv, g in q.groupby("level")]
    for lv, g in groups:
        for s in stats:
            sub = g.dropna(subset=[f"{s}_c"])
            if len(sub) < 40:
                continue
            n = _weights(sub, s, side)
            c = sub[f"{s}_c"].to_numpy(float)
            ev = np.array([samp_var(r, s) for _, r in sub.iterrows()], dtype=float)
            ok = ~np.isnan(ev)
            n, c, ev = n[ok], c[ok], ev[ok]
            if len(c) < 40:
                continue
            var_obs = float(np.average((c - np.average(c, weights=n)) ** 2, weights=n))
            noise = float(np.average(ev / n, weights=n))
            var_true = max(var_obs - noise, 0.15 * var_obs)   # never let noise eat everything
            M = float(np.average(ev, weights=n)) / var_true
            out[(lv, s)] = {"M": float(np.clip(M, 15, 5000)), "var_true": var_true,
                            "sd_true": math.sqrt(var_true), "n": int(len(c))}
    return out


def ballast(C, side, level, stat):
    b = C[side]["ballast"]
    return (b.get((level, stat)) or b.get(("ALL", stat)) or {"M": 200, "var_true": 1e-4, "sd_true": 0.01})


def _mixture_priors(q, stats, side):
    """Two-component talent prior per stat (pooled across levels, centered
    space), fit by a deconvolution EM that knows each season's sampling
    noise. Elite players are not just the tail of one bell curve: the
    backtest shows one-mean shrinkage over-regresses the top decile
    (Jensen, McShane & Wyner 2009 found the same for MLB HR rates). Each
    component k has mean mu_k, talent sd tau_k and weight pi_k; the
    projection then shrinks toward a responsibility-weighted blend.
    Returns {stat: [(pi, mu, tau2), (pi, mu, tau2)]} sorted regular first."""
    out = {}
    for s in stats:
        sub = q.dropna(subset=[f"{s}_c"])
        if len(sub) < 200:
            continue
        x = sub[f"{s}_c"].to_numpy(float)
        n = sub[dn(side, s)].to_numpy(float).clip(min=1)
        ev = np.array([samp_var(r, s) for _, r in sub.iterrows()], dtype=float)
        ok = ~np.isnan(ev)
        x, n, ev = x[ok], n[ok], ev[ok]
        v = ev / n                                   # per-season noise variance
        w = n / n.mean()
        # init: regular = bulk, elite = the good tail (sign-aware: lower is better for some)
        better_high = s not in ("k_pct", "er_rate", "whip_rate", "hr_bf", "bb_pct", "babip_against") if side == "bat" else s in ()
        if side == "pit":
            better_high = s in ("k_pct",)
        if side == "bat" and s in ("k_pct",):
            better_high = False
        q80 = np.quantile(x, 0.8 if better_high else 0.2)
        mu = np.array([np.average(x, weights=w), q80]); tau2 = np.array([np.var(x) * 0.5, np.var(x) * 0.5]); pi = np.array([0.85, 0.15])
        for _ in range(60):
            # E-step
            dens = np.stack([pi[k] * np.exp(-0.5 * (x - mu[k]) ** 2 / (tau2[k] + v)) / np.sqrt(tau2[k] + v) for k in range(2)])
            dens = dens / np.maximum(dens.sum(axis=0, keepdims=True), 1e-300)
            # M-step (weighted by sample size)
            for k in range(2):
                r = dens[k] * w
                sr = r.sum()
                if sr <= 1e-9:
                    continue
                mu[k] = (r * x).sum() / sr
                tau2[k] = max(((r * ((x - mu[k]) ** 2 - v)).sum() / sr), 0.10 * np.var(x))
            pi = np.maximum(dens.mean(axis=1), 0.02); pi = pi / pi.sum()
        comps = sorted(zip(pi, mu, tau2), key=lambda t: -t[0])   # regular (bigger weight) first
        out[s] = [(float(a), float(b), float(c)) for a, b, c in comps]
    return out


def _drift(q, stats, side, ballasts):
    """AR(1) talent + season-effect decomposition per stat (pooled levels).

    Same-level pair covariance at gap g is tau2 * phi^g; the cross-sectional
    sampling-free variance (ballast var_true) is tau2 + sig_s2. Weighted
    least squares on log cov vs gap (gaps 1..3), phi clipped to [0.5, 1].
    Returns {stat: {"phi", "tau2", "sig_s2"}}."""
    out = {}
    for s in stats:
        b = ballasts.get(("ALL", s))
        if not b:
            continue
        gs, cs, ws = [], [], []
        for gap in (1, 2, 3):
            p = _pairs(q, gap=gap)
            p = p[p["level_1"] == p["level_2"]].dropna(subset=[f"{s}_c_1", f"{s}_c_2"])
            if len(p) < 60:
                continue
            w = p["hn"].to_numpy(float)
            a = p[f"{s}_c_1"].to_numpy(float); c = p[f"{s}_c_2"].to_numpy(float)
            cov = float(np.average((a - np.average(a, weights=w)) * (c - np.average(c, weights=w)), weights=w))
            if cov <= 0:
                continue
            gs.append(gap); cs.append(math.log(cov)); ws.append(math.sqrt(len(p)))
        if len(gs) >= 2:
            X = np.column_stack([np.ones(len(gs)), np.array(gs, float)]); W = np.array(ws)
            coef, *_ = np.linalg.lstsq(X * W[:, None], np.array(cs) * W, rcond=None)
            phi = float(np.clip(math.exp(coef[1]), 0.5, 1.0))
            tau2 = float(min(math.exp(coef[0]), b["var_true"]))
        elif gs:
            phi, tau2 = 0.9, float(min(math.exp(cs[0]) / 0.9, b["var_true"]))
        else:
            phi, tau2 = 1.0, b["var_true"]
        tau2 = max(tau2, 0.25 * b["var_true"])
        out[s] = {"phi": phi, "tau2": tau2, "sig_s2": max(b["var_true"] - tau2, 0.0)}
    return out


def _drift_tune(q, stats, side, ballasts):
    """Choose each stat's drift parameters by PREDICTIVE fit, not moments.

    Pair covariances at longer gaps come from the players who lasted, so the
    moment estimates of phi/sig_s2 are confounded by survival. Instead: for
    every (player, level) sequence in the training data, run the filter
    through the seasons in order and score its one-step-ahead prediction of
    each season (>= MIN_N_STAT) against what happened, sample-weighted.
    Grid over persistence phi, the season-effect share of sampling-free
    variance, and a scale on that variance (the constant-talent empirical
    Bayes model is the phi=1, share=0, scale=1 corner). Returns
    {stat: {"phi", "tau2", "sig_s2", "mse", "mse_const"}}."""
    out = {}
    qq = q[~q["season"].isin(COVID)]
    for s in stats:
        b = ballasts.get(("ALL", s))
        if not b:
            continue
        sub = qq.dropna(subset=[f"{s}_c"])
        nn = sub[dn(side, s)].clip(lower=1).to_numpy(float)
        seq = {}
        for pid, lv, se, x, n in zip(sub["pid"], sub["level"], sub["season"], sub[f"{s}_c"].to_numpy(float), nn):
            seq.setdefault((pid, lv), []).append((int(se), float(x), float(n)))
        seqs = [sorted(v) for v in seq.values() if len(v) >= 2]
        if len(seqs) < 100:
            continue
        L = max(len(v) for v in seqs); N = len(seqs)
        S = np.full((N, L), np.nan); X = np.zeros((N, L)); NN = np.ones((N, L))
        for i, v in enumerate(seqs):
            for j, (se, x, n) in enumerate(v):
                S[i, j] = se; X[i, j] = x; NN[i, j] = n
        ev = b["M"] * b["var_true"]; vt = b["var_true"]
        best = None; mse_const = None
        for phi in (0.8, 0.85, 0.9, 0.95, 1.0):
            for share in (0.0, 0.15, 0.3, 0.5):
                for scale in (0.7, 1.0, 1.4, 2.0):
                    for gamma in (0.0, 0.3, 0.6):
                        # gamma inflates a thin season's noise by (M_REF/n)^gamma:
                        # part-time samples are less informative than their PA
                        # count says (role, matchups, garbage time)
                        tau2 = vt * scale * (1 - share); sig = vt * scale * share
                        m = np.zeros(N); P = np.full(N, tau2); last = S[:, 0].copy()
                        sse = 0.0; sw = 0.0
                        for j in range(L):
                            valid = ~np.isnan(S[:, j])
                            if j > 0:
                                g = np.where(valid, S[:, j] - last, 1.0)
                                pg = phi ** g
                                m_pred = m * pg; P_pred = pg ** 2 * P + tau2 * (1 - pg ** 2)
                                sc = valid & (NN[:, j] >= MIN_N_STAT)
                                err = X[:, j] - m_pred
                                sse += float(np.sum(NN[sc, j] * err[sc] ** 2)); sw += float(np.sum(NN[sc, j]))
                                m = np.where(valid, m_pred, m); P = np.where(valid, P_pred, P)
                            R = (sig + ev / NN[:, j]) * (M_REF / NN[:, j]) ** gamma
                            K = P / (P + R)
                            m = np.where(valid, m + K * (X[:, j] - m), m)
                            P = np.where(valid, (1 - K) * P, P)
                            last = np.where(valid, S[:, j], last)
                        mse = sse / max(sw, 1.0)
                        if phi == 1.0 and share == 0.0 and scale == 1.0 and gamma == 0.0:
                            mse_const = mse
                        if best is None or mse < best[0]:
                            best = (mse, phi, tau2, sig, gamma)
        out[s] = {"phi": best[1], "tau2": best[2], "sig_s2": best[3], "gamma": best[4],
                  "mse": best[0], "mse_const": mse_const}
    return out


def _talent_cov(q, comps, drift):
    """Persistent-talent covariance across components.

    Sampling noise is independent across seasons, so the lagged cross-
    covariance cov(x_i season t, x_j season t+1) = phi_j * Sigma_T[i, j] is
    free of it. Symmetrize, convert to correlations (shrunk n/(n+300) toward
    zero, clipped to +-0.9), then rebuild with the tuned per-stat tau2 on the
    diagonal and force positive-definiteness. Returns the k x k matrix (None
    if any component lacks drift parameters)."""
    if any(c not in drift for c in comps):
        return None
    k = len(comps)
    p = _pairs(q)
    p = p[p["level_1"] == p["level_2"]]
    raw = np.zeros((k, k)); cnt = np.zeros((k, k))
    for i, a in enumerate(comps):
        for j, c in enumerate(comps):
            sub = p.dropna(subset=[f"{a}_c_1", f"{c}_c_2"])
            if len(sub) < 50:
                continue
            w = sub["hn"].to_numpy(float)
            x = sub[f"{a}_c_1"].to_numpy(float); y = sub[f"{c}_c_2"].to_numpy(float)
            raw[i, j] = np.average((x - np.average(x, weights=w)) * (y - np.average(y, weights=w)), weights=w) / max(drift[c]["phi"], 0.5)
            cnt[i, j] = len(sub)
    sym = (raw + raw.T) / 2
    d = np.sqrt(np.maximum(np.diag(sym), 1e-12))
    rho = sym / np.outer(d, d)
    n = (cnt + cnt.T) / 2
    rho = rho * (n / (n + CORR_SHRINK))
    rho = np.clip(rho, -0.9, 0.9); np.fill_diagonal(rho, 1.0)
    tau = np.array([math.sqrt(drift[c]["tau2"]) for c in comps])
    S = rho * np.outer(tau, tau)
    w, V = np.linalg.eigh(S)
    w = np.maximum(w, 1e-4 * w.max())
    S = V @ np.diag(w) @ V.T
    return (S + S.T) / 2


def _blend_ev(ev, n_w, ev_default):
    if ev is None or (isinstance(ev, float) and math.isnan(ev)):
        return ev_default
    return (n_w * ev + 100.0 * ev_default) / (n_w + 100.0)


def _kalman_joint(groups, comps, priors, drift, Sigma, ev_defaults, target_season):
    """Multivariate AR(1) filter over the component vector.

    groups: {(season, order): {stat: (x, n_w, ev)}} one entry per history
    row (spring or summer). Missing components in a row are simply not
    observed that step. Returns {stat: (est, rel, var)}."""
    k = len(comps); idx = {c: i for i, c in enumerate(comps)}
    phi = np.array([drift[c]["phi"] for c in comps])
    sig = np.array([drift[c]["sig_s2"] for c in comps])
    m = np.zeros(k); P = Sigma.copy(); last = None
    for key in sorted(groups):
        season = key[0]
        if last is not None and season > last:
            pg = phi ** (season - last); F = np.diag(pg)
            m = pg * m
            P = F @ P @ F + (Sigma - F @ Sigma @ F)
        rows = {c: v for c, v in groups[key].items() if c in idx}
        if not rows:
            continue
        ii = [idx[c] for c in rows]
        z = np.array([rows[c][0] - priors[c] for c in rows])
        Rd = np.array([(sig[idx[c]] + _blend_ev(rows[c][2], rows[c][1], ev_defaults[c]) / max(rows[c][1], 1e-6))
                       * (M_REF / max(rows[c][1], 1.0)) ** drift[c].get("gamma", 0.0) for c in rows])
        H = np.zeros((len(ii), k)); H[np.arange(len(ii)), ii] = 1.0
        Sm = H @ P @ H.T + np.diag(Rd)
        K = P @ H.T @ np.linalg.inv(Sm)
        m = m + K @ (z - H @ m)
        P = (np.eye(k) - K @ H) @ P
        P = (P + P.T) / 2
        last = season
    if last is not None:
        pg = phi ** max(target_season - last, 1); F = np.diag(pg)
        m = pg * m
        P = F @ P @ F + (Sigma - F @ Sigma @ F)
    out = {}
    for c, i in idx.items():
        t2 = max(Sigma[i, i], 1e-12)
        rel = 1 - P[i, i] / t2
        out[c] = (priors[c] + m[i], max(0.0, min(1.0, rel)), max(P[i, i], 0.0) + sig[i])
    return out


def _kalman(obs, prior, d, ev_default, target_season):
    """Run the AR(1) filter over obs = [(season, x, n_w, ev)] (x centered and
    already translated/aged, n_w = discounted sample). Returns (est, rel, var)."""
    phi, tau2, sig = d["phi"], d["tau2"], d["sig_s2"]
    m, P, last = 0.0, tau2, None
    for season, x, n_w, ev in sorted(obs, key=lambda o: o[0]):
        if last is not None and season > last:
            g = season - last
            m *= phi ** g
            P = (phi ** (2 * g)) * P + tau2 * (1 - phi ** (2 * g))
        # per-event variance: the row's own (heteroskedastic) estimate is
        # degenerate for tiny samples (a 6-PA hitter who struck out every
        # time gets p(1-p) ~ 0), so blend it with the pooled value, n/(n+100)
        ev = _blend_ev(ev, n_w, ev_default)
        R = (sig + ev / max(n_w, 1e-6)) * (M_REF / max(n_w, 1.0)) ** d.get("gamma", 0.0)
        K = P / (P + R)
        m += K * ((x - prior) - m)
        P = (1 - K) * P
        last = season
    if last is not None:
        g = max(target_season - last, 1)
        m *= phi ** g
        P = (phi ** (2 * g)) * P + tau2 * (1 - phi ** (2 * g))
    rel = 1 - P / tau2 if tau2 > 0 else 0.0
    return prior + m, max(0.0, min(1.0, rel)), P + sig


def _calibration(q, stats, side):
    """Asymmetric calibration of the shrunk estimate. The talent distribution
    is not a symmetric bell: the backtest shows the top decile beats its
    projection by ~.015 wOBA while the bottom decile is on target, i.e. one
    ballast over-regresses the good tail. Fit, on consecutive same-level
    seasons, next season's centered rate on the one-season shrunk estimate
    with separate slopes above and below zero; slopes are shrunk toward 1.
    Returns {stat: (slope_below, slope_above)}."""
    out = {}
    p = _pairs(q)
    p = p[p["level_1"] == p["level_2"]]
    for s in stats:
        sub = p.dropna(subset=[f"{s}_c_1", f"{s}_c_2"])
        if len(sub) < 200:
            continue
        n1 = sub[f"{dn(side, s)}_1"].to_numpy(float).clip(min=1)
        n2 = sub[f"{dn(side, s)}_2"].to_numpy(float).clip(min=1)
        ev = np.array([samp_var({s: v}, s) for v in sub[f"{s}_1"].to_numpy(float)])
        c1 = sub[f"{s}_c_1"].to_numpy(float); c2 = sub[f"{s}_c_2"].to_numpy(float)
        var_obs = np.average((c1 - np.average(c1, weights=n1)) ** 2, weights=n1)
        noise = np.average(ev / n1, weights=n1)
        M = np.average(ev, weights=n1) / max(var_obs - noise, 0.15 * var_obs)
        est = c1 * n1 / (n1 + M)
        w = 2 / (1 / n1 + 1 / n2)
        X = np.column_stack([np.ones_like(est), np.minimum(est, 0), np.maximum(est, 0)])
        W = np.sqrt(w)
        coef, *_ = np.linalg.lstsq(X * W[:, None], c2 * W, rcond=None)
        k = len(sub) / (len(sub) + 300)
        lo = 1 + k * (float(coef[1]) - 1); hi = 1 + k * (float(coef[2]) - 1)
        out[s] = (float(np.clip(lo, 0.6, 1.6)), float(np.clip(hi, 0.6, 1.6)))
    return out


def _pt_slopes(tc, stats, side):
    """Playing time is confounded with talent: the players a coach gives 40 PA
    are worse than the ones he gives 200. Fit PREDICTIVELY on consecutive
    same-level seasons: next season's centered rate minus this season's
    one-season shrunk estimate, regressed on log(n this season). A slope fit
    within one season would pick up in-season selection (hot hitters get more
    at-bats) and over-penalize thin samples, which the backtest showed.
    Returns {(level, stat): (slope, log_ref)}; level 'ALL' is the pooled fit."""
    out = {}
    p = _pairs(tc[tc["wt_n"] >= 10])
    p = p[p["level_1"] == p["level_2"]]
    if p.empty:
        return out
    groups = [("ALL", p)] + [(lv, g) for lv, g in p.groupby("level_1")]
    for lv, g in groups:
        for s in stats:
            sub = g.dropna(subset=[f"{s}_c_1", f"{s}_c_2"])
            if len(sub) < 150:
                continue
            n1 = sub[f"{dn(side, s)}_1"].to_numpy(float).clip(min=1)
            n2 = sub[f"{dn(side, s)}_2"].to_numpy(float).clip(min=1)
            ev = np.array([samp_var({s: v}, s) for v in sub[f"{s}_1"].to_numpy(float)])
            c1 = sub[f"{s}_c_1"].to_numpy(float); c2 = sub[f"{s}_c_2"].to_numpy(float)
            # one-season shrunk estimate with the pooled ballast
            var_obs = np.average((c1 - np.average(c1, weights=n1)) ** 2, weights=n1)
            noise = np.average(ev / n1, weights=n1)
            M = np.average(ev, weights=n1) / max(var_obs - noise, 0.15 * var_obs)
            est1 = c1 * n1 / (n1 + M)
            resid = c2 - est1
            x = np.log(n1); w = 2 / (1 / n1 + 1 / n2)
            mx, my = np.average(x, weights=w), np.average(resid, weights=w)
            vx = np.average((x - mx) ** 2, weights=w)
            if vx <= 0:
                continue
            slope = float(np.average((x - mx) * (resid - my), weights=w) / vx)
            out[(lv, s)] = (slope * (len(sub) / (len(sub) + 200)), float(mx))
    return out


def _tier_offsets(q, stats, side):
    """Class-year offsets in centered space per (level, class)."""
    out = {}
    t = q.dropna(subset=["cls"])
    for (lv, cls), g in t.groupby(["level", "cls"]):
        for s in stats:
            v = g[f"{s}_c"].dropna()
            if len(v) >= 25:
                w = g.loc[v.index, dn(side, s)].clip(lower=1)
                off = float(np.average(v, weights=w))
                out[(lv, cls, s)] = off * (len(v) / (len(v) + TIER_SHRINK))
    return out


def _team_offsets(q, stats, target, side):
    """Program strength: a team's players' mean centered rate over the last
    three training seasons, shrunk. Lets the prior say 'LCSC hitters are
    better than the NAIA mean' instead of pulling everyone to one number."""
    out = {}
    recent = q[q["season"] >= target - 3]
    for tid, g in recent.groupby("team_id"):
        for s in stats:
            v = g[f"{s}_c"].dropna()
            if len(v) >= 8:
                w = g.loc[v.index, dn(side, s)].clip(lower=1)
                off = float(np.average(v, weights=w))
                out[(int(tid), s)] = off * (len(v) / (len(v) + TEAM_SHRINK))
    return out


def _pairs(df, gap=1):
    a = df.copy(); b = df.copy()
    p = a.merge(b, on="pid", suffixes=("_1", "_2"))
    p = p[p["season_2"] == p["season_1"] + gap]
    p = p[~p["season_1"].isin(COVID) & ~p["season_2"].isin(COVID)]
    p = p.sort_values("wt_n_1", ascending=False).drop_duplicates(["pid", "season_1"])
    p["hn"] = 2 / (1 / p["wt_n_1"] + 1 / p["wt_n_2"])
    return p


def _aging(q, stats, side):
    """Component-specific class-transition deltas (centered), per level group,
    shrunk toward the pooled delta."""
    p = _pairs(q)
    p = p[(p["level_1"] == p["level_2"])].dropna(subset=["cls_1", "cls_2"])
    p["tr"] = p["cls_1"] + "->" + p["cls_2"]
    keep = {"Fr->So", "So->Jr", "Jr->Sr", "Sr->Sr+"}
    pooled, out = {}, {}
    for tr, g in p.groupby("tr"):
        if tr not in keep:
            continue
        for s in stats:
            sub = g.dropna(subset=[f"{s}_c_1", f"{s}_c_2"])
            if len(sub) >= 25:
                pooled[(tr, s)] = (float(np.average(sub[f"{s}_c_2"] - sub[f"{s}_c_1"], weights=sub["hn"])), len(sub))
    for (grp, tr), g in p.assign(grp=np.where(p["level_1"] == "JUCO", "JUCO", "4YR")).groupby(["grp", "tr"]):
        if tr not in keep:
            continue
        for s in stats:
            sub = g.dropna(subset=[f"{s}_c_1", f"{s}_c_2"])
            pool = pooled.get((tr, s), (0.0, 0))[0]
            if len(sub) >= 15:
                d = float(np.average(sub[f"{s}_c_2"] - sub[f"{s}_c_1"], weights=sub["hn"]))
                w = len(sub) / (len(sub) + AGING_SHRINK)
                out[(grp, tr, s)] = w * d + (1 - w) * pool
            else:
                out[(grp, tr, s)] = pool
    for (tr, s), (d, n) in pooled.items():
        out.setdefault(("ALL", tr, s), d)
    return out


def aging_delta(C, side, level, cls_now, stat):
    if not cls_now or cls_now not in CLASS_NEXT:
        return 0.0
    tr = f"{cls_now}->{CLASS_NEXT[cls_now]}"
    grp = "JUCO" if level == "JUCO" else "4YR"
    a = C[side]["aging"]
    return a.get((grp, tr, stat), a.get(("ALL", tr, stat), 0.0))


_CLASS_ORD = {"Fr": 0, "So": 1, "Jr": 2, "Sr": 3, "Sr+": 4}


def _class_steps(cls_from, cls_to):
    """Number of class transitions from cls_from up to cls_to (0 if unknown/behind)."""
    a, b = _CLASS_ORD.get(cls_from), _CLASS_ORD.get(cls_to)
    if a is None or b is None:
        return 0
    return max(b - a, 0)


def _class_path_delta(C, side, level, cls, gap, stat):
    """Aging over `gap` transitions starting from class `cls` (for mover correction)."""
    d, c = 0.0, cls
    for _ in range(max(gap, 1)):
        d += aging_delta(C, side, level, c, stat)
        c = CLASS_NEXT.get(c, c) if c else c
    return d


def _level_offsets(q, sc, stats, aging_tbl, side):
    """Solve additive level offsets (centered space) per component.

    off[L] answers: a player who is +x above his league mean at level L would
    be +x + off[L] above the D1 mean. D1 = 0. Sources (each an equation with
    an inverse-variance weight):
      movers  : off[JUCO] - off[X]  = mean(c_first4yr - c_lastJUCO - aging)
      bridge  : off[L] - off[D1]    = mean(c_WCL - c_L)[D1 players] - mean(c_WCL - c_L)[L players]
      prior   : off[JUCO]           = Zimmerman JUCO->D1 (weak)
    """
    C_tmp = {side: {"aging": aging_tbl}}
    res = {}
    for s in stats:
        eqs = []   # (coef dict, value, weight)
        deltas = {}
        # movers: last JUCO season -> first 4-year season, gap <= 3
        jr = q[(q["level"] == "JUCO")].dropna(subset=[f"{s}_c"])
        fr = q[(q["level"] != "JUCO")].dropna(subset=[f"{s}_c"])
        last_j = jr.sort_values("season").groupby("pid").tail(1)
        first_f = fr.sort_values("season").groupby("pid").head(1)
        m = last_j.merge(first_f, on="pid", suffixes=("_j", "_f"))
        m = m[(m["season_f"] > m["season_j"]) & (m["season_f"] - m["season_j"] <= 3)]
        by_dest = defaultdict(list)
        for _, r in m.iterrows():
            gap = int(r["season_f"] - r["season_j"])
            ag = _class_path_delta(C_tmp, side, "JUCO", r["cls_j"] if isinstance(r["cls_j"], str) else "So", gap, s)
            d = float(r[f"{s}_c_f"] - r[f"{s}_c_j"] - ag)
            hn = 2 / (1 / max(r[f"{dn(side, s)}_j"], 1) + 1 / max(r[f"{dn(side, s)}_f"], 1))
            by_dest[r["level_f"]].append((d, hn))
        for dest, vals in by_dest.items():
            if len(vals) < 8:
                continue
            d = np.array([v[0] for v in vals]); w = np.array([v[1] for v in vals])
            mean = float(np.average(d, weights=w))
            var = float(np.average((d - mean) ** 2, weights=w)) / len(vals) + 1e-6
            coef = {"JUCO": 1.0}
            if dest != "D1":
                coef[dest] = -1.0
            eqs.append((coef, mean, 1.0 / var))
        # WCL bridge
        if sc is not None and not sc.empty and f"{s}_c" in sc.columns:
            spr = q.dropna(subset=[f"{s}_c"])
            sm = sc.dropna(subset=[f"{s}_c"])
            b = spr.merge(sm[["pid", "season", f"{s}_c", dn(side, s)]], on=["pid", "season"], suffixes=("", "_s"))
            deltas = {}
            for lv, g in b.groupby("level"):
                if len(g) < 12:
                    continue
                hn = 2 / (1 / g[dn(side, s)].clip(lower=1) + 1 / g[f"{dn(side, s)}_s"].clip(lower=1))
                d = (g[f"{s}_c_s"] - g[f"{s}_c"]).to_numpy(float)
                mean = float(np.average(d, weights=hn))
                var = float(np.average((d - mean) ** 2, weights=hn)) / len(g) + 1e-6
                deltas[lv] = (mean, var, len(g))
            if "D1" in deltas:
                d1_mean, d1_var, _ = deltas["D1"]
                for lv, (mean, var, n) in deltas.items():
                    if lv == "D1":
                        continue
                    # d_L = mean(c_WCL - c_L). A level whose players drop MORE in the
                    # WCL than D1 players do is the easier level, so its lift to
                    # D1 is negative: off[L] = d_L - d_D1.
                    eqs.append(({lv: 1.0}, mean - d1_mean, 1.0 / (var + d1_var)))
        # published prior for JUCO -> D1 (hitters only where we have it)
        if side == "bat" and s in PRIOR_JUCO_D1:
            sd = 0.06 if s in ("woba", "iso") else 0.05
            eqs.append(({"JUCO": 1.0}, PRIOR_JUCO_D1[s], PRIOR_JUCO_D1_N / sd ** 2))
        if not eqs:
            continue
        unknowns = [lv for lv in LEVELS if lv != "D1"]
        A = np.zeros((len(eqs), len(unknowns))); y = np.zeros(len(eqs)); w = np.zeros(len(eqs))
        for i, (coef, val, wt) in enumerate(eqs):
            for lv, cf in coef.items():
                if lv in unknowns:
                    A[i, unknowns.index(lv)] = cf
            y[i] = val; w[i] = wt
        # ridge toward 0 so a level with no evidence stays at "no translation"
        lam = 1.0 / (0.03 ** 2)
        AtW = A.T * w
        sol = np.linalg.solve(AtW @ A + lam * np.eye(len(unknowns)), AtW @ y)
        res[s] = {"D1": 0.0, **{lv: float(v) for lv, v in zip(unknowns, sol)}}
        # WCL as a history level: its offset relative to D1 from the bridge
        if "D1" in deltas:
            # a WCL season translated to D1: c_D1 = c_WCL - d_D1
            res[s]["WCL"] = float(-deltas["D1"][0])
    return res


def translate(C, side, from_level, to_level, stat):
    """Additive change to a centered rate when moving from_level -> to_level."""
    off = C[side]["offsets"].get(stat)
    if not off or from_level == to_level:
        return 0.0
    a = off.get(from_level, 0.0); b = off.get(to_level, 0.0)
    return (a - b) * OFFSET_SCALE


# ── peripheral refinement (fit on pairs) ─────────────────────────────
def fit_refine(C, side, df_c, pbp, target):
    """Sign-constrained univariate residual betas per (component, peripheral),
    fit on consecutive-season pairs where season 1 has PBP. Residual = next
    season's centered rate minus this engine's shrunk estimate from season 1
    alone (so the betas only carry information the box score doesn't)."""
    spec = REFINE_BAT if side == "bat" else REFINE_PIT
    feats = PBP_BAT if side == "bat" else PBP_PIT
    if pbp is None or pbp.empty:
        return {}
    d = df_c.merge(pbp, on=["pid", "season"], how="left")
    # center peripherals per level-season
    for f in feats:
        if f not in d.columns:
            d[f] = np.nan
        mu = d.groupby(["level", "season"])[f].transform(lambda v: np.nanmean(v) if v.notna().sum() >= 20 else np.nan)
        d[f"{f}_c"] = d[f] - mu
    p = _pairs(d[d["wt_n"] >= MIN_N_STAT])
    p = p[p["level_1"] == p["level_2"]]
    out = {}
    for stat, fmap in spec.items():
        sub = p.dropna(subset=[f"{stat}_c_1", f"{stat}_c_2"])
        if len(sub) < 60:
            continue
        # one-season shrunk estimate from season 1 only
        est = []
        for _, r in sub.iterrows():
            M = ballast(C, side, r["level_1"], stat)["M"]
            n = max(r[f"{dn(side, stat)}_1"], 1)
            est.append(r[f"{stat}_c_1"] * n / (n + M))
        resid = sub[f"{stat}_c_2"].to_numpy(float) - np.array(est)
        w = sub["hn"].to_numpy(float)
        for f, sign in fmap.items():
            col = f"{f}_c_1"
            if col not in sub.columns:
                continue
            ok = sub[col].notna().to_numpy()
            if ok.sum() < 60:
                continue
            x = sub.loc[ok, col].to_numpy(float); y = resid[ok]; ww = w[ok]
            mx, my = np.average(x, weights=ww), np.average(y, weights=ww)
            vx = np.average((x - mx) ** 2, weights=ww)
            if vx <= 0:
                continue
            beta = float(np.average((x - mx) * (y - my), weights=ww) / vx)
            beta = max(beta, 0.0) if sign > 0 else min(beta, 0.0)
            beta *= ok.sum() / (ok.sum() + REFINE_SHRINK)
            if beta != 0.0:
                out[(stat, f)] = (beta, int(ok.sum()))
    return out


# ── the projection ───────────────────────────────────────────────────
def project(C, side, hist, summer_hist, pbp_last, target_level, target_season,
            cls_last, dest_team_id=None, refine=None):
    """Project one player. `hist` = centered, de-parked spring rows (any level,
    seasons < target); `summer_hist` = centered WCL rows; `pbp_last` = dict of
    centered peripherals from the last season (or None).
    Returns {stat: {"c": centered proj, "value": rate at target env, "rel": reliability,
                    "sd": posterior sd of true talent, "n_eff": effective sample}}."""
    stats = BAT if side == "bat" else PIT
    out = {}
    next_cls = CLASS_NEXT.get(cls_last) if cls_last else None
    tier = C[side]["tier"]; team = C[side]["team"]
    tcls = next_cls or cls_last

    # ---- stage 1: per-stat history observations + prior ------------------
    obs_by, num_by, den_by, prior_by, ball_by = {}, {}, {}, {}, {}
    groups = {}                        # (season, row order) -> {stat: (x, n_w, ev)}
    rows = [(int(r["season"]), r, r["level"], TRANSLATED_DISCOUNT if r["level"] != target_level else 1.0)
            for _, r in hist.iterrows()]
    if summer_hist is not None:
        rows += [(int(r["season"]), r, "WCL", SUMMER_DISCOUNT) for _, r in summer_hist.iterrows()]
    for s in stats:
        num = den = 0.0
        obs = []
        for order, (season, r, lvl, disc) in enumerate(rows):
            back = target_season - season
            v = r.get(f"{s}_c")
            if (back not in RECENCY and not DRIFT) or v is None or pd.isna(v):
                continue
            n = float(max(r[dn(side, s)], 0))
            if n <= 0:
                continue
            v = v + translate(C, side, lvl, target_level, s)
            if AGE_PER_ROW and lvl != "WCL":
                # a senior-to-be's freshman season needs three class steps of
                # development, not one: age each row from its own class
                rc = r.get("cls")
                rc = rc if isinstance(rc, str) else cls_last
                steps = _class_steps(rc, cls_last)
                v = v + _class_path_delta(C, side, target_level, rc, steps + 1, s) if rc else v
            ev = _row_ev(r, s)
            obs.append((season, v, n * disc, ev))
            groups.setdefault((season, order), {})[s] = (v, n * disc, ev)
            if back in RECENCY:
                w = RECENCY[back] * n * disc
                num += w * v; den += w
        prior = 0.0
        if tcls:
            prior += tier.get((target_level, tcls, s), 0.0)
        if dest_team_id is not None:
            prior += team.get((int(dest_team_id), s), 0.0)
        # thin-sample players are worse than the class mean (playing time
        # is earned): shift the prior down by the fitted log(n) slope
        sl = C[side]["pt_slope"].get((target_level, s)) or C[side]["pt_slope"].get(("ALL", s))
        if PT_COVARIATE and sl and len(hist):
            last = hist.sort_values("season").iloc[-1]
            n_last = float(max(last.get(dn(side, s), 0) or 0, 1))
            slope, log_ref = sl
            prior += slope * (math.log(n_last) - log_ref)
        obs_by[s], num_by[s], den_by[s], prior_by[s] = obs, num, den, prior
        ball_by[s] = ballast(C, side, target_level, s)

    # ---- stage 2: joint shrinkage of the component vector -----------------
    joint = {}
    Sigma = C[side].get("talent_cov") if (DRIFT and JOINT) else None
    if Sigma is not None and groups:
        comps = JOINT_COMPS[side]
        joint = _kalman_joint(groups, comps, {c: prior_by[c] for c in comps}, C[side]["drift"], Sigma,
                              {c: ball_by[c]["M"] * ball_by[c]["var_true"] for c in comps}, target_season)

    # ---- stage 3: per-stat estimate -------------------------------------
    for s in stats:
        obs, num, den, prior, b = obs_by[s], num_by[s], den_by[s], prior_by[s], ball_by[s]
        M = b["M"] * M_SCALE[side]
        n_eff = den / RECENCY[1]
        if M_GAMMA[side] and n_eff > 0:
            M = M * (M_REF / n_eff) ** M_GAMMA[side]
        mix = C[side].get("mixture", {}).get(s) if PRIOR_MODE == "mixture" else None
        drift = C[side].get("drift", {}).get(s) if DRIFT else None
        if s in joint and obs:
            est, rel, var_post = joint[s]
            n_eff = sum(o[2] for o in obs)
        elif drift and obs:
            est, rel, var_post = _kalman(obs, prior, drift, b["M"] * b["var_true"], target_season)
            n_eff = sum(o[2] for o in obs)
        elif mix and n_eff > 0:
            # responsibility-weighted shrinkage toward each component
            xbar = num / den
            ev = float(np.average(b["var_true"] * b["M"], weights=None))  # E[per-event var] = M * var_true
            v = ev / n_eff
            post_m, post_w, post_v = [], [], []
            for pi_k, mu_k, tau2_k in mix:
                m_k = mu_k + prior
                lik = pi_k * math.exp(-0.5 * (xbar - m_k) ** 2 / (tau2_k + v)) / math.sqrt(tau2_k + v)
                shrink = tau2_k / (tau2_k + v)
                post_m.append(m_k + shrink * (xbar - m_k)); post_w.append(lik); post_v.append(tau2_k * v / (tau2_k + v))
            tw = sum(post_w) or 1.0
            wts = [x / tw for x in post_w]
            est = sum(wt * m for wt, m in zip(wts, post_m))
            rel = sum(wt * (1 - pv / t2) for wt, pv, (pi_k, mu_k, t2) in zip(wts, post_v, mix))
            rel = max(0.0, min(1.0, rel))
            var_post = sum(wt * (pv + (m - est) ** 2) for wt, pv, m in zip(wts, post_v, post_m))
        else:
            est = (num / RECENCY[1] + M * prior) / (n_eff + M) if (n_eff + M) > 0 else prior
            rel = n_eff / (n_eff + M) if (n_eff + M) > 0 else 0.0
            var_post = max(b["var_true"], 1e-8) * (1 - rel)
        # asymmetric calibration around the prior (good tail regresses less)
        if CALIBRATE:
            cal = C[side].get("calib", {}).get(s)
            if cal:
                d = est - prior
                est = prior + d * (cal[1] if d > 0 else cal[0])
        # aging: the player's own history is at his old class; move it forward
        # (already folded into each row when AGE_PER_ROW)
        if not AGE_PER_ROW:
            est += aging_delta(C, side, target_level, cls_last, s) * rel
        out[s] = {"c": est, "rel": rel, "n_eff": n_eff, "sd": math.sqrt(max(var_post, 1e-10))}
    # peripheral refinement
    if refine and pbp_last:
        for (stat, f), (beta, _n) in refine.items():
            v = pbp_last.get(f)
            if stat in out and v is not None and not pd.isna(v):
                out[stat]["c"] += beta * v
    # anchor to the destination environment
    means = C[side]["means"]
    for s in stats:
        mu = env_mean(means, target_level, target_season - 1, s)
        out[s]["value"] = (out[s]["c"] + mu) if mu is not None else None
    return out


# ── reconstruction ───────────────────────────────────────────────────
def reconstruct_bat(p, sf_rate=0.02, sh_rate=0.01, park_hr=1.0, park_run=1.0):
    """Slash line from components. p = {stat: value}. Applies the destination
    park (HR multiplier, run multiplier) on the way out."""
    k = np.clip(p["k_pct"], 0.02, 0.50); bb = np.clip(p["bb_pct"], 0.01, 0.30)
    hbp = np.clip(p.get("hbp_pct", 0.025), 0.0, 0.08)
    hr_pa = max(p["hr_pa"], 0.0) * park_hr
    iso = max(p["iso"], 0.0) * math.sqrt(park_hr)
    babip = np.clip(p["babip"], 0.18, 0.45) * math.sqrt(park_run)
    ab_share = max(1 - bb - hbp - sf_rate - sh_rate, 0.5)
    bip_share = max(ab_share - k - hr_pa + sf_rate, 0.05)
    h_pa = hr_pa + babip * bip_share
    avg = h_pa / ab_share
    # extra bases: ISO per AB; HR are 3 each, the rest split 2B/3B ~ 6:1
    xb_pa = iso * ab_share
    non_hr_xb = max(xb_pa - 3 * hr_pa, 0.0)
    d3_pa = non_hr_xb / 8.0          # 2B + 2*3B = non_hr_xb with 3B = 2B/6  -> 2B = 6t, 3B = t, 6t+2t = 8t
    d2_pa = 6 * d3_pa
    s1_pa = max(h_pa - hr_pa - d2_pa - d3_pa, 0.0)
    obp = (h_pa + bb + hbp) / max(1 - sh_rate, 0.5)
    slg = avg + iso
    w = WOBA_W
    woba = (w["bb"] * bb + w["hbp"] * hbp + w["1b"] * s1_pa + w["2b"] * d2_pa + w["3b"] * d3_pa + w["hr"] * hr_pa)
    return {"AVG": avg, "OBP": obp, "SLG": slg, "wOBA": woba, "iso": iso, "hr_pa": hr_pa,
            "k_pct": k, "bb_pct": bb, "babip": babip, "d2_pa": d2_pa, "d3_pa": d3_pa,
            "s1_pa": s1_pa, "h_pa": h_pa, "ab_share": ab_share}


def fit_run_model(train_c, means):
    """ER/BF ~ K% + BB% + HR/BF on raw training rows (FIP-style weights)."""
    f = train_c.dropna(subset=["er_rate", "k_pct", "bb_pct", "hr_bf"])
    f = f[f["bf"] >= 60]
    X = np.column_stack([f["k_pct"], f["bb_pct"], f["hr_bf"], np.ones(len(f))])
    w = np.sqrt(f["bf"].to_numpy(float))
    coef, *_ = np.linalg.lstsq(X * w[:, None], f["er_rate"].to_numpy(float) * w, rcond=None)
    return coef


def fit_run_model_talent(train_c, means, drift, ballasts):
    """Run-model coefficients for PROJECTED (talent-scale) K/BB/HR.

    fit_run_model regresses a season's ER/BF on that season's OBSERVED
    rates, which is the right thing for FIP-style accounting on actual
    seasons (luck, last-season FIP). Applied to shrunk projections those
    weights are ~20% too weak (the backtest showed actual ER responding
    1.2x more strongly to projected than to observed components). Here:
    next season's ER/BF regressed on this season's one-step shrunk
    estimates (same shrink the filter uses), same-level pairs, >= 60 BF
    both sides. Falls back to fit_run_model when drift is missing."""
    if not drift or not all(c in drift for c in ("k_pct", "bb_pct", "hr_bf")):
        return fit_run_model(train_c, means)
    q = train_c[train_c["wt_n"] >= 60]
    p = _pairs(q)
    p = p[(p["level_1"] == p["level_2"]) & (p["bf_2"] >= 60)].dropna(subset=["er_rate_2", "k_pct_c_1", "bb_pct_c_1", "hr_bf_c_1"])
    if len(p) < 200:
        return fit_run_model(train_c, means)
    n = p["bf_1"].to_numpy(float).clip(min=1)
    cols = []
    for c in ("k_pct", "bb_pct", "hr_bf"):
        d = drift[c]; b = ballasts.get(("ALL", c)) or {"M": 200, "var_true": 1e-4}
        ev = b["M"] * b["var_true"]
        R = (ev / n) * (M_REF / n) ** d.get("gamma", 0.0)
        K = d["tau2"] / (d["tau2"] + R) * d["phi"]
        base = np.array([env_mean(means, lv, int(se), c) for lv, se in zip(p["level_2"], p["season_2"])], dtype=float)
        cols.append(base + p[f"{c}_c_1"].to_numpy(float) * K)
    X = np.column_stack(cols + [np.ones(len(p))])
    w = np.sqrt(p["hn"].to_numpy(float))
    coef, *_ = np.linalg.lstsq(X * w[:, None], p["er_rate_2"].to_numpy(float) * w, rcond=None)
    return coef


def reconstruct_pit(p, run_coef, ip_per_bf, park_run=1.0, park_hr=1.0, luck=0.0):
    k = np.clip(p["k_pct"], 0.03, 0.50); bb = np.clip(p["bb_pct"], 0.01, 0.30)
    hr = max(p["hr_bf"], 0.0) * park_hr
    babip = np.clip(p["babip_against"], 0.22, 0.40) * math.sqrt(park_run)
    fip_rate = run_coef[0] * k + run_coef[1] * bb + run_coef[2] * hr + run_coef[3]
    er_rate = max(fip_rate + luck, 0.005) * park_run
    ab_share = max(1 - bb - 0.025, 0.5)
    bip_share = max(ab_share - k - hr, 0.05)
    h_bf = hr + babip * bip_share
    opp_avg = h_bf / ab_share
    whip_rate = h_bf + bb
    era = er_rate / ip_per_bf * 9.0
    fip = fip_rate * park_run / ip_per_bf * 9.0
    return {"ERA": era, "FIP": fip, "K_pct": k, "BB_pct": bb, "HR_bf": hr, "opp_avg": opp_avg,
            "whip_rate": whip_rate, "er_rate": er_rate, "babip_against": babip}
