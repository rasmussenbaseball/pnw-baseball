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
    For every player row in pitching_stats with box-score coverage, raise
    hit_batters / hits / walks / strikeouts / earned_runs to the box-score sums
    when those are higher, and rebuild batters_faced so it stays consistent
    with the season line (see repair() for the exact BF rule). Then the
    downstream recalculate_league_adjusted.py script recomputes babip_against,
    FIP, K%, BB% cleanly.

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


def _outs(ip) -> int:
    """Baseball-notation IP (6.2 = 6 2/3) -> outs."""
    ip = float(ip or 0)
    whole = int(ip)
    return whole * 3 + int(round((ip - whole) * 10))


def _in_band(value: int, est: int) -> bool:
    """Is `value` a plausible BF for a line whose outs+H+BB+HBP is `est`?

    True BF differs from the estimate by reached-on-error (+) and by outs
    that are not plate appearances such as caught stealing / pickoffs (-),
    so allow 0.8x .. 1.25x, or +/-2 batters for tiny lines.
    """
    if abs(value - est) <= 2:
        return True
    if est <= 0:
        return False
    return 0.8 <= value / est <= 1.25


def repair(season: int, dry_run: bool = False, verbose: bool = False) -> None:
    """Reconcile pitching_stats counting stats against box-score truth.

    For every pitching_stats row that has box-score coverage, take the MAX of
    the season-row value and the box-score sum for each stat below. We use
    max() (not overwrite) because some ingestion paths cover games that box
    scores don't, and vice versa -- never regress a stat downward.

    Stats reconciled (always max(season_row, box_sum), never regress):
      - hit_batters         (composite templates often omit HBP entirely)
      - hits_allowed        (Seattle U WMT API undercounts)
      - walks               (Seattle U WMT API undercounts)
      - strikeouts          (Seattle U WMT API undercounts)
      - earned_runs         (Seattle U WMT API undercounts)

    batters_faced is handled differently because for composite-sourced rows
    (NWAC, Willamette) it is only ever an ESTIMATE (outs + H + BB + HBP), and a
    pure "max against the box sum" ratchet burned us in 2026: duplicate game
    rows (before dedup_games ran) and ghost game_pitching rows inflated the box
    sum, max() locked the inflated value in, and because the scraper reset
    H/BB daily but never BF, the H/BB deltas were re-added every run
    (Pevny 282 BF on 13 IP, Gutierrez 359 BF on 0.1 IP, Karlson 432 on 68 IP).
    The rule now is:
      est  = outs + H + BB + HBP (after the max() reconciliation above)
      base = old_bf + recovered (HBP + H + BB); if base is not within the
             sanity band of est (0.8x .. 1.25x, or +/-2 for tiny lines) it is
             stale or corrupt, so base = est
      new_bf = max(base, box_bf) but ONLY if box_bf itself is inside the band
               AND the box does not cover more games than the season row;
               otherwise (duplicated / ghost / mismatched rows) box_bf is ignored
    Ghost rows (gp.team_id not one of the game's two teams) are excluded from
    every box sum.

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
                   ps.innings_pitched AS ip,
                   ps.games          AS games,
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
                   box.games_box,
                   dirty.hbp_dirty, dirty.h_dirty, dirty.bb_dirty, dirty.k_dirty, dirty.er_dirty,
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
                       SUM(COALESCE(gp.earned_runs, 0))    AS er_box,
                       COUNT(DISTINCT gp.game_id)          AS games_box
                FROM game_pitching gp
                JOIN games g ON gp.game_id = g.id
                WHERE g.status = 'final'
                  -- ghost-row guard: skip box rows attached to a team that did
                  -- not play in the game (bad name matches from other scrapers)
                  AND gp.team_id IN (g.home_team_id, g.away_team_id)
                GROUP BY gp.player_id, gp.team_id, g.season
            ) box ON box.player_id = ps.player_id
                 AND box.team_id   = ps.team_id
                 AND box.season    = ps.season
            -- Same sums WITHOUT the ghost guard. Earlier versions of this script
            -- wrote these contaminated sums into pitching_stats; when a stored
            -- stat still equals the contaminated sum we know where it came from
            -- and reset it to the clean sum before reconciling.
            LEFT JOIN (
                SELECT gp.player_id, gp.team_id, g.season,
                       SUM(COALESCE(gp.hit_batters, 0))  AS hbp_dirty,
                       SUM(COALESCE(gp.hits_allowed, 0)) AS h_dirty,
                       SUM(COALESCE(gp.walks, 0))        AS bb_dirty,
                       SUM(COALESCE(gp.strikeouts, 0))   AS k_dirty,
                       SUM(COALESCE(gp.earned_runs, 0))  AS er_dirty
                FROM game_pitching gp
                JOIN games g ON gp.game_id = g.id
                WHERE g.status = 'final'
                  AND gp.team_id NOT IN (g.home_team_id, g.away_team_id)
                GROUP BY gp.player_id, gp.team_id, g.season
            ) ghost ON ghost.player_id = ps.player_id
                   AND ghost.team_id   = ps.team_id
                   AND ghost.season    = ps.season
            LEFT JOIN LATERAL (
                SELECT box.hbp_box + COALESCE(ghost.hbp_dirty, 0) AS hbp_dirty,
                       box.h_box   + COALESCE(ghost.h_dirty, 0)   AS h_dirty,
                       box.bb_box  + COALESCE(ghost.bb_dirty, 0)  AS bb_dirty,
                       box.k_box   + COALESCE(ghost.k_dirty, 0)   AS k_dirty,
                       box.er_box  + COALESCE(ghost.er_dirty, 0)  AS er_dirty
            ) dirty ON TRUE
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

            # Undo ghost-row contamination written by the old max() rule: a
            # stored value that equals the ghost-inclusive sum (and differs
            # from the clean sum) came from this script, so drop it back to
            # the clean sum before reconciling.
            ghosted = []
            for key, old_val, dirty_val, clean_val in (
                ("hbp", old_hbp, row["hbp_dirty"], hbp_box),
                ("h",   old_h,   row["h_dirty"],   h_box),
                ("bb",  old_bb,  row["bb_dirty"],  bb_box),
                ("k",   old_k,   row["k_dirty"],   k_box),
                ("er",  old_er,  row["er_dirty"],  er_box),
            ):
                dirty_val = int(dirty_val or 0)
                if dirty_val != clean_val and old_val == dirty_val:
                    ghosted.append(key)
            if "hbp" in ghosted: old_hbp = hbp_box
            if "h"   in ghosted: old_h   = h_box
            if "bb"  in ghosted: old_bb  = bb_box
            if "k"   in ghosted: old_k   = k_box
            if "er"  in ghosted: old_er  = er_box

            # A box sum that covers MORE appearances than the season row is
            # either a duplicated game (Oregon 2026-06-06 vs Texas was stored
            # twice under two opponent ids) or a bad name match. A single
            # duplicated start sits inside the BF sanity band, so when the box
            # game count exceeds the season line we do not raise anything from
            # the box for this row; BF is still rebuilt from the line below.
            games = int(row["games"] or 0)
            games_box = int(row["games_box"] or 0)
            trust_box = games == 0 or games_box <= games

            if trust_box:
                new_hbp = max(old_hbp, hbp_box)
                new_h   = max(old_h,   h_box)
                new_bb  = max(old_bb,  bb_box)
                new_k   = max(old_k,   k_box)
                new_er  = max(old_er,  er_box)
            else:
                new_hbp, new_h, new_bb, new_k, new_er = old_hbp, old_h, old_bb, old_k, old_er

            hbp_added = new_hbp - int(row["old_hbp"] or 0)
            h_added   = new_h   - int(row["old_h"]   or 0)
            bb_added  = new_bb  - int(row["old_bb"]  or 0)
            k_added   = new_k   - int(row["old_k"]   or 0)
            er_added  = new_er  - int(row["old_er"]  or 0)

            # BF: rebuild from the (now reconciled) season line and only let a
            # box-score sum override it when that sum is itself consistent
            # with the line. See the docstring for why a bare max() is unsafe.
            est = _outs(row["ip"]) + new_h + new_bb + new_hbp
            base = old_bf + hbp_added + h_added + bb_added
            if not _in_band(base, est):
                base = est
            new_bf = max(base, bf_box) if (trust_box and _in_band(bf_box, est)) else base
            bf_added = new_bf - old_bf

            if (hbp_added == 0 and bf_added == 0 and h_added == 0
                    and bb_added == 0 and k_added == 0 and er_added == 0):
                continue

            teams_touched[row["short_name"]] = teams_touched.get(row["short_name"], 0) + 1
            if verbose:
                print(f"  {row['short_name']:<18} player {row['player_id']:<6} "
                      f"IP {row['ip']}  BF {old_bf}->{new_bf} (est {est}, box {bf_box}/{row['games_box']}g of {row['games']})"
                      f"  H {int(row['old_h'] or 0)}->{new_h}  BB {int(row['old_bb'] or 0)}->{new_bb}"
                      f"  HBP {int(row['old_hbp'] or 0)}->{new_hbp}  K {int(row['old_k'] or 0)}->{new_k}"
                      f"  ER {int(row['old_er'] or 0)}->{new_er}"
                      + (f"  [ghost-reset: {','.join(ghosted)}]" if ghosted else "")
                      + ("" if trust_box else "  [box not trusted: more games than season row]"))
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
        print(f"Totals changed -- HBP: {totals['hbp']}   BF: {totals['bf']:+d}   "
              f"H: {totals['h']}   BB: {totals['bb']}   K: {totals['k']}   ER: {totals['er']}")

        if dry_run:
            conn.rollback()
        else:
            conn.commit()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", type=int, required=True, help="Season year, e.g. 2026")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without writing")
    parser.add_argument("--verbose", "-v", action="store_true", help="Print every row that changes")
    args = parser.parse_args()

    repair(args.season, dry_run=args.dry_run, verbose=args.verbose)


if __name__ == "__main__":
    main()
