"""Pitch tempo and in-outing fatigue from TrackMan game rows.

Tempo: seconds between consecutive pitches of the SAME plate appearance
(TrackMan stamps every pitch with a wall-clock time). Staying inside the PA
sidesteps the batter-change gap and the missing runner data; the pitch clock
in college is 20 s with bases empty, so the result reads on that scale.

Fatigue: a pitcher's own pitches in each outing are numbered 1..N and
bucketed in 15s. Velo, Stuff+, zone rate, whiff rate and run value by
bucket show what the arm looks like deep into an outing, the read a staff
uses for pitch limits.
"""
from collections import defaultdict
from statistics import median

TEMPO_MIN_S, TEMPO_MAX_S = 5.0, 45.0


def _secs(t):
    """'HH:MM:SS.ff' -> seconds, or None."""
    if not t:
        return None
    try:
        parts = str(t).split(":")
        if len(parts) != 3:
            return None
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    except (TypeError, ValueError):
        return None


def tempo_gaps(rows):
    """[(gap_seconds, row_of_the_later_pitch)] within plate appearances."""
    by_pa = defaultdict(list)
    for r in rows:
        if r.get("pa_of_inning") is None or r.get("time") is None:
            continue
        key = (r.get("session_id"), r.get("inning"), r.get("top_bottom"), r.get("pa_of_inning"))
        by_pa[key].append(r)
    gaps = []
    for pa in by_pa.values():
        pa.sort(key=lambda r: (r.get("pitch_of_pa") or 0, r.get("pitch_no") or 0))
        for a, b in zip(pa, pa[1:]):
            ta, tb = _secs(a.get("time")), _secs(b.get("time"))
            if ta is None or tb is None:
                continue
            g = tb - ta
            if TEMPO_MIN_S <= g <= TEMPO_MAX_S:
                gaps.append((g, b))
    return gaps


def _summ(vals):
    if not vals:
        return None
    v = sorted(vals)
    n = len(v)
    return {"median": round(median(v), 1), "p25": round(v[n // 4], 1), "p75": round(v[(3 * n) // 4], 1), "n": n}


def tempo_summary(rows, min_n=10):
    gaps = tempo_gaps(rows)
    if len(gaps) < min_n:
        return None
    allv = [g for g, _ in gaps]
    out = {"all": _summ(allv), "by_type": {}, "by_count": {}}
    by_t, by_c = defaultdict(list), defaultdict(list)
    for g, r in gaps:
        if r.get("ptype"):
            by_t[r["ptype"]].append(g)
        b, s = r.get("balls"), r.get("strikes")
        if b is not None and s is not None:
            state = "two_strikes" if s == 2 else ("behind" if b > s else ("ahead" if s > b else "even"))
            by_c[state].append(g)
    out["by_type"] = {t: _summ(v) for t, v in by_t.items() if len(v) >= 5}
    out["by_count"] = {c: _summ(v) for c, v in by_c.items() if len(v) >= 5}
    return out


def tempo_pool(rows_by_pitcher, min_n=10):
    """{pitcher: median tempo} for percentile context."""
    out = {}
    for name, rows in rows_by_pitcher.items():
        gaps = [g for g, _ in tempo_gaps(rows)]
        if len(gaps) >= min_n:
            out[name] = median(gaps)
    return out


FATIGUE_BUCKETS = [(1, 15), (16, 30), (31, 45), (46, 60), (61, 75), (76, 90), (91, 999)]


def fatigue_curve(rows, fb_family, grade_fn, rv_fn, rv_base=0.0, min_n=8):
    """Per 15-pitch bucket across this pitcher's outings. `rows` are his
    pitches with session_id, pitch_no, ptype, rel_speed, ivb, horz_break,
    spin_rate, extension, rel_height, rel_side, is_in_zone, is_swing,
    is_whiff, balls, strikes, pitch_call, play_result."""
    by_sess = defaultdict(list)
    for r in rows:
        if r.get("session_id") is not None:
            by_sess[r["session_id"]].append(r)
    buckets = defaultdict(list)
    outings = 0
    for rows_ in by_sess.values():
        rows_.sort(key=lambda r: (r.get("pitch_no") or 0))
        outings += 1
        for i, r in enumerate(rows_, start=1):
            for lo, hi in FATIGUE_BUCKETS:
                if lo <= i <= hi:
                    buckets[(lo, hi)].append(r)
                    break
    out = []
    for (lo, hi) in FATIGUE_BUCKETS:
        rs = buckets.get((lo, hi), [])
        if len(rs) < min_n:
            continue
        fbv = [float(r["rel_speed"]) for r in rs if r.get("rel_speed") is not None and r.get("ptype") in fb_family]
        # pitch-weighted Stuff+ from per-type centroids inside the bucket
        cents = defaultdict(lambda: defaultdict(list))
        for r in rs:
            for k, v in (("velo", r.get("rel_speed")), ("ivb", r.get("ivb")), ("hb", r.get("horz_break")),
                         ("spin", r.get("spin_rate")), ("ext", r.get("extension")),
                         ("rel_h", r.get("rel_height")), ("rel_s", r.get("rel_side"))):
                if v is not None:
                    cents[r.get("ptype")][k].append(float(v))
        types = {}
        for t, vals in cents.items():
            if not t:
                continue
            e = {"ptype": t, "n": len(vals.get("velo", []))}
            for k, arr in vals.items():
                e[k] = sum(arr) / len(arr) if arr else None
            types[t] = e
        fb = None
        for t, e in types.items():
            cand = (t == "Fastball", t in fb_family, e["n"])
            if fb is None or cand > fb[0]:
                fb = (cand, e)
        sw = sn = 0
        for t, e in types.items():
            if e["n"] >= 3:
                g = grade_fn(e, fb[1] if fb else e)
                if g is not None:
                    sw += g * e["n"]
                    sn += e["n"]
        zone = [r for r in rs if r.get("is_in_zone") is not None]
        swings = [r for r in rs if r.get("is_swing")]
        rv = rvn = 0
        for r in rs:
            v = rv_fn(r.get("balls"), r.get("strikes"), r.get("pitch_call"), r.get("play_result"))
            if v is not None:
                rv -= v
                rvn += 1
        rv += rvn * rv_base
        out.append({
            "bucket": f"{lo}-{hi}" if hi < 999 else f"{lo}+",
            "n": len(rs), "outings": len({r["session_id"] for r in rs}),
            "fb_velo": round(sum(fbv) / len(fbv), 1) if fbv else None,
            "fb_max": round(max(fbv), 1) if fbv else None,
            "stuff": round(sw / sn) if sn else None,
            "zone_pct": round(100 * sum(1 for r in zone if r["is_in_zone"]) / len(zone), 1) if zone else None,
            "whiff_pct": round(100 * sum(1 for r in swings if r.get("is_whiff")) / len(swings), 1) if len(swings) >= 5 else None,
            "rv100": round(100 * rv / rvn, 2) if rvn else None,
        })
    return {"buckets": out, "outings": outings} if out else None
