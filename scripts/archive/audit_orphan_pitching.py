#!/usr/bin/env python3
"""
Audit game_pitching rows where player_id IS NULL.

Answers three questions:
  1. Scope: per-team, per-season. How many orphan rows with team_id SET, and
     how much phantom IP / ER / BF do they contribute?
  2. Are the orphans duplicates of properly-matched rows? For each orphan,
     look for a non-orphan row in the same (game_id, team_id) whose last name
     matches. We use the abbreviated-initial pattern ("I. Hallam" matches
     "Issac Hallam") since that's the name collision we saw during dedup.
  3. Breakdown: orphans that HAVE a likely full-name twin (safe to delete)
     vs. orphans with NO twin (would lose innings if we deleted them).

READ ONLY. No writes.

Usage:
    cd /Users/naterasmussen/Desktop/pnw-baseball
    python3 scripts/audit_orphan_pitching.py --season 2026
    python3 scripts/audit_orphan_pitching.py                 # all seasons
"""

import argparse
import logging
import os
import re
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

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


def _norm(s):
    """Lowercase, strip punctuation, collapse whitespace."""
    if not s:
        return ""
    s = s.strip().lower()
    s = re.sub(r"[.,]", "", s)
    s = re.sub(r"\s+", " ", s)
    return s


def _first_last(name):
    """Return (first_token, last_token) from a human name string.
    Handles 'First Last', 'F. Last', 'Last, First', 'First M Last', etc."""
    if not name:
        return ("", "")
    s = _norm(name)
    if "," in name:
        # 'Last, First [Middle]' -> first=first, last=last
        parts = [p.strip() for p in name.split(",", 1)]
        last = _norm(parts[0])
        first = _norm(parts[1]) if len(parts) > 1 else ""
        # If first has multiple tokens (e.g. 'First Middle'), keep just the first.
        first = first.split(" ")[0] if first else ""
        return (first, last)
    tokens = s.split()
    if not tokens:
        return ("", "")
    if len(tokens) == 1:
        return ("", tokens[0])
    return (tokens[0], tokens[-1])


def audit(season=None):
    conn = get_conn()
    cur = conn.cursor()

    season_sql = ""
    season_params = ()
    if season is not None:
        season_sql = " AND g.season = %s"
        season_params = (season,)

    # ----- Step 1: Per-team scope of orphans with team_id SET -----
    cur.execute(
        f"""
        SELECT g.season,
               gp.team_id,
               COUNT(*)                                 AS rows,
               SUM(COALESCE(gp.innings_pitched, 0))     AS sum_ip,
               SUM(COALESCE(gp.earned_runs, 0))         AS sum_er,
               SUM(COALESCE(gp.batters_faced, 0))       AS sum_bf
        FROM game_pitching gp
        JOIN games g ON gp.game_id = g.id
        WHERE gp.player_id IS NULL
          AND gp.team_id IS NOT NULL
          {season_sql}
        GROUP BY g.season, gp.team_id
        ORDER BY g.season DESC, SUM(COALESCE(gp.innings_pitched, 0)) DESC
        """,
        season_params,
    )
    by_team = cur.fetchall()

    team_ids = sorted({r["team_id"] for r in by_team})
    team_names = {}
    if team_ids:
        cur.execute(
            "SELECT id, short_name FROM teams WHERE id = ANY(%s)",
            (team_ids,),
        )
        team_names = {r["id"]: r["short_name"] for r in cur.fetchall()}

    logger.info("=== Orphan rows with team_id SET, by (season, team) ===")
    logger.info("%-6s  %-28s  %-6s  %-9s  %-6s  %-6s",
                "season", "team", "rows", "sum_ip", "sum_er", "sum_bf")
    for r in by_team:
        tname = team_names.get(r["team_id"], f"team_id={r['team_id']}")
        logger.info("%-6s  %-28s  %-6s  %-9s  %-6s  %-6s",
                    r["season"], tname, r["rows"], r["sum_ip"], r["sum_er"], r["sum_bf"])

    # ----- Step 2: For each orphan, check for a full-name twin on same game+team -----
    # Pull all orphans (with team_id set) and all non-orphans in same games/teams.
    cur.execute(
        f"""
        SELECT gp.id, gp.game_id, gp.team_id, gp.player_name,
               gp.innings_pitched, gp.earned_runs, gp.batters_faced,
               g.season
        FROM game_pitching gp
        JOIN games g ON gp.game_id = g.id
        WHERE gp.player_id IS NULL
          AND gp.team_id IS NOT NULL
          {season_sql}
        """,
        season_params,
    )
    orphans = cur.fetchall()

    # Grab all non-orphan rows in the same (game_id, team_id) pairs.
    pairs = {(o["game_id"], o["team_id"]) for o in orphans}
    twins_by_pair = {}
    if pairs:
        # Use unnest of arrays to pass pairs.
        game_ids = list({p[0] for p in pairs})
        team_ids_ = list({p[1] for p in pairs})
        cur.execute(
            """
            SELECT gp.id, gp.game_id, gp.team_id, gp.player_name,
                   gp.innings_pitched, gp.earned_runs, gp.batters_faced,
                   gp.player_id
            FROM game_pitching gp
            WHERE gp.player_id IS NOT NULL
              AND gp.game_id = ANY(%s)
              AND gp.team_id = ANY(%s)
            """,
            (game_ids, team_ids_),
        )
        for r in cur.fetchall():
            key = (r["game_id"], r["team_id"])
            twins_by_pair.setdefault(key, []).append(r)

    matched = 0
    unmatched = 0
    matched_examples = []
    unmatched_examples = []
    # Track inflation: sum of IP/ER/BF from orphans that HAVE a twin (these
    # are the ones we'd remove to get accurate totals).
    infl_ip = 0.0
    infl_er = 0
    infl_bf = 0

    for o in orphans:
        o_first, o_last = _first_last(o["player_name"])
        twins = twins_by_pair.get((o["game_id"], o["team_id"]), [])
        matched_twin = None
        for t in twins:
            t_first, t_last = _first_last(t["player_name"])
            if not o_last or not t_last:
                continue
            if o_last != t_last:
                continue
            # Last names match. Accept if first initial matches (or either first empty).
            if not o_first or not t_first:
                matched_twin = t
                break
            if o_first[0] == t_first[0]:
                matched_twin = t
                break
        if matched_twin:
            matched += 1
            infl_ip += float(o["innings_pitched"] or 0)
            infl_er += int(o["earned_runs"] or 0)
            infl_bf += int(o["batters_faced"] or 0)
            if len(matched_examples) < 5:
                matched_examples.append((o, matched_twin))
        else:
            unmatched += 1
            if len(unmatched_examples) < 5:
                unmatched_examples.append(o)

    logger.info("=== Orphan twin-match summary ===")
    logger.info("  orphans with full-name twin (likely duplicates):   %s", matched)
    logger.info("  orphans with NO twin (unique innings if we trust them): %s", unmatched)
    logger.info("  inflation from MATCHED orphans: IP=%.1f  ER=%s  BF=%s",
                infl_ip, infl_er, infl_bf)

    logger.info("Sample matched (orphan -> twin):")
    for o, t in matched_examples:
        logger.info(
            "  game=%s team=%s  orphan id=%s '%s' ip=%s er=%s  <->  twin id=%s '%s' ip=%s er=%s",
            o["game_id"], team_names.get(o["team_id"], o["team_id"]),
            o["id"], o["player_name"], o["innings_pitched"], o["earned_runs"],
            t["id"], t["player_name"], t["innings_pitched"], t["earned_runs"],
        )

    logger.info("Sample unmatched (no twin — would lose these if deleted):")
    for o in unmatched_examples:
        logger.info(
            "  game=%s team=%s  orphan id=%s '%s' ip=%s er=%s bf=%s",
            o["game_id"], team_names.get(o["team_id"], o["team_id"]),
            o["id"], o["player_name"], o["innings_pitched"],
            o["earned_runs"], o["batters_faced"],
        )

    conn.close()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--season", type=int, default=None,
                   help="Limit to a single season. Default: all seasons.")
    args = p.parse_args()

    if not DATABASE_URL:
        logger.error("DATABASE_URL not set in environment / .env")
        sys.exit(1)

    audit(season=args.season)


if __name__ == "__main__":
    main()
