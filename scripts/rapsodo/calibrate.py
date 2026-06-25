"""Recompute the Stuff model's population anchors from all uploaded Rapsodo
pitches, writing backend/data/rapsodo_anchors.json. Run after new uploads so
Stuff's "100 = average for that pitch type" recenters to the actual NWBB
population (instead of college-provisional estimates).

We calibrate VELOCITY (mean + SD) per re-classified pitch type — velocity is
device-independent, so it's safe to pool spin- and trajectory-basis sessions.
IVB/HB means are written for reference but NOT yet used by the model (they mix
break bases; basis-aware movement calibration is future work).

Usage:
  PYTHONPATH=backend python3 scripts/rapsodo/calibrate.py
"""
import json
import os
from collections import defaultdict
from statistics import mean, pstdev

from app.models.database import get_connection

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "backend", "data", "rapsodo_anchors.json")


def main():
    by = defaultdict(lambda: {"velo": [], "ivb": [], "hb": []})
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT pitch, velo, ivb, arm_hb FROM rapsodo_pitches
               WHERE quality='ok' AND pitch IS NOT NULL AND pitch <> 'unclassified'
                 AND velo IS NOT NULL"""
        )
        for r in cur.fetchall():
            d = by[r["pitch"]]
            d["velo"].append(float(r["velo"]))
            if r["ivb"] is not None:
                d["ivb"].append(float(r["ivb"]))
            if r["arm_hb"] is not None:
                d["hb"].append(float(r["arm_hb"]))

    anchors = {}
    for pitch, d in sorted(by.items()):
        n = len(d["velo"])
        anchors[pitch] = {
            "n": n,
            "velo": round(mean(d["velo"]), 1),
            "velo_sd": round(pstdev(d["velo"]), 2) if n > 1 else None,
            "ivb": round(mean(d["ivb"]), 1) if d["ivb"] else None,
            "hb": round(mean(d["hb"]), 1) if d["hb"] else None,
        }

    with open(OUT, "w") as fh:
        json.dump(anchors, fh, indent=2, sort_keys=True)

    print(f"wrote {OUT}")
    print(f"{'pitch':<18}{'n':>5}{'velo':>7}{'sd':>6}{'ivb':>7}{'hb':>7}   (n>=12 calibrates Stuff)")
    for pitch, a in sorted(anchors.items(), key=lambda kv: -kv[1]["n"]):
        flag = " *" if a["n"] >= 12 else ""
        print(f"  {pitch:<16}{a['n']:>5}{a['velo']:>7}{str(a['velo_sd']):>6}"
              f"{str(a['ivb']):>7}{str(a['hb']):>7}{flag}")


if __name__ == "__main__":
    main()
