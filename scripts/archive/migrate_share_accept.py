#!/usr/bin/env python3
"""
One-time migration (Oct 2026): staff shares become INVITATIONS.

tracking_workspace_shares.accepted_at is added; rows that already exist were
created when adding an email took effect immediately (and the member's data
was already merged), so they are stamped accepted. New rows stay NULL until
the invited coach accepts from their portal.

  PYTHONPATH=backend python3 scripts/migrate_share_accept.py
"""
from app.models.database import get_connection

with get_connection() as conn:
    cur = conn.cursor()
    cur.execute("ALTER TABLE tracking_workspace_shares ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ")
    cur.execute("UPDATE tracking_workspace_shares SET accepted_at = COALESCE(created_at, NOW()) WHERE accepted_at IS NULL")
    print(f"  {cur.rowcount} existing shares marked accepted")
    conn.commit()
print("done")
