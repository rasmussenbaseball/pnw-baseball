"""
Direct DB inspection for game 3695 bot 8 events. Print every state
column so we can see exactly what the state machine wrote vs what we
expected.
"""
import sys
from app.models.database import get_connection

with get_connection() as conn:
    cur = conn.cursor()
    cur.execute("""
        SELECT id, sequence_idx, result_type, batter_name,
               bases_before, bases_after, outs_before, outs_after,
               r1_name, r2_name, r3_name, runs_on_play,
               result_text
        FROM game_events
        WHERE game_id = 3695 AND inning = 8 AND half = 'bottom'
        ORDER BY sequence_idx
    """)
    rows = cur.fetchall()

print(f"{'idx':>3} {'type':<22} {'batter':<28} "
      f"{'bb':>3} {'ba':>3}  {'r1':<24} {'r2':<24} {'r3':<24}")
for r in rows:
    print(f"{r['sequence_idx']:>3} {r['result_type']:<22} "
          f"{(r['batter_name'] or '-')[:28]:<28} "
          f"{(r['bases_before'] or '?'):>3} {(r['bases_after'] or '?'):>3}  "
          f"{(r['r1_name'] or '-')[:24]:<24} "
          f"{(r['r2_name'] or '-')[:24]:<24} "
          f"{(r['r3_name'] or '-')[:24]:<24}")
    print(f"      → {(r['result_text'] or '')[:100]}")
