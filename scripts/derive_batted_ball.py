#!/usr/bin/env python3
"""
Derive bb_type + field_zone for every contact PA in game_events.

Reads result_text + result_type, runs `classify_batted_ball.classify`,
and writes the two columns plus bb_derived_at.

Idempotent — safe to re-run after a classifier improvement; --force
re-derives even already-derived rows.

Usage:
    python3 scripts/derive_batted_ball.py
    python3 scripts/derive_batted_ball.py --force
    python3 scripts/derive_batted_ball.py --season 2026
    python3 scripts/derive_batted_ball.py --dry-run
"""

import argparse
import logging
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent))
from classify_batted_ball import classify  # noqa: E402

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
DATABASE_URL = os.environ.get("DATABASE_URL")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

CONTACT_TYPES = {
    "single", "double", "triple", "home_run",
    "ground_out", "fly_out", "line_out", "pop_out",
    "sac_fly", "sac_bunt",
    "fielders_choice", "error",
    "double_play", "triple_play",
}


def get_conn():
    url = DATABASE_URL
    if url and "sslmode" not in url:
        url += ("&" if "?" in url else "?") + "sslmode=require"
    conn = psycopg2.connect(url)
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def derive(season=None, force=False, dry_run=False, batch=2000):
    conn = get_conn()
    cur = conn.cursor()

    where = ["result_type = ANY(%s)"]
    params = [list(CONTACT_TYPES)]
    if season:
        where.append("game_id IN (SELECT id FROM games WHERE season = %s)")
        params.append(season)
    if not force:
        where.append("bb_derived_at IS NULL")

    cur.execute(
        f"""
        SELECT id, result_type, result_text
        FROM game_events
        WHERE {' AND '.join(where)}
        ORDER BY id
        """,
        params,
    )
    rows = cur.fetchall()
    total = len(rows)
    logger.info("%d events to classify%s",
                total, " (DRY-RUN)" if dry_run else "")
    if total == 0:
        return

    classified = 0
    bb_set = 0
    zone_set = 0
    updates = []
    for r in rows:
        bb, zone = classify(r["result_type"], r["result_text"])
        if bb:
            bb_set += 1
        if zone:
            zone_set += 1
        updates.append((bb, zone, r["id"]))
        classified += 1

        if len(updates) >= batch:
            if not dry_run:
                psycopg2.extras.execute_batch(
                    cur,
                    """
                    UPDATE game_events
                    SET bb_type = %s,
                        field_zone = %s,
                        bb_derived_at = now()
                    WHERE id = %s
                    """,
                    updates,
                    page_size=500,
                )
                conn.commit()
            updates = []
            logger.info("  progress: %d / %d", classified, total)

    # Flush tail
    if updates and not dry_run:
        psycopg2.extras.execute_batch(
            cur,
            """
            UPDATE game_events
            SET bb_type = %s,
                field_zone = %s,
                bb_derived_at = now()
            WHERE id = %s
            """,
            updates,
            page_size=500,
        )
        conn.commit()

    logger.info("DONE: classified=%d  bb_set=%d (%.1f%%)  zone_set=%d (%.1f%%)",
                classified, bb_set, 100 * bb_set / max(classified, 1),
                zone_set, 100 * zone_set / max(classified, 1))
    conn.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    derive(season=args.season, force=args.force, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
