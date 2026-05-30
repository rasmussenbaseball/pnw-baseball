#!/usr/bin/env python3
"""
Resolve player_id for summer_game_batting / summer_game_pitching rows.

The box-score scraper writes player_name verbatim from the box-score
HTML but leaves player_id NULL because we may not have synced the
Pointstreak roster yet. This script walks the unresolved rows and
matches them to summer_players within the same team_id.

Match strategy (per team):
  1. exact normalized "first last"
  2. exact normalized "last" (when the box gives just last)
  3. "f. last" -> any (team_id, first_initial + last) match
  4. fall back to last-name unique match if exactly one summer_player
     on that team has that last name

Usage:
    PYTHONPATH=backend python3 scripts/resolve_summer_game_players.py
    PYTHONPATH=backend python3 scripts/resolve_summer_game_players.py --dry-run
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
logger = logging.getLogger("resolve_summer_players")


def _norm(s):
    return re.sub(r"[^a-z]", "", (s or "").lower())


# Match a leading box-score order/position prefix that the Presto
# scraper occasionally leaves on the player name. Examples:
#   "1. Kolby Lukinchuk(W, 1-0)"  → "Kolby Lukinchuk"
#   "1bM.D. Conner"               → "M.D. Conner"
#   "rf  Noah Albanese"           → "Noah Albanese"
# Order digit + period: "1. ", "12. "
# Position code at start: "1b", "2b", "3b", "ss", "lf", "cf", "rf",
#   "c", "p", "dh", "ph", "pr", "of", "if".
# Position codes are emitted LOWERCASE by the box score and are either
# glued to a Capitalized name ("cAnders", "pKolby", "1bM.D.") or
# followed by whitespace ("rf  Noah"). We therefore match lowercase
# codes only (no re.IGNORECASE) AND require an uppercase letter,
# whitespace, or end-of-string right after the code. That way we never
# chop the leading capital off a real first name like "Casey", "Cole",
# or "Preston" (whose "C"/"pr" would otherwise match the "c"/"pr" code).
_PREFIX_RE = re.compile(
    r"^\s*(?:\d+\.\s*|(?:1b|2b|3b|ss|lf|cf|rf|dh|ph|pr|of|if|p|c)(?=[A-Z]|\s|$)\s*)+",
)
# Trailing pitcher decision parenthetical:
#   "Kolby Lukinchuk(W, 1-0)" or "Player Name (W)"
_DECISION_RE = re.compile(r"\s*\(\s*[WLSHBwlsbh][^)]*\)\s*$")


def sanitize_player_name(raw):
    """Strip box-score noise (order prefix, position prefix, decision
    parenthetical) so summer_players rows store the actual name."""
    if not raw:
        return ""
    n = raw.strip()
    n = _DECISION_RE.sub("", n)
    n = _PREFIX_RE.sub("", n)
    return n.strip()


def build_lookup(cur):
    """Return {team_id: {match_key: player_id}} + {team_id: {last: set(player_id)}}."""
    cur.execute(
        "SELECT id, team_id, first_name, last_name FROM summer_players"
    )
    exact = defaultdict(dict)
    by_last = defaultdict(lambda: defaultdict(set))
    for row in cur.fetchall():
        pid = row["id"]
        team_id = row["team_id"]
        first = (row.get("first_name") or "").strip()
        last = (row.get("last_name") or "").strip()
        if not (first or last):
            continue
        # Multiple keys per player for fuzzy match
        if first and last:
            exact[team_id][_norm(f"{first} {last}")] = pid
            exact[team_id][_norm(f"{first[0]} {last}")] = pid  # "F. Last"
        if last:
            exact[team_id][_norm(last)] = pid
            by_last[team_id][_norm(last)].add(pid)
    return exact, by_last


def resolve_one(name, team_id, exact, by_last):
    if not name or team_id is None:
        return None
    key = _norm(name)
    if not key:
        return None
    pid = exact.get(team_id, {}).get(key)
    if pid:
        return pid
    # last-name fallback when unique on the team
    # "First Last" -> use just last
    parts = name.strip().split()
    if len(parts) >= 2:
        last_key = _norm(parts[-1])
        cands = by_last.get(team_id, {}).get(last_key, set())
        if len(cands) == 1:
            return next(iter(cands))
    return None


def _split_first_last(name):
    """'F. Last' / 'First Last' / 'Last, First' -> (first, last)."""
    if not name:
        return "", ""
    name = name.strip()
    if "," in name:
        last, first = [p.strip() for p in name.split(",", 1)]
        return first, last
    parts = name.split()
    if len(parts) == 1:
        return "", parts[0]
    return parts[0].rstrip("."), " ".join(parts[1:])


def create_stub_player(cur, team_id, player_name, position=None):
    """Create a minimal summer_players row for a name we've never seen
    before. Pointstreak roster scrape fills in real bio data later."""
    cleaned = sanitize_player_name(player_name)
    first, last = _split_first_last(cleaned)
    if not last:
        return None
    cur.execute(
        """
        INSERT INTO summer_players (first_name, last_name, team_id, position)
        VALUES (%s, %s, %s, %s)
        RETURNING id
        """,
        (first, last, team_id, position),
    )
    return cur.fetchone()["id"]


def run(dry_run=False, create_stubs=True):
    with get_connection() as conn:
        cur = conn.cursor()
        exact, by_last = build_lookup(cur)
        logger.info(
            f"Loaded {sum(len(v) for v in exact.values())} player-name "
            f"keys across {len(exact)} teams"
        )

        # Batting (also pull position so we can stub with it)
        cur.execute(
            """
            SELECT id, team_id, player_name, position
            FROM summer_game_batting
            WHERE player_id IS NULL AND team_id IS NOT NULL
            """
        )
        batting_unresolved = cur.fetchall()
        # Pitching
        cur.execute(
            """
            SELECT id, team_id, player_name
            FROM summer_game_pitching
            WHERE player_id IS NULL AND team_id IS NOT NULL
            """
        )
        pitching_unresolved = cur.fetchall()

        logger.info(
            f"Unresolved: {len(batting_unresolved)} batting · "
            f"{len(pitching_unresolved)} pitching"
        )

        # Cache stubs we create this run so a player who batted AND
        # pitched gets one new summer_players row, not two.
        stub_cache = {}  # (team_id, norm_name) -> player_id

        def _resolve_or_stub(name, team_id, position=None):
            # Clean the box-score noise off the name BEFORE trying to
            # resolve so "Kolby Lukinchuk(W, 1-0)" matches an existing
            # "Kolby Lukinchuk" row instead of stubbing a new mess.
            clean = sanitize_player_name(name)
            pid = resolve_one(clean, team_id, exact, by_last)
            if pid is not None:
                return pid, False
            if not create_stubs or dry_run:
                return None, False
            cache_key = (team_id, _norm(clean))
            if cache_key in stub_cache:
                return stub_cache[cache_key], True
            pid = create_stub_player(cur, team_id, clean, position)
            if pid is not None:
                stub_cache[cache_key] = pid
                exact.setdefault(team_id, {})[_norm(clean)] = pid
            return pid, True

        bat_resolved = bat_stubbed = 0
        pit_resolved = pit_stubbed = 0
        for r in batting_unresolved:
            pid, stubbed = _resolve_or_stub(r["player_name"], r["team_id"], r.get("position"))
            if pid is None:
                continue
            bat_resolved += 1
            if stubbed:
                bat_stubbed += 1
            if not dry_run:
                cur.execute(
                    "UPDATE summer_game_batting SET player_id = %s WHERE id = %s",
                    (pid, r["id"]),
                )
        for r in pitching_unresolved:
            pid, stubbed = _resolve_or_stub(r["player_name"], r["team_id"], "P")
            if pid is None:
                continue
            pit_resolved += 1
            if stubbed:
                pit_stubbed += 1
            if not dry_run:
                cur.execute(
                    "UPDATE summer_game_pitching SET player_id = %s WHERE id = %s",
                    (pid, r["id"]),
                )

        if not dry_run:
            conn.commit()

        logger.info(
            f"Resolved: batting {bat_resolved}/{len(batting_unresolved)} "
            f"({bat_stubbed} new stubs) · "
            f"pitching {pit_resolved}/{len(pitching_unresolved)} "
            f"({pit_stubbed} new stubs)"
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-stubs", action="store_true",
                        help="Skip stub creation; only resolve to existing summer_players")
    args = parser.parse_args()
    run(dry_run=args.dry_run, create_stubs=not args.no_stubs)


if __name__ == "__main__":
    main()
