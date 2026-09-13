"""Re-grade the WCL summer TrackMan centroids (trackman_pitches.pitch_grade)
with the site-wide Stuff+ model, so the summer player cards, the WCL portal
ARS column and the TrackMan Suite all read the same scale.

    PYTHONPATH=backend python3 scripts/stuff/regrade_wcl.py            # report
    PYTHONPATH=backend python3 scripts/stuff/regrade_wcl.py --commit   # write pitch_grade + est_vaa

Rows are per player / season / pitch type centroids transcribed from
session PDFs. HB is signed like TrackMan (+ = pitcher's right), so arm-side
sign comes from summer_players.throws, else the release side. Types the
model does not cover ("Undefined") keep a NULL grade.
"""
import sys
from collections import defaultdict

import numpy as np

from app.models.database import get_connection
from app.stats import stuff_core as core

COMMIT = "--commit" in sys.argv


def _sign(throws, rel_s):
    t = (throws or "").strip().upper()[:1]
    if t == "R":
        return 1.0
    if t == "L":
        return -1.0
    return -1.0 if (rel_s is not None and rel_s < 0) else 1.0


def _entry(r, sign):
    return {"ptype": r["ptype"], "n": r["pitch_count"] or 0, "velo": r["velo"], "ivb": r["ivb"],
            "hb_arm": (r["hb"] * sign) if r["hb"] is not None else None, "spin": r["spin"],
            "ext": r["extension"], "rel_h": r["rel_height"], "rel_s": r["rel_side"]}


def main():
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""SELECT tp.id, tp.summer_player_id, tp.season, tp.pitch_type, tp.pitch_count,
                              tp.velo, tp.spin, tp.ivb, tp.hb, tp.extension, tp.rel_height, tp.rel_side,
                              tp.pitch_grade, tp.whiff_pct, sp.throws
                       FROM trackman_pitches tp LEFT JOIN summer_players sp ON sp.id = tp.summer_player_id""")
        rows = [dict(r) for r in cur.fetchall()]
        for r in rows:
            for k in ("velo", "spin", "ivb", "hb", "extension", "rel_height", "rel_side", "whiff_pct"):
                r[k] = float(r[k]) if r[k] is not None else None
            r["ptype"] = core.canon_type(r["pitch_type"])
        by_key = defaultdict(list)
        for r in rows:
            by_key[(r["summer_player_id"], r["season"])].append(r)
        updates, grades = [], defaultdict(list)
        for key, rs in by_key.items():
            sign = _sign(rs[0]["throws"], next((r["rel_side"] for r in rs if r["rel_side"] is not None), None))
            fb = core.pick_fastball([r for r in rs if r["ptype"] and r["velo"] is not None] and
                                    [_entry(r, sign) for r in rs if r["ptype"] and r["velo"] is not None])
            for r in rs:
                g = None
                if r["ptype"]:
                    g, _, _ = core.score(_entry(r, sign), fb)
                vaa = core.estimate_vaa(r["velo"], r["extension"], r["rel_height"], r["ivb"])
                updates.append((g, vaa, r["id"]))
                if g is not None:
                    grades[r["ptype"]].append(g)
        print(f"{len(rows)} centroids, {sum(1 for u in updates if u[0] is not None)} graded")
        for pt, gs in sorted(grades.items(), key=lambda kv: -len(kv[1])):
            q = np.percentile(gs, [5, 50, 95])
            print(f"  {pt:10s} n={len(gs):4d}  p5 {q[0]:.0f}  med {q[1]:.0f}  p95 {q[2]:.0f}")
        if COMMIT:
            cur.executemany("UPDATE trackman_pitches SET pitch_grade = %s, est_vaa = %s WHERE id = %s", updates)
            conn.commit()
            print("committed")
        else:
            print("dry run (pass --commit to write)")


if __name__ == "__main__":
    main()
