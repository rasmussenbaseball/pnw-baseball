"""
Dedupe duplicate team records (e.g. "Occidental" + "Occidental
College"). For each duplicate group:

  1. Pick the canonical team_id (most games + most real roster).
  2. For every phantom player on the non-canonical team:
       - If a phantom with the same first/last name already exists on
         the canonical team, redirect the non-canonical phantom's
         references (game_events, game_batting, game_pitching) to the
         existing canonical phantom, then delete the non-canonical row.
       - Otherwise, just move the player record to the canonical team.
  3. Move any non-phantom players to the canonical team (defensive
     — most duplicates have 0 real roster).
  4. Update games.home_team_id / away_team_id from non-canonical
     team to canonical.
  5. Delete the non-canonical team row.

Idempotent. Safe to re-run.

Run on Mac:
    cd ~/Desktop/pnw-baseball
    PYTHONPATH=backend python3 scripts/dedupe_teams.py
        # default: real run (writes)
        # --dry-run: report counts, no DB writes
"""
from __future__ import annotations
import argparse
import logging
import re
import sys
from collections import defaultdict

from app.models.database import get_connection


TRIM_RE = re.compile(
    r"(?:\s+university\b|\s+college\b|\s+\((?:ca|or|wa|id|mt)\)$)",
    re.IGNORECASE,
)
PUNCT_RE = re.compile(r"[^\w\s]")


def normalize(name: str) -> str:
    if not name:
        return ""
    s = TRIM_RE.sub("", name)
    s = PUNCT_RE.sub("", s)
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s


logger = logging.getLogger("dedupe_teams")
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        # Find duplicate groups
        cur.execute("""
            SELECT t.id, t.name, t.short_name,
                   (SELECT COUNT(*) FROM players WHERE team_id = t.id AND is_phantom = FALSE) AS n_real,
                   (SELECT COUNT(*) FROM games WHERE home_team_id = t.id OR away_team_id = t.id) AS n_games
            FROM teams t
        """)
        teams = list(cur.fetchall())
        groups = defaultdict(list)
        for t in teams:
            key = normalize(t["name"] or t["short_name"] or "")
            if key:
                groups[key].append(t)
        dup_groups = [g for g in groups.values() if len(g) > 1]
        logger.info("Found %d duplicate groups", len(dup_groups))

        for group in dup_groups:
            # Pick canonical: most real roster, then most games, then lowest id
            group.sort(key=lambda t: (-(t["n_real"] or 0),
                                       -(t["n_games"] or 0),
                                       t["id"]))
            canonical = group[0]
            losers = group[1:]
            logger.info("")
            logger.info("Group: %s",
                        canonical["name"] or canonical["short_name"])
            logger.info("  CANONICAL: id=%d  '%s'  games=%d  real=%d",
                        canonical["id"], canonical["name"],
                        canonical["n_games"], canonical["n_real"])
            for loser in losers:
                logger.info("  drop:      id=%d  '%s'  games=%d  real=%d",
                            loser["id"], loser["name"],
                            loser["n_games"], loser["n_real"])

            for loser in losers:
                _merge(cur, canonical["id"], loser["id"], dry_run=args.dry_run)

        if args.dry_run:
            logger.info("\n[DRY RUN] no changes committed.")
        else:
            conn.commit()
            logger.info("\nDone — committed.")

    return 0


def _merge(cur, canonical_id: int, loser_id: int, dry_run: bool):
    """Merge `loser_id` into `canonical_id`. See module docstring."""
    # 1. Walk every player on the loser team. For each, check if a
    #    same-name player already exists on canonical; if so, redirect
    #    references and delete; if not, just move the team_id.
    cur.execute("""
        SELECT id, first_name, last_name, is_phantom
        FROM players WHERE team_id = %s
    """, (loser_id,))
    loser_players = list(cur.fetchall())
    logger.info("    %d players on loser team_id=%d",
                len(loser_players), loser_id)

    redirects = 0
    moves = 0
    for p in loser_players:
        cur.execute("""
            SELECT id FROM players
            WHERE team_id = %s
              AND COALESCE(LOWER(first_name), '') = COALESCE(LOWER(%s), '')
              AND COALESCE(LOWER(last_name), '')  = COALESCE(LOWER(%s), '')
              AND id <> %s
            ORDER BY is_phantom ASC, id ASC
            LIMIT 1
        """, (canonical_id, p["first_name"] or "",
              p["last_name"] or "", p["id"]))
        existing = cur.fetchone()
        if existing:
            # Redirect references from p.id → existing.id, then delete p
            redirects += 1
            if not dry_run:
                _redirect_player(cur, p["id"], existing["id"])
                cur.execute("DELETE FROM players WHERE id = %s", (p["id"],))
        else:
            # Just move team_id
            moves += 1
            if not dry_run:
                cur.execute("UPDATE players SET team_id = %s WHERE id = %s",
                            (canonical_id, p["id"]))
    logger.info("    redirected=%d  moved=%d", redirects, moves)

    # 2. Update games table
    cur.execute("""
        SELECT
            (SELECT COUNT(*) FROM games WHERE home_team_id = %s) AS home_n,
            (SELECT COUNT(*) FROM games WHERE away_team_id = %s) AS away_n
    """, (loser_id, loser_id))
    r = cur.fetchone()
    logger.info("    games: home=%d  away=%d", r["home_n"] or 0, r["away_n"] or 0)
    if not dry_run:
        cur.execute("UPDATE games SET home_team_id = %s WHERE home_team_id = %s",
                    (canonical_id, loser_id))
        cur.execute("UPDATE games SET away_team_id = %s WHERE away_team_id = %s",
                    (canonical_id, loser_id))
        # game_events / game_batting / game_pitching also have team_id columns —
        # update them so per-event team-keyed queries stay consistent.
        for tbl, col in [
            ("game_events", "batting_team_id"),
            ("game_events", "defending_team_id"),
            ("game_batting", "team_id"),
            ("game_pitching", "team_id"),
        ]:
            cur.execute(
                f"UPDATE {tbl} SET {col} = %s WHERE {col} = %s",
                (canonical_id, loser_id),
            )

    # 3. Delete the loser team
    if not dry_run:
        cur.execute("DELETE FROM teams WHERE id = %s", (loser_id,))


def _redirect_player(cur, old_id: int, new_id: int):
    """Move every FK reference to `old_id` over to `new_id`."""
    cur.execute("UPDATE game_events SET pitcher_player_id = %s "
                "WHERE pitcher_player_id = %s", (new_id, old_id))
    cur.execute("UPDATE game_events SET batter_player_id = %s "
                "WHERE batter_player_id = %s", (new_id, old_id))
    cur.execute("""
        UPDATE game_events SET
            r1_player_id = CASE WHEN r1_player_id = %s THEN %s ELSE r1_player_id END,
            r2_player_id = CASE WHEN r2_player_id = %s THEN %s ELSE r2_player_id END,
            r3_player_id = CASE WHEN r3_player_id = %s THEN %s ELSE r3_player_id END
        WHERE r1_player_id = %s OR r2_player_id = %s OR r3_player_id = %s
    """, (old_id, new_id, old_id, new_id, old_id, new_id,
          old_id, old_id, old_id))
    cur.execute("UPDATE game_batting  SET player_id = %s WHERE player_id = %s",
                (new_id, old_id))
    cur.execute("UPDATE game_pitching SET player_id = %s WHERE player_id = %s",
                (new_id, old_id))


if __name__ == "__main__":
    sys.exit(main())
