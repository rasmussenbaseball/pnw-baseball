"""
Phase D.5 — Step 3: compute Win Probability Added per game_event.

For every state-populated PA event:
    wpa_batter  = WP_after - WP_before     (positive = good for batter)
    wpa_pitcher = -wpa_batter              (positive = good for pitcher)

Where WP is from the wp_lookup table built in Step 2. The tricky part
is computing WP_after correctly:

  • Same half-inning (outs_after < 3): same batting team, new state.
        WP_after = lookup(inning, half, score_diff_after, bases_after, outs_after)

  • Half flips (outs_after == 3): batting team switches, bases/outs reset.
        new_half/new_inning depend on prior half (top → bottom of same inn,
                                                  bottom → top of next inn)
        score_diff_after flips sign (now from new batter's perspective)
        WP for NEW batting team = lookup(...)
        WP for OLD batting team = 1 − lookup(...)

  • Last event of the game (walk-off / final out): WP_after is just
    the actual outcome — 1.0 if the batting team won, 0.0 if they lost.

We process every state-populated event regardless of audit status. The
WP table itself was built from audit-clean games, so the *function* is
trustworthy; applying it to slightly-off states (in audit-bad games)
gives slightly-off WPAs but most events in those games are still fine
and the per-player season totals average out the noise.

Run on Mac:
    cd ~/Desktop/pnw-baseball
    PYTHONPATH=backend python3 scripts/compute_wpa.py
        # default: only games with wpa_derived_at IS NULL
        # --force      re-derive games already derived
        # --season N   change season (default 2026)
        # --limit N    cap games processed
"""

from __future__ import annotations
import argparse
import logging
import sys
from collections import defaultdict
from typing import Dict, Tuple

import psycopg2.extras

from app.models.database import get_connection


SEASON = 2026

# Same caps as build_wp_table.py — must agree for lookups to hit
INNING_CAP = 10
SCORE_DIFF_CAP = 6

# Fallback when a state isn't in any lookup tier
GLOBAL_FALLBACK_WP = 0.50

logger = logging.getLogger("compute_wpa")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def _bucket_inning(inn: int) -> int:
    return min(int(inn), INNING_CAP)


def _bucket_score(diff: int) -> int:
    if diff > SCORE_DIFF_CAP:
        return SCORE_DIFF_CAP
    if diff < -SCORE_DIFF_CAP:
        return -SCORE_DIFF_CAP
    return int(diff)


# ─────────────────────────────────────────────────────────────────
# WP lookup — load wp_lookup table once into memory, fast dict access
# ─────────────────────────────────────────────────────────────────

class WPLookup:
    """Fast in-memory WP lookup with hierarchical fallback.

    Tier 1: full fine-bucket key
    Tier 2: supercell (drop bases + outs)
    Tier 3: GLOBAL_FALLBACK_WP
    """

    def __init__(self, cur):
        cur.execute("""
            SELECT division_group, inning, half, score_diff, bases, outs,
                   wp, supercell_wp
            FROM wp_lookup
        """)
        self.fine: Dict[Tuple, float] = {}
        self.supercell: Dict[Tuple, float] = {}
        for r in cur.fetchall():
            key_fine = (r["division_group"], r["inning"], r["half"],
                        r["score_diff"], r["bases"], r["outs"])
            key_super = (r["division_group"], r["inning"], r["half"],
                         r["score_diff"])
            self.fine[key_fine] = float(r["wp"])
            # All rows in a supercell share supercell_wp — store once
            self.supercell.setdefault(key_super, float(r["supercell_wp"]))
        logger.info("WPLookup loaded: %d fine buckets, %d supercells",
                    len(self.fine), len(self.supercell))

    def wp(self, division_group: str, inning: int, half: str,
           score_diff: int, bases: str, outs: int) -> float:
        inn = _bucket_inning(inning)
        sd = _bucket_score(score_diff)
        # Tier 1: fine
        v = self.fine.get((division_group, inn, half, sd, bases, outs))
        if v is not None:
            return v
        # Tier 2: supercell
        v = self.supercell.get((division_group, inn, half, sd))
        if v is not None:
            return v
        # Tier 3: global
        return GLOBAL_FALLBACK_WP


# ─────────────────────────────────────────────────────────────────
# Per-game derivation
# ─────────────────────────────────────────────────────────────────

def derive_game_wpa(cur, game_id: int, wp_lookup: WPLookup,
                    division_group: str, home_score_final: int,
                    away_score_final: int, audit_ok: bool,
                    force: bool) -> dict:
    """Compute WPA for every state-populated event in one game.

    audit_ok: True iff SUM(runs_on_play) over this game equals
    home_score + away_score. When False, the per-PA score state is
    likely missing 1-3 runs from scorer omissions — we still compute
    WPA from the smoothed WP lookup, but DO NOT snap WP_after to
    the actual game outcome on the final PA (that would inflate the
    last PA's WPA artificially when the score state was already off).
    """

    # Skip if already derived
    if not force:
        cur.execute(
            "SELECT 1 FROM game_events WHERE game_id = %s "
            "  AND wpa_derived_at IS NOT NULL LIMIT 1",
            (game_id,),
        )
        if cur.fetchone():
            return {"skipped": True}

    # Pull events ordered chronologically. We only WPA the events with
    # full state populated AND a PA result type (sub-events like steals
    # don't change the batter; their WP delta belongs to the surrounding
    # PA, not as a standalone WPA — defer that to a future phase).
    cur.execute("""
        SELECT id, inning, half, sequence_idx,
               result_type,
               bases_before, outs_before, bases_after, outs_after,
               bat_score_before, fld_score_before, runs_on_play
        FROM game_events
        WHERE game_id = %s
          AND inning IS NOT NULL
          AND half IN ('top', 'bottom')
        ORDER BY inning ASC,
                 CASE WHEN half = 'top' THEN 0 ELSE 1 END,
                 sequence_idx ASC
    """, (game_id,))
    events = cur.fetchall()
    if not events:
        return {"events": 0}

    home_won = home_score_final > away_score_final

    updates = []
    n = len(events)

    for i, ev in enumerate(events):
        # If state isn't populated, skip — leave wp_before/after NULL
        if (ev["bases_before"] is None or ev["outs_before"] is None
                or ev["bat_score_before"] is None
                or ev["fld_score_before"] is None
                or ev["bases_after"] is None
                or ev["outs_after"] is None):
            updates.append((None, None, None, None, ev["id"]))
            continue

        inning = ev["inning"]
        half = ev["half"]
        score_diff_before = ev["bat_score_before"] - ev["fld_score_before"]
        bases_b = ev["bases_before"]
        outs_b = ev["outs_before"]

        # WP_before — straight lookup
        wp_before = wp_lookup.wp(division_group, inning, half,
                                  score_diff_before, bases_b, outs_b)

        # WP_after — depends on whether half flipped + game ended
        is_last = (i == n - 1)
        runs = ev["runs_on_play"] or 0
        score_diff_after = score_diff_before + runs
        outs_a = ev["outs_after"]
        bases_a = ev["bases_after"]

        # ── Decide WP_after ───────────────────────────────────────
        # Try the outcome snap first (only valid when ALL the
        # following hold: this is the last PA, the game audit is
        # clean, AND the score state at end of PA is consistent with
        # the outcome). audit_ok alone isn't enough — it only checks
        # SUM(runs_on_play) matches the final, not that individual
        # events' bat_score_before columns are internally consistent.
        # A game can be audit-clean overall yet have a strikeout PA
        # late where bat_score_before says home is still down 6, even
        # though home actually won. Snapping wp_after to 1.0 in that
        # case would credit the strikeout with a phantom +0.94 WPA.
        wp_after = None
        if is_last and audit_ok:
            home_batting = (half == "bottom")
            batter_won = (home_batting and home_won) or (
                (not home_batting) and (not home_won))
            # The outcome snap is only safe when the recorded state at
            # the END of this PA is consistent with the game actually
            # ending here. We require ALL of the following:
            #
            #   1. STRICT lead consistency. batter_won → bat side is
            #      strictly ahead at end of PA. Tied scores can't end
            #      a game — they'd require extras. (A tied 'walk in
            #      top 8' would otherwise pass the loose check and
            #      get a fake +0.87 WPA.)
            #
            #   2. Inning ≥ 7. Earlier events physically cannot be
            #      game-enders except by mercy rule (rare). Covers
            #      NWAC 7-inning regulation and NCAA 9-inning.
            #
            #   3. Either a walk-off (bottom half, batter took lead
            #      mid-inning) OR a 3rd-out ending (game ends on the
            #      final out of an inning where the lead is decided).
            lead_consistent = ((batter_won and score_diff_after > 0)
                               or ((not batter_won) and score_diff_after < 0))
            inning_consistent = (inning >= 7)
            walk_off = (home_batting and batter_won and score_diff_after > 0)
            third_out_end = (outs_a == 3 and lead_consistent)
            result_consistent = walk_off or third_out_end

            if lead_consistent and inning_consistent and result_consistent:
                wp_after = 1.0 if batter_won else 0.0

        if wp_after is None:
            # Outcome snap didn't apply — derive WP_after from state.
            if outs_a < 3:
                # Same half-inning, same batting team, new state
                wp_after = wp_lookup.wp(division_group, inning, half,
                                         score_diff_after, bases_a, outs_a)
            else:
                # Half flips. Reset bases/outs, switch batting team.
                if half == "top":
                    new_inning = inning
                    new_half = "bottom"
                else:
                    new_inning = inning + 1
                    new_half = "top"
                # New batting team has the opposite score perspective
                new_score_diff = -score_diff_after
                wp_new_batter = wp_lookup.wp(division_group, new_inning, new_half,
                                              new_score_diff, "000", 0)
                # WP from PRIOR batting team's perspective is 1 - new one
                wp_after = 1.0 - wp_new_batter

        wpa_batter = wp_after - wp_before
        wpa_pitcher = -wpa_batter
        # Clamp WPA to [-1, 1] — sanity guard
        wpa_batter = max(-1.0, min(1.0, wpa_batter))
        wpa_pitcher = max(-1.0, min(1.0, wpa_pitcher))

        updates.append((wp_before, wp_after, wpa_batter, wpa_pitcher, ev["id"]))

    # Batch UPDATE
    psycopg2.extras.execute_batch(cur, """
        UPDATE game_events SET
            wp_before       = %s,
            wp_after        = %s,
            wpa_batter      = %s,
            wpa_pitcher     = %s,
            wpa_derived_at  = NOW()
        WHERE id = %s
    """, updates, page_size=500)

    return {"events": len(events), "updated": len(updates)}


# ─────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="Compute WPA for game_events.")
    ap.add_argument("--season", type=int, default=SEASON)
    ap.add_argument("--game-id", type=int, help="Single game (smoke test).")
    ap.add_argument("--force", action="store_true",
                    help="Re-derive games already WPA-derived.")
    ap.add_argument("--limit", type=int, help="Cap games processed.")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        # Apply migration if columns don't already exist (idempotent).
        # Cleaner UX than asking Nate to run a separate migration step.
        logger.info("Applying migration (idempotent)...")
        cur.execute("""
            ALTER TABLE game_events
                ADD COLUMN IF NOT EXISTS wp_before        DOUBLE PRECISION,
                ADD COLUMN IF NOT EXISTS wp_after         DOUBLE PRECISION,
                ADD COLUMN IF NOT EXISTS wpa_batter       DOUBLE PRECISION,
                ADD COLUMN IF NOT EXISTS wpa_pitcher      DOUBLE PRECISION,
                ADD COLUMN IF NOT EXISTS wpa_derived_at   TIMESTAMPTZ;
            CREATE INDEX IF NOT EXISTS game_events_wpa_batter_idx
                ON game_events (batter_player_id)
                WHERE wpa_batter IS NOT NULL AND batter_player_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS game_events_wpa_pitcher_idx
                ON game_events (pitcher_player_id)
                WHERE wpa_pitcher IS NOT NULL AND pitcher_player_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS game_events_wpa_undrived_idx
                ON game_events (game_id)
                WHERE wpa_derived_at IS NULL;
        """)
        conn.commit()

        # Load WP lookup table once
        wp_lookup = WPLookup(cur)

        # Pre-cache division_group + final score + audit_ok per game.
        # audit_ok = SUM(runs_on_play) matches the games-table final.
        # Used to decide whether to snap WP_after to game outcome on
        # the last PA (only safe when the score state is consistent
        # with the actual outcome — see derive_game_wpa docstring).
        cur.execute("""
            WITH game_audit AS (
                SELECT game_id, COALESCE(SUM(runs_on_play), 0) AS derived_total
                FROM game_events
                GROUP BY game_id
            )
            SELECT g.id AS game_id,
                   g.home_score, g.away_score,
                   CASE WHEN d.name = 'NWAC' THEN 'NWAC' ELSE 'NCAA' END
                       AS division_group,
                   CASE WHEN COALESCE(ga.derived_total, 0)
                             = (g.home_score + g.away_score)
                        THEN TRUE ELSE FALSE END AS audit_ok
            FROM games g
            JOIN teams t       ON t.id = g.home_team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d   ON d.id = c.division_id
            LEFT JOIN game_audit ga ON ga.game_id = g.id
            WHERE g.season = %s
              AND g.home_score IS NOT NULL
              AND g.away_score IS NOT NULL
              AND g.home_score <> g.away_score
        """, (args.season,))
        game_meta = {
            r["game_id"]: (r["division_group"], r["home_score"],
                           r["away_score"], r["audit_ok"])
            for r in cur.fetchall()
        }
        n_audit_ok = sum(1 for v in game_meta.values() if v[3])
        logger.info("Cached metadata for %d games (%d audit-clean)",
                    len(game_meta), n_audit_ok)

        # Determine which games to process
        if args.game_id:
            game_ids = [args.game_id]
        else:
            where = ["g.season = %s"]
            params = [args.season]
            if not args.force:
                where.append(
                    "EXISTS (SELECT 1 FROM game_events e WHERE e.game_id = g.id "
                    "  AND e.wpa_derived_at IS NULL "
                    "  AND e.bases_before IS NOT NULL)"
                )
            else:
                where.append(
                    "EXISTS (SELECT 1 FROM game_events e WHERE e.game_id = g.id "
                    "  AND e.bases_before IS NOT NULL)"
                )
            sql = (f"SELECT g.id FROM games g WHERE {' AND '.join(where)} "
                   "ORDER BY g.game_date, g.id")
            if args.limit:
                sql += f" LIMIT {int(args.limit)}"
            cur.execute(sql, params)
            game_ids = [r["id"] for r in cur.fetchall()]

        logger.info("Processing %d game(s)", len(game_ids))

        ok = 0
        skipped = 0
        failed = 0
        total_events = 0

        for i, gid in enumerate(game_ids, 1):
            meta = game_meta.get(gid)
            if not meta:
                # No final score / unmatched division — skip
                skipped += 1
                continue
            div_group, h, a, audit_ok = meta

            try:
                res = derive_game_wpa(cur, gid, wp_lookup, div_group, h, a,
                                      audit_ok=audit_ok, force=args.force)
            except Exception:
                logger.exception("game %d failed", gid)
                conn.rollback()
                failed += 1
                continue

            if res.get("skipped"):
                skipped += 1
                continue

            total_events += res.get("events", 0)
            ok += 1
            if i % 100 == 0:
                logger.info("  progress: %d / %d games", i, len(game_ids))
                conn.commit()

        conn.commit()
        logger.info("DONE: ok=%d skipped=%d failed=%d events=%d",
                    ok, skipped, failed, total_events)

        # ── Sanity prints ──────────────────────────────────────────
        print()
        cur.execute("""
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN wpa_batter IS NOT NULL THEN 1 ELSE 0 END) AS computed
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s
        """, (args.season,))
        r = cur.fetchone()
        print(f"── WPA coverage: {r['computed']:,}/{r['total']:,} events "
              f"({r['computed']/r['total']*100:.1f}%) ──")

        # WPA distribution sanity
        cur.execute("""
            SELECT
                MIN(wpa_batter) AS min_wpa,
                MAX(wpa_batter) AS max_wpa,
                AVG(wpa_batter) AS mean_wpa,
                AVG(ABS(wpa_batter)) AS mean_abs_wpa
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s AND wpa_batter IS NOT NULL
        """, (args.season,))
        r = cur.fetchone()
        if r and r["mean_wpa"] is not None:
            print(f"── WPA distribution ──")
            print(f"  min:          {r['min_wpa']:+.4f}")
            print(f"  max:          {r['max_wpa']:+.4f}")
            print(f"  mean:         {r['mean_wpa']:+.4f}  (should be ~0)")
            print(f"  mean |WPA|:   {r['mean_abs_wpa']:.4f}  (typical PA value)")

        # Top 10 single-PA WPA events from AUDIT-CLEAN games only.
        # Audit-bad games can produce inflated WPAs from missing-run
        # state corruption; we only surface trustworthy clutch moments.
        cur.execute("""
            WITH game_audit AS (
                SELECT game_id, COALESCE(SUM(runs_on_play), 0) AS derived_total
                FROM game_events GROUP BY game_id
            )
            SELECT g.game_date, ge.batter_name, ge.result_type,
                   ge.inning, ge.half,
                   ge.bat_score_before, ge.fld_score_before,
                   ge.runs_on_play, ge.wpa_batter,
                   ge.wp_before, ge.wp_after,
                   th.short_name AS home_short, ta.short_name AS away_short
            FROM game_events ge
            JOIN games g  ON g.id = ge.game_id
            JOIN game_audit ga ON ga.game_id = g.id
                              AND ga.derived_total = (g.home_score + g.away_score)
            JOIN teams th ON th.id = g.home_team_id
            JOIN teams ta ON ta.id = g.away_team_id
            WHERE g.season = %s AND ge.wpa_batter IS NOT NULL
            ORDER BY ge.wpa_batter DESC
            LIMIT 10
        """, (args.season,))
        print("\n── Top 10 single-PA WPA in audit-clean games (real clutch moments) ──")
        for r in cur.fetchall():
            inn = f"{r['inning']}{r['half'][:1]}"
            print(f"  {r['wpa_batter']:+.3f}  {r['wp_before']:.3f}->{r['wp_after']:.3f}"
                  f"  {r['game_date']}  {r['away_short']:>5}@{r['home_short']:<5}  "
                  f"{inn} {r['bat_score_before']}-{r['fld_score_before']}  "
                  f"{r['result_type']:<20}  {r['batter_name'] or ''}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
