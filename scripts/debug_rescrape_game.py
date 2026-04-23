#!/usr/bin/env python3
"""
One-off diagnostic for the Kiserow/Semm game 3570 merge bug (and similar
orphan-pitcher issues in other NWAC games).

What it does, in order:
  1. Prints the current game_pitching rows for the given game_id.
  2. Re-scrapes the NWAC box score URL (deletes existing rows for the game
     inside process_boxscore and reinserts fresh).
  3. Prints the game_pitching rows again so we can diff.

Run from Mac (uses the prod DB via .env DATABASE_URL):

    cd ~/Desktop/pnw-baseball
    PYTHONPATH=backend python3 scripts/debug_rescrape_game.py \
        --game-id 3570 \
        --url https://nwacsports.com/sports/bsb/2025-26/boxscores/20260422_lbm2.xml

Pass --no-rescrape to only print the current state without refetching.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
sys.path.insert(0, str(Path(__file__).parent))

from app.models.database import get_connection
from scrape_nwac_boxscores import process_boxscore


def dump_pitching(cur, game_id, label):
    cur.execute(
        """
        SELECT gp.id,
               gp.player_id,
               gp.player_name,
               gp.team_id,
               t.short_name AS team,
               gp.innings_pitched,
               gp.hits_allowed,
               gp.runs_allowed,
               gp.earned_runs,
               gp.walks,
               gp.strikeouts,
               gp.home_runs_allowed,
               gp.decision,
               gp.pitch_order,
               gp.is_starter,
               gp.created_at
        FROM game_pitching gp
        LEFT JOIN teams t ON t.id = gp.team_id
        WHERE gp.game_id = %s
        ORDER BY gp.team_id, gp.pitch_order, gp.id
        """,
        (game_id,),
    )
    rows = cur.fetchall()
    print(f"\n=== {label}: game_pitching rows for game_id={game_id} "
          f"({len(rows)} rows) ===")
    if not rows:
        print("  (no rows)")
        return
    for r in rows:
        print(
            f"  id={r['id']:<7} "
            f"team={r['team'] or '?':<18} "
            f"player_id={str(r['player_id']):<7} "
            f"name={r['player_name']:<25} "
            f"IP={r['innings_pitched']:<5} "
            f"H={r['hits_allowed']:<3} "
            f"R={r['runs_allowed']:<3} "
            f"ER={r['earned_runs']:<3} "
            f"BB={r['walks']:<3} "
            f"K={r['strikeouts']:<3} "
            f"HR={r['home_runs_allowed']:<3} "
            f"dec={str(r['decision'] or '-'):<3} "
            f"ord={r['pitch_order']} "
            f"starter={r['is_starter']} "
            f"created={r['created_at']}"
        )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-id", type=int, required=True)
    ap.add_argument("--url", required=True, help="NWAC box score XML URL")
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--no-rescrape", action="store_true",
                    help="Only print current state; do not refetch/rewrite.")
    args = ap.parse_args()

    # Print BEFORE state
    with get_connection() as conn:
        cur = conn.cursor()
        dump_pitching(cur, args.game_id, "BEFORE")

    if args.no_rescrape:
        print("\n--no-rescrape set; exiting without refetching.")
        return

    # Re-scrape
    print(f"\n=== Re-scraping {args.url} ===")
    ok = process_boxscore(args.url, args.season, dry_run=False)
    print(f"Scrape result: {'SUCCESS' if ok else 'FAILED'}")

    # Print AFTER state
    with get_connection() as conn:
        cur = conn.cursor()
        dump_pitching(cur, args.game_id, "AFTER")


if __name__ == "__main__":
    main()
