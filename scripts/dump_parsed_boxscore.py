"""
Parse a single game's box score and DUMP the raw player_lines for one team
in the order the parser returns them. Doesn't touch the DB. Useful for
debugging why a real starter is ending up at batting_order 100+ after the
scraper runs.

Usage (from Mac or server, from repo root):
    PYTHONPATH=backend python3 scripts/dump_parsed_boxscore.py <game_id> <team>

Example:
    PYTHONPATH=backend python3 scripts/dump_parsed_boxscore.py 917 Bushnell
"""
import argparse
import os
import shutil
import sys

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
            SELECT id, game_date, source_url,
                   home_team_id, away_team_id,
                   home_score, away_score
            FROM games WHERE id = %s
            """,
            (args.game_id,),
        )
        g = cur.fetchone()
        if not g:
            print(f"No game id={args.game_id}")
            return
        g = dict(g)

    side = "home" if tid == g["home_team_id"] else "away"
    print(f"Game {args.game_id}: {g['game_date']}  {team['name']} side={side}")
    print(f"URL: {g['source_url']}\n")

    html = fetch_page(g["source_url"], retries=2, delay_range=(1.0, 2.0))
    if not html:
        print("FAILED to fetch HTML.")
        return

    if detect_platform(g["source_url"]) == "presto":
        box = parse_presto_boxscore(html, "")
    else:
        base_url = "/".join(g["source_url"].split("/")[:3])
        box = parse_sidearm_boxscore(html, base_url)

    if not box:
        print("Parser returned nothing.")
        return

    # Detect home/away flip via scores
    bs_a, bs_h = box.get("away_score"), box.get("home_score")
    s_a, s_h = g.get("away_score"), g.get("home_score")
    box_flipped = False
    if bs_a is not None and bs_h is not None and s_a is not None and s_h is not None:
        if int(bs_a) == int(s_h) and int(bs_h) == int(s_a) and int(s_a) != int(s_h):
            box_flipped = True
            print("*** Box score home/away FLIPPED relative to schedule ***\n")

    bh, ba = ("away", "home") if box_flipped else ("home", "away")
    batting = box.get("batting") or {}

    rows = batting.get(bh if side == "home" else ba, [])
    print(f"{len(rows)} batting rows returned by parser for this team:\n")

    SUB_POSITIONS = {"PR", "PH", "CR"}
    lineup_slot = 0
    extra_slot = 100

    print(f"  #  | parsed_pos  | AB | player_name                      |"
          f" is_sub? | is_nonbat_P? | assigned_bo")
    print("  ---+-------------+----+----------------------------------+"
          "---------+--------------+------------")

    for i, p in enumerate(rows):
        pos = (p.get("position") or "").upper().strip()
        primary = pos.split("/")[0].strip()
        ab = p.get("ab", 0) or 0
        is_sub = primary in SUB_POSITIONS
        is_nbp = primary == "P" and ab == 0

        if is_sub or is_nbp:
            bo = extra_slot
            extra_slot += 1
        else:
            lineup_slot += 1
            if lineup_slot <= 9:
                bo = lineup_slot
            else:
                bo = extra_slot
                extra_slot += 1

        flag_sub = "YES" if is_sub else "   "
        flag_nbp = "YES" if is_nbp else "   "
        print(
            f"  {i+1:<2} | {pos:<11} | {ab:>2} | "
            f"{(p.get('player_name') or '?'):<32} | "
            f"  {flag_sub}   |      {flag_nbp}     |  {bo}"
        )


if __name__ == "__main__":
    main()
