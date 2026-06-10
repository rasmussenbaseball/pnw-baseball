#!/usr/bin/env python3
"""
One-time cleanup for Pacific University (id=17) ghost games.

These 16 rows were inserted into the `games` table with home_team_id=17
or away_team_id=17, but they are NOT on Pacific's real 2026 schedule
(verified against goboxers.com/sports/baseball/schedule/2026).

Root cause: scrapers running on OTHER teams' pages saw the string
"Pacific" as an opponent and resolved it blindly to id=17 via
team_matching.py, when the opponent was actually one of:
  - Fresno Pacific University (NAIA, no row in our DB)
  - University of the Pacific (D1 WCC, id=32857)
  - something else that the NWAC scraper tagged "Pacific"

This script deletes the 16 ghost rows and their game_batting /
game_pitching children.

Usage:
    cd ~/Desktop/pnw-baseball
    PYTHONPATH=backend python3 scripts/cleanup_pacific_ghost_games.py --dry-run
    PYTHONPATH=backend python3 scripts/cleanup_pacific_ghost_games.py
"""

import argparse
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection


# Ghost game IDs with reasons. Keeping the annotations here so future-me
# can trace why each row was flagged.
GHOSTS = [
    # (game_id, reason)
    (676, "Feb 5  WOU — WOU actually played Fresno Pacific (URL slug: fresno-pacific)"),
    (677, "Feb 6  WOU — WOU actually played Fresno Pacific"),
    (678, "Feb 6  WOU gn=2 — WOU actually played Fresno Pacific"),
    (679, "Feb 7  WOU — WOU actually played Fresno Pacific"),
    (1623, "Feb 25 Clark — not on Pacific's 2026 schedule"),
    (1624, "Mar 8  Clark gn=1 — not on Pacific's 2026 schedule"),
    (1625, "Mar 8  Clark gn=2 — not on Pacific's 2026 schedule"),
    (1626, "Mar 19 Clark — not on Pacific's 2026 schedule"),
    (3014, "Mar 20 Seattle U — Seattle U played D1 Pacific (id=32857), Pluto API"),
    (3015, "Mar 21 Seattle U — Seattle U played D1 Pacific (id=32857), Pluto API"),
    (3016, "Mar 22 Seattle U — Seattle U played D1 Pacific (id=32857), Pluto API"),
    (1727, "Mar 25 Grays Harbor — not on Pacific's 2026 schedule"),
    (1728, "Mar 25 Grays Harbor gn=2 — not on Pacific's 2026 schedule"),
    (1188, "Mar 27 Gonzaga — Gonzaga played D1 Pacific (id=32857), gozags.com URL"),
    (1287, "Mar 28 Gonzaga — Gonzaga played D1 Pacific (id=32857), gozags.com URL"),
    (1400, "Mar 29 Gonzaga — Gonzaga played D1 Pacific (id=32857), gozags.com URL"),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="Report what would be deleted without deleting.")
    args = ap.parse_args()

    ghost_ids = [g[0] for g in GHOSTS]

    with get_connection() as conn:
        cur = conn.cursor()

        # Step 1: safety check — confirm every ghost row actually involves
        # Pacific (team_id=17). If not, bail loudly.
        cur.execute("""
            SELECT id, game_date, game_number, home_team_id, away_team_id,
                   home_score, away_score, source_url
            FROM games
            WHERE id = ANY(%s)
            ORDER BY id
        """, (ghost_ids,))
        rows = cur.fetchall()

        found_ids = {r["id"] for r in rows}
        missing = [gid for gid in ghost_ids if gid not in found_ids]
        if missing:
            print(f"WARNING: these IDs no longer exist in games: {missing}")

        bad_rows = [r for r in rows
                    if r["home_team_id"] != 17 and r["away_team_id"] != 17]
        if bad_rows:
            print("ABORT: some ghost IDs are NOT Pacific (id=17) games:")
            for r in bad_rows:
                print(f"  id={r['id']} home={r['home_team_id']} away={r['away_team_id']}")
            print("Refusing to delete — investigate before re-running.")
            return

        # Print what we're about to delete with its reason.
        print(f"Dry run: {args.dry_run}")
        print(f"Pacific ghost cleanup — {len(rows)} rows found of {len(ghost_ids)} expected")
        print()
        print(f"{'id':>5}  {'date':<11}  {'gn':>2}  "
              f"{'home':>6}  {'away':>6}  {'score':>7}  reason")
        reasons = {gid: reason for gid, reason in GHOSTS}
        for r in rows:
            score = f"{r['home_score']}-{r['away_score']}"
            print(f"{r['id']:>5}  {str(r['game_date']):<11}  {r['game_number']:>2}  "
                  f"{r['home_team_id']:>6}  {r['away_team_id']:>6}  "
                  f"{score:>7}  {reasons[r['id']]}")
        print()

        # Step 2: count children before deleting.
        cur.execute("""
            SELECT COUNT(*) AS cnt FROM game_batting WHERE game_id = ANY(%s)
        """, (ghost_ids,))
        batting_count = cur.fetchone()["cnt"]

        cur.execute("""
            SELECT COUNT(*) AS cnt FROM game_pitching WHERE game_id = ANY(%s)
        """, (ghost_ids,))
        pitching_count = cur.fetchone()["cnt"]

        print(f"Child rows involved:")
        print(f"  game_batting:  {batting_count}")
        print(f"  game_pitching: {pitching_count}")
        print()

        if args.dry_run:
            print("DRY RUN — nothing deleted. Re-run without --dry-run to apply.")
            return

        # Step 3: delete children, then games.
        cur.execute("DELETE FROM game_batting  WHERE game_id = ANY(%s)", (ghost_ids,))
        bat_del = cur.rowcount
        cur.execute("DELETE FROM game_pitching WHERE game_id = ANY(%s)", (ghost_ids,))
        pit_del = cur.rowcount
        cur.execute("DELETE FROM games WHERE id = ANY(%s)", (ghost_ids,))
        game_del = cur.rowcount

        conn.commit()

        print(f"Deleted:")
        print(f"  games:         {game_del}")
        print(f"  game_batting:  {bat_del}")
        print(f"  game_pitching: {pit_del}")


if __name__ == "__main__":
    main()
