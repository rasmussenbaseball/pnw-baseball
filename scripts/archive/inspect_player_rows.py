"""
Dump every raw game_batting row for one player (across all name variants)
so we can see what the box-score scraper actually wrote into the DB.

Usage:
    PYTHONPATH=backend python3 scripts/inspect_player_rows.py Bushnell Fahland
    PYTHONPATH=backend python3 scripts/inspect_player_rows.py Bushnell Jennings

Arguments:
  1) team (id or short/full name)
  2) last-name substring to match against the players table
  3) (optional) season — defaults to 2026
"""
import sys
import os

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
    if len(sys.argv) < 3:
        print("Usage: inspect_player_rows.py <team> <last_name_substring> [season]")
        return
    team_arg = sys.argv[1]
    last_sub = sys.argv[2]
    season = int(sys.argv[3]) if len(sys.argv) > 3 else 2026

    with get_connection() as conn:
        cur = conn.cursor()
        team = resolve_team(cur, team_arg)
        if not team:
            print(f"No team matching: {team_arg}")
            return
        team_id = team["id"]
        print(f"\n=== {team['name']} (id={team_id}) season {season} ===")

        # Find matching players by last-name substring
        cur.execute(
            """
            SELECT id, first_name, last_name
            FROM players
            WHERE team_id = %s AND last_name ILIKE %s
            ORDER BY last_name, first_name
            """,
            (team_id, f"%{last_sub}%"),
        )
        players = [dict(r) for r in cur.fetchall()]
        if not players:
            print(f"No players with last-name match: {last_sub}")
            return

        for p in players:
            print(f"\n── Player {p['first_name']} {p['last_name']} (id={p['id']}) ──")

            # Find every batting row — by player_id OR by any name variant
            cur.execute(
                """
                SELECT gb.game_id, g.game_date, g.game_number,
                       gb.player_id, gb.player_name,
                       gb.batting_order, gb.position,
                       gb.at_bats, gb.hits,
                       CASE WHEN g.home_team_id = %s THEN at2.short_name
                            ELSE ht.short_name END AS opp
                FROM game_batting gb
                JOIN games g ON gb.game_id = g.id
                LEFT JOIN teams ht ON g.home_team_id = ht.id
                LEFT JOIN teams at2 ON g.away_team_id = at2.id
                WHERE gb.team_id = %s
                  AND g.season = %s AND g.status = 'final'
                  AND (gb.player_id = %s
                       OR gb.player_name ILIKE %s
                       OR gb.player_name ILIKE %s)
                ORDER BY g.game_date, g.game_number, gb.batting_order NULLS LAST
                """,
                (team_id, team_id, season, p["id"],
                 f"%{p['last_name']}%", f"%{p['last_name'][:6]}%"),
            )
            rows = cur.fetchall()
            print(f"  {len(rows)} row(s) across all name variants\n")
            print(f"  {'date':<12}{'opp':<14}{'g#':<4}{'pid':<6}{'order':<7}{'pos':<10}{'ab':<4}{'h':<4}{'name'}")
            for r in rows:
                date = str(r["game_date"])
                opp = (r["opp"] or "")[:12]
                gnum = str(r["game_number"] or "")
                pid = str(r["player_id"]) if r["player_id"] is not None else "null"
                order = str(r["batting_order"]) if r["batting_order"] is not None else "null"
                pos = (r["position"] or "")[:9]
                ab = str(r["at_bats"] if r["at_bats"] is not None else "")
                h = str(r["hits"] if r["hits"] is not None else "")
                name = r["player_name"] or ""
                print(f"  {date:<12}{opp:<14}{gnum:<4}{pid:<6}{order:<7}{pos:<10}{ab:<4}{h:<4}{name}")

        print()


if __name__ == "__main__":
    main()
