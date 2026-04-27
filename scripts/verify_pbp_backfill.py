"""
Quick verification that the post-backfill PBP data looks correct.
Confirms:
  1. runner_sub events exist (pinch runner tracking is live)
  2. No IBB events have trailing " was" in batter_name
  3. Audit pass rate improved
  4. Resolution rates intact
  5. Sub-event distribution sane

Run on Mac OR server:
    PYTHONPATH=backend python3 scripts/verify_pbp_backfill.py
"""
from __future__ import annotations
import sys
from app.models.database import get_connection

SEASON = 2026


def main() -> int:
    with get_connection() as conn:
        cur = conn.cursor()

        # 1. runner_sub events
        cur.execute("""
            SELECT COUNT(*) AS n,
                   COUNT(DISTINCT game_id) AS games
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s AND ge.result_type = 'runner_sub'
        """, (SEASON,))
        r = cur.fetchone()
        print(f"\n── 1. Pinch / courtesy runner subs ──")
        print(f"  runner_sub events:     {r['n']:>5,}")
        print(f"  distinct games:        {r['games']:>5,}")
        print(f"  avg per game:          {(r['n'] / r['games']):.2f}" if r['games'] else "  (no games)")

        # 2. IBB batter_name cleanliness
        cur.execute("""
            SELECT
                SUM(CASE WHEN batter_name LIKE '%% was' THEN 1 ELSE 0 END) AS dirty,
                COUNT(*) AS total
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s AND ge.result_type = 'intentional_walk'
        """, (SEASON,))
        r = cur.fetchone()
        print(f"\n── 2. IBB batter_name cleanliness ──")
        print(f"  total IBB events:      {r['total']:>5,}")
        print(f"  events with ' was':    {r['dirty']:>5,}  (should be 0)")

        # 3. Audit pass rate
        cur.execute("""
            WITH ga AS (
                SELECT g.id,
                       (g.home_score + g.away_score) AS actual,
                       COALESCE(SUM(ge.runs_on_play), 0) AS derived
                FROM games g
                LEFT JOIN game_events ge ON ge.game_id = g.id
                WHERE g.season = %s AND g.home_score IS NOT NULL
                  AND g.away_score IS NOT NULL
                  AND g.home_score <> g.away_score
                  AND g.id IN (SELECT DISTINCT game_id FROM game_events)
                GROUP BY g.id
            )
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN derived = actual THEN 1 ELSE 0 END) AS perfect,
                   SUM(CASE WHEN ABS(derived - actual) = 1 THEN 1 ELSE 0 END) AS off1,
                   SUM(CASE WHEN ABS(derived - actual) >= 2 THEN 1 ELSE 0 END) AS off2plus
            FROM ga
        """, (SEASON,))
        r = cur.fetchone()
        tot = r["total"]
        print(f"\n── 3. Audit pass rate ──")
        print(f"  Total games audited:   {tot:>5,}")
        print(f"  Perfect:               {r['perfect']:>5,}  ({r['perfect']/tot*100:.1f}%)")
        print(f"  Off by 1:              {r['off1']:>5,}  ({r['off1']/tot*100:.1f}%)")
        print(f"  Off by 2+:             {r['off2plus']:>5,}  ({r['off2plus']/tot*100:.1f}%)")

        # 4. Player ID resolution
        cur.execute("""
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN batter_player_id IS NOT NULL THEN 1 ELSE 0 END) AS bat,
                SUM(CASE WHEN pitcher_player_id IS NOT NULL THEN 1 ELSE 0 END) AS pit
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s
              AND ge.result_type IS NOT NULL
              AND ge.result_type NOT IN ('stolen_base','caught_stealing','wild_pitch',
                                          'passed_ball','balk','pickoff','runner_other',
                                          'runner_sub')
        """, (SEASON,))
        r = cur.fetchone()
        tot = r["total"]
        print(f"\n── 4. Player ID resolution ──")
        print(f"  PA events:             {tot:>5,}")
        print(f"  Batter resolved:       {r['bat']:>5,}  ({r['bat']/tot*100:.1f}%)")
        print(f"  Pitcher resolved:      {r['pit']:>5,}  ({r['pit']/tot*100:.1f}%)")

        # 5. Sub-event distribution
        cur.execute("""
            SELECT result_type, COUNT(*) AS n
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s
              AND result_type IN ('stolen_base','caught_stealing','wild_pitch',
                                   'passed_ball','balk','pickoff','runner_other',
                                   'runner_sub')
            GROUP BY result_type ORDER BY n DESC
        """, (SEASON,))
        print(f"\n── 5. Sub-event distribution ──")
        for r in cur.fetchall():
            print(f"  {r['n']:>5,}  {r['result_type']}")

        # 6. Quick spot-check: an IBB followed by runner_sub
        cur.execute("""
            SELECT batter_name, result_text, game_id
            FROM game_events
            WHERE result_type = 'intentional_walk'
              AND game_id IN (SELECT game_id FROM game_events
                              WHERE result_type = 'runner_sub')
            LIMIT 5
        """)
        print(f"\n── 6. Sample IBB batter_names (post-fix) ──")
        for r in cur.fetchall():
            print(f"  game {r['game_id']:>5}  batter={r['batter_name']!r}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
