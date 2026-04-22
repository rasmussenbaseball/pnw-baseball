#!/usr/bin/env python3
"""
Force pitching_stats counting stats to match game_pitching sums for a
specific set of teams. Use this AFTER deduplicating game_pitching when
pitching_stats is known to be inflated from a prior repair run.

Why this is needed:
  fix_pitching_hbp_from_boxscores.py uses max(ps_old, box_sum) and
  "never regresses downward." Before the dedupe, game_pitching had duplicate
  rows for some teams (Seattle U 88, UW 12, Pacific 1, Gonzaga 1 in 2026)
  which caused box_sum to be inflated. The repair script then wrote those
  inflated values into pitching_stats. Post-dedupe, game_pitching is clean,
  but pitching_stats is still bloated — and max() can't regress it back.

What this script does:
  For a whitelist of team_ids, overwrite pitching_stats.{hits_allowed, walks,
  strikeouts, earned_runs, home_runs_allowed, hit_batters, batters_faced,
  innings_pitched} with the summed values from game_pitching. This treats the
  (now-clean) box score as the authoritative source.

Safety:
  - Restricted to an explicit team whitelist (Seattle U, UW, Pacific, Gonzaga
    for 2026 by default; editable below). Does not touch opposing teams where
    our box-score coverage is incomplete.
  - Only touches pitching_stats rows that correspond to a (player_id, team_id,
    season) combo that actually has game_pitching rows.
  - --dry-run shows what would change without writing.

Usage:
    cd /Users/naterasmussen/Desktop/pnw-baseball
    PYTHONPATH=backend python3 scripts/resync_pitching_stats_from_boxscores.py --season 2026 --dry-run
    PYTHONPATH=backend python3 scripts/resync_pitching_stats_from_boxscores.py --season 2026
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Make `app.*` importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.models.database import get_connection  # noqa: E402


# Teams whose pitching_stats is known to have been inflated by the earlier
# max() repair run against duplicated game_pitching rows AND whose primary
# ingestion path is box-score based (not a composite season page). Seattle U
# qualifies because its scrape path is the WMT Games API per-box-score.
#
# DO NOT add teams whose primary source is a composite season page
# (gohuskies.com, goseattleu.com composite, etc.) — their pitching_stats is
# more complete than box-score sums and resyncing would regress data. For
# those teams, dedupe game_pitching and leave pitching_stats alone.
AFFECTED_TEAMS = {
    2026: [
        "Seattle U",
    ],
}

# Stats we will overwrite from game_pitching. We intentionally SKIP:
#   - home_runs_allowed: composite HR is more reliable than box-score HR
#   - innings_pitched:   composite IP is authoritative and already accurate
RESYNC_STATS = ("h", "bb", "k", "er", "hbp", "bf")


def resolve_team_ids(cur, short_names: list[str]) -> dict[str, int]:
    cur.execute(
        "SELECT id, short_name FROM teams WHERE short_name = ANY(%s)",
        (short_names,),
    )
    return {r["short_name"]: r["id"] for r in cur.fetchall()}


def resync(season: int, dry_run: bool) -> None:
    whitelist_names = AFFECTED_TEAMS.get(season)
    if not whitelist_names:
        print(f"No affected-team list configured for season {season}. "
              f"Edit AFFECTED_TEAMS in the script if you want to resync.")
        return

    with get_connection() as conn:
        cur = conn.cursor()

        name_to_id = resolve_team_ids(cur, whitelist_names)
        missing = [n for n in whitelist_names if n not in name_to_id]
        if missing:
            print(f"WARNING: could not resolve team short_names: {missing}")
        team_ids = list(name_to_id.values())
        if not team_ids:
            print("No team ids resolved. Aborting.")
            return

        print(f"Resyncing pitching_stats from game_pitching for season {season}.")
        print("Affected teams:")
        for name, tid in name_to_id.items():
            print(f"  {name:<20} team_id={tid}")

        # Compute box-score sums per (player_id, team_id) for the whitelisted
        # teams, then join against pitching_stats for the same (player, team,
        # season). Show the before/after so we can see exactly what flips.
        cur.execute(
            """
            WITH box AS (
                SELECT gp.player_id,
                       gp.team_id,
                       SUM(COALESCE(gp.innings_pitched, 0))     AS ip_box,
                       SUM(COALESCE(gp.hits_allowed, 0))        AS h_box,
                       SUM(COALESCE(gp.walks, 0))               AS bb_box,
                       SUM(COALESCE(gp.strikeouts, 0))          AS k_box,
                       SUM(COALESCE(gp.earned_runs, 0))         AS er_box,
                       SUM(COALESCE(gp.home_runs_allowed, 0))   AS hr_box,
                       SUM(COALESCE(gp.hit_batters, 0))         AS hbp_box,
                       SUM(COALESCE(gp.batters_faced, 0))       AS bf_box
                FROM game_pitching gp
                JOIN games g ON gp.game_id = g.id
                WHERE g.season = %s
                  AND g.status = 'final'
                  AND gp.team_id = ANY(%s)
                  AND gp.player_id IS NOT NULL
                  AND gp.team_id IN (g.home_team_id, g.away_team_id)
                GROUP BY gp.player_id, gp.team_id
            )
            SELECT ps.id               AS ps_id,
                   ps.player_id,
                   ps.team_id,
                   t.short_name,
                   p.first_name || ' ' || p.last_name AS player_name,
                   ps.innings_pitched  AS old_ip,
                   ps.hits_allowed     AS old_h,
                   ps.walks            AS old_bb,
                   ps.strikeouts       AS old_k,
                   ps.earned_runs      AS old_er,
                   ps.home_runs_allowed AS old_hr,
                   ps.hit_batters      AS old_hbp,
                   ps.batters_faced    AS old_bf,
                   box.ip_box, box.h_box, box.bb_box, box.k_box,
                   box.er_box, box.hr_box, box.hbp_box, box.bf_box
            FROM pitching_stats ps
            JOIN teams t ON ps.team_id = t.id
            JOIN players p ON ps.player_id = p.id
            JOIN box ON box.player_id = ps.player_id AND box.team_id = ps.team_id
            WHERE ps.season = %s
              AND ps.team_id = ANY(%s)
            ORDER BY t.short_name, p.last_name, p.first_name
            """,
            (season, team_ids, season, team_ids),
        )
        rows = cur.fetchall()

        if not rows:
            print("No pitching_stats rows match for those teams/season. Nothing to do.")
            return

        changed = 0
        diffs = []
        for r in rows:
            old_vals = [r[f"old_{f}"] for f in RESYNC_STATS]
            box_vals = [r[f"{f}_box"]  for f in RESYNC_STATS]
            if all((o or 0) == (b or 0) for o, b in zip(old_vals, box_vals)):
                continue
            changed += 1
            diffs.append(r)

        if changed == 0:
            print("All rows already match box-score sums (for resynced stats). Nothing to do.")
            return

        print(f"\n{changed} pitcher row(s) will be resynced "
              f"(stats: {', '.join(RESYNC_STATS)}).")
        print(f"{'Team':<12} {'Pitcher':<22} {'stat':<5} {'old':<7} -> {'new':<7}")
        for r in diffs[:20]:
            for f in RESYNC_STATS:
                old = r[f"old_{f}"] or 0
                new = r[f"{f}_box"] or 0
                if float(old) == float(new):
                    continue
                print(f"{r['short_name']:<12} {r['player_name']:<22} "
                      f"{f:<5} {float(old):<7} -> {float(new):<7}")
            print("")

        if dry_run:
            print("\n[DRY RUN] no writes. Use without --dry-run to commit.")
            conn.rollback()
            return

        # Do the writes. IP and HR are intentionally NOT touched.
        for r in diffs:
            cur.execute(
                """
                UPDATE pitching_stats
                SET hits_allowed   = %s,
                    walks          = %s,
                    strikeouts     = %s,
                    earned_runs    = %s,
                    hit_batters    = %s,
                    batters_faced  = %s,
                    updated_at     = NOW()
                WHERE id = %s
                """,
                (
                    r["h_box"], r["bb_box"], r["k_box"],
                    r["er_box"], r["hbp_box"], r["bf_box"],
                    r["ps_id"],
                ),
            )
        conn.commit()
        print(f"\nCOMMITTED. Resynced {changed} pitching_stats row(s). "
              f"(IP and HR untouched.)")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--season", type=int, required=True)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    resync(args.season, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
