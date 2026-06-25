"""Location+ for Rapsodo bullpens: a command score that combines (a) hitting the
pitch type's intended HEIGHT target with (b) living on the strike-zone edge / shadow
while avoiding heart-of-plate meatballs and non-competitive waste.

Bullpens have no hitter and no count, so horizontal in/out (which is platoon
dependent) is deliberately treated as edge-vs-heart, NOT in-vs-away — only height
carries a pitch-type target. 100 = provisional average; this is a v1 whose anchors
(_REF/_K, TARGET_Y) are meant to be tuned as the population grows. See RAPSODO_TOOL_DESIGN.md.
"""
import math
from statistics import mean

# Ideal plate HEIGHT (inches off the ground) per pitch type. Zone is ~18"-42".
TARGET_Y = {
    "fastball": 40, "sinker": 23, "cutter": 31,
    "slider": 23, "sweeper": 24,
    "curveball": 21, "changeup": 22, "splitter": 18,
}
_HEIGHT_SD = 7.0      # how forgiving the height target is (in)
_EDGE_SD = 3.5        # width of the good "shadow" band straddling the zone border (in)
# _REF centers the score: it's the mean per-pitch location value over the current
# population (~0.21), so an average-located arsenal lands at 100. Provisional —
# recompute as the population grows. _K sets the spread.
_REF, _K = 0.21, 180
_MIN_N = 3


def _border_signed_dist(x, y):
    """Signed distance (in) to the strike-zone boundary: + = inside depth (toward the
    center, i.e. a meatball when large), - = distance outside. ~0 = straddling the edge."""
    hin = 8.5 - abs(x)                  # inside the left/right edges if > 0
    vin = min(y - 18.0, 42.0 - y)       # inside the top/bottom edges if > 0
    if hin >= 0 and vin >= 0:
        return min(hin, vin)            # depth toward the nearest edge
    ox = max(0.0, abs(x) - 8.5)
    oy = max(0.0, 18.0 - y, y - 42.0)
    return -math.hypot(ox, oy)


def location_value(pitch, x, y):
    """0..~1 quality of a single location for this pitch type."""
    ty = TARGET_Y.get(pitch, 30.0)
    height_fit = math.exp(-((y - ty) / _HEIGHT_SD) ** 2 / 2)
    edge = math.exp(-(_border_signed_dist(x, y) ** 2) / (2 * _EDGE_SD ** 2))
    return height_fit * edge


def location_plus(pitch, locs):
    """locs: list of (sz_side, sz_height) in inches. Returns a Location+ int, or None
    if fewer than _MIN_N reliable locations."""
    vals = [location_value(pitch, float(x), float(y)) for x, y in locs]
    if len(vals) < _MIN_N:
        return None
    return round(max(40, min(170, 100 + _K * (mean(vals) - _REF))))
