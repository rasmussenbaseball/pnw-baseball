"""
Compute Win Probability Added per summer_game_events row (WCL).

Summer port of scripts/compute_wpa.py — same algorithm, same wp_lookup
table (built from spring NCAA/NWAC PBP by build_wp_table.py). We
deliberately REUSE the spring WP table rather than building a summer-
specific run environment: cross-product consistency (a +0.20 WPA means
the same thing on a WCL page as on a spring page) beats fitting WCL's
slightly different scoring environment with 1 season of data. WCL plays
9-inning regulation like the NCAA divisions, so division_group='NCAA'.

For every state-populated PA event:
    wpa_batter  = WP_after - WP_before     (positive = good for batter)
    wpa_pitcher = -wpa_batter              (positive = good for pitcher)

WP_after handling (same as spring):
  • Same half-inning (outs_after < 3): same batting team, new state.
  • Half flips (outs_after == 3): batting team switches, bases/outs
    reset, score perspective flips: WP_after = 1 - lookup(new state).
  • Last event of an audit-clean game whose end-state is consistent
    with the outcome: snap WP_after to 1.0 / 0.0.

Run on Mac or server:
    PYTHONPATH=backend python3 scripts/compute_summer_wpa.py
        # default: only games with wpa_derived_at IS NULL
        # --force      re-derive games already derived
        # --season N   change season (default 2026)
        # --limit N    cap games processed
"""

from __future__ import annotations
import argparse
import logging
import sys
from typing import Dict, Tuple

import psycopg2.extras

from app.models.database import get_connection


SEASON = 2026

# WCL = 9-inning regulation, college talent → use the NCAA WP surface.
DIVISION_GROUP = "NCAA"

# Same caps as build_wp_table.py — must agree for lookups to hit
INNING_CAP = 10
SCORE_DIFF_CAP = 6

# Fallback when a state isn't in any lookup tier
GLOBAL_FALLBACK_WP = 0.50

logger = logging.getLogger("compute_summer_wpa")
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
    """Compute WPA for every state-populated event in one summer game.

    audit_ok: True iff per-side derived runs match the summer_games
    final. When False we still compute WPA from the smoothed WP lookup,
    but DO NOT snap WP_after to the actual game outcome on the final PA
    (that would inflate the last PA's WPA artificially when the score
    state was already off)."""

    # Skip if already derived
    if not force:
        cur.execute(
            "SELECT 1 FROM summer_game_events WHERE game_id = %s "
            "  AND wpa_derived_at IS NOT NULL LIMIT 1",
            (game_id,),
        )
        if cur.fetchone():
            return {"skipped": True}

    # Pull events ordered chronologically. We only WPA the events with
    # full state populated AND a PA result type (sub-events like steals
    # don't change the batter; their WP delta belongs to the surrounding
    # PA, not as a standalone WPA — same deferral as spring).
    cur.execute("""
        SELECT id, inning, half, sequence_idx,
               result_type,
               bases_before, outs_before, bases_after, outs_after,
               bat_score_before, fld_score_before, runs_on_play
        FROM summer_game_events
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
        # Outcome snap: only when this is the last PA, the game audit
        # is clean, AND the recorded end-of-PA state is consistent with
        # the game actually ending here (strict lead + inning >= 7 +
        # walk-off or 3rd-out ending). Same guards as spring.
        wp_after = None
        if is_last and audit_ok:
            home_batting = (half == "bottom")
            batter_won = (home_batting and home_won) or (
                (not home_batting) and (not home_won))
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
        UPDATE summer_game_events SET
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
    ap = argparse.ArgumentParser(description="Compute WPA for summer_game_events.")
    ap.add_argument("--season", type=int, default=SEASON)
    ap.add_argument("--game-id", type=int, help="Single summer game (smoke test).")
    ap.add_argument("--force", action="store_true",
                    help="Re-derive games already WPA-derived.")
    ap.add_argument("--limit", type=int, help="Cap games processed.")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        # Apply migration if columns don't already exist (idempotent).
        logger.info("Applying migration (idempotent)...")
        cur.execute("""
            ALTER TABLE summer_game_events
                ADD COLUMN IF NOT EXISTS wp_before        DOUBLE PRECISION,
                ADD COLUMN IF NOT EXISTS wp_after         DOUBLE PRECISION,
                ADD COLUMN IF NOT EXISTS wpa_batter       DOUBLE PRECISION,
                ADD COLUMN IF NOT EXISTS wpa_pitcher      DOUBLE PRECISION,
                ADD COLUMN IF NOT EXISTS wpa_derived_at   TIMESTAMPTZ;
            CREATE INDEX IF NOT EXISTS summer_game_events_wpa_batter_idx
                ON summer_game_events (batter_player_id)
                WHERE wpa_batter IS NOT NULL AND batter_player_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS summer_game_events_wpa_pitcher_idx
                ON summer_game_events (pitcher_player_id)
                WHERE wpa_pitcher IS NOT NULL AND pitcher_player_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS summer_game_events_wpa_undrived_idx
                ON summer_game_events (game_id)
                WHERE wpa_derived_at IS NULL;
        """)
        conn.commit()

        # Load WP lookup table once (spring-built; NCAA surface used)
        wp_lookup = WPLookup(cur)

        # Pre-cache final score + audit_ok per game. audit_ok = per-side
        # derived runs match the summer_games final (stricter than the
        # spring total-runs check; we have per-side accumulators).
        cur.execute("""
            WITH game_audit AS (
                SELECT e.game_id,
                       COALESCE(SUM(e.runs_on_play)
                           FILTER (WHERE e.half = 'bottom'), 0) AS derived_home,
                       COALESCE(SUM(e.runs_on_play)
                           FILTER (WHERE e.half = 'top'), 0) AS derived_away
                FROM summer_game_events e
                GROUP BY e.game_id
            )
            SELECT g.id AS game_id,
                   g.home_score, g.away_score,
                   CASE WHEN COALESCE(ga.derived_home, 0) = g.home_score
                         AND COALESCE(ga.derived_away, 0) = g.away_score
                        THEN TRUE ELSE FALSE END AS audit_ok
            FROM summer_games g
            LEFT JOIN game_audit ga ON ga.game_id = g.id
            WHERE g.season = %s
              AND g.home_score IS NOT NULL
              AND g.away_score IS NOT NULL
              AND g.home_score <> g.away_score
        """, (args.season,))
        game_meta = {
            r["game_id"]: (r["home_score"], r["away_score"], r["audit_ok"])
            for r in cur.fetchall()
        }
        n_audit_ok = sum(1 for v in game_meta.values() if v[2])
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
                    "EXISTS (SELECT 1 FROM summer_game_events e WHERE e.game_id = g.id "
                    "  AND e.wpa_derived_at IS NULL "
                    "  AND e.bases_before IS NOT NULL)"
                )
            else:
                where.append(
                    "EXISTS (SELECT 1 FROM summer_game_events e WHERE e.game_id = g.id "
                    "  AND e.bases_before IS NOT NULL)"
                )
            sql = (f"SELECT g.id FROM summer_games g WHERE {' AND '.join(where)} "
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
                # No final score / tie — skip
                skipped += 1
                continue
            h, a, audit_ok = meta

            try:
                res = derive_game_wpa(cur, gid, wp_lookup, DIVISION_GROUP, h, a,
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
            FROM summer_game_events ge
            JOIN summer_games g ON g.id = ge.game_id
            WHERE g.season = %s
        """, (args.season,))
        r = cur.fetchone()
        if r and r["total"]:
            print(f"── WPA coverage: {r['computed']:,}/{r['total']:,} events "
                  f"({r['computed']/r['total']*100:.1f}%) ──")

        # WPA distribution sanity
        cur.execute("""
            SELECT
                MIN(wpa_batter) AS min_wpa,
                MAX(wpa_batter) AS max_wpa,
                AVG(wpa_batter) AS mean_wpa,
                AVG(ABS(wpa_batter)) AS mean_abs_wpa
            FROM summer_game_events ge
            JOIN summer_games g ON g.id = ge.game_id
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
        cur.execute("""
            WITH game_audit AS (
                SELECT e.game_id,
                       COALESCE(SUM(e.runs_on_play)
                           FILTER (WHERE e.half = 'bottom'), 0) AS dh,
                       COALESCE(SUM(e.runs_on_play)
                           FILTER (WHERE e.half = 'top'), 0) AS da
                FROM summer_game_events e GROUP BY e.game_id
            )
            SELECT g.game_date, ge.batter_name, ge.result_type,
                   ge.inning, ge.half,
                   ge.bat_score_before, ge.fld_score_before,
                   ge.runs_on_play, ge.wpa_batter,
                   ge.wp_before, ge.wp_after,
                   g.home_team_name, g.away_team_name
            FROM summer_game_events ge
            JOIN summer_games g  ON g.id = ge.game_id
            JOIN game_audit ga ON ga.game_id = g.id
                              AND ga.dh = g.home_score AND ga.da = g.away_score
            WHERE g.season = %s AND ge.wpa_batter IS NOT NULL
            ORDER BY ge.wpa_batter DESC
            LIMIT 10
        """, (args.season,))
        print("\n── Top 10 single-PA WPA in audit-clean games (real clutch moments) ──")
        for r in cur.fetchall():
            inn = f"{r['inning']}{r['half'][:1]}"
            print(f"  {r['wpa_batter']:+.3f}  {r['wp_before']:.3f}->{r['wp_after']:.3f}"
                  f"  {r['game_date']}  {r['away_team_name'][:14]:>14}@{r['home_team_name'][:14]:<14}  "
                  f"{inn} {r['bat_score_before']}-{r['fld_score_before']}  "
                  f"{r['result_type']:<20}  {r['batter_name'] or ''}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
