"""Pitch tunneling + seam-shifted-wake flags from Rapsodo arsenal centroids.

True tunneling (Baseball Prospectus, 2017) is measured on GAME pitch-pairs with full
trajectory tracking: how close two pitches are at the hitter's commit point (~23.8 ft
from the plate, ~175 ms before contact) vs how far they separate by the plate. A
bullpen gives single pitches with no hitter and no sequence — BUT each pitch carries
its release point, velo and movement (IVB/HB), so we can compute POTENTIAL tunneling:
assume a pair is thrown from the pitcher's release toward the same target and ask where
they sit at the commit point vs the plate. Tight at the commit point + wide at the
plate (late, post-commit break) = deceptive.

Caveat (surfaced in the UI): this is potential tunneling from AVERAGE shapes, not
measured game pairs — no hitter, no sequence, and pitch-to-pitch release consistency
matters. Rapsodo's own app does not compute tunneling at all.
"""
import math

PLATE_DIST = 60.5     # ft, rubber to plate; release is `ext` ft in front of the rubber
TUNNEL_DIST = 23.8    # ft from the plate = the hitter's commit/decision point


def _n(x, d=0.0):
    return float(x) if x is not None else d


def _flight_fraction(ext):
    """Fraction of flight DISTANCE elapsed at the commit point (release → 23.8 ft).
    Break grows ~with time², so separation at the commit point ≈ plate-separation×f²."""
    rd = PLATE_DIST - _n(ext, 6.0)            # release distance from the plate (ft)
    if rd <= TUNNEL_DIST:
        return 0.6
    return max(0.05, min(0.95, (rd - TUNNEL_DIST) / rd))


def _plate_diff(a, b):
    """Movement separation at the plate (in), if aimed identically = the shape gap."""
    return math.hypot(_n(a.get("ivb")) - _n(b.get("ivb")),
                      _n(a.get("arm_hb")) - _n(b.get("arm_hb")))


def _release_diff(a, b):
    """Release-point separation (in) — different slots are easier to read early."""
    return math.hypot((_n(a.get("rel_height")) - _n(b.get("rel_height"))) * 12,
                      (_n(a.get("rel_side")) - _n(b.get("rel_side"))) * 12)


def _grade(tunnel_diff, plate_diff, rel_diff, velo_gap):
    """Transparent 20–99 tunnel grade. Tunneling is about the TIGHT commit-point look,
    so a small tunnel differential dominates; late post-commit break and a velo gap add
    deception, a wide release point (easy to read early) docks it. A pitch that already
    separates at the commit point grades poorly even if it has nasty movement."""
    post = max(plate_diff - tunnel_diff, 0.0)
    score = (95 - 6.0 * tunnel_diff + 0.5 * min(post, 18) + 0.8 * velo_gap
             - 1.5 * max(rel_diff - 2, 0))
    return int(max(20, min(99, round(score))))


def tunnel_pairs(arsenal, hand=None):
    """Tunneling of each established secondary vs the primary fastball.
    Returns {fb, fraction, pairs:[{pitch, release_diff, tunnel_diff, plate_diff,
    post_break, break_tunnel_ratio, velo_gap, grade}], best}."""
    est = [a for a in arsenal if (a.get("count") or 0) >= 2
           and a.get("pitch") not in (None, "unclassified")
           and a.get("ivb") is not None and a.get("arm_hb") is not None
           and a.get("velo") is not None]
    if len(est) < 2:
        return {"fb": None, "pairs": [], "fraction": None, "best": None}
    fbs = [a for a in est if a["pitch"] in ("fastball", "sinker")]
    fb = max(fbs, key=lambda a: a["count"]) if fbs else max(est, key=lambda a: a["velo"])
    pairs = []
    for a in est:
        if a is fb:
            continue
        plate = _plate_diff(fb, a)
        reld = _release_diff(fb, a)
        f = _flight_fraction(a.get("ext"))
        tdiff = reld * (1 - f) + plate * (f ** 2)        # separation at the commit point
        post = max(plate - tdiff, 0.0)                   # late, post-commit break
        vgap = abs(_n(fb.get("velo")) - _n(a.get("velo")))
        pairs.append({
            "pitch": a["pitch"],
            "release_diff": round(reld, 1),
            "tunnel_diff": round(tdiff, 1),
            "plate_diff": round(plate, 1),
            "post_break": round(post, 1),
            "break_tunnel_ratio": round(post / tdiff, 2) if tdiff > 0.5 else None,
            "velo_gap": round(vgap, 1),
            "fraction": round(f, 3),
            "grade": _grade(tdiff, plate, reld, vgap),
        })
    pairs.sort(key=lambda p: -p["grade"])
    return {"fb": fb["pitch"],
            "fraction": pairs[0]["fraction"] if pairs else None,
            "pairs": pairs,
            "best": pairs[0]["pitch"] if pairs else None}


# ── Seam-shifted wake (SSW) candidate flag ────────────────────────────────────
# SSW = a ball that moves in a direction its ACTIVE (transverse) spin doesn't fully
# explain — extra, non-Magnus movement off the seams. We can't measure it directly,
# but we can flag candidates: a pitch whose OBSERVED movement direction diverges from
# its spin-axis (tilt) direction by more than a threshold, with enough spin efficiency
# that it isn't just gyro. Matters most on sinkers / changeups / 2-seam / sweepers.
# Honest limit (Driveline, baseballaero): Rapsodo 2.0 measures spin mid-flight and
# back-models, so treat this as a FLAG to look at the pitch on video, not a verdict.
_SSW_PITCHES = {"sinker", "changeup", "splitter", "sweeper", "curveball"}


def _movement_dir_deg(ivb, hb):
    """Direction of the movement vector as a clock-style bearing in degrees
    (0°=12:00 up, 90°=3:00, measured clockwise), matching tilt_deg convention."""
    # screen: +hb to the right, +ivb up. bearing clockwise from up.
    return (math.degrees(math.atan2(_n(hb), _n(ivb))) + 360) % 360


def ssw_flags(arsenal, hand=None):
    """Per-eligible-pitch SSW candidate flag. Returns {pitch: {deviation_deg, note}}.
    Compares observed spin tilt (tilt_deg) to the movement-implied direction."""
    out = {}
    flip = -1 if hand == "L" else 1     # arm_hb is normalized arm-side+; tilt_deg is raw
    for a in arsenal:
        if a["pitch"] not in _SSW_PITCHES or (a.get("count") or 0) < 3:
            continue
        tilt = a.get("tilt_deg")
        ivb, hb, eff = a.get("ivb"), a.get("arm_hb"), a.get("spin_eff")
        if tilt is None or ivb is None or hb is None:
            continue
        # observed spin pushes the ball OPPOSITE the top of the axis (a 12:00/up axis
        # backspin lifts the ball UP), so the spin-implied movement bearing ≈ tilt.
        # Use RAW hb (un-normalize lefties) so movement & tilt share one frame.
        move = _movement_dir_deg(ivb, hb * flip)
        dev = abs((move - float(tilt) + 180) % 360 - 180)   # 0..180
        # decent spin efficiency (not pure gyro) + a real directional gap = candidate
        if dev >= 35 and (eff is None or float(eff) >= 55) and math.hypot(ivb, hb) >= 6:
            out[a["pitch"]] = {
                "deviation_deg": round(dev),
                "note": (f"Moves ~{round(dev)}° off its spin axis — a seam-shifted-wake "
                         "candidate (extra, non-spin movement). Check it on video."),
            }
    return out
