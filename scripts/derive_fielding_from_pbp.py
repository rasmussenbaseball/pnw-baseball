#!/usr/bin/env python3
"""Derive per-position fielding stats from play-by-play narratives.

Background
----------
D1 Sidearm box scores ship a structured fielding object per player per
game, so we get per-position fielding rows in `game_fielding` directly
from the box-score JSON. Non-D1 sources (D2/D3/NAIA Sidearm HTML,
NWAC Presto) only publish a single combined "season fielding" line per
player — no per-position breakdown.

What this script does
---------------------
Walks `game_events.result_text` for non-D1 games, parses each narrative
to figure out which DEFENSIVE POSITION made each putout / assist / error
/ DP / passed ball / SBA / CS / pickoff, then maps positions to the
specific player_id who started at that position for that game (using
`game_batting.position` as the per-game lineup snapshot, plus
`game_events.pitcher_player_id` for pitcher attribution).

The resulting rows get UPSERTed into `game_fielding`, then the existing
`aggregate_fielding.py` rolls them up into per-position `fielding_stats`
rows that the player page already knows how to render.

Caveats
-------
- We only know the STARTING lineup for each position (from game_batting).
  Defensive subs mid-game silently get attributed to the starter.
- Multi-position rows like '2B/SS' use the first listed position.
- Pitcher attribution per event uses `pitcher_player_id` (per-event).
- One PB per event regardless of how many runners advance.
- One error per (position, event) regardless of how many sub-clauses
  mention the same error.

Usage
-----
    PYTHONPATH=backend python3 scripts/derive_fielding_from_pbp.py \\
        --season 2026 --divisions D2 D3 NAIA JUCO
    PYTHONPATH=backend python3 scripts/aggregate_fielding.py --season 2026
"""

from __future__ import annotations

import argparse
import logging
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.models.database import get_connection  # noqa: E402


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Position normalization
# ---------------------------------------------------------------------------

# Canonical defensive positions we write to game_fielding.position.
VALID_POSITIONS = {"P", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"}

# Position synonyms in narrative text.
_POS_SYNONYMS = {
    "p": "P", "pitcher": "P",
    "c": "C", "catcher": "C",
    "1b": "1B", "first": "1B", "first base": "1B", "firstbase": "1B",
    "2b": "2B", "second": "2B", "second base": "2B",
    "3b": "3B", "third": "3B", "third base": "3B",
    "ss": "SS", "shortstop": "SS", "short": "SS",
    "lf": "LF", "left": "LF", "left field": "LF", "leftfield": "LF",
    "cf": "CF", "center": "CF", "center field": "CF", "centerfield": "CF",
    "rf": "RF", "right": "RF", "right field": "RF", "rightfield": "RF",
}


def norm_pos(token: str) -> str | None:
    """Normalize a position token to canonical uppercase form, or None."""
    if not token:
        return None
    t = token.strip().lower()
    # Strip trailing punctuation that creeps in from narrative tail.
    t = t.rstrip(".,;:!?)")
    # Some narratives say "to short" or "to lf" — both work.
    return _POS_SYNONYMS.get(t)


def lineup_position(raw: str | None) -> str | None:
    """Resolve a game_batting.position cell to a defensive position.

    Handles:
    - case (P / p → P)
    - multi-position strings ('2B/SS' → '2B', the listed primary)
    - non-defensive slots (DH, PH, PR, blank → None)
    """
    if not raw:
        return None
    primary = raw.split("/")[0].strip().upper()
    if primary in VALID_POSITIONS:
        return primary
    return None


# ---------------------------------------------------------------------------
# Narrative parser
# ---------------------------------------------------------------------------

# Stat keys we increment.
STAT_PO = "po"
STAT_A = "a"
STAT_E = "e"
STAT_DP = "dp"
STAT_TP = "tp"
STAT_PB = "pb"
STAT_SBA = "sba"
STAT_CS = "cs"
STAT_PICKOFF = "pickoffs"

# Regex toolkit. We keep them broad and let order handle precedence.
POS_TOKEN = r"(?:1b|2b|3b|ss|lf|cf|rf|c|p|short|shortstop|first|second|third|left|center|right|leftfield|centerfield|rightfield)"
RE_DP_3 = re.compile(
    rf"grounded into double play\s+({POS_TOKEN})\s+to\s+({POS_TOKEN})\s+to\s+({POS_TOKEN})",
    re.IGNORECASE,
)
RE_DP_2 = re.compile(
    rf"grounded into double play\s+({POS_TOKEN})\s+to\s+({POS_TOKEN})\b",
    re.IGNORECASE,
)
RE_TP_3 = re.compile(
    rf"grounded into triple play\s+({POS_TOKEN})\s+to\s+({POS_TOKEN})\s+to\s+({POS_TOKEN})",
    re.IGNORECASE,
)
RE_GROUND_OUT = re.compile(
    rf"\bgrounded out to\s+({POS_TOKEN})(?:\s+([\w\s]+?))?\b",
    re.IGNORECASE,
)
RE_GROUND_OUT_TO_TO = re.compile(
    rf"\bgrounded out to\s+({POS_TOKEN})\s+to\s+({POS_TOKEN})\b",
    re.IGNORECASE,
)
RE_AIR_OUT = re.compile(
    rf"\b(?:flied|fouled|popped|lined)\s+(?:out|up)\s+to\s+({POS_TOKEN})\b",
    re.IGNORECASE,
)
RE_K_PASSED = re.compile(
    rf"struck out (?:swinging|looking)?[,]?\s*out at first\s+({POS_TOKEN})\s+to\s+({POS_TOKEN})",
    re.IGNORECASE,
)
RE_K_ERROR = re.compile(
    rf"struck out.*?reached.*?error by\s+({POS_TOKEN})",
    re.IGNORECASE,
)
RE_K_PLAIN = re.compile(r"struck out (?:swinging|looking)\b", re.IGNORECASE)
RE_OUT_AT_3FIELDER = re.compile(
    rf"\bout at (?:first|second|third|home)\s+({POS_TOKEN})\s+to\s+({POS_TOKEN})\s+to\s+({POS_TOKEN})",
    re.IGNORECASE,
)
RE_OUT_AT_2FIELDER = re.compile(
    rf"\bout at (?:first|second|third|home)\s+({POS_TOKEN})\s+to\s+({POS_TOKEN})",
    re.IGNORECASE,
)
RE_OUT_AT_UNASSISTED = re.compile(
    rf"\bout at (?:first|second|third|home)\s+({POS_TOKEN})\s+unassisted",
    re.IGNORECASE,
)
RE_PICKED_OFF_NARR = re.compile(
    rf"picked off,\s*out at (?:first|second|third|home)\s+({POS_TOKEN})\s+to\s+({POS_TOKEN})",
    re.IGNORECASE,
)
RE_STOLE = re.compile(r"\bstole (?:second|third|home)\b", re.IGNORECASE)
RE_PB = re.compile(r"\bpassed ball\b", re.IGNORECASE)
RE_ERROR_BY = re.compile(rf"error by\s+({POS_TOKEN})", re.IGNORECASE)


def _strip_parens(text: str) -> str:
    """Drop pitch-sequence and similar parenthetical noise."""
    return re.sub(r"\([^)]*\)", "", text)


def parse_fielding_events(result_text: str) -> list[tuple[str, str, int]]:
    """Parse a result_text into a list of (position, stat_key, delta) tuples.

    Idempotent and side-effect-free. Returns deltas with no dedup —
    callers (or the caller-side accumulator) should handle dedup for
    once-per-event stats like passed balls and per-position errors.
    """
    if not result_text:
        return []

    text = _strip_parens(result_text)
    deltas: list[tuple[str, str, int]] = []

    # Track positions we've already credited an error to in THIS event,
    # so multi-clause "error by c... error by c" doesn't double-count.
    errored_positions: set[str] = set()
    # PB is one per event regardless of runners.
    pb_already_credited = False

    clauses = [c.strip() for c in text.split(";") if c.strip()]
    for clause in clauses:
        # ---- 1. Triple play (rare but well-shaped) ----
        m = RE_TP_3.search(clause)
        if m:
            f1, f2, f3 = (norm_pos(m.group(i)) for i in (1, 2, 3))
            if f1:
                deltas.append((f1, STAT_A, 1))
            if f2:
                deltas.append((f2, STAT_PO, 1))
                deltas.append((f2, STAT_A, 1))
            if f3:
                deltas.append((f3, STAT_PO, 1))
            for f in (f1, f2, f3):
                if f:
                    deltas.append((f, STAT_TP, 1))
            continue

        # ---- 2. Double play (3-fielder) ----
        m = RE_DP_3.search(clause)
        if m:
            f1, f2, f3 = (norm_pos(m.group(i)) for i in (1, 2, 3))
            if f1:
                deltas.append((f1, STAT_A, 1))
            if f2:
                deltas.append((f2, STAT_PO, 1))
                deltas.append((f2, STAT_A, 1))
            if f3:
                deltas.append((f3, STAT_PO, 1))
            for f in (f1, f2, f3):
                if f:
                    deltas.append((f, STAT_DP, 1))
            continue

        # ---- 3. Double play (2-fielder) ----
        m = RE_DP_2.search(clause)
        if m:
            f1, f2 = (norm_pos(m.group(i)) for i in (1, 2))
            if f1:
                deltas.append((f1, STAT_A, 1))
            if f2:
                deltas.append((f2, STAT_PO, 1))
            for f in (f1, f2):
                if f:
                    deltas.append((f, STAT_DP, 1))
            continue

        # ---- 4. Strikeout edge cases ----
        if "struck out" in clause.lower():
            m_err = RE_K_ERROR.search(clause)
            if m_err:
                pos = norm_pos(m_err.group(1))
                if pos and pos not in errored_positions:
                    deltas.append((pos, STAT_E, 1))
                    errored_positions.add(pos)
                continue
            m_passed = RE_K_PASSED.search(clause)
            if m_passed:
                f1 = norm_pos(m_passed.group(1))
                f2 = norm_pos(m_passed.group(2))
                if f1:
                    deltas.append((f1, STAT_A, 1))
                if f2:
                    deltas.append((f2, STAT_PO, 1))
                continue
            # Standard K: catcher PO (the "out" credit on a K).
            deltas.append(("C", STAT_PO, 1))
            continue

        # ---- 5. Ground out (handle "to X to Y" before plain "to X") ----
        m = RE_GROUND_OUT_TO_TO.search(clause)
        if m:
            f1 = norm_pos(m.group(1))
            f2 = norm_pos(m.group(2))
            if f1:
                deltas.append((f1, STAT_A, 1))
            if f2:
                deltas.append((f2, STAT_PO, 1))
            continue
        m = RE_GROUND_OUT.search(clause)
        if m:
            pos = norm_pos(m.group(1))
            if "unassisted" in clause.lower():
                # Single fielder PO (often p, 1b, or 3b).
                if pos:
                    deltas.append((pos, STAT_PO, 1))
            else:
                # Default: <pos> assist, 1B PO. If <pos>=1B no assist.
                if pos:
                    if pos == "1B":
                        deltas.append(("1B", STAT_PO, 1))
                    else:
                        deltas.append((pos, STAT_A, 1))
                        deltas.append(("1B", STAT_PO, 1))
            continue

        # ---- 6. Air outs (fly / foul / pop / line) ----
        m = RE_AIR_OUT.search(clause)
        if m:
            pos = norm_pos(m.group(1))
            if pos:
                deltas.append((pos, STAT_PO, 1))
            continue

        # ---- 7. Pickoffs ("picked off, out at ...") ----
        m = RE_PICKED_OFF_NARR.search(clause)
        if m:
            f1 = norm_pos(m.group(1))
            f2 = norm_pos(m.group(2))
            if f1:
                deltas.append((f1, STAT_A, 1))
                deltas.append((f1, STAT_PICKOFF, 1))
            if f2:
                deltas.append((f2, STAT_PO, 1))
            continue

        # ---- 8. "out at <base> X to Y to Z" (3-fielder runner out) ----
        m = RE_OUT_AT_3FIELDER.search(clause)
        if m:
            f1 = norm_pos(m.group(1))
            f2 = norm_pos(m.group(2))
            f3 = norm_pos(m.group(3))
            if "picked off" in clause.lower():
                if f1:
                    deltas.append((f1, STAT_A, 1))
                    deltas.append((f1, STAT_PICKOFF, 1))
                if f2:
                    deltas.append((f2, STAT_A, 1))
                if f3:
                    deltas.append((f3, STAT_PO, 1))
            else:
                if f1:
                    deltas.append((f1, STAT_A, 1))
                if f2:
                    deltas.append((f2, STAT_A, 1))
                if f3:
                    deltas.append((f3, STAT_PO, 1))
            continue

        # ---- 9. "out at <base> X to Y" (2-fielder runner out) ----
        m = RE_OUT_AT_2FIELDER.search(clause)
        if m:
            f1 = norm_pos(m.group(1))
            f2 = norm_pos(m.group(2))
            cs = "caught stealing" in clause.lower()
            picked = "picked off" in clause.lower()
            if f1:
                deltas.append((f1, STAT_A, 1))
                if cs and f1 == "C":
                    deltas.append(("C", STAT_CS, 1))
                if picked:
                    deltas.append((f1, STAT_PICKOFF, 1))
            if f2:
                deltas.append((f2, STAT_PO, 1))
            continue

        # ---- 10. "out at <base> X unassisted" ----
        m = RE_OUT_AT_UNASSISTED.search(clause)
        if m:
            pos = norm_pos(m.group(1))
            cs = "caught stealing" in clause.lower()
            if pos:
                deltas.append((pos, STAT_PO, 1))
                if cs and pos == "C":
                    deltas.append(("C", STAT_CS, 1))
            continue

        # ---- 11. Stole base (catcher SBA) ----
        if RE_STOLE.search(clause):
            deltas.append(("C", STAT_SBA, 1))
            # don't continue — there could be an error sub-clause too,
            # but typically the stolen-base clause is standalone.

        # ---- 12. Passed ball (once per event) ----
        if not pb_already_credited and RE_PB.search(clause):
            deltas.append(("C", STAT_PB, 1))
            pb_already_credited = True
            # continue to allow possible co-occurring error parse below

        # ---- 13. Error by <position> ----
        for m in RE_ERROR_BY.finditer(clause):
            pos = norm_pos(m.group(1))
            if pos and pos not in errored_positions:
                deltas.append((pos, STAT_E, 1))
                errored_positions.add(pos)

    return deltas


# ---------------------------------------------------------------------------
# Lineup map per game/team
# ---------------------------------------------------------------------------

def build_lineup_map(cur, game_id: int) -> dict[tuple[int, str], int]:
    """Return {(team_id, POSITION): player_id} using game_batting.

    Multi-position notation uses primary (first listed) position.
    First row per (team_id, position) wins — typically the starter.
    """
    cur.execute(
        """
        SELECT team_id, position, player_id
        FROM game_batting
        WHERE game_id = %s
        ORDER BY id
        """,
        (game_id,),
    )
    out: dict[tuple[int, str], int] = {}
    for row in cur.fetchall():
        pos = lineup_position(row["position"])
        if not pos:
            continue
        key = (row["team_id"], pos)
        if key not in out:
            out[key] = row["player_id"]
    return out


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

# Accumulator key: (team_id, player_id, position) → stat_dict
StatBucket = dict[tuple[int, int, str], dict[str, int]]


def _bump(bucket: StatBucket, team_id: int, player_id: int,
          pos: str, stat: str, delta: int = 1) -> None:
    key = (team_id, player_id, pos)
    if key not in bucket:
        bucket[key] = {
            STAT_PO: 0, STAT_A: 0, STAT_E: 0, STAT_DP: 0, STAT_TP: 0,
            STAT_PB: 0, STAT_SBA: 0, STAT_CS: 0, STAT_PICKOFF: 0,
        }
    bucket[key][stat] += delta


def derive_game(cur, game_id: int) -> StatBucket:
    """Walk all events in one game, return per-(player,position) deltas."""
    lineup = build_lineup_map(cur, game_id)
    cur.execute(
        """
        SELECT defending_team_id, pitcher_player_id, result_text
        FROM game_events
        WHERE game_id = %s
          AND result_text IS NOT NULL
        ORDER BY inning, sequence_idx, id
        """,
        (game_id,),
    )
    rows = cur.fetchall()

    bucket: StatBucket = {}
    for row in rows:
        team_id = row["defending_team_id"]
        if not team_id:
            continue
        deltas = parse_fielding_events(row["result_text"])
        for pos, stat, delta in deltas:
            if pos == "P":
                pid = row["pitcher_player_id"]
            else:
                pid = lineup.get((team_id, pos))
            if not pid:
                # We know what position made the play but can't tie
                # it to a player_id. Skip rather than write a NULL.
                continue
            _bump(bucket, team_id, pid, pos, stat, delta)
    return bucket


def upsert_game_fielding(cur, game_id: int, bucket: StatBucket) -> int:
    """UPSERT bucket rows into game_fielding. Returns rows written."""
    if not bucket:
        return 0
    written = 0
    for (team_id, player_id, position), stats in bucket.items():
        # Skip empty rows defensively (parser shouldn't emit them, but
        # just in case — only write if at least one stat is non-zero).
        if not any(stats.values()):
            continue
        cur.execute(
            """
            INSERT INTO game_fielding (
                game_id, team_id, player_id, position,
                innings, games_started,
                putouts, assists, errors,
                double_plays, triple_plays,
                passed_balls, stolen_bases_against,
                caught_stealing_by, pickoffs,
                catchers_interference
            ) VALUES (
                %s, %s, %s, %s,
                NULL, 0,
                %s, %s, %s,
                %s, %s,
                %s, %s,
                %s, %s,
                0
            )
            ON CONFLICT (game_id, player_id, position) DO UPDATE SET
                team_id = EXCLUDED.team_id,
                putouts = EXCLUDED.putouts,
                assists = EXCLUDED.assists,
                errors = EXCLUDED.errors,
                double_plays = EXCLUDED.double_plays,
                triple_plays = EXCLUDED.triple_plays,
                passed_balls = EXCLUDED.passed_balls,
                stolen_bases_against = EXCLUDED.stolen_bases_against,
                caught_stealing_by = EXCLUDED.caught_stealing_by,
                pickoffs = EXCLUDED.pickoffs,
                updated_at = now()
            """,
            (
                game_id, team_id, player_id, position,
                stats[STAT_PO], stats[STAT_A], stats[STAT_E],
                stats[STAT_DP], stats[STAT_TP],
                stats[STAT_PB], stats[STAT_SBA],
                stats[STAT_CS], stats[STAT_PICKOFF],
            ),
        )
        written += 1
    return written


def games_for(cur, season: int, divisions: list[str]) -> list[int]:
    """Return game IDs to derive."""
    placeholders = ",".join(["%s"] * len(divisions))
    cur.execute(
        f"""
        SELECT DISTINCT g.id
        FROM games g
        JOIN teams t ON g.home_team_id = t.id
        JOIN conferences c ON t.conference_id = c.id
        JOIN divisions d ON c.division_id = d.id
        WHERE g.season = %s
          AND d.level IN ({placeholders})
          AND EXISTS (
            SELECT 1 FROM game_events ge
            WHERE ge.game_id = g.id AND ge.result_text IS NOT NULL
          )
        ORDER BY g.id
        """,
        (season, *divisions),
    )
    return [r["id"] for r in cur.fetchall()]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument(
        "--divisions",
        nargs="+",
        default=["D2", "D3", "NAIA", "JUCO"],
        help="Divisions to derive (default: D2 D3 NAIA JUCO).",
    )
    ap.add_argument("--limit", type=int, help="Only process N games (for testing).")
    ap.add_argument("--dry-run", action="store_true", help="Parse but don't write.")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()
        game_ids = games_for(cur, args.season, args.divisions)
        if args.limit:
            game_ids = game_ids[: args.limit]
        logger.info(
            "Deriving fielding from PBP: season=%s divisions=%s games=%d dry_run=%s",
            args.season, args.divisions, len(game_ids), args.dry_run,
        )
        total_rows = 0
        for i, gid in enumerate(game_ids, 1):
            bucket = derive_game(cur, gid)
            if not args.dry_run:
                total_rows += upsert_game_fielding(cur, gid, bucket)
            else:
                total_rows += sum(1 for stats in bucket.values() if any(stats.values()))
            if i % 100 == 0:
                logger.info("  ... %d/%d games processed (%d rows)", i, len(game_ids), total_rows)
                if not args.dry_run:
                    conn.commit()
        if not args.dry_run:
            conn.commit()
        logger.info("Done. Wrote %d game_fielding rows across %d games.", total_rows, len(game_ids))

    return 0


if __name__ == "__main__":
    sys.exit(main())
