"""Pronation vs supination estimate from a pitcher's arsenal shapes.

Multi-factor and evidence-first: we score several independent tells and SHOW all
of them, rather than asserting a label from one signal.

The tells (supinator = +, pronator = -):
  * Fastball shape — ride/cut bias (sup) vs arm-side run / sinker bias (pron).
  * Breaking-ball SPIN RATE — supinators spin the breaker up; a pronator can throw
    the same big shape but with notably LESS spin (the key discriminator).
  * Breaking-ball VELOCITY — supinators' breakers are harder; pronated breakers are
    slower.
  * A true glove-side SWEEPER — a supination shape.
  * A low-spin, arm-side fading CHANGEUP — a pronation shape (kill-spin).
  * A CUTTER — a mild supination tell.

All movement inputs use arm-side-positive HB (already normalized), so the logic is
handedness-agnostic. It's an estimate, not a verdict. See RAPSODO_TOOL_DESIGN.md.
"""
import math

_FB = {"fastball", "sinker"}
_BREAKERS = {"slider", "sweeper", "curveball"}

_PLATOON_TYPES = {"fastball", "sinker", "cutter", "slider", "sweeper",
                  "curveball", "changeup", "splitter"}


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _platoon_bias(pitch, ivb, hb, fbivb):
    """Platoon bias from the pitch's actual MOVEMENT, in [-1, +1]: +1 = strongly
    same-handed, -1 = strongly opposite-handed, 0 = platoon-neutral.

    Grounded in Statcast-era research (verified finding: HORIZONTAL pitches — sinker,
    sweeper — are platoon-VULNERABLE, while VERTICAL/gyro pitches — gyro slider, cutter,
    vertical changeup — are platoon-STABLE). So horizontal break drives the split and
    vertical break neutralizes it; the pitch FAMILY only sets which way the split points.
    Two sliders of different shapes therefore grade differently, by design."""
    ivb = ivb if ivb is not None else 0.0
    hb = hb if hb is not None else 0.0
    if pitch in ("fastball", "sinker"):
        run, ride = max(0.0, hb), max(0.0, ivb)
        # arm-side RUN -> same-handed (a sinker); RIDE -> neutral / slight-opposite (a 4-seam)
        return _clamp((run - ride) / 14.0, -0.2, 0.75)
    if pitch in ("changeup", "splitter"):
        fade, drop = max(0.0, hb), max(0.0, 12.0 - ivb)
        # arm-side FADE -> opposite-handed weapon; vertical DROP -> neutral (works both ways).
        # A two-plane fading change splits hard; a vertical splitter/kick-change is neutral.
        return -fade / (fade + 1.4 * drop + 6.0)
    if pitch == "cutter":
        return -0.15   # small glove cut + ride: platoon-neutral, slight opposite lean
    # breaking balls (slider / sweeper / curveball): glove SWEEP -> same-handed; DEPTH -> neutral
    glove, depth = max(0.0, -hb), max(0.0, -ivb)
    return glove / (glove + 1.6 * depth + 5.0)


def _platoon_values(b):
    """Bias -> (value vs same-handed, value vs opposite-handed), each ~0.25-1.0. A
    neutral pitch (b~0) is solid BOTH ways (~0.85); an extreme pitch is great one way,
    poor the other."""
    mag = abs(b)
    fav, unf = 0.85 + 0.15 * mag, 0.85 - 0.6 * mag
    return (fav, unf) if b >= 0 else (unf, fav)


def platoon_profile(arsenal, hand=None):
    """Platoon coverage scores (0-100) vs RHH and LHH from the ESTABLISHED arsenal
    (pitch types with >= 2 reps), graded from each pitch's MOVEMENT not just its label.
    Depth is rewarded via a saturating sum, so a 4-5 pitch mix that genuinely works
    against a side scores far higher than one or two offerings. Returns per-pitch
    vs-RHH/vs-LHH values for the visual, or None."""
    pitches = [a for a in (arsenal or [])
               if (a.get("count") or 0) >= 2 and a.get("pitch") in _PLATOON_TYPES]
    if not pitches:
        return None
    fb = next((a for a in pitches if a["pitch"] in ("fastball", "sinker")), None)
    fbivb = _f(fb.get("ivb")) if fb else 12.0
    rows = []
    for a in pitches:
        b = _platoon_bias(a["pitch"], _f(a.get("ivb")), _f(a.get("arm_hb")), fbivb)
        s, o = _platoon_values(b)
        rows.append((a["pitch"], s, o))
    same = sum(r[1] for r in rows)
    opp = sum(r[2] for r in rows)
    score = lambda x: round(100 * (1 - math.exp(-0.5 * x)))   # noqa: E731
    same_s, opp_s = score(same), score(opp)
    lhp = hand == "L"
    per = [{"pitch": p,
            "vs_rhh": round((o if lhp else s) * 100),
            "vs_lhh": round((s if lhp else o) * 100)}
           for (p, s, o) in rows]
    return {
        "vs_rhh": opp_s if lhp else same_s,
        "vs_lhh": same_s if lhp else opp_s,
        "n_pitches": len(rows),
        "pitches": per,
    }


def _f(v):
    return float(v) if v is not None else None


def pronation_profile(arsenal, hand=None):
    """Returns {lean, score, signals:[{dir, text}]} or None. score > 0 leans
    supinator, < 0 leans pronator."""
    if not arsenal:
        return None
    fb = max((a for a in arsenal if a.get("pitch") in _FB), key=lambda a: a.get("count", 0), default=None)
    breakers = [a for a in arsenal if a.get("pitch") in _BREAKERS and a.get("count", 0) >= 2]
    best_breaker = max(breakers, key=lambda a: a.get("count", 0)) if breakers else None
    ch = next((a for a in arsenal if a.get("pitch") == "changeup"), None)
    fb_velo = _f(fb.get("velo")) if fb else None

    score = 0.0
    signals = []

    def add(pts, direction, text):
        nonlocal score
        score += pts
        signals.append({"dir": direction, "text": text})

    # 1) Fastball: run-dominant (pronation) vs ride/cut-dominant (supination)
    if fb:
        ivb, run = _f(fb.get("ivb")), _f(fb.get("arm_hb"))
        if ivb is not None and run is not None:
            if run - ivb >= 4:
                add(-1.0, "pron", "Fastball runs more than it rides (arm-side / sinker bias)")
            elif ivb - run >= 6:
                add(1.0, "sup", "Fastball rides / cuts with little run (backspin bias)")

    # 2) Breaking-ball spin rate — the supinator/pronator discriminator
    if best_breaker:
        spin = _f(best_breaker.get("total_spin"))
        bvelo = _f(best_breaker.get("velo"))
        label = best_breaker["pitch"]
        if spin is not None:
            if spin >= 2300:
                add(1.5, "sup", f"High breaking-ball spin ({round(spin)} rpm on the {label}) — supinators spin it up")
            elif spin <= 1900:
                add(-1.0, "pron", f"Lower breaking-ball spin ({round(spin)} rpm on the {label}) — a pronated breaker spins less")
        # 3) Breaking-ball velocity (relative to the fastball)
        if bvelo is not None and fb_velo is not None:
            bgap = fb_velo - bvelo
            if bgap <= 9:
                add(0.7, "sup", f"Hard breaking ball ({round(bvelo)} mph, tight off the fastball)")
            elif bgap >= 15:
                add(-0.7, "pron", f"Soft, slow breaking ball ({round(bvelo)} mph)")

    # 4) A true sweeper is a supination shape
    if any(a.get("pitch") == "sweeper" and a.get("count", 0) >= 2 for a in arsenal):
        add(1.3, "sup", "Throws a glove-side sweeper — a supination shape")

    # 5) A low-spin, arm-side fading changeup is a pronation shape
    if ch:
        spin, c_run, c_ivb = _f(ch.get("total_spin")), _f(ch.get("arm_hb")), _f(ch.get("ivb"))
        if spin is not None and spin < 1850 and (c_run or 0) >= 12 and (c_ivb if c_ivb is not None else 99) <= 8:
            add(-1.6, "pron", "Low-spin, arm-side fading changeup — a pronation shape")

    # 6) A cutter leans (mildly) toward supination
    if any(a.get("pitch") == "cutter" for a in arsenal):
        add(0.5, "sup", "Has a cutter — a mild supination tell")

    if score >= 2.5:
        lean = "strong supinator"
    elif score >= 1:
        lean = "supinator lean"
    elif score <= -2.5:
        lean = "strong pronator"
    elif score <= -1:
        lean = "pronator lean"
    else:
        lean = "true blend"

    return {"lean": lean, "score": round(score, 1), "signals": signals}
