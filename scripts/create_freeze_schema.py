#!/usr/bin/env python3
"""
Step 1 of the playoff-freeze feature: create schema only.

Creates four tables used by the per-conference freeze mechanism:

1. conference_freezes
   Tracks which conferences have ended their regular season and when.
   One row per conference (conf_key primary key). When a row exists, the
   conference is considered frozen and downstream features should serve
   their snapshotted data instead of live aggregates.

2. batting_stats_frozen
   A snapshot copy of batting_stats rows for players on teams in the frozen
   conference, taken at freeze time. Same schema as batting_stats.

3. pitching_stats_frozen
   Same idea for pitching_stats.

4. team_season_stats_frozen
   Same idea for team_season_stats (W-L records used by playoff projections
   and standings).

This script is idempotent: it uses IF NOT EXISTS for every table so it is
safe to run multiple times. It does NOT modify any existing data.

Usage (from repo root):
    PYTHONPATH=backend python3 scripts/create_freeze_schema.py
"""

import sys
import os
import logging

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("create_freeze_schema")


CREATE_CONFERENCE_FREEZES = """
CREATE TABLE IF NOT EXISTS conference_freezes (
    conf_key TEXT PRIMARY KEY,
    regular_season_end_date DATE NOT NULL,
    frozen_at TIMESTAMP NOT NULL DEFAULT NOW(),
    notes TEXT
);
"""

# Snapshot tables mirror their live counterparts exactly.
# INCLUDING ALL copies defaults, constraints, indexes, and storage params,
# but does NOT copy foreign keys (which is what we want -- the snapshot
# should stand alone even if the live tables change).
CREATE_BATTING_FROZEN = """
CREATE TABLE IF NOT EXISTS batting_stats_frozen
    (LIKE batting_stats INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
"""

CREATE_PITCHING_FROZEN = """
CREATE TABLE IF NOT EXISTS pitching_stats_frozen
    (LIKE pitching_stats INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
"""

CREATE_TEAM_SEASON_FROZEN = """
CREATE TABLE IF NOT EXISTS team_season_stats_frozen
    (LIKE team_season_stats INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
"""

# Every frozen row needs to know which conference's freeze it belongs to,
# so we can cleanly drop/refresh a single conference without touching others.
ADD_CONF_KEY_BATTING = """
ALTER TABLE batting_stats_frozen
    ADD COLUMN IF NOT EXISTS conf_key TEXT;
"""

ADD_CONF_KEY_PITCHING = """
ALTER TABLE pitching_stats_frozen
    ADD COLUMN IF NOT EXISTS conf_key TEXT;
"""

ADD_CONF_KEY_TEAM = """
ALTER TABLE team_season_stats_frozen
    ADD COLUMN IF NOT EXISTS conf_key TEXT;
"""

# Indexes to make the snapshot lookups fast.
CREATE_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_batting_frozen_conf ON batting_stats_frozen (conf_key, season);",
    "CREATE INDEX IF NOT EXISTS idx_pitching_frozen_conf ON pitching_stats_frozen (conf_key, season);",
    "CREATE INDEX IF NOT EXISTS idx_team_season_frozen_conf ON team_season_stats_frozen (conf_key, season);",
]


def run():
    with get_connection() as conn:
        cur = conn.cursor()

        logger.info("Creating conference_freezes...")
        cur.execute(CREATE_CONFERENCE_FREEZES)

        logger.info("Creating batting_stats_frozen...")
        cur.execute(CREATE_BATTING_FROZEN)
        cur.execute(ADD_CONF_KEY_BATTING)

        logger.info("Creating pitching_stats_frozen...")
        cur.execute(CREATE_PITCHING_FROZEN)
        cur.execute(ADD_CONF_KEY_PITCHING)

        logger.info("Creating team_season_stats_frozen...")
        cur.execute(CREATE_TEAM_SEASON_FROZEN)
        cur.execute(ADD_CONF_KEY_TEAM)

        logger.info("Creating indexes...")
        for sql in CREATE_INDEXES:
            cur.execute(sql)

        conn.commit()
        logger.info("Done. Schema ready. No data changed.")

        # Quick sanity check: show row counts so Nate can confirm tables exist and are empty.
        for table in (
            "conference_freezes",
            "batting_stats_frozen",
            "pitching_stats_frozen",
            "team_season_stats_frozen",
        ):
            cur.execute(f"SELECT COUNT(*) AS n FROM {table};")
            n = cur.fetchone()["n"]
            logger.info("  %s: %d rows", table, n)


if __name__ == "__main__":
    run()
