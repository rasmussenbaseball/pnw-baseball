"""One-time migration: move transfer-portal MEMBERSHIP from the git-tracked
backend/data/transfer_portal.json into the transfer_portal_members DB table, so
the dev Commitment Editor can add/remove portal players live (no deploy).

After this, the /transfer-portal endpoint reads membership (player_id + from +
position override) from the DB. committed_to already comes from the players
table (see migrate_portal_commits_to_db.py).

Idempotent — ON CONFLICT DO NOTHING.

    PYTHONPATH=backend python3 scripts/migrate_portal_members_to_db.py          # dry run
    PYTHONPATH=backend python3 scripts/migrate_portal_members_to_db.py --apply   # commit
"""
import json
import sys
from pathlib import Path

from app.models.database import get_connection
from app.api.admin_tools import _ensure_tables

APPLY = "--apply" in sys.argv
DATA = Path(__file__).parent.parent / "backend" / "data" / "transfer_portal.json"


def main():
    entries = json.load(open(DATA)).get("players", [])
    members = [(int(e["player_id"]), e.get("from"), e.get("position"))
               for e in entries if e.get("player_id")]
    print(f"{len(members)} portal members in JSON")
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        cur.execute("SELECT count(*) c FROM transfer_portal_members")
        print("existing rows in table:", cur.fetchone()["c"])
        if APPLY:
            for pid, frm, pos in members:
                cur.execute(
                    """INSERT INTO transfer_portal_members (player_id, from_school, position, added_by)
                       VALUES (%s, %s, %s, 'migration')
                       ON CONFLICT (player_id) DO NOTHING""",
                    (pid, frm, pos),
                )
            conn.commit()
            cur.execute("SELECT count(*) c FROM transfer_portal_members")
            print("rows after migration:", cur.fetchone()["c"])
        else:
            print("(dry run — pass --apply to insert)")


if __name__ == "__main__":
    main()
