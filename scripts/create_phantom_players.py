"""
PBP cleanup #1: phantom player records for OOC opponents.

For every game_events row where pitcher_player_id (or batter_player_id)
is NULL but the name field is set, create a lightweight 'phantom' player
record on the appropriate team and update the row to link to it.

Phantoms are flagged via players.is_phantom = TRUE. Leaderboards and
fan-facing stat lists should filter on is_phantom = FALSE; per-PA
queries (matchup history, PBP-derived rate stats) can include them.

Why this matters: ~13% of 2026 PA events have NULL pitcher_player_id
because the pitcher is on an OOC opponent we never roster-scraped
(Occidental, Pomona-Pitzer, Chapman, Whittier, etc.). Phantoms give
those events a player_id to group by, so 'how PNW hitters did vs Nikki
Scott' becomes queryable even though we'll never have her box stats.

Strategy:
  1. Apply migration (idempotent): add is_phantom to players.
  2. Iterate unresolved (team_id, name) tuples.
  3. For each, FIRST try a real-player match via find_player_id_with_fallback
     in case the parser missed something fixable. Only create a phantom
     when no real match exists.
  4. UPDATE game_events to populate the player_id.

Run on Mac:
    cd ~/Desktop/pnw-baseball
    PYTHONPATH=backend python3 scripts/create_phantom_players.py
        # default: 2026 only
        # --season N        change season
        # --dry-run         report counts, no DB writes
"""

from __future__ import annotations
import argparse
import logging
import re
import sys

from app.models.database import get_connection

# Reuse the existing matcher so we don't accidentally create a phantom
# for a player we COULD have resolved. find_player_id_with_fallback
# tries every variant of the name format we know about.
sys.path.insert(0, "scripts")  # so the import works when run from repo root
from scrape_pbp import find_player_id_with_fallback


SEASON = 2026

logger = logging.getLogger("phantoms")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def parse_name(name: str) -> tuple[str, str]:
    """Parse a PBP-format name into (first, last).

    Handles:
      'First Last'     → ('First', 'Last')
      'F. Last'        → ('F.', 'Last')
      'Last, First'    → ('First', 'Last')
      'Last,First'     → ('First', 'Last')   (no space)
      'GAMBOA, AJ'     → ('AJ', 'GAMBOA')
      'HOWARD'         → ('', 'HOWARD')      (single token)
    """
    name = (name or "").strip()
    if not name:
        return "", ""
    if "," in name:
        parts = name.split(",", 1)
        last = parts[0].strip()
        first = parts[1].strip()
        return first, last
    if " " in name:
        # 'F. Last' style
        m = re.match(r"^([A-Z]\.?)\s+(.+)$", name)
        if m:
            first = m.group(1)
            if not first.endswith("."):
                first += "."
            return first, m.group(2).strip()
        # 'First Last' (or 'First Middle Last' — split on last space)
        first, last = name.rsplit(" ", 1)
        return first.strip(), last.strip()
    return "", name  # single token, treat as last name


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=SEASON)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        # ── Migration: add is_phantom to players (idempotent) ──
        logger.info("Applying migration (idempotent)...")
        cur.execute("""
            ALTER TABLE players
                ADD COLUMN IF NOT EXISTS is_phantom BOOLEAN NOT NULL DEFAULT FALSE
        """)
        # Index so queries that filter is_phantom = FALSE stay fast.
        cur.execute("""
            CREATE INDEX IF NOT EXISTS players_is_phantom_idx
                ON players (is_phantom)
                WHERE is_phantom = TRUE
        """)
        conn.commit()

        # ── Collect unresolved (team_id, name) tuples ──
        # Pitcher side
        logger.info("Collecting unresolved pitcher names...")
        cur.execute("""
            SELECT defending_team_id AS team_id,
                   pitcher_name AS name,
                   COUNT(*) AS n
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s
              AND ge.pitcher_name IS NOT NULL
              AND ge.pitcher_player_id IS NULL
              AND ge.defending_team_id IS NOT NULL
            GROUP BY defending_team_id, pitcher_name
        """, (args.season,))
        pitcher_pairs = [(r["team_id"], r["name"], r["n"]) for r in cur.fetchall()]

        # Batter side
        logger.info("Collecting unresolved batter names...")
        cur.execute("""
            SELECT batting_team_id AS team_id,
                   batter_name AS name,
                   COUNT(*) AS n
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s
              AND ge.batter_name IS NOT NULL
              AND ge.batter_player_id IS NULL
              AND ge.batting_team_id IS NOT NULL
            GROUP BY batting_team_id, batter_name
        """, (args.season,))
        batter_pairs = [(r["team_id"], r["name"], r["n"]) for r in cur.fetchall()]

        # Dedupe across both sides — same person could be both batter and pitcher.
        unique_pairs = {}
        for tid, name, n in pitcher_pairs + batter_pairs:
            key = (tid, name)
            unique_pairs[key] = unique_pairs.get(key, 0) + n
        logger.info("  %d unique (team, name) tuples (pitcher %d, batter %d)",
                    len(unique_pairs), len(pitcher_pairs), len(batter_pairs))

        # ── Resolve each tuple: real player first, phantom if no match ──
        resolved_real = 0
        created_phantom = 0
        reused_phantom = 0
        unmappable = 0
        # (team_id, name) -> player_id
        pid_map: dict[tuple[int, str], int] = {}

        for (team_id, name), n_events in unique_pairs.items():
            # 1. Try real-player match (better than creating phantom for
            #    someone we already have).
            real_pid, _ = find_player_id_with_fallback(
                cur, team_id, name, args.season, game_id=None
            )
            if real_pid:
                pid_map[(team_id, name)] = real_pid
                resolved_real += 1
                continue

            # 2. Reuse existing phantom if one exists for this (team, name).
            first, last = parse_name(name)
            if not first and not last:
                unmappable += 1
                continue
            cur.execute("""
                SELECT id FROM players
                WHERE team_id = %s
                  AND COALESCE(first_name, '') = %s
                  AND COALESCE(last_name, '') = %s
                  AND is_phantom = TRUE
                LIMIT 1
            """, (team_id, first, last))
            existing = cur.fetchone()
            if existing:
                pid_map[(team_id, name)] = existing["id"]
                reused_phantom += 1
                continue

            # 3. Create new phantom.
            if not args.dry_run:
                cur.execute("""
                    INSERT INTO players
                        (team_id, first_name, last_name, position, is_phantom,
                         created_at, updated_at)
                    VALUES (%s, %s, %s, %s, TRUE, NOW(), NOW())
                    RETURNING id
                """, (team_id, first, last, "P"))  # default position; will be wrong for batters but harmless
                new_pid = cur.fetchone()["id"]
                pid_map[(team_id, name)] = new_pid
            created_phantom += 1

        if not args.dry_run:
            conn.commit()
        logger.info("  resolved_real=%d  created_phantom=%d  reused_phantom=%d  unmappable=%d",
                    resolved_real, created_phantom, reused_phantom, unmappable)

        # ── Update game_events to populate player_ids ──
        if args.dry_run:
            logger.info("DRY RUN — skipping game_events updates.")
            return 0

        logger.info("Updating game_events.pitcher_player_id...")
        n_pitcher_updates = 0
        for (team_id, name), pid in pid_map.items():
            cur.execute("""
                UPDATE game_events ge
                SET pitcher_player_id = %s
                FROM games g
                WHERE ge.game_id = g.id
                  AND g.season = %s
                  AND ge.defending_team_id = %s
                  AND ge.pitcher_name = %s
                  AND ge.pitcher_player_id IS NULL
            """, (pid, args.season, team_id, name))
            n_pitcher_updates += cur.rowcount
        conn.commit()
        logger.info("  %d game_events rows updated (pitcher_player_id)", n_pitcher_updates)

        logger.info("Updating game_events.batter_player_id...")
        n_batter_updates = 0
        for (team_id, name), pid in pid_map.items():
            cur.execute("""
                UPDATE game_events ge
                SET batter_player_id = %s
                FROM games g
                WHERE ge.game_id = g.id
                  AND g.season = %s
                  AND ge.batting_team_id = %s
                  AND ge.batter_name = %s
                  AND ge.batter_player_id IS NULL
            """, (pid, args.season, team_id, name))
            n_batter_updates += cur.rowcount
        conn.commit()
        logger.info("  %d game_events rows updated (batter_player_id)", n_batter_updates)

        # ── Final coverage check ──
        cur.execute("""
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN pitcher_player_id IS NOT NULL THEN 1 ELSE 0 END) AS pit,
                SUM(CASE WHEN batter_player_id  IS NOT NULL THEN 1 ELSE 0 END) AS bat
            FROM game_events ge
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = %s
              AND ge.result_type IS NOT NULL
              AND ge.result_type NOT IN ('stolen_base','caught_stealing','wild_pitch',
                                          'passed_ball','balk','pickoff','runner_other')
        """, (args.season,))
        r = cur.fetchone()
        tot = r["total"]
        print()
        print(f"── Final resolution coverage ({args.season}) ──")
        print(f"  Total PA events:     {tot:>6,}")
        print(f"  Pitcher resolved:    {r['pit']:>6,}  ({r['pit']/tot*100:.1f}%)")
        print(f"  Batter resolved:     {r['bat']:>6,}  ({r['bat']/tot*100:.1f}%)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
