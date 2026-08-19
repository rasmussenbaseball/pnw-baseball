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
    flag_mistags(cur, owner, pitchers)
    consolidate_owner(cur, owner, pitchers)
    return classified, updated


# ── Mistag detection ──────────────────────────────────────────────
# The TrackMan operator sometimes leaves the wrong pitcher name on a pitch
# (mid-inning change). Release point is the fingerprint: a pitch released
# a foot or more from the pitcher's own release cluster belongs to someone
# else (Mallari's phantom "sweeper" released 3 ft away — Nate, 2026-08-19).
# Flagged pitches get class_pitch_type='Mistag' and every pitcher-facing
# view excludes them; a coach override still wins and rescues the pitch.
MISTAG_DIST_FT = 1.0
MISTAG_HEIGHT_FT = 0.5    # a different HUMAN releases at a different height;
                          # side-only shifts are the same guy moving on the
                          # rubber (Wolfe slid a foot over mid-outing — legit)
MISTAG_MAX_SHARE = 0.10   # if more than this is "outlying", it's a real
                          # second slot (drop-down guy) — flag nothing
MISTAG_MIN_PITCHES = 20


def _median(vals):
    s = sorted(vals)
    return s[len(s) // 2]


def flag_mistags(cur, owner, pitchers=None, dry_run=False):
    """Flag release-point outliers as Mistag. A per-SESSION calibration
    offset is removed first: a shifted TrackMan setup moves EVERY pitcher's
    release that day (Wolfe's 2026-01-30 session sat a foot off), while a
    mistag moves only the mislabeled pitch. Returns report rows."""
    extra = " AND pitcher = ANY(%s)" if pitchers else ""
    params = [owner] + ([list(pitchers)] if pitchers else [])
    cur.execute(
        f"""SELECT id, pitcher, pitcher_team, session_id, rel_height, rel_side, class_pitch_type
            FROM tm_pitches
            WHERE owner_user_id = %s AND pitcher IS NOT NULL
              AND override_pitch_type IS NULL
              AND rel_height IS NOT NULL AND rel_side IS NOT NULL{extra}""",
        params,
    )
    by_arm = defaultdict(list)
    for r in cur.fetchall():
        by_arm[(r["pitcher"], r["pitcher_team"])].append(
            (r["id"], float(r["rel_height"]), float(r["rel_side"]),
             r["class_pitch_type"], r["session_id"]))

    # global release median per pitcher
    meds = {arm: (_median([r[1] for r in rows]), _median([r[2] for r in rows]))
            for arm, rows in by_arm.items() if len(rows) >= MISTAG_MIN_PITCHES}

    # per-session calibration offset = median (over pitchers with 5+ pitches
    # in the session) of how far the session's release sits from each
    # pitcher's own global median
    sess_deltas = defaultdict(list)
    for arm, rows in by_arm.items():
        if arm not in meds:
            continue
        med_h, med_s = meds[arm]
        by_sess = defaultdict(list)
        for r in rows:
            by_sess[r[4]].append(r)
        for sid, rs in by_sess.items():
            if len(rs) >= 5:
                sess_deltas[sid].append((_median([r[1] for r in rs]) - med_h,
                                         _median([r[2] for r in rs]) - med_s))
    sess_off = {sid: (_median([d[0] for d in ds]), _median([d[1] for d in ds]))
                for sid, ds in sess_deltas.items() if ds}

    report, flag_ids, unflag_ids = [], [], []
    for (name, team), rows in by_arm.items():
        if (name, team) not in meds:
            continue
        med_h, med_s = meds[(name, team)]
        out = []
        for r in rows:
            oh, os = sess_off.get(r[4], (0.0, 0.0))
            dh = r[1] - oh - med_h
            if (math.hypot(dh, r[2] - os - med_s) > MISTAG_DIST_FT
                    and abs(dh) > MISTAG_HEIGHT_FT):
                out.append(r)
        if len(out) > max(1, int(MISTAG_MAX_SHARE * len(rows))):
            out = []   # a real second slot, not mistags
        out_ids = {r[0] for r in out}
        flag_ids += [r[0] for r in out if r[3] != "Mistag"]
        unflag_ids += [r[0] for r in rows if r[3] == "Mistag" and r[0] not in out_ids]
        if out:
            report.append({"pitcher": name, "team": team, "from": "*",
                           "to": "Mistag", "updated": len(out)})

    if not dry_run:
        if flag_ids:
            cur.execute("UPDATE tm_pitches SET class_pitch_type = 'Mistag' WHERE id = ANY(%s)",
                        (flag_ids,))
        if unflag_ids:   # threshold moved; hand back to the classifier
            cur.execute("UPDATE tm_pitches SET class_pitch_type = NULL WHERE id = ANY(%s)",
                        (unflag_ids,))
    return report


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
              AND {eff} IS NOT NULL AND {eff} <> 'Mistag'
              AND rel_speed IS NOT NULL{extra}
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
        # 1-2 pitch strays can't be a real pitch: absorb into the nearest
        # cluster, no distance limit (Mallari's lone fastball-shaped
        # "changeup" survived every threshold)
        for t in [t for t, c in cl.items() if c["n"] < 3]:
            if len(cl) < 2:
                break
            near = min((o for o in cl if o != t), key=lambda o: _cdist(cl[t], cl[o]))
            s, g = cl.pop(t), cl[near]
            tot = s["n"] + g["n"]
            for k in ("velo", "ivb", "hb"):
                g[k] = (s[k] * s["n"] + g[k] * g["n"]) / tot
            g["n"] = tot
            mapping[t] = near
            for src, dst in mapping.items():
                if dst == t:
                    mapping[src] = near
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
SPLIT_JND = 2.2       # centroid separation (JND units) that means two pitches
SPLIT_MIN_N = 8       # both halves need this many pitches
CUTTER_FB_GAP = 4.5   # a "cutter" more than this below the fastball is a breaker


def _breaker_name(ivb, hb, velo=None, fb_velo=None):
    sweep = abs(hb)
    # cutter: near-fastball velo, real ride, no sweep (Schwenk's 80.9 off
    # an 85.2 heater with 11" of ride is a cutter, not a slider). Marshall's
    # 83.5 off 88.7 with 7" of ride stays a slider — fails both gates.
    if (velo is not None and fb_velo is not None
            and velo >= fb_velo - 5.0 and ivb >= 9.0 and sweep <= 6.0):
        return "Cutter"
    # sweepers live in the slider velo band; a breaker 13+ mph below the
    # fastball is a curveball no matter how much it sweeps (Sanchez's
    # 69.7-mph, 18-inch bender stays a curve; Keamo's 76-mph one doesn't)
    slow = (velo is not None and fb_velo is not None and velo <= fb_velo - 13.0)
    if sweep >= 13.0:
        return "Curveball" if (slow or ivb <= -15.0) else "Sweeper"
    return "Curveball" if ivb <= -10.0 else "Slider"


# pitch tuples through this section: (id, ivb, hb, velo, current_label)
def _row_jnd(a, b):
    return math.sqrt(((a[3] - b[3]) / MERGE_VELO_JND) ** 2
                     + ((a[1] - b[1]) / MERGE_BREAK_JND) ** 2
                     + ((a[2] - b[2]) / MERGE_BREAK_JND) ** 2)


def _leaf_mean(rows):
    n = len(rows)
    return (sum(r[1] for r in rows) / n, sum(r[2] for r in rows) / n,
            sum(r[3] for r in rows) / n)


def _two_means(rows):
    """2-means in JND (velo, ivb, hb) space, seeded by the farthest pair.
    Returns (g1, g2, centroid_jnd) or None."""
    if len(rows) < 4:
        return None
    seed = max(combinations(rows, 2), key=lambda p: _row_jnd(p[0], p[1]))
    c1 = (0, seed[0][1], seed[0][2], seed[0][3])
    c2 = (0, seed[1][1], seed[1][2], seed[1][3])
    g1 = g2 = None
    for _ in range(25):
        g1 = [r for r in rows if _row_jnd(r, c1) <= _row_jnd(r, c2)]
        g2 = [r for r in rows if _row_jnd(r, c1) > _row_jnd(r, c2)]
        if not g1 or not g2:
            return None
        n1, n2 = (0, *_leaf_mean(g1)), (0, *_leaf_mean(g2))
        if n1[1:] == c1[1:] and n2[1:] == c2[1:]:
            break
        c1, c2 = n1, n2
    return g1, g2, _row_jnd(c1, c2)


def _split_rec(rows, depth=0):
    """Recursive 2-means: keep splitting while the halves clearly separate."""
    if depth >= 2 or len(rows) < 2 * SPLIT_MIN_N:
        return [rows]
    res = _two_means(rows)
    if not res:
        return [rows]
    g1, g2, d = res
    if d < SPLIT_JND or len(g1) < SPLIT_MIN_N or len(g2) < SPLIT_MIN_N:
        return [rows]
    return _split_rec(g1, depth + 1) + _split_rec(g2, depth + 1)


def repartition_breakers(cur, owner, pitchers=None, dry_run=False):
    """Pool each pitcher's breaking balls (sliders/sweepers/curveballs, plus
    'cutters' thrown at breaker speed), find the real cluster structure with
    recursive 2-means in velo+movement space, and name each cluster from its
    own shape. Comparative rule (Nate, 2026-08-19): when two clusters would
    both read 'slider', the one 3+ mph slower with 5+ inches more depth is
    the curveball."""
    eff = "COALESCE(override_pitch_type, class_pitch_type, tagged_pitch_type, auto_pitch_type)"
    extra = " AND pitcher = ANY(%s)" if pitchers else ""
    params = [owner] + ([list(pitchers)] if pitchers else [])
    cur.execute(
        f"""SELECT id, pitcher, pitcher_team, {eff} AS t, ivb, horz_break AS hb, rel_speed
            FROM tm_pitches
            WHERE owner_user_id = %s AND pitcher IS NOT NULL
              AND override_pitch_type IS NULL
              AND {eff} IN ('Slider', 'Sweeper', 'Curveball', 'Cutter')
              AND ivb IS NOT NULL AND horz_break IS NOT NULL
              AND rel_speed IS NOT NULL{extra}""",
        params,
    )
    arms = defaultdict(lambda: defaultdict(list))
    for r in cur.fetchall():
        arms[(r["pitcher"], r["pitcher_team"])][r["t"]].append(
            (r["id"], float(r["ivb"]), float(r["hb"]), float(r["rel_speed"]), r["t"]))

    # each pitcher's fastball velo = his top type-average velo
    cur.execute(
        f"""SELECT pitcher, pitcher_team, MAX(v) AS fb_velo FROM (
                SELECT pitcher, pitcher_team, {eff} AS t, AVG(rel_speed) AS v
                FROM tm_pitches
                WHERE owner_user_id = %s AND pitcher IS NOT NULL
                  AND {eff} IS DISTINCT FROM 'Mistag'
                  AND rel_speed IS NOT NULL{extra}
                GROUP BY pitcher, pitcher_team, {eff}
                HAVING COUNT(*) >= 3
            ) sub GROUP BY pitcher, pitcher_team""",
        params,
    )
    fb_velos = {(r["pitcher"], r["pitcher_team"]): float(r["fb_velo"]) for r in cur.fetchall()}

    report, changes = [], []
    for (name, team), by_label in arms.items():
        fb = fb_velos.get((name, team))
        # pool the true breakers; a "cutter" joins only when it's thrown at
        # breaker speed (a real cutter rides within ~4.5 mph of the heater)
        pool = []
        for label, rows in by_label.items():
            if label == "Cutter":
                cv = sum(r[3] for r in rows) / len(rows)
                if fb is not None and cv > fb - CUTTER_FB_GAP:
                    continue   # real cutter: protected
            pool += rows
        if len(pool) < SPLIT_MIN_N:
            continue

        leaves = _split_rec(pool)
        src_labels = {r[4] for r in pool}
        if len(leaves) == 1 and len(src_labels) > 1:
            # k-means found no clean break but the classifier had kept these
            # apart through consolidation — trust that partition, just rename
            leaves = [rows for label, rows in by_label.items()
                      if label in src_labels and rows and rows[0] in pool]
            leaves = [lf for lf in leaves if lf]

        named = []
        for lf in leaves:
            ivb, hb, velo = _leaf_mean(lf)
            named.append([lf, _breaker_name(ivb, hb, velo, fb), ivb, velo, hb])
        # a Cutter is only a Cutter when it's clearly its own pitch: within
        # 3 JND of another breaker leaf it's the hard end of the slider's
        # spray (Marshall's 84-mph firm leaf sits 2.5 from his slider —
        # one pitch; Schwenk's true cutter sits 4.0 away)
        for e in named:
            if e[1] != "Cutter" or len(named) < 2:
                continue
            me = (0, e[2], e[4], e[3])
            near = min(_row_jnd(me, (0, o[2], o[4], o[3])) for o in named if o is not e)
            if near < 3.0:
                e[1] = "Slider"
        # comparative disambiguation among same-named 'Slider' leaves
        sliders = [e for e in named if e[1] == "Slider"]
        if len(sliders) > 1:
            ref = max(sliders, key=lambda e: e[3])
            for e in sliders:
                if e is not ref and e[3] <= ref[3] - 3.0 and e[2] <= ref[2] - 5.0:
                    e[1] = "Curveball"

        moved = defaultdict(int)
        for lf, new, *_ in named:
            for r in lf:
                if r[4] != new:
                    changes.append((new, r[0]))
                    moved[(r[4], new)] += 1
        for (src, dst), n in moved.items():
            report.append({"pitcher": name, "team": team, "from": src, "to": dst, "updated": n})

    if changes and not dry_run:
        from psycopg2.extras import execute_values
        execute_values(cur, """
            UPDATE tm_pitches AS t SET class_pitch_type = v.new
            FROM (VALUES %s) AS v(new, id)
            WHERE t.id = v.id
        """, changes, page_size=500)
    return report
