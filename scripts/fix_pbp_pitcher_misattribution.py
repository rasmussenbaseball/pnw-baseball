"""
Fix PBP pitcher mis-attribution: games where game_events.pitcher_player_id
points at a position player (has batting_stats, no pitching_stats) instead
of the real pitcher.

Two failure modes get repaired automatically:
  1. sole-pitcher  — the box score lists exactly ONE pitcher for that team
                     in that game, so the whole mislabeled stint is his
                     (e.g. Eli Pupo's 32 events → Austin Wolfe's complete game).
  2. name-match    — the box score has a pitcher with the SAME last name but a
                     different (real, pitching_stats-backed) player_id. This is
                     a player-identity split: the box linker and the PBP linker
                     picked different rows for the same human. Repoint the
                     events at the pitching row (e.g. "Ty Shepard" → Troy
                     Shepard, "Cody Sazama" the C-row → the P-row).

Anything that can't be resolved this way is LEFT ALONE and printed under
"MANUAL / skipped" (e.g. Rhett Hays, who really did pitch — his box row just
never linked, so his PBP is already correct).

Only game_events rows are touched: pitcher_player_id (and pitcher_name for
consistency). Per-event WPA is unaffected (it doesn't depend on identity), so
no recompute is needed. Box scores / pitching_stats are never modified.

Usage:
    PYTHONPATH=backend python3 scripts/fix_pbp_pitcher_misattribution.py           # dry run
    PYTHONPATH=backend python3 scripts/fix_pbp_pitcher_misattribution.py --commit  # apply
"""
import sys
from app.models.database import get_connection


# Genuine mis-attributions with an unambiguous target that the automatic
# rules can't reach. (game_id, bad_pid) -> correct pitcher player_id.
#   g3474: the opening 3-inning stint was mislabeled "Hiroshi Johnson" and
#   linked to Bryce Johnson (a Skagit position player). The box score's
#   starter for that stint is Colton Romero (id1140, BF18, pitch_order 1).
MANUAL_OVERRIDES = {
    (3474, 5334): 1140,
}


def last_name(name):
    if not name:
        return ""
    name = name.strip()
    if "," in name:            # "Shepard, Troy" / "Hays, Jr" / "GEORGE,IKE"
        return name.split(",")[0].strip().lower()
    return name.split()[-1].lower()  # "Ty Shepard" / "I. Fendel"


def resolve():
    commit = "--commit" in sys.argv
    with get_connection() as conn:
        _resolve(conn, commit)


def _resolve(conn, commit):
    cur = conn.cursor()

    # Every (game, defending_team, bad_pid) where the PBP pitcher is a real
    # position player (bats, never pitches).
    cur.execute("""
        SELECT ge.game_id, ge.defending_team_id AS team, ge.pitcher_player_id AS bad_pid,
               p.first_name, p.last_name,
               count(*) AS ev, min(ge.inning) AS mn, max(ge.inning) AS mx
        FROM game_events ge
        JOIN players p ON ge.pitcher_player_id = p.id
        WHERE EXISTS (SELECT 1 FROM batting_stats bs WHERE bs.player_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM pitching_stats ps WHERE ps.player_id = p.id)
        GROUP BY ge.game_id, ge.defending_team_id, ge.pitcher_player_id, p.first_name, p.last_name
        ORDER BY p.last_name, ge.game_id
    """)
    polluted = [dict(r) for r in cur.fetchall()]

    plans, skips = [], []
    for r in polluted:
        gid, team, bad_pid = r["game_id"], r["team"], r["bad_pid"]
        bad_last = (r["last_name"] or "").lower()

        # Is this player himself in the box-score pitching for this game? If so
        # his PBP is CORRECT — he really pitched (a position player who threw a
        # mop-up inning, or whose season pitching line just never aggregated).
        # Never reassign those.
        cur.execute("""SELECT 1 FROM game_pitching
                       WHERE game_id = %s AND team_id = %s AND player_id = %s LIMIT 1""",
                    (gid, team, bad_pid))
        in_box = cur.fetchone() is not None

        # Box-score pitchers for this team/game that have a real id and an
        # actual season pitching line (i.e. valid reassignment targets).
        cur.execute("""
            SELECT gp.player_id, gp.player_name, gp.pitch_order,
                   pl.first_name, pl.last_name
            FROM game_pitching gp
            JOIN players pl ON gp.player_id = pl.id
            WHERE gp.game_id = %s AND gp.team_id = %s
              AND gp.player_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM pitching_stats ps WHERE ps.player_id = gp.player_id)
            ORDER BY gp.pitch_order
        """, (gid, team))
        box = [dict(b) for b in cur.fetchall()]

        target, rule = None, None
        if in_box:
            rule = None  # correct PBP — leave it
        elif (gid, bad_pid) in MANUAL_OVERRIDES:
            tid = MANUAL_OVERRIDES[(gid, bad_pid)]
            target = next((b for b in box if b["player_id"] == tid), None)
            rule = "manual-override"
        else:
            same = [b for b in box
                    if b["player_id"] != bad_pid
                    and (b["last_name"] or "").lower() == bad_last]
            if len(same) == 1:
                target, rule = same[0], "name-match"
            elif len(box) == 1 and box[0]["player_id"] != bad_pid:
                target, rule = box[0], "sole-pitcher"

        if target:
            tname = f"{target['first_name'] or ''} {target['last_name'] or ''}".strip()
            plans.append({**r, "target_id": target["player_id"], "target_name": tname, "rule": rule})
        else:
            boxstr = ", ".join(f"{b['player_name']}(id{b['player_id']})" for b in box) or "none"
            reason = "PBP correct (player is in box score)" if in_box else "no unambiguous target"
            skips.append({**r, "box": boxstr, "reason": reason})

    print(f"=== {len(plans)} reassignments planned, {len(skips)} skipped ===\n")
    for p in plans:
        print(f"  g{p['game_id']:<5} {p['first_name']} {p['last_name']:14} id{p['bad_pid']} "
              f"({p['ev']} ev, inn{p['mn']}-{p['mx']})  →  {p['target_name']} id{p['target_id']}  [{p['rule']}]")
    if skips:
        print("\n  --- MANUAL / skipped (left as-is) ---")
        for s in skips:
            print(f"  g{s['game_id']:<5} {s['first_name']} {s['last_name']:14} id{s['bad_pid']} "
                  f"({s['ev']} ev, inn{s['mn']}-{s['mx']})  — {s['reason']}")

    if not commit:
        print("\nDRY RUN — re-run with --commit to apply.")
        return

    total = 0
    for p in plans:
        cur.execute("""
            UPDATE game_events
            SET pitcher_player_id = %s, pitcher_name = %s
            WHERE game_id = %s AND defending_team_id = %s AND pitcher_player_id = %s
        """, (p["target_id"], p["target_name"], p["game_id"], p["team"], p["bad_pid"]))
        total += cur.rowcount
    conn.commit()
    print(f"\nCOMMITTED — {total} game_events rows reassigned across {len(plans)} game/pitcher groups.")


if __name__ == "__main__":
    resolve()
