"""
Phase D.5 — diagnostic: find games where bot 9 events have the home
team batting with a lead. That state shouldn't exist (game ends when
home takes the lead in bot 9), so the events tell us where state
derivation goes wrong.

Run on Mac:
    cd ~/Desktop/pnw-baseball
    PYTHONPATH=backend python3 scripts/inspect_bot9_anomalies.py

Prints up to 3 anomaly games and walks every event from inning 8
onward, so we can see whether half is mislabeled, scores carry over
wrong, or something else is going on.
"""

from __future__ import annotations
import sys

from app.models.database import get_connection


SEASON = 2026


def main() -> int:
    with get_connection() as conn:
        cur = conn.cursor()

        # Find a few NCAA games with bot 9 events where home_score > away_score
        # going INTO the PA. Filter to NCAA so we know it's a 9-inning game
        # (NWAC plays 7-inning, so inning 9 there is extras and behaves
        # differently).
        cur.execute("""
            SELECT DISTINCT ge.game_id, g.home_team_id, g.away_team_id,
                   g.home_score, g.away_score, g.game_date,
                   th.short_name AS home_short, ta.short_name AS away_short
            FROM game_events ge
            JOIN games g       ON g.id = ge.game_id
            JOIN teams th      ON th.id = g.home_team_id
            JOIN teams ta      ON ta.id = g.away_team_id
            JOIN conferences ch ON ch.id = th.conference_id
            JOIN divisions  dh ON dh.id = ch.division_id
            WHERE g.season = %s
              AND ge.inning = 9
              AND ge.half = 'bottom'
              AND ge.bat_score_before IS NOT NULL
              AND ge.fld_score_before IS NOT NULL
              AND ge.bat_score_before > ge.fld_score_before
              AND dh.name <> 'NWAC'
            ORDER BY ge.game_id
            LIMIT 3
        """, (SEASON,))
        anomaly_games = cur.fetchall()

        if not anomaly_games:
            print("No NCAA games with bot 9 home-up-lead events found. "
                  "Either the bug is NWAC-only or it self-resolved.")
            return 0

        for ag in anomaly_games:
            print("=" * 78)
            print(f"Game {ag['game_id']}  on {ag['game_date']}  "
                  f"{ag['away_short']} @ {ag['home_short']}")
            print(f"  final score (home/away in games row): "
                  f"{ag['home_score']} - {ag['away_score']}")
            print(f"  home_team_id={ag['home_team_id']}  "
                  f"away_team_id={ag['away_team_id']}")
            print()
            cur.execute("""
                SELECT inning, half, sequence_idx,
                       batting_team_id, batter_name,
                       result_type, result_text,
                       bat_score_before, fld_score_before, runs_on_play
                FROM game_events
                WHERE game_id = %s
                  AND (inning >= 8 OR result_type IS NOT NULL)
                ORDER BY inning ASC,
                         CASE WHEN half = 'top' THEN 0 ELSE 1 END,
                         sequence_idx ASC
            """, (ag["game_id"],))
            evs = cur.fetchall()
            # Filter to inning 8+ for display
            evs = [e for e in evs if e["inning"] is not None and e["inning"] >= 8]

            print(f"  {len(evs)} events from inning 8 onward:")
            print(f"  {'inn/half':<8} {'seq':>3}  {'bat_team':>9}  "
                  f"{'b':>2} {'f':>2} {'r':>2}  {'res':<24} narrative")
            for e in evs:
                inn_h = f"{e['inning']}{e['half'][:1]}"
                snippet = (e['result_text'] or "")[:60]
                print(f"  {inn_h:<8} {e['sequence_idx']:>3}  "
                      f"{e['batting_team_id'] or '':>9}  "
                      f"{(e['bat_score_before'] if e['bat_score_before'] is not None else ''):>2} "
                      f"{(e['fld_score_before'] if e['fld_score_before'] is not None else ''):>2} "
                      f"{(e['runs_on_play'] or 0):>2}  "
                      f"{(e['result_type'] or '')[:24]:<24} {snippet}")
            print()

    return 0


if __name__ == "__main__":
    sys.exit(main())
