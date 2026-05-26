"""
Apply the articles paywall migration.

Run with:
    PYTHONPATH=backend python3 scripts/migrate_articles_paywall.py

Idempotent.
"""

from pathlib import Path

from app.models.database import get_connection


def main():
    sql_path = Path(__file__).resolve().parent / "migrate_articles_paywall.sql"
    sql = sql_path.read_text()
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(sql)
        conn.commit()
    print("OK — articles.requires_tier added.")


if __name__ == "__main__":
    main()
