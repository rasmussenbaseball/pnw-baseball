"""Backfill tm_pitches.contact_x/y/z from raw TrackMan CSVs.

The suite's pitch ingest dedupes ON CONFLICT DO NOTHING, so re-uploading a
file never updates existing rows — this script reads the ORIGINAL CSVs and
fills the contact-position columns (added 2026-09) for pitches already in
the database, matching on TrackMan's global PitchUID.

Usage (Mac, where the raw files live):
    PYTHONPATH=backend python3 scripts/backfill_contact_position.py ~/Downloads
"""
import csv
import glob
import os
import sys

from psycopg2.extras import execute_values

from app.models.database import get_connection


def main(folder):
    updates = {}
    scanned = 0
    for path in glob.glob(os.path.join(os.path.expanduser(folder), "*.csv")):
        try:
            with open(path, newline="", encoding="utf-8-sig") as f:
                reader = csv.DictReader(f)
                heads = reader.fieldnames or []
                if "PitchUID" not in heads or "ContactPositionX" not in heads:
                    continue
                scanned += 1
                for r in reader:
                    uid = (r.get("PitchUID") or "").strip()
                    if not uid:
                        continue
                    try:
                        x = float(r["ContactPositionX"])
                        y = float(r["ContactPositionY"])
                        z = float(r["ContactPositionZ"])
                    except (ValueError, KeyError, TypeError):
                        continue
                    updates[uid] = (x, y, z)
        except Exception as e:
            print(f"skip {os.path.basename(path)}: {e}")
    print(f"{scanned} TrackMan files scanned, {len(updates)} pitches with contact position")
    if not updates:
        return
    rows = [(uid, x, y, z) for uid, (x, y, z) in updates.items()]
    with get_connection() as conn:
        cur = conn.cursor()
        execute_values(cur, """
            UPDATE tm_pitches AS t
            SET contact_x = v.x, contact_y = v.y, contact_z = v.z
            FROM (VALUES %s) AS v(uid, x, y, z)
            WHERE t.pitch_uid = v.uid
        """, rows, page_size=500)
        print(f"updated {cur.rowcount} database rows")
        conn.commit()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "~/Downloads")
