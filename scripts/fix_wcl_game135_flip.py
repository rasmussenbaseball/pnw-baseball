#!/usr/bin/env python3
"""
One-off repair: WCL game 135 (2026-06-17 AppleSox/Riverhawks nightcap) was
parsed with its two lineups reversed (the box-score parser keyed home/away off
table order). That created 28 shadow summer_players — the "same player on both
teams" bug. This re-points game 135's box-score + PBP rows back to the real
players, un-flips the game's score, deletes the shadows, and leaves season
aggregates to aggregate_summer_stats.py.

Run dry first, then --apply:
    PYTHONPATH=backend python3 scripts/fix_wcl_game135_flip.py
    PYTHONPATH=backend python3 scripts/fix_wcl_game135_flip.py --apply
"""
import sys, json, argparse
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
from app.models.database import get_connection

GID = 135
HOME, AWAY = 8, 2            # game 135: home=AppleSox(8), away=Riverhawks(2)
TEAMS = {HOME, AWAY}
def other(t): return (TEAMS - {t}).pop()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        # ── shadow -> real mapping (same name, opposite team) ──
        cur.execute("""SELECT player_id FROM summer_game_batting WHERE game_id=%s
                       UNION SELECT player_id FROM summer_game_pitching WHERE game_id=%s""", (GID, GID))
        shadows = sorted(r["player_id"] for r in cur.fetchall())
        mapping = {}
        for sid in shadows:
            cur.execute("SELECT team_id, first_name, last_name FROM summer_players WHERE id=%s", (sid,))
            s = cur.fetchone()
            cur.execute("""SELECT id FROM summer_players WHERE team_id=%s
                           AND lower(first_name)=lower(%s) AND lower(last_name)=lower(%s) AND id<>%s""",
                        (other(s["team_id"]), s["first_name"], s["last_name"], sid))
            reals = cur.fetchall()
            if len(reals) != 1:
                print(f"ABORT: shadow {sid} {s['first_name']} {s['last_name']} has {len(reals)} real matches")
                return
            mapping[sid] = {"real": reals[0]["id"], "real_team": other(s["team_id"]),
                            "name": f"{s['first_name']} {s['last_name']}"}
        print(f"{len(mapping)} shadow->real mappings resolved.")

        # ── backup ──
        backup = {"game_id": GID, "mapping": mapping}
        for tbl in ("summer_game_batting", "summer_game_pitching", "summer_game_events"):
            cur.execute(f"SELECT * FROM {tbl} WHERE game_id=%s", (GID,))
            backup[tbl] = [dict(r) for r in cur.fetchall()]
        cur.execute("SELECT * FROM summer_games WHERE id=%s", (GID,))
        backup["summer_games"] = [dict(r) for r in cur.fetchall()]
        cur.execute("SELECT * FROM summer_players WHERE id=ANY(%s)", (shadows,))
        backup["shadow_players"] = [dict(r) for r in cur.fetchall()]
        bpath = f"/tmp/wcl_game135_backup.json"
        Path(bpath).write_text(json.dumps(backup, default=str, indent=2))
        print(f"backup written to {bpath} ({len(backup['summer_game_events'])} events, "
              f"{len(backup['shadow_players'])} shadow players)")

        if not args.apply:
            print("\nDRY RUN — re-point game-135 batting/pitching/events to real players, "
                  "swap away<->home score/hits/errors/line, fix links, delete 28 shadows.\n"
                  "Re-run with --apply to execute, then run aggregate_summer_stats + compute_summer_advanced.")
            return

        # ── re-point box score + PBP rows, set correct team/is_home ──
        for sid, m in mapping.items():
            rid, rteam = m["real"], m["real_team"]
            is_home = (rteam == HOME)
            cur.execute("UPDATE summer_game_batting  SET player_id=%s, team_id=%s, is_home=%s WHERE game_id=%s AND player_id=%s",
                        (rid, rteam, is_home, GID, sid))
            cur.execute("UPDATE summer_game_pitching SET player_id=%s, team_id=%s, is_home=%s WHERE game_id=%s AND player_id=%s",
                        (rid, rteam, is_home, GID, sid))
            cur.execute("UPDATE summer_game_events SET batter_player_id=%s  WHERE game_id=%s AND batter_player_id=%s",  (rid, GID, sid))
            cur.execute("UPDATE summer_game_events SET pitcher_player_id=%s WHERE game_id=%s AND pitcher_player_id=%s", (rid, GID, sid))
            # summer_player_links: re-point to real unless real already linked.
            cur.execute("SELECT 1 FROM summer_player_links WHERE summer_player_id=%s", (rid,))
            if cur.fetchone():
                cur.execute("DELETE FROM summer_player_links WHERE summer_player_id=%s", (sid,))
            else:
                cur.execute("UPDATE summer_player_links SET summer_player_id=%s WHERE summer_player_id=%s", (rid, sid))

        # ── un-flip the game header (away<->home) ──
        cur.execute("""UPDATE summer_games SET
                         away_score=home_score, home_score=away_score,
                         away_hits=home_hits,   home_hits=away_hits,
                         away_errors=home_errors, home_errors=away_errors,
                         away_line_score=home_line_score, home_line_score=away_line_score
                       WHERE id=%s""", (GID,))

        # ── delete shadow players + their phantom season lines ──
        cur.execute("DELETE FROM summer_batting_stats  WHERE player_id=ANY(%s)", (shadows,))
        cur.execute("DELETE FROM summer_pitching_stats WHERE player_id=ANY(%s)", (shadows,))
        cur.execute("DELETE FROM summer_players WHERE id=ANY(%s)", (shadows,))

        conn.commit()
        print(f"APPLIED. Re-pointed game {GID}, deleted {len(shadows)} shadow players. "
              "Now run: aggregate_summer_stats.py --league WCL --season 2026 ; compute_summer_advanced.py --season 2026")


if __name__ == "__main__":
    main()
