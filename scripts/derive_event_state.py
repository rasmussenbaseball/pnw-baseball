#!/usr/bin/env python3
"""
Derive base/out/score state for every PA in game_events.

Reads existing game_events rows for a game, walks them in (inning ASC,
top-before-bottom, sequence_idx ASC) order, and computes:

    outs_before, outs_after
    bases_before, bases_after          (3-char string '000'..'111'; idx 0 = 1B)
    runs_on_play
    bat_score_before, fld_score_before
    r1_name / r2_name / r3_name        runner identity on each base
    r1_player_id / r2_player_id / r3_player_id   resolved when in roster

State machine:
  - Reset outs=0, bases=empty at the start of every (inning, half).
  - Capture before-state.
  - Apply the batter outcome (single -> 1B, double -> 2B, walk -> 1B, etc.).
  - Walk the ;-separated runner clauses, applying each:
        "X scored", "X advanced to N", "X out at N", "caught stealing",
        "picked off", "out on the play" (DP/TP companion), wild pitch /
        passed ball / balk / error mods.
  - Capture after-state, score deltas.

Usage:
    # Single game (smoke test)
    python3 scripts/derive_event_state.py --game-id 3639

    # Backfill all undrived games
    python3 scripts/derive_event_state.py --season 2026

    # Re-derive everything (after parser fix)
    python3 scripts/derive_event_state.py --season 2026 --force

    # Dry-run: print state for a single game without writing
    python3 scripts/derive_event_state.py --game-id 3639 --dry-run
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


# ─────────────────────────────────────────────────────────────────
# Name normalization
# ─────────────────────────────────────────────────────────────────
# Narratives mix forms ("M. Aikawa", "Aikawa", "Michael Aikawa"). We
# normalize to a lowercase last-name token for cross-reference within a
# game. If two batters share a last name we still distinguish via initial.

_PUNCT_RE = re.compile(r"[.,;:!?]")


def _norm_last(name):
    """Lowercase last-name-ish key for runner matching.

    Handles both narrative formats Sidearm scorers use:
      - "FirstName LastName"   (most schools)            -> last word
      - "LastName,FirstName"   (Gonzaga, WSU, some D1)   -> pre-comma chunk
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


def _norm_runner_token(text):
    """Take a clause like 'M. Aikawa scored' and return ('aikawa', 'M. Aikawa')."""
    text = text.strip()
    # Strip trailing decorations after the verb start
    return _norm_last(text), text


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

# Reached-on-error: parses where the BATTER ended up
REACHED_BASE_RE    = re.compile(r"reached\s+(first|second|third)\b", re.IGNORECASE)


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

# Pattern matches the same narratives parse_pbp_events.PINCH_RUNNER_RE
# matches. Group 1 = new runner; group 2 = displaced runner.
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
    known limitation when the scorer omits a runner movement, but
    inferring an automatic "displaced runner scored" creates more false
    positives than it fixes (e.g. ordering: batter takes 1B before
    runner-clauses move the existing R1 to 2B). Reconciliation against
    the line score is the right way to recover scorer-omitted runs;
    that's a future Phase A++ pass."""
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
    # "X advanced" narrative (common pattern: "Glenn walked." with bases
    # loaded → R3 scored implicitly).  We run this BEFORE placing the
    # batter so we don't clobber.  Only fires when 1B is still occupied
    # AT THIS POINT — runner-clauses have already run by the time we
    # get here (derive_game reordered the calls), so any runner that
    # was explicitly moved is already gone from 1B.
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

    # Stole / advanced (including "advanced to home" = scored)
    m = ADV_RE.match(cl) or STOLE_RE.match(cl)
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

        # Chained-advance check: same clause has another advance/score
        # without a runner name. "stole second, advanced to third on the
        # throw" / "advanced to second on a wild pitch, advanced to third".
        # We only honor the LAST chain hit (multiple chains is unusual).
        rest = cl[m.end():]
        runs_extra = 0
        if CHAIN_SCORED_RE.search(rest):
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
        return runs_extra + runs_extra_disp, 0

    # Catcher's interference / "reached on error" already handled at batter
    # level. We could parse other rare clauses here in future iterations.
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
            "SELECT 1 FROM game_events WHERE game_id = %s AND state_derived_at IS NOT NULL LIMIT 1",
            (game_id,),
        )
        if cur.fetchone():
            return {"skipped": True}

    cur.execute(
        """
        SELECT id, inning, half, sequence_idx, batting_team_id,
               batter_player_id, batter_name, result_type, result_text, rbi
        FROM game_events
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

    # Roster lookup for runner -> player_id resolution
    cur.execute(
        """
        SELECT player_id, team_id, player_name
        FROM game_batting
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
        """Map runner name + batting team -> player_id (None if unknown)."""
        last = _norm_last(name)
        if not last:
            return None
        return roster.get((batting_team_id, last))

    # State accumulators
    home_team_id = None
    away_team_id = None
    cur.execute("SELECT home_team_id, away_team_id FROM games WHERE id = %s", (game_id,))
    g = cur.fetchone()
    if g:
        home_team_id = g["home_team_id"]
        away_team_id = g["away_team_id"]

    home_score = 0
    away_score = 0
    cur_half_key = None
    outs = 0
    bases = empty_bases()

    updates = []
    audit_unmatched = 0

    for ev in events:
        half_key = (ev["inning"], ev["half"])
        if half_key != cur_half_key:
            outs = 0
            bases = empty_bases()
            cur_half_key = half_key

        # Capture BEFORE state
        # Determine "is the home team batting?" from `half`, NOT from
        # ev.batting_team_id. The scraper occasionally flips team_ids
        # on an event (project_home_away_flip_bug.md). Half-inning is
        # canonical: top = away bats, bottom = home bats. This makes
        # bat_score / fld_score / score_diff robust to the flip bug
        # AND keeps home_score / away_score accumulators correct so a
        # single bad event no longer corrupts every event after it.
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
            # for the new runner's name. The next event's bases_before
            # will then reflect the correct identity.
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
        # If the team_id is wrong on this event, the half tells us who
        # actually batted, so the runs land in the right accumulator.
        if home_batting:
            home_score += runs
        else:
            away_score += runs

        bases_a = bases_str(bases)

        # Resolve runner identities to player_id
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

    # Audit: total runs_on_play should equal final score
    derived_total = home_score + away_score
    cur.execute("SELECT home_score, away_score FROM games WHERE id = %s", (game_id,))
    g2 = cur.fetchone() or {}
    actual_total = (g2.get("home_score") or 0) + (g2.get("away_score") or 0)
    score_audit_ok = (derived_total == actual_total)

    if dry_run:
        return {
            "events": len(events),
            "derived_runs": derived_total,
            "actual_runs": actual_total,
            "score_audit_ok": score_audit_ok,
            "updates": updates[:5],  # sample
        }

    # Bulk update
    psycopg2.extras.execute_batch(
        cur,
        """
        UPDATE game_events SET
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
        "derived_runs": derived_total,
        "actual_runs": actual_total,
        "score_audit_ok": score_audit_ok,
    }


# ─────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Derive base/out/score state for game_events.")
    parser.add_argument("--game-id", type=int, help="Single game (smoke test).")
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--force", action="store_true", help="Re-derive games already derived.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, help="Cap number of games processed.")
    args = parser.parse_args()

    conn = get_conn()
    cur = conn.cursor()

    if args.game_id:
        game_ids = [args.game_id]
    else:
        where = ["g.season = %s"]
        params = [args.season]
        if not args.force:
            where.append(
                "EXISTS (SELECT 1 FROM game_events e WHERE e.game_id = g.id "
                "AND e.state_derived_at IS NULL)"
            )
        else:
            where.append("EXISTS (SELECT 1 FROM game_events e WHERE e.game_id = g.id)")
        sql = (
            f"SELECT g.id FROM games g WHERE {' AND '.join(where)} "
            "ORDER BY g.game_date, g.id"
        )
        if args.limit:
            sql += f" LIMIT {int(args.limit)}"
        cur.execute(sql, params)
        game_ids = [r["id"] for r in cur.fetchall()]

    logger.info("Processing %d game(s)", len(game_ids))

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
                    f"  game {gid}: derived={result['derived_runs']} actual={result['actual_runs']}"
                )

        if not args.dry_run:
            conn.commit()

        if i % 50 == 0:
            logger.info("  progress: %d / %d games", i, len(game_ids))

    logger.info("DONE: games=%d events=%d audit_ok=%d audit_bad=%d skipped=%d",
                len(game_ids), total_events, audit_ok, audit_bad, skipped)
    if bad_examples:
        logger.info("Score-mismatch sample (first 10):\n%s", "\n".join(bad_examples))

    conn.close()


if __name__ == "__main__":
    main()
