#!/usr/bin/env python3
"""
Ingest a PBR state ranking list (copy-pasted from the paid PBR site) and
attach PBR state ranks to the recruits we already track.

PBR's full state rankings are paywalled, so we can't scrape them. But Nate
has a ProspectPlus account and can copy-paste a state's ranking list; this
script parses that paste, matches each player to a recruit committed to one
of our schools, sets `pbr_state_rank`, and recomputes `recruit_score` with
the existing cross-state weighting (scrape_recruits.STATE_FACTOR /
compute_score). Players in the paste who didn't commit to one of our
schools are simply ignored — we only rank our commits.

Paste format: paste the ranking table rows into a text file, one player per
line. The parser is forgiving — it needs a leading rank number and the
player name; it auto-detects the 2-letter state code to delimit the name.
Example lines (any of these work):
    1   Eli Herst   WA   Seattle Academy   2026   RHP   Vanderbilt
    2 Bryce Collins WA Kelso HS 2026 RHP Mississippi
    3,Anthony Karis,WA,...

Usage:
    PYTHONPATH=backend python3 scripts/ingest_pbr_rankings.py \
        --state WA --grad-year 2026 --file /tmp/wa_2026_pbr.txt [--dry-run]
"""

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scrape_recruits import compute_score, norm_name  # noqa: E402

from app.models.database import get_connection  # noqa: E402

_STATE_RE = re.compile(r"^[A-Z]{2}$")


def parse_paste(text):
    """Yield (rank, normalized_name) from forgiving pasted ranking rows."""
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        # CSV-ish first
        parts = [p.strip() for p in re.split(r"[\t,]|\s{2,}", line) if p.strip()]
        if len(parts) < 2:
            parts = line.split()
        if not parts:
            continue
        m = re.match(r"#?(\d+)", parts[0])
        if not m:
            continue
        rank = int(m.group(1))
        # Name = tokens after the rank, up to the 2-letter state code.
        rest = parts[1:] if not re.fullmatch(r"#?\d+", parts[0]) else parts[1:]
        # Re-tokenize the remainder by spaces so multi-word cells split cleanly.
        toks = " ".join(rest).split()
        name_toks = []
        for t in toks:
            if _STATE_RE.match(t) and len(name_toks) >= 2:
                break
            name_toks.append(t)
            if len(name_toks) >= 4:  # safety: names rarely exceed 4 tokens
                break
        name = " ".join(name_toks[:3]) if len(name_toks) > 3 else " ".join(name_toks)
        if name:
            out.append((rank, norm_name(name)))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--state", required=True, help="State the ranking is for (WA, UT, CA, ...)")
    ap.add_argument("--grad-year", type=int, default=2026)
    ap.add_argument("--file", required=True, help="Text file of pasted ranking rows")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    state = args.state.strip().upper()

    pairs = parse_paste(Path(args.file).read_text())
    rank_by_name = {}
    for rank, nk in pairs:
        rank_by_name.setdefault(nk, rank)  # keep best (first) rank per name
    print(f"parsed {len(pairs)} rows, {len(rank_by_name)} distinct players from {args.file}")

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT id, first_name, last_name, state, bbnw_state_rank
               FROM recruits WHERE grad_year = %s AND UPPER(state) = %s""",
            (args.grad_year, state),
        )
        recruits = cur.fetchall()
        print(f"{len(recruits)} recruits committed to our schools from {state} {args.grad_year}")

        matched, updated = 0, 0
        unmatched_paste = set(rank_by_name)
        for r in recruits:
            nk = norm_name(f"{r['first_name']} {r['last_name']}")
            pbr_rank = rank_by_name.get(nk)
            if pbr_rank is None:
                continue
            matched += 1
            unmatched_paste.discard(nk)
            new_score = compute_score(r["bbnw_state_rank"], pbr_rank, state)
            if not args.dry_run:
                cur.execute(
                    "UPDATE recruits SET pbr_state_rank = %s, recruit_score = %s, "
                    "sources = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(sources,'{}') || %s))), "
                    "last_seen = now() WHERE id = %s",
                    (pbr_rank, new_score, ["pbr"], r["id"]),
                )
            updated += 1
        if not args.dry_run:
            conn.commit()

        mode = "DRY RUN" if args.dry_run else "APPLIED"
        print(f"[{mode}] matched {matched} recruits, set PBR rank on {updated}")
        if unmatched_paste:
            print(f"  {len(unmatched_paste)} ranked players in the paste are NOT commits to our "
                  f"schools (ignored) — that's expected.")


if __name__ == "__main__":
    main()
