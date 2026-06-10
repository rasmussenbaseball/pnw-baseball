#!/usr/bin/env python3
"""One-off helper: re-scrape a batch of game_ids by reading them from
stdin, in order. Avoids the --limit+ORDER-BY-DESC repeat issue.
Usage:  echo "id1 id2 id3" | python3 scripts/_oneoff_rescrape_batch.py
"""
import sys
sys.path.insert(0, "scripts")
sys.path.insert(0, "backend")
from app.models.database import get_connection
from scrape_pbp import process_game

ids = []
for tok in sys.stdin.read().split():
    if tok.isdigit():
        ids.append(int(tok))

print(f"Processing {len(ids)} games...")
with get_connection() as conn:
    cur = conn.cursor()
    for gid in ids:
        cur.execute("""
            SELECT g.id, g.source_url, g.season, g.game_date,
                   g.home_team_id, g.home_team_name, g.away_team_id, g.away_team_name,
                   ht.name AS home_db_name, ht.school_name AS home_db_school, ht.short_name AS home_db_short,
                   at.name AS away_db_name, at.school_name AS away_db_school, at.short_name AS away_db_short
            FROM games g
            JOIN teams ht ON ht.id = g.home_team_id
            JOIN teams at ON at.id = g.away_team_id
            WHERE g.id = %s
        """, (gid,))
        g = cur.fetchone()
        if not g:
            print(f"  {gid}: not found")
            continue
        try:
            r = process_game(cur, dict(g), dry_run=False, verbose=False)
            conn.commit()
            print(f"  {gid}: events={r['events_total']}, batters={r['batters_resolved']}, pitchers={r['pitchers_resolved']}")
        except Exception as e:
            print(f"  {gid}: ERROR {e}")
            conn.rollback()
