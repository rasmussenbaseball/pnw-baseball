"""Backfill tm_pitches.base_pos_x/y/z (where a catcher's throw arrived) from
TrackMan game CSVs already uploaded. Matches on PitchUID; only touches rows
whose base_pos_x is still NULL and only pitches that carry a throw.

    python backend/scripts/backfill_tm_base_pos.py <csv or directory> [...]

Reads DATABASE_URL from the environment or the repo .env. Skips files that
are not TrackMan game exports (positioning files, Rapsodo, box scores)."""
from __future__ import annotations

import csv
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.models.database import get_connection  # noqa: E402
from psycopg2.extras import execute_values  # noqa: E402

NEED = {"PitchUID", "BasePositionX", "BasePositionY", "BasePositionZ"}


def _f(v):
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None


def collect(paths):
    rows = {}
    files = 0
    for p in paths:
        p = Path(p)
        cands = sorted(p.rglob("*.csv")) if p.is_dir() else [p]
        for f in cands:
            try:
                with open(f, encoding="utf-8-sig", newline="") as fh:
                    rd = csv.DictReader(fh)
                    if not rd.fieldnames or not NEED.issubset(set(rd.fieldnames)):
                        continue
                    files += 1
                    for r in rd:
                        x, y, z = _f(r.get("BasePositionX")), _f(r.get("BasePositionY")), _f(r.get("BasePositionZ"))
                        if x is None and z is None:
                            continue
                        uid = (r.get("PitchUID") or "").strip()
                        if uid:
                            rows[uid] = (x, y, z)
            except (OSError, UnicodeDecodeError):
                continue
    return files, rows


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    files, rows = collect(argv)
    print(f"{files} TrackMan game files, {len(rows)} throws with a tracked base position")
    if not rows:
        return 0
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'tm_pitches' AND column_name = 'base_pos_x'""")
        if cur.fetchone() is None:
            for c in ("base_pos_x", "base_pos_y", "base_pos_z"):
                cur.execute(f"ALTER TABLE tm_pitches ADD COLUMN IF NOT EXISTS {c} DOUBLE PRECISION")
        cur.execute("SELECT COUNT(*) AS n FROM tm_pitches WHERE base_pos_x IS NOT NULL")
        before = cur.fetchone()["n"]
        execute_values(cur, """
            UPDATE tm_pitches AS p SET base_pos_x = v.x, base_pos_y = v.y, base_pos_z = v.z
            FROM (VALUES %s) AS v(uid, x, y, z)
            WHERE p.pitch_uid = v.uid AND p.base_pos_x IS NULL""",
            [(uid, x, y, z) for uid, (x, y, z) in rows.items()], page_size=1000)
        cur.execute("SELECT COUNT(*) AS n FROM tm_pitches WHERE base_pos_x IS NOT NULL")
        updated = cur.fetchone()["n"] - before
        cur.execute("""SELECT COUNT(*) AS n FROM tm_pitches
                       WHERE pop_time IS NOT NULL AND base_pos_x IS NULL""")
        missing = cur.fetchone()["n"]
    print(f"updated {updated} rows; pop times still without a base position: {missing}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
