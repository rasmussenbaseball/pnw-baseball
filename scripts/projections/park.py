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

~half a team's games are at home, so a season-line multiplier applies the park
effect at HOME_SHARE (matches recalculate_league_adjusted.py's 0.5). All factors
return 1.0 for unknown teams. Constants below are the tunable knobs.
"""
import json
import os

# ── tunable knobs ──
HOME_SHARE = 0.50          # share of a season's games at home (matches recalc)
BASELINE_PULL_FT = 326.0   # league-average pull-fence distance (LF/RF mean)
K_DIST_PCT_PER_FT = 0.8    # %-change in a hitter's TOTAL HR per ft of pull fence
                           #   vs baseline (already discounts the ~65% pull share)
AIRPULL_REF = 0.20         # league-average air-pull%; a hitter at this gets 1.0x
AIRPULL_CLAMP = (0.5, 1.6) # how far air-pull% can scale the directional effect
FIP_HR_SHARE = 0.35        # fraction of FIP that's park-sensitive (the HR term)

_PF = None


def _load():
    global _PF
    if _PF is not None:
        return _PF
    path = os.path.join(os.path.dirname(__file__), "..", "..", "data", "park_factors.json")
    pf = {}
    try:
        with open(path) as f:
            d = json.load(f)
        for t in d.get("teams", []):
            tid = t.get("team_id")
            if tid is None:
                continue
            dims = t.get("dimensions") or {}
            pf[tid] = {"run_pct": float(t.get("park_factor_pct") or 0.0),
                       "lf": dims.get("lf"), "rf": dims.get("rf")}
    except FileNotFoundError:
        pf = {}
    _PF = pf
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
    """Total HR% park effect for a hitter at this park: overall carry + the
    handedness-directional pull-fence effect, scaled by air-pull%."""
    e = _load().get(team_id)
    if not e:
        return 0.0
    pct = e["run_pct"]
    d = _pull_dist(e, bats)
    if d:
        pct += K_DIST_PCT_PER_FT * (BASELINE_PULL_FT - d) * _airpull_scale(airpull)
    return pct


def hr_mult(team_id, bats=None, airpull=None):
    """Season-line HR multiplier (>1 inflates) for a hitter at this park."""
    return 1.0 + hr_pct(team_id, bats, airpull) / 100.0 * HOME_SHARE


def run_mult(team_id):
    """Season-line overall run multiplier for this park (both hitters & pitchers)."""
    e = _load().get(team_id)
    if not e:
        return 1.0
    return 1.0 + e["run_pct"] / 100.0 * HOME_SHARE


def pit_hr_mult(team_id):
    """HR-allowed multiplier for a pitcher (faces both hands → non-directional)."""
    return run_mult(team_id)


def pit_fip_mult(team_id):
    """FIP multiplier for a pitcher — damped, since only the HR term of FIP is
    park-sensitive (K and BB are not)."""
    e = _load().get(team_id)
    if not e:
        return 1.0
    return 1.0 + e["run_pct"] / 100.0 * HOME_SHARE * FIP_HR_SHARE
