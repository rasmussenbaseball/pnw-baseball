"""
Apply the user_subscriptions table migration.

Run with:
    PYTHONPATH=backend python3 scripts/migrate_user_subscriptions.py

Idempotent.
"""

from pathlib import Path

from app.models.database import get_connection


def main():
    sql_path = Path(__file__).resolve().parent / "migrate_user_subscriptions.sql"
    sql = sql_path.read_text()
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(sql)
        conn.commit()
    print("OK — user_subscriptions table ready.")


if __name__ == "__main__":
    main()
