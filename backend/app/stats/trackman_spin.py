"""Spin direction, seam-shifted wake and active spin from TrackMan rows.

TrackMan measures the spin AXIS (degrees; 180 = pure backspin, so the clock
tilt is axis/30 + 6 hours) and the induced movement (IVB up, HorzBreak
positive toward the catcher's right, the right-hander's arm side). The
movement implies its own axis: a ball moving up-and-arm-side must be
spinning around an axis tilted that way. Where the two disagree the air is
pushing the ball somewhere the spin alone does not explain, which is the
seam-shifted wake (SSW) effect Savant's spin-direction comparison shows.

Active spin is inferred from movement, as Savant does, through the lift
model: movement over the flight is proportional to the lift coefficient,
which rises with the spin parameter S = r*omega/v. We compute the movement
a fully efficient ball with this spin and speed would show, scale it so the
corpus's own four-seam fastballs top out at 100 (fastballs cannot exceed
full efficiency), and report observed / full. Movement-inferred, not a
gyro measurement: treat a single pitch as noise, a pitch type's average as
a real read.
"""
import math

_R_BALL_M = 0.0366          # ball radius (m)
_MPH_TO_MS = 0.44704
_IN_PER_CL = 96.6           # flight-integrated movement (in) per unit lift coefficient


def tilt_from_axis(axis_deg):
    """TrackMan spin axis (deg) -> clock hours as a float in [0, 12)."""
    if axis_deg is None:
        return None
    return ((float(axis_deg) / 30.0) + 6.0) % 12.0


def tilt_from_movement(ivb, hb):
    """Clock hours the movement vector points to (12:00 = pure ride)."""
    if ivb is None or hb is None:
        return None
    deg = math.degrees(math.atan2(float(hb), float(ivb))) % 360.0
    return deg / 30.0


def clock_str(hours):
    """Float hours -> 'h:mm' with 15-minute rounding for readability off."""
    if hours is None:
        return None
    h = hours % 12.0
    hh = int(h)
    mm = int(round((h - hh) * 60))
    if mm == 60:
        hh, mm = hh + 1, 0
    hh = 12 if hh == 0 else hh
    return f"{hh}:{mm:02d}"


def axis_deviation_min(ivb, hb, axis_deg):
    """Movement-implied minus measured tilt, in clock minutes (signed,
    wrapped to +-360 min = +-6 h). 1 degree of axis = 2 minutes."""
    tm, ts = tilt_from_movement(ivb, hb), tilt_from_axis(axis_deg)
    if tm is None or ts is None:
        return None
    d = (tm - ts) * 60.0
    while d > 360:
        d -= 720
    while d < -360:
        d += 720
    return d


def lift_coef(s):
    """Nathan's lift-coefficient fit vs spin parameter S."""
    if s <= 0:
        return 0.0
    return 1.5 * s if s < 0.1 else 0.09 + 0.6 * s


def full_movement_in(spin_rpm, velo_mph):
    """Movement (in) a 100%-efficient ball with this spin/speed would show,
    before the corpus scale factor."""
    if not spin_rpm or not velo_mph or spin_rpm <= 0 or velo_mph <= 0:
        return None
    omega = float(spin_rpm) * 2 * math.pi / 60.0
    v = float(velo_mph) * _MPH_TO_MS
    return _IN_PER_CL * lift_coef(_R_BALL_M * omega / v)


def movement_ratio(ivb, hb, spin_rpm, velo_mph):
    """observed movement / unscaled full-efficiency movement."""
    full = full_movement_in(spin_rpm, velo_mph)
    if full is None or ivb is None or hb is None or full <= 0:
        return None
    return math.hypot(float(ivb), float(hb)) / full


def calibrate_scale(ratios, pct=0.95):
    """Scale factor so the corpus's fastballs top out at 100%: the given
    percentile of fastball movement ratios maps to 1.0."""
    vals = sorted(r for r in ratios if r is not None and r > 0)
    if len(vals) < 20:
        return None
    return vals[min(len(vals) - 1, int(pct * len(vals)))]


def active_spin_pct(ratio, scale):
    if ratio is None or not scale:
        return None
    return max(0.0, min(100.0, 100.0 * ratio / scale))


def circular_mean_hours(hours_list):
    pts = [(math.cos(h / 12 * 2 * math.pi), math.sin(h / 12 * 2 * math.pi)) for h in hours_list if h is not None]
    if not pts:
        return None
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    if abs(cx) < 1e-9 and abs(cy) < 1e-9:
        return None
    return (math.degrees(math.atan2(cy, cx)) % 360.0) / 30.0


def spin_profile(rows, scale, min_n=3):
    """Per pitch type: measured tilt, movement tilt, SSW deviation, active
    spin, spin rate, Bauer units. `rows` carry ptype, ivb, horz_break,
    spin_axis, spin_rate, rel_speed."""
    by = {}
    for r in rows:
        t = r.get("ptype")
        if not t:
            continue
        g = by.setdefault(t, {"n": 0, "tilt": [], "mtilt": [], "dev": [], "act": [], "spin": [], "bauer": []})
        g["n"] += 1
        ts = tilt_from_axis(r.get("spin_axis"))
        tm = tilt_from_movement(r.get("ivb"), r.get("horz_break"))
        if ts is not None:
            g["tilt"].append(ts)
        if tm is not None:
            g["mtilt"].append(tm)
        d = axis_deviation_min(r.get("ivb"), r.get("horz_break"), r.get("spin_axis"))
        if d is not None:
            g["dev"].append(d)
        a = active_spin_pct(movement_ratio(r.get("ivb"), r.get("horz_break"), r.get("spin_rate"), r.get("rel_speed")), scale)
        if a is not None:
            g["act"].append(a)
        if r.get("spin_rate"):
            g["spin"].append(float(r["spin_rate"]))
            if r.get("rel_speed"):
                g["bauer"].append(float(r["spin_rate"]) / float(r["rel_speed"]))
    out = {}
    for t, g in by.items():
        if g["n"] < min_n:
            continue
        dev = sorted(g["dev"])
        med_dev = dev[len(dev) // 2] if dev else None
        out[t] = {
            "n": g["n"],
            "tilt": clock_str(circular_mean_hours(g["tilt"])),
            "move_tilt": clock_str(circular_mean_hours(g["mtilt"])),
            "ssw_min": round(med_dev) if med_dev is not None else None,
            "active_spin": round(sum(g["act"]) / len(g["act"])) if g["act"] else None,
            "spin": round(sum(g["spin"]) / len(g["spin"])) if g["spin"] else None,
            "bauer": round(sum(g["bauer"]) / len(g["bauer"]), 1) if g["bauer"] else None,
        }
    return out
