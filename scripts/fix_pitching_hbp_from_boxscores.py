#!/usr/bin/env python3
"""
Repair pitching_stats.hit_batters and batters_faced using game_pitching box scores.

Problem:
    The NWAC scraper (scripts/scrape_nwac.py) hardcodes hbp=0 for every pitcher
    because the NWAC composite pitching template does not publish Hit Batters.
    Willamette (D3) is also affected through a separate ingestion path.
    With HBP=0 and BF estimated as outs+H+BB (missing HBP), the BABIP denominator
    (BF - BB - HBP - K - HR) is understated and BABIP is inflated.

Fix (for a given season):
    For every player row in pitching_stats where hit_batters == 0 but the player's
    game_pitching rows show HBPs, update:
      - hit_batters := sum of game_pitching.hit_batters for that player/season
      - batters_faced := batters_faced + recovered_hbp (add the missing HBPs back)
    Then the downstream recalculate_league_adjusted.py script will recompute
    babip_against cleanly.

Usage:
    PYTHONPATH=backend python3 scripts/fix_pitching_hbp_from_boxscores.py --season 2026
    PYTHONPATH=backend python3 scripts/fix_pitching_hbp_from_boxscores.py --season 2026 --dry-run
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Make `app.*` importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.models.database import get_connection  # noqa: E402


def repair(season: int, dry_run: bool = False) -> None:
    """Reconcile pitching_stats counting stats against box-score truth.

    For every pitching_stats row that has box-score coverage, take the MAX of
    the season-row value and the box-score sum for each stat below. We use
    max() (not overwrite) because some ingestion paths cover games that box
    scores don't, and vice versa -- never regress a stat downward.

    Stats reconciled (always max(season_row, box_sum), never regress):
      - hit_batters         (composite templates often omit HBP entirely)
      - batters_faced       (composite BF estimates undercount because they
                             don't include HBP and sometimes other events)
      - hits_allowed        (Seattle U WMT API undercounts)
      - walks               (Seattle U WMT API undercounts)
      - strikeouts          (Seattle U WMT API undercounts)
      - earned_runs         (Seattle U WMT API undercounts)

    Stats NOT reconciled here:
      - home_runs_allowed   (composite is generally more reliable than the
                             box-score HR parse, which often misses HRs)
      - innings_pitched     (composite IP is trustworthy)

    Downstream, recalculate_league_adjusted.py will recompute BABIP against,
    FIP, BAA, WHIP, ERA, etc. off the corrected counting stats.
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # Pull every pitching_stats row alongside the box-score sums so we can
        # decide row-by-row whether anything actually needs to change.
        cur.execute(
            """
            SELECT ps.id             AS ps_id,
                   ps.player_id,
                   ps.team_id,
                   ps.season,
                   ps.batters_faced  AS old_bf,
                   ps.hit_batters    AS old_hbp,
                   ps.hits_allowed   AS old_h,
                   ps.walks          AS old_bb,
                   ps.strikeouts     AS old_k,
                   ps.earned_runs    AS old_er,
                   box.hbp_box,
                   box.bf_box,
                   box.h_box,
                   box.bb_box,
                   box.k_box,
                   box.er_box,
                   t.short_name
            FROM pitching_stats ps
            JOIN teams t ON ps.team_id = t.id
            JOIN (
                SELECT gp.player_id, gp.team_id, g.season,
                       SUM(COALESCE(gp.hit_batters, 0))    AS hbp_box,
                       SUM(COALESCE(gp.batters_faced, 0))  AS bf_box,
                       SUM(COALESCE(gp.hits_allowed, 0))   AS h_box,
                       SUM(COALESCE(gp.walks, 0))          AS bb_box,
                       SUM(COALESCE(gp.strikeouts, 0))     AS k_box,
                       SUM(COALESCE(gp.earned_runs, 0))    AS er_box
                FROM game_pitching gp
                JOIN games g ON gp.game_id = g.id
                WHERE g.status = 'final'
                GROUP BY gp.player_id, gp.team_id, g.season
            ) box ON box.player_id = ps.player_id
                 AND box.team_id   = ps.team_id
                 AND box.season    = ps.season
            WHERE ps.season = %s
            ORDER BY t.short_name, ps.player_id
            """,
            (season,),
        )
        rows = cur.fetchall()

        if not rows:
            print(f"No pitching_stats rows with box-score coverage for season {season}.")
            return

        teams_touched: dict[str, int] = {}
        totals = {"hbp": 0, "bf": 0, "h": 0, "bb": 0, "k": 0, "er": 0}
        updated = 0

        for row in rows:
            old_hbp = int(row["old_hbp"] or 0)
            old_bf  = int(row["old_bf"]  or 0)
            old_h   = int(row["old_h"]   or 0)
            old_bb  = int(row["old_bb"]  or 0)
            old_k   = int(row["old_k"]   or 0)
            old_er  = int(row["old_er"]  or 0)
            hbp_box = int(row["hbp_box"] or 0)
            bf_box  = int(row["bf_box"]  or 0)
            h_box   = int(row["h_box"]   or 0)
            bb_box  = int(row["bb_box"]  or 0)
            k_box   = int(row["k_box"]   or 0)
            er_box  = int(row["er_box"]  or 0)

            new_hbp = max(old_hbp, hbp_box)
            new_h   = max(old_h,   h_box)
            new_bb  = max(old_bb,  bb_box)
            new_k   = max(old_k,   k_box)
            new_er  = max(old_er,  er_box)

            # For BF we also add any recovered HBP/H/BB/K on top of the old
            # estimate (the composite BF = outs + H + BB and omitted HBP; we
            # also back-fill K since those are outs not always reflected in IP
            # when the composite is partial). Then take the max against the
            # box-score BF sum.
            hbp_added = new_hbp - old_hbp
            h_added   = new_h   - old_h
            bb_added  = new_bb  - old_bb
            new_bf = max(old_bf + hbp_added + h_added + bb_added, bf_box)
            bf_added = new_bf - old_bf
            k_added   = new_k   - old_k
            er_added  = new_er  - old_er

            if (hbp_added == 0 and bf_added == 0 and h_added == 0
                    and bb_added == 0 and k_added == 0 and er_added == 0):
                continue

            teams_touched[row["short_name"]] = teams_touched.get(row["short_name"], 0) + 1
            totals["hbp"] += hbp_added
            totals["bf"]  += bf_added
            totals["h"]   += h_added
            totals["bb"]  += bb_added
            totals["k"]   += k_added
            totals["er"]  += er_added
            updated += 1

            if dry_run:
                continue

            cur.execute(
                """
                UPDATE pitching_stats
                SET hit_batters   = %s,
                    batters_faced = %s,
                    hits_allowed  = %s,
                    walks         = %s,
                    strikeouts    = %s,
                    earned_runs   = %s,
                    updated_at    = NOW()
                WHERE id = %s
                """,
                (new_hbp, new_bf, new_h, new_bb, new_k, new_er, row["ps_id"]),
            )

        if updated == 0:
            print(f"All pitching_stats rows already consistent with box scores for season {season}.")
            return

        print(f"Found {updated} pitcher rows needing repair for season {season}.")
        if dry_run:
            print("DRY RUN -- no writes. Breakdown by team:")
        else:
            print("Repaired. Breakdown by team:")
        for team, n in sorted(teams_touched.items(), key=lambda kv: (-kv[1], kv[0])):
            print(f"  {team:<24} {n} pitcher rows")
        print(f"Totals restored -- HBP: {totals['hbp']}   BF: {totals['bf']}   "
              f"H: {totals['h']}   BB: {totals['bb']}   K: {totals['k']}   ER: {totals['er']}")

        if dry_run:
            conn.rollback()
        else:
            conn.commit()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", type=int, required=True, help="Season year, e.g. 2026")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without writing")
    args = parser.parse_args()

    repair(args.season, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
