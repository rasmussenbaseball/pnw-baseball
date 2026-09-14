"""Count-state splits for TrackMan pitch rows.

States (pitcher's perspective; the hitter view is the same rows with the
labels flipped, since "pitcher ahead" IS "hitter behind"):
  ahead   strikes > balls       even    balls == strikes
  behind  balls > strikes       two_k   two strikes (overlaps ahead/even/behind)
  first   0-0                   three   three balls
Every state carries the same process + outcome block so a coach can read
"what happens to our staff when they fall behind" or "what our lineup does
with two strikes" off one table.
"""
from ..stats.trackman_runvalue import pitch_run_value
from ..stats.trackman_xstats import xwobacon

STATES = [("ahead", "Ahead"), ("even", "Even"), ("behind", "Behind"),
          ("two_k", "2 strikes"), ("first", "First pitch"), ("three", "3 balls")]
_CSW = ("StrikeCalled", "StrikeSwinging")
_STRIKES = {"StrikeCalled", "StrikeSwinging", "FoulBall", "FoulBallFieldable", "FoulBallNotFieldable",
            "InPlay", "AutomaticStrike"}


def state_of(balls, strikes):
    if balls is None or strikes is None:
        return None
    if strikes > balls:
        return "ahead"
    if balls > strikes:
        return "behind"
    return "even"


def _pct(n, d):
    return round(100 * n / d, 1) if d else None


def _block(rows, fair, base):
    called = [r for r in rows if r.get("pitch_call")]
    sw = [r for r in rows if r.get("is_swing")]
    wh = [r for r in sw if r.get("is_whiff")]
    oz = [r for r in rows if r.get("is_in_zone") is False]
    ch = [r for r in oz if (r.get("is_chase") if r.get("is_chase") is not None else r.get("is_swing"))]
    zoned = [r for r in rows if r.get("is_in_zone") is not None]
    bbe = [r for r in rows if r.get("exit_speed") is not None and fair(r)]
    evs = [float(r["exit_speed"]) for r in bbe]
    xw = [xwobacon(float(r["exit_speed"]), float(r["launch_angle"]), r.get("direction"), (r.get("batter_side") or "")[:1] or None)
          for r in bbe if r.get("launch_angle") is not None]
    rv = n_rv = 0.0
    for r in rows:
        v = pitch_run_value(r.get("balls"), r.get("strikes"), r.get("pitch_call"), r.get("play_result"))
        if v is not None:
            rv += v
            n_rv += 1
    return {
        "pitches": len(rows),
        "zone_pct": _pct(sum(1 for r in zoned if r["is_in_zone"]), len(zoned)),
        "strike_pct": _pct(sum(1 for r in called if r["pitch_call"] in _STRIKES), len(called)),
        "swing_pct": _pct(len(sw), len(called)),
        "contact_pct": _pct(len(sw) - len(wh), len(sw)),
        "whiff_pct": _pct(len(wh), len(sw)),
        "chase_pct": _pct(len(ch), len(oz)),
        "csw_pct": _pct(sum(1 for r in rows if r.get("pitch_call") in _CSW), len(rows)),
        "bbe": len(bbe),
        "avg_ev": round(sum(evs) / len(evs), 1) if evs else None,
        "hh_pct": _pct(sum(1 for v in evs if v >= 90), len(evs)),
        "xwobacon": round(sum(xw) / len(xw), 3) if xw else None,
        "k": sum(1 for r in rows if r.get("k_or_bb") == "Strikeout"),
        "bb": sum(1 for r in rows if r.get("k_or_bb") == "Walk"),
        # batter-perspective run value per 100, centered on the corpus
        "rv100": round(100 * (rv - n_rv * base) / n_rv, 2) if n_rv else None,
    }


def count_states(rows, fair, base=0.0):
    """-> {state: block}. `fair(row)` is the fair-ball predicate; `base` the
    corpus RV baseline (batter perspective). rv100 is batter-perspective;
    negate for a pitcher display."""
    groups = {k: [] for k, _ in STATES}
    for r in rows:
        st = state_of(r.get("balls"), r.get("strikes"))
        if st is None:
            continue
        groups[st].append(r)
        if r.get("strikes") == 2:
            groups["two_k"].append(r)
        if r.get("balls") == 0 and r.get("strikes") == 0:
            groups["first"].append(r)
        if r.get("balls") == 3:
            groups["three"].append(r)
    total = sum(len(groups[k]) for k in ("ahead", "even", "behind")) or 1
    out = {}
    for k, label in STATES:
        b = _block(groups[k], fair, base)
        b["label"] = label
        b["share_pct"] = round(100 * len(groups[k]) / total, 1) if k in ("ahead", "even", "behind") else None
        out[k] = b
    return out
