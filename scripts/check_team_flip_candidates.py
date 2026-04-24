#!/usr/bin/env python3
"""
For every final game involving a given team, parse the Sidearm source_url
slug and flag games where the stored home_team_id appears BEFORE the
stored away_team_id in the slug.

Sidearm URL format: .../stats/<season>/<away-slug>-<home-slug>/boxscore/<id>
so stored home tokens appearing first = team_ids are flipped.

Usage:
    PYTHONPATH=backend python3 scripts/check_team_flip_candidates.py \
        --short-name "C of I" --season 2026
"""

import argparse
import sys
import os
import re

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection


def tokens(name: str):
    # Lowercase, keep alnum only, drop tiny stopwords that appear everywhere.
    if not name:
        return []
    raw = re.findall(r"[a-z0-9]+", name.lower())
    stop = {"of", "the", "college", "university", "state", "institute",
            "technology", "and", "u"}
    return [t for t in raw if t not in stop and len(t) > 1]


def first_index(hay: str, toks):
    """Lowest index in `hay` where any token from `toks` appears, or None."""
    best = None
    for t in toks:
        i = hay.find(t)
        if i >= 0 and (best is None or i < best):
            best = i
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--short-name", required=True)
    ap.add_argument("--season", type=int, default=2026)
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute("SELECT id FROM teams WHERE short_name = %s",
                    (args.short_name,))
        t = cur.fetchone()
        if not t:
            print(f"No team with short_name = {args.short_name!r}")
            return
        tid = t["id"]

        # Discover which column stores the box score URL. Different schemas use
        # different names (source_url, boxscore_url, sidearm_url, etc).
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'games'
        """)
        game_cols = {r["column_name"] for r in cur.fetchall()}
        url_candidates = [c for c in ("source_url", "boxscore_url", "box_url",
                                      "sidearm_url", "url")
                          if c in game_cols]
        if not url_candidates:
            print(f"No URL-ish column found on games. Columns: {sorted(game_cols)}")
            return
        url_col = url_candidates[0]
        print(f"Using games.{url_col} for slug parsing")
        print()

        cur.execute(f"""
            SELECT g.id, g.game_date,
                   g.home_team_id, g.away_team_id,
                   g.home_score, g.away_score,
                   g.{url_col} AS url,
                   ht.short_name AS home_name,
                   at.short_name AS away_name
            FROM games g
            LEFT JOIN teams ht ON ht.id = g.home_team_id
            LEFT JOIN teams at ON at.id = g.away_team_id
            WHERE g.season = %s
              AND g.status = 'final'
              AND (g.home_team_id = %s OR g.away_team_id = %s)
              AND g.home_score IS NOT NULL
              AND g.away_score IS NOT NULL
            ORDER BY g.game_date, g.id
        """, (args.season, tid, tid))
        rows = [dict(r) for r in cur.fetchall()]

        flip_candidates = []
        no_url = 0
        for r in rows:
            url = (r["url"] or "").lower()
            if not url:
                no_url += 1
                continue
            # Extract the slug segment between /stats/<year>/ and /boxscore/
            m = re.search(r"/stats/\d+/([^/]+)/boxscore", url)
            if not m:
                # Try looser pattern: just anything after /stats/year/
                m = re.search(r"/stats/\d+/([^/]+)", url)
            if not m:
                continue
            slug = m.group(1)

            home_toks = set(tokens(r["home_name"]))
            away_toks = set(tokens(r["away_name"]))
            # Drop tokens shared by both teams (e.g. both have "state").
            shared = home_toks & away_toks
            home_toks -= shared
            away_toks -= shared
            if not home_toks or not away_toks:
                continue

            h_idx = first_index(slug, home_toks)
            a_idx = first_index(slug, away_toks)
            if h_idx is None or a_idx is None:
                continue

            # Slug order is <away>-<home>. If stored home appears BEFORE
            # stored away, the ids are flipped.
            if h_idx < a_idx:
                flip_candidates.append({
                    "row": r, "slug": slug,
                    "h_idx": h_idx, "a_idx": a_idx,
                })

        print(f"Total final games: {len(rows)}")
        print(f"Games with no source URL: {no_url}")
        print(f"Flip candidates (home appears before away in slug): "
              f"{len(flip_candidates)}")
        print()
        if flip_candidates:
            print("FLIP CANDIDATES:")
            for c in flip_candidates:
                r = c["row"]
                print(f"  game_id={r['id']}  {r['game_date']}  "
                      f"stored: HOME={r['home_name']} ({r['home_score']})  "
                      f"AWAY={r['away_name']} ({r['away_score']})")
                print(f"    slug: {c['slug']}")
                print(f"    (home_tok_at={c['h_idx']} < away_tok_at={c['a_idx']})")
                print()

            ids = [c["row"]["id"] for c in flip_candidates]
            print("Suggested fix (team_ids only, not scores — per memory):")
            print("  BEGIN;")
            print(f"  UPDATE games")
            print(f"  SET home_team_id = away_team_id,")
            print(f"      away_team_id = home_team_id")
            print(f"  WHERE id = ANY(ARRAY{ids});")
            print("  -- Inspect result on a couple games first, then COMMIT")
            print("  -- or ROLLBACK if any candidate looks wrong.")


if __name__ == "__main__":
    main()
