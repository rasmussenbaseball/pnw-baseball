#!/usr/bin/env python3
"""
Apply scripts/migrate_04_game_batting_unique.sql to the database.

Usage:
    python3 scripts/apply_migration_04.py
"""

import logging
import os
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
DATABASE_URL = os.environ.get("DATABASE_URL")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def main():
    if not DATABASE_URL:
        logger.error("DATABASE_URL not set in environment / .env")
        sys.exit(1)

    sql_path = Path(__file__).resolve().parent / "migrate_04_game_batting_unique.sql"
    sql = sql_path.read_text()

    url = DATABASE_URL
    if "sslmode" not in url:
        sep = "&" if "?" in url else "?"
        url = url + sep + "sslmode=require"
    conn = psycopg2.connect(url)
    cur = conn.cursor()

    try:
        logger.info("Applying %s ...", sql_path.name)
        cur.execute(sql)
        conn.commit()
        logger.info("Migration applied successfully.")

        # Verify the index exists.
        cur.execute("""
            SELECT indexname, indexdef
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename = 'game_batting'
              AND indexname = 'uniq_game_batting_game_player'
        """)
        row = cur.fetchone()
        if row:
            logger.info("Verified index: %s", row[0])
            logger.info("  %s", row[1])
        else:
            logger.warning("Index uniq_game_batting_game_player NOT FOUND after migration.")
    except psycopg2.Error as e:
        conn.rollback()
        logger.error("Migration FAILED: %s", e)
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
