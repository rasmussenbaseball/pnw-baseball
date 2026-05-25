"""
Apply the user_subscriptions Stripe-billing schema migration.

Run with:
    PYTHONPATH=backend python3 scripts/migrate_user_subscriptions_stripe.py

Idempotent — uses ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS,
and the tier-constraint dance handles existing 'paid' rows safely.
"""

from pathlib import Path

from app.models.database import get_connection


def main():
    sql_path = Path(__file__).resolve().parent / "migrate_user_subscriptions_stripe.sql"
    sql = sql_path.read_text()
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(sql)
        conn.commit()
    print("OK — user_subscriptions extended for Stripe.")


if __name__ == "__main__":
    main()
