#!/usr/bin/env python3
"""
Auto-link summer_players to spring players (summer_player_links).

When a WCL roster lists a player who also plays college spring ball
on a PNW team, we want the spring player profile to surface
"Currently with: <WCL team>" and the summer profile to surface
"View college profile". That link lives in summer_player_links.

Match strategy:
  1. Build candidates by normalized "first last" name.
  2. Score each summer_player → spring_player pair:
       +10  exact normalized full-name match (always required)
       +20  college string contains spring team's short_name (or vice versa)
       +5   college matches by alias (Saddleback CC → Saddleback)
  3. Pick the single highest-scoring spring player. Ties → skip
     (we don't want to silently link "John Smith" to one of two).

Usage:
    PYTHONPATH=backend python3 scripts/link_summer_to_spring.py
    PYTHONPATH=backend python3 scripts/link_summer_to_spring.py --dry-run
    PYTHONPATH=backend python3 scripts/link_summer_to_spring.py --season 2026 --rescore
"""

import argparse
import logging
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.models.database import get_connection


logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("link_summer_to_spring")


def _norm(s):
    return re.sub(r"[^a-z]", "", (s or "").lower())


def _norm_school(s):
    """College name → comparison key. Strip suffixes like 'CC',
    'Community College', 'University', state words."""
    if not s:
        return ""
    s = s.lower()
    for junk in ("community college", "comm college", "university", " of ",
                 "college", "state", " cc", " jc"):
        s = s.replace(junk, " ")
    return re.sub(r"[^a-z]", "", s)


def load_spring_candidates(cur):
    """Returns dict: norm_full_name -> list of {id, first, last, team_id, team_short, school_name}.

    Only active 2026 players to keep the candidate pool reasonable.
    """
    cur.execute(
        """
        SELECT DISTINCT p.id, p.first_name, p.last_name,
               p.team_id, t.short_name AS team_short, t.school_name
        FROM players p
        JOIN teams t ON t.id = p.team_id
        WHERE COALESCE(t.is_active, 1) = 1
          AND COALESCE(p.is_phantom, FALSE) = FALSE
        """
    )
    by_name = defaultdict(list)
    for row in cur.fetchall():
        key = _norm(f"{row['first_name']} {row['last_name']}")
        by_name[key].append({
            "id": row["id"],
            "first": row["first_name"],
            "last": row["last_name"],
            "team_id": row["team_id"],
            "team_short": row["team_short"] or "",
            "school_name": row["school_name"] or "",
        })
    return by_name


def load_summer_unlinked(cur, season):
    """Return unlinked summer_players who appear in a game during
    `season` (so we don't try to link inactive prior-year roster
    ghosts)."""
    cur.execute(
        """
        SELECT DISTINCT sp.id, sp.first_name, sp.last_name, sp.college,
               t.short_name AS team_short, t.name AS team_name
        FROM summer_players sp
        JOIN summer_teams t ON t.id = sp.team_id
        WHERE NOT EXISTS (
            SELECT 1 FROM summer_player_links spl WHERE spl.summer_player_id = sp.id
        )
        AND (
          EXISTS (
            SELECT 1 FROM summer_game_batting gb
            JOIN summer_games g ON g.id = gb.game_id
            WHERE gb.player_id = sp.id AND g.season = %s
          )
          OR EXISTS (
            SELECT 1 FROM summer_game_pitching gp
            JOIN summer_games g ON g.id = gp.game_id
            WHERE gp.player_id = sp.id AND g.season = %s
          )
        )
        """,
        (season, season),
    )
    return cur.fetchall()


def score_match(summer_player, spring_candidate):
    """Higher = better. <10 = no link."""
    score = 10  # base for name match
    summer_college = _norm_school(summer_player.get("college") or "")
    spring_school = _norm_school(spring_candidate["school_name"])
    spring_short = _norm_school(spring_candidate["team_short"])
    if summer_college and spring_school:
        if summer_college == spring_school:
            score += 20
        elif summer_college in spring_school or spring_school in summer_college:
            score += 15
        elif spring_short and (summer_college in spring_short or spring_short in summer_college):
            score += 5
    return score


def run(season, dry_run=False, rescore=False):
    with get_connection() as conn:
        cur = conn.cursor()
        spring_by_name = load_spring_candidates(cur)
        logger.info(f"Loaded {sum(len(v) for v in spring_by_name.values())} spring candidates "
                    f"under {len(spring_by_name)} unique full names")

        if rescore:
            logger.info("Rescore mode: clearing existing links before re-linking")
            if not dry_run:
                cur.execute("DELETE FROM summer_player_links WHERE confidence = 'auto'")

        unlinked = load_summer_unlinked(cur, season)
        logger.info(f"Unlinked summer_players with {season} game data: {len(unlinked)}")

        linked = 0
        ambiguous = 0
        no_candidate = 0
        for sp in unlinked:
            key = _norm(f"{sp['first_name']} {sp['last_name']}")
            cands = spring_by_name.get(key, [])
            if not cands:
                no_candidate += 1
                continue
            # Score every candidate, pick best
            scored = [(score_match(dict(sp), c), c) for c in cands]
            scored.sort(key=lambda x: -x[0])
            top_score = scored[0][0]
            top_candidates = [c for s, c in scored if s == top_score]
            if len(top_candidates) > 1:
                # Tie at the top → ambiguous, skip
                ambiguous += 1
                continue
            chosen = top_candidates[0]
            logger.debug(
                f"  link {sp['first_name']} {sp['last_name']} "
                f"({sp.get('college') or '?'} → {chosen['team_short']}) score={top_score}"
            )
            linked += 1
            if not dry_run:
                cur.execute(
                    """
                    INSERT INTO summer_player_links (summer_player_id, spring_player_id, confidence)
                    VALUES (%s, %s, 'auto')
                    ON CONFLICT (summer_player_id) DO NOTHING
                    """,
                    (sp["id"], chosen["id"]),
                )

        if not dry_run:
            conn.commit()

        logger.info(
            f"Linked: {linked} · Ambiguous: {ambiguous} · "
            f"No spring candidate: {no_candidate}"
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--rescore", action="store_true",
                        help="Delete existing 'auto' links and recompute")
    args = parser.parse_args()
    run(args.season, dry_run=args.dry_run, rescore=args.rescore)


if __name__ == "__main__":
    main()
