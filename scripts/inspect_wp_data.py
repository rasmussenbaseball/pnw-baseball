"""
Phase D.5 — Step 1: Win Probability table inspection.

Read-only diagnostic. Tells us:
  1. How many 2026 game_events have full state populated (the data we
     can actually feed into a WP build).
  2. The split by division group — NCAA (D1/D2/D3/NAIA) vs NWAC. We're
     building two separate WP tables, so we need each side to have
     enough events to fill its buckets.
  3. How many games have a known final score (the dependent variable —
     we can only count "wins" if we know who won).
  4. How dense the buckets get under the proposed coding:
        inning  capped at 10 (9 + extras)
        score   capped at +/- 6
        bases   8 values, outs 3 values, half 2 values
        max buckets = 10 * 2 * 13 * 8 * 3 = 6,240
  5. A spot sanity-check: the "tied, top 1st, bases empty, 0 outs" WP
     should land near 0.50. If it doesn't, we have a wins-attribution
     bug to fix before building.

Run on Mac (uses ~/Desktop/pnw-baseball/.env via DATABASE_URL):
    cd ~/Desktop/pnw-baseball
    PYTHONPATH=backend python3 scripts/inspect_wp_data.py
"""

from __future__ import annotations
import sys
from collections import Counter

from app.models.database import get_connection


SEASON = 2026

# Result types that are PA outcomes (vs sub-events like steals).
# These are the events we attribute to a batter / pitcher and the only
# rows we'll feed into the WP build.
PA_RESULT_TYPES = (
    "home_run", "triple", "double", "single",
    "walk", "intentional_walk", "hbp",
    "strikeout_swinging", "strikeout_looking",
    "ground_out", "fly_out", "line_out", "pop_out",
    "sac_fly", "sac_bunt", "fielders_choice", "error",
    "double_play", "triple_play", "catcher_interference",
)


def _bucket_inning(inn: int) -> int:
    """Cap innings at 10 — anything 10+ shares an 'extras' bucket."""
    return min(int(inn), 10)


def _bucket_score(diff: int) -> int:
    """Cap score margin at +/- 6 — beyond that WP is essentially 0 or 1."""
    if diff > 6:
        return 6
    if diff < -6:
        return -6
    return int(diff)


def main() -> int:
    with get_connection() as conn:
        cur = conn.cursor()

        # 1. Total events + state-populated count
        cur.execute("""
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN bases_before IS NOT NULL
                          AND outs_before IS NOT NULL
                          AND bat_score_before IS NOT NULL
                          AND fld_score_before IS NOT NULL
                          AND inning IS NOT NULL
                          AND half IS NOT NULL
                         THEN 1 ELSE 0 END) AS state_full
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s
              AND ge.result_type = ANY(%s)
        """, (SEASON, list(PA_RESULT_TYPES)))
        r = cur.fetchone()
        total = r["total"]
        state_full = r["state_full"] or 0
        print(f"\n── 2026 PA events ──")
        print(f"  total PA events:      {total:>7,}")
        print(f"  full state populated: {state_full:>7,}  ({state_full/total*100:.1f}%)")

        # 2. By division group (NCAA vs NWAC)
        cur.execute("""
            SELECT
                CASE WHEN d.name = 'NWAC' THEN 'NWAC'
                     ELSE 'NCAA'  -- D1 / D2 / D3 / NAIA
                END AS div_group,
                COUNT(*) AS n
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            JOIN teams t ON t.id = ge.batting_team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE g.season = %s
              AND ge.result_type = ANY(%s)
              AND ge.bases_before IS NOT NULL
              AND ge.outs_before IS NOT NULL
              AND ge.bat_score_before IS NOT NULL
              AND ge.fld_score_before IS NOT NULL
            GROUP BY div_group
            ORDER BY n DESC
        """, (SEASON, list(PA_RESULT_TYPES)))
        print(f"\n── State-populated PA events by division group ──")
        for r in cur.fetchall():
            print(f"  {r['div_group']:>4}: {r['n']:>7,}")

        # 3. Games with a known final score
        cur.execute("""
            SELECT COUNT(*) AS n
            FROM games
            WHERE season = %s
              AND home_score IS NOT NULL
              AND away_score IS NOT NULL
              AND home_score <> away_score   -- ties are ambiguous, exclude
              AND id IN (SELECT DISTINCT game_id FROM game_events)
        """, (SEASON,))
        finished_games = cur.fetchone()["n"]
        print(f"\n── Games with PBP and a decisive final score: {finished_games:,} ──")

        # 4. Bucket density distribution
        cur.execute("""
            SELECT inning, half, bases_before, outs_before,
                   (bat_score_before - fld_score_before) AS score_diff,
                   COUNT(*) AS n
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            JOIN teams t ON t.id = ge.batting_team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE g.season = %s
              AND ge.result_type = ANY(%s)
              AND ge.bases_before IS NOT NULL
              AND ge.outs_before IS NOT NULL
              AND ge.bat_score_before IS NOT NULL
              AND ge.fld_score_before IS NOT NULL
              AND d.name <> 'NWAC'
            GROUP BY inning, half, bases_before, outs_before, score_diff
        """, (SEASON, list(PA_RESULT_TYPES)))
        bucket_counts_ncaa = Counter()
        for r in cur.fetchall():
            key = (
                _bucket_inning(r["inning"]),
                r["half"],
                _bucket_score(r["score_diff"]),
                r["bases_before"],
                r["outs_before"],
            )
            bucket_counts_ncaa[key] += r["n"]

        cur.execute("""
            SELECT inning, half, bases_before, outs_before,
                   (bat_score_before - fld_score_before) AS score_diff,
                   COUNT(*) AS n
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            JOIN teams t ON t.id = ge.batting_team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d ON d.id = c.division_id
            WHERE g.season = %s
              AND ge.result_type = ANY(%s)
              AND ge.bases_before IS NOT NULL
              AND ge.outs_before IS NOT NULL
              AND ge.bat_score_before IS NOT NULL
              AND ge.fld_score_before IS NOT NULL
              AND d.name = 'NWAC'
            GROUP BY inning, half, bases_before, outs_before, score_diff
        """, (SEASON, list(PA_RESULT_TYPES)))
        bucket_counts_nwac = Counter()
        for r in cur.fetchall():
            key = (
                _bucket_inning(r["inning"]),
                r["half"],
                _bucket_score(r["score_diff"]),
                r["bases_before"],
                r["outs_before"],
            )
            bucket_counts_nwac[key] += r["n"]

        for label, bc in (("NCAA", bucket_counts_ncaa), ("NWAC", bucket_counts_nwac)):
            if not bc:
                print(f"\n── {label} bucket density: NO ROWS ──")
                continue
            sizes = sorted(bc.values())
            distinct = len(sizes)
            total_n = sum(sizes)
            p10 = sizes[int(distinct * 0.10)]
            p25 = sizes[int(distinct * 0.25)]
            p50 = sizes[distinct // 2]
            p75 = sizes[int(distinct * 0.75)]
            sparse = sum(1 for s in sizes if s < 10)
            decent = sum(1 for s in sizes if s >= 30)
            print(f"\n── {label} bucket density (capped: inn≤10, |score|≤6) ──")
            print(f"  distinct buckets:       {distinct:,} / 6,240 max")
            print(f"  total events:           {total_n:,}")
            print(f"  bucket size p10/p25/p50/p75: {p10} / {p25} / {p50} / {p75}")
            print(f"  buckets with <10 events: {sparse:,}  ({sparse/distinct*100:.0f}%)")
            print(f"  buckets with ≥30 events: {decent:,}  ({decent/distinct*100:.0f}%)")

        # 5. Spot-check: WP for the canonical "neutral" state should be ~0.50.
        # Top 1st, bases empty, 0 outs, score 0-0 → WP from batter's perspective
        # = P(road team wins). With home-field advantage, it's typically ~0.46.
        cur.execute("""
            SELECT
                COUNT(*) AS n,
                SUM(CASE
                        WHEN g.home_score > g.away_score
                             AND ge.batting_team_id = g.home_team_id THEN 1
                        WHEN g.away_score > g.home_score
                             AND ge.batting_team_id = g.away_team_id THEN 1
                        ELSE 0 END) AS wins
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s
              AND ge.result_type = ANY(%s)
              AND g.home_score IS NOT NULL
              AND g.away_score IS NOT NULL
              AND g.home_score <> g.away_score
              AND ge.inning = 1
              AND ge.half = 'top'
              AND ge.bases_before = '000'
              AND ge.outs_before = 0
              AND ge.bat_score_before = 0
              AND ge.fld_score_before = 0
        """, (SEASON, list(PA_RESULT_TYPES)))
        r = cur.fetchone()
        n = r["n"] or 0
        wins = r["wins"] or 0
        print(f"\n── Sanity: WP at 'top 1, bases empty, 0 outs, 0-0' ──")
        if n > 0:
            print(f"  events: {n:,}   batting-team wins: {wins}")
            print(f"  empirical WP (batting team = road team): {wins/n:.3f}")
            print(f"  (expect ~0.46 — slight road disadvantage from HFA)")
        else:
            print(f"  no events found — investigate")

        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
