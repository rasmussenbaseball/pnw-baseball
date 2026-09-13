"""Pitch SHAPE identification in the pitcher's own frame.

The question "is this a cutter or a slider?" has no answer in absolute
inches: a sidearmer's slider sweeps 18" because his whole arm does, and an
over-the-top guy's curveball has 12" of the same sweep. What separates
pitch types is how a pitch moves RELATIVE TO THE PITCHER'S FASTBALL, so
every pitch here is rotated into the slot frame set by his primary
fastball's movement direction (the fastball's Magnus vector points along
the arm angle, so it is the cleanest slot proxy the data offers):

    along  = movement in the fastball's direction (ride-like, +) ... (anti-fastball / topspin, -)
    perp   = movement across it: glove side (+) or arm side (-)

and judged with the velocity gap and spin ratio off that fastball. This is
how Statcast (per-pitcher models keyed to each arm's own repertoire) and
Driveline (slot-typed breaking balls: 3/4 = slider, low = sweeper, over
the top = curve) both frame it.

WHAT THIS MODULE DECIDES AND WHAT IT DOES NOT
  The operator's tag is the truth about WHICH pitches a pitcher throws
  (grip and intent); no group he named consistently is ever renamed by
  code. This module names SHAPES: it classifies untagged pitches, names
  machine-found clusters, and, when a named group's shape argues clearly
  for a different name (Gaza's "slider" that rides like a cutter, Green's
  "slider" that sweeps 18"), it surfaces a SUGGESTION the coach can apply
  with one click. Suggestions are gated per pair so the noisy boundaries
  (slider-shaped curveballs, cutter-ish sliders on the line) stay quiet.

  Descriptors ("gyro", "sweepy", "kick / low-spin", "12-6") annotate a
  pitch without changing its type, which is how kick changes and gyro
  sliders are handled: they are changeups and sliders with a note.
"""
import math

FB_TAGS = ("Fastball", "Sinker")
FASTBALL_BAND_MPH = 3.0     # within this of the primary fastball = fastball velocity


def slot_frame(fb):
    """Angle (rad) of the fastball's movement vector in (arm-side HB, IVB)."""
    if fb is None or fb.get("ivb") is None or fb.get("hb_arm") is None:
        return None
    return math.atan2(float(fb["ivb"]), float(fb["hb_arm"]))


def rotate(ivb, hb_arm, theta):
    """-> (along, perp): components along the fastball direction and across it (+ = glove side)."""
    ux, uy = math.cos(theta), math.sin(theta)
    return hb_arm * ux + ivb * uy, -hb_arm * uy + ivb * ux


def slot_label(theta, rel_h=None, rel_s=None):
    """Coach-facing arm slot from the fastball direction (deg above horizontal)."""
    if theta is None:
        return None
    deg = math.degrees(theta)
    if deg >= 72:
        name = "over the top"
    elif deg >= 58:
        name = "high 3/4"
    elif deg >= 44:
        name = "3/4"
    elif deg >= 30:
        name = "low 3/4"
    elif deg >= 12:
        name = "sidearm"
    else:
        name = "submarine"
    return {"deg": round(deg), "label": name}


def _features(g, fb, theta):
    along, perp = rotate(float(g["ivb"]), float(g["hb_arm"]), theta)
    fa, _ = rotate(float(fb["ivb"]), float(fb["hb_arm"]), theta)
    dv = float(fb["velo"]) - float(g["velo"])
    spin = float(g["spin"]) if g.get("spin") else None
    fspin = float(fb["spin"]) if fb.get("spin") else None
    sr = (spin / fspin) if (spin and fspin) else None
    return {"along": along, "perp": perp, "fb_along": fa, "dv": dv, "spin": spin, "sr": sr,
            "ivb": float(g["ivb"]), "hb_arm": float(g["hb_arm"]), "sweep": -float(g["hb_arm"])}


def shape_verdict(g, fb, theta=None):
    """Shape name for one pitch or centroid {velo, ivb, hb_arm, spin} against
    the pitcher's primary fastball centroid. None if inputs are missing."""
    if g is None or fb is None or None in (g.get("velo"), g.get("ivb"), g.get("hb_arm")):
        return None
    theta = theta if theta is not None else slot_frame(fb)
    if theta is None:
        return None
    f = _features(g, fb, theta)
    along, perp, fa, dv, sr, ivb, spin = (f["along"], f["perp"], f["fb_along"], f["dv"],
                                          f["sr"], f["ivb"], f["spin"])
    armside = perp <= 1.0 and f["hb_arm"] >= 0.5 * float(fb["hb_arm"])
    # offspeed first: an arm-side pitch that lost spin or ride is a changeup
    # even when it sits only a couple of mph off the heater
    if armside and dv >= 1.5 and ((sr is not None and sr <= 0.85) or perp <= -8.0):
        return "Splitter" if (spin is not None and spin < 1150 and ivb <= 5) else "ChangeUp"
    if dv <= FASTBALL_BAND_MPH:
        if perp >= 3.5 and along <= fa - 4.0:
            return "Cutter"
        if perp <= -4.0 or along <= fa - 6.0:
            return "Sinker"
        return "Fastball"
    if armside and dv >= 3.5 and ((sr is not None and sr <= 0.90) or along <= fa - 6.0 or perp <= -5.0):
        return "Splitter" if (spin is not None and spin < 1150 and ivb <= 5) else "ChangeUp"
    if armside and dv >= 5.0:
        return "ChangeUp"
    # glove-side / cut family
    if perp >= 10.0 and f["sweep"] >= 12.0:
        return "Sweeper"
    # curveball needs real depth, not just an anti-fastball direction: a
    # 3/4 slider's sweepy tail points away from the heater too
    if along <= -14.0 and perp < 10.0 and ivb <= -8.0:
        return "Curveball"
    if ivb <= -10.0 and perp < 10.0:
        return "Curveball"
    if dv <= 7.0 and along >= 2.5 and perp <= 9.0:
        return "Cutter"
    if dv >= 12.0 and along <= -8.0 and ivb <= -4.0:
        return "Curveball"
    return "Slider"


# Pairs where a shape disagreement is worth a coach's click, with the extra
# margin each needs. Anything not listed stays a silent descriptor.
def suggest(tag, g, fb, theta=None):
    """-> suggested type (str) when the named group's shape clearly says
    another name, else None."""
    if not tag or g is None or fb is None:
        return None
    theta = theta if theta is not None else slot_frame(fb)
    v = shape_verdict(g, fb, theta)
    if v is None or v == tag:
        return None
    f = _features(g, fb, theta)
    along, perp, fa, dv, ivb = f["along"], f["perp"], f["fb_along"], f["dv"], f["ivb"]
    pair = (tag, v)
    if pair == ("Slider", "Cutter"):
        return v if (dv <= 6.5 and along >= 3.5) else None           # rides, near fastball velo
    if pair == ("Cutter", "Slider"):
        return v if (dv >= 7.5 or along <= -1.0) else None           # too slow / no ride to be a cutter
    if pair in (("Slider", "Sweeper"), ("Curveball", "Sweeper")):
        return v if (perp >= 9.5 and f["sweep"] >= 13.0 and ivb >= -8.0) else None
    if pair == ("Sweeper", "Slider"):
        return v if f["sweep"] <= 9.0 else None
    if pair == ("Slider", "Curveball"):
        return v if (along <= -16.0 and dv >= 11.0) else None
    if pair == ("Curveball", "Slider"):
        return v if (ivb >= -3.0 and along >= -8.0) else None        # nothing curve-like about it
    if pair == ("Fastball", "Sinker"):
        return v if (perp <= -4.5 or along <= fa - 7.0) else None
    if pair == ("Sinker", "Fastball"):
        return None                                                  # grip call; never second-guess
    if pair == ("Fastball", "Cutter"):
        return v if (perp >= 4.0 and along <= fa - 5.0) else None
    if pair == ("Cutter", "Fastball"):
        return None
    if pair == ("ChangeUp", "Splitter"):
        return v if (f["spin"] is not None and f["spin"] < 1050 and ivb <= 3.0) else None
    if pair == ("Splitter", "ChangeUp"):
        return None
    if tag in ("Fastball", "Sinker", "Cutter") and v == "ChangeUp":
        return v if (dv >= 5.0 and f["sr"] is not None and f["sr"] <= 0.85) else None
    if tag in ("ChangeUp", "Splitter") and v in ("Fastball", "Sinker", "Cutter"):
        return None                                                  # a firm changeup is still a changeup
    return None


def descriptor(ptype, g, fb, theta=None):
    """Short shape note for a named pitch ('gyro', 'sweepy', 'kick / low-spin'...)."""
    if g is None or fb is None or None in (g.get("velo"), g.get("ivb"), g.get("hb_arm")):
        return None
    theta = theta if theta is not None else slot_frame(fb)
    if theta is None:
        return None
    f = _features(g, fb, theta)
    along, perp, fa, dv, spin, sr = f["along"], f["perp"], f["fb_along"], f["dv"], f["spin"], f["sr"]
    notes = []
    if ptype == "Slider":
        if perp >= 10.0:
            notes.append("sweepy")
        elif perp <= 7.0 and abs(along) <= 8.0:
            notes.append("gyro")
        if along <= -10.0:
            notes.append("deep")
    elif ptype == "Sweeper":
        if f["sweep"] >= 16.0:
            notes.append("big sweep")
    elif ptype == "Curveball":
        if perp <= 4.0:
            notes.append("12-6")
        elif perp >= 8.0:
            notes.append("slurvy")
        if dv >= 14.0:
            notes.append("slow")
    elif ptype == "Cutter":
        if along >= 8.0:
            notes.append("riding")
        if dv >= 6.0:
            notes.append("slider-ish velo")
    elif ptype in ("ChangeUp", "Splitter"):
        if spin is not None and spin < 1200:
            notes.append(f"kick / low-spin ({spin:.0f} rpm)")
        elif sr is not None and sr <= 0.8:
            notes.append("spin killed")
        if perp <= -8.0:
            notes.append("fade")
        if along <= fa - 12.0:
            notes.append("tumble")
        if dv < 4.0:
            notes.append("firm")
    elif ptype in ("Fastball", "Sinker"):
        if ptype == "Fastball" and along >= 20.0:
            notes.append("ride")
        if f["hb_arm"] >= 15.0:
            notes.append("run")
        if ptype == "Fastball" and perp >= 3.0:
            notes.append("cut")
        if ptype == "Sinker" and f["ivb"] <= 8.0:
            notes.append("heavy")
    return ", ".join(notes) if notes else None
