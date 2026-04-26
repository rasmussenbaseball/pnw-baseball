"""
Leverage Index (LI) — parametric MVP (Phase D).

LI measures how impactful a single PA is on the eventual game outcome.
Definition (Tom Tango): the average possible win-probability swing from
this state, normalized so the league mean = 1.0. A "1.0 LI" PA is an
average-importance moment; 2.0+ is high leverage (closer in 1-run game,
RISP late); below 0.5 is mop-up duty.

This implementation is a PARAMETRIC approximation tuned to baseline
baseball intuition — innings, score margin, and base/out state.
Magnitudes are within ~30% of true Tango LI.

──────────────────────────────────────────────────────────────────────
HISTORY: Phase D.5 attempted to replace this with an empirical LI
lookup (avg|WPA| in state / overall avg|WPA|) built from per-event
WPA. The lookup table itself works (scripts/build_li_table.py +
li_lookup) but the ratio came out compressed — known closers like
Luke Ivanoff fell from AVG LI 2.58 (parametric) to 1.00 (empirical),
so the user-facing "Closer-tier" classification stopped working.

Root cause: the WP table that WPA is built on (build_wp_table.py)
is over-smoothed — adjacent states like (bot 9 tied bases empty 0
outs) and (bot 9 tied bases loaded 2 outs) end up with WP values
within 0.02 of each other instead of the ~0.30 spread real Tango
data shows. WPA transitions are therefore compressed at every state,
which collapses the |WPA| means that LI averages.

To make empirical LI work end-to-end, we'd need to: (1) rebuild WP
with much lighter smoothing (maybe at the cost of bigger sample-size
artifacts in extreme buckets), (2) accumulate multiple seasons of
PBP data so sparse buckets fill in, or (3) build a hybrid that uses
parametric LI as a Bayesian prior and shrinks toward empirical.

For now (April 2026) the parametric formula stays. The empirical
li_lookup table is preserved on the database for future iteration.
──────────────────────────────────────────────────────────────────────

Use:
    from app.api.leverage import compute_li
    li = compute_li(inning=9, half='bottom', score_diff=0,
                    bases='011', outs=2)
    # → ~5.0 (bottom 9, tied, runners on 2nd+3rd, 2 outs — peak leverage)

Inputs:
    inning      : 1+
    half        : 'top' or 'bottom'
    score_diff  : batting team's lead (negative = trailing)
    bases       : 3-char string '000' (empty) to '111' (loaded);
                  index 0 = 1B, 1 = 2B, 2 = 3B
    outs        : 0 / 1 / 2

Returns:
    LI (float). Returns 1.0 (league average) when state inputs are NULL,
    so the metric degrades gracefully on undrived events.
"""

from __future__ import annotations
from typing import Optional


# ── Inning factor: how much does the inning matter? ──
#   Innings 1-3: low (lots of game left to recover)
#   Innings 4-6: moderate
#   Innings 7-8: high (closing window)
#   Innings 9+:  peak (any swing decides it)
def _innings_mult(inning: int) -> float:
    if inning >= 9:
        return 2.5
    if inning >= 7:
        return 1.7
    if inning >= 4:
        return 1.05
    return 0.75


# ── Score-margin factor: closeness ──
#   Tied / 1-run: highest (any run swings WP a lot)
#   ≤3 run lead/deficit: moderate
#   Blowouts: low
def _close_mult(score_diff: int) -> float:
    margin = abs(score_diff)
    if margin == 0:
        return 1.55
    if margin == 1:
        return 1.40
    if margin <= 3:
        return 1.05
    if margin <= 5:
        return 0.55
    if margin <= 8:
        return 0.25
    return 0.10


# ── Base/out factor: state contribution to leverage ──
#   Bases empty + outs early in inning: low (small WP swing per PA)
#   Loaded + 2 outs: peak (any outcome ends inning or scores 2+)
def _state_mult(bases: str, outs: int) -> float:
    has_3b = len(bases) >= 3 and bases[2] == "1"
    has_2b = len(bases) >= 2 and bases[1] == "1"
    has_1b = len(bases) >= 1 and bases[0] == "1"
    risp = has_2b or has_3b
    loaded = has_1b and has_2b and has_3b

    if loaded:
        # Bases loaded amplifies sharply with outs (with 2 outs, K vs hit
        # is the difference between 0 and 2+ runs).
        return 1.55 + outs * 0.25            # 1.55 / 1.80 / 2.05
    if risp:
        # RISP gets more leveraged with 2 outs (last chance to score).
        return 1.05 + outs * 0.20            # 1.05 / 1.25 / 1.45
    if has_1b:
        # Runner on 1B: moderate, slightly lower with more outs (less
        # likely to convert to a run).
        return 0.95 - outs * 0.10            # 0.95 / 0.85 / 0.75
    # Bases empty: lowest, decreases with outs (less to do)
    return 0.65 - outs * 0.10                # 0.65 / 0.55 / 0.45


def compute_li(
    inning: Optional[int],
    half: Optional[str],
    score_diff: Optional[int],
    bases: Optional[str],
    outs: Optional[int],
    division_group: Optional[str] = None,  # accepted but unused (parametric)
) -> float:
    """Parametric leverage index. NULL inputs → 1.0 (league average).

    The division_group parameter is accepted for forward-compatibility
    with the empirical lookup but currently unused — the parametric
    formula is the same across divisions.
    """
    if inning is None or score_diff is None or bases is None or outs is None:
        return 1.0
    li = (_innings_mult(inning)
          * _close_mult(score_diff)
          * _state_mult(bases, outs))
    # Calibration: the product above naturally averages slightly under
    # 1.0 across realistic states (most PAs are mid-inning, mid-margin,
    # bases empty). Multiply by 1.15 so the typical PA reads ~1.0.
    li *= 1.15
    # Clamp at 10 so a bug in inputs doesn't produce an absurd outlier.
    return max(0.05, min(li, 10.0))
