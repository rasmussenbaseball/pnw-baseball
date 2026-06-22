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
from collections import defaultdict
from datetime import datetime

# ---- tunables (documented in RAPSODO_TOOL_DESIGN.md; conventions, not laws) ----
LOW_CONFIDENCE = 0.5        # spin_confidence <= this -> exclude from shape centroids
FB_VELO_BAND = 5.0          # pitches within this many mph of session top velo = "fastball-ish"
RIDE_IVB = 17.0             # 4-seam "carries" at/above this induced vertical break
SINK_IVB = 10.0             # sinker territory below this IVB with strong arm-side run
ARM_SIDE_RUN = 14.0         # inches of arm-side HB that counts as a "running" pitch

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
        "rel_height": _f(r.get("Release Height")),
        "rel_side": _f(r.get("Release Side")),
        "extension": _f(r.get("Release Extension (ft)")),
        "vaa": _f(r.get("Vertical Approach Angle")),
        "haa": _f(r.get("Horizontal Approach Angle")),
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


def classify(p, fb_velo, hand):
    """Re-classify ONE pitch by shape, ignoring Rapsodo's label. arm_hb must
    already be set (arm-side positive). Returns a label string.

    v1 heuristic: classifies each pitch in isolation against fixed thresholds.
    Good enough to correct obvious mislabels; Phase 3 replaces this with real
    cluster-then-label so fuzzy breakers stop over-splitting."""
    velo, ivb, ahb, eff, gyro = p["velo"], p["ivb"], p["arm_hb"], p["spin_eff"], p["gyro"]
    if velo is None or ivb is None or ahb is None:
        return "unclassified"
    gap = (fb_velo - velo) if fb_velo else 0      # mph slower than the fastball
    g = abs(gyro) if gyro is not None else None

    # fastball family: hard, high efficiency, arm-side / ride
    if gap <= 6 and (eff is None or eff >= 80) and ivb >= 6 and ahb >= -2:
        if ivb >= RIDE_IVB and ahb < 10:
            return "4-seam (ride)"
        if ivb < SINK_IVB and ahb >= ARM_SIDE_RUN:
            return "sinker / 2-seam"
        return "fastball (mixed)"
    # changeup: clearly slower, arm-side, less ride than the FB
    if gap >= 6 and ahb >= 8:
        return "changeup"
    # cutter: near FB velo, modest glove-side, partial efficiency, some ride
    if gap <= 7 and -8 <= ahb <= 2 and (eff is None or 35 <= eff <= 70) and ivb >= 4:
        return "cutter"
    # breaking balls: glove side and/or low efficiency / high gyro
    if ahb < 0 or (eff is not None and eff < 60) or (g is not None and g >= 45):
        if ivb < -2:
            return "curveball"
        if g is not None and g >= 60 and abs(ahb) < 6:
            return "gyro slider"
        if ahb <= -8:
            return "sweeper"
        return "slider"
    return "unclassified"


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
            "tilt": _common_tilt(ps),
            "rel_height": _mean([p["rel_height"] for p in ps]),
            "rel_side": _mean([p["rel_side"] for p in ps]),
            "ext": _mean([p["extension"] for p in ps]),
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

    ok = [p for p in pitches if p["quality"] == "ok"]
    fb_velo = None
    if ok:
        top = max(p["velo"] for p in ok if p["velo"])
        fbs = [p["velo"] for p in ok if p["velo"] and p["velo"] >= top - FB_VELO_BAND]
        fb_velo = round(sum(fbs) / len(fbs), 1) if fbs else top
    for p in pitches:
        p["pitch"] = classify(p, fb_velo, hand) if p["quality"] in ("ok", "low_confidence") else None

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
