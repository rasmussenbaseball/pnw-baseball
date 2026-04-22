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
    """Patch HBP / BF for pitching_stats rows that disagree with box scores.

    Two classes of fixes are applied:
      1. HBP recovery: when the season-row hit_batters is less than the sum of
         hit_batters across the player's box-score rows (because the composite
         pitching template didn't publish HBP and the scraper hardcoded 0).
      2. BF reconciliation: when the season-row batters_faced is less than the
         sum of batters_faced across the player's box-score rows (because the
         composite BF was estimated from outs+H+BB and undercounts).
    """
    with get_connection() as conn:
        cur = conn.cursor()

        # Pull every pitching_stats row that has box-score coverage. We'll
        # decide row-by-row whether anything actually needs to change.
        cur.execute(
            """
            SELECT ps.id            AS ps_id,
                   ps.player_id,
                   ps.team_id,
                   ps.season,
                   ps.batters_faced AS old_bf,
                   ps.hit_batters   AS old_hbp,
                   box.hbp_box,
                   box.bf_box,
                   t.short_name
            FROM pitching_stats ps
            JOIN teams t ON ps.team_id = t.id
            JOIN (
                SELECT gp.player_id, gp.team_id, g.season,
                       SUM(COALESCE(gp.hit_batters, 0))    AS hbp_box,
                       SUM(COALESCE(gp.batters_faced, 0))  AS bf_box
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
        total_hbp_added = 0
        total_bf_added = 0
        updated = 0

        for row in rows:
            old_hbp = int(row["old_hbp"] or 0)
            old_bf = int(row["old_bf"] or 0)
            hbp_box = int(row["hbp_box"] or 0)
            bf_box = int(row["bf_box"] or 0)

            # New HBP: trust box scores when they exceed the season-row value.
            new_hbp = max(old_hbp, hbp_box)
            hbp_added = new_hbp - old_hbp

            # New BF: trust box scores when they exceed the season-row value.
            # Also ensure we don't drop BF below "old_bf + any recovered HBP"
            # when the composite covers more games than box scores.
            new_bf = max(old_bf + hbp_added, bf_box)
            bf_added = new_bf - old_bf

            # Skip rows that are already consistent.
            if hbp_added == 0 and bf_added == 0:
                continue

            teams_touched[row["short_name"]] = teams_touched.get(row["short_name"], 0) + 1
            total_hbp_added += hbp_added
            total_bf_added += bf_added
            updated += 1

            if dry_run:
                continue

            cur.execute(
                """
                UPDATE pitching_stats
                SET hit_batters   = %s,
                    batters_faced = %s,
                    updated_at    = NOW()
                WHERE id = %s
                """,
                (new_hbp, new_bf, row["ps_id"]),
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
        print(f"Total HBPs restored: {total_hbp_added}")
        print(f"Total BF restored:   {total_bf_added}")

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
