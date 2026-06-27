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

FB_LABELS = {"fastball", "sinker"}
_CAVEAT_SHAPE = "Shape only — confirm it plays with command and that the grip/slot is repeatable."
_CAVEAT_DESIGN = "A direction to explore with your pitching coach, not a guaranteed gain. Mind arm health."

# ── Research-grounded platoon roles (Statcast-era, ~2017-2025) ──────────────
# Sources: FanGraphs "The Cutter, a Platoon-Neutral Offering", "Sinkers, Change-ups
# and Platoon Splits", "The Secret Benefit and Cost of Sweeping Sliders"; Baseball
# Prospectus "Luis Castillo and the Pronator's Triangle"; FanGraphs / ESPN kick-change
# breakdowns; MLB.com Statcast miss-distance. Findings: offspeed (CH/SPL) is the
# opposite-handed weapon (used ~2.6x more vs opposite hand); breaking balls put away
# same-handed hitters; horizontal pitches (sinker, sweeper) are platoon-VULNERABLE
# while vertical/gyro pitches (gyro slider, cutter for RHP, changeup) are platoon-STABLE;
# sweepers miss fewer bats than depth/gyro breakers; supinators suit a kick change or
# splitter, pronators a hard gyro slider; cutter/gyro-slider can bridge a FB→slow-curve gap.
_BREAKERS = {"slider", "sweeper", "curveball"}   # same-handed put-away
_OFFSPEED = {"changeup", "splitter"}             # the opposite-handed weapon


def _num(v):
    return float(v) if v is not None else None


def _pitch_target(pitch, fb):
    """Research-informed TARGET shape for a recommended pitch, personalized off the
    pitcher's fastball (velo, IVB, arm-side HB). Velos ladder down from the heater;
    breakers get glove-side / depth, offspeed kills ride for fade or drop. Returns
    {pitch, velo, ivb, hb} or None."""
    v = (fb.get("velo") if fb else None) or 88.0
    iv = (fb.get("ivb") if fb else None) or 15.0
    h = (fb.get("arm_hb") if fb else None) or 12.0
    spec = {
        "cutter":      (v - 6,  max(4.0, iv - 8), -2.0),   # bridge: tunnels off FB, ride off, slight cut
        "gyro slider": (v - 9,  2.0, -2.0),                # near (0,0), bullet spin
        "slider":      (v - 11, 0.0, -7.0),                # gyro/depth slider, glove-side
        "sweeper":     (v - 12, 3.0, -15.0),               # big sweep (same-side)
        "curveball":   (v - 16, -8.0, -6.0),               # depth downer for whiff
        "changeup":    (v - 9,  max(3.0, iv - 9), h + 2),  # kill ride, more arm-side fade
        "splitter":    (v - 9,  3.0, max(0.0, h - 5)),     # low spin, vertical drop
    }.get(pitch)
    if not spec:
        return None
    return {"pitch": pitch, "velo": round(spec[0]), "ivb": round(spec[1]), "hb": round(spec[2])}


# Stuff-model feature -> (why it's hurting, the lever to fix it). Keys match the
# component keys emitted by stuff_model.grade_pitch.
_STUFF_LEVER = {
    "velo":         ("below-average velocity", "add velocity"),
    "spin":         ("low spin", "spin it up — grip and finger pressure"),
    "hb_abs":       ("not enough horizontal break", "sharpen the side-to-side movement"),
    "extension":    ("short extension", "get further out front down the mound"),
    "vaa_adj":      ("an approach angle that doesn't fit the shape", "tighten the plane (slot / ride)"),
    "rel_side_abs": ("a narrow release point", "widen or lower the release a touch"),
    "fb_velo_sep":  ("too little velocity gap off the fastball", "take more velo off it"),
    "fb_move_sep":  ("too little movement separation from the fastball", "separate its shape further from the heater"),
    "run":          ("not enough arm-side run", "get more arm-side run on it"),
    "drop":         ("not enough sink", "kill ride to add sink"),
    "shape":        ("not enough cut — ride still on it", "take more ride off for true cut"),
    "ride":         ("not enough ride / carry", "get more ride up in the zone"),
    "vaa":          ("a steep fastball plane", "flatten the approach angle — raise the slot or add ride"),
    "ride_kill":    ("not enough ride killed off the fastball", "kill ~8\" more ride than the heater"),
}


def generate_suggestions(arsenal, handedness=None, n_reliable=0, lean=None, tunnel=None):
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
            "total_spin": _num(a.get("total_spin")),
            "vaa": _num(a.get("vaa")),
            "rel_height": _num(a.get("rel_height")),
            "stuff": a.get("stuff"),
            "stuff_components": a.get("stuff_components"),
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
    fb_vaa = _num(fb.get("vaa"))            # approach angle (deg, neg = steeper)
    fb_relh = _num(fb.get("rel_height"))
    # VAA is the real arbiter of whether a fastball plays up: a fastball doesn't
    # play up unless its approach is "sub-5" (flatter than -5.0). A low slot only
    # helps if it actually flattens the plane, which the VAA already reflects — so
    # gate on VAA, and only fall back to slot when VAA is missing.
    flat_vaa = fb_vaa is not None and fb_vaa >= -5.0
    low_slot = fb_relh is not None and fb_relh <= 5.4
    plays_up = flat_vaa or (fb_vaa is None and low_slot)
    dead_shape = (fb_ivb is not None and fb_hb is not None
                  and abs(fb_ivb - fb_hb) <= 4 and 8 <= fb_ivb <= 16 and fb_hb >= 8)
    vaa_txt = f" (VAA {fb_vaa}°)" if fb_vaa is not None else ""

    # ── fastball: dead zone vs plus carry (now VAA / slot aware) ─────────
    if dead_shape and not plays_up:
        out.append({
            "kind": "flag",
            "title": "Fastball is in the dead zone",
            "detail": f"The {fb['pitch']} has roughly equal ride and run "
                      f"({round(fb_ivb)}\" IVB vs {round(fb_hb)}\" arm-side){vaa_txt}, so its movement "
                      "vector points up-and-arm-side right on the barrel's path — hitters see it as flat. "
                      "Two escapes: get on top for more carry (axis toward 12:30, raise IVB), or "
                      "lean into a sinker (tilt the axis toward 3:00, trade ride for arm-side run).",
            "caveat": "The dead zone is arm-slot- and velocity-relative; plus velo can still carry it. " + _CAVEAT_DESIGN,
        })
    elif dead_shape and plays_up:
        why = "a flat approach angle" if flat_vaa else "a low release slot"
        out.append({
            "kind": "strength",
            "title": "Fastball plays up despite its shape",
            "detail": f"Ride and run are close ({round(fb_ivb)}\" / {round(fb_hb)}\"), which usually reads "
                      f"dead-zone — but {why}{vaa_txt} flattens its plane, so it gets on hitters more "
                      "than the raw shape suggests. Live at the top and let the angle do the work.",
            "caveat": "Command up still matters. " + _CAVEAT_DESIGN,
        })
    elif (fb["pitch"] == "fastball" and fb_ivb is not None and fb_ivb >= 15) or (fb_ivb is not None and fb_ivb >= 17) or flat_vaa:
        bits = []
        if fb_ivb is not None and fb_ivb >= 15:
            bits.append(f"{round(fb_ivb)}\" of ride")
        if flat_vaa:
            bits.append(f"a flat {fb_vaa}° approach angle")
        detail = (("Plus " + " and ".join(bits)) if bits else "A flat plane") + \
            " is a swing-and-miss shape up in the zone. Live at the top and tunnel a downer off it."
        out.append({
            "kind": "strength",
            "title": "Fastball carries",
            "detail": detail,
            "caveat": "Carry plays best with command up.",
        })

    # ── platoon coverage + arsenal development (research-grounded) ───────
    # Established pitch types (>= 2 reps, so a single misread doesn't trigger a rule).
    types = {p["pitch"] for p in pitches if (p["count"] or 0) >= 2}
    breakers = types & _BREAKERS
    offspeed = types & _OFFSPEED
    has_cutter = "cutter" in types
    sup = "supinator" in (lean or "")
    pron = "pronator" in (lean or "")
    rhp = handedness == "R"

    # OPPOSITE-handed coverage. Offspeed is THE pitch that resets the platoon; a cutter
    # is platoon-neutral for RHP (not LHP). With neither, opposite-handed bats sit on it.
    opp_cover = bool(offspeed) or (has_cutter and rhp)
    if secondaries and not opp_cover:
        rec = ("a kick changeup or splitter — as a supinator you'll get depth from those more "
               "easily than a fading change" if sup
               else "a changeup or splitter (kill spin for arm-side fade and depth)")
        out.append({
            "kind": "flag",
            "title": "No weapon for opposite-handed hitters",
            "detail": "Nothing here resets the platoon. Offspeed (changeup / splitter) is the pitch "
                      "that neutralizes opposite-handed bats — it's used about 2.6x more often that way "
                      "for a reason. Add " + rec + ".",
            "caveat": "Offspeed is the opposite-handed weapon (Statcast platoon-split research). " + _CAVEAT_DESIGN,
            "target": _pitch_target("splitter" if sup else "changeup", fb),
        })

    # SAME-handed put-away. Breaking balls bury same-handed hitters glove-side.
    if secondaries and not breakers and not has_cutter:
        rec = ("a hard gyro slider — it tunnels off your arm-side stuff better than a sweeper" if pron
               else "a sweeper or slider — supinators spin those up naturally" if sup
               else "a gyro slider or sweeper")
        out.append({
            "kind": "flag",
            "title": "No same-handed put-away pitch",
            "detail": "No breaking ball to attack same-handed hitters glove-side or steal back-foot "
                      "strikes. Add " + rec + ".",
            "caveat": "Breaking balls carry same-handed; release bias points the shape. " + _CAVEAT_DESIGN,
            "target": _pitch_target("gyro slider" if pron else "sweeper" if sup else "slider", fb),
        })

    # ONLY a sweeper: platoon-vulnerable + lower whiff than a downer shape.
    if breakers == {"sweeper"} and not has_cutter:
        out.append({
            "kind": "flag",
            "title": "Sweeper is the only breaking ball",
            "detail": "A big-horizontal sweeper misses bats vs same-handed hitters, but it flattens out "
                      "and gets hit by opposite-handed bats, and it whiffs less than a depth shape. Add a "
                      "vertical-depth slider or curveball (a 'downer') — it covers both sides better and "
                      "misses more barrels.",
            "caveat": "Vertical/gyro breakers out-whiff big-sweep shapes (Statcast). " + _CAVEAT_DESIGN,
            "target": _pitch_target("slider", fb),
        })

    # BRIDGE pitch: a big velocity jump from the fastball to a slow breaking ball with
    # nothing in between lets hitters time both. A cutter/hard gyro slider ladders it.
    slow_brk = [p for p in pitches if p["pitch"] in ("curveball", "sweeper")
                and (p["count"] or 0) >= 2 and p["velo"]]
    mid_present = has_cutter or "slider" in types
    if fb_v and slow_brk and not mid_present:
        slowest = min(slow_brk, key=lambda p: p["velo"])
        gap = fb_v - slowest["velo"]
        if gap >= 12:
            rec = ("a cutter or a hard gyro slider" if sup else "a cutter (it tunnels off the heater "
                   "and plays to both sides)")
            out.append({
                "kind": "flag",
                "title": "Big gap between the fastball and the breaking ball",
                "detail": f"About {round(gap)} mph from the fastball down to the {slowest['pitch']} with "
                          f"nothing between — hitters can time both speeds. Add a bridge pitch in the mid-velocity "
                          f"band: {rec}, to ladder velocity and tunnel off the fastball.",
                "caveat": "Bridge/tunneling principle (arsenal-construction research). " + _CAVEAT_DESIGN,
                "target": _pitch_target("cutter", fb),
            })

    # Well-rounded: covers both sides — positive reinforcement.
    if secondaries and opp_cover and (breakers or has_cutter) and len(types) >= 4:
        out.append({
            "kind": "strength",
            "title": "Arsenal covers both sides",
            "detail": "You've got an offspeed for opposite-handed bats and a breaker for same-handed bats — "
                      "the platoon coverage is there. Focus reps on sharpening shapes and command, not adding pitches.",
            "caveat": "Coverage ≠ command; quality of each shape still decides it.",
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

    # ── why a pitch grades low on Stuff (read the model's own components) ──
    graded = [p for p in pitches if (p["count"] or 0) >= 2 and p.get("stuff") is not None]
    low = sorted([p for p in graded if p["stuff"] < 88], key=lambda p: p["stuff"])[:2]
    for p in low:
        comps = p.get("stuff_components") or {}
        negs = sorted([(k, v) for k, v in comps.items()
                       if v <= -2.0 and k in _STUFF_LEVER], key=lambda kv: kv[1])[:2]
        if not negs:
            continue
        whys = " and ".join(_STUFF_LEVER[k][0] for k, _ in negs)
        fixes = "; ".join(_STUFF_LEVER[k][1] for k, _ in negs)
        out.append({
            "kind": "flag",
            "title": f"{p['pitch'].capitalize()} stuff grades low ({p['stuff']})",
            "detail": f"On our college whiff/chase model it's held back by {whys}. "
                      f"Biggest levers to raise the grade: {fixes}.",
            "caveat": "Stuff is shape-only and model-relative (100 = WCL average for that pitch type); "
                      "command and sequencing still decide outcomes.",
        })

    # ── Sequencing off tunneling ──
    fb = (tunnel or {}).get("fb")
    pairs = (tunnel or {}).get("pairs") or []
    if fb and pairs:
        strong = [p for p in pairs if p["grade"] >= 68 and (p.get("post_break") or 0) >= 6]
        if strong:
            b = strong[0]
            out.append({
                "kind": "strength",
                "title": f"{b['pitch'].capitalize()} tunnels off the {fb}",
                "detail": (f"It stays within ~{b['tunnel_diff']}\" of the {fb} at the hitter's commit "
                           f"point, then separates to ~{b['plate_diff']}\" by the plate "
                           f"(~{b['post_break']}\" of late, post-commit break). Throw it right behind "
                           f"the {fb} in the same window — same look, different finish."),
                "caveat": "Potential tunneling from average shapes (no hitter or sequence in a bullpen); "
                          "pitch-to-pitch release consistency decides how much carries to a game.",
            })
        early = [p for p in pairs if (p.get("tunnel_diff") or 0) >= 9]
        if early:
            e = max(early, key=lambda x: x["tunnel_diff"])
            out.append({
                "kind": "flag",
                "title": f"{e['pitch'].capitalize()} shows itself early",
                "detail": (f"It's already ~{e['tunnel_diff']}\" off the {fb} at the commit point, so a "
                           f"hitter can read it before deciding. Tighten its early path/slot to the {fb}, "
                           "or set it up off a different pitch."),
            })

    return out
