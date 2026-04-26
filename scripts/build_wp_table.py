"""
Phase D.5 — Step 2: Build the empirical Win Probability lookup table.

This is the foundation of WPA / Tango LI. For every game state
(division_group, inning, half, score_diff, bases, outs) we compute
   WP = P(batting team wins | this state)
from our 1,000+ games of 2026 PBP, with Beta-binomial smoothing so
sparse buckets don't produce noisy estimates.

Smoothing strategy (hierarchical prior):
  - "supercell"  = (division_group, inning, half, score_diff).
    Supercells are dense (~300 events each), so their raw WP is stable.
  - "fine bucket" = supercell × (bases, outs). Most fine buckets are
    sparse — many have <10 events.
  - For each fine bucket:
        wp = (wins + alpha) / (n + alpha + beta)
    where the prior (alpha + beta) sums to PRIOR_STRENGTH and the prior
    mean is the supercell's empirical WP. Sparse buckets fall back to
    the supercell rate; dense buckets reflect their own data.

This handles:
  - Bases/outs adding marginal info on top of inning + score
  - Top/bottom of inning (last-licks effect)
  - Per-division differences (NWAC plays differently than NAIA)

The output table `wp_lookup` is the source of truth. compute_li and
WPA both query against it.

Run on Mac:
    cd ~/Desktop/pnw-baseball
    PYTHONPATH=backend python3 scripts/build_wp_table.py

Output: writes ~6,000-9,000 rows to wp_lookup. Idempotent — re-running
truncates and rebuilds. Prints a sanity summary at the end.
"""

from __future__ import annotations
import sys
from collections import defaultdict
from typing import Dict, Tuple

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

# Smoothing strength — phantom PAs added to every fine bucket,
# distributed by the supercell's smoothed win rate. 30 means a bucket
# with 30 raw events weighs equally with the prior; sparse buckets lean
# on the prior.
PRIOR_STRENGTH = 30.0

# Meta-smoothing strength — phantom PAs added to every SUPERCELL,
# distributed by the global win rate. Without this, a supercell with
# only 5 events (all losses) would have a raw rate of 0, pulling every
# fine bucket inside it toward 0 → clamped to 0.001 → spurious huge
# WPAs. Meta-smoothing pulls sparse supercells toward the global rate
# so the prior they pass down is realistic.
META_STRENGTH = 30.0

# Fine clamps on the final smoothed WP. Loose enough that no bucket
# can produce a single-PA WPA jump greater than ~0.96. Real-world WP
# at any game state has at least a couple-percent floor — even a 10-run
# deficit in the 9th has happened.
WP_FLOOR = 0.02
WP_CEIL = 0.98

# Capping rules — values past these are flattened into the boundary
# bucket because WP saturates (a 7-run lead in the 9th is functionally
# the same as an 8-run lead).
INNING_CAP = 10        # 10 = "9 + extras"
SCORE_DIFF_CAP = 6     # +6 / -6 = blowout buckets


# ── DDL ─────────────────────────────────────────────────────────────
CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS wp_lookup (
    division_group  TEXT     NOT NULL,    -- 'NCAA' or 'NWAC'
    inning          SMALLINT NOT NULL,    -- 1..10  (10 = extras)
    half            TEXT     NOT NULL,    -- 'top' / 'bottom'
    score_diff      SMALLINT NOT NULL,    -- -6..+6 (batting team's lead)
    bases           TEXT     NOT NULL,    -- '000'..'111'
    outs            SMALLINT NOT NULL,    -- 0..2
    raw_n           INTEGER  NOT NULL,    -- raw event count in this bucket
    raw_wins        INTEGER  NOT NULL,    -- raw batting-team wins
    supercell_wp    DOUBLE PRECISION NOT NULL,  -- prior used (supercell rate)
    wp              DOUBLE PRECISION NOT NULL,  -- smoothed posterior WP
    built_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (division_group, inning, half, score_diff, bases, outs)
);

-- Lookup is single-row PK fetch — no extra index needed beyond the PK.
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

        # ── DDL ────────────────────────────────────────────────────
        print("Creating / checking wp_lookup table...")
        cur.execute(CREATE_TABLE_SQL)

        # ── Pull every state-populated PA event with the game outcome ──
        # Filter:
        #   - season = SEASON
        #   - PA result types only (skip steals/WPs/PBs — those don't
        #     start a PA, the WP question is about PA-level transitions)
        #   - full state populated
        #   - decisive final score (no ties, no NULLs)
        #   - **audit-clean game**: SUM(runs_on_play) over the game
        #     matches the games table's final score. Games that fail
        #     this audit have scorer-omitted runs in their narrative,
        #     which corrupt every event's bat_score_before /
        #     fld_score_before from that point onward (project memory
        #     project_pbp_phase_a.md flagged this — 25% of games are
        #     short 1-3 runs from omissions). Including audit-bad
        #     games systematically biases late-inning WP estimates
        #     (e.g. produces a 'bot 9 home up 1' state that shouldn't
        #     exist). We get clean data by filtering them out.
        #
        # Batting team: derive from `half`, not ge.batting_team_id.
        # Top = away bats, bottom = home bats. Robust to the team-id
        # flip bug (project_home_away_flip_bug.md). Division group is
        # the BATTING team's division, again derived via half.
        print(f"Loading audit-clean 2026 events with game outcome...")
        cur.execute("""
            WITH game_audit AS (
                -- Sum per-game runs_on_play and compare to the final
                -- score in games. audit_ok = derived matches actual.
                SELECT
                    g.id AS game_id,
                    g.home_score, g.away_score,
                    g.home_team_id, g.away_team_id,
                    COALESCE(SUM(ge.runs_on_play), 0) AS derived_total,
                    (g.home_score + g.away_score) AS actual_total
                FROM games g
                LEFT JOIN game_events ge ON ge.game_id = g.id
                WHERE g.season = %s
                  AND g.home_score IS NOT NULL
                  AND g.away_score IS NOT NULL
                  AND g.home_score <> g.away_score
                GROUP BY g.id
            )
            SELECT
                CASE WHEN d.name = 'NWAC' THEN 'NWAC' ELSE 'NCAA' END
                    AS division_group,
                ge.inning,
                ge.half,
                (ge.bat_score_before - ge.fld_score_before) AS score_diff,
                ge.bases_before,
                ge.outs_before,
                CASE
                    WHEN ge.half = 'top'    AND g.away_score > g.home_score THEN 1
                    WHEN ge.half = 'bottom' AND g.home_score > g.away_score THEN 1
                    ELSE 0
                END AS batter_won
            FROM game_events ge
            -- Inner join to game_audit restricts to audit-clean games.
            JOIN game_audit ga ON ga.game_id = ge.game_id
                              AND ga.derived_total = ga.actual_total
            JOIN games g       ON g.id = ge.game_id
            -- batting team is the away team in top of inning, home in bottom.
            -- Join the *correct* team for division grouping, regardless of
            -- whether ge.batting_team_id is set right.
            JOIN teams t       ON t.id = CASE WHEN ge.half = 'top'
                                              THEN g.away_team_id
                                              ELSE g.home_team_id END
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d   ON d.id = c.division_id
            WHERE g.season = %s
              AND ge.result_type = ANY(%s)
              AND ge.bases_before IS NOT NULL
              AND ge.outs_before IS NOT NULL
              AND ge.bat_score_before IS NOT NULL
              AND ge.fld_score_before IS NOT NULL
              AND ge.inning IS NOT NULL
              AND ge.half IN ('top', 'bottom')
              AND g.home_score IS NOT NULL
              AND g.away_score IS NOT NULL
              AND g.home_score <> g.away_score
        """, (SEASON, SEASON, list(PA_RESULT_TYPES)))
        rows = cur.fetchall()
        print(f"  {len(rows):,} events loaded (audit-clean only)")

        # Print audit pass rate for context
        cur.execute("""
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN COALESCE(s.derived_total, 0) = (g.home_score + g.away_score)
                         THEN 1 ELSE 0 END) AS audit_ok
            FROM games g
            LEFT JOIN (
                SELECT game_id, SUM(runs_on_play) AS derived_total
                FROM game_events GROUP BY game_id
            ) s ON s.game_id = g.id
            WHERE g.season = %s
              AND g.home_score IS NOT NULL
              AND g.away_score IS NOT NULL
              AND g.home_score <> g.away_score
              AND g.id IN (SELECT DISTINCT game_id FROM game_events)
        """, (SEASON,))
        ar = cur.fetchone()
        print(f"  audit-pass rate: {ar['audit_ok']:,}/{ar['total']:,} games "
              f"({ar['audit_ok']/ar['total']*100:.1f}%)")

        # ── Diagnostic 1: does the home team win at the expected
        # ~54-57% rate? If it's near 50% or below, the home/away labels
        # in the games table are systematically swapped on many games.
        cur.execute("""
            SELECT
                COUNT(*) AS n,
                SUM(CASE WHEN home_score > away_score THEN 1 ELSE 0 END) AS home_wins,
                SUM(CASE WHEN away_score > home_score THEN 1 ELSE 0 END) AS away_wins
            FROM games
            WHERE season = %s
              AND home_score IS NOT NULL
              AND away_score IS NOT NULL
              AND home_score <> away_score
              AND id IN (SELECT DISTINCT game_id FROM game_events)
        """, (SEASON,))
        gd = cur.fetchone()
        print(f"  game-level diag: home wins {gd['home_wins']:,}/{gd['n']:,} "
              f"({gd['home_wins']/gd['n']*100:.1f}%)  -- expect 54-57%")

        # ── Diagnostic 2: supercell sample sizes for our 6 sanity states.
        # If a supercell has <50 events, the rate is noisy.
        canon = [
            ('NCAA', 1, 'top',    0,  'Top 1 leadoff,    score 0'),
            ('NCAA', 9, 'bottom', 0,  'Bot 9 tied,       score 0'),
            ('NCAA', 9, 'bottom', 1,  'Bot 9 home up 1,  score +1'),
            ('NCAA', 9, 'bottom', -1, 'Bot 9 home down 1, score -1'),
            ('NCAA', 9, 'top',    5,  'Top 9 away up 5,  score +5'),
        ]
        print("  supercell event counts (NCAA):")
        for div, inn, half, sd, label in canon:
            cur.execute("""
                SELECT COUNT(*) AS n,
                       SUM(CASE
                               WHEN ge.half='top'    AND g.away_score > g.home_score THEN 1
                               WHEN ge.half='bottom' AND g.home_score > g.away_score THEN 1
                               ELSE 0 END) AS w
                FROM game_events ge
                JOIN games g       ON g.id = ge.game_id
                JOIN teams t       ON t.id = CASE WHEN ge.half='top' THEN g.away_team_id
                                                  ELSE g.home_team_id END
                JOIN conferences c ON c.id = t.conference_id
                JOIN divisions d   ON d.id = c.division_id
                WHERE g.season = %s
                  AND ge.result_type = ANY(%s)
                  AND ge.bases_before IS NOT NULL
                  AND ge.outs_before IS NOT NULL
                  AND ge.bat_score_before IS NOT NULL
                  AND ge.fld_score_before IS NOT NULL
                  AND ge.inning = %s
                  AND ge.half = %s
                  AND (ge.bat_score_before - ge.fld_score_before) = %s
                  AND CASE WHEN d.name='NWAC' THEN 'NWAC' ELSE 'NCAA' END = %s
                  AND g.home_score IS NOT NULL
                  AND g.away_score IS NOT NULL
                  AND g.home_score <> g.away_score
            """, (SEASON, list(PA_RESULT_TYPES), inn, half, sd, div))
            r = cur.fetchone()
            n = r["n"] or 0
            w = r["w"] or 0
            wp = (w / n) if n else 0
            print(f"    {label:<35}  n={n:>5,}  w={w:>4}  raw_wp={wp:.3f}")

        # ── Diagnostic 3: how often does ge.batting_team_id disagree
        # with the half-derived batter? Confirms we're right to derive
        # from half rather than trust the column.
        cur.execute("""
            SELECT
                SUM(CASE
                        WHEN (ge.half='top'    AND ge.batting_team_id = g.away_team_id)
                          OR (ge.half='bottom' AND ge.batting_team_id = g.home_team_id)
                        THEN 1 ELSE 0 END) AS agree,
                SUM(CASE
                        WHEN (ge.half='top'    AND ge.batting_team_id = g.home_team_id)
                          OR (ge.half='bottom' AND ge.batting_team_id = g.away_team_id)
                        THEN 1 ELSE 0 END) AS disagree,
                COUNT(*) AS total
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s
              AND ge.result_type = ANY(%s)
              AND ge.half IN ('top','bottom')
              AND ge.batting_team_id IS NOT NULL
        """, (SEASON, list(PA_RESULT_TYPES)))
        d = cur.fetchone()
        if d and d["total"]:
            tot = d["total"]
            agree = d["agree"] or 0
            disagree = d["disagree"] or 0
            print(f"  team_id flip diagnostic: "
                  f"{disagree:,}/{tot:,} events ({disagree/tot*100:.1f}%) "
                  f"have batting_team_id disagreeing with half")

        # ── Aggregate ──────────────────────────────────────────────
        # fine_n[key]  = total events  ; fine_w[key] = batting-team wins
        # super_n      = same, but keyed at the supercell granularity
        FineKey = Tuple[str, int, str, int, str, int]   # (div, inn, half, sd, bases, outs)
        SuperKey = Tuple[str, int, str, int]            # (div, inn, half, sd)

        fine_n:  Dict[FineKey, int]  = defaultdict(int)
        fine_w:  Dict[FineKey, int]  = defaultdict(int)
        super_n: Dict[SuperKey, int] = defaultdict(int)
        super_w: Dict[SuperKey, int] = defaultdict(int)

        for r in rows:
            inn = _bucket_inning(r["inning"])
            sd  = _bucket_score(r["score_diff"])
            div = r["division_group"]
            half = r["half"]
            bases = r["bases_before"]
            outs = int(r["outs_before"])
            won = int(r["batter_won"])

            fk: FineKey = (div, inn, half, sd, bases, outs)
            sk: SuperKey = (div, inn, half, sd)

            fine_n[fk] += 1
            fine_w[fk] += won
            super_n[sk] += 1
            super_w[sk] += won

        print(f"  {len(fine_n):,} distinct fine buckets")
        print(f"  {len(super_n):,} distinct supercells")

        # ── Compute smoothed WP ────────────────────────────────────
        # Two-tier smoothing: supercells shrink toward the global rate,
        # then fine buckets shrink toward their (smoothed) supercell.
        # Without supercell smoothing, sparse supercells pin extreme
        # rates and every fine bucket inside them inherits them.
        global_w = sum(super_w.values())
        global_n = sum(super_n.values()) or 1
        global_wp = global_w / global_n
        print(f"  global batting-team WP: {global_wp:.3f}")
        print(f"  smoothing: PRIOR_STRENGTH={PRIOR_STRENGTH}, "
              f"META_STRENGTH={META_STRENGTH}, "
              f"clamps=[{WP_FLOOR}, {WP_CEIL}]")

        # First tier: smooth each supercell toward global_wp
        meta_alpha = META_STRENGTH * global_wp
        meta_beta = META_STRENGTH * (1 - global_wp)
        super_smoothed: Dict[SuperKey, float] = {}
        for sk, sn in super_n.items():
            sw = super_w[sk]
            super_smoothed[sk] = (sw + meta_alpha) / (sn + meta_alpha + meta_beta)

        # Second tier: each fine bucket shrinks toward its (smoothed)
        # supercell. Supercells we haven't seen at all fall back to
        # global_wp.
        out_rows = []
        for fk, n in fine_n.items():
            div, inn, half, sd, bases, outs = fk
            w = fine_w[fk]
            sk: SuperKey = (div, inn, half, sd)
            supercell_wp = super_smoothed.get(sk, global_wp)

            alpha = PRIOR_STRENGTH * supercell_wp
            beta  = PRIOR_STRENGTH * (1 - supercell_wp)
            wp = (w + alpha) / (n + alpha + beta)
            # Loose clamp — even a 10-run deficit has a non-zero WP
            wp = max(WP_FLOOR, min(wp, WP_CEIL))

            out_rows.append((
                div, inn, half, sd, bases, outs,
                n, w, supercell_wp, wp,
            ))

        # ── Write ──────────────────────────────────────────────────
        print(f"  writing {len(out_rows):,} rows to wp_lookup...")
        cur.execute("TRUNCATE wp_lookup")
        cur.executemany("""
            INSERT INTO wp_lookup
                (division_group, inning, half, score_diff, bases, outs,
                 raw_n, raw_wins, supercell_wp, wp)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, out_rows)
        print(f"  done.")

        # ── Sanity prints ──────────────────────────────────────────
        print("\n── Sanity: WP at canonical states (NCAA) ──")
        spots = [
            ("Top 1, 0-0, 000, 0 outs (neutral start)",
             ('NCAA', 1, 'top', 0, '000', 0)),
            ("Bot 9, 0-0, 000, 0 outs (last licks tied)",
             ('NCAA', 9, 'bottom', 0, '000', 0)),
            ("Bot 9, +1 lead, 000, 2 outs (closer's dream)",
             ('NCAA', 9, 'bottom', 1, '000', 2)),
            ("Bot 9, -1 down, 011, 0 outs (rally start)",
             ('NCAA', 9, 'bottom', -1, '011', 0)),
            ("Bot 9, 0-0, 111, 2 outs (peak leverage)",
             ('NCAA', 9, 'bottom', 0, '111', 2)),
            ("Top 9, +5 lead, 000, 1 out (mop-up)",
             ('NCAA', 9, 'top', 5, '000', 1)),
        ]
        for label, key in spots:
            cur.execute("""
                SELECT raw_n, raw_wins, supercell_wp, wp
                FROM wp_lookup
                WHERE division_group=%s AND inning=%s AND half=%s
                  AND score_diff=%s AND bases=%s AND outs=%s
            """, key)
            r = cur.fetchone()
            if r:
                print(f"  {label}")
                print(f"    raw {r['raw_wins']:>3}/{r['raw_n']:>3}   "
                      f"supercell {r['supercell_wp']:.3f}   wp {r['wp']:.3f}")
            else:
                print(f"  {label}  — NO BUCKET (no events landed here)")

        # Coverage summary
        cur.execute("""
            SELECT division_group, COUNT(*) AS n
            FROM wp_lookup GROUP BY division_group ORDER BY 1
        """)
        print("\n── wp_lookup coverage ──")
        for r in cur.fetchall():
            print(f"  {r['division_group']}: {r['n']:,} buckets")

    return 0


if __name__ == "__main__":
    sys.exit(main())
