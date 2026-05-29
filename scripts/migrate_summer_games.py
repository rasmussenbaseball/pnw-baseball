#!/usr/bin/env python3
"""
Apply the summer per-game tables migration.

Run with:
    PYTHONPATH=backend python3 scripts/migrate_summer_games.py

Idempotent — all CREATEs use IF NOT EXISTS.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.models.database import get_connection


def main():
    sql_path = Path(__file__).resolve().parent / "migrate_summer_games.sql"
    sql = sql_path.read_text()
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(sql)
        conn.commit()
    print("OK — summer_games / summer_game_batting / summer_game_pitching tables ready.")


if __name__ == "__main__":
    main()
