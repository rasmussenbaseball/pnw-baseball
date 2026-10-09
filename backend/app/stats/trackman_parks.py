"""Park-aware home runs from TrackMan landing data.

TrackMan gives every air ball a projected distance and a bearing (degrees
off the center-field line, negative toward left field). The site's park
file carries the five fence distances (LF, LCF, CF, RCF, RF) for 57 PNW
parks, so "would this one be out?" is a lookup: interpolate the fence at
the ball's bearing and compare. Clearing counts are reported per park and
as a park-neutral expected homer total (the share of PNW parks a ball
clears, summed over balls), which strips the home yard out of a hitter's
power read the way Savant's "HR in X/30 parks" does.

Fence heights are not in the data, so a ball that lands at the fence
distance plus a small margin counts as out; the margin stands in for the
typical 8-10 ft fence.
"""
import json
import os
from functools import lru_cache

_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "..", "data", "park_factors.json")
# fence-height stand-in: a ball needs to carry this far PAST the fence
# distance (the distance where it would land on flat ground) to clear a
# typical 8 ft wall at a 25-35 degree descent
FENCE_MARGIN_FT = 6.0
_ANCHORS = [(-45.0, "lf"), (-22.5, "lcf"), (0.0, "cf"), (22.5, "rcf"), (45.0, "rf")]


@lru_cache(maxsize=1)
def parks():
    try:
        with open(_PATH) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return []
    out = []
    for t in d.get("teams", []):
        dims = t.get("dimensions") or {}
        if not all(dims.get(k) for _, k in _ANCHORS):
            continue
        out.append({
            "team_id": t.get("team_id"), "name": t.get("full_name") or t.get("short_name"),
            "short": t.get("short_name"), "division": t.get("division"),
            "stadium": t.get("stadium"), "elevation_ft": t.get("elevation_ft"),
            "dims": {k: float(dims[k]) for _, k in _ANCHORS},
        })
    return out


def fence_at(dims, bearing):
    """Interpolated fence distance (ft) at a bearing (deg, -45 LF line ... +45 RF line)."""
    b = max(-45.0, min(45.0, float(bearing)))
    for (b0, k0), (b1, k1) in zip(_ANCHORS, _ANCHORS[1:]):
        if b0 <= b <= b1:
            t = (b - b0) / (b1 - b0)
            return dims[k0] * (1 - t) + dims[k1] * t
    return dims["cf"]


def clears(dims, distance, bearing):
    return float(distance) >= fence_at(dims, bearing) + FENCE_MARGIN_FT


def match_park(tm_code):
    """TrackMan team code (BUS_BEA, WAR_PAC, COR_UNI) -> park, by the same
    token-prefix match the suite uses for the portal team."""
    if not tm_code:
        return None
    parts = [p for p in str(tm_code).lower().replace("-", "_").split("_") if p]
    best, best_score = None, 0
    for p in parks():
        words = f"{p['name']} {p['short'] or ''} {p['stadium'] or ''}".lower().replace("-", " ").split()
        score = sum(1 for part in parts if any(w.startswith(part) for w in words))
        if score > best_score:
            best, best_score = p, score
    return best if best_score >= 2 else None


def ball_report(distance, bearing, launch_angle=None, home=None, division=None):
    """For one air ball: how many parks it clears, and whether it is out at
    home / at the average park of the division."""
    if distance is None or bearing is None:
        return None
    if launch_angle is not None and float(launch_angle) < 10:
        return None          # grounders do not leave the yard
    ps = parks()
    if not ps:
        return None
    out_in = [p for p in ps if clears(p["dims"], distance, bearing)]
    res = {"parks_out": len(out_in), "parks_total": len(ps),
           "share": round(len(out_in) / len(ps), 3),
           "out_at": sorted(p["short"] or p["name"] for p in out_in)}
    if home:
        res["home_out"] = clears(home["dims"], distance, bearing)
        res["home_fence"] = round(fence_at(home["dims"], bearing))
    if division:
        dp = [p for p in ps if p["division"] == division]
        if dp:
            res["div_out"] = sum(1 for p in dp if clears(p["dims"], distance, bearing))
            res["div_total"] = len(dp)
    return res


def attack_angle_proxy(bbe, top_share=0.10, min_n=8):
    """Swing-plane proxy: median launch angle on a hitter's hardest-hit
    balls (top 10%, at least 3). Published shortcut for attack angle when
    there is no bat sensor: the hardest contact comes closest to the bat's
    path. `bbe` = [(ev, la)]."""
    pts = [(float(e), float(l)) for e, l in bbe if e is not None and l is not None]
    if len(pts) < min_n:
        return None
    pts.sort(key=lambda x: -x[0])
    k = max(3, int(round(top_share * len(pts))))
    las = sorted(l for _, l in pts[:k])
    med = las[len(las) // 2] if len(las) % 2 else (las[len(las) // 2 - 1] + las[len(las) // 2]) / 2
    return {"attack_angle": round(med, 1), "n_top": k, "n": len(pts),
            "label": "steep" if med >= 18 else "flat" if med < 6 else "level"}
