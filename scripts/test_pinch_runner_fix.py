"""
Smoke test for pinch runner state-machine handling.

Picks Game 3695 (PLU @ Whitman, 2026-04-25) which we sampled earlier
and confirmed has a "Braydon Olson pinch ran for Sam Mieszkowski-
Lapping" substitution. Re-scrapes the PBP, re-derives state, then
prints every event around the substitution so we can verify:

  1. A 'runner_sub' event was emitted by the parser.
  2. The state machine swapped the runner identity on the right base.
  3. Subsequent events show the new runner's name in r1/r2/r3_name.

Run on Mac (uses production DB):
    cd ~/Desktop/pnw-baseball
    PYTHONPATH=backend python3 scripts/test_pinch_runner_fix.py
"""

from __future__ import annotations
import sys

from app.models.database import get_connection

# Run scrape_pbp + derive_event_state on the test game
import subprocess

GAME_ID = 3695


def main() -> int:
    print(f"Re-scraping PBP for game {GAME_ID}...")
    r = subprocess.run(
        ["python3", "scripts/scrape_pbp.py",
         "--game-id", str(GAME_ID), "--rescrape"],
        env={**__import__("os").environ, "PYTHONPATH": "backend"},
        capture_output=True, text=True,
    )
    print(r.stdout)
    if r.returncode != 0:
        print("FAILED:")
        print(r.stderr)
        return 1

    print(f"\nRe-deriving state for game {GAME_ID}...")
    r = subprocess.run(
        ["python3", "scripts/derive_event_state.py",
         "--game-id", str(GAME_ID), "--force"],
        env={**__import__("os").environ, "PYTHONPATH": "backend"},
        capture_output=True, text=True,
    )
    print(r.stdout)
    if r.returncode != 0:
        print("FAILED:")
        print(r.stderr)
        return 1

    # Now inspect the events
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT inning, half, sequence_idx,
                   result_type, result_text,
                   bases_before, bases_after, outs_before, outs_after,
                   r1_name, r2_name, r3_name
            FROM game_events
            WHERE game_id = %s
            ORDER BY inning ASC,
                     CASE WHEN half = 'top' THEN 0 ELSE 1 END,
                     sequence_idx ASC
        """, (GAME_ID,))
        events = list(cur.fetchall())

    print(f"\n── {len(events)} events for game {GAME_ID} ──")
    print(f"\nLooking for 'runner_sub' events...")
    sub_events = [e for e in events if e["result_type"] == "runner_sub"]
    print(f"  Found {len(sub_events)} runner_sub events.")
    for e in sub_events:
        idx = events.index(e)
        print(f"\n  ── runner_sub at {e['half']} {e['inning']} ──")
        print(f"     narrative: \"{e['result_text']}\"")
        # Show 2 events before and 3 after for context
        ctx_start = max(0, idx - 2)
        ctx_end = min(len(events), idx + 4)
        print(f"     surrounding events:")
        for i, ce in enumerate(events[ctx_start:ctx_end]):
            real_idx = ctx_start + i
            mark = " >>" if real_idx == idx else "   "
            r1 = ce["r1_name"] or "-"
            r2 = ce["r2_name"] or "-"
            r3 = ce["r3_name"] or "-"
            print(f"     {mark} {ce['half'][:1]}{ce['inning']}.{ce['sequence_idx']:02d} "
                  f"{ce['result_type']:<22} "
                  f"bases {ce['bases_before']}->{ce['bases_after']} "
                  f"r1={r1[:15]:<15} r2={r2[:15]:<15} r3={r3[:15]}")
            snippet = (ce['result_text'] or '')[:80]
            print(f"          \"{snippet}\"")

    return 0


if __name__ == "__main__":
    sys.exit(main())
