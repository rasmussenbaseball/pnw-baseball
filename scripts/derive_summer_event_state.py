#!/usr/bin/env python3
"""
Derive base/out/score state for every PA in summer_game_events.

Summer (WCL) port of scripts/derive_event_state.py — same runner-tracking
state machine, same derived column names, operating on the summer_* tables
(summer_game_events / summer_games / summer_game_batting). The wclstats.com
narratives use the same StatCrew grammar as spring Sidearm/Presto text
("Anthony Setticasi grounded out to c (1-0 B); Kade Crawford advanced to
second."), so the clause parser carries over unchanged; one addition is the
chained ", out at <base>" pattern ("advanced to third, out at home rf to c")
which WCL scorers use inside a single runner clause.

Reads summer_game_events rows for a game, walks them in (inning ASC,
top-before-bottom, sequence_idx ASC) order, and computes:

    outs_before, outs_after
    bases_before, bases_after          (3-char string '000'..'111'; idx 0 = 1B)
    runs_on_play
    bat_score_before, fld_score_before
    r1_name / r2_name / r3_name        runner identity on each base
    r1_player_id / r2_player_id / r3_player_id   resolved via summer_game_batting

Adds the columns via ALTER TABLE ... ADD COLUMN IF NOT EXISTS (names mirror
spring game_events EXACTLY so downstream SQL ports cleanly).

Idempotent — skips games already derived (state_derived_at) unless --force.

Usage:
    # Dry-run audit (no writes; prints per-game reconciliation)
    python3 scripts/derive_summer_event_state.py --season 2026 --dry-run

    # Single game (smoke test)
    python3 scripts/derive_summer_event_state.py --game-id 97 --dry-run

    # Backfill all underived games
    python3 scripts/derive_summer_event_state.py --season 2026

    # Re-derive everything (after parser fix)
    python3 scripts/derive_summer_event_state.py --season 2026 --force
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

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
DATABASE_URL = os.environ.get("DATABASE_URL")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def get_conn():
    url = DATABASE_URL
    if url and "sslmode" not in url:
        url += ("&" if "?" in url else "?") + "sslmode=require"
    conn = psycopg2.connect(url)
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def ensure_schema(cur):
    """Add the derived-state columns (idempotent). Column names + types
    mirror spring game_events exactly."""
    for col, typ in (
        ("outs_before", "SMALLINT"),
        ("outs_after", "SMALLINT"),
        ("bases_before", "TEXT"),
        ("bases_after", "TEXT"),
        ("runs_on_play", "SMALLINT"),
        ("bat_score_before", "SMALLINT"),
        ("fld_score_before", "SMALLINT"),
        ("r1_name", "TEXT"),
        ("r2_name", "TEXT"),
        ("r3_name", "TEXT"),
        ("r1_player_id", "INTEGER"),
        ("r2_player_id", "INTEGER"),
        ("r3_player_id", "INTEGER"),
        ("state_derived_at", "TIMESTAMPTZ"),
    ):
        cur.execute(
            f"ALTER TABLE summer_game_events ADD COLUMN IF NOT EXISTS {col} {typ}"
        )


# ─────────────────────────────────────────────────────────────────
# Name normalization
# ─────────────────────────────────────────────────────────────────
# Narratives mix forms ("M. Aikawa", "Aikawa", "Michael Aikawa"). We
# normalize to a lowercase last-name token for cross-reference within a
# game. If two batters share a last name we still distinguish via initial.

_PUNCT_RE = re.compile(r"[.,;:!?]")


def _norm_last(name):
    """Lowercase last-name-ish key for runner matching.

    Handles both narrative formats scorers use:
      - "FirstName LastName"  -> last word
      - "LastName,FirstName"  -> pre-comma chunk
      - Drops Jr/Sr/III suffixes
    """
    if not name:
        return ""
    s = name.strip()
    if "," in s:
        # "Last,First" or "Last, First"
        return s.split(",", 1)[0].strip().lower()
    s = _PUNCT_RE.sub("", s).strip()
    parts = s.split()
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0].lower()
    last = parts[-1]
    if last.lower() in {"jr", "sr", "ii", "iii", "iv"} and len(parts) >= 2:
        last = parts[-2]
    return last.lower()


# ─────────────────────────────────────────────────────────────────
# Per-clause regexes
# ─────────────────────────────────────────────────────────────────
# Note: `who` allows commas to support "Last,First" name format. Clauses
# are already split on ';' so we only need to exclude that.
SCORED_RE          = re.compile(r"^(?P<who>[^;]+?)\s+scored\b", re.IGNORECASE)
ADV_RE             = re.compile(r"^(?P<who>[^;]+?)\s+(?:advanced|moved|stole)\s+to\s+(?P<base>second|third|home)\b", re.IGNORECASE)
STOLE_RE           = re.compile(r"^(?P<who>[^;]+?)\s+stole\s+(?P<base>second|third|home)\b", re.IGNORECASE)
OUT_AT_RE          = re.compile(r"^(?P<who>[^;]+?)\s+(?:was\s+)?(?:thrown\s+)?out\s+at\s+(?P<base>first|second|third|home)\b", re.IGNORECASE)
OUT_ON_PLAY_RE     = re.compile(r"^(?P<who>[^;]+?)\s+(?:out\s+on\s+the\s+play|out\s+on\s+a\s+(?:double|triple)\s+play|put\s+out)\b", re.IGNORECASE)
PICKED_OFF_RE      = re.compile(r"^(?P<who>[^;]+?)\s+(?:was\s+)?picked\s+off\b", re.IGNORECASE)
CAUGHT_STEAL_RE    = re.compile(r"caught\s+stealing", re.IGNORECASE)
FAILED_PICKOFF_RE  = re.compile(r"failed\s+pickoff\s+attempt", re.IGNORECASE)

# Within ONE clause a runner can be bumped further: "stole second, advanced
# to third on the throw" or "advanced to second on a wild pitch, advanced
# to third" — second move has no name (implicit, same runner).
CHAIN_ADV_RE = re.compile(
    r",\s*(?:advanced|moved)\s+to\s+(?P<base>second|third|home)\b",
    re.IGNORECASE,
)
CHAIN_SCORED_RE = re.compile(
    r",\s*(?:and\s+)?scored\b(?!\s+from)",  # avoid "scored from X" which is part of HR sub-text
    re.IGNORECASE,
)
# WCL scorers chain an out inside an advance clause: "advanced to third,
# out at home rf to c" — the runner was ultimately thrown out.
CHAIN_OUT_RE = re.compile(
    r",\s*(?:was\s+)?(?:thrown\s+)?out\s+at\s+(?P<base>first|second|third|home)\b",
    re.IGNORECASE,
)

# Reached-on-error: parses where the BATTER ended up
REACHED_BASE_RE    = re.compile(r"reached\s+(first|second|third)\b", re.IGNORECASE)

# wclstats.com data artifact: the "scored" verb is sometimes dropped and
# the runner's name doubled instead — "Easton Mould Easton Mould." /
# "Tanner Johns Tanner Johns, unearned." Always sits where a scored
# clause would (RBI counts + line scores confirm). Treat as scored.
DUP_NAME_SCORED_RE = re.compile(
    r"^(?P<who>.+?)\s+(?P=who)\s*(?:,\s*unearned)?\s*\.?\s*$",
    re.IGNORECASE,
)


# ─────────────────────────────────────────────────────────────────
# Per-result-type batter destination
# ─────────────────────────────────────────────────────────────────
# Where does the BATTER end up immediately after their primary outcome
# (before any subsequent runner narrative)? None = batter is out, no base.
BATTER_DEST = {
    "single":            1,
    "double":            2,
    "triple":            3,
    "home_run":          0,    # 0 = scored, special
    "walk":              1,
    "intentional_walk":  1,
    "hbp":               1,
    "catcher_interference": 1,
    "fielders_choice":   1,    # batter usually reaches first; runner is out
    "error":             None, # unknown — parse "reached first/second/third" from text
    "ground_out":        None,
    "fly_out":           None,
    "line_out":          None,
    "pop_out":           None,
    "strikeout_swinging": None,
    "strikeout_looking": None,
    "sac_fly":           None,
    "sac_bunt":          None, # sometimes reaches base; we'll parse text
    "double_play":       None,
    "triple_play":       None,
}

BATTER_OUT_TYPES = {
    "ground_out", "fly_out", "line_out", "pop_out",
    "strikeout_swinging", "strikeout_looking",
    "sac_fly", "sac_bunt", "double_play", "triple_play",
}

# Sub-event types — no batter, no PA-completion; runner clauses applied
# directly. derive_game treats these specially (every clause is a runner
# clause, not a batter outcome).
SUBEVENT_TYPES = {
    "wild_pitch", "passed_ball", "balk",
    "stolen_base", "caught_stealing",
    "pickoff", "runner_other",
    "runner_sub",   # pinch/courtesy runner — handled specially below
}

# Group 1 = new runner; group 2 = displaced runner.
RUNNER_SUB_RE = re.compile(
    r"^(.+?)\s+(?:pinch|courtesy)\s+ran\s+for\s+(.+?)\.?\s*$",
    re.IGNORECASE,
)


# ─────────────────────────────────────────────────────────────────
# Bases helpers
# ─────────────────────────────────────────────────────────────────
def bases_str(bases):
    """{1: name|None, 2: name|None, 3: name|None} -> '101'."""
    return "".join("1" if bases[b] else "0" for b in (1, 2, 3))


def empty_bases():
    return {1: None, 2: None, 3: None}


def find_runner(bases, last_key):
    """Return base number where a runner with last_key sits, else None."""
    for b in (3, 2, 1):  # check higher bases first (closer to scoring)
        v = bases[b]
        if v and _norm_last(v) == last_key:
            return b
    return None


def remove_runner(bases, base):
    bases[base] = None


def place_runner(bases, base, name):
    """Put `name` on `base`. Always returns 0 — silent overwrite is a
    known limitation when the scorer omits a runner movement (same
    rationale as spring derive_event_state.place_runner)."""
    bases[base] = name
    return 0


def vacate_to(bases, dest_base, name):
    """Move `name` from wherever they are (or unknown) onto dest_base."""
    last_key = _norm_last(name)
    src = find_runner(bases, last_key)
    if src is not None:
        bases[src] = None
    return place_runner(bases, dest_base, name)


BASE_NUM = {"first": 1, "second": 2, "third": 3, "home": 0}


# ─────────────────────────────────────────────────────────────────
# Apply one PA's narrative to mutable state
# ─────────────────────────────────────────────────────────────────
def split_clauses(text):
    """Split a narrative into clauses on ';'. The first clause is the
    batter action; the rest are runner movements."""
    if not text:
        return []
    return [c.strip() for c in text.split(";") if c.strip()]


# Match the BATTER's own batter clause (the bit before any ;) for
# follow-up narrative like "advanced to second on an error" and
# ", scored, unearned" / ", scored on a wild pitch". These extend the
# batter's own movement WITHOUT introducing a new runner.
BATTER_OWN_ADV_RE = re.compile(
    r"advanced to (?P<base>second|third|home) on (?:a |an |the )?"
    r"(?:throw|throwing\s+error|error|wild\s+pitch|passed\s+ball|balk|fielding\s+error)",
    re.IGNORECASE,
)
BATTER_OWN_SCORED_RE = re.compile(
    r",\s*scored\b|\bscored\s+on\s+(?:a\s+|an\s+|the\s+)?(?:throw|throwing\s+error|"
    r"error|wild\s+pitch|passed\s+ball|balk|fielding\s+error)",
    re.IGNORECASE,
)


def apply_batter_outcome(ev, bases, batter_name):
    """Place the batter on a base (or score them) per result_type. Returns
    the number of runs scored by THE BATTER (HR, or batter who advanced
    further on an error / wild pitch within their own batter clause)."""
    rtype = ev["result_type"]
    text = ev["result_text"] or ""
    # The batter clause is everything up to the first ';' (rest of the
    # narrative is about other runners). If the narrative HAS runner
    # clauses, the scorer told us where everyone went — we should NOT
    # second-guess them with the force-chain heuristic.
    has_runner_clauses = ";" in text
    batter_clause = text.split(";", 1)[0]

    # Parse "reached first/second/third on an error" for error type
    runs_disp = 0
    if rtype == "error":
        m = REACHED_BASE_RE.search(text)
        if m:
            base_word = m.group(1).lower()
            dest = BASE_NUM.get(base_word, 1)
        else:
            dest = 1
        if dest > 0:
            runs_disp += place_runner(bases, dest, batter_name)
        return runs_disp

    # Sac bunt: usually batter is out, but sometimes reaches on E
    if rtype == "sac_bunt":
        m = REACHED_BASE_RE.search(text)
        if m and "reached" in text.lower():
            dest = BASE_NUM.get(m.group(1).lower(), 1)
            if dest > 0:
                runs_disp += place_runner(bases, dest, batter_name)
        return runs_disp

    # Strikeout that reaches on a wild pitch / passed ball / dropped 3rd
    if rtype in ("strikeout_swinging", "strikeout_looking"):
        if re.search(r"reached\s+first", text, re.IGNORECASE):
            runs_disp += place_runner(bases, 1, batter_name)
        return runs_disp

    dest = BATTER_DEST.get(rtype)
    if dest is None:
        # Pure out — nothing to place
        return 0
    if dest == 0:
        # Home run: batter scores
        return 1

    # Force-chain inference: walks / HBP / CI / FC push existing runners
    # forward when 1B is occupied, even when the scorer omits explicit
    # "X advanced" narrative. We run this BEFORE placing the batter so
    # we don't clobber. Only fires when 1B is still occupied AT THIS
    # POINT — runner-clauses have already run by the time we get here
    # (derive_game reordered the calls), so any runner that was
    # explicitly moved is already gone from 1B.
    if rtype in ("walk", "intentional_walk", "hbp",
                 "catcher_interference", "fielders_choice") \
            and not has_runner_clauses:
        if dest == 1 and bases[1] is not None:
            r1 = bases[1]
            if bases[2] is not None:
                r2 = bases[2]
                if bases[3] is not None:
                    # Bases loaded → R3 scored (forced)
                    runs_disp += 1
                    bases[3] = r2  # R2 forced to 3B
                else:
                    bases[3] = r2  # R2 forced to 3B
                bases[2] = r1      # R1 forced to 2B
            else:
                bases[2] = r1      # R1 forced to 2B
            bases[1] = None        # Clear so place_runner doesn't double-place

    runs_disp += place_runner(bases, dest, batter_name)

    # Did the batter advance further within their OWN clause? "Singled,
    # advanced to second on an error" / "Singled, ..., scored, unearned"
    if BATTER_OWN_SCORED_RE.search(batter_clause):
        # Batter scored on the same play
        last_key = _norm_last(batter_name)
        b = find_runner(bases, last_key)
        if b is not None:
            remove_runner(bases, b)
        return runs_disp + 1

    m = BATTER_OWN_ADV_RE.search(batter_clause)
    if m:
        bumped_to = BASE_NUM.get(m.group("base").lower(), dest)
        if bumped_to > dest:
            # Move the batter from `dest` up to `bumped_to`
            remove_runner(bases, dest)
            runs_disp += place_runner(bases, bumped_to, batter_name)

    return runs_disp


def apply_runner_clause(clause, bases):
    """Mutate `bases` per a single runner clause. Returns (runs_scored,
    outs_added). If the clause doesn't match any known pattern, returns
    (0, 0) and logs a debug line — no-op rather than guess."""
    cl = clause.strip()
    if not cl:
        return 0, 0

    # Failed pickoff -> no state change
    if FAILED_PICKOFF_RE.search(cl):
        return 0, 0

    # Out at base. "X out at second c to 2b, caught stealing" — runner removed, +1 out.
    m = OUT_AT_RE.match(cl)
    if m:
        who = m.group("who")
        last = _norm_last(who)
        b = find_runner(bases, last)
        if b is not None:
            remove_runner(bases, b)
        return 0, 1

    # "X out on the play" (DP / TP companion): runner removed, +1 out.
    m = OUT_ON_PLAY_RE.match(cl)
    if m:
        who = m.group("who")
        last = _norm_last(who)
        b = find_runner(bases, last)
        if b is not None:
            remove_runner(bases, b)
        return 0, 1

    # Picked off (without "advanced" — pure out)
    m = PICKED_OFF_RE.match(cl)
    if m:
        who = m.group("who")
        last = _norm_last(who)
        b = find_runner(bases, last)
        if b is not None:
            remove_runner(bases, b)
        return 0, 1

    # Stole / advanced (including "advanced to home" = scored).
    # Checked BEFORE the scored branch, and STOLE before ADV: a chained
    # clause like "Evan Burg stole second, advanced to third on the
    # throw" must anchor on the FIRST verb ("stole second") so the
    # runner is vacated from his real base — ADV_RE's lazy `who` would
    # otherwise swallow "stole second," and ghost the runner. Same for
    # "Sawyer Nelson stole third, scored on a throwing error": the
    # chain handler removes him from 2B properly, where SCORED_RE
    # would credit the run but leave a ghost on 2B.
    m = STOLE_RE.match(cl) or ADV_RE.match(cl)
    if m:
        who = m.group("who")
        base_word = m.group("base").lower()
        dest = BASE_NUM.get(base_word, 0)
        if dest == 0:
            # Advanced to home = scored
            last = _norm_last(who)
            b = find_runner(bases, last)
            if b is not None:
                remove_runner(bases, b)
            return 1, 0
        runs_extra_disp = vacate_to(bases, dest, who)

        # Chained moves in the SAME clause without a runner name (implicit
        # same runner): "stole second, advanced to third on the throw" /
        # "advanced to third, out at home rf to c" / ", scored".
        # We only honor the LAST chain hit (multiple chains is unusual).
        rest = cl[m.end():]
        runs_extra = 0
        outs_extra = 0
        chain_out = CHAIN_OUT_RE.search(rest)
        if chain_out:
            # Runner kept going and was thrown out — remove + 1 out.
            b = find_runner(bases, _norm_last(who))
            if b is not None:
                remove_runner(bases, b)
            outs_extra = 1
        elif CHAIN_SCORED_RE.search(rest):
            # Runner kept going all the way home
            b = find_runner(bases, _norm_last(who))
            if b is not None:
                remove_runner(bases, b)
            runs_extra = 1
        else:
            chain = CHAIN_ADV_RE.search(rest)
            if chain:
                new_base = BASE_NUM.get(chain.group("base").lower(), dest)
                if new_base == 0:
                    b = find_runner(bases, _norm_last(who))
                    if b is not None:
                        remove_runner(bases, b)
                    runs_extra = 1
                elif new_base > dest:
                    runs_extra += vacate_to(bases, new_base, who)
        return runs_extra + runs_extra_disp, outs_extra

    # Scored
    m = SCORED_RE.match(cl)
    if m:
        who = m.group("who")
        last = _norm_last(who)
        b = find_runner(bases, last)
        if b is not None:
            remove_runner(bases, b)
        # If not on base, we still credit the run (narrative is authoritative).
        return 1, 0

    # Doubled-name artifact ("Francis Subero Francis Subero.") = scored
    m = DUP_NAME_SCORED_RE.match(cl)
    if m:
        who = m.group("who")
        last = _norm_last(who)
        b = find_runner(bases, last)
        if b is not None:
            remove_runner(bases, b)
        return 1, 0

    logger.debug("Unmatched runner clause: %r", cl[:100])
    return 0, 0


# ─────────────────────────────────────────────────────────────────
# Per-game derivation
# ─────────────────────────────────────────────────────────────────
def derive_game(cur, game_id, dry_run=False, force=False):
    """Compute and persist state for one game. Returns dict of audit stats."""

    # Skip if already derived (unless forced)
    if not force:
        cur.execute(
            "SELECT 1 FROM summer_game_events WHERE game_id = %s AND state_derived_at IS NOT NULL LIMIT 1",
            (game_id,),
        )
        if cur.fetchone():
            return {"skipped": True}

    cur.execute(
        """
        SELECT id, inning, half, sequence_idx, batting_team_id,
               batter_player_id, batter_name, result_type, result_text, rbi
        FROM summer_game_events
        WHERE game_id = %s
        ORDER BY inning ASC,
                 CASE WHEN half = 'top' THEN 0 ELSE 1 END,
                 sequence_idx ASC
        """,
        (game_id,),
    )
    events = cur.fetchall()
    if not events:
        return {"events": 0}

    # Roster lookup for runner -> player_id resolution. Summer mirror of
    # spring's game_batting join: summer_game_batting carries (team_id,
    # player_id, player_name) for everyone who batted in this game.
    cur.execute(
        """
        SELECT player_id, team_id, player_name
        FROM summer_game_batting
        WHERE game_id = %s AND player_id IS NOT NULL
        """,
        (game_id,),
    )
    # Map (team_id, last_key) -> player_id; if collision, store None to flag ambiguity
    roster = {}
    for r in cur.fetchall():
        key = (r["team_id"], _norm_last(r["player_name"]))
        if key in roster and roster[key] != r["player_id"]:
            roster[key] = None
        else:
            roster.setdefault(key, r["player_id"])

    def resolve(name, batting_team_id):
        """Map runner name + batting team -> summer player_id (None if unknown)."""
        last = _norm_last(name)
        if not last:
            return None
        return roster.get((batting_team_id, last))

    home_score = 0
    away_score = 0
    cur_half_key = None
    outs = 0
    bases = empty_bases()

    updates = []

    for ev in events:
        half_key = (ev["inning"], ev["half"])
        if half_key != cur_half_key:
            outs = 0
            bases = empty_bases()
            cur_half_key = half_key

        # Capture BEFORE state. Half-inning is canonical: top = away
        # bats, bottom = home bats (the summer scraper also derives
        # batting_team_id from the half, so they always agree — but we
        # key on half for consistency with spring).
        bat_team = ev["batting_team_id"]
        home_batting = (ev["half"] == "bottom")
        if home_batting:
            bat_score_b, fld_score_b = home_score, away_score
        else:
            bat_score_b, fld_score_b = away_score, home_score

        outs_b = min(outs, 2)
        bases_b = bases_str(bases)
        r1b, r2b, r3b = bases[1], bases[2], bases[3]

        runs = 0
        outs_added_total = 0
        clauses = split_clauses(ev["result_text"])

        if ev["result_type"] == "runner_sub":
            # Pinch / courtesy runner. No outs, no runs — just swap
            # the displaced runner's name on whichever base he's on
            # for the new runner's name.
            m = RUNNER_SUB_RE.match(ev["result_text"] or "")
            if m:
                new_name = m.group(1).strip()
                old_name = m.group(2).strip()
                old_last = _norm_last(old_name)
                for base_idx in (1, 2, 3):
                    occupant = bases.get(base_idx)
                    if occupant and _norm_last(occupant) == old_last:
                        bases[base_idx] = new_name
                        break
            # No clauses to process — skip into the post-event bookkeeping.
        elif ev["result_type"] in SUBEVENT_TYPES:
            # Sub-event row — no batter outcome to apply; every clause
            # in the narrative describes a runner movement.
            for clause in clauses:
                r, o = apply_runner_clause(clause, bases)
                runs += r
                outs_added_total += o
        else:
            # PA event — process runner clauses FIRST (they vacate bases
            # explicitly), THEN apply the batter outcome (so its force-
            # chain logic can correctly infer implicit forces from any
            # base still occupied at that point).
            for clause in clauses[1:]:
                r, o = apply_runner_clause(clause, bases)
                runs += r
                outs_added_total += o
            runs += apply_batter_outcome(ev, bases, ev["batter_name"])
            if ev["result_type"] in BATTER_OUT_TYPES:
                outs_added_total += 1

        outs += outs_added_total
        outs_after = min(outs, 3)

        # Score update — same half-based determination as above.
        if home_batting:
            home_score += runs
        else:
            away_score += runs

        bases_a = bases_str(bases)

        # Resolve runner identities to summer player_id
        r1_pid = resolve(r1b, bat_team) if r1b else None
        r2_pid = resolve(r2b, bat_team) if r2b else None
        r3_pid = resolve(r3b, bat_team) if r3b else None

        updates.append(
            (
                outs_b, outs_after, bases_b, bases_a, runs,
                bat_score_b, fld_score_b,
                r1b, r2b, r3b, r1_pid, r2_pid, r3_pid,
                ev["id"],
            )
        )

    # Audit: derived final score vs the authoritative summer_games score
    cur.execute("SELECT home_score, away_score FROM summer_games WHERE id = %s", (game_id,))
    g2 = cur.fetchone() or {}
    actual_home = g2.get("home_score") or 0
    actual_away = g2.get("away_score") or 0
    score_audit_ok = (home_score == actual_home and away_score == actual_away)

    if dry_run:
        return {
            "events": len(events),
            "derived_home": home_score,
            "derived_away": away_score,
            "actual_home": actual_home,
            "actual_away": actual_away,
            "score_audit_ok": score_audit_ok,
        }

    # Bulk update
    psycopg2.extras.execute_batch(
        cur,
        """
        UPDATE summer_game_events SET
            outs_before       = %s,
            outs_after        = %s,
            bases_before      = %s,
            bases_after       = %s,
            runs_on_play      = %s,
            bat_score_before  = %s,
            fld_score_before  = %s,
            r1_name           = %s,
            r2_name           = %s,
            r3_name           = %s,
            r1_player_id      = %s,
            r2_player_id      = %s,
            r3_player_id      = %s,
            state_derived_at  = now()
        WHERE id = %s
        """,
        updates,
        page_size=200,
    )

    return {
        "events": len(events),
        "derived_home": home_score,
        "derived_away": away_score,
        "actual_home": actual_home,
        "actual_away": actual_away,
        "score_audit_ok": score_audit_ok,
    }


# ─────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Derive base/out/score state for summer_game_events.")
    parser.add_argument("--game-id", type=int, help="Single summer_games.id (smoke test).")
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--force", action="store_true", help="Re-derive games already derived.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, help="Cap number of games processed.")
    args = parser.parse_args()

    conn = get_conn()
    cur = conn.cursor()

    if not args.dry_run:
        ensure_schema(cur)
        conn.commit()
    else:
        # Dry-run reads bases_before-free SQL only; still make sure the
        # columns exist so the skip-check below doesn't error on a fresh DB.
        cur.execute(
            """SELECT 1 FROM information_schema.columns
               WHERE table_name = 'summer_game_events' AND column_name = 'state_derived_at'"""
        )
        if not cur.fetchone():
            ensure_schema(cur)
            conn.commit()

    if args.game_id:
        game_ids = [args.game_id]
    else:
        where = ["g.season = %s"]
        params = [args.season]
        if not args.force:
            where.append(
                "EXISTS (SELECT 1 FROM summer_game_events e WHERE e.game_id = g.id "
                "AND e.state_derived_at IS NULL)"
            )
        else:
            where.append("EXISTS (SELECT 1 FROM summer_game_events e WHERE e.game_id = g.id)")
        sql = (
            f"SELECT g.id FROM summer_games g WHERE {' AND '.join(where)} "
            "ORDER BY g.game_date, g.id"
        )
        if args.limit:
            sql += f" LIMIT {int(args.limit)}"
        cur.execute(sql, params)
        game_ids = [r["id"] for r in cur.fetchall()]

    logger.info("Processing %d summer game(s)", len(game_ids))

    audit_ok = 0
    audit_bad = 0
    skipped = 0
    total_events = 0
    bad_examples = []

    for i, gid in enumerate(game_ids, 1):
        try:
            result = derive_game(cur, gid, dry_run=args.dry_run, force=args.force)
        except Exception as e:
            logger.exception("game %d failed: %s", gid, e)
            conn.rollback()
            continue

        if result.get("skipped"):
            skipped += 1
            continue

        total_events += result.get("events", 0)
        if result.get("score_audit_ok"):
            audit_ok += 1
        else:
            audit_bad += 1
            if len(bad_examples) < 10:
                bad_examples.append(
                    f"  game {gid}: derived={result['derived_away']}-{result['derived_home']} "
                    f"actual={result['actual_away']}-{result['actual_home']} (away-home)"
                )

        if not args.dry_run:
            conn.commit()

        if i % 50 == 0:
            logger.info("  progress: %d / %d games", i, len(game_ids))

    derived = audit_ok + audit_bad
    pct = 100.0 * audit_ok / derived if derived else 0.0
    logger.info("DONE: games=%d events=%d audit_ok=%d audit_bad=%d (%.1f%% exact) skipped=%d",
                len(game_ids), total_events, audit_ok, audit_bad, pct, skipped)
    if bad_examples:
        logger.info("Score-mismatch sample (first 10):\n%s", "\n".join(bad_examples))

    conn.close()


if __name__ == "__main__":
    main()
