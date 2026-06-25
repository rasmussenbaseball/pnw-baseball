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
_FB = {"4-seam (ride)", "fastball (mixed)", "sinker / 2-seam"}
_BREAKERS = {"slider", "sweeper", "gyro slider", "curveball"}


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
