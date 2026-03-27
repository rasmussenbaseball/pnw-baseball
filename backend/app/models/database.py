"""
Database connection for PNW College Baseball Analytics.

Connects to Supabase Postgres. Uses DATABASE_URL environment variable
or falls back to the Supabase pooler connection string.
"""

import os
from contextlib import contextmanager

import psycopg2
import psycopg2.extras


# Connection string: check env var first (for Render), then fall back
DATABASE_URL = os.environ.get("DATABASE_URL")

if not DATABASE_URL:
    # Load from .env file if not set as environment variable
    from dotenv import load_dotenv
    from pathlib import Path
    load_dotenv(Path(__file__).resolve().parent.parent.parent.parent / ".env")
    DATABASE_URL = os.environ.get("DATABASE_URL")


@contextmanager
def get_connection():
    """Context manager for database connections.

    Returns a connection with RealDictCursor so rows behave like dicts
    (row["column_name"]) — same interface the rest of the code expects.
    """
    conn = psycopg2.connect(DATABASE_URL)
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    """No-op for Postgres — tables are created via migration script."""
    print("Database: using Supabase Postgres")


def seed_divisions_and_conferences():
    """No-op for Postgres — data is already migrated."""
    pass
