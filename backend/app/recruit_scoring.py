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
  * Unranked: no list ranks him, so his public PBR profile measurables do
    (fastball max, secondary velo, spin, exit velo, bat and hand speed,
    position velo, pop time, 60 time). A ridge regression fitted on the
    RANKED recruits (separately for pitchers and hitters) learns how those
    measurables map to the rank-based score. Each unranked player then sits
    in his state's unranked band (below the last ranked player in that state,
    down to 5), placed by where his predicted score falls among all unranked
    players of the class. Where PBR has no current list (HI, MT, BC, AB ...)
    the predicted score is used directly, clipped to 6-40. No measurables
    either: the 30th percentile of his band, or the generic 12.
    Every recruit gets a score, so every commit counts in its class average.

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


# ── measurables model (unranked players) ──────────────────────────────────
_PITCH_FEATS = ("fb_max", "sec_velo", "fb_spin")
_HIT_FEATS = ("exit_velo", "bat_speed", "hand_speed", "pos_velo", "sixty", "pop")
_LOWER_BETTER = {"sixty", "pop"}
_POS_VELO_ADJ = {"c_velo": 6.0, "inf_velo": 0.0, "of_velo": -3.0}   # put C / IF / OF arms on one scale
UNRANKED_LO = 5.0


def _features(m: dict | None, position: str | None):
    """(role, {feature: value}) from stored measurables; role is 'P' or 'H'."""
    m = m or {}
    if isinstance(m, str):
        try:
            m = json.loads(m)
        except ValueError:
            m = {}
    pos = (position or "").upper()
    is_p = ("HP" in pos or pos in ("P", "RHP", "LHP")) or (m.get("fb_max") and not m.get("exit_velo"))
    if is_p:
        sec = max([m[k] for k in ("cb", "sl", "ch", "spl", "ct") if m.get(k)] or [None]) if any(m.get(k) for k in ("cb", "sl", "ch", "spl", "ct")) else None
        f = {"fb_max": m.get("fb_max"), "sec_velo": sec, "fb_spin": m.get("fb_spin")}
        return "P", f
    pv = None
    for k, adj in _POS_VELO_ADJ.items():
        if m.get(k):
            pv = max(pv or 0.0, m[k] + adj)
    f = {"exit_velo": m.get("exit_velo"), "bat_speed": m.get("bat_speed"), "hand_speed": m.get("hand_speed"),
         "pos_velo": pv, "sixty": m.get("sixty"), "pop": m.get("pop")}
    return "H", f


class MeasurablesModel:
    """Ridge regression of logit(score) on standardized measurables (missing
    values filled with the feature mean plus a missing flag), one model for
    pitchers and one for hitters, fitted on ranked recruits."""

    def __init__(self):
        self.models = {}

    @staticmethod
    def _logit(score):
        p = min(0.99, max(0.01, score / 100.0))
        return math.log(p / (1 - p))

    def fit(self, rows):
        import numpy as np
        for role, feats in (("P", _PITCH_FEATS), ("H", _HIT_FEATS)):
            data = []
            for r in rows:
                rl, f = _features(r.get("measurables"), r.get("position"))
                if rl == role and any(v is not None for v in f.values()):
                    data.append((f, self._logit(float(r["score"]))))
            if len(data) < 25:
                continue
            stats = {}
            for k in feats:
                vals = [f[k] for f, _ in data if f.get(k) is not None]
                if len(vals) >= 8:
                    mu = sum(vals) / len(vals)
                    sd = (sum((v - mu) ** 2 for v in vals) / len(vals)) ** 0.5 or 1.0
                    stats[k] = (mu, sd)
            keys = list(stats)
            X = np.array([self._row(f, keys, stats) for f, _ in data])
            y = np.array([t for _, t in data])
            lam = 3.0
            reg = lam * np.eye(X.shape[1]); reg[0, 0] = 0.0
            beta = np.linalg.solve(X.T @ X + reg, X.T @ y)
            pred = X @ beta
            ss = float(((y - pred) ** 2).sum()); st = float(((y - y.mean()) ** 2).sum()) or 1.0
            self.models[role] = {"keys": keys, "stats": stats, "beta": beta.tolist(),
                                 "n": len(data), "r2": round(1 - ss / st, 3)}
        return self

    @staticmethod
    def _row(f, keys, stats):
        row = [1.0]
        for k in keys:
            mu, sd = stats[k]
            v = f.get(k)
            if v is None:
                row += [0.0, 1.0]
            else:
                z = (v - mu) / sd
                row += [-z if k in _LOWER_BETTER else z, 0.0]
        return row

    def predict(self, measurables, position):
        role, f = _features(measurables, position)
        mdl = self.models.get(role)
        if not mdl or not any(v is not None for v in f.values()):
            return None
        row = self._row(f, mdl["keys"], mdl["stats"])
        # the fit used 2 columns per key; beta lines up with row
        t = sum(b * x for b, x in zip(mdl["beta"], row))
        return round(100.0 / (1.0 + math.exp(-t)), 1)


def unranked_band(state, grad_year):
    """(hi, has_list): the top of a state's unranked band = just below the
    last ranked player of that state's PBR list."""
    label = list_for_state(state)
    c = _curve(label, grad_year)
    if c is None:
        return None, False
    n = (c.get("n") or {}).get(str(grad_year)) if grad_year else None
    if not n:
        n = max((c.get("n") or {}).values() or [0])
    if not n:
        return None, False
    return round(0.95 * score_from_national(c["b"] + c["a"] * (n + 1)), 1), True


def _is_ranked(r):
    return any(r.get(k) for k in ("pbr_national_rank", "pbr_state_rank", "bbnw_state_rank"))


def score_row(r: dict) -> float:
    """recruit_score() from a recruits-table row (dict)."""
    return recruit_score(
        state=r.get("state"), grad_year=r.get("grad_year"),
        pbr_national_rank=r.get("pbr_national_rank"),
        pbr_state_rank=r.get("pbr_state_rank"), pbr_rank_list=r.get("pbr_rank_list"),
        bbnw_state_rank=r.get("bbnw_state_rank"), bbnw_rank_state=r.get("bbnw_rank_state"))


SCHEMA_SQL = (
    "ALTER TABLE recruits ADD COLUMN IF NOT EXISTS pbr_profile_url text",
    "ALTER TABLE recruits ADD COLUMN IF NOT EXISTS measurables jsonb",
    "ALTER TABLE recruits ADD COLUMN IF NOT EXISTS measurables_at timestamptz",
    "ALTER TABLE recruits ADD COLUMN IF NOT EXISTS pbr_national_rank int",
    "ALTER TABLE recruits ADD COLUMN IF NOT EXISTS pbr_rank_list text",
    "ALTER TABLE recruits ADD COLUMN IF NOT EXISTS bbnw_rank_state text",
)


def ensure_columns(cur):
    for stmt in SCHEMA_SQL:
        cur.execute(stmt)


def rescore_class(cur, grad_year: int) -> int:
    """Recompute recruit_score for every recruit in a class from the stored
    rank columns and measurables. Safe to run any time; returns rows updated."""
    ensure_columns(cur)
    cols = """id, state, grad_year, position, pbr_national_rank, pbr_state_rank, pbr_rank_list,
              bbnw_state_rank, bbnw_rank_state, measurables"""
    # Train on every ranked recruit with measurables (all classes on file).
    cur.execute(f"SELECT {cols} FROM recruits WHERE measurables IS NOT NULL")
    train = []
    for r in cur.fetchall():
        r = dict(r)
        if _is_ranked(r):
            r["score"] = score_row(r)
            train.append(r)
    model = MeasurablesModel().fit(train)

    cur.execute(f"SELECT {cols} FROM recruits WHERE grad_year = %s", (grad_year,))
    rows = [dict(r) for r in cur.fetchall()]
    scores = {}
    unranked = []
    for r in rows:
        if _is_ranked(r):
            scores[r["id"]] = score_row(r)
        else:
            r["pred"] = model.predict(r.get("measurables"), r.get("position"))
            unranked.append(r)
    # Percentile of each unranked player's predicted score among the class's
    # unranked players with measurables (ties share the middle rank).
    preds = sorted(x["pred"] for x in unranked if x["pred"] is not None)
    def pct(v):
        if not preds:
            return 0.3
        below = sum(1 for p in preds if p < v); eq = sum(1 for p in preds if p == v)
        return (below + 0.5 * eq) / len(preds)
    for r in unranked:
        hi, has_list = unranked_band(r.get("state"), grad_year)
        if has_list:
            q = pct(r["pred"]) if r["pred"] is not None else 0.3
            scores[r["id"]] = round(UNRANKED_LO + (hi - UNRANKED_LO) * q, 1)
        elif r["pred"] is not None:
            scores[r["id"]] = round(min(40.0, max(6.0, r["pred"])), 1)
        else:
            scores[r["id"]] = UNRANKED_GENERIC
    for rid, sc in scores.items():
        cur.execute("UPDATE recruits SET recruit_score = %s WHERE id = %s", (sc, rid))
    rescore_class.last_model = {k: {kk: v[kk] for kk in ("n", "r2", "keys")} for k, v in model.models.items()}
    return len(rows)
