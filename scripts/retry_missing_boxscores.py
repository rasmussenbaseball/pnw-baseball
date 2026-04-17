"""
Retry box-score scraping for games that ended up with NO batting rows.
Intended for one-off recovery after a scrape run had DB timeouts.

Unlike scripts/scrape_boxscores.py, this version:
  - Only looks at games with zero game_batting rows
  - Opens a fresh DB connection for EACH game (so one timeout doesn't
    take the whole script down)
  - Commits after every game
  - Only uses the already-stored source_url (does not re-fetch the
    team schedule page)

Usage:
    PYTHONPATH=backend python3 scripts/retry_missing_boxscores.py Bushnell
    PYTHONPATH=backend python3 scripts/retry_missing_boxscores.py Bushnell 2026
"""
import sys
import os
import argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

# Reuse the existing scraper's parsing + insert functions.
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


def find_missing_games(cur, team_id, season):
    """Games for this team that have zero game_batting rows
    FOR THIS SPECIFIC TEAM (opposing team's rows don't count)."""
    cur.execute(
        """
        SELECT g.id, g.game_date, g.game_number, g.source_url,
               g.home_team_id, g.away_team_id,
               g.home_score, g.away_score
        FROM games g
        WHERE g.season = %s
          AND g.status = 'final'
          AND (g.home_team_id = %s OR g.away_team_id = %s)
          AND g.source_url IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM game_batting gb
              WHERE gb.game_id = g.id AND gb.team_id = %s
          )
        ORDER BY g.game_date, g.game_number
        """,
        (season, team_id, team_id, team_id),
    )
    return [dict(r) for r in cur.fetchall()]


def detect_platform(source_url):
    """Very small guess — Sidearm or Presto — based on URL shape."""
    url = (source_url or "").lower()
    # PrestoSports usually has /boxscore/ and /sports/ too but distinct hosts
    # The Bushnell failures are all sidearm (bushnellbeacons.com). We keep
    # this simple; if a team needs presto we can extend.
    if "prestosports" in url or "boxstat" in url:
        return "presto"
    return "sidearm"


def retry_one_game(game, season):
    """Fetch, parse, and re-insert batting+pitching for a single game.
    Opens a fresh DB connection so a timeout here doesn't take down a
    long-running loop."""
    print(f"\n── {game['game_date']} g#{game.get('game_number') or 1}  {game['source_url']}")
    html = fetch_page(game["source_url"], retries=2, delay_range=(1.0, 2.0))
    if not html:
        print("   FAILED: could not fetch HTML")
        return False

    platform = detect_platform(game["source_url"])
    if platform == "presto":
        box = parse_presto_boxscore(html, "")
    else:
        base_url = "/".join(game["source_url"].split("/")[:3])
        box = parse_sidearm_boxscore(html, base_url)

    if not box:
        print("   FAILED: parser returned nothing")
        return False

    # ── Detect home/away flip using scores ──
    box_flipped = False
    bs_away = box.get("away_score")
    bs_home = box.get("home_score")
    s_away = game.get("away_score")
    s_home = game.get("home_score")
    if (bs_away is not None and bs_home is not None
            and s_away is not None and s_home is not None):
        if (int(bs_away) == int(s_home) and int(bs_home) == int(s_away)
                and int(s_away) != int(s_home)):
            box_flipped = True
            print(f"   Flip detected (box: {bs_away}-{bs_home}, sched: {s_away}-{s_home})")

    bh, ba = ("away", "home") if box_flipped else ("home", "away")

    raw_batting = box.get("batting") or {}
    raw_pitching = box.get("pitching") or {}
    box_batting = {
        "home": raw_batting.get(bh, []),
        "away": raw_batting.get(ba, []),
    }
    box_pitching = {
        "home": raw_pitching.get(bh, []),
        "away": raw_pitching.get(ba, []),
    }

    print(f"   Parsed {len(box_batting['away'])} away batters, "
          f"{len(box_batting['home'])} home batters, "
          f"{len(box_pitching['away'])} away pitchers, "
          f"{len(box_pitching['home'])} home pitchers"
          f"{'  (FLIPPED)' if box_flipped else ''}")

    # ── Fresh DB connection, quick work, commit, done ──
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute("DELETE FROM game_batting  WHERE game_id = %s", (game["id"],))
            cur.execute("DELETE FROM game_pitching WHERE game_id = %s", (game["id"],))

            if box_batting["home"]:
                insert_game_batting(cur, game["id"], game["home_team_id"],
                                    box_batting["home"], season)
            if box_batting["away"]:
                insert_game_batting(cur, game["id"], game["away_team_id"],
                                    box_batting["away"], season)
            if box_pitching["home"]:
                insert_game_pitching(cur, game["id"], game["home_team_id"],
                                     box_pitching["home"], season)
            if box_pitching["away"]:
                insert_game_pitching(cur, game["id"], game["away_team_id"],
                                     box_pitching["away"], season)
            conn.commit()
        print("   OK — inserted")
        return True
    except Exception as e:
        print(f"   DB FAILURE: {e}")
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("team")
    ap.add_argument("season", nargs="?", type=int, default=2026)
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()
        team = resolve_team(cur, args.team)
        if not team:
            print(f"No team found for: {args.team}")
            return
        tid = team["id"]
        missing = find_missing_games(cur, tid, args.season)

    if not missing:
        print(f"\nNo missing games for {team['name']} {args.season} — all games have batting rows.")
        return

    print(f"\n=== {team['name']} {args.season}: {len(missing)} game(s) need retry ===")
    for g in missing:
        print(f"  • {g['game_date']} g#{g.get('game_number') or 1}  {g['source_url']}")

    ok = 0
    for g in missing:
        if retry_one_game(g, args.season):
            ok += 1

    print(f"\nDone. {ok}/{len(missing)} recovered.")


if __name__ == "__main__":
    main()
