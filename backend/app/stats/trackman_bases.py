"""Base-state reconstruction from TrackMan play results.

The V3 export carries no runner fields, so base states are rebuilt per
half-inning from what each plate appearance did: walks and hit batters
force, singles move everyone one base, doubles two, triples and homers
clear, sacrifices and fielder's choices move runners one, errors read like
singles. RunsScored on a pitch removes that many lead runners (so a single
that scored the man from second comes out right), OutsOnPlay beyond the
batter removes the trailing runner (double play), and an out or run on a
pitch that did not end the PA is a caught stealing, pickoff or wild pitch
and is applied to the runners directly. Good enough to split a pitcher's
work into bases empty / runner on first only / runners in scoring position,
which is what the splits table shows; it is not an official log.
"""
from collections import defaultdict

HIT_BASES = {"Single": 1, "Double": 2, "Triple": 3, "HomeRun": 4, "Error": 1}


def _outcome(r):
    if r.get("k_or_bb") == "Strikeout":
        return "K"
    if r.get("k_or_bb") == "Walk":
        return "BB"
    if r.get("pitch_call") == "HitByPitch":
        return "HBP"
    pr = r.get("play_result")
    if pr:
        return pr
    if r.get("pitch_call") == "InPlay":
        return "InPlay"
    return None


def _advance(bases, n):
    """Move every runner n bases; return runners that reached home."""
    scored = 0
    new = set()
    for b in bases:
        if b + n >= 4:
            scored += 1
        else:
            new.add(b + n)
    return new, scored


def _force(bases):
    """Walk / HBP: batter to first, the chain of runners ahead of him moves
    only where forced (1st -> 2nd -> 3rd -> home)."""
    new = set(bases)
    k = 0
    while (k + 1) in new:
        k += 1                      # consecutive occupied bases from first
    for b in range(1, k + 1):
        new.discard(b)
    scored = 0
    for b in range(2, k + 2):
        if b >= 4:
            scored += 1
        else:
            new.add(b)
    new.add(1)
    return new, scored


def state_label(bases):
    if not bases:
        return "empty"
    if bases == {1}:
        return "on1"
    return "risp"


def tag_base_states(rows):
    """Return {pitch id -> 'empty'|'on1'|'risp'} for live rows (needs
    session_id, inning, top_bottom, pa_of_inning, pitch_of_pa, pitch_no,
    pitch_call, k_or_bb, play_result, outs_on_play, runs_scored)."""
    halves = defaultdict(list)
    for r in rows:
        if r.get("inning") is None or r.get("pa_of_inning") is None:
            continue
        halves[(r.get("session_id"), r.get("inning"), r.get("top_bottom"))].append(r)
    out = {}
    for key, rs in halves.items():
        rs.sort(key=lambda r: (r.get("pa_of_inning") or 0, r.get("pitch_of_pa") or 0, r.get("pitch_no") or 0))
        bases = set()
        for r in rs:
            out[r.get("pitch_id") or id(r)] = state_label(bases)
            o = _outcome(r)
            runs = int(r.get("runs_scored") or 0)
            outs = int(r.get("outs_on_play") or 0)
            if o is None:
                # mid-PA event: a run is a steal of home / wild pitch (lead
                # runner), an out is a caught stealing / pickoff (trail runner)
                for _ in range(runs):
                    if bases:
                        bases.remove(max(bases))
                for _ in range(outs):
                    if bases:
                        bases.remove(min(bases))
                continue
            if o in ("BB", "HBP"):
                bases, _ = _force(bases)
            elif o in HIT_BASES:
                n = HIT_BASES[o]
                bases, _ = _advance(bases, n)
                if n < 4:
                    bases.add(n)
            elif o in ("Sacrifice", "FieldersChoice"):
                bases, _ = _advance(bases, 1)
                if o == "FieldersChoice":
                    bases.add(1)
                    if outs and len(bases) > 1:
                        bases.remove(max(bases))      # lead runner forced out
            elif o in ("Out", "InPlay", "K"):
                extra = max(0, outs - 1)                # double play: a runner went too
                for _ in range(extra):
                    if bases:
                        bases.remove(min(bases))
            # reconcile with the scorer: RunsScored is authoritative
            for _ in range(runs):
                if bases:
                    bases.remove(max(bases))
    return out


STATES = [("empty", "Bases empty"), ("on1", "Runner on 1st"), ("risp", "RISP")]
