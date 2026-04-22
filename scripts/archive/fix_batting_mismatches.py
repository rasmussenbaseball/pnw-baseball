#!/usr/bin/env python3
"""
Targeted repair for 3 game_batting rows where the matcher wrongly matched
players with no row in the players table to a different player who happened
to share a last name on the same team.

Rows:
  id=2317185  game=1413  "Smith, Darren" wrongly -> player_id=4709 (Cameron Smith)
  id=2317199  game=1413  "Smith, Hunter" wrongly -> player_id=4709 (Cameron Smith)
  id=1182790  game=2696  "Ekolu Arai"    wrongly -> player_id=1103 (Koshi Arai)

Fix: set player_id = NULL so the rows become orphans (still counted in per-game
box score totals with their correct name text, but not wrongly linked to
another player's page).

Usage:
    python3 scripts/fix_batting_mismatches.py --dry-run
    python3 scripts/fix_batting_mismatches.py
"""

import argparse
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
logger = logging.getLogger(__name__)

ROW_IDS = [2317185, 2317199, 1182790]


def get_conn():
    url = DATABASE_URL
    if url and "sslmode" not in url:
        sep = "&" if "?" in url else "?"
        url = url + sep + "sslmode=require"
    conn = psycopg2.connect(url)
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    conn = get_conn()
    cur = conn.cursor()

    # Show the rows before.
    cur.execute(
        """
        SELECT id, game_id, team_id, player_id, player_name
        FROM game_batting
        WHERE id = ANY(%s)
        ORDER BY id
        """,
        (ROW_IDS,),
    )
    rows = cur.fetchall()
    logger.info("Before:")
    for r in rows:
        logger.info(
            "  id=%s  game=%s  team=%s  player_id=%s  player_name=%s",
            r["id"], r["game_id"], r["team_id"], r["player_id"], r["player_name"],
        )

    cur.execute(
        "UPDATE game_batting SET player_id = NULL WHERE id = ANY(%s)",
        (ROW_IDS,),
    )
    logger.info("UPDATE affected %s rows.", cur.rowcount)

    # Show after.
    cur.execute(
        """
        SELECT id, game_id, team_id, player_id, player_name
        FROM game_batting
        WHERE id = ANY(%s)
        ORDER BY id
        """,
        (ROW_IDS,),
    )
    logger.info("After:")
    for r in cur.fetchall():
        logger.info(
            "  id=%s  game=%s  team=%s  player_id=%s  player_name=%s",
            r["id"], r["game_id"], r["team_id"], r["player_id"], r["player_name"],
        )

    if args.dry_run:
        conn.rollback()
        logger.info("[DRY RUN] Rolled back.")
    else:
        conn.commit()
        logger.info("COMMITTED.")

    conn.close()


if __name__ == "__main__":
    main()
