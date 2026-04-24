#!/usr/bin/env python3
"""
Deduplicate games in the database.

Games can be duplicated when:
- The same game is scraped from both teams' sites
- NULL team_ids cause dedup checks to fail (NULL != NULL in SQL)
- Multiple scrape runs re-insert the same games
- A scraper creates an OOC placeholder (team_id > 30000) for an opponent that
  team_matching.py could not resolve, shadowing a real-team game on the same date

Three passes:
  Pass 1: same team pair, home/away flipped.
  Pass 2: one side has NULL team_id, matched to a valid same-date counterpart.
  Pass 3: phantom pair — one side has an OOC placeholder; the other side is all
          real teams; their batting rows share >= 50% of players (same real game
          scraped twice).

Usage (on server):
    cd /opt/pnw-baseball
    python3 scripts/dedup_games.py --season 2026 --dry-run
    python3 scripts/dedup_games.py --season 2026
"""

import argparse
import logging
import os
import sys

import psycopg2
import psycopg2.extras

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
DATABASE_URL = os.environ.get("DATABASE_URL")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def get_conn():
    url = DATABASE_URL
    if url and "sslmode" not in url:
        sep = "&" if "?" in url else "?"
        url = url + sep + "sslmode=require"
    conn = psycopg2.connect(url)
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


# Threshold above which two games' batting-row overlap is taken to mean
# "same real game, scraped twice" rather than "two separate games".
PHANTOM_OVERLAP_THRESHOLD = 0.5


def _last_name(s):
    """Extract a lowercase last name from a player_name string.

    Handles both 'First Last' and 'Last, First' formats.
    """
    if not s:
        return ""
    s = s.strip()
    if "," in s:
        return s.split(",", 1)[0].strip().lower()
    parts = s.split()
    return parts[-1].lower() if parts else ""


def _bat_key(row):
    """Build a comparison key for a game_batting row.

    Prefers player_id when non-null (the canonical identifier). Falls back to
    (team_id, normalized last name) so rows with missing player_id but identical
    player still match across the two scrapes of the same real game.
    """
    if row.get("player_id"):
        return ("pid", row["player_id"])
    return ("name", row.get("team_id"), _last_name(row.get("player_name") or ""))


def _batting_overlap_ratio(cur, shadow_id, canon_id):
    """2 * shared_keys / (|shadow| + |canon|); >= 0.5 means likely the same game."""
    cur.execute(
        "SELECT player_id, player_name, team_id FROM game_batting WHERE game_id = %s",
        (shadow_id,),
    )
    sh = cur.fetchall()
    cur.execute(
        "SELECT player_id, player_name, team_id FROM game_batting WHERE game_id = %s",
        (canon_id,),
    )
    ca = cur.fetchall()
    denom = len(sh) + len(ca)
    if not denom:
        return 0.0
    sh_keys = {_bat_key(r) for r in sh}
    ca_keys = {_bat_key(r) for r in ca}
    return (2 * len(sh_keys & ca_keys)) / denom


def dedup_games(season, dry_run=False):
    conn = get_conn()
    cur = conn.cursor()

    total_deleted = 0
    total_batting_deleted = 0
    total_pitching_deleted = 0

    # ========== Pass 1: home/away-flipped duplicates ==========
    # Group by the NORMALIZED team pair so games with teams swapped between
    # home and away are caught as the same matchup. Requires both team_ids
    # to be non-NULL. NULL-opponent orphans are handled in Pass 2.
    cur.execute("""
        SELECT
            game_date,
            LEAST(home_team_id, away_team_id)    AS team_lo,
            GREATEST(home_team_id, away_team_id) AS team_hi,
            game_number,
            COUNT(*) as cnt,
            array_agg(id ORDER BY id) as game_ids
        FROM games
        WHERE season = %s AND status = 'final'
          AND home_team_id IS NOT NULL
          AND away_team_id IS NOT NULL
        GROUP BY game_date,
                 LEAST(home_team_id, away_team_id),
                 GREATEST(home_team_id, away_team_id),
                 game_number
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
    """, (season,))

    dup_groups = cur.fetchall()
    logger.info(f"Pass 1 (same team pair, either orientation): "
                f"found {len(dup_groups)} duplicate groups")

    for group in dup_groups:
        game_ids = group["game_ids"]
        date = group["game_date"]
        t_lo = group["team_lo"]
        t_hi = group["team_hi"]
        gnum = group["game_number"]

        # For each game in the group, count batting rows and keep the fullest.
        best_id = None
        best_count = -1
        game_counts = {}

        for gid in game_ids:
            cur.execute("SELECT COUNT(*) as cnt FROM game_batting WHERE game_id = %s", (gid,))
            cnt = cur.fetchone()["cnt"]
            game_counts[gid] = cnt
            if cnt > best_count:
                best_count = cnt
                best_id = gid

        ids_to_delete = [gid for gid in game_ids if gid != best_id]

        if not ids_to_delete:
            continue

        logger.info(
            f"  {date} teams=({t_lo},{t_hi}) gn={gnum}: "
            f"keeping game {best_id} ({best_count} batting rows), "
            f"deleting {len(ids_to_delete)} dupes {ids_to_delete}"
        )

        if dry_run:
            total_deleted += len(ids_to_delete)
            for did in ids_to_delete:
                total_batting_deleted += game_counts[did]
            continue

        # Delete batting and pitching rows for duplicate games
        for did in ids_to_delete:
            cur.execute("DELETE FROM game_batting WHERE game_id = %s", (did,))
            total_batting_deleted += cur.rowcount

            cur.execute("DELETE FROM game_pitching WHERE game_id = %s", (did,))
            total_pitching_deleted += cur.rowcount

            cur.execute("DELETE FROM games WHERE id = %s", (did,))
            total_deleted += 1

        conn.commit()

    # ========== Pass 2: NULL-opponent orphan games ==========
    # Find games with NULL home_team_id or away_team_id that have a valid
    # counterpart on the same date + game_number where the valid game shares
    # one of the known team_ids. These orphans are safe to delete because the
    # valid game already contains the real data.
    cur.execute("""
        SELECT DISTINCT ON (g1.id)
            g1.id                AS orphan_id,
            g1.game_date         AS game_date,
            g1.game_number       AS game_number,
            g1.home_team_id      AS orphan_home,
            g1.away_team_id      AS orphan_away,
            g2.id                AS valid_id,
            g2.home_team_id      AS valid_home,
            g2.away_team_id      AS valid_away
        FROM games g1
        JOIN games g2
          ON g1.season = g2.season
         AND g1.game_date = g2.game_date
         AND COALESCE(g1.game_number, 1) = COALESCE(g2.game_number, 1)
         AND g1.id <> g2.id
         AND g2.home_team_id IS NOT NULL
         AND g2.away_team_id IS NOT NULL
         AND g2.home_team_id <> g2.away_team_id
         AND (
              g1.home_team_id IN (g2.home_team_id, g2.away_team_id)
           OR g1.away_team_id IN (g2.home_team_id, g2.away_team_id)
         )
        WHERE g1.season = %s
          AND g1.status = 'final'
          AND (g1.home_team_id IS NULL OR g1.away_team_id IS NULL)
        ORDER BY g1.id, g2.id
    """, (season,))

    orphans = cur.fetchall()
    logger.info(f"Pass 2 (NULL-opponent orphans with a valid counterpart): "
                f"found {len(orphans)}")

    for o in orphans:
        logger.info(
            f"  {o['game_date']} gn={o['game_number']} "
            f"orphan={o['orphan_id']} "
            f"home={o['orphan_home']} away={o['orphan_away']} "
            f"-> valid={o['valid_id']} "
            f"(home={o['valid_home']} away={o['valid_away']})"
        )

        if dry_run:
            cur.execute("SELECT COUNT(*) as cnt FROM game_batting  WHERE game_id = %s",
                        (o["orphan_id"],))
            total_batting_deleted += cur.fetchone()["cnt"]
            cur.execute("SELECT COUNT(*) as cnt FROM game_pitching WHERE game_id = %s",
                        (o["orphan_id"],))
            total_pitching_deleted += cur.fetchone()["cnt"]
            total_deleted += 1
            continue

        cur.execute("DELETE FROM game_batting  WHERE game_id = %s", (o["orphan_id"],))
        total_batting_deleted += cur.rowcount
        cur.execute("DELETE FROM game_pitching WHERE game_id = %s", (o["orphan_id"],))
        total_pitching_deleted += cur.rowcount
        cur.execute("DELETE FROM games         WHERE id      = %s", (o["orphan_id"],))
        total_deleted += 1

    if not dry_run:
        conn.commit()

    # ========== Pass 3: phantom pairs (OOC placeholder shadowing real team) ==========
    # team_matching.py auto-creates an OOC placeholder team (id > 30000, is_active=0)
    # when it cannot resolve an opponent string. If the SAME real game is later
    # scraped from the other team's site and their matcher resolves both teams
    # correctly, we end up with two rows: a "canon" (both team_ids real) and a
    # "shadow" (one real team_id + the OOC placeholder). Pass 1 misses these
    # because the normalized team pair differs.
    #
    # Classify a pair as a phantom only when >= 50% of the two games' batting
    # rows describe the same player (player_id match, or team_id + last name).
    # This keeps real separate games against different OOC opponents safe.
    cur.execute("""
        SELECT g1.id AS id1, g2.id AS id2, g1.game_date,
               g1.home_team_id AS h1, g1.away_team_id AS a1,
               g2.home_team_id AS h2, g2.away_team_id AS a2
        FROM games g1
        JOIN games g2
          ON g1.season = g2.season
         AND g1.game_date = g2.game_date
         AND g1.id < g2.id
        WHERE g1.season = %s
          AND g1.status = 'final' AND g2.status = 'final'
          AND g1.home_team_id IS NOT NULL AND g1.away_team_id IS NOT NULL
          AND g2.home_team_id IS NOT NULL AND g2.away_team_id IS NOT NULL
          AND (
              (g1.home_team_id IN (g2.home_team_id, g2.away_team_id))::int +
              (g1.away_team_id IN (g2.home_team_id, g2.away_team_id))::int = 1
          )
          AND (g1.home_team_id > 30000 OR g1.away_team_id > 30000
               OR g2.home_team_id > 30000 OR g2.away_team_id > 30000)
        ORDER BY g1.game_date
    """, (season,))

    phantom_candidates = cur.fetchall()

    confirmed_phantoms = []
    for p in phantom_candidates:
        g1_ooc = p["h1"] > 30000 or p["a1"] > 30000
        g2_ooc = p["h2"] > 30000 or p["a2"] > 30000

        # Clear canon/shadow required: exactly one side must have the OOC id.
        if g1_ooc and not g2_ooc:
            shadow_id, canon_id = p["id1"], p["id2"]
        elif g2_ooc and not g1_ooc:
            shadow_id, canon_id = p["id2"], p["id1"]
        else:
            # Both-OOC or neither-OOC — skip, needs manual review.
            continue

        ratio = _batting_overlap_ratio(cur, shadow_id, canon_id)
        if ratio < PHANTOM_OVERLAP_THRESHOLD:
            continue

        confirmed_phantoms.append({
            "game_date": p["game_date"],
            "shadow": shadow_id,
            "canon": canon_id,
            "ratio": ratio,
        })

    # Deduplicate per-shadow: in doubleheader cases a single shadow can
    # candidate-match both real games. Keep the canon with the highest overlap.
    best_by_shadow = {}
    for p in confirmed_phantoms:
        key = p["shadow"]
        if key not in best_by_shadow or p["ratio"] > best_by_shadow[key]["ratio"]:
            best_by_shadow[key] = p
    phantoms = list(best_by_shadow.values())

    logger.info(f"Pass 3 (phantom pairs, OOC shadowing real team): "
                f"found {len(phantoms)}")

    phantom_games_deleted = 0
    phantom_bat_deleted = 0
    phantom_pit_deleted = 0

    for p in phantoms:
        logger.info(
            f"  {p['game_date']} canon=g{p['canon']} shadow=g{p['shadow']} "
            f"overlap_ratio={p['ratio']:.2f}"
        )

        if dry_run:
            cur.execute("SELECT COUNT(*) AS cnt FROM game_batting WHERE game_id = %s",
                        (p["shadow"],))
            phantom_bat_deleted += cur.fetchone()["cnt"]
            cur.execute("SELECT COUNT(*) AS cnt FROM game_pitching WHERE game_id = %s",
                        (p["shadow"],))
            phantom_pit_deleted += cur.fetchone()["cnt"]
            phantom_games_deleted += 1
            continue

        cur.execute("DELETE FROM game_batting  WHERE game_id = %s", (p["shadow"],))
        phantom_bat_deleted += cur.rowcount
        cur.execute("DELETE FROM game_pitching WHERE game_id = %s", (p["shadow"],))
        phantom_pit_deleted += cur.rowcount
        cur.execute("DELETE FROM games         WHERE id      = %s", (p["shadow"],))
        phantom_games_deleted += 1

    if not dry_run:
        conn.commit()

    total_deleted += phantom_games_deleted
    total_batting_deleted += phantom_bat_deleted
    total_pitching_deleted += phantom_pit_deleted

    # ========== Pass 4: orientation-swapped schedule-only phantoms ==========
    # When Sidearm's team schedule lists a game the scraper cannot match to a
    # real box score URL, scrape_boxscores.py synthesizes a gamelog:// URL and
    # inserts a schedule-only row (final status, W/L, no batting/pitching). If
    # the real box score is already stored under a different source_url, we end
    # up with two rows on the same date for the same team pair but with
    # different game_number values — Pass 1 misses them because it groups by
    # game_number, and Pass 3 misses them because both rows have real team_ids.
    #
    # Signature that makes this safe against legitimate doubleheaders:
    #   - same date, same team pair (either orientation)
    #   - different game_number (or one NULL)
    #   - phantom has 0 batting rows AND 0 pitching rows
    #   - canon has batting rows
    # Real doubleheaders scraped by us always have batting on both games.
    cur.execute("""
        SELECT g1.id AS phantom_id, g1.game_date,
               g1.game_number AS phantom_gn, g2.game_number AS canon_gn,
               g1.source_url  AS phantom_src,
               g2.id AS canon_id
        FROM games g1
        JOIN games g2
          ON g1.season = g2.season
         AND g1.game_date = g2.game_date
         AND g1.id <> g2.id
         AND (g1.game_number IS DISTINCT FROM g2.game_number)
         AND LEAST(g1.home_team_id, g1.away_team_id)
             = LEAST(g2.home_team_id, g2.away_team_id)
         AND GREATEST(g1.home_team_id, g1.away_team_id)
             = GREATEST(g2.home_team_id, g2.away_team_id)
        WHERE g1.season = %s
          AND g1.status = 'final' AND g2.status = 'final'
          AND g1.home_team_id IS NOT NULL AND g1.away_team_id IS NOT NULL
          AND g2.home_team_id IS NOT NULL AND g2.away_team_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM game_batting  WHERE game_id = g1.id)
          AND NOT EXISTS (SELECT 1 FROM game_pitching WHERE game_id = g1.id)
          AND EXISTS     (SELECT 1 FROM game_batting  WHERE game_id = g2.id)
        ORDER BY g1.game_date, g1.id
    """, (season,))

    raw_p4 = cur.fetchall()
    # A single phantom can match multiple canons (e.g., legit doubleheader
    # where our row happens to lack batting on game 2). Keep one canon per
    # phantom — the one whose game_number matches the phantom's, else the
    # lowest canon id. This ensures we only delete each phantom once.
    seen = set()
    phantoms_p4 = []
    for r in raw_p4:
        if r["phantom_id"] in seen:
            continue
        seen.add(r["phantom_id"])
        phantoms_p4.append(r)

    logger.info(f"Pass 4 (orientation-swapped schedule-only phantoms): "
                f"found {len(phantoms_p4)}")

    p4_deleted = 0
    for r in phantoms_p4:
        logger.info(
            f"  {r['game_date']} phantom=g{r['phantom_id']} "
            f"gn={r['phantom_gn']} src={r['phantom_src']!r} "
            f"-> canon=g{r['canon_id']} gn={r['canon_gn']}"
        )
        if dry_run:
            p4_deleted += 1
            continue
        # Phantom has no batting/pitching by construction, so no child rows
        # to clean up. Still issue the DELETEs defensively in case of race.
        cur.execute("DELETE FROM game_batting  WHERE game_id = %s", (r["phantom_id"],))
        cur.execute("DELETE FROM game_pitching WHERE game_id = %s", (r["phantom_id"],))
        cur.execute("DELETE FROM games         WHERE id      = %s", (r["phantom_id"],))
        p4_deleted += 1

    if not dry_run:
        conn.commit()

    total_deleted += p4_deleted

    # ========== Summary ==========
    logger.info(f"\n{'='*60}")
    logger.info(f"{'DRY RUN - ' if dry_run else ''}Dedup complete for season {season}")
    logger.info(f"  Pass 1 duplicate groups: {len(dup_groups)}")
    logger.info(f"  Pass 2 orphan games:     {len(orphans)}")
    logger.info(f"  Pass 3 phantom pairs:    {len(phantoms)}")
    logger.info(f"  Pass 4 schedule-only:    {len(phantoms_p4)}")
    logger.info(f"  Games deleted:           {total_deleted}")
    logger.info(f"  Batting rows deleted:    {total_batting_deleted}")
    logger.info(f"  Pitching rows deleted:   {total_pitching_deleted}")

    # Show final game count
    cur.execute("SELECT COUNT(*) as cnt FROM games WHERE season = %s AND status = 'final'", (season,))
    remaining = cur.fetchone()["cnt"]
    logger.info(f"  Games remaining:         {remaining}")

    conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Deduplicate games")
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    dedup_games(args.season, args.dry_run)
