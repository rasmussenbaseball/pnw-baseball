#!/usr/bin/env python3
"""Add headshot_url column to players table if it doesn't exist."""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection

def main():
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            cur.execute("ALTER TABLE players ADD COLUMN headshot_url TEXT")
            conn.commit()
            print("Added headshot_url column to players table")
        except Exception as e:
            conn.rollback()
            if "already exists" in str(e):
                print("headshot_url column already exists")
            else:
                print(f"Error: {e}")

if __name__ == "__main__":
    main()
