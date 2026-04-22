#!/usr/bin/env python3
"""
One-off: look up specific players to repair false-match groups found by
inspect_game_batting_dups.py.
"""

import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
DATABASE_URL = os.environ.get("DATABASE_URL")


def get_conn():
    url = DATABASE_URL
    if url and "sslmode" not in url:
        sep = "&" if "?" in url else "?"
        url = url + sep + "sslmode=require"
    conn = psycopg2.connect(url)
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def main():
    conn = get_conn()
    cur = conn.cursor()

    searches = [
        # (label, team_id, last_name_lower, first_name_contains)
        ("Darren Smith (team 22)",  22, "smith", "darren"),
        ("Hunter Smith (team 22)",  22, "smith", "hunter"),
        ("Ekolu Arai  (team 30)",   30, "arai",  "ekolu"),
        ("Koshi Arai  (team 30)",   30, "arai",  "koshi"),
        # Also dump all Smiths on team 22 and Arais on team 30 for context
    ]
    for label, tid, last, first_contains in searches:
        cur.execute(
            """
            SELECT id, first_name, last_name, team_id
            FROM players
            WHERE team_id = %s
              AND LOWER(last_name) = %s
              AND LOWER(first_name) LIKE %s
            ORDER BY id
""",
            (tid, last, f"%{first_contains}%"),
        )
        rows = cur.fetchall()
        print(f"\n{label}:")
        if not rows:
            print("  (no match)")
        for r in rows:
            print(f"  id={r['id']:<6} {r['first_name']} {r['last_name']}  team_id={r['team_id']}")

    print("\n---- All Smiths on team 22 ----")
    cur.execute(
        "SELECT id, first_name, last_name FROM players "
        "WHERE team_id = 22 AND LOWER(last_name) = 'smith' ORDER BY id"
    )
    for r in cur.fetchall():
        print(f"  id={r['id']:<6} {r['first_name']} {r['last_name']}")

    print("\n---- All Arais on team 30 ----")
    cur.execute(
        "SELECT id, first_name, last_name FROM players "
        "WHERE team_id = 30 AND LOWER(last_name) = 'arai' ORDER BY id"
    )
    for r in cur.fetchall():
        print(f"  id={r['id']:<6} {r['first_name']} {r['last_name']}")

    print("\n---- All Arais ANY team ----")
    cur.execute(
        "SELECT id, first_name, last_name, team_id FROM players "
        "WHERE LOWER(last_name) = 'arai' ORDER BY id"
    )
    for r in cur.fetchall():
        print(f"  id={r['id']:<6} {r['first_name']} {r['last_name']}  team_id={r['team_id']}")

    conn.close()


if __name__ == "__main__":
    main()
