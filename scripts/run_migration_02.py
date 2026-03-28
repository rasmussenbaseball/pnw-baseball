#!/usr/bin/env python3
"""
Run the games/boxscores migration against your Supabase Postgres database.

Usage:
    cd pnw-baseball
    PYTHONPATH=backend python3 scripts/run_migration_02.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from app.models.database import get_connection

SQL_FILE = Path(__file__).parent / "migrate_02_games_boxscores.sql"


def main():
    sql = SQL_FILE.read_text()
    print("Running migration: migrate_02_games_boxscores.sql")
    print(f"  ({len(sql)} bytes of SQL)")

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(sql)
        conn.commit()
        print("Migration complete! Tables created: games, game_batting, game_pitching")


if __name__ == "__main__":
    main()
