#!/usr/bin/env python3
"""
One-off diagnostic: dump every (game_id, player_id) duplicate group in
game_batting for 2026 with enough context to decide whether each group is:
  (A) same player under two name formats - safe to dedupe
  (B) TWO DIFFERENT PLAYERS mis-matched to the same player_id - do NOT dedupe,
      fix the matcher / correct the player_id instead

Usage:
    python3 scripts/inspect_game_batting_dups.py
"""

import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
DATABASE_URL = os.environ.get("DATABASE_URL")


def get_conn():
    url = DATABASE_URL
    if url and "sslmode" not in url:
        sep = "&" if "?" in url else "?"
        url = url + sep + "sslmode=require"
    conn = psycopg2.connect(url)
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def main():
    if not DATABASE_URL:
        print("DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)

    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
        SELECT gb.game_id,
               gb.player_id,
               TRIM(CONCAT_WS(' ', p.first_name, p.last_name)) AS canonical,
               p.team_id AS canonical_team_id,
               g.home_team_id,
               g.away_team_id,
               array_agg(gb.id          ORDER BY gb.id) AS row_ids,
               array_agg(gb.team_id     ORDER BY gb.id) AS team_ids,
               array_agg(gb.player_name ORDER BY gb.id) AS names,
               array_agg(COALESCE(gb.at_bats,0)::text || '/' ||
                         COALESCE(gb.hits,0)::text     ORDER BY gb.id) AS ab_h
        FROM game_batting gb
        JOIN games g ON gb.game_id = g.id
        LEFT JOIN players p ON gb.player_id = p.id
        WHERE gb.player_id IS NOT NULL
          AND g.season = 2026
        GROUP BY gb.game_id, gb.player_id, p.first_name, p.last_name, p.team_id,
                 g.home_team_id, g.away_team_id
        HAVING COUNT(*) > 1
        ORDER BY gb.game_id
    """)
    rows = cur.fetchall()

    print(f"Found {len(rows)} duplicate (game_id, player_id) groups in 2026 game_batting.\n")
    print("Legend: canonical = players.name for player_id. "
          "If the names array has values that don't fit one real person, "
          "that row is a MIS-MATCH, not a dedupe candidate.\n")

    for i, r in enumerate(rows, 1):
        print(f"[{i:>2}] game={r['game_id']:<5} player_id={r['player_id']:<5} "
              f"canonical='{r['canonical']}' (roster team={r['canonical_team_id']})  "
              f"home={r['home_team_id']} away={r['away_team_id']}")
        print(f"     row_ids   = {r['row_ids']}")
        print(f"     team_ids  = {r['team_ids']}")
        print(f"     names     = {r['names']}")
        print(f"     AB/H      = {r['ab_h']}")
        print()

    conn.close()


if __name__ == "__main__":
    main()
