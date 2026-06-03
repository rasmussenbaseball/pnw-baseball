"""
Find the 2 IBB events whose batter_name still has trailing " was".
Print full result_text + neighboring events so we can see what
narrative format my anchor missed.
"""
import sys
from app.models.database import get_connection

with get_connection() as conn:
    cur = conn.cursor()
    cur.execute("""
        SELECT ge.id, ge.game_id, ge.inning, ge.half, ge.sequence_idx,
               ge.batter_name, ge.result_text,
               g.game_date,
               th.short_name AS home_short, ta.short_name AS away_short
        FROM game_events ge
        JOIN games g ON g.id = ge.game_id
        JOIN teams th ON th.id = g.home_team_id
        JOIN teams ta ON ta.id = g.away_team_id
        WHERE g.season = 2026
          AND ge.result_type = 'intentional_walk'
          AND ge.batter_name LIKE '%% was'
        ORDER BY ge.id
    """)
    for r in cur.fetchall():
        print(f"\n── event {r['id']} (game {r['game_id']}: "
              f"{r['away_short']} @ {r['home_short']} {r['game_date']}) ──")
        print(f"  inning: {r['half']} {r['inning']} seq={r['sequence_idx']}")
        print(f"  batter_name (stored): {r['batter_name']!r}")
        print(f"  result_text (full):   {r['result_text']!r}")
