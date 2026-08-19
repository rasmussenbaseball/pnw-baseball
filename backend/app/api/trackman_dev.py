"""Development notes engine for the Coach Board.

Turns every player's tracked data into a short list of coaching points —
the "what do we work on with this kid" answer, computed from evidence and
written in coach language with the numbers attached. Rules are transparent
heuristics from standard player-development practice:

PITCHERS: velo intent (sitting far under his own max), fastball shape/usage
pairing (ride plays up, sink plays down, dead-zone shapes need a lane),
usage optimization by run value, putaway and first-pitch attack plans,
predictability behind in the count, platoon gaps that suggest an arsenal
addition, release repeatability, extension.

HITTERS: air-pull conversion (big EV stuck on the ground / straightaway),
two-strike contact, chase and passivity (swing decisions both directions),
zone-contact bat-to-ball work, box adjustments from inner/outer-third
contact quality, pitch-type holes, BP-to-game transfer.

DEFENSE (from positioning OAE): directional weaknesses (first-step work),
hands/throw vs range failure signatures, routine-play conversion.

CATCHERS: edge-specific framing, pop time decomposed into exchange vs arm.

Every qualified player gets AT LEAST two points: one strength to lean on,
plus focuses — or an honest "balanced profile" note when nothing flags.
"""
from collections import defaultdict

from fastapi import APIRouter, Depends, Query

from ..models.database import get_connection
from ..stats.trackman_runvalue import pitch_run_value
from ..stats.trackman_xstats import xwobacon
from .trackman_suite import (
    _gate, _season_clause, _rv_baseline, _NO_MISTAG,
    trackman_defense, trackman_catching,
)

router = APIRouter(tags=["trackman-dev"])

FB_SET = ("Fastball", "Sinker")
MIN_PITCHER_N = 50
MIN_HITTER_N = 40


def _pctl(v, vals):
    if v is None or len(vals) < 5:
        return None
    below = sum(1 for x in vals if x < v)
    return round(100 * below / len(vals))


def _ord(n):
    if n is None:
        return None
    if 10 <= n % 100 <= 20:
        suf = "th"
    else:
        suf = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suf}"


def _rate(num, den, dec=1):
    return round(100 * num / den, dec) if den else None


@router.get("/trackman/dev-notes")
def dev_notes(
    team: str | None = Query(None),
    season: int | None = Query(None),
    owner: str = Depends(_gate),
):
    """Per-player development points. Live sessions only (BP feeds only the
    transfer-gap rule). Team filters to the coach's own players."""
    ssql, sparams = _season_clause(season)
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            f"""SELECT p.pitcher, p.pitcher_team, p.pitcher_throws,
                       p.batter, p.batter_team, p.batter_side,
                       COALESCE(p.override_pitch_type, p.class_pitch_type, p.tagged_pitch_type, p.auto_pitch_type) AS ptype,
                       p.rel_speed, p.ivb, p.horz_break, p.extension,
                       p.rel_height, p.rel_side,
                       p.plate_loc_side, p.plate_loc_height,
                       p.pitch_call, p.is_swing, p.is_whiff, p.is_contact, p.is_chase, p.is_in_zone,
                       p.balls, p.strikes, p.k_or_bb, p.play_result,
                       p.exit_speed, p.launch_angle, p.direction,
                       s.session_type
                FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                WHERE p.owner_user_id = %s{ssql}""",
            [owner] + sparams,
        )
        rows = [dict(r) for r in cur.fetchall()]
        rv_base = _rv_baseline(cur, owner, "live", season)

    live = [r for r in rows if r["session_type"] in ("game", "scrimmage", "intrasquad")]
    bp = [r for r in rows if r["session_type"] == "bp"]

    # ── pitcher aggregation ──
    P = defaultdict(lambda: {
        "n": 0, "types": defaultdict(lambda: defaultdict(float)),
        "sides": defaultdict(lambda: defaultdict(float)),
        "first_n": 0, "first_k": 0, "twok_n": 0, "twok_end": 0, "twok_chase_n": 0, "twok_oz": 0,
        "twok_fb": 0,
        "behind_n": 0, "behind_fb": 0, "behind_csw": 0,
        "rh": [], "rs": [], "throws": None,
    })
    for r in live:
        name = r["pitcher"]
        if not name or (r["ptype"] or "") == "Mistag":
            continue
        a = P[(name, r["pitcher_team"])]
        a["n"] += 1
        a["throws"] = r["pitcher_throws"]
        if r["rel_height"] is not None and r["rel_side"] is not None:
            a["rh"].append(float(r["rel_height"]))
            a["rs"].append(float(r["rel_side"]))
        t = a["types"][r["ptype"] or "?"]
        t["n"] += 1
        for k, v in (("velo", r["rel_speed"]), ("ivb", r["ivb"]), ("hb", r["horz_break"]),
                     ("ext", r["extension"]), ("ph", r["plate_loc_height"])):
            if v is not None:
                t[f"{k}_s"] += float(v)
                t[f"{k}_n"] += 1
        if r["rel_speed"] is not None:
            t["vmax"] = max(t["vmax"], float(r["rel_speed"]))
        if r["is_swing"]:
            t["sw"] += 1
            t["wh"] += 1 if r["is_whiff"] else 0
        if r["is_in_zone"] is True:
            t["z_in"] += 1
            t["z_n"] += 1
        elif r["is_in_zone"] is False:
            t["z_n"] += 1
        if r["pitch_call"] in ("StrikeCalled", "StrikeSwinging"):
            t["csw"] += 1
        if r["exit_speed"] is not None:
            t["ev_s"] += float(r["exit_speed"])
            t["ev_n"] += 1
        rv = pitch_run_value(r["balls"], r["strikes"], r["pitch_call"], r["play_result"])
        if rv is not None:
            t["rv"] += -(rv - rv_base)
            t["rv_n"] += 1
        side = (r["batter_side"] or "")[:1]
        if side in ("L", "R"):
            sd = a["sides"][side]
            sd["n"] += 1
            if r["is_swing"]:
                sd["sw"] += 1
                sd["wh"] += 1 if r["is_whiff"] else 0
            if rv is not None:
                sd["rv"] += -(rv - rv_base)
                sd["rv_n"] += 1
        if r["pitch_call"]:
            b, st = r["balls"], r["strikes"]
            if b == 0 and st == 0:
                a["first_n"] += 1
                if r["pitch_call"] not in ("BallCalled", "BallinDirt", "BallIntentional", "HitByPitch"):
                    a["first_k"] += 1
            if st == 2:
                a["twok_n"] += 1
                if (r["ptype"] or "") in FB_SET:
                    a["twok_fb"] += 1
                if r["k_or_bb"] == "Strikeout":
                    a["twok_end"] += 1
                if r["is_in_zone"] is False:
                    a["twok_oz"] += 1
                    if r["is_chase"]:
                        a["twok_chase_n"] += 1
            if b is not None and st is not None and b > st:
                a["behind_n"] += 1
                if (r["ptype"] or "") in FB_SET:
                    a["behind_fb"] += 1
                if r["pitch_call"] in ("StrikeCalled", "StrikeSwinging"):
                    a["behind_csw"] += 1

    # ── hitter aggregation ──
    H = defaultdict(lambda: {
        "seen": 0, "sw": 0, "wh": 0, "oz": 0, "ch": 0, "zsw": 0, "zct": 0,
        "heart_n": 0, "heart_take": 0, "twok_sw": 0, "twok_ct": 0,
        "evs": [], "las": [], "air": 0, "pull_air": 0, "hh": 0,
        "sides": defaultdict(lambda: defaultdict(float)),
        "types": defaultdict(lambda: defaultdict(float)),
        "thirds": defaultdict(lambda: defaultdict(float)),   # in/mid/out
        "bp_evn": 0, "bp_hh": 0, "side": None,
    })
    for r in live:
        name = r["batter"]
        if not name:
            continue
        h = H[(name, r["batter_team"])]
        hand = (r["batter_side"] or "")[:1]
        h["side"] = hand or h["side"]
        if r["pitch_call"]:
            h["seen"] += 1
            if r["is_swing"]:
                h["sw"] += 1
                h["wh"] += 1 if r["is_whiff"] else 0
            if r["is_in_zone"] is False:
                h["oz"] += 1
                if r["is_chase"]:
                    h["ch"] += 1
            if r["is_swing"] and r["is_in_zone"]:
                h["zsw"] += 1
                h["zct"] += 1 if r["is_contact"] else 0
            if r["strikes"] == 2 and r["is_swing"]:
                h["twok_sw"] += 1
                h["twok_ct"] += 1 if r["is_contact"] else 0
            # heart = inner 2/3 of the zone
            px, pz = r["plate_loc_side"], r["plate_loc_height"]
            if px is not None and pz is not None:
                if max(abs(px) / 0.83, abs(pz - 2.5)) <= 0.67:
                    h["heart_n"] += 1
                    if not r["is_swing"]:
                        h["heart_take"] += 1
                # inner/outer thirds relative to the batter (HBP-verified:
                # positive plate side = in to a RHH)
                if hand in ("L", "R"):
                    adj = px * (1.0 if hand == "R" else -1.0)
                    third = "in" if adj > 0.28 else ("out" if adj < -0.28 else "mid")
                    tb = h["thirds"][third]
                    if r["is_swing"]:
                        tb["sw"] += 1
                        tb["wh"] += 1 if r["is_whiff"] else 0
                    if r["exit_speed"] is not None:
                        tb["ev_s"] += float(r["exit_speed"])
                        tb["ev_n"] += 1
            th = (r["pitcher_throws"] or "")[:1]
            if th in ("L", "R"):
                sd = h["sides"][th]
                sd["n"] += 1
                if r["is_swing"]:
                    sd["sw"] += 1
                    sd["wh"] += 1 if r["is_whiff"] else 0
            pt = r["ptype"]
            if pt and pt != "Mistag":
                td = h["types"][pt]
                td["n"] += 1
                if r["is_swing"]:
                    td["sw"] += 1
                    td["wh"] += 1 if r["is_whiff"] else 0
                if r["is_in_zone"] is False:
                    td["oz"] += 1
                    if r["is_chase"]:
                        td["ch"] += 1
        if r["exit_speed"] is not None:
            ev = float(r["exit_speed"])
            h["evs"].append(ev)
            if ev >= 90:
                h["hh"] += 1
            la = r["launch_angle"]
            if la is not None:
                h["las"].append(float(la))
                if la >= 10:
                    h["air"] += 1
                    d = r["direction"]
                    if d is not None and hand in ("L", "R"):
                        if float(d) * (1.0 if hand == "L" else -1.0) >= 10:
                            h["pull_air"] += 1
            if la is not None and r["exit_speed"] is not None:
                td = h["types"].get(r["ptype"]) if r["ptype"] else None
                if td is not None:
                    td["xw_s"] += xwobacon(ev, float(la), r["direction"] and float(r["direction"]),
                                           hand or None)
                    td["xw_n"] += 1
                    td["la_s"] += float(la)
                    td["la_n"] += 1
                    if la < 10:
                        td["gb"] += 1
                    td["ev_s"] += ev
                    td["ev_n"] += 1
    for r in bp:
        name = r["batter"]
        if not name or r["exit_speed"] is None:
            continue
        h = H[(name, r["batter_team"])]
        h["bp_evn"] += 1
        h["bp_hh"] += 1 if float(r["exit_speed"]) >= 90 else 0

    # corpus reference arrays
    fb_velos, exts, chases, evs_c, c2ks = [], [], [], [], []
    for a in P.values():
        if a["n"] < MIN_PITCHER_N:
            continue
        fb = [t for k, t in a["types"].items() if k in FB_SET and t["velo_n"] >= 10]
        if fb:
            best = max(fb, key=lambda t: t["n"])
            fb_velos.append(best["velo_s"] / best["velo_n"])
        e_n = sum(t["ext_n"] for t in a["types"].values())
        if e_n >= 10:
            exts.append(sum(t["ext_s"] for t in a["types"].values()) / e_n)
    swings_c = []
    for h in H.values():
        if h["seen"] < MIN_HITTER_N:
            continue
        if h["oz"] >= 15:
            chases.append(h["ch"] / h["oz"])
        if len(h["evs"]) >= 10:
            evs_c.append(sum(h["evs"]) / len(h["evs"]))
        if h["twok_sw"] >= 10:
            c2ks.append(h["twok_ct"] / h["twok_sw"])
        swings_c.append(h["sw"] / h["seen"])
    chase_avg = (sum(chases) / len(chases)) if chases else 0.28
    c2k_avg = (sum(c2ks) / len(c2ks)) if c2ks else 0.75
    swing_avg = (sum(swings_c) / len(swings_c)) if swings_c else 0.46

    dfs = trackman_defense(context="all", team=team, date_from=None, date_to=None,
                           season=season, owner=owner)
    cat = trackman_catching(team=team, season=season, owner=owner)

    players = {}

    def entry(name, tm):
        key = name
        if key not in players:
            players[key] = {"player": name, "team": tm, "roles": [], "points": []}
        return players[key]

    def add(e, area, note, kind="focus", prio=50):
        e["points"].append({"area": area, "note": note, "kind": kind, "prio": prio})

    # ── pitcher rules ──
    for (name, tm), a in P.items():
        if a["n"] < MIN_PITCHER_N or (team and tm != team):
            continue
        e = entry(name, tm)
        e["roles"].append("pitcher")
        types = {k: t for k, t in a["types"].items() if t["n"] >= 10}
        fbs = {k: t for k, t in types.items() if k in FB_SET}
        fb = max(fbs.values(), key=lambda t: t["n"]) if fbs else None

        # strength: best pitch by RV/100 (only when it's genuinely good)
        rated = [(k, 100 * t["rv"] / t["rv_n"], t) for k, t in types.items() if t["rv_n"] >= 25]
        if rated:
            bk, brv, bt = max(rated, key=lambda x: x[1])
            if brv >= 0.5:
                wh = _rate(bt["wh"], bt["sw"])
                add(e, "Identity",
                    f"The {bk.lower()} is the weapon: {brv:+.1f} runs per 100 with a {wh}% whiff rate. "
                    f"Build the plan around it.", kind="strength", prio=90)
                use = 100 * bt["n"] / a["n"]
                if brv >= 1.0 and use < 22:
                    add(e, "Usage",
                        f"His best pitch ({bk.lower()}, {brv:+.1f} RV/100) is only {use:.0f}% of the mix. "
                        f"Nothing to build, just throw it more.", prio=85)
            else:
                whs = [(k, t["wh"] / t["sw"], t) for k, t in types.items() if t["sw"] >= 15]
                if whs:
                    wk2, w2, _ = max(whs, key=lambda x: x[1])
                    add(e, "Identity",
                        f"Nothing in the mix is beating hitters yet — the {wk2.lower()} misses the most "
                        f"bats ({100*w2:.0f}% whiff), so that's the piece to sharpen first.",
                        kind="strength", prio=45)
            wk, wrv, wt = min(rated, key=lambda x: x[1])
            wuse = 100 * wt["n"] / a["n"]
            if wrv <= -1.5 and wuse >= 18:
                add(e, "Usage",
                    f"The {wk.lower()} is costing him ({wrv:+.1f} RV/100 on {wuse:.0f}% usage). "
                    f"Shelve it or rework the shape before it earns innings back.", prio=80)

        if fb and fb["velo_n"] >= 15:
            v = fb["velo_s"] / fb["velo_n"]
            gap = fb["vmax"] - v
            pct = _pctl(v, fb_velos)
            if gap >= 3.0:
                add(e, "Velocity",
                    f"Sits {v:.1f} but has touched {fb['vmax']:.1f} — {gap:.1f} mph in the tank. "
                    f"Velo-intent work (pulldowns, run-and-guns) to raise the sitting speed.", prio=75)
            elif pct is not None and pct <= 30:
                add(e, "Velocity",
                    f"Fastball sits {v:.1f} ({_ord(pct)} percentile in this corpus). A dedicated velo "
                    f"block is the highest-leverage offseason move.", prio=60)
            ivb = fb["ivb_s"] / fb["ivb_n"] if fb["ivb_n"] else None
            ph = fb["ph_s"] / fb["ph_n"] if fb["ph_n"] else None
            hb = abs(fb["hb_s"] / fb["hb_n"]) if fb["hb_n"] else None
            if ivb is not None and ph is not None:
                if ivb >= 14.5 and ph < 2.55:
                    add(e, "Pitch design",
                        f"{ivb:.0f}\" of ride but he lives at {ph:.1f} ft — the carry is wasted down. "
                        f"Move the fastball up: top-third targets, let the ride miss over barrels.", prio=78)
                elif ivb <= 9 and ph > 2.75:
                    add(e, "Pitch design",
                        f"Sinking fastball ({ivb:.0f}\" ride) thrown at {ph:.1f} ft — up is where sink "
                        f"gets barreled. Pound the knees and chase ground balls.", prio=74)
                elif 9 < ivb < 13.5 and hb is not None and 4 <= hb <= 12:
                    add(e, "Pitch design",
                        f"Dead-zone fastball shape ({ivb:.0f}\" ride, {hb:.0f}\" run) — hitters see it "
                        f"best. Pick a lane: chase ride (stay behind the ball) or full sink/run.", prio=70)

        # putaway + attack plans
        if a["twok_n"] >= 40:
            put = _rate(a["twok_end"], a["twok_n"])
            oz_chase = _rate(a["twok_chase_n"], a["twok_oz"]) if a["twok_oz"] >= 15 else None
            if put is not None and put < 22:
                extra_txt = (f" Two-strike chase rate is only {oz_chase}% — the finish pitch isn't "
                             f"tempting anyone." if oz_chase is not None and oz_chase < 25 else "")
                add(e, "Putaway",
                    f"Finishes just {put}% of two-strike counts with a strikeout.{extra_txt} "
                    f"Script the 2K sequence: best whiff pitch, off the edge, not in the zone.", prio=72)
        if a["first_n"] >= 40:
            fps = _rate(a["first_k"], a["first_n"])
            if fps is not None and fps < 58:
                add(e, "Attack",
                    f"First-pitch strike rate {fps}% — behind before the AB starts. Pick one "
                    f"get-me-over (usually the highest-CSW secondary) and trust it 0-0.", prio=68)
        if a["behind_n"] >= 30:
            fbshare = _rate(a["behind_fb"], a["behind_n"], 0)
            if fbshare is not None and fbshare >= 75:
                add(e, "Attack",
                    f"When behind he's {fbshare}% fastballs — hitters sit on it. Steal a "
                    f"breaking-ball strike in hitter's counts to break the pattern.", prio=62)

        # platoon gap → arsenal suggestion
        L, R = a["sides"].get("L"), a["sides"].get("R")
        if L and R and L["n"] >= 60 and R["n"] >= 60 and L["rv_n"] and R["rv_n"]:
            lrv, rrv = 100 * L["rv"] / L["rv_n"], 100 * R["rv"] / R["rv_n"]
            weak, wl, srv = ("LHH", lrv, rrv) if lrv < rrv - 2.0 else (("RHH", rrv, lrv) if rrv < lrv - 2.0 else (None, 0, 0))
            if weak:
                hand = "L" if a["throws"] == "Left" else "R"
                opp = (hand == "R" and weak == "LHH") or (hand == "L" and weak == "RHH")
                sugg = ("a changeup or splitter that fades away from them"
                        if opp else "more sweep away from them — the same-side kill pitch")
                verb = ("Getting hurt by" if wl < 0 else "Noticeably weaker vs")
                add(e, "Arsenal",
                    f"{verb} {weak} ({wl:+.1f} RV/100 vs {srv:+.1f} against the other side). "
                    f"The classic fix is {sugg} — or steal usage from whatever they're sitting on.", prio=76)

        # release / extension
        if len(a["rh"]) >= 30:
            import statistics as _st
            sd = max(_st.pstdev(a["rh"]), _st.pstdev(a["rs"]))
            if sd > 0.28:
                add(e, "Delivery",
                    f"Release point wanders (±{sd:.2f} ft) — command and tunneling both leak from "
                    f"that. Repeatability work: towel drills, low-intent command bullpens.", prio=64)
        e_n = sum(t["ext_n"] for t in a["types"].values())
        if e_n >= 20:
            ext = sum(t["ext_s"] for t in a["types"].values()) / e_n
            pct = _pctl(ext, exts)
            if pct is not None and pct <= 25:
                add(e, "Delivery",
                    f"Extension {ext:.1f} ft ({_ord(pct)} percentile) — every foot down the mound is "
                    f"~1.5 mph of perceived velo. Stride/med-ball work is free velocity.", prio=58)

        # ── deeper pitch design: secondary separations ──
        ch = next((types[k] for k in ("ChangeUp", "Splitter") if k in types and types[k]["velo_n"] >= 10), None)
        if fb and fb["velo_n"] >= 15 and ch is not None:
            fbv = fb["velo_s"] / fb["velo_n"]
            chv = ch["velo_s"] / ch["velo_n"]
            sep = fbv - chv
            if sep < 6:
                add(e, "Pitch design",
                    f"Changeup is too firm — only {sep:.1f} mph off the fastball (8-12 is the window). "
                    f"Kill velocity without changing the arm: deeper grip, deaden the wrist, let it die.", prio=71)
            elif fb["ivb_n"] and ch["ivb_n"]:
                ivb_sep = fb["ivb_s"] / fb["ivb_n"] - ch["ivb_s"] / ch["ivb_n"]
                if ivb_sep < 6:
                    add(e, "Pitch design",
                        f"The changeup only separates by speed — its shape mirrors the fastball "
                        f"({ivb_sep:.0f}\" of drop separation). Kill spin / turn it over so it falls "
                        f"off the fastball plane instead of just arriving late.", prio=67)
        cb = types.get("Curveball")
        if fb and fb["velo_n"] >= 15 and cb is not None and cb["velo_n"] >= 10:
            gap = fb["velo_s"] / fb["velo_n"] - cb["velo_s"] / cb["velo_n"]
            if gap >= 16:
                add(e, "Pitch design",
                    f"Curveball is {gap:.0f} mph off the fastball — at that speed gap hitters ID it "
                    f"out of the hand. Power-curve intent: throw it HARDER with the same shape, even "
                    f"at the cost of a few inches of break.", prio=65)

        # command gap: a bat-misser he can't land
        cmd = [(k, t["wh"] / t["sw"], t["z_in"] / t["z_n"]) for k, t in types.items()
               if t["n"] >= 25 and t["sw"] >= 12 and t["z_n"] >= 20]
        cmd = [c for c in cmd if c[1] >= 0.32 and c[2] <= 0.38]
        if cmd:
            k, w, z = max(cmd, key=lambda c: c[1])
            add(e, "Command",
                f"The {k.lower()} misses bats ({100*w:.0f}% whiff) but he can't land it "
                f"({100*z:.0f}% zone) — its ceiling is pure command. Dial intent back to 80%, "
                f"glove-side targets, earn the right to bury it.", prio=73)

        # 2K finishing: throwing fastballs while a breaker misses bats
        if a["twok_n"] >= 40:
            fb2k = a["twok_fb"] / a["twok_n"]
            brs = [(k, t["wh"] / t["sw"]) for k, t in types.items()
                   if k in ("Slider", "Sweeper", "Curveball") and t["sw"] >= 20]
            if fb2k >= 0.55 and brs:
                bk2, bw2 = max(brs, key=lambda x: x[1])
                if bw2 >= 0.30:
                    add(e, "Usage",
                        f"Finishing with fastballs ({100*fb2k:.0f}% of two-strike pitches) while the "
                        f"{bk2.lower()} misses {100*bw2:.0f}% of swings. Flip the 2K script: breaker "
                        f"off the edge is the out pitch.", prio=69)

        # arsenal additions
        offs = sum(t["n"] for k, t in a["types"].items() if k in ("ChangeUp", "Splitter"))
        fb_ivb = (fb["ivb_s"] / fb["ivb_n"]) if fb and fb["ivb_n"] else None
        if a["n"] >= 150 and offs / a["n"] < 0.05:
            add(e, "Arsenal",
                f"No offspeed in the mix ({100*offs/a['n']:.0f}% usage) — everything he throws spins "
                f"the same direction. A changeup is the cheapest third dimension: same slot, kill the "
                f"hand at release, 300 flat-grounds before it sees a game.", prio=72)
        elif len(types) == 2:
            sugg = ("a depth breaker (curveball) that tunnels off the ride"
                    if fb_ivb is not None and fb_ivb >= 14
                    else "a sweeper — it pairs naturally with a sinking fastball")
            add(e, "Arsenal",
                f"Two-pitch mix — fine in relief, a ceiling as a starter. The shape that fits this "
                f"fastball is {sugg}.", prio=63)
        else:
            brk = [t for k, t in types.items() if k in ("Slider", "Sweeper", "Curveball")]
            if (fb_ivb is not None and fb_ivb >= 14 and brk
                    and all(t["ivb_n"] and t["ivb_s"] / t["ivb_n"] > -4 for t in brk)):
                add(e, "Arsenal",
                    f"Big-ride fastball ({fb_ivb:.0f}\") with no depth pitch under it — every breaker "
                    f"stays on plane. A true downer (curveball or harder-depth slider) doubles what "
                    f"the ride is worth up.", prio=64)

    # ── hitter rules ──
    for (name, tm), h in H.items():
        if h["seen"] < MIN_HITTER_N or (team and tm != team):
            continue
        e = entry(name, tm)
        e["roles"].append("hitter")
        bbe = len(h["evs"])
        avg_ev = sum(h["evs"]) / bbe if bbe else None
        ev_pct = _pctl(avg_ev, evs_c)
        gb_pct = _rate(sum(1 for la in h["las"] if la < 10), len(h["las"]), 0) if h["las"] else None

        # strength first
        if ev_pct is not None and ev_pct >= 65:
            add(e, "Identity",
                f"The bat speed is real: {avg_ev:.1f} mph average EV ({_ord(ev_pct)} percentile), "
                f"hard-hit {_rate(h['hh'], bbe)}%. Everything below is about cashing it in.",
                kind="strength", prio=90)
        elif h["oz"] >= 15 and h["ch"] / h["oz"] <= chase_avg - 0.05:
            add(e, "Identity",
                f"Elite swing decisions: {_rate(h['ch'], h['oz'])}% chase vs a {100*chase_avg:.0f}% "
                f"corpus average. The eye is the carrying tool — protect it.", kind="strength", prio=90)
        elif h["zsw"] >= 25 and h["zct"] / h["zsw"] >= 0.88:
            add(e, "Identity",
                f"Bat-to-ball is the tool: {_rate(h['zct'], h['zsw'])}% zone contact. "
                f"Development = turning contact into damage, not more contact.", kind="strength", prio=90)
        elif bbe >= 10 and avg_ev is not None:
            add(e, "Identity",
                f"Baseline: {avg_ev:.1f} mph EV on {bbe} tracked balls, {_rate(h['wh'], h['sw'])}% whiff. "
                f"Best current skill is shown below — the focuses are where the next level lives.",
                kind="strength", prio=40)

        # air-pull conversion
        if (bbe >= 20 and ev_pct is not None and ev_pct >= 55 and h["air"] >= 8
                and (h["pull_air"] / h["air"] < 0.22 or (gb_pct is not None and gb_pct >= 48))):
            pa = _rate(h["pull_air"], h["air"], 0)
            gb_txt = f", {gb_pct}% of contact on the ground" if gb_pct is not None and gb_pct >= 48 else ""
            add(e, "Approach",
                f"His EV deserves pulled air and he isn't getting there: only {pa}% of his air balls "
                f"are pulled{gb_txt}. Tee/flip work turning on the inner half, catch it out front — "
                f"that's where his slug is hiding.", prio=85)

        # two-strike contact
        if h["twok_sw"] >= 20:
            c2k = h["twok_ct"] / h["twok_sw"]
            if c2k < c2k_avg - 0.05:
                add(e, "Two-strike",
                    f"Two-strike contact {100*c2k:.0f}% vs a {100*c2k_avg:.0f}% corpus average — ABs are "
                    f"dying on strike three. Build a B-swing: choke, widen, cut the leg kick, protect away.",
                    prio=78)

        # chase / passivity
        if h["oz"] >= 20:
            ch = h["ch"] / h["oz"]
            if ch >= chase_avg + 0.06:
                add(e, "Swing decisions",
                    f"Chasing {100*ch:.0f}% of pitches out of the zone (corpus {100*chase_avg:.0f}%). "
                    f"Machine work with random in/out mixes, take-until-strike rounds — the swing is "
                    f"fine, the trigger is early.", prio=80)
        if h["heart_n"] >= 40:
            take = h["heart_take"] / h["heart_n"]
            if take >= 0.42:
                add(e, "Swing decisions",
                    f"Taking {100*take:.0f}% of pitches in the heart of the zone — passivity is "
                    f"donating strikes. Green-light early counts: hunt one zone, A-swing when it shows.",
                    prio=70)

        # zone contact
        if h["zsw"] >= 25:
            zc = h["zct"] / h["zsw"]
            if zc < 0.76:
                add(e, "Contact",
                    f"Zone contact {100*zc:.0f}% (corpus ~82%) — misses on hittable pitches cap "
                    f"everything else. Short-bat/one-hand drills, tempo work, track-to-contact rounds.",
                    prio=76)

        # box adjustment from thirds
        ti, to = h["thirds"].get("in"), h["thirds"].get("out")
        if ti and to and ti["sw"] >= 15 and to["sw"] >= 15:
            wi, wo = ti["wh"] / ti["sw"], to["wh"] / to["sw"]
            evi = ti["ev_s"] / ti["ev_n"] if ti["ev_n"] >= 5 else None
            evo = to["ev_s"] / to["ev_n"] if to["ev_n"] >= 5 else None
            out_worse_w = wo - wi >= 0.15
            out_worse_ev = evi is not None and evo is not None and evi - evo >= 7
            in_worse_w = wi - wo >= 0.15
            in_worse_ev = evi is not None and evo is not None and evo - evi >= 7
            if out_worse_w or out_worse_ev:
                why = (f"whiff {100*wo:.0f}% away vs {100*wi:.0f}% in" if out_worse_w
                       else f"EV {evo:.0f} away vs {evi:.0f} in")
                add(e, "Setup",
                    f"The outer third is beating him ({why}). Try crowding the plate a "
                    f"ball-width and hunting away early.", prio=66)
            elif in_worse_w or in_worse_ev:
                why = (f"whiff {100*wi:.0f}% in vs {100*wo:.0f}% away" if in_worse_w
                       else f"EV {evi:.0f} in vs {evo:.0f} away")
                add(e, "Setup",
                    f"Getting beat inside ({why}). Back off the plate a touch or start "
                    f"the hands earlier vs velo in.", prio=66)

        # pitch-type hole
        holes = []
        for pt, td in h["types"].items():
            if td["n"] >= 40 and td["sw"] >= 15:
                w = td["wh"] / td["sw"]
                if w >= 0.38:
                    xw = td["xw_s"] / td["xw_n"] if td["xw_n"] >= 5 else None
                    holes.append((pt, w, xw, td["n"]))
        noted_types = set()
        if holes:
            pt, w, xw, n = max(holes, key=lambda x: x[1])
            noted_types.add(pt)
            dmg = (f" — but he DOES damage when he connects (.{int(round(xw*1000)):03d} xwOBAcon), so "
                   f"it's pitch selection, not the swing" if xw is not None and xw >= 0.36 else
                   ". Recognition work: machine rounds, spin-ID off the hand")
            add(e, "Pitch recognition",
                f"Whiffing {100*w:.0f}% of swings vs the {pt.lower()} ({n:.0f} seen){dmg}.", prio=74)

        # ── what he hits vs what he doesn't ──
        typed = [(pt, td) for pt, td in h["types"].items() if td["xw_n"] >= 8]
        overall_sw = h["sw"] / h["seen"] if h["seen"] else 0
        if typed:
            bpt, btd = max(typed, key=lambda kv: kv[1]["xw_s"] / kv[1]["xw_n"])
            bxw = btd["xw_s"] / btd["xw_n"]
            if bxw >= 0.40:
                bev = btd["ev_s"] / btd["ev_n"] if btd["ev_n"] else None
                add(e, "Pitch plan",
                    f"Feasts on the {bpt.lower()}: .{int(round(bxw*1000)):03d} xwOBAcon"
                    + (f" at {bev:.0f} mph" if bev else "")
                    + f" on {btd['xw_n']:.0f} in play. That's the pitch to hunt in plus counts.",
                    kind="strength", prio=72)
                b_swing = btd["sw"] / btd["n"] if btd["n"] else 0
                if btd["n"] >= 30 and b_swing <= overall_sw - 0.08:
                    add(e, "Pitch plan",
                        f"Passive against his best pitch — swings at only {100*b_swing:.0f}% of "
                        f"{bpt.lower()}s vs {100*overall_sw:.0f}% overall. He's taking the pitch he "
                        f"crushes; green-light it, especially early.", prio=71)
            wpt, wtd = min(typed, key=lambda kv: kv[1]["xw_s"] / kv[1]["xw_n"])
            wxw = wtd["xw_s"] / wtd["xw_n"]
            if wxw <= 0.28 and wpt not in noted_types and wtd["la_n"] >= 8:
                wla = wtd["la_s"] / wtd["la_n"]
                gbr = wtd["gb"] / wtd["la_n"]
                if gbr >= 0.55 or wla < 5:
                    add(e, "Pitch plan",
                        f"Beats the {wpt.lower()} into the ground: {wla:.0f}° average launch, "
                        f"{100*gbr:.0f}% grounders, .{int(round(wxw*1000)):03d} xwOBAcon. Either "
                        f"elevate it (tee work catching it deeper/under) or stop offering at it "
                        f"below the zone.", prio=70)
                else:
                    add(e, "Pitch plan",
                        f"Produces just .{int(round(wxw*1000)):03d} xwOBAcon vs the {wpt.lower()} "
                        f"({wtd['xw_n']:.0f} in play) — dedicated machine work on that shape.", prio=62)

        # chase vs spin specifically
        br_oz = sum(td["oz"] for k, td in h["types"].items() if k in ("Slider", "Sweeper", "Curveball"))
        br_ch = sum(td["ch"] for k, td in h["types"].items() if k in ("Slider", "Sweeper", "Curveball"))
        fb_oz = sum(td["oz"] for k, td in h["types"].items() if k in ("Fastball", "Sinker", "Cutter"))
        fb_ch = sum(td["ch"] for k, td in h["types"].items() if k in ("Fastball", "Sinker", "Cutter"))
        if br_oz >= 20 and fb_oz >= 15:
            brr, fbr = br_ch / br_oz, fb_ch / fb_oz
            if brr >= fbr + 0.12:
                add(e, "Swing decisions",
                    f"Expands specifically against spin: chases {100*brr:.0f}% of breaking balls off "
                    f"the plate vs {100*fbr:.0f}% of fastballs. Spin-recognition rounds — call the "
                    f"pitch out loud before swing/take decisions.", prio=75)

        # swing rate suppressing on-base skills
        if h["seen"] >= 80 and overall_sw >= swing_avg + 0.07 and h["oz"] >= 15 \
                and h["ch"] / h["oz"] >= chase_avg:
            add(e, "Approach",
                f"The swing rate is suppressing his on-base skills: offers at {100*overall_sw:.0f}% "
                f"of pitches (corpus {100*swing_avg:.0f}%). Walks live in the takes he isn't making — "
                f"strike-one can be a take without costing him anything.", prio=73)

        # transfer gap
        if h["bp_evn"] >= 15 and bbe >= 15:
            live_hh, bp_hh = h["hh"] / bbe, h["bp_hh"] / h["bp_evn"]
            if bp_hh - live_hh >= 0.12:
                add(e, "Transfer",
                    f"Hard-hit {100*bp_hh:.0f}% in BP vs {100*live_hh:.0f}% live — the cage swing "
                    f"isn't surviving game speed. More velo/random BP, fewer grooved rounds.", prio=68)

    # ── defense rules ──
    DIR_TXT = {"left": "moving to his left (1B side)", "right": "moving to his right (3B side)",
               "in": "coming in on balls", "back": "going back"}
    for row in (dfs.get("infield") or []) + (dfs.get("outfield") or []):
        name = row["player"]
        if team is None and name not in players:
            continue  # only annotate players already on the board unless team-filtered
        e = players.get(name) or entry(name, row.get("team") or "")
        if "defense" not in e["roles"]:
            e["roles"].append("defense")
        dirs = row.get("dirs") or {}
        worst = None
        for d, v in dirs.items():
            if not v:
                continue
            if v["opps"] >= 8 and v["oae"] <= -1.2 and (worst is None or v["oae"] < worst[1]["oae"]):
                worst = (d, v)
        if worst:
            d, v = worst
            add(e, "Defense",
                f"Struggles {DIR_TXT.get(d, d)}: {v['oae']:+.1f} outs above expected on "
                f"{v['opps']} chances. First-step and crossover work in that direction; check the "
                f"pre-pitch setup isn't cheating the other way.", prio=72)
        errs, thru = row.get("errors") or 0, row.get("through") or 0
        if errs >= 3 and errs > thru:
            add(e, "Defense",
                f"The range is fine — he reaches the ball and loses it ({errs} errors vs {thru} "
                f"through). Hands and throw cleanup: short-hop rounds, footwork-to-throw tempo.", prio=68)
        elif thru >= 5 and thru >= errs * 2 and (row.get("conv_pct") or 1) < (row.get("x_conv_pct") or 0):
            add(e, "Defense",
                f"Balls are getting past cleanly ({thru} through, only {errs} errors) — that's range "
                f"or first read, not hands. Reaction/first-step work off the bat.", prio=66)
        b = row.get("buckets") or {}
        r_opp, r_made = (b.get("routine") or [0, 0])[0], (b.get("routine") or [0, 0])[1]
        if r_opp >= 12 and r_made / r_opp < 0.93:
            add(e, "Defense",
                f"Converting only {r_made}/{r_opp} routine plays — the easy ones are the leak. "
                f"Boring-glove volume: routine reps at game tempo until they're automatic.", prio=70)

    # position-vs-position: same glove, different spots (Fahland: good SS, rough 3B)
    pos_rows = defaultdict(list)
    for pos, lst in (dfs.get("by_position") or {}).items():
        for row in lst:
            if row["opps"] >= 8:
                pos_rows[row["player"]].append((pos, row["oae"], row["opps"]))
    for name, lst in pos_rows.items():
        if len(lst) < 2 or name not in players:
            continue
        best = max(lst, key=lambda x: x[1])
        worst = min(lst, key=lambda x: x[1])
        if best[1] >= 0 and worst[1] <= -1.5:
            add(players[name], "Defense",
                f"Two different defenders depending on the spot: {best[1]:+.1f} OAE at {best[0]} "
                f"({best[2]} chances) vs {worst[1]:+.1f} at {worst[0]} ({worst[2]}). The glove plays "
                f"at {best[0]} — treat {worst[0]} innings as development reps, not a default.", prio=77)

    # ── catcher rules ──
    # per-edge corpus baselines: umpires corpus-wide call some edges tighter
    # (the low edge nets negative for EVERYONE) — a coaching point is being
    # worse than the corpus ON that edge, not sharing the corpus bias.
    EDGE_TXT = {"high": "top", "low": "bottom", "left": "glove-side", "right": "arm-side"}
    edge_ratio = {}
    for edge in EDGE_TXT:
        st = sum((c.get("edges") or {}).get(edge, {}).get("strikes", 0) for c in cat.get("catchers", []))
        xx = sum((c.get("edges") or {}).get(edge, {}).get("x", 0) for c in cat.get("catchers", []))
        edge_ratio[edge] = (st / xx) if xx else 1.0
    for c in cat.get("catchers", []):
        name = c["catcher"]
        if (c.get("shadow_taken") or 0) < 60 and (c.get("throws") or 0) < 3:
            continue
        e = players.get(name) or entry(name, c.get("catcher_team") or "")
        if "catcher" not in e["roles"]:
            e["roles"].append("catcher")
        edges = c.get("edges") or {}
        excess = {k: v["strikes"] - v["x"] * edge_ratio[k] for k, v in edges.items() if v.get("x")}
        worst = min(excess.items(), key=lambda kv: kv[1]) if excess else None
        if (c.get("sae") or 0) >= 3:
            add(e, "Catching",
                f"Plus framer: +{c['sae']} strikes above expected on {c['shadow_taken']} edge takes. "
                f"Keep the receiving pattern exactly as is.", kind="strength", prio=80)
        if worst and worst[1] <= -2.0:
            add(e, "Catching",
                f"Losing calls on the {EDGE_TXT.get(worst[0], worst[0])} edge ({worst[1]:+.1f} strikes "
                f"vs how that edge gets called corpus-wide). Presentation work there: beat the ball "
                f"to the spot, stick it, quiet glove.", prio=74)
        pop, exch = c.get("avg_pop"), c.get("avg_exchange")
        if pop is not None and pop >= 2.12:
            if exch is not None and exch >= 0.85:
                add(e, "Catching",
                    f"Pop time {pop:.2f} and the exchange ({exch:.2f}s) is where it lives — the arm "
                    f"isn't the problem. Transfer drills: glove-to-ear reps, footwork timing.", prio=70)
            else:
                add(e, "Catching",
                    f"Pop time {pop:.2f} with a clean exchange — this one is arm strength and "
                    f"footwork drive. Long toss + weighted-ball program for the carry.", prio=68)

    # ── guarantee two points per player ──
    out = []
    for e in players.values():
        if team and e["team"] != team and e["team"]:
            continue
        pts = sorted(e["points"], key=lambda p: (-int(p["kind"] == "strength"), -p["prio"]))
        if not pts:
            continue
        if len(pts) < 2:
            pts.append({"area": "Profile", "kind": "focus", "prio": 10,
                        "note": "Balanced profile — nothing flags hard in the tracked data. "
                                "Development here is volume: more tracked live reps to sharpen the picture."})
        e["points"] = pts[:7]
        e["roles"] = list(dict.fromkeys(e["roles"]))
        out.append(e)

    role_rank = lambda e: (0 if "pitcher" in e["roles"] else 1, -len(e["points"]))
    out.sort(key=role_rank)
    return {"players": out, "count": len(out)}
