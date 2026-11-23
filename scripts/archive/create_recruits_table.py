#!/usr/bin/env python3
"""
Migration: create the `recruits` table for HS-recruit / commit ingestion.

A high-school recruit is fundamentally not a college roster row (players.team_id
is NOT NULL and every existing "commit" is a JUCO roster player), so recruits
live in their own dedicated table. See the "Recruiting Classes" plan.

Idempotent: CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS, so it is safe
to run repeatedly. scrape_recruits.py also calls ensure_schema() on every run, so
running this migration explicitly is optional but handy for a clean bootstrap.

Usage:
    PYTHONPATH=backend python3 scripts/create_recruits_table.py
"""

import logging
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
DATABASE_URL = os.environ.get("DATABASE_URL")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("create_recruits_table")


def get_conn():
    url = DATABASE_URL
    if url and "sslmode" not in url:
        url += ("&" if "?" in url else "?") + "sslmode=require"
    conn = psycopg2.connect(url)
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


# Single source of truth for the recruits schema. Both this migration and
# scrape_recruits.ensure_schema() use it so the two never drift.
CREATE_SQL = """
CREATE TABLE IF NOT EXISTS recruits (
    id              serial PRIMARY KEY,
    first_name      text NOT NULL,
    last_name       text NOT NULL,
    position        text,
    grad_year       int NOT NULL,
    high_school     text,
    city            text,
    state           text,
    height          text,
    weight          int,
    committed_team_id int REFERENCES teams(id),
    committed_raw   text,
    pbr_state_rank  int,
    pbr_url         text,
    bbnw_state_rank int,
    bbnw_url        text,
    recruit_score   numeric,
    sources         text[],
    commitment_date date,
    headshot_url    text,
    first_seen      timestamptz DEFAULT now(),
    last_seen       timestamptz,
    UNIQUE (first_name, last_name, grad_year)
)
"""

INDEX_SQL = [
    "CREATE INDEX IF NOT EXISTS recruits_committed_team_idx ON recruits (committed_team_id)",
    "CREATE INDEX IF NOT EXISTS recruits_grad_year_idx ON recruits (grad_year)",
    "CREATE INDEX IF NOT EXISTS recruits_state_idx ON recruits (state)",
]


def ensure_schema(cur):
    """Create the recruits table + indexes if absent. Idempotent."""
    cur.execute(CREATE_SQL)
    for stmt in INDEX_SQL:
        cur.execute(stmt)


def main():
    if not DATABASE_URL:
        logger.error("DATABASE_URL not set (check .env)")
        sys.exit(1)
    with get_conn() as conn:
        cur = conn.cursor()
        ensure_schema(cur)
        conn.commit()
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'recruits' ORDER BY ordinal_position
        """)
        cols = [r["column_name"] for r in cur.fetchall()]
    logger.info("recruits table ready (%d columns): %s", len(cols), ", ".join(cols))


if __name__ == "__main__":
    main()
