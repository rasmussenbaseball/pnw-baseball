#!/usr/bin/env python3
"""Diagnose home/road and opponent display issues for Albert Jennings."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
from app.models.database import get_connection


def run():
    with get_connection() as conn:
        cur = conn.cursor()

        # Show Albert's player record
        print("=== Albert Jennings player records ===")
        cur.execute("""
            SELECT p.id, p.team_id, p.first_name, p.last_name, t.short_name
            FROM players p
            JOIN teams t ON p.team_id = t.id
            WHERE p.last_name ILIKE 'Jennings' AND p.first_name ILIKE 'Albert%'
        """)
        for r in cur.fetchall():
            print(dict(r))

        # Show his game_batting rows WITH full game context
        print("\n=== His game_batting rows + game record details ===")
        cur.execute("""
            SELECT
                gb.player_name, gb.player_id, gb.team_id as gb_team_id,
                g.id as game_id, g.game_date, g.game_number,
                g.home_team_id, g.away_team_id,
                g.home_team_name, g.away_team_name,
                g.home_score, g.away_score,
                ht.short_name as home_short, at2.short_name as away_short
            FROM game_batting gb
            JOIN games g ON gb.game_id = g.id
            LEFT JOIN teams ht ON ht.id = g.home_team_id
            LEFT JOIN teams at2 ON at2.id = g.away_team_id
            WHERE (gb.player_name ILIKE '%Jennings%Albert%'
               OR gb.player_name ILIKE '%Albert%Jennings%')
            ORDER BY g.game_date, g.id
        """)
        for r in cur.fetchall():
            d = dict(r)
            # Highlight the problem
            is_home = (d['gb_team_id'] == d['home_team_id'])
            if is_home:
                opp = d['away_short'] or d['away_team_name'] or '?'
            else:
                opp = d['home_short'] or d['home_team_name'] or '?'
            d['_computed_home_road'] = 'HOME' if is_home else 'ROAD'
            d['_computed_opponent'] = opp
            print(d)


if __name__ == "__main__":
    run()
