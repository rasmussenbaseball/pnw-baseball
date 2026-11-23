"""One-time migration: copy transfer_portal.json `committed_to` values into
the players table (is_committed / committed_to / commitment_date).

After this, the players table is the single source of truth for ALL
commitments (NWAC + transfer + profile badge), and the dev Commitment Editor
can edit/undo them live. The /transfer-portal endpoint reads committed_to
from the DB instead of the JSON.

Safe to re-run (idempotent): only updates rows whose committed_to differs.

    PYTHONPATH=backend python3 scripts/migrate_portal_commits_to_db.py          # dry run
    PYTHONPATH=backend python3 scripts/migrate_portal_commits_to_db.py --apply   # commit
"""
import json
import sys
from pathlib import Path

from app.models.database import get_connection

APPLY = "--apply" in sys.argv
DATA = Path(__file__).parent.parent / "backend" / "data" / "transfer_portal.json"


def main():
    entries = json.load(open(DATA)).get("players", [])
    committed = [
        (int(e["player_id"]), e["committed_to"].strip())
        for e in entries
        if e.get("player_id") and e.get("committed_to")
    ]
    print(f"{len(committed)} committed transfer entries in JSON")

    changed = 0
    with get_connection() as conn:
        cur = conn.cursor()
        for pid, school in committed:
            cur.execute("SELECT first_name, last_name, is_committed, committed_to FROM players WHERE id = %s", (pid,))
            row = cur.fetchone()
            if not row:
                print(f"  ! player {pid} not found (committed_to={school}) — skipped")
                continue
            already = bool(row["is_committed"]) and (row["committed_to"] or "").strip() == school
            if already:
                continue
            name = f"{row['first_name']} {row['last_name']}"
            print(f"  {'APPLY' if APPLY else 'WOULD'}: {name} ({pid})  {row['committed_to']!r} -> {school!r}")
            if APPLY:
                cur.execute(
                    """UPDATE players SET is_committed = 1, committed_to = %s,
                              commitment_date = COALESCE(commitment_date, now())
                       WHERE id = %s""",
                    (school, pid),
                )
            changed += 1
        if APPLY:
            conn.commit()
    print(f"{'Applied' if APPLY else 'Would change'} {changed} player rows.")


if __name__ == "__main__":
    main()
