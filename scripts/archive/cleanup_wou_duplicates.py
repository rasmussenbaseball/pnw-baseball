"""
Targeted cleanup for the WOU duplicate-game issue identified 2026-04-20.

Deletes the following 5 rows from games (and cascade-deletes their
game_batting + game_pitching rows):

  gid 3291   — 2026-04-16 home/away flipped duplicate of gid 3290
  gid 3428   — 2026-04-17 g#1 NULL-opponent orphan of gid 3314
  gid 3429   — 2026-04-17 g#2 NULL-opponent orphan of gid 3320
  gid 3430   — 2026-04-18 g#1 NULL-opponent orphan of gid 3383
  gid 3431   — 2026-04-18 g#2 NULL-opponent orphan of gid 3384

All 5 were identified in diagnose_wou_pitching.py.

SAFETY:
  * Default is dry-run — prints what would be deleted and exits.
  * Add --confirm to actually delete.
  * Verifies each kept game has MORE game_batting + game_pitching rows than
    its duplicate (if not, aborts and makes you look manually).

Run on the SERVER:
    cd /opt/pnw-baseball
    PYTHONPATH=backend python3 cleanup_wou_duplicates.py              # dry run
    PYTHONPATH=backend python3 cleanup_wou_duplicates.py --confirm    # apply
"""
import sys
sys.path.insert(0, "backend")

from app.models.database import get_connection

# (id_to_delete, id_to_keep, reason)
DELETIONS = [
    (3291, 3290, "2026-04-16 g#1 — home/away flipped dup of 3290"),
    (3428, 3314, "2026-04-17 g#1 — NULL-opponent orphan of 3314"),
    (3429, 3320, "2026-04-17 g#2 — NULL-opponent orphan of 3320"),
    (3430, 3383, "2026-04-18 g#1 — NULL-opponent orphan of 3383"),
    (3431, 3384, "2026-04-18 g#2 — NULL-opponent orphan of 3384"),
]

def main():
    confirm = "--confirm" in sys.argv
    mode = "APPLY" if confirm else "DRY RUN"
    print(f"=== {mode} ===\n")

    with get_connection() as conn:
        cur = conn.cursor()

        # First pass — count and sanity-check
        abort = False
        plan = []
        for del_id, keep_id, reason in DELETIONS:
            cur.execute("SELECT COUNT(*) AS c FROM game_batting  WHERE game_id = %s", (del_id,))
            del_bat = cur.fetchone()["c"]
            cur.execute("SELECT COUNT(*) AS c FROM game_pitching WHERE game_id = %s", (del_id,))
            del_pit = cur.fetchone()["c"]
            cur.execute("SELECT COUNT(*) AS c FROM game_batting  WHERE game_id = %s", (keep_id,))
            keep_bat = cur.fetchone()["c"]
            cur.execute("SELECT COUNT(*) AS c FROM game_pitching WHERE game_id = %s", (keep_id,))
            keep_pit = cur.fetchone()["c"]

            # Also grab a quick identity check — pull team + date for the delete candidate
            cur.execute("""
                SELECT game_date, home_team_id, away_team_id, status
                FROM games WHERE id = %s
            """, (del_id,))
            row = cur.fetchone()
            if not row:
                print(f"  ⚠  gid {del_id} not found — skipping.")
                continue

            safe = (keep_bat + keep_pit) >= (del_bat + del_pit)
            marker = "OK" if safe else "ABORT"
            if not safe:
                abort = True

            print(f"  [{marker}] gid {del_id}  →  delete  (keeping {keep_id})")
            print(f"          {reason}")
            print(f"          {row['game_date']}  status={row['status']}  "
                  f"home={row['home_team_id']}  away={row['away_team_id']}")
            print(f"          delete rows : {del_bat} batting, {del_pit} pitching")
            print(f"          keep   rows : {keep_bat} batting, {keep_pit} pitching")
            print()

            plan.append((del_id, del_bat, del_pit))

        if abort:
            print("ABORTING — a kept game has FEWER rows than its duplicate. "
                  "Please inspect manually.")
            return

        if not confirm:
            print("DRY RUN — nothing was deleted. Re-run with --confirm to apply.")
            return

        # Actually delete
        print("Applying deletions...")
        for del_id, _, _ in plan:
            cur.execute("DELETE FROM game_batting  WHERE game_id = %s", (del_id,))
            bd = cur.rowcount
            cur.execute("DELETE FROM game_pitching WHERE game_id = %s", (del_id,))
            pd = cur.rowcount
            cur.execute("DELETE FROM games         WHERE id      = %s", (del_id,))
            gd = cur.rowcount
            print(f"  gid {del_id}: deleted {gd} game, {bd} batting, {pd} pitching")

        conn.commit()
        print("\nDONE. Next: run")
        print("    PYTHONPATH=backend python3 scripts/recalculate_league_adjusted.py --season 2026")
        print("to rebuild pitching_stats and batting_stats.")


if __name__ == "__main__":
    main()
