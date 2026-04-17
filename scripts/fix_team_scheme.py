"""
Clean up old-scheme game_batting rows for a team+season and force-rescrape
every one of their games so the data lines up with the current scraper
(starters at batting_order 1-9, subs/non-batting pitchers at 100+).

What it does, per team:
  1. Reports current row breakdown (1-9, 10-99, 100+)
  2. Deletes all game_batting rows at batting_order BETWEEN 10 AND 99
     for this team's games in the given season
  3. For each of the team's games: re-fetches the box score page and
     re-inserts batting + pitching rows via the current insert_game_*
     functions (which use the new scheme)
  4. Reports the final breakdown + a diff

Usage (on Mac, from repo root):
    PYTHONPATH=backend python3 scripts/fix_team_scheme.py Bushnell 2026

Or pass a team id:
    PYTHONPATH=backend python3 scripts/fix_team_scheme.py 24 2026
"""
import argparse
import os
import random
import shutil
import sys
import time

# Nuke bytecode caches before we import anything
HERE = os.path.dirname(os.path.abspath(__file__))
for root, dirs, _ in os.walk(HERE):
    for d in list(dirs):
        if d == "__pycache__":
            shutil.rmtree(os.path.join(root, d), ignore_errors=True)

sys.path.insert(0, os.path.join(HERE, "..", "backend"))
sys.dont_write_bytecode = True

from scrape_boxscores import (  # noqa: E402
    fetch_page,
    parse_sidearm_boxscore,
    parse_presto_boxscore,
    insert_game_batting,
    insert_game_pitching,
)
from app.models.database import get_connection  # noqa: E402


def resolve_team(cur, arg):
    if arg.isdigit():
        cur.execute("SELECT id, name FROM teams WHERE id = %s", (int(arg),))
    else:
        cur.execute(
            "SELECT id, name FROM teams "
            "WHERE short_name ILIKE %s OR name ILIKE %s LIMIT 1",
            (arg, arg),
        )
    r = cur.fetchone()
    return dict(r) if r else None


def detect_platform(url):
    url = (url or "").lower()
    if "prestosports" in url or "boxstat" in url:
        return "presto"
    return "sidearm"


def scheme_breakdown(cur, team_id, season):
    cur.execute(
        """
        SELECT
            SUM(CASE WHEN batting_order BETWEEN 1 AND 9 THEN 1 ELSE 0 END) AS starters,
            SUM(CASE WHEN batting_order BETWEEN 10 AND 99 THEN 1 ELSE 0 END) AS old_subs,
            SUM(CASE WHEN batting_order >= 100 THEN 1 ELSE 0 END) AS new_subs,
            COUNT(*) AS total
        FROM game_batting gb
        JOIN games g ON g.id = gb.game_id
        WHERE gb.team_id = %s AND g.season = %s
        """,
        (team_id, season),
    )
    r = cur.fetchone()
    return {
        "starters": r["starters"] or 0,
        "old_subs": r["old_subs"] or 0,
        "new_subs": r["new_subs"] or 0,
        "total": r["total"] or 0,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("team", help="team id or short/full name")
    ap.add_argument("season", type=int)
    ap.add_argument(
        "--no-rescrape",
        action="store_true",
        help="Only delete old-scheme rows, skip the re-scrape. Useful for a "
             "quick cleanup if you plan to re-run the main scraper yourself.",
    )
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()
        team = resolve_team(cur, args.team)
        if not team:
            print(f"No team found for: {args.team}")
            return
        tid = team["id"]
        print(f"\n=== {team['name']} (id={tid}) season {args.season} ===")

        before = scheme_breakdown(cur, tid, args.season)
        print("\nBefore:")
        print(f"  Starters (1-9):  {before['starters']}")
        print(f"  Old subs (10-99): {before['old_subs']}")
        print(f"  New subs (>=100): {before['new_subs']}")
        print(f"  Total:           {before['total']}")

        # 1. Delete all old-scheme rows
        cur.execute(
            """
            DELETE FROM game_batting
            USING games g
            WHERE game_batting.game_id = g.id
              AND game_batting.team_id = %s
              AND g.season = %s
              AND game_batting.batting_order BETWEEN 10 AND 99
            """,
            (tid, args.season),
        )
        deleted = cur.rowcount
        conn.commit()
        print(f"\nDeleted {deleted} old-scheme rows.")

        if args.no_rescrape:
            after = scheme_breakdown(cur, tid, args.season)
            print("\nAfter delete-only:")
            print(f"  Starters (1-9):  {after['starters']}")
            print(f"  Old subs (10-99): {after['old_subs']}")
            print(f"  New subs (>=100): {after['new_subs']}")
            print("\nDone. Re-run the main scraper to repopulate sub rows.")
            return

        # 2. Collect every game this team played in this season
        cur.execute(
            """
            SELECT id, game_date, game_number, source_url,
                   home_team_id, away_team_id,
                   home_score, away_score
            FROM games
            WHERE season = %s
              AND (home_team_id = %s OR away_team_id = %s)
              AND source_url IS NOT NULL
            ORDER BY game_date, id
            """,
            (args.season, tid, tid),
        )
        games = [dict(r) for r in cur.fetchall()]
        print(f"\nFound {len(games)} games to re-scrape.")

    # 3. Re-scrape each game (force-delete + re-insert)
    ok = 0
    fail = 0
    for i, g in enumerate(games, 1):
        side = "home" if tid == g["home_team_id"] else "away"
        print(f"\n[{i}/{len(games)}] game_id={g['id']} {g['game_date']} "
              f"g#{g['game_number']} side={side}")
        print(f"  URL: {g['source_url']}")

        # Delete this team's batting + pitching rows for this game so
        # re-insert doesn't collide on the unique key.
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                "DELETE FROM game_batting WHERE game_id=%s AND team_id=%s",
                (g["id"], tid),
            )
            db = cur.rowcount
            cur.execute(
                "DELETE FROM game_pitching WHERE game_id=%s AND team_id=%s",
                (g["id"], tid),
            )
            dp = cur.rowcount
            conn.commit()
            print(f"  wiped {db} batting, {dp} pitching rows")

        html = fetch_page(g["source_url"], retries=2, delay_range=(1.0, 2.0))
        if not html:
            print("  FAILED to fetch HTML.")
            fail += 1
            continue

        if detect_platform(g["source_url"]) == "presto":
            box = parse_presto_boxscore(html, "")
        else:
            base_url = "/".join(g["source_url"].split("/")[:3])
            box = parse_sidearm_boxscore(html, base_url)

        if not box:
            print("  Parser returned nothing.")
            fail += 1
            continue

        # Detect home/away flip via scores
        box_flipped = False
        bs_a, bs_h = box.get("away_score"), box.get("home_score")
        s_a, s_h = g.get("away_score"), g.get("home_score")
        if bs_a is not None and bs_h is not None and s_a is not None and s_h is not None:
            if int(bs_a) == int(s_h) and int(bs_h) == int(s_a) and int(s_a) != int(s_h):
                box_flipped = True

        bh, ba = ("away", "home") if box_flipped else ("home", "away")
        raw_batting = box.get("batting") or {}
        raw_pitching = box.get("pitching") or {}

        if side == "home":
            batting_rows = raw_batting.get(bh, [])
            pitching_rows = raw_pitching.get(bh, [])
        else:
            batting_rows = raw_batting.get(ba, [])
            pitching_rows = raw_pitching.get(ba, [])

        print(f"  parsed {len(batting_rows)} batting, "
              f"{len(pitching_rows)} pitching"
              f"{' (FLIPPED)' if box_flipped else ''}")

        with get_connection() as conn:
            cur = conn.cursor()
            try:
                if batting_rows:
                    insert_game_batting(cur, g["id"], tid, batting_rows, args.season)
                if pitching_rows:
                    insert_game_pitching(cur, g["id"], tid, pitching_rows, args.season)
                conn.commit()
                ok += 1
            except Exception as e:
                conn.rollback()
                print(f"  INSERT FAILED: {e}")
                fail += 1

        # Polite delay between requests
        time.sleep(random.uniform(1.0, 2.0))

    # 4. Final report
    with get_connection() as conn:
        cur = conn.cursor()
        after = scheme_breakdown(cur, tid, args.season)

    print("\n" + "=" * 60)
    print(f"Re-scrape complete: {ok} ok, {fail} failed")
    print("\nAfter:")
    print(f"  Starters (1-9):  {after['starters']}")
    print(f"  Old subs (10-99): {after['old_subs']}")
    print(f"  New subs (>=100): {after['new_subs']}")
    print(f"  Total:           {after['total']}")
    if after["old_subs"] == 0 and after["new_subs"] > 0:
        print("\nVERDICT: Clean. Scheme is correct.")
    elif after["old_subs"] == 0 and after["new_subs"] == 0:
        print("\nVERDICT: No sub rows produced. Box-score parser may not "
              "be emitting PH/PR/CR entries, or this team just never had "
              "subs. Worth spot-checking one game manually.")
    else:
        print(f"\nVERDICT: Still {after['old_subs']} old-scheme rows. "
              "Something is wrong.")


if __name__ == "__main__":
    main()
