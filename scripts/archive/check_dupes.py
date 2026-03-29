#!/usr/bin/env python3
"""Check for duplicate player records."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
from app.models.database import get_connection

with get_connection() as conn:
    cur = conn.cursor()

    # Find duplicate players (same first_name, last_name, team_id)
    cur.execute("""
        SELECT p.first_name, p.last_name, t.short_name, COUNT(*) as cnt,
               ARRAY_AGG(p.id ORDER BY p.id) as player_ids
        FROM players p
        LEFT JOIN teams t ON p.team_id = t.id
        GROUP BY p.first_name, p.last_name, p.team_id, t.short_name
        HAVING COUNT(*) > 1
        ORDER BY cnt DESC
    """)
    rows = cur.fetchall()
    print(f"Found {len(rows)} sets of duplicate players:\n")
    for r in rows:
        print(f"  {r['first_name']} {r['last_name']} ({r['short_name']}): {r['cnt']}x — ids: {r['player_ids']}")
