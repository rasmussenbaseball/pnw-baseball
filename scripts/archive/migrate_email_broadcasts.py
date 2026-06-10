"""
Apply the email_broadcasts table migration.

Run with:
    PYTHONPATH=backend python3 scripts/migrate_email_broadcasts.py

Idempotent — uses CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS,
so re-running on an already-migrated database is a no-op.
"""

from pathlib import Path

from app.models.database import get_connection


def main():
    sql_path = Path(__file__).resolve().parent / "migrate_email_broadcasts.sql"
    sql = sql_path.read_text()
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(sql)
        conn.commit()
    print("OK — email_broadcasts table ready.")


if __name__ == "__main__":
    main()
