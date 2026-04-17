"""
Force-rescrape ONE game for ONE team, no matter what's already in
the DB. Deletes that team's batting + pitching rows for the game,
fetches the box score page fresh, and re-inserts.

The scraper's insert_game_batting has temporary diagnostic prints
(`[BATTING-FIX-ACTIVE]` / `[BATTING-FIX]`) that will fire during
the insert. If we don't see those prints, the fix function isn't
actually being called — which would tell us the scraper hit a
caching or path issue.

Also clears any __pycache__ under scripts/ before importing so we
can be sure we're running the source-of-truth code.

Usage (from Mac, repo root):
    PYTHONPATH=backend python3 scripts/force_rescrape_one_game.py <game_id> <team>

Example:
    PYTHONPATH=backend python3 scripts/force_rescrape_one_game.py 3090 Bushnell
"""
import sys
import os
import shutil
import argparse

# ── Nuke bytecode caches before we import anything else ──
HERE = os.path.dirname(os.path.abspath(__file__))
for root, dirs, _ in os.walk(HERE):
    for d in list(dirs):
        if d == "__pycache__":
            shutil.rmtree(os.path.join(root, d), ignore_errors=True)

sys.path.insert(0, os.path.join(HERE, "..", "backend"))
sys.dont_write_bytecode = True  # don't re-create caches this run

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
            "SELECT id, name FROM teams WHERE short_name ILIKE %s OR name ILIKE %s LIMIT 1",
            (arg, arg),
        )
    r = cur.fetchone()
    return dict(r) if r else None


def detect_platform(url):
    url = (url or "").lower()
    if "prestosports" in url or "boxstat" in url:
        return "presto"
    return "sidearm"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("game_id", type=int)
    ap.add_argument("team")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        team = resolve_team(cur, args.team)
        if not team:
            print(f"No team found for: {args.team}")
            return
        tid = team["id"]

        cur.execute(
            """
            SELECT id, game_date, game_number, source_url,
                   home_team_id, away_team_id,
                   home_score, away_score, season
            FROM games WHERE id = %s
            """,
            (args.game_id,),
        )
        g = cur.fetchone()
        if not g:
            print(f"No game id={args.game_id}")
            return
        g = dict(g)

        if tid not in (g["home_team_id"], g["away_team_id"]):
            print(f"Team {team['name']} is not in game {args.game_id}")
            return

        side = "home" if tid == g["home_team_id"] else "away"
        print(f"\nGame {args.game_id}: {g['game_date']} g#{g['game_number']}  side={side}")
        print(f"  Source URL: {g['source_url']}")

        # Delete only this team's rows for this game
        cur.execute(
            "DELETE FROM game_batting  WHERE game_id = %s AND team_id = %s",
            (args.game_id, tid),
        )
        del_b = cur.rowcount
        cur.execute(
            "DELETE FROM game_pitching WHERE game_id = %s AND team_id = %s",
            (args.game_id, tid),
        )
        del_p = cur.rowcount
        conn.commit()
        print(f"  Deleted {del_b} batting, {del_p} pitching rows for {team['name']}.")

    # Fetch page fresh
    print(f"\nFetching {g['source_url']} ...")
    html = fetch_page(g["source_url"], retries=2, delay_range=(1.0, 2.0))
    if not html:
        print("  FAILED to fetch HTML.")
        return

    if detect_platform(g["source_url"]) == "presto":
        box = parse_presto_boxscore(html, "")
    else:
        base_url = "/".join(g["source_url"].split("/")[:3])
        box = parse_sidearm_boxscore(html, base_url)

    if not box:
        print("  Parser returned nothing.")
        return

    # Detect home/away flip via scores
    box_flipped = False
    bs_a, bs_h = box.get("away_score"), box.get("home_score")
    s_a, s_h = g.get("away_score"), g.get("home_score")
    if (bs_a is not None and bs_h is not None and s_a is not None and s_h is not None):
        if int(bs_a) == int(s_h) and int(bs_h) == int(s_a) and int(s_a) != int(s_h):
            box_flipped = True
            print(f"  Flip detected (box: {bs_a}-{bs_h}, sched: {s_a}-{s_h})")

    bh, ba = ("away", "home") if box_flipped else ("home", "away")
    raw_batting = box.get("batting") or {}
    raw_pitching = box.get("pitching") or {}

    # Pick just the rows for the team we're rescraping
    if side == "home":
        batting_rows = raw_batting.get(bh, [])
        pitching_rows = raw_pitching.get(bh, [])
    else:
        batting_rows = raw_batting.get(ba, [])
        pitching_rows = raw_pitching.get(ba, [])

    print(f"  Parsed {len(batting_rows)} {side} batting rows, "
          f"{len(pitching_rows)} {side} pitching rows"
          f"{'  (FLIPPED)' if box_flipped else ''}")

    # ── Insert via the shared scraper functions (which have diag prints) ──
    with get_connection() as conn:
        cur = conn.cursor()
        if batting_rows:
            insert_game_batting(cur, args.game_id, tid, batting_rows, g["season"])
        if pitching_rows:
            insert_game_pitching(cur, args.game_id, tid, pitching_rows, g["season"])
        conn.commit()
    print("\nDone.")


if __name__ == "__main__":
    main()
