"""
Phase D.5 — Step 5: Build the empirical Tango Leverage Index table.

Definition (Tom Tango): LI for state S is the AVERAGE ABSOLUTE WIN
PROBABILITY SWING that PAs in state S produce, normalized so the league
mean = 1.0.

In equation form, for each state bucket (division_group, inning, half,
score_diff, bases, outs):
    LI = mean(|wpa_batter|) in this state / mean(|wpa_batter|) over all states

This replaces the parametric `compute_li` in backend/app/api/leverage.py.
The parametric version was directionally correct but tuned by hand;
the empirical version is fit to actual 2026 PBP data.

Smoothing: same two-tier approach as build_wp_table.py — sparse fine
buckets shrink toward their supercell's mean |WPA|, supercells shrink
toward the global mean |WPA|. Without this, a state bucket with 2
events that happened to be 0.45-WPA walk-offs would post LI = 12+,
which is nonsense.

Run on Mac OR server:
    cd ~/Desktop/pnw-baseball   (or /opt/pnw-baseball on the server)
    PYTHONPATH=backend python3 scripts/build_li_table.py

Input: game_events.wpa_batter (must already be populated by compute_wpa.py).
Output: li_lookup table (truncated and rebuilt each run; idempotent).
"""

from __future__ import annotations
import sys
from collections import defaultdict
from typing import Dict, Tuple

from app.models.database import get_connection


SEASON = 2026

# Same bucket caps as wp_lookup — the lookups have to agree
INNING_CAP = 10
SCORE_DIFF_CAP = 6

# Smoothing strengths (units = phantom PAs):
#   PRIOR_STRENGTH adds phantom PAs at the supercell's mean to each
#       fine bucket. Sparse buckets get pulled toward supercell.
#   META_STRENGTH adds phantom PAs at the global mean to each
#       supercell. Sparse supercells get pulled toward overall.
PRIOR_STRENGTH = 30.0
META_STRENGTH = 30.0

# Bound LI values — a single PA can't produce LI=20 in any realistic
# college baseball state. The MLB Tango table caps near 10. We use 8.
LI_FLOOR = 0.05
LI_CEIL = 8.0


CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS li_lookup (
    division_group  TEXT     NOT NULL,    -- 'NCAA' or 'NWAC'
    inning          SMALLINT NOT NULL,    -- 1..10  (10 = extras)
    half            TEXT     NOT NULL,    -- 'top' / 'bottom'
    score_diff      SMALLINT NOT NULL,    -- -6..+6 (batting team's lead)
    bases           TEXT     NOT NULL,    -- '000'..'111'
    outs            SMALLINT NOT NULL,    -- 0..2
    raw_n           INTEGER  NOT NULL,    -- raw event count in bucket
    raw_mean_abs    DOUBLE PRECISION NOT NULL,  -- raw mean |wpa| in bucket
    supercell_mean  DOUBLE PRECISION NOT NULL,  -- smoothed prior used
    li              DOUBLE PRECISION NOT NULL,  -- smoothed LI
    built_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (division_group, inning, half, score_diff, bases, outs)
);
"""


def _bucket_inning(inn: int) -> int:
    return min(int(inn), INNING_CAP)


def _bucket_score(diff: int) -> int:
    if diff > SCORE_DIFF_CAP:
        return SCORE_DIFF_CAP
    if diff < -SCORE_DIFF_CAP:
        return -SCORE_DIFF_CAP
    return int(diff)


def main() -> int:
    with get_connection() as conn:
        cur = conn.cursor()

        print("Creating / checking li_lookup table...")
        cur.execute(CREATE_TABLE_SQL)

        # Pull every event with WPA + state populated, with division
        # group derived from the half-inning (top → away, bottom → home).
        # We do NOT filter to audit-clean games here — for LI, individual
        # PA noise averages out within each bucket, and we want as much
        # data as possible filling out sparse extreme states.
        print("Loading 2026 events with WPA + state populated...")
        cur.execute("""
            SELECT
                CASE WHEN d.name = 'NWAC' THEN 'NWAC' ELSE 'NCAA' END
                    AS division_group,
                ge.inning,
                ge.half,
                (ge.bat_score_before - ge.fld_score_before) AS score_diff,
                ge.bases_before,
                ge.outs_before,
                ABS(ge.wpa_batter) AS abs_wpa
            FROM game_events ge
            JOIN games g       ON g.id = ge.game_id
            JOIN teams t       ON t.id = CASE WHEN ge.half = 'top'
                                              THEN g.away_team_id
                                              ELSE g.home_team_id END
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d   ON d.id = c.division_id
            WHERE g.season = %s
              AND ge.wpa_batter IS NOT NULL
              AND ge.bases_before IS NOT NULL
              AND ge.outs_before IS NOT NULL
              AND ge.bat_score_before IS NOT NULL
              AND ge.fld_score_before IS NOT NULL
              AND ge.inning IS NOT NULL
              AND ge.half IN ('top', 'bottom')
        """, (SEASON,))
        rows = cur.fetchall()
        print(f"  {len(rows):,} events loaded")

        # Aggregate sums + counts at fine + supercell + global granularity
        FineKey = Tuple[str, int, str, int, str, int]
        SuperKey = Tuple[str, int, str, int]

        fine_n: Dict[FineKey, int] = defaultdict(int)
        fine_sum: Dict[FineKey, float] = defaultdict(float)
        super_n: Dict[SuperKey, int] = defaultdict(int)
        super_sum: Dict[SuperKey, float] = defaultdict(float)

        global_n = 0
        global_sum = 0.0

        for r in rows:
            inn = _bucket_inning(r["inning"])
            sd = _bucket_score(r["score_diff"])
            div = r["division_group"]
            half = r["half"]
            bases = r["bases_before"]
            outs = int(r["outs_before"])
            abs_wpa = float(r["abs_wpa"])

            fk: FineKey = (div, inn, half, sd, bases, outs)
            sk: SuperKey = (div, inn, half, sd)

            fine_n[fk] += 1
            fine_sum[fk] += abs_wpa
            super_n[sk] += 1
            super_sum[sk] += abs_wpa
            global_n += 1
            global_sum += abs_wpa

        print(f"  {len(fine_n):,} distinct fine buckets")
        print(f"  {len(super_n):,} distinct supercells")
        global_mean = (global_sum / global_n) if global_n else 0.0
        print(f"  global mean |WPA|: {global_mean:.4f}")

        # First tier: smooth each supercell's mean toward the global mean
        super_smoothed: Dict[SuperKey, float] = {}
        for sk, sn in super_n.items():
            ss = super_sum[sk]
            super_smoothed[sk] = (
                (ss + META_STRENGTH * global_mean)
                / (sn + META_STRENGTH)
            )

        # Second tier: smooth each fine bucket's mean toward its supercell
        out_rows = []
        for fk, n in fine_n.items():
            div, inn, half, sd, bases, outs = fk
            s = fine_sum[fk]
            sk: SuperKey = (div, inn, half, sd)
            supercell_mean = super_smoothed.get(sk, global_mean)

            smoothed_mean = (
                (s + PRIOR_STRENGTH * supercell_mean)
                / (n + PRIOR_STRENGTH)
            )
            li = (smoothed_mean / global_mean) if global_mean > 0 else 1.0
            li = max(LI_FLOOR, min(li, LI_CEIL))

            raw_mean = s / n if n else 0.0
            out_rows.append((
                div, inn, half, sd, bases, outs,
                n, raw_mean, supercell_mean, li,
            ))

        # Write
        print(f"  writing {len(out_rows):,} rows to li_lookup...")
        cur.execute("TRUNCATE li_lookup")
        cur.executemany("""
            INSERT INTO li_lookup
                (division_group, inning, half, score_diff, bases, outs,
                 raw_n, raw_mean_abs, supercell_mean, li)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, out_rows)
        print("  done.")

        # Sanity: print LI for the same canonical states we used in
        # build_wp_table — these should match baseball intuition.
        print("\n── Sanity: LI at canonical states (NCAA) ──")
        spots = [
            ("Top 1, 0-0, 000, 0 outs (neutral start)",
             ('NCAA', 1, 'top', 0, '000', 0)),
            ("Bot 9, 0-0, 000, 0 outs (last licks tied)",
             ('NCAA', 9, 'bottom', 0, '000', 0)),
            ("Bot 9, 0-0, 011, 1 out (RISP late tied)",
             ('NCAA', 9, 'bottom', 0, '011', 1)),
            ("Bot 9, 0-0, 111, 2 outs (peak leverage)",
             ('NCAA', 9, 'bottom', 0, '111', 2)),
            ("Top 9, +5 lead, 000, 1 out (mop-up)",
             ('NCAA', 9, 'top', 5, '000', 1)),
            ("Top 1, 0-0, 000, 2 outs (low leverage)",
             ('NCAA', 1, 'top', 0, '000', 2)),
        ]
        for label, key in spots:
            cur.execute("""
                SELECT raw_n, raw_mean_abs, supercell_mean, li
                FROM li_lookup
                WHERE division_group=%s AND inning=%s AND half=%s
                  AND score_diff=%s AND bases=%s AND outs=%s
            """, key)
            r = cur.fetchone()
            if r:
                print(f"  {label}")
                print(f"    n={r['raw_n']:>4}  raw|WPA|={r['raw_mean_abs']:.4f}  "
                      f"super={r['supercell_mean']:.4f}  LI={r['li']:.2f}")
            else:
                print(f"  {label}  — NO BUCKET")

        cur.execute("""
            SELECT division_group, COUNT(*) AS n,
                   AVG(li) AS mean_li,
                   MIN(li) AS min_li, MAX(li) AS max_li
            FROM li_lookup GROUP BY division_group ORDER BY 1
        """)
        print("\n── li_lookup coverage ──")
        for r in cur.fetchall():
            print(f"  {r['division_group']}: {r['n']:,} buckets  "
                  f"mean LI={r['mean_li']:.2f}  range=[{r['min_li']:.2f}, {r['max_li']:.2f}]")

    return 0


if __name__ == "__main__":
    sys.exit(main())
