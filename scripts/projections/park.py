"""Park factors for the projection model.

Reads data/park_factors.json (Kai Malloch's empirical-Bayes set, already
re-centered so the games-weighted league-average park = neutral) and exposes
multiplicative factors the projection uses to (a) DE-PARK a player's demonstrated
power/run rates before ranking him by true talent, and (b) RE-PARK the calibrated
projection to the park he'll actually hit/pitch in next season.

Two pieces feed the HITTER home-run factor:
  • the park's OVERALL run factor (park_factor_pct) — elevation/temperature/carry,
    which lifts every hitter's HR regardless of where he hits it; and
  • a DIRECTIONAL component from the pull-side fence distance — a left-handed
    hitter pulls to RIGHT field, a righty to LEFT, so a short pull fence (EOU's
    314 ft RF) inflates HR for that handedness. It's scaled by the hitter's
    air-pull% (a pull-air hitter cashes in a short fence; a spray/oppo hitter
    barely notices it).

Only ~half a team's games are at home; the OTHER half are at the other parks in
its league, whose AVERAGE is the environment baked into that level's stat
distribution (which is exactly what the projection calibrates each rate to). So a
park's real effect on a season line is the HOME park's DEVIATION FROM ITS LEAGUE
AVERAGE, applied at HOME_SHARE — the away games (and the calibration baseline)
already sit at the league average and cancel out. We use LEVEL (D1/D2/D3/NAIA/
JUCO) as the league grouping, matching the per-level calibration. All factors
return 1.0 for unknown teams. Constants below are the tunable knobs.
"""
import json
import os

# ── tunable knobs ──
HOME_SHARE = 0.50          # share of a season's games at home (matches recalc)
K_DIST_PCT_PER_FT = 0.8    # %-change in a hitter's TOTAL HR per ft of pull fence
                           #   vs the league average (already discounts ~65% pull share)
AIRPULL_REF = 0.20         # league-average air-pull%; a hitter at this gets 1.0x
AIRPULL_CLAMP = (0.5, 1.6) # how far air-pull% can scale the directional effect
FIP_HR_SHARE = 0.35        # fraction of FIP that's park-sensitive (the HR term)
BASELINE_PULL_FT = 326.0   # fallback pull-fence if a level has no measured dims

_PF = None
_LVL = None   # per-level average {run_pct, lf, rf} — the "away/league" baseline


def _load():
    global _PF, _LVL
    if _PF is not None:
        return _PF
    path = os.path.join(os.path.dirname(__file__), "..", "..", "data", "park_factors.json")
    pf, by_lvl = {}, {}
    try:
        with open(path) as f:
            d = json.load(f)
        for t in d.get("teams", []):
            tid = t.get("team_id")
            if tid is None:
                continue
            dims = t.get("dimensions") or {}
            e = {"run_pct": float(t.get("park_factor_pct") or 0.0),
                 "lf": dims.get("lf"), "rf": dims.get("rf"),
                 "level": t.get("division")}
            pf[tid] = e
            by_lvl.setdefault(e["level"], []).append(e)
    except FileNotFoundError:
        pf = {}
    lvl = {}
    for level, es in by_lvl.items():
        runs = [e["run_pct"] for e in es]
        lfs = [e["lf"] for e in es if e["lf"]]
        rfs = [e["rf"] for e in es if e["rf"]]
        lvl[level] = {"run_pct": sum(runs) / len(runs) if runs else 0.0,
                      "lf": sum(lfs) / len(lfs) if lfs else BASELINE_PULL_FT,
                      "rf": sum(rfs) / len(rfs) if rfs else BASELINE_PULL_FT}
    _PF, _LVL = pf, lvl
    return pf


def _airpull_scale(airpull):
    if airpull is None:
        return 1.0
    lo, hi = AIRPULL_CLAMP
    return max(lo, min(hi, airpull / AIRPULL_REF))


def _pull_dist(entry, bats):
    lf, rf = entry.get("lf"), entry.get("rf")
    b = (bats or "").upper()[:1]
    if b == "L":
        return rf
    if b == "R":
        return lf
    ds = [x for x in (lf, rf) if x]     # switch / unknown → average pull fence
    return sum(ds) / len(ds) if ds else None


def hr_pct(team_id, bats, airpull):
    """A hitter's HR% park effect — the HOME park's DEVIATION FROM ITS LEAGUE
    AVERAGE (overall carry + handedness-directional pull-fence vs the league's
    average pull fence), so the away ~half (at league-average parks) cancels."""
    pf = _load()
    e = pf.get(team_id)
    if not e:
        return 0.0
    la = _LVL.get(e["level"]) or {"run_pct": 0.0, "lf": BASELINE_PULL_FT, "rf": BASELINE_PULL_FT}
    pct = e["run_pct"] - la["run_pct"]
    d_home = _pull_dist(e, bats)
    d_lg = _pull_dist(la, bats)
    if d_home and d_lg:
        # home pull fence shorter than the league average → more HR
        pct += K_DIST_PCT_PER_FT * (d_lg - d_home) * _airpull_scale(airpull)
    return pct


def hr_mult(team_id, bats=None, airpull=None):
    """Season-line HR multiplier (>1 inflates) for a hitter, vs his league."""
    return 1.0 + hr_pct(team_id, bats, airpull) / 100.0 * HOME_SHARE


def _run_dev(team_id):
    pf = _load()
    e = pf.get(team_id)
    if not e:
        return None
    la = _LVL.get(e["level"]) or {"run_pct": 0.0}
    return e["run_pct"] - la["run_pct"]


def run_mult(team_id):
    """Season-line overall run multiplier vs the team's league (hitters & pitchers)."""
    dev = _run_dev(team_id)
    return 1.0 if dev is None else 1.0 + dev / 100.0 * HOME_SHARE


def pit_hr_mult(team_id):
    """HR-allowed multiplier for a pitcher (faces both hands → non-directional)."""
    return run_mult(team_id)


def pit_fip_mult(team_id):
    """FIP multiplier for a pitcher — damped, since only the HR term of FIP is
    park-sensitive (K and BB are not)."""
    dev = _run_dev(team_id)
    return 1.0 if dev is None else 1.0 + dev / 100.0 * HOME_SHARE * FIP_HR_SHARE
