#!/usr/bin/env python3
"""
Update player positions based on game log data.

Uses most-played position from box scores instead of generic roster data.
Runs after box score scraping so position counts are current.

Usage:
    cd pnw-baseball
    PYTHONPATH=backend python3 scripts/update_positions.py --season 2026
"""

import sys
import os
import argparse
import logging

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection
from app.stats.advanced import normalize_position

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)


def main():
    parser = argparse.ArgumentParser(description="Update player positions from game logs")
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--dry-run", action="store_true", help="Show changes without updating DB")
    args = parser.parse_args()

    log.info(f"Updating positions from game logs for {args.season} season...")

    with get_connection() as conn:
        cur = conn.cursor()

        # ── Get position counts per player from game_batting ──
        cur.execute("""
            SELECT gb.player_id, gb.position,
                   COUNT(DISTINCT (g.game_date, COALESCE(g.game_number, 1))) as games
            FROM game_batting gb
            JOIN games g ON g.id = gb.game_id
            WHERE gb.player_id IS NOT NULL
              AND g.season = %s
              AND gb.position IS NOT NULL
              AND gb.position != ''
              AND gb.position != '-'
            GROUP BY gb.player_id, gb.position
            ORDER BY gb.player_id, games DESC
        """, (args.season,))
        rows = cur.fetchall()

        if not rows:
            log.info("No game log position data found.")
            return

        log.info(f"Found {len(rows)} player-position rows from game logs.")

        # ── Group by player, normalize positions, accumulate game counts ──
        player_positions = {}
        for r in rows:
            pid = r["player_id"]
            raw_pos = r["position"]
            games = r["games"]

            norm = normalize_position(raw_pos)
            if not norm:
                continue

            if pid not in player_positions:
                player_positions[pid] = {}
            player_positions[pid][norm] = player_positions[pid].get(norm, 0) + games

        log.info(f"Processed positions for {len(player_positions)} players.")

        # ── Pick most-played position, compare to current, update if different ──
        changed = 0
        skipped = 0

        for pid, pos_counts in player_positions.items():
            best_pos = max(pos_counts, key=pos_counts.get)
            best_games = pos_counts[best_pos]

            cur.execute("SELECT position, first_name, last_name FROM players WHERE id = %s", (pid,))
            row = cur.fetchone()
            if not row:
                skipped += 1
                continue

            old_pos = row["position"] or ""
            old_norm = normalize_position(old_pos) if old_pos else ""

            if old_norm == best_pos:
                continue

            if args.dry_run:
                log.info(f"  [DRY RUN] {row['first_name']} {row['last_name']}: {old_pos} -> {best_pos} ({best_games} games)")
            else:
                cur.execute("UPDATE players SET position = %s WHERE id = %s", (best_pos, pid))

            changed += 1

        if not args.dry_run:
            conn.commit()

        log.info(f"Updated {changed} player positions. ({skipped} players not found in DB)")
        if args.dry_run:
            log.info("(Dry run — no changes saved)")


if __name__ == "__main__":
    main()
