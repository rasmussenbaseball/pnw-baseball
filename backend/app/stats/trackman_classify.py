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
from collections import defaultdict

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
        for new, pid in changes:
            cur.execute("UPDATE tm_pitches SET class_pitch_type = %s WHERE id = %s", (new, pid))
            updated += 1
    return classified, updated
