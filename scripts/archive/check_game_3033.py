"""Inspect game 3033's scrape history + verify the parser produces
clean batter_names when re-run on its actual HTML."""
import sys, re
from app.models.database import get_connection

sys.path.insert(0, "scripts")
from parse_pbp_events import extract_batter_name

# 1. Sanity: does my updated extract_batter_name produce a clean name?
text = "Liam Irish was intentionally walked (3-0 BBBB)."
print(f"extract_batter_name(text, 'intentional_walk') = {extract_batter_name(text, 'intentional_walk')!r}")
print(f"   (expected: 'Liam Irish')")

# 2. Look at the game's metadata
with get_connection() as conn:
    cur = conn.cursor()
    cur.execute("""
        SELECT id, game_date, source_url, pbp_scraped_at, pbp_attempt_count,
               status, home_team_id, away_team_id, home_score, away_score
        FROM games WHERE id = 3033
    """)
    g = dict(cur.fetchone() or {})
    print(f"\nGame 3033 metadata:")
    for k, v in g.items():
        print(f"  {k}: {v}")

    # 3. Look at the full event around the IBB
    cur.execute("""
        SELECT id, sequence_idx, batter_name, result_text, result_type
        FROM game_events
        WHERE game_id = 3033 AND result_type = 'intentional_walk'
    """)
    print(f"\nIBB events in game 3033:")
    for r in cur.fetchall():
        print(f"  id={r['id']}  seq={r['sequence_idx']}")
        print(f"    batter_name = {r['batter_name']!r}")
        print(f"    result_text = {r['result_text']!r}")
