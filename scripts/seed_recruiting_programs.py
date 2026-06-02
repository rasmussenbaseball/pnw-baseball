#!/usr/bin/env python3
"""
Seed / refresh the recruiting_programs table from
backend/app/data/recruiting_programs.json (built by
scripts/build_recruiting_programs_json.py).

Idempotent UPSERT keyed by team_id. Run AFTER scripts/migrate_recruiting_programs.sql
has created the table.

Usage (from repo root, on the server):
    PYTHONPATH=backend python3 scripts/seed_recruiting_programs.py
"""
import json
from pathlib import Path

from psycopg2.extras import Json

from app.models.database import get_connection

DATA = Path(__file__).resolve().parent.parent / "backend" / "app" / "data" / "recruiting_programs.json"


def main():
    programs = json.loads(DATA.read_text())
    with get_connection() as conn:  # commits on clean exit
        cur = conn.cursor()
        n = 0
        for p in programs:
            cur.execute(
                """
                INSERT INTO recruiting_programs
                    (team_id, school_name, division, conference, profile, updated_at)
                VALUES (%s, %s, %s, %s, %s, now())
                ON CONFLICT (team_id) DO UPDATE SET
                    school_name = EXCLUDED.school_name,
                    division    = EXCLUDED.division,
                    conference  = EXCLUDED.conference,
                    profile     = EXCLUDED.profile,
                    updated_at  = now()
                """,
                (p["team_id"], p["school_name"], p.get("division"),
                 p.get("conference"), Json(p.get("profile") or {})),
            )
            n += 1
        cur.execute("SELECT COUNT(*) AS c FROM recruiting_programs")
        total = cur.fetchone()["c"]
    print(f"Upserted {n} programs. Table now has {total} rows.")


if __name__ == "__main__":
    main()
