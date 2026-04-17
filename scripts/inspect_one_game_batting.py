"""
Dump every game_batting row for one game so we can see exactly what
batting_order values the scraper wrote. Helps diagnose whether the
scraper fix (1-9 for starters, 100+ for subs) is in effect.

Usage:
    PYTHONPATH=backend python3 scripts/inspect_one_game_batting.py <game_id>

Or find a game by date/team:
    PYTHONPATH=backend python3 scripts/inspect_one_game_batting.py --date 2026-04-12 --team Bushnell --gnum 1
"""
import sys
import os
import argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("game_id", nargs="?", type=int)
    ap.add_argument("--date")
    ap.add_argument("--team")
    ap.add_argument("--gnum", type=int, default=1)
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        if args.game_id:
            game_id = args.game_id
        else:
            if not (args.date and args.team):
                print("Provide game_id or --date + --team")
                return
            team = resolve_team(cur, args.team)
            if not team:
                print(f"No team: {args.team}")
                return
            cur.execute(
                """
                SELECT id FROM games
                WHERE game_date = %s
                  AND (home_team_id = %s OR away_team_id = %s)
                  AND game_number = %s
                  AND status = 'final'
                LIMIT 1
                """,
                (args.date, team["id"], team["id"], args.gnum),
            )
            r = cur.fetchone()
            if not r:
                print(f"No game found for {args.team} {args.date} g#{args.gnum}")
                return
            game_id = r["id"]

        cur.execute(
            """
            SELECT g.game_date, g.game_number,
                   COALESCE(ht.short_name, ht.name) AS home,
                   COALESCE(at2.short_name, at2.name) AS away
            FROM games g
            LEFT JOIN teams ht ON g.home_team_id = ht.id
            LEFT JOIN teams at2 ON g.away_team_id = at2.id
            WHERE g.id = %s
            """,
            (game_id,),
        )
        gi = dict(cur.fetchone())
        print(f"\nGame id={game_id}  {gi['game_date']} g#{gi['game_number']}  "
              f"{gi['away']} @ {gi['home']}\n")

        cur.execute(
            """
            SELECT gb.team_id,
                   COALESCE(t.short_name, t.name) AS team_short,
                   gb.batting_order, gb.position,
                   gb.player_name, gb.at_bats, gb.hits
            FROM game_batting gb
            LEFT JOIN teams t ON gb.team_id = t.id
            WHERE gb.game_id = %s
            ORDER BY gb.team_id, gb.batting_order NULLS LAST
            """,
            (game_id,),
        )
        rows = [dict(r) for r in cur.fetchall()]

        if not rows:
            print("  (no batting rows)")
            return

        current_team = None
        for r in rows:
            if r["team_id"] != current_team:
                print(f"\n── {r['team_short']} ──")
                print(f"{'order':<6}{'pos':<8}{'ab':<4}{'h':<4}player")
                current_team = r["team_id"]
            order = str(r["batting_order"]) if r["batting_order"] is not None else "null"
            pos = (r["position"] or "")[:7]
            ab = str(r["at_bats"] if r["at_bats"] is not None else "")
            h = str(r["hits"] if r["hits"] is not None else "")
            print(f"{order:<6}{pos:<8}{ab:<4}{h:<4}{r['player_name']}")

        print()


if __name__ == "__main__":
    main()
