"""Auto pitch classification for TrackMan Suite rows.

Reuses the Rapsodo Lab's shape classifier (app/stats/rapsodo_parse.classify)
— the site-standard, cluster-relative rules that judge every pitch against
the pitcher's own fastball. Human TaggedPitchType labels are error-prone
(one mis-tagged cutter drags a whole arsenal's Stuff grade), so the suite
classifies every pitch itself and grades on that; coaches can override
individual pitches in the Pitcher Lab.

TrackMan -> classifier field bridge:
  - arm_hb: TrackMan HorzBreak is catcher-view signed; the classifier wants
    arm-side positive, so RHP keep the sign and LHP flip it (verified on the
    Hamlin corpus: RHP fastballs read +HB, LHP fastballs -HB).
  - spin_eff / gyro: Rapsodo-only measurements, passed as None — the
    classifier's rules degrade gracefully without them.
Effective type everywhere = override > classified > tagged > auto.
"""
import math
from collections import defaultdict
from itertools import combinations

from .rapsodo_parse import classify, _fastball_centroid

# classifier's lowercase labels -> the suite's normalized type names
CLASS_TO_SUITE = {
    "fastball": "Fastball",
    "sinker": "Sinker",
    "cutter": "Cutter",
    "slider": "Slider",
    "sweeper": "Sweeper",
    "curveball": "Curveball",
    "changeup": "ChangeUp",
    "splitter": "Splitter",
}
SUITE_TYPES = list(CLASS_TO_SUITE.values())


def _bridge(row):
    """tm_pitches row -> classifier pitch dict (arm-side HB)."""
    hb = row.get("horz_break")
    throws = row.get("pitcher_throws")
    arm_hb = None
    if hb is not None:
        arm_hb = float(hb) if throws != "Left" else -float(hb)
    return {
        "velo": float(row["rel_speed"]) if row.get("rel_speed") is not None else None,
        "ivb": float(row["ivb"]) if row.get("ivb") is not None else None,
        "arm_hb": arm_hb,
        "total_spin": float(row["spin_rate"]) if row.get("spin_rate") is not None else None,
        "spin_eff": None,
        "gyro": None,
    }


def reclassify_owner(cur, owner, pitchers=None):
    """(Re)compute class_pitch_type for an owner's pitches, per pitcher.
    Only writes rows whose classification changed. Returns (classified, updated)."""
    extra = " AND pitcher = ANY(%s)" if pitchers else ""
    params = [owner] + ([list(pitchers)] if pitchers else [])
    cur.execute(
        f"""SELECT id, pitcher, pitcher_team, pitcher_throws,
                   rel_speed, ivb, horz_break, spin_rate, class_pitch_type
            FROM tm_pitches
            WHERE owner_user_id = %s AND pitcher IS NOT NULL{extra}""",
        params,
    )
    rows = cur.fetchall()
    by_arm = defaultdict(list)
    for r in rows:
        by_arm[(r["pitcher"], r["pitcher_team"])].append(r)

    classified = updated = 0
    for (name, team), rs in by_arm.items():
        hand = "L" if rs[0]["pitcher_throws"] == "Left" else "R"
        bridged = [(r, _bridge(r)) for r in rs]
        fb = _fastball_centroid([b for _, b in bridged])
        changes = []
        for r, b in bridged:
            label = classify(b, fb, hand) if b["velo"] is not None else "unclassified"
            new = CLASS_TO_SUITE.get(label)  # unclassified -> None (falls back to tags)
            classified += 1 if new else 0
            if new != r["class_pitch_type"]:
                changes.append((new, r["id"]))
        if changes:
            # Batched: the per-row UPDATE loop was a round-trip per changed
            # pitch and dominated large uploads.
            from psycopg2.extras import execute_values
            execute_values(cur, """
                UPDATE tm_pitches AS t SET class_pitch_type = v.new
                FROM (VALUES %s) AS v(new, id)
                WHERE t.id = v.id
            """, changes, page_size=500)
            updated += 1
    consolidate_owner(cur, owner, pitchers)
    return classified, updated


# ── Arsenal consolidation ─────────────────────────────────────────
# Per-pitch classification over-splits real arsenals: borderline pitches
# land across template boundaries and a 4-pitch guy shows 7 "types" (Keamo
# showed splitter/sinker/cutter he doesn't throw — Nate, 2026-08-19). This
# post-pass looks at the pitcher's OWN movement profile: type clusters that
# are movement/velo twins, or trace-usage satellites of a bigger cluster,
# are the same offering and get merged into it. Distances are in rough
# "just noticeable difference" units so the threshold reads as "a hitter
# couldn't tell these apart".
MERGE_VELO_JND = 2.5    # mph per distance unit
MERGE_BREAK_JND = 3.5   # inches of IVB/HB per distance unit
MERGE_CLOSE_D = 1.5     # twins: centroids this close always merge
MERGE_FORCE_D = 3.0     # trace clusters absorb into anything this close
MERGE_TRACE_N = 10      # fewer pitches than this = trace usage


def _cdist(a, b):
    return math.sqrt(((a["velo"] - b["velo"]) / MERGE_VELO_JND) ** 2
                     + ((a["ivb"] - b["ivb"]) / MERGE_BREAK_JND) ** 2
                     + ((a["hb"] - b["hb"]) / MERGE_BREAK_JND) ** 2)


def consolidate_owner(cur, owner, pitchers=None, dry_run=False):
    """Merge over-split pitch-type clusters, per pitcher. Writes the
    absorbing type into class_pitch_type (overridden pitches untouched).
    Returns a report list; pass dry_run=True to only report."""
    eff = "COALESCE(override_pitch_type, class_pitch_type, tagged_pitch_type, auto_pitch_type)"
    extra = " AND pitcher = ANY(%s)" if pitchers else ""
    params = [owner] + ([list(pitchers)] if pitchers else [])
    cur.execute(
        f"""SELECT pitcher, pitcher_team, {eff} AS t, COUNT(*) AS n,
                   AVG(rel_speed) AS velo, AVG(ivb) AS ivb, AVG(horz_break) AS hb
            FROM tm_pitches
            WHERE owner_user_id = %s AND pitcher IS NOT NULL
              AND {eff} IS NOT NULL AND rel_speed IS NOT NULL{extra}
            GROUP BY pitcher, pitcher_team, {eff}""",
        params,
    )
    groups = defaultdict(dict)
    for r in cur.fetchall():
        if r["velo"] is None or r["ivb"] is None or r["hb"] is None:
            continue
        groups[(r["pitcher"], r["pitcher_team"])][r["t"]] = {
            "n": r["n"], "velo": float(r["velo"]), "ivb": float(r["ivb"]), "hb": float(r["hb"]),
        }

    report = []
    for (name, team), cl in groups.items():
        mapping = {}
        frozen = set()   # pairs ruled out (velo-family guard)
        while len(cl) > 1:
            # best QUALIFYING pair each round (don't stop at the closest
            # pair overall — a farther pair may still qualify on trace usage)
            def _qualifies(a, b):
                if (a, b) in frozen or (b, a) in frozen:
                    return False
                d = _cdist(cl[a], cl[b])
                small_n = min(cl[a]["n"], cl[b]["n"])
                return d < MERGE_CLOSE_D or (small_n < MERGE_TRACE_N and d < MERGE_FORCE_D)
            cands = [(a, b) for a, b in combinations(cl, 2) if _qualifies(a, b)]
            if not cands:
                break
            a, b = min(cands, key=lambda p: _cdist(cl[p[0]], cl[p[1]]))
            small, big = (a, b) if cl[a]["n"] <= cl[b]["n"] else (b, a)
            # velo-family stickiness: a cluster thrown at fastball speed is
            # the fastball (or its variant), never an offspeed — Wolfe's
            # five 86-mph "sinkers" belong to his 87-mph heater, not his
            # 83-mph changeup, even when the shape is closer.
            top_velo = max(c["velo"] for c in cl.values())
            if cl[small]["velo"] >= top_velo - 2.0 and cl[big]["velo"] < top_velo - 2.0:
                fam = [t for t in cl if t != small and cl[t]["velo"] >= top_velo - 2.0
                       and _cdist(cl[small], cl[t]) < MERGE_FORCE_D]
                if fam:
                    big = max(fam, key=lambda t: cl[t]["n"])
                    if cl[big]["n"] < cl[small]["n"]:
                        small, big = big, small
                else:
                    frozen.add((small, big))   # keep it as its own pitch
                    continue
            s, g = cl.pop(small), cl[big]
            tot = s["n"] + g["n"]
            for k in ("velo", "ivb", "hb"):
                g[k] = (s[k] * s["n"] + g[k] * g["n"]) / tot
            g["n"] = tot
            frozen = {(x, y) for (x, y) in frozen if small not in (x, y)}
            # anything already mapped to the absorbed type follows it
            mapping[small] = big
            for src, dst in mapping.items():
                if dst == small:
                    mapping[src] = big
        for src, dst in mapping.items():
            n = 0
            if not dry_run:
                cur.execute(
                    f"""UPDATE tm_pitches SET class_pitch_type = %s
                        WHERE owner_user_id = %s AND pitcher = %s
                          AND pitcher_team IS NOT DISTINCT FROM %s
                          AND override_pitch_type IS NULL
                          AND COALESCE(class_pitch_type, tagged_pitch_type, auto_pitch_type) = %s""",
                    (dst, owner, name, team, src),
                )
                n = cur.rowcount
            report.append({"pitcher": name, "team": team, "from": src, "to": dst, "updated": n})
    report += repartition_breakers(cur, owner, pitchers, dry_run=dry_run)
    return report


# ── Breaker repartition ───────────────────────────────────────────
# The template classifier names each breaking ball in isolation, so a big
# sweepy breaker with depth reads "curveball" while its tight siblings read
# "slider" — one real pitch splits, two real pitches blur. Nate's rule
# (2026-08-19): within a pitcher's breakers, a clear horizontal-break gap
# means TWO different pitches, and 13"+ of sweep IS a sweeper no matter the
# depth. So per post-consolidation cluster: split on HB when it's clearly
# bimodal, then (re)name every breaker cluster from its own centroid.
BREAKER_FAMILY = ("Slider", "Sweeper", "Curveball")
SPLIT_GAP_IN = 8.0    # HB centroid gap that means two pitches
SPLIT_MIN_N = 8       # both halves need this many pitches


def _breaker_name(ivb, hb, velo=None, fb_velo=None):
    sweep = abs(hb)
    # sweepers live in the slider velo band; a breaker 13+ mph below the
    # fastball is a curveball no matter how much it sweeps (Sanchez's
    # 69.7-mph, 18-inch bender stays a curve; Keamo's 76-mph one doesn't)
    slow = (velo is not None and fb_velo is not None and velo <= fb_velo - 13.0)
    if sweep >= 13.0:
        return "Curveball" if (slow or ivb <= -15.0) else "Sweeper"
    return "Curveball" if ivb <= -10.0 else "Slider"


def _two_means_1d(vals):
    c1, c2 = min(vals), max(vals)
    for _ in range(25):
        g1 = [v for v in vals if abs(v - c1) <= abs(v - c2)]
        g2 = [v for v in vals if abs(v - c1) > abs(v - c2)]
        if not g1 or not g2:
            return None
        n1, n2 = sum(g1) / len(g1), sum(g2) / len(g2)
        if n1 == c1 and n2 == c2:
            break
        c1, c2 = n1, n2
    return c1, c2


def repartition_breakers(cur, owner, pitchers=None, dry_run=False):
    """Split HB-bimodal breaker clusters and rename every breaker cluster
    from its centroid shape. Returns a report like consolidate_owner's."""
    eff = "COALESCE(override_pitch_type, class_pitch_type, tagged_pitch_type, auto_pitch_type)"
    extra = " AND pitcher = ANY(%s)" if pitchers else ""
    params = [owner] + ([list(pitchers)] if pitchers else [])
    cur.execute(
        f"""SELECT id, pitcher, pitcher_team, {eff} AS t, ivb, horz_break AS hb, rel_speed
            FROM tm_pitches
            WHERE owner_user_id = %s AND pitcher IS NOT NULL
              AND override_pitch_type IS NULL
              AND {eff} IN ('Slider', 'Sweeper', 'Curveball')
              AND ivb IS NOT NULL AND horz_break IS NOT NULL{extra}""",
        params,
    )
    clusters = defaultdict(list)
    for r in cur.fetchall():
        clusters[(r["pitcher"], r["pitcher_team"], r["t"])].append(
            (r["id"], float(r["ivb"]), float(r["hb"]),
             float(r["rel_speed"]) if r["rel_speed"] is not None else None))

    # each pitcher's fastball velo = his top type-average velo
    cur.execute(
        f"""SELECT pitcher, pitcher_team, MAX(v) AS fb_velo FROM (
                SELECT pitcher, pitcher_team, {eff} AS t, AVG(rel_speed) AS v
                FROM tm_pitches
                WHERE owner_user_id = %s AND pitcher IS NOT NULL
                  AND rel_speed IS NOT NULL{extra}
                GROUP BY pitcher, pitcher_team, {eff}
                HAVING COUNT(*) >= 3
            ) sub GROUP BY pitcher, pitcher_team""",
        params,
    )
    fb_velos = {(r["pitcher"], r["pitcher_team"]): float(r["fb_velo"]) for r in cur.fetchall()}

    def _grp_name(grp, fb):
        ivb = sum(r[1] for r in grp) / len(grp)
        hb = sum(r[2] for r in grp) / len(grp)
        velos = [r[3] for r in grp if r[3] is not None]
        velo = sum(velos) / len(velos) if velos else None
        return _breaker_name(ivb, hb, velo, fb)

    report, changes = [], []
    for (name, team, label), rows in clusters.items():
        fb = fb_velos.get((name, team))
        parts = None
        if len(rows) >= 2 * SPLIT_MIN_N:
            hbs = [r[2] for r in rows]
            cs = _two_means_1d(hbs)
            if cs and abs(cs[0] - cs[1]) >= SPLIT_GAP_IN:
                g1 = [r for r in rows if abs(r[2] - cs[0]) <= abs(r[2] - cs[1])]
                g2 = [r for r in rows if abs(r[2] - cs[0]) > abs(r[2] - cs[1])]
                if len(g1) >= SPLIT_MIN_N and len(g2) >= SPLIT_MIN_N:
                    n1, n2 = _grp_name(g1, fb), _grp_name(g2, fb)
                    if n1 != n2:
                        parts = [(g1, n1), (g2, n2)]
        if parts is None:
            parts = [(rows, _grp_name(rows, fb))]
        for grp, new in parts:
            moved = [(new, r[0]) for r in grp]
            if new != label:
                changes += moved
                report.append({"pitcher": name, "team": team, "from": label, "to": new,
                               "updated": len(moved)})

    if changes and not dry_run:
        from psycopg2.extras import execute_values
        execute_values(cur, """
            UPDATE tm_pitches AS t SET class_pitch_type = v.new
            FROM (VALUES %s) AS v(new, id)
            WHERE t.id = v.id
        """, changes, page_size=500)
    return report
