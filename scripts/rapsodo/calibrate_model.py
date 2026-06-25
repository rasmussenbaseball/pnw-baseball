"""Recalibrate the WCL TrackMan Stuff model to the Rapsodo POPULATION.

The model's learned weights (what makes a pitch miss bats) transfer fine, but its
feature MEANS/STDS are TrackMan's — and Rapsodo measures break/extension/VAA
differently, so standardizing Rapsodo inputs on TrackMan stats biases every grade.
This computes per-pitch-type feature means/stds + predictor mean/std from our own
Rapsodo data and writes them into the model artifact under each type's "rapsodo"
key. grade_pitch() then z-scores Rapsodo inputs against Rapsodo (keeping the
TrackMan coefficients + shrink), so 100 = average Rapsodo pitch of that type.

Run after refresh/upload (deploy hook + cron):
  PYTHONPATH=backend python3 scripts/rapsodo/calibrate_model.py
"""
import json
import math
import os
from collections import defaultdict

import numpy as np

from app.models.database import get_connection
from app.stats.rapsodo_parse import _fastball_centroid, derive
from app.stats.stuff_model import RAPSODO_TO_MODEL, estimate_vaa

MODEL_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "backend", "data", "rapsodo_stuff_model.json")
_FB = {"4-seam (ride)", "fastball (mixed)", "sinker / 2-seam"}
_RAW = ("id, session_id, player_db_id, velo, total_spin, spin_eff, spin_confidence, gyro, "
        "ivb, hb_raw, rel_angle, rel_height, sz_height, extension, manual_pitch, pitch, quality, arm_hb, vaa")
_MIN_N = 20


def _num(v):
    return float(v) if v is not None else None


def main():
    model = json.load(open(MODEL_PATH))
    F = model["features"]
    ext_idx = F.index("extension")

    # gather features per model-type, pooled across all players/owners
    by_type = defaultdict(list)
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, handedness FROM rapsodo_players")
        players = [(r["id"], r["handedness"]) for r in cur.fetchall()]
        for pid, hand in players:
            cur.execute(f"SELECT {_RAW} FROM rapsodo_pitches WHERE player_db_id=%s", (pid,))
            rows = derive([dict(r) for r in cur.fetchall()], hand)
            ok = [r for r in rows if r["quality"] == "ok" and r["pitch"]]
            fb = _fastball_centroid([r for r in ok if r["pitch"] in _FB] or ok)
            for r in ok:
                mt = RAPSODO_TO_MODEL.get(r["pitch"])
                velo, ivb, hb = _num(r["velo"]), _num(r["ivb"]), _num(r["arm_hb"])
                spin, rel_h, rel_s = _num(r["total_spin"]), _num(r["rel_height"]), _num(r["rel_side"] if "rel_side" in r else None)
                if mt is None or None in (velo, ivb, hb, spin, rel_h) or mt not in model["types"]:
                    continue
                ext = _num(r["extension"]) or model["types"][mt]["means"][ext_idx]
                est = estimate_vaa(velo, ext, rel_h, ivb)
                if est is None:
                    continue
                fbv = fb["velo"] if fb else velo
                fbivb = fb["ivb"] if fb else ivb
                fbhb = fb["arm_hb"] if fb else hb
                by_type[mt].append({
                    "velo": velo, "spin": spin, "extension": ext, "hb_abs": abs(hb),
                    "rel_side_abs": abs(rel_s or 0.0), "rel_h": rel_h, "rel_s": abs(rel_s or 0.0),
                    "est_vaa": est, "velo_sep": fbv - velo, "ivb_sep": fbivb - ivb,
                    "mov_sep": math.hypot(ivb - fbivb, hb - fbhb),
                })

    # DIAGNOSTIC: compare each feature's Rapsodo distribution to the WCL/TrackMan
    # training distribution. A big |offset| (Rapsodo mean vs TrackMan mean, in
    # TrackMan-std units) is a measurement mismatch that biases every grade for
    # that type — that's the hangup to fix (not recalibrate to 7 pitchers).
    alpha = model.get("slot_alpha", 0.6)
    for mt, pitches in sorted(by_type.items()):
        if len(pitches) < _MIN_N:
            print(f"\n{mt}: n={len(pitches)} (too few to assess)")
            continue
        m = model["types"][mt]
        y = np.array([p["est_vaa"] for p in pitches])
        X = np.array([[1.0, p["rel_h"], p["rel_s"]] for p in pitches])
        ybar = float(y.mean())
        try:
            sc = np.linalg.solve(X.T @ X + 1e-6 * np.eye(3), X.T @ y)
        except np.linalg.LinAlgError:
            sc = np.array([ybar, 0.0, 0.0])
        for i, p in enumerate(pitches):
            p["vaa_adj"] = p["est_vaa"] - alpha * (float(X[i] @ sc) - ybar)
        M = np.array([[p[f] for f in F] for p in pitches])
        rmean, rstd = M.mean(axis=0), M.std(axis=0)
        print(f"\n{mt}  (Rapsodo n={len(pitches)})   feature: TM_mean -> Rap_mean  [offset in TM std]")
        for i, f in enumerate(F):
            off = (rmean[i] - m["means"][i]) / (m["stds"][i] or 1)
            flag = "  <-- MISMATCH" if abs(off) >= 0.75 else ""
            print(f"    {f:<13} {m['means'][i]:>8.2f} -> {rmean[i]:>7.2f}   [{off:+.2f}]{flag}")


if __name__ == "__main__":
    main()
