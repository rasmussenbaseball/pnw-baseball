#!/usr/bin/env python3
"""
Step 4a of the playoff-freeze feature: add projection_snapshots table.

This table stores a captured copy of the /playoff-projections output for a
single conference at the moment it freezes. When the endpoint serves a
frozen conference, it reads from here instead of re-running Monte Carlo
against stale/drifting inputs.

One row per (conf_key, season). The snapshot_json column holds the exact
section of the projection response that corresponds to this conference --
standings, seeds, playoff fields, championship probabilities, etc. -- so
the endpoint can drop it into the live response unchanged.

Idempotent: safe to run multiple times.

Usage:
    PYTHONPATH=backend python3 scripts/create_projection_snapshots_table.py
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
logger = logging.getLogger("create_projection_snapshots_table")


CREATE_SQL = """
CREATE TABLE IF NOT EXISTS projection_snapshots (
    conf_key TEXT NOT NULL,
    season INTEGER NOT NULL,
    snapshot_json JSONB NOT NULL,
    snapshotted_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (conf_key, season)
);
"""

CREATE_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_projection_snapshots_season
    ON projection_snapshots (season);
"""


def run():
    with get_connection() as conn:
        cur = conn.cursor()
        logger.info("Creating projection_snapshots...")
        cur.execute(CREATE_SQL)
        cur.execute(CREATE_INDEX_SQL)
        conn.commit()

        cur.execute("SELECT COUNT(*) AS n FROM projection_snapshots;")
        n = cur.fetchone()["n"]
        logger.info("Done. projection_snapshots has %d rows.", n)


if __name__ == "__main__":
    run()
