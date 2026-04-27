"""
Walk every phantom player, check if a real player on the same team
matches its name (handling generational suffixes), and if so:
  1. Update game_events.batter_player_id / pitcher_player_id from
     the phantom_id to the real_id.
  2. Delete the now-redundant phantom row.

Idempotent. Safe to re-run — phantoms that already got reconciled
won't exist anymore, so nothing happens for them.

Run on Mac:
    cd ~/Desktop/pnw-baseball
    PYTHONPATH=backend python3 scripts/reconcile_phantoms.py
        # default: real run (writes)
        # --dry-run     report counts, no DB writes
"""
from __future__ import annotations
import argparse
import logging
import re
import sys

from app.models.database import get_connection


SUFFIX_RE = re.compile(r"\s+(?:jr|sr|ii|iii|iv)\.?$", re.IGNORECASE)

logger = logging.getLogger("phantoms")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        # Find every (phantom, real) pair on the same team where the
        # real player's last_name matches the phantom's after stripping
        # generational suffix.
        cur.execute("""
            SELECT
                ph.id   AS phantom_id,
                ph.team_id,
                ph.first_name AS phantom_first,
                ph.last_name  AS phantom_last,
                rp.id   AS real_id,
                rp.first_name AS real_first,
                rp.last_name  AS real_last
            FROM players ph
            JOIN players rp ON rp.team_id = ph.team_id
                            AND rp.is_phantom = FALSE
                            AND LOWER(COALESCE(rp.first_name, ''))
                                = LOWER(COALESCE(ph.first_name, ''))
                            AND (LOWER(COALESCE(rp.last_name, ''))
                                    = LOWER(COALESCE(ph.last_name, ''))
                                 OR LOWER(REGEXP_REPLACE(
                                        COALESCE(rp.last_name, ''),
                                        '\\s+(jr|sr|ii|iii|iv)\\.?$', '', 'i'))
                                    = LOWER(COALESCE(ph.last_name, '')))
            WHERE ph.is_phantom = TRUE
        """)
        pairs = list(cur.fetchall())
        logger.info("Recoverable phantoms: %d", len(pairs))

        if not pairs:
            logger.info("Nothing to do.")
            return 0

        total_pit_updates = 0
        total_bat_updates = 0
        for p in pairs:
            phantom_id = p["phantom_id"]
            real_id = p["real_id"]
            phantom_label = f"{p['phantom_first']} {p['phantom_last']}".strip()
            real_label = f"{p['real_first']} {p['real_last']}".strip()
            logger.info("  %s (id=%d) → %s (id=%d)  team_id=%d",
                        phantom_label, phantom_id, real_label, real_id, p["team_id"])

            # Count how many events would change
            cur.execute("""
                SELECT
                    SUM(CASE WHEN pitcher_player_id = %s THEN 1 ELSE 0 END) AS pit,
                    SUM(CASE WHEN batter_player_id  = %s THEN 1 ELSE 0 END) AS bat
                FROM game_events
            """, (phantom_id, phantom_id))
            r = cur.fetchone()
            pit_n = r["pit"] or 0
            bat_n = r["bat"] or 0
            logger.info("    events: pitcher=%d  batter=%d", pit_n, bat_n)
            total_pit_updates += pit_n
            total_bat_updates += bat_n

            if args.dry_run:
                continue

            # game_events
            cur.execute("UPDATE game_events SET pitcher_player_id = %s "
                        "WHERE pitcher_player_id = %s", (real_id, phantom_id))
            cur.execute("UPDATE game_events SET batter_player_id = %s "
                        "WHERE batter_player_id = %s", (real_id, phantom_id))
            cur.execute("""
                UPDATE game_events SET
                    r1_player_id = CASE WHEN r1_player_id = %s THEN %s ELSE r1_player_id END,
                    r2_player_id = CASE WHEN r2_player_id = %s THEN %s ELSE r2_player_id END,
                    r3_player_id = CASE WHEN r3_player_id = %s THEN %s ELSE r3_player_id END
                WHERE r1_player_id = %s OR r2_player_id = %s OR r3_player_id = %s
            """, (phantom_id, real_id,
                  phantom_id, real_id,
                  phantom_id, real_id,
                  phantom_id, phantom_id, phantom_id))

            # The box-score scraper may have also matched the phantom
            # (since find_player_id without suffix-stripping fell back
            # to phantom). Redirect game_batting / game_pitching too.
            cur.execute("UPDATE game_batting  SET player_id = %s "
                        "WHERE player_id = %s", (real_id, phantom_id))
            cur.execute("UPDATE game_pitching SET player_id = %s "
                        "WHERE player_id = %s", (real_id, phantom_id))

            # Delete the phantom record
            cur.execute("DELETE FROM players WHERE id = %s", (phantom_id,))

        if args.dry_run:
            logger.info("[DRY RUN] would update pitcher events=%d, batter events=%d, "
                        "delete %d phantoms",
                        total_pit_updates, total_bat_updates, len(pairs))
        else:
            conn.commit()
            logger.info("Done: pitcher events updated=%d, batter events updated=%d, "
                        "phantoms deleted=%d",
                        total_pit_updates, total_bat_updates, len(pairs))

    return 0


if __name__ == "__main__":
    sys.exit(main())
