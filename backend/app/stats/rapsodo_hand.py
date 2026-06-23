"""Pronation vs supination estimate from a pitcher's arsenal shapes.

Supinators get around the ball: riding/cutting fastballs and glove-side sweep
(sweepers, sweepy sliders) come naturally; changeups are harder. Pronators turn
the ball over: arm-side run / sinkers and kill-spin fading changeups come
naturally; true sweepers are harder. We score those tells from Rapsodo shapes
and SHOW the evidence rather than just a label — it's an estimate, not a verdict.

All inputs use arm-side-positive movement (already normalized), so the logic is
handedness-agnostic. See RAPSODO_TOOL_DESIGN.md.
"""
_FASTBALL = {"4-seam (ride)", "fastball (mixed)", "sinker / 2-seam", "cutter"}


def _f(v):
    return float(v) if v is not None else None


def pronation_profile(arsenal, hand=None):
    """Returns {lean, score, signals:[{dir, text}]} or None. score > 0 leans
    supinator, < 0 leans pronator."""
    if not arsenal:
        return None
    fbs = [a for a in arsenal if a.get("pitch") in {"4-seam (ride)", "fastball (mixed)", "sinker / 2-seam"}]
    fb = (max(fbs, key=lambda a: a.get("count", 0)) if fbs else None)

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
                add(-1, "pron", "Fastball runs more than it rides (arm-side / sinker bias)")
            elif ivb - run >= 6:
                add(1, "sup", "Fastball rides with little run (cut / backspin bias)")

    # 2) A sweeper / big sweepy breaker is a supination pitch
    sweepy = [a for a in arsenal if _f(a.get("arm_hb")) is not None and _f(a["arm_hb"]) <= -8
              and a.get("count", 0) >= 2]
    if sweepy:
        add(2, "sup", "Throws glove-side sweep (sweeper / sweepy slider) — a supination shape")

    # 3) A low-spin, arm-side fading changeup is a pronation pitch
    ch = next((a for a in arsenal if a.get("pitch") == "changeup"), None)
    if ch:
        spin, c_run, c_ivb = _f(ch.get("total_spin")), _f(ch.get("arm_hb")), _f(ch.get("ivb"))
        if spin is not None and spin < 1850 and (c_run or 0) >= 12 and (c_ivb if c_ivb is not None else 99) <= 8:
            add(-2, "pron", "Low-spin, arm-side fading changeup — a pronation shape")

    # 4) A cutter leans (mildly) toward supination
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
