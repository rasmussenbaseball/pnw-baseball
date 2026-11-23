#!/usr/bin/env python3
"""
One-time migration (Sept 2026): season-scope commitments and portal membership.

  players.committed_season        first season the player plays at the NEW school
                                  (legacy commits = 2027: they were made in the
                                  2026 cycle for the 2027 season)
  transfer_portal_members.season  cycle year (the season after which the player
                                  entered the portal); legacy rows = 2026
  wcl_portal_members.season       the summer the player was listed; legacy = 2026
  incoming_transfers.season       arrival season; legacy = 2027

Re-runnable: ALTERs are IF NOT EXISTS, backfills only touch NULLs.

  PYTHONPATH=backend python3 scripts/migrate_commit_seasons.py
"""
from app.models.database import get_connection

STMTS = [
    "ALTER TABLE players ADD COLUMN IF NOT EXISTS committed_season INTEGER",
    "ALTER TABLE transfer_portal_members ADD COLUMN IF NOT EXISTS season INTEGER",
    "ALTER TABLE wcl_portal_members ADD COLUMN IF NOT EXISTS season INTEGER",
    "ALTER TABLE incoming_transfers ADD COLUMN IF NOT EXISTS season INTEGER",
    "UPDATE players SET committed_season = 2027 WHERE COALESCE(is_committed, 0) = 1 AND committed_season IS NULL",
    "UPDATE transfer_portal_members SET season = 2026 WHERE season IS NULL",
    "UPDATE wcl_portal_members SET season = 2026 WHERE season IS NULL",
    "UPDATE incoming_transfers SET season = 2027 WHERE season IS NULL",
]


def main():
    with get_connection() as conn:
        cur = conn.cursor()
        for sql in STMTS:
            cur.execute(sql)
            print(f"  {cur.rowcount:>5} rows  {sql[:80]}")
        conn.commit()
    print("done")


if __name__ == "__main__":
    main()
