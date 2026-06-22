"""Rapsodo arsenal suggestion engine — rule-based coaching notes derived from a
pitcher's re-classified movement profile. See RAPSODO_TOOL_DESIGN.md §4d.

Every note is a tendency, not a verdict: shape is not command, grip feasibility,
or arm health. Each suggestion carries a caveat and the rules lean on widely-cited
pitch-design heuristics (dead zone, arm-slot direction coverage, changeup ride
separation). Numbers may arrive as Decimal (DB-fed), so thresholds use ints to
avoid Decimal/float mixing.

generate_suggestions(arsenal, handedness, n_reliable) -> list of:
  { "kind": "flag" | "strength" | "note", "title": str, "detail": str, "caveat": str }
"""

FB_LABELS = {"4-seam (ride)", "fastball (mixed)", "sinker / 2-seam"}
_CAVEAT_SHAPE = "Shape only — confirm it plays with command and that the grip/slot is repeatable."
_CAVEAT_DESIGN = "A direction to explore with your pitching coach, not a guaranteed gain. Mind arm health."


def _num(v):
    return float(v) if v is not None else None


def generate_suggestions(arsenal, handedness=None, n_reliable=0):
    out = []
    if not arsenal:
        return out

    # normalize the few fields we reason over to float
    pitches = []
    for a in arsenal:
        pitches.append({
            "pitch": a.get("pitch"),
            "count": a.get("count") or 0,
            "velo": _num(a.get("velo")),
            "ivb": _num(a.get("ivb")),
            "arm_hb": _num(a.get("arm_hb")),
            "spin_eff": _num(a.get("spin_eff")),
        })

    # anchor fastball: the fastball-family pitch with the most reps, else the
    # hardest pitch overall.
    fbs = [p for p in pitches if p["pitch"] in FB_LABELS]
    fb = (max(fbs, key=lambda p: p["count"]) if fbs
          else max(pitches, key=lambda p: (p["velo"] or 0)))
    secondaries = [p for p in pitches if p is not fb and p["count"] >= 2]

    # ── sample-size caveat ──────────────────────────────────────────────
    if n_reliable < 30:
        out.append({
            "kind": "note",
            "title": "Small sample",
            "detail": f"Only {n_reliable} reliable pitches so far. Treat the shapes below as a "
                      "first read; collect ~100 fastballs and ~50 of each secondary before "
                      "trusting averages or trends.",
            "caveat": "More high-intent reps will firm these up.",
        })

    fb_v, fb_ivb, fb_hb = fb["velo"], fb["ivb"], fb["arm_hb"]

    # ── fastball: dead zone vs plus carry ───────────────────────────────
    if fb_ivb is not None and fb_hb is not None and abs(fb_ivb - fb_hb) <= 4 and 8 <= fb_ivb <= 16 and fb_hb >= 8:
        out.append({
            "kind": "flag",
            "title": "Fastball is in the dead zone",
            "detail": f"The {fb['pitch']} has roughly equal ride and run "
                      f"({round(fb_ivb)}\" IVB vs {round(fb_hb)}\" arm-side), so its movement vector "
                      "points up-and-arm-side right on the barrel's path — hitters see it as flat. "
                      "Two escapes: get on top for more carry (axis toward 12:30, raise IVB), or "
                      "lean into a sinker (tilt the axis toward 3:00, trade ride for arm-side run).",
            "caveat": "The dead zone is arm-slot- and velocity-relative; plus velo can still carry it. " + _CAVEAT_DESIGN,
        })
    elif fb["pitch"] == "4-seam (ride)" or (fb_ivb is not None and fb_ivb >= 17):
        out.append({
            "kind": "strength",
            "title": "Fastball carries",
            "detail": f"{round(fb_ivb)}\" of induced ride is a swing-and-miss shape up in the zone. "
                      "Live at the top, especially against uphill swings, and tunnel a downer off it.",
            "caveat": "Carry plays best with a flat approach angle / lower slot and command up.",
        })

    # ── directional coverage (arm slot relative) ────────────────────────
    glove = [p for p in secondaries if p["arm_hb"] is not None and p["arm_hb"] <= -3]
    arm_sec = [p for p in secondaries if p["arm_hb"] is not None and p["arm_hb"] >= 6]
    if secondaries and not glove:
        out.append({
            "kind": "flag",
            "title": "No glove-side weapon",
            "detail": "Everything moves arm-side or straight — a hitter can sit on one side of the "
                      "plate. Add a glove-side breaker (gyro slider or sweeper) to attack the other "
                      "side and steal called strikes back-door / back-foot.",
            "caveat": "Supinators pick up sweepers naturally; pronators pick up gyro shapes. " + _CAVEAT_DESIGN,
        })
    if secondaries and not arm_sec:
        out.append({
            "kind": "flag",
            "title": "No arm-side change of pace",
            "detail": "No clear arm-side offspeed (changeup or sinker). A pitch that runs arm-side and "
                      "slower gives opposite-handed hitters a different look and a velocity ladder.",
            "caveat": _CAVEAT_DESIGN,
        })

    # ── changeup separation ─────────────────────────────────────────────
    ch = next((p for p in pitches if p["pitch"] == "changeup"), None)
    if ch and fb_v and ch["velo"]:
        vg = fb_v - ch["velo"]
        ig = (fb_ivb - ch["ivb"]) if (fb_ivb is not None and ch["ivb"] is not None) else None
        if vg < 6:
            out.append({
                "kind": "flag",
                "title": "Changeup is too firm",
                "detail": f"Only {round(vg)} mph slower than the fastball — not enough to disrupt timing. "
                          "Target an 8–10 mph gap (kill spin / change the grip to bleed velo).",
                "caveat": _CAVEAT_DESIGN,
            })
        elif ig is not None and ig < 6:
            out.append({
                "kind": "flag",
                "title": "Changeup doesn't separate down",
                "detail": f"It keeps most of the fastball's ride (only {round(ig)}\" less IVB), so it "
                          "stays on plane. Aim for ≥8\" less ride than the heater so it dives under barrels.",
                "caveat": _CAVEAT_DESIGN,
            })
        elif ig is not None and vg >= 8 and ig >= 8:
            out.append({
                "kind": "strength",
                "title": "Changeup tunnels well",
                "detail": f"{round(vg)} mph slower and {round(ig)}\" less ride than the fastball, on the same "
                          "arm-side line — it mirrors the heater out of the hand then dives. Keep leaning on it.",
                "caveat": "Bank on it most against opposite-handed hitters.",
            })

    return out
