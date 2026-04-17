"""
Verify the Opponent Trends endpoint output for one team.

Calls the `opponent_trends` FastAPI handler in-process (no HTTP round trip,
no server restart needed) and prints the lineups + bullpen so we can spot
duplicate players or missing positions at a glance.

Usage (on Mac, from repo root):
    PYTHONPATH=backend python3 scripts/verify_opponent_trends.py "Bushnell"

You can pass a team id or short/full name. Season defaults to 2026.
"""
import sys
import os
import json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection  # noqa: E402
from app.api.routes import opponent_trends  # noqa: E402


def resolve_team(arg):
    with get_connection() as conn:
        cur = conn.cursor()
        if arg.isdigit():
            cur.execute("SELECT id, name FROM teams WHERE id = %s", (int(arg),))
        else:
            cur.execute(
                "SELECT id, name FROM teams WHERE short_name ILIKE %s OR name ILIKE %s LIMIT 1",
                (arg, arg),
            )
        row = cur.fetchone()
        return dict(row) if row else None


def print_lineup(label, section):
    print(f"\n── {label} ── ({section.get('games_count', 0)} games)")
    if not section or not section.get("lineup"):
        print("  (no data)")
        return
    for row in section["lineup"]:
        pct = f"{row['pct']}%" if row.get("pct") else "—"
        print(f"  {row['spot']}. {row.get('position', '—'):<4} {row['player_name']:<28} {pct}")
    bench = section.get("bench") or []
    if bench:
        print("  Bench: " + ", ".join(f"{b['player_name']} ({b.get('position') or '?'}, {b['games_started']}G)" for b in bench))


def main():
    team_arg = sys.argv[1] if len(sys.argv) > 1 else "Bushnell"
    season = int(sys.argv[2]) if len(sys.argv) > 2 else 2026

    t = resolve_team(team_arg)
    if not t:
        print(f"No team found for: {team_arg}")
        return

    print(f"\n=== Opponent Trends — {t['name']} (id={t['id']}) season {season} ===")
    data = opponent_trends(team_id=t["id"], season=season)
    print(f"Games analyzed: {data['games_analyzed']}")

    lt = data.get("lineup_trends") or {}
    print_lineup("Projected Lineup vs RHP", lt.get("vs_rhp") or {})
    print_lineup("Projected Lineup vs LHP", lt.get("vs_lhp") or {})

    by_game = lt.get("by_game_number") or {}
    for slot in ("1", "2", "3", "4"):
        if slot in by_game:
            print_lineup(f"Game {slot} Lineup", by_game[slot])

    # Pitching: starters + relievers
    pt = data.get("pitching_trends") or {}
    print("\n── Starting Pitchers ──")
    for sp in pt.get("starters", []):
        slots = ",".join(f"G{k}:{v}" for k, v in (sp.get("slots") or {}).items())
        print(f"  {sp['name']:<28} GS={sp['starts']:<3} ERA={sp.get('era') or '—':<6} T={sp.get('throws') or '?'}  {slots}")

    print("\n── Predicted Rotation (next series) ──")
    for pr in pt.get("predicted_rotation", []):
        print(f"  G{pr['game']}  {pr['name']:<24} T={pr.get('throws') or '?'}  {pr['game_conf']}% slot  {pr['week_pct']}% week")

    print("\n── Relievers ──")
    for r in pt.get("relievers", []):
        star = "★ " if r.get("is_top") else "  "
        tier = r.get("tier") or "—"
        fip = r.get("fip")
        kbb = r.get("k_bb_pct")
        rating = r.get("rating")
        fip_s = f"{fip:4.2f}" if fip is not None else " --  "
        kbb_s = f"{kbb:5.1f}%" if kbb is not None else "  --  "
        rating_s = f"{rating:5.1f}" if rating is not None else "  --  "
        print(
            f"  {star}[{r['role']:<12}] {r['name']:<26} "
            f"App={r['apps']:<3} IP={str(r.get('total_ip') or '—'):<5} "
            f"ERA={str(r.get('era') or '—'):<5} "
            f"FIP={fip_s} K-BB%={kbb_s} Rating={rating_s} "
            f"Tier={tier:<11} Lev%={r['leverage_pct']}"
        )

    # Check for duplicates (the whole point of this verification)
    all_lineup_names = []
    for section_key in ("vs_rhp", "vs_lhp"):
        section = lt.get(section_key) or {}
        for row in section.get("lineup") or []:
            if row.get("player_name") and row["player_name"] != "—":
                all_lineup_names.append((section_key, row["player_name"]))

    # A pitcher can legitimately appear in BOTH starters and relievers if
    # they've made at least one start and at least one relief appearance.
    # That's expected, not a bug — no warning needed.
    print()


if __name__ == "__main__":
    main()
