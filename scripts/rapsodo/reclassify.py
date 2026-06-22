"""Recompute the stored `pitch` label for every rapsodo_pitches row using the
CURRENT classifier (app.stats.rapsodo_parse). Run this after improving the
classifier so the fix applies to already-uploaded sessions — no re-upload needed.

Usage:
  PYTHONPATH=backend python3 scripts/rapsodo/reclassify.py            # dry run
  PYTHONPATH=backend python3 scripts/rapsodo/reclassify.py --commit   # write
"""
import argparse

from app.models.database import get_connection
from app.stats.rapsodo_parse import reclassify


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true")
    a = ap.parse_args()
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT DISTINCT session_id FROM rapsodo_pitches ORDER BY session_id")
        sids = [r["session_id"] for r in cur.fetchall()]
        changed = 0
        for sid in sids:
            cur.execute(
                """SELECT id, velo, ivb, arm_hb, spin_eff, gyro, quality, pitch
                   FROM rapsodo_pitches WHERE session_id=%s ORDER BY pitch_no""",
                (sid,),
            )
            rows = [dict(r) for r in cur.fetchall()]
            for r, label in zip(rows, reclassify(rows)):
                if label != r["pitch"]:
                    changed += 1
                    print(f"  session {sid} pitch {r['id']}: {r['pitch']} -> {label}")
                    if a.commit:
                        cur.execute("UPDATE rapsodo_pitches SET pitch=%s WHERE id=%s", (label, r["id"]))
        verb = "UPDATED" if a.commit else "WOULD UPDATE"
        print(f"\n{verb} {changed} pitches across {len(sids)} sessions")
        if not a.commit and changed:
            print("dry run — re-run with --commit to write")


if __name__ == "__main__":
    main()
