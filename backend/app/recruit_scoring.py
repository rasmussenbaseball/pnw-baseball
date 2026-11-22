"""Recruit score (0-100) for any high school recruit, from any state.

One national scale (Nov 2026 rebuild). Every rank is turned into a
"national-equivalent rank" and scored with the same curve:

    score = 100 / (1 + nat_rank / SCALE)

  * PBR national top-500 rank, when the player has one: used as is.
  * PBR state-list rank: nat_rank = b + a * state_rank, with a and b fitted per
    list from where that state's ranked players land in PBR's national top 500
    (backend/data/recruit_state_curves.json). Deep states (CA, TX, FL) have a
    small slope, so a CA #60 is still roughly a national #470; thin states
    (UT, ON, OR) a steep one.
  * Baseball Northwest rank in WA / OR: mapped through the same WA / OR curve
    and averaged with the PBR rank (geometric mean of the two national ranks).
  * Baseball Northwest rank where PBR has no current list (ID, MT, BC, AB, WY):
    the hand-calibrated June 2026 curve (state quality x depth), unchanged.
  * Unranked: a player below a PBR state list of N players sits just under the
    list: 0.8 x the score of rank N+1, kept between 10 and 20. A player from a
    place with no current list at all gets the generic 12. Every recruit now
    gets a score, so every commit counts in its class average.

Raw PBR ranks are paid content: they live only in the recruits table and are
never returned by the API. Only this derived score is public.
"""
from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

SCALE = 3200.0                 # national rank where the score is 50
UNRANKED_GENERIC = 12.0
UNRANKED_FLOOR, UNRANKED_CAP = 10.0, 20.0
_CURVES_PATH = Path(__file__).resolve().parent.parent / "data" / "recruit_state_curves.json"

# Home state / province -> PBR state-list label
_REGION_LIST = {
    "CT": "New England", "MA": "New England", "ME": "New England",
    "NH": "New England", "RI": "New England", "VT": "New England",
    "ND": "Dakotas", "SD": "Dakotas", "DC": "VA",
}

# June 2026 hand-calibrated curve, kept for Baseball Northwest ranks in places
# PBR has no current list (Idaho, Montana, BC, Alberta, Wyoming ...).
_LEGACY_DECAY = 0.018
_LEGACY_QUALITY = {"WA": 1.00, "OR": 0.97, "ID": 0.78, "MT": 0.60, "BC": 0.90, "AB": 0.88, "WY": 0.60}
_LEGACY_DEPTH = {"WA": 1.0, "OR": 1.0, "ID": 0.35, "MT": 0.40, "BC": 2.0, "AB": 1.8, "WY": 0.40}


@lru_cache(maxsize=1)
def curves() -> dict:
    try:
        return json.loads(_CURVES_PATH.read_text()).get("curves", {})
    except (OSError, ValueError):
        return {}


def list_for_state(state: str | None) -> str | None:
    st = (state or "").strip().upper()
    if not st:
        return None
    return _REGION_LIST.get(st, st)


def _curve(label: str | None, grad_year: int | None = None):
    """The fitted curve for a PBR list, or None when PBR has no usable list
    (never existed, or stale: zero players of this class on it)."""
    if not label:
        return None
    c = curves().get(label)
    if not c:
        return None
    if grad_year is not None:
        n = (c.get("n") or {}).get(str(grad_year))
        if n is not None and n <= 0:
            return None
    return c


def score_from_national(nat_rank: float) -> float:
    return round(100.0 / (1.0 + max(float(nat_rank), 1.0) / SCALE), 1)


def national_from_state(label: str, state_rank: int, grad_year: int | None = None):
    c = _curve(label, grad_year)
    if c is None or not state_rank:
        return None
    return max(1.0, c["b"] + c["a"] * float(state_rank))


def _legacy_bbnw_score(rank: int, state: str) -> float:
    q = _LEGACY_QUALITY.get(state, 0.82)
    d = _LEGACY_DEPTH.get(state, 1.1)
    eff = 1.0 + (rank - 1) / d
    return round(min(100.0, 100.0 / (1.0 + _LEGACY_DECAY * (eff - 1.0)) * q), 1)


def unranked_score(state: str | None, grad_year: int | None) -> float:
    label = list_for_state(state)
    c = _curve(label, grad_year)
    if c is None:
        return UNRANKED_GENERIC
    n = (c.get("n") or {}).get(str(grad_year)) if grad_year else None
    if not n:
        n = max((c.get("n") or {}).values() or [0])
    if not n:
        return UNRANKED_GENERIC
    bottom = score_from_national(c["b"] + c["a"] * (n + 1))
    return round(min(UNRANKED_CAP, max(UNRANKED_FLOOR, 0.8 * bottom)), 1)


def recruit_score(*, state=None, grad_year=None, pbr_national_rank=None,
                  pbr_state_rank=None, pbr_rank_list=None,
                  bbnw_state_rank=None, bbnw_rank_state=None) -> float:
    """Score one recruit. Every argument may be None; the result never is."""
    if pbr_national_rank:
        return score_from_national(pbr_national_rank)
    nats = []
    if pbr_state_rank:
        n = national_from_state(pbr_rank_list or list_for_state(state), pbr_state_rank, grad_year)
        if n is not None:
            nats.append(n)
    legacy = None
    if bbnw_state_rank:
        bst = (bbnw_rank_state or state or "").strip().upper()
        n = national_from_state(list_for_state(bst), bbnw_state_rank, grad_year)
        if n is not None:
            nats.append(n)
        else:
            legacy = _legacy_bbnw_score(int(bbnw_state_rank), bst)
    if nats:
        nat = math.exp(sum(math.log(x) for x in nats) / len(nats))
        s = score_from_national(nat)
        return max(s, legacy) if legacy is not None else s
    if legacy is not None:
        return legacy
    return unranked_score(state, grad_year)


def score_row(r: dict) -> float:
    """recruit_score() from a recruits-table row (dict)."""
    return recruit_score(
        state=r.get("state"), grad_year=r.get("grad_year"),
        pbr_national_rank=r.get("pbr_national_rank"),
        pbr_state_rank=r.get("pbr_state_rank"), pbr_rank_list=r.get("pbr_rank_list"),
        bbnw_state_rank=r.get("bbnw_state_rank"), bbnw_rank_state=r.get("bbnw_rank_state"))


SCHEMA_SQL = (
    "ALTER TABLE recruits ADD COLUMN IF NOT EXISTS pbr_national_rank int",
    "ALTER TABLE recruits ADD COLUMN IF NOT EXISTS pbr_rank_list text",
    "ALTER TABLE recruits ADD COLUMN IF NOT EXISTS bbnw_rank_state text",
)


def ensure_columns(cur):
    for stmt in SCHEMA_SQL:
        cur.execute(stmt)


def rescore_class(cur, grad_year: int) -> int:
    """Recompute recruit_score for every recruit in a class from the stored
    rank columns. Safe to run any time; returns rows updated."""
    ensure_columns(cur)
    cur.execute("""SELECT id, state, grad_year, pbr_national_rank, pbr_state_rank, pbr_rank_list,
                          bbnw_state_rank, bbnw_rank_state
                   FROM recruits WHERE grad_year = %s""", (grad_year,))
    rows = cur.fetchall()
    for r in rows:
        cur.execute("UPDATE recruits SET recruit_score = %s WHERE id = %s", (score_row(dict(r)), r["id"]))
    return len(rows)
