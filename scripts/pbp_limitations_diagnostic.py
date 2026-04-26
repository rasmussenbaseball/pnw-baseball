"""
Comprehensive PBP-quality diagnostic. Quantifies every category of
limitation we know about so we can prioritize cleanup.

Categories covered:
  1. Coverage — what fraction of games have PBP at all
  2. Audit accuracy — do per-PA runs sum to the games-table final
  3. State derivation — how many events have full state populated
  4. Player ID resolution — how many events are keyed to a real player
  5. Pitch sequence — how many events have count + pitch sequence
  6. Batted ball classification — how many BIP have bb_type / field_zone
  7. Audit gap distribution — when audits fail, how off are they?
  8. Per-team audit pass rates — is failure concentrated on certain teams?
  9. Per-source audit pass rates — Sidearm vs NWAC vs other
 10. OOC opponent gap — how big is the player_id hole from out-of-conference

Run on Mac:
    cd ~/Desktop/pnw-baseball
    PYTHONPATH=backend python3 scripts/pbp_limitations_diagnostic.py
"""

from __future__ import annotations
import sys
from collections import Counter

from app.models.database import get_connection


SEASON = 2026

PA_RESULT_TYPES = (
    "home_run", "triple", "double", "single",
    "walk", "intentional_walk", "hbp",
    "strikeout_swinging", "strikeout_looking",
    "ground_out", "fly_out", "line_out", "pop_out",
    "sac_fly", "sac_bunt", "fielders_choice", "error",
    "double_play", "triple_play", "catcher_interference",
)


def section(title):
    print()
    print("=" * 70)
    print(f"  {title}")
    print("=" * 70)


def main() -> int:
    with get_connection() as conn:
        cur = conn.cursor()

        # ── 1. Game-level coverage ───────────────────────────────
        section("1. GAME-LEVEL COVERAGE")
        cur.execute("""
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN id IN (SELECT DISTINCT game_id FROM game_events)
                            THEN 1 ELSE 0 END) AS with_events,
                   SUM(CASE WHEN home_score IS NOT NULL AND away_score IS NOT NULL
                            AND home_score <> away_score
                            THEN 1 ELSE 0 END) AS decisive
            FROM games WHERE season = %s AND status = 'final'
        """, (SEASON,))
        r = cur.fetchone()
        total = r["total"]
        with_events = r["with_events"] or 0
        decisive = r["decisive"] or 0
        print(f"  Total final 2026 games:              {total:>5,}")
        print(f"  Games with PBP events:               {with_events:>5,}  ({with_events/total*100:.1f}%)")
        print(f"  Games with decisive final score:     {decisive:>5,}")
        print(f"  Coverage gap (no PBP):               {total - with_events:>5,}")

        # By source — group by team logo URL or name patterns
        cur.execute("""
            SELECT
                CASE WHEN d.name = 'NWAC' THEN 'NWAC'
                     WHEN d.level IN ('D2','D3','NAIA') THEN 'NCAA D2/D3/NAIA'
                     WHEN d.level = 'D1' THEN 'NCAA D1'
                     ELSE d.level END AS source_group,
                COUNT(DISTINCT g.id) AS total_games,
                COUNT(DISTINCT CASE WHEN g.id IN
                       (SELECT DISTINCT game_id FROM game_events)
                       THEN g.id END) AS with_events
            FROM games g
            LEFT JOIN teams t ON t.id = COALESCE(g.home_team_id, g.away_team_id)
            LEFT JOIN conferences c ON c.id = t.conference_id
            LEFT JOIN divisions d ON d.id = c.division_id
            WHERE g.season = %s AND g.status = 'final'
              AND (g.home_team_id = t.id OR g.away_team_id = t.id)
            GROUP BY source_group
            ORDER BY total_games DESC
        """, (SEASON,))
        print(f"\n  Coverage by source group:")
        print(f"  {'Source':<24} {'Games':>7} {'WithPBP':>9} {'%':>6}")
        for r in cur.fetchall():
            pct = (r["with_events"] / r["total_games"] * 100) if r["total_games"] else 0
            print(f"  {r['source_group']:<24} {r['total_games']:>7,} "
                  f"{r['with_events']:>9,} {pct:>5.1f}%")

        # ── 2. Audit accuracy ───────────────────────────────────
        section("2. AUDIT ACCURACY (do per-PA runs sum to final score?)")
        cur.execute("""
            WITH game_audit AS (
                SELECT g.id AS game_id,
                       (g.home_score + g.away_score) AS actual,
                       COALESCE(SUM(ge.runs_on_play), 0) AS derived
                FROM games g
                LEFT JOIN game_events ge ON ge.game_id = g.id
                WHERE g.season = %s
                  AND g.home_score IS NOT NULL
                  AND g.away_score IS NOT NULL
                  AND g.home_score <> g.away_score
                  AND g.id IN (SELECT DISTINCT game_id FROM game_events)
                GROUP BY g.id
            )
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN derived = actual THEN 1 ELSE 0 END) AS perfect,
                SUM(CASE WHEN ABS(actual - derived) = 1 THEN 1 ELSE 0 END) AS off_by_1,
                SUM(CASE WHEN ABS(actual - derived) = 2 THEN 1 ELSE 0 END) AS off_by_2,
                SUM(CASE WHEN ABS(actual - derived) = 3 THEN 1 ELSE 0 END) AS off_by_3,
                SUM(CASE WHEN ABS(actual - derived) BETWEEN 4 AND 6 THEN 1 ELSE 0 END) AS off_by_4_6,
                SUM(CASE WHEN ABS(actual - derived) > 6 THEN 1 ELSE 0 END) AS off_by_7plus
            FROM game_audit
        """, (SEASON,))
        r = cur.fetchone()
        tot = r["total"]
        print(f"  Games audited:           {tot:>5,}")
        print(f"  Audit perfect:           {r['perfect']:>5,}  ({r['perfect']/tot*100:.1f}%)")
        print(f"  Off by 1 run:            {r['off_by_1']:>5,}  ({r['off_by_1']/tot*100:.1f}%)")
        print(f"  Off by 2 runs:           {r['off_by_2']:>5,}  ({r['off_by_2']/tot*100:.1f}%)")
        print(f"  Off by 3 runs:           {r['off_by_3']:>5,}  ({r['off_by_3']/tot*100:.1f}%)")
        print(f"  Off by 4-6 runs:         {r['off_by_4_6']:>5,}  ({r['off_by_4_6']/tot*100:.1f}%)")
        print(f"  Off by 7+ runs:          {r['off_by_7plus']:>5,}  ({r['off_by_7plus']/tot*100:.1f}%)")

        # By source
        cur.execute("""
            WITH game_audit AS (
                SELECT g.id AS game_id, g.home_team_id,
                       (g.home_score + g.away_score) AS actual,
                       COALESCE(SUM(ge.runs_on_play), 0) AS derived
                FROM games g
                LEFT JOIN game_events ge ON ge.game_id = g.id
                WHERE g.season = %s
                  AND g.home_score IS NOT NULL
                  AND g.away_score IS NOT NULL
                  AND g.home_score <> g.away_score
                  AND g.id IN (SELECT DISTINCT game_id FROM game_events)
                GROUP BY g.id
            )
            SELECT
                CASE WHEN d.name = 'NWAC' THEN 'NWAC'
                     ELSE 'NCAA' END AS source,
                COUNT(*) AS total,
                SUM(CASE WHEN ga.derived = ga.actual THEN 1 ELSE 0 END) AS perfect,
                AVG(ABS(ga.actual - ga.derived)) AS avg_gap
            FROM game_audit ga
            JOIN teams t ON t.id = ga.home_team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            GROUP BY source
        """, (SEASON,))
        print(f"\n  By source:")
        print(f"  {'Source':<8} {'Games':>7} {'Perfect':>9} {'%':>6} {'AvgGap':>8}")
        for r in cur.fetchall():
            pct = (r["perfect"] / r["total"] * 100) if r["total"] else 0
            print(f"  {r['source']:<8} {r['total']:>7,} {r['perfect']:>9,} "
                  f"{pct:>5.1f}% {r['avg_gap']:>7.2f}")

        # ── 3. State derivation coverage ─────────────────────────
        section("3. STATE DERIVATION — events with full state populated")
        cur.execute("""
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN bases_before IS NOT NULL AND outs_before IS NOT NULL
                          AND bat_score_before IS NOT NULL AND fld_score_before IS NOT NULL
                         THEN 1 ELSE 0 END) AS full_state,
                SUM(CASE WHEN state_derived_at IS NOT NULL THEN 1 ELSE 0 END) AS state_marked
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s AND ge.result_type = ANY(%s)
        """, (SEASON, list(PA_RESULT_TYPES)))
        r = cur.fetchone()
        tot = r["total"]
        print(f"  Total PA events:                        {tot:>6,}")
        print(f"  Events with full state populated:       {r['full_state']:>6,}  "
              f"({r['full_state']/tot*100:.1f}%)")
        print(f"  Events with state_derived_at set:       {r['state_marked']:>6,}  "
              f"({r['state_marked']/tot*100:.1f}%)")
        print(f"  State-derivation gap:                   {tot - r['full_state']:>6,}")

        # ── 4. Player ID resolution ──────────────────────────────
        section("4. PLAYER ID RESOLUTION (key for per-player stats)")
        cur.execute("""
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN batter_player_id IS NOT NULL THEN 1 ELSE 0 END) AS bat_resolved,
                SUM(CASE WHEN pitcher_player_id IS NOT NULL THEN 1 ELSE 0 END) AS pit_resolved,
                SUM(CASE WHEN batter_player_id IS NOT NULL
                          AND pitcher_player_id IS NOT NULL THEN 1 ELSE 0 END) AS both
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s AND ge.result_type = ANY(%s)
        """, (SEASON, list(PA_RESULT_TYPES)))
        r = cur.fetchone()
        tot = r["total"]
        print(f"  Total PA events:                        {tot:>6,}")
        print(f"  Batter resolved:                        {r['bat_resolved']:>6,}  "
              f"({r['bat_resolved']/tot*100:.1f}%)")
        print(f"  Pitcher resolved:                       {r['pit_resolved']:>6,}  "
              f"({r['pit_resolved']/tot*100:.1f}%)")
        print(f"  Both resolved:                          {r['both']:>6,}  "
              f"({r['both']/tot*100:.1f}%)")

        # OOC pitcher gap — pitchers not in our players table at all.
        # Likely reason for unresolved IDs.
        cur.execute("""
            SELECT COUNT(*) AS unresolved_count,
                   COUNT(DISTINCT pitcher_name) AS distinct_unresolved_names
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s
              AND ge.pitcher_name IS NOT NULL
              AND ge.pitcher_player_id IS NULL
              AND ge.result_type = ANY(%s)
        """, (SEASON, list(PA_RESULT_TYPES)))
        r = cur.fetchone()
        print(f"\n  Unresolved pitcher events:              {r['unresolved_count']:>6,}")
        print(f"  Distinct unresolved pitcher names:      {r['distinct_unresolved_names']:>6,}")

        # Top 10 most-PA unresolved pitchers — these are OOC opponents
        # that show up a lot in our data
        cur.execute("""
            SELECT ge.pitcher_name, COUNT(*) AS n
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s AND ge.pitcher_player_id IS NULL
              AND ge.result_type = ANY(%s)
            GROUP BY ge.pitcher_name
            ORDER BY n DESC LIMIT 10
        """, (SEASON, list(PA_RESULT_TYPES)))
        print(f"\n  Top 10 unresolved pitcher names (OOC opponents):")
        for r in cur.fetchall():
            print(f"    {r['n']:>4}  {r['pitcher_name']}")

        # ── 5. Pitch sequence coverage ──────────────────────────
        section("5. PITCH SEQUENCE COVERAGE (count states + pitch types)")
        cur.execute("""
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN pitches_thrown IS NOT NULL THEN 1 ELSE 0 END) AS tracked,
                SUM(CASE WHEN balls_before IS NOT NULL AND strikes_before IS NOT NULL
                         THEN 1 ELSE 0 END) AS has_count
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s AND ge.result_type = ANY(%s)
        """, (SEASON, list(PA_RESULT_TYPES)))
        r = cur.fetchone()
        tot = r["total"]
        print(f"  Total PA events:                        {tot:>6,}")
        print(f"  Pitch-tracked (pitches_thrown set):     {r['tracked']:>6,}  "
              f"({r['tracked']/tot*100:.1f}%)")
        print(f"  Has count state (balls/strikes set):    {r['has_count']:>6,}  "
              f"({r['has_count']/tot*100:.1f}%)")

        # ── 6. Batted-ball classification ───────────────────────
        section("6. BATTED-BALL CLASSIFICATION (Phase E coverage)")
        BIP_TYPES = ('home_run','triple','double','single','ground_out','fly_out',
                     'line_out','pop_out','sac_fly','sac_bunt','fielders_choice',
                     'error','double_play','triple_play')
        cur.execute("""
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN bb_type IS NOT NULL THEN 1 ELSE 0 END) AS has_type,
                SUM(CASE WHEN field_zone IS NOT NULL THEN 1 ELSE 0 END) AS has_zone
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s AND ge.result_type = ANY(%s)
        """, (SEASON, list(BIP_TYPES)))
        r = cur.fetchone()
        tot = r["total"]
        print(f"  Total ball-in-play events:              {tot:>6,}")
        print(f"  Has bb_type (GB/LD/FB/PU):              {r['has_type']:>6,}  "
              f"({r['has_type']/tot*100:.1f}%)")
        print(f"  Has field_zone (LEFT/CENTER/RIGHT):     {r['has_zone']:>6,}  "
              f"({r['has_zone']/tot*100:.1f}%)")

        # ── 7. Top problem teams (audit failures) ───────────────
        section("7. PER-TEAM AUDIT FAILURES (find systematic issues)")
        cur.execute("""
            WITH game_audit AS (
                SELECT g.id AS game_id, g.home_team_id, g.away_team_id,
                       (g.home_score + g.away_score) AS actual,
                       COALESCE(SUM(ge.runs_on_play), 0) AS derived
                FROM games g
                LEFT JOIN game_events ge ON ge.game_id = g.id
                WHERE g.season = %s AND g.home_score IS NOT NULL
                  AND g.away_score IS NOT NULL AND g.home_score <> g.away_score
                  AND g.id IN (SELECT DISTINCT game_id FROM game_events)
                GROUP BY g.id
            ),
            team_games AS (
                SELECT t.id, t.short_name AS team,
                       COUNT(*) AS games_played,
                       SUM(CASE WHEN ga.derived = ga.actual THEN 1 ELSE 0 END) AS perfect,
                       AVG(ABS(ga.actual - ga.derived)) AS avg_gap
                FROM game_audit ga
                JOIN teams t ON t.id = ga.home_team_id OR t.id = ga.away_team_id
                GROUP BY t.id, t.short_name
                HAVING COUNT(*) >= 10
            )
            SELECT * FROM team_games ORDER BY avg_gap DESC LIMIT 15
        """, (SEASON,))
        print(f"  Top 15 teams by avg audit gap (min 10 games):")
        print(f"  {'Team':<24} {'Games':>6} {'Perfect':>8} {'%':>6} {'AvgGap':>8}")
        for r in cur.fetchall():
            pct = (r["perfect"] / r["games_played"] * 100) if r["games_played"] else 0
            print(f"  {(r['team'] or '?'):<24} {r['games_played']:>6} {r['perfect']:>8} "
                  f"{pct:>5.1f}% {r['avg_gap']:>7.2f}")

        # ── 8. Sub-event row coverage ───────────────────────────
        section("8. SUB-EVENT COVERAGE (steals, WP, PB, balks)")
        cur.execute("""
            SELECT result_type, COUNT(*) AS n
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s
              AND result_type IN ('stolen_base','caught_stealing','wild_pitch',
                                  'passed_ball','balk','pickoff','runner_other')
            GROUP BY result_type ORDER BY n DESC
        """, (SEASON,))
        rows = list(cur.fetchall())
        if rows:
            print(f"  Sub-events recorded:")
            for r in rows:
                print(f"    {r['n']:>5,}  {r['result_type']}")
        else:
            print("  No sub-event rows in 2026.")

        # ── 9. State-derivation skipped games ───────────────────
        section("9. GAMES WITH UNDRIVED STATE (game has events but no state)")
        cur.execute("""
            SELECT COUNT(DISTINCT game_id) AS games
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s
              AND ge.bases_before IS NULL
        """, (SEASON,))
        n_undrived = cur.fetchone()["games"]
        print(f"  Games with at least one undrived event: {n_undrived:>4,}")

        # ── 10. Runner identity coverage ────────────────────────
        section("10. RUNNER IDENTITY (per-runner stats coverage)")
        cur.execute("""
            SELECT
                COUNT(*) AS events_with_runner,
                SUM(CASE WHEN r1_player_id IS NOT NULL THEN 1 ELSE 0 END) AS r1_resolved,
                SUM(CASE WHEN r1_name IS NOT NULL THEN 1 ELSE 0 END) AS r1_named
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s AND ge.bases_before IS NOT NULL
              AND SUBSTRING(ge.bases_before, 1, 1) = '1'
        """, (SEASON,))
        r = cur.fetchone()
        tot = r["events_with_runner"]
        if tot:
            print(f"  Events with runner on 1B:               {tot:>6,}")
            print(f"  Has runner-1 name:                      {r['r1_named']:>6,}  "
                  f"({r['r1_named']/tot*100:.1f}%)")
            print(f"  Has runner-1 player_id (resolved):      {r['r1_resolved']:>6,}  "
                  f"({r['r1_resolved']/tot*100:.1f}%)")

        print()
        print("=" * 70)
        print("  END")
        print("=" * 70)

    return 0


if __name__ == "__main__":
    sys.exit(main())
