"""Rapsodo CSV parser / normalizer — the trustworthy data layer.

Turns a raw Rapsodo pitching export (any device generation) into clean,
handedness-correct, quality-flagged, RE-CLASSIFIED pitch data. Pure functions,
no DB and no I/O beyond reading a file/string, so both the upload endpoint
(app.api.rapsodo) and the CLI (scripts/rapsodo/parse.py) import from here.

See RAPSODO_TOOL_DESIGN.md for the full plan. What this does that raw Rapsodo
does not: normalizes heterogeneous device exports to one movement basis, gates
junk reads, infers handedness, and re-classifies pitches by shape (ignoring
Rapsodo's unreliable Pitch Type labels).
"""
import csv
import io
import math
from collections import defaultdict
from datetime import datetime

# ---- tunables (documented in RAPSODO_TOOL_DESIGN.md; conventions, not laws) ----
LOW_CONFIDENCE = 0.5        # spin_confidence <= this -> exclude from shape centroids
FB_VELO_BAND = 5.0          # pitches within this many mph of session top velo = "fastball-ish"
RIDE_IVB = 17.0             # 4-seam "carries" at/above this induced vertical break
SINK_IVB = 10.0             # sinker territory below this IVB with strong arm-side run
ARM_SIDE_RUN = 14.0         # inches of arm-side HB that counts as a "running" pitch
WARMUP_GAP = 11.0           # a fastball-SHAPED pitch this many mph below the FB baseline = warmup lob

_DATE_FMT = "%a %b %d %Y %I:%M:%S %p"   # "Sun Dec 28 2025 1:13:36 AM"


def _f(v):
    """Rapsodo blanks are '-' or empty; everything else is a float (or None)."""
    if v is None:
        return None
    s = str(v).strip()
    if s in ("", "-"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _clock_to_deg(tilt):
    """'01:38' spin-direction clock -> degrees clockwise from 12:00 (0 = pure
    backspin/ride). None if unparseable."""
    if not tilt or ":" not in str(tilt):
        return None
    try:
        hh, mm = str(tilt).strip().split(":")
        return ((int(hh) % 12) * 30) + (int(mm) * 0.5)
    except (ValueError, IndexError):
        return None


def _estimate_vaa(velo, rel_angle, rel_height, sz_height, ext):
    """Geometric vertical approach angle (deg, negative = downward) at the plate.
    These devices rarely report measured VAA, so we estimate it from release
    kinematics: a constant-vertical-acceleration (parabolic) flight from the
    release point to the plate-crossing height. Inputs: velo (mph), release angle
    (deg, vertical launch), release height (ft), plate-crossing height (in),
    extension (ft). ~±0.5 deg vs measured — enough to tell flat from steep, which
    is what matters for the dead-zone call."""
    if velo is None or rel_angle is None or rel_height is None or sz_height is None:
        return None
    vx = velo * 1.467                                # mph -> ft/s (horizontal approx)
    if vx <= 0:
        return None
    D = 60.5 - (ext if ext else 6.0) - 1.4           # release point -> front of plate (ft)
    if D < 20:
        D = 54.0
    t = D / vx
    plate_h = sz_height / 12.0                        # plate-crossing height (in -> ft)
    vy0 = vx * math.tan(math.radians(rel_angle))      # vertical velo at release
    vyf = 2.0 * (plate_h - rel_height) / t - vy0      # const-accel: disp = (vy0+vyf)/2 * t
    return round(math.degrees(math.atan2(vyf, vx)), 1)


def _parse_dt(s):
    if not s:
        return None
    try:
        return datetime.strptime(str(s).strip(), _DATE_FMT)
    except (ValueError, TypeError):
        return None


def device_generation(serial):
    if not serial:
        return "unknown"
    s = serial.upper()
    if s.startswith("MTD"):
        return "PRO 2.0"          # documented MTD prefix
    if s.startswith("RCE"):
        return "PRO/3.0-class"    # reports spin break + gyro; exact gen unconfirmed
    return "unknown"


def _read_rows(all_rows):
    """Pull the metadata header (Player ID/Name) and the per-pitch dict rows out
    of a Rapsodo export. Rows 1-4 are metadata; the real header starts at 'No'."""
    player_id = player_name = None
    header = header_idx = None
    for i, row in enumerate(all_rows):
        if not row:
            continue
        c0 = row[0].strip().strip('"')
        if c0 == "Player ID:" and len(row) > 1:
            player_id = row[1].strip()
        elif c0 == "Player Name:" and len(row) > 1:
            player_name = row[1].strip()
        elif c0 == "No":
            header, header_idx = [c.strip() for c in row], i
            break
    if header is None:
        raise ValueError("could not find pitch header row (starting with 'No')")
    rows = []
    for row in all_rows[header_idx + 1:]:
        if not row or not row[0].strip():
            continue
        rows.append(dict(zip(header, row)))
    return player_id, player_name, rows


def normalize_pitch(r):
    """One raw CSV row -> a normalized pitch dict with a single movement basis,
    derived metrics, and a quality flag. arm_hb is filled later (needs the whole
    session to know handedness)."""
    velo = _f(r.get("Velocity"))
    total_spin = _f(r.get("Total Spin"))
    true_spin = _f(r.get("True Spin (release)"))
    eff = _f(r.get("Spin Efficiency (release)"))
    conf = _f(r.get("Spin Confidence"))
    gyro = _f(r.get("Gyro Degree (deg)"))

    # movement basis: prefer Magnus-only spin break (~Statcast IVB/HB); fall back
    # to trajectory break (PRO 2.0 primary); record which we used.
    vb_spin, hb_spin = _f(r.get("VB (spin)")), _f(r.get("HB (spin)"))
    vb_traj, hb_traj = _f(r.get("VB (trajectory)")), _f(r.get("HB (trajectory)"))
    if vb_spin is not None and hb_spin is not None:
        ivb, hb, basis = vb_spin, hb_spin, "spin"
    elif vb_traj is not None and hb_traj is not None:
        ivb, hb, basis = vb_traj, hb_traj, "trajectory"
    else:
        ivb = hb = None
        basis = "none"

    if velo is None and ivb is None:
        quality = "failed"            # dead row, no usable data
    elif ivb is None or eff is None:
        quality = "partial"           # has velo but no shape
    elif conf is not None and conf <= LOW_CONFIDENCE:
        quality = "low_confidence"
    else:
        quality = "ok"

    active_spin = round(total_spin * eff / 100.0) if (total_spin and eff) else true_spin
    bauer = round(total_spin / velo, 1) if (total_spin and velo) else None
    dt = _parse_dt(r.get("Date"))

    rel_height = _f(r.get("Release Height"))
    rel_angle = _f(r.get("Release Angle"))
    extension = _f(r.get("Release Extension (ft)"))
    sz_height = _f(r.get("Strike Zone Height"))
    vaa_device = _f(r.get("Vertical Approach Angle"))
    vaa = vaa_device if vaa_device is not None else _estimate_vaa(velo, rel_angle, rel_height, sz_height, extension)

    return {
        "pitch_no": _int(r.get("No")),
        "thrown_at": dt.isoformat() if dt else None,
        "raw_label": (r.get("Pitch Type") or "").strip() or None,
        "velo": velo,
        "total_spin": round(total_spin) if total_spin else None,
        "active_spin": active_spin,
        "spin_eff": eff,
        "spin_confidence": conf,
        "gyro": gyro,
        "ivb": ivb,
        "hb_raw": hb,                 # Rapsodo fixed frame (neg = breaks left)
        "arm_hb": None,               # filled after handedness is known
        "movement_basis": basis,
        "tilt": (r.get("Spin Direction") or "").strip().strip('"') or None,
        "tilt_deg": _clock_to_deg(r.get("Spin Direction")),
        "rel_height": rel_height,
        "rel_side": _f(r.get("Release Side")),
        "extension": extension,
        "rel_angle": rel_angle,
        "horiz_angle": _f(r.get("Horizontal Angle")),
        "vaa": vaa,
        "vaa_estimated": vaa_device is None and vaa is not None,
        "haa": _f(r.get("Horizontal Approach Angle")),
        "sz_side": _f(r.get("Strike Zone Side")),
        "sz_height": sz_height,
        "bauer": bauer,
        "intent": (r.get("Intent Type") or "").strip() or None,
        "is_strike": (r.get("Is Strike") or "").strip() or None,
        "quality": quality,
    }


def _int(v):
    try:
        return int(str(v).strip())
    except (ValueError, TypeError):
        return None


def infer_handedness(pitches):
    """Classify the primary fastball cluster (fastest pitches) and read its raw
    HB sign: positive => RHP, negative => LHP. Returns ('R'|'L'|None, why)."""
    usable = [p for p in pitches if p["quality"] == "ok" and p["velo"] and p["hb_raw"] is not None]
    if not usable:
        return None, "no usable pitches with movement"
    top = max(p["velo"] for p in usable)
    fb = [p for p in usable if p["velo"] >= top - FB_VELO_BAND]
    avg_hb = sum(p["hb_raw"] for p in fb) / len(fb)
    hand = "R" if avg_hb > 0 else "L"
    return hand, f"fastball cluster avg raw HB {avg_hb:+.1f} over {len(fb)} pitches"


def _fastball_centroid(ok_pitches):
    """Centroid (velo, ivb, arm_hb) of the fastest cluster — the presumed
    fastball — used as the reference every other pitch is classified against."""
    cand = [p for p in ok_pitches
            if p["velo"] is not None and p["ivb"] is not None and p["arm_hb"] is not None]
    if not cand:
        return None
    top = max(p["velo"] for p in cand)
    fb = [p for p in cand if p["velo"] >= top - FB_VELO_BAND] or cand
    n = len(fb)
    return {
        "velo": round(sum(p["velo"] for p in fb) / n, 1),
        "ivb": round(sum(p["ivb"] for p in fb) / n, 1),
        "arm_hb": round(sum(p["arm_hb"] for p in fb) / n, 1),
    }


def classify(p, fb, hand):
    """Re-classify ONE pitch by shape, ignoring Rapsodo's label. arm_hb must
    already be set (arm-side positive); `fb` is the fastball centroid from
    _fastball_centroid (or None). Returns a label string.

    Cluster-relative: each pitch is judged against the pitcher's own fastball,
    so a sub-max-effort heater that keeps its ride stays a fastball, and a
    changeup must actually KILL ride vs the FB (not just be slower). Still a
    heuristic — Phase 3 will add full cluster-then-label for fuzzy breakers."""
    velo, ivb, ahb, eff = p["velo"], p["ivb"], p["arm_hb"], p["spin_eff"]
    spin = p.get("total_spin")
    if velo is None or ivb is None or ahb is None:
        return "unclassified"
    g = abs(p["gyro"]) if p["gyro"] is not None else None
    fbv = fb["velo"] if fb else velo
    fbivb = fb["ivb"] if fb else ivb
    gap = fbv - velo                              # mph slower than the fastball

    # FASTBALL FAMILY: hard (not much slower than the FB), arm-side, riding.
    # eff floor is low (70) on purpose: plenty of good fastballs spin at 70-80%
    # efficiency, and a lower-eff pitch that's still hard + riding + arm-side is a
    # fastball, not a breaker (breakers are glove-side or low-ride, excluded below).
    if gap <= 6 and (eff is None or eff >= 70) and ivb >= 6 and ahb >= -2:
        if ivb >= RIDE_IVB and ahb < 10:
            return "4-seam (ride)"
        if ivb < SINK_IVB and ahb >= ARM_SIDE_RUN:
            return "sinker / 2-seam"
        return "fastball (mixed)"
    # SINKER / 2-SEAM (slightly slower): a heavy arm-side runner a few mph off the
    # 4-seam still keeping ride. True changeups are either lower-ride or 10+ slower,
    # so the gap<=10 + ride>=6 + big-run gates exclude them.
    if 6 < gap <= 10 and ivb >= 6 and ahb >= 11 and (eff is None or eff >= 70):
        return "sinker / 2-seam"
    # CHANGEUP: slower, arm-side, AND ride killed vs the fastball — so a slow
    # pitch that keeps full fastball ride is NOT a changeup (that was the v1 bug).
    if gap >= 6 and ahb >= 8 and ivb <= fbivb - 4:
        return "changeup"
    # SPLITTER: killed velo + LOW spin (tumbles), arm-side / straight. Low spin is
    # the splitter tell (changeups spin higher and fade more).
    if gap >= 5 and spin is not None and spin < 1600 and ahb >= -3:
        return "splitter"
    # CUTTER: a few mph off the FB with the ride TAKEN OFF (well below the FB's
    # ride) and only a small glove-side/neutral break. Cluster-relative, so a
    # high-efficiency "slutter" still reads as a cutter — efficiency alone is an
    # unreliable cutter signal (e.g. Oliver Duthie's 89%-eff cutter).
    if 2 <= gap <= 9 and -8 <= ahb <= 3 and ivb >= 0 and ivb <= fbivb - 3:
        return "cutter"
    # BREAKING BALLS: glove side and/or low efficiency / high gyro.
    if ahb < 0 or (eff is not None and eff < 60) or (g is not None and g >= 45):
        if ivb <= -2:
            return "curveball"
        if g is not None and g >= 60 and abs(ahb) < 8:
            return "gyro slider"
        if ahb <= -8:
            return "sweeper"
        return "slider"
    return "unclassified"


def _is_warmup(p, fb):
    """A fastball-SHAPED pitch thrown well below the fastball baseline is almost
    always a warmup lob / sub-max toss, not a real offspeed (a real curve/change
    is slow because of its shape, not effort). Flag those so they don't pollute
    the arsenal, plots, or suggestions."""
    if not fb or p.get("velo") is None or p.get("ivb") is None or p.get("arm_hb") is None:
        return False
    eff = p.get("spin_eff")
    return (p["velo"] <= fb["velo"] - WARMUP_GAP        # way slower than the FB
            and (eff is None or eff >= 85)              # ...but spun like a fastball
            and p["ivb"] >= fb["ivb"] - 4               # ...keeps the FB's ride (a changeup kills it)
            and p["arm_hb"] >= -2)                      # ...arm-side / straight, not breaking


def classify_session(pitches, hand=None):
    """Label every pitch in a session and flip clear warmup lobs to quality
    'warmup'. Mutates each pitch's `pitch` and `quality`. Returns the fastball
    centroid. Shared by the CSV parse path and the DB re-classify path so both
    stay in lockstep."""
    cand = [p for p in pitches if p.get("quality") in ("ok", "warmup")]
    fb = _fastball_centroid(cand)
    for p in pitches:
        q = p.get("quality")
        if q in ("ok", "warmup"):
            if _is_warmup(p, fb):
                p["quality"], p["pitch"] = "warmup", None
            else:
                p["quality"], p["pitch"] = "ok", classify(p, fb, hand)
        elif q == "low_confidence":
            p["pitch"] = classify(p, fb, hand)
        else:
            p["pitch"] = None
    return fb


def reclassify(pitches, hand=None):
    """Re-run classification + lob-filtering on already-normalized pitch dicts
    (e.g. rows read back from the DB), so classifier improvements apply
    retroactively without re-uploading. Returns [{pitch, quality}] aligned with
    `pitches`. DB rows are Decimal; coerce the numeric fields to float here since
    classify/_fastball_centroid do float math."""
    def _fnum(v):
        return float(v) if v is not None else None
    norm = [{**p, "velo": _fnum(p.get("velo")), "ivb": _fnum(p.get("ivb")),
             "arm_hb": _fnum(p.get("arm_hb")), "spin_eff": _fnum(p.get("spin_eff")),
             "gyro": _fnum(p.get("gyro"))} for p in pitches]
    classify_session(norm, hand)
    return [{"pitch": p.get("pitch"), "quality": p.get("quality")} for p in norm]


def _mean(vals):
    vals = [v for v in vals if v is not None]
    return round(sum(vals) / len(vals), 1) if vals else None


def aggregate_arsenal(ok_pitches):
    """Group OK pitches by their re-classified label into per-pitch centroids.
    Reused by both the per-session parse and the cross-session profile API."""
    groups = defaultdict(list)
    for p in ok_pitches:
        if p.get("pitch"):
            groups[p["pitch"]].append(p)
    arsenal = []
    for label, ps in groups.items():
        velos = [p["velo"] for p in ps if p["velo"] is not None]
        arsenal.append({
            "pitch": label,
            "count": len(ps),
            "velo": _mean([p["velo"] for p in ps]),
            "velo_max": round(max(velos), 1) if velos else None,
            "total_spin": _mean([p["total_spin"] for p in ps]),
            "spin_eff": _mean([p["spin_eff"] for p in ps]),
            "ivb": _mean([p["ivb"] for p in ps]),
            "arm_hb": _mean([p["arm_hb"] for p in ps]),
            "gyro": _mean([p["gyro"] for p in ps]),
            "vaa": _mean([p.get("vaa") for p in ps]),
            "tilt": _common_tilt(ps),
            "rel_height": _mean([p["rel_height"] for p in ps]),
            "rel_side": _mean([p["rel_side"] for p in ps]),
            # exclude 0 / None: some devices report extension as 0 when unmeasured,
            # and averaging those zeros in wrecks perceived-velo / Stuff.
            "ext": _mean([p["extension"] for p in ps if p["extension"] not in (None, 0)]),
        })
    arsenal.sort(key=lambda a: a["count"], reverse=True)
    return arsenal


def _common_tilt(ps):
    counts = defaultdict(int)
    for p in ps:
        if p.get("tilt"):
            counts[p["tilt"]] += 1
    return max(counts, key=counts.get) if counts else None


def parse_rows(all_rows, source_name):
    """Full pipeline for one CSV's already-split rows. Returns a structured,
    DB-ready dict (the session)."""
    player_id, player_name, raw_rows = _read_rows(all_rows)
    serial = next((r.get("Device Serial Number") for r in raw_rows
                   if (r.get("Device Serial Number") or "").strip() not in ("", "-")), None)
    pitches = [normalize_pitch(r) for r in raw_rows]

    hand, hand_why = infer_handedness(pitches)
    flip = -1 if hand == "L" else 1
    for p in pitches:
        p["arm_hb"] = round(p["hb_raw"] * flip, 1) if p["hb_raw"] is not None else None

    fb = classify_session(pitches, hand)
    fb_velo = fb["velo"] if fb else None
    ok = [p for p in pitches if p["quality"] == "ok"]   # warmups now excluded

    arsenal = aggregate_arsenal(ok)

    qc = defaultdict(int)
    for p in pitches:
        qc[p["quality"]] += 1
    velos = [p["velo"] for p in pitches if p["velo"]]
    intents = sorted({p["intent"] for p in pitches if p["intent"]})
    dts = [p["thrown_at"] for p in pitches if p["thrown_at"]]
    session_date = min(dts)[:10] if dts else None

    return {
        "source_file": source_name,
        "rapsodo_player_id": player_id,
        "player_name": player_name,
        "device_serial": serial,
        "device_generation": device_generation(serial),
        "handedness": hand,
        "handedness_basis": hand_why,
        "fastball_velo": fb_velo,
        "session_date": session_date,
        "n_pitches": len(pitches),
        "qc": dict(qc),
        "velo_range": [round(min(velos), 1), round(max(velos), 1)] if velos else None,
        "intent_tags": intents or None,
        "arsenal": arsenal,
        "pitches": pitches,
    }


def parse_text(text, source_name):
    return parse_rows(list(csv.reader(io.StringIO(text))), source_name)


def parse_session(path):
    with open(path, newline="", encoding="utf-8-sig") as fh:
        return parse_rows(list(csv.reader(fh)), path)
