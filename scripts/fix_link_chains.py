#!/usr/bin/env python3
"""
Flatten any broken chains in player_links where a canonical_id
is itself a linked_id (i.e., A→B→C should become A→C and B→C).
Safe to run multiple times.
"""
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "backend" / "data" / "pnw_baseball.db"
if not DB_PATH.exists():
    DB_PATH = Path(__file__).parent.parent / "data" / "pnw_baseball.db"

conn = sqlite3.connect(str(DB_PATH))
conn.row_factory = sqlite3.Row

# Find chains: links whose canonical_id is itself a linked_id somewhere
rows = conn.execute("""
    SELECT pl1.id as link_id,
           pl1.canonical_id as mid_id,
           pl1.linked_id as leaf_id,
           pl2.canonical_id as root_id
    FROM player_links pl1
    JOIN player_links pl2 ON pl1.canonical_id = pl2.linked_id
""").fetchall()

if rows:
    print(f"Found {len(rows)} broken chains, fixing...")
    for r in rows:
        print(f"  Link #{r['link_id']}: {r['leaf_id']} -> {r['mid_id']} -> {r['root_id']} (flattening to {r['leaf_id']} -> {r['root_id']})")
        conn.execute("UPDATE player_links SET canonical_id = ? WHERE id = ?",
                     (r["root_id"], r["link_id"]))
    conn.commit()
    print("All chains flattened!")
else:
    print("No broken chains found.")

conn.close()
