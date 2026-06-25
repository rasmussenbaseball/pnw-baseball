"""Re-derive every stored Rapsodo pitch from its RAW fields using the CURRENT
model (classification, VAA, lob-filter) and write the results back, so profiles
reflect model improvements WITHOUT anyone re-uploading CSVs. Coach reclassify
overrides (manual_pitch) are preserved. Also refreshes per-session QC counts.

Runs automatically (deploy hook + daily cron). Manual:
  PYTHONPATH=backend python3 scripts/rapsodo/refresh.py [--dry]
"""
import argparse

from app.models.database import get_connection
from app.stats.rapsodo_parse import derive

_RAW = ("id, session_id, player_db_id, velo, total_spin, spin_eff, spin_confidence, "
        "gyro, ivb, hb_raw, rel_angle, rel_height, sz_height, extension, manual_pitch, "
        "pitch, quality, arm_hb, vaa")


def _ne(a, b):
    if a is None and b is None:
        return False
    if a is None or b is None:
        return True
    return abs(float(a) - float(b)) > 0.05


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, handedness FROM rapsodo_players")
        players = [(r["id"], r["handedness"]) for r in cur.fetchall()]
        changed = 0
        for pid, hand in players:
            cur.execute(f"SELECT {_RAW} FROM rapsodo_pitches WHERE player_db_id=%s", (pid,))
            rows = [dict(r) for r in cur.fetchall()]
            dmap = {d["id"]: d for d in derive(rows, hand)}
            for old in rows:
                new = dmap[old["id"]]
                if (new["pitch"] != old["pitch"] or new["quality"] != old["quality"]
                        or _ne(new["arm_hb"], old["arm_hb"]) or _ne(new["vaa"], old["vaa"])):
                    changed += 1
                    if not args.dry:
                        cur.execute(
                            "UPDATE rapsodo_pitches SET pitch=%s, quality=%s, arm_hb=%s, vaa=%s WHERE id=%s",
                            (new["pitch"], new["quality"], new["arm_hb"], new["vaa"], new["id"]),
                        )
        if not args.dry:
            cur.execute("""
                UPDATE rapsodo_sessions s SET
                    qc_ok=x.ok, qc_low_confidence=x.lc, qc_partial=x.pa,
                    qc_failed=x.fa, qc_warmup=x.wu
                FROM (
                    SELECT session_id,
                        count(*) FILTER (WHERE quality='ok')             AS ok,
                        count(*) FILTER (WHERE quality='low_confidence') AS lc,
                        count(*) FILTER (WHERE quality='partial')        AS pa,
                        count(*) FILTER (WHERE quality='failed')         AS fa,
                        count(*) FILTER (WHERE quality='warmup')         AS wu
                    FROM rapsodo_pitches GROUP BY session_id
                ) x WHERE s.id = x.session_id
            """)
        print(f"{'would update' if args.dry else 'updated'} {changed} pitches across {len(players)} players")


if __name__ == "__main__":
    main()
