"""
Player Comparison tool.

Productionizes the V1 prototype built by NWBB Stats interns Trevor Kazahaya and
Connor Broschard. Given a Northwest player, it finds the most statistically
similar comparables either inside the NW database or among recent MLB
player-seasons, using a weighted, percentile-based similarity model, plus an
archetype label and a reliability range.

This is a faithful reproduction of the prototype's algorithm:
  * percentiles are rank-based and computed WITHIN each pool separately, so a NW
    player's rank inside the NW pool is matched to MLB seasons' ranks inside the
    MLB pool (cross-environment matching),
  * per-metric weighted L1 distance over the configured metric set,
  * similarity = clamp(100 - total weighted distance, 0, 100) (weights sum to 1),
  * archetypes + reliability ranges layered on top.

The NW pool is read live from the database so comps stay fresh as stats update.
The MLB pool is a bundled static reference set (recent FanGraphs seasons), parsed
once at import from backend/app/data/.
"""

import bisect
import csv
import math
from functools import lru_cache
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from ..cache import cached_endpoint
from ..models.database import get_connection
from ..config import CURRENT_SEASON

router = APIRouter()

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SEASON_DEFAULT = CURRENT_SEASON

# ── Metric configuration (exact mirror of the recovered prototype config) ──────
# direction "higher" = more is better; "lower" = less is better. Weights sum to 1.
HITTER_METRICS = [
    {"key": "wrcPlus", "label": "wRC+", "weight": 0.30, "format": "int",  "direction": "higher"},
    {"key": "woba",    "label": "wOBA", "weight": 0.25, "format": "avg",  "direction": "higher"},
    {"key": "kPct",    "label": "K%",   "weight": 0.15, "format": "pct",  "direction": "lower"},
    {"key": "bbPct",   "label": "BB%",  "weight": 0.15, "format": "pct",  "direction": "higher"},
    {"key": "iso",     "label": "ISO",  "weight": 0.15, "format": "avg",  "direction": "higher"},
]
PITCHER_METRICS = [
    {"key": "kPct",    "label": "K%",   "weight": 0.20, "format": "pct",  "direction": "higher"},
    {"key": "bbPct",   "label": "BB%",  "weight": 0.15, "format": "pct",  "direction": "lower"},
    {"key": "fip",     "label": "FIP",  "weight": 0.20, "format": "rate", "direction": "lower"},
    {"key": "xfip",    "label": "xFIP", "weight": 0.16, "format": "rate", "direction": "lower"},
    {"key": "eraPlus", "label": "ERA+", "weight": 0.17, "format": "int",  "direction": "higher"},
    {"key": "whip",    "label": "WHIP", "weight": 0.12, "format": "rate", "direction": "lower"},
]
METRICS = {"hitter": HITTER_METRICS, "pitcher": PITCHER_METRICS}
THRESHOLD_KEY = {"hitter": "pa", "pitcher": "ip"}
THRESHOLD_VAL = {"hitter": 75, "pitcher": 15}
THRESHOLD_LABEL = {"hitter": "75+ PA", "pitcher": "15+ IP"}
STRONG_SAMPLE = {"hitter": 150, "pitcher": 40}
SAMPLE_LABEL = {"hitter": "PA", "pitcher": "IP"}

POSITION_ORDER = ["C", "1B", "2B", "SS", "3B", "LF", "CF", "RF", "DH"]
BATS_ORDER = ["R", "L", "S"]


# ── Small numeric helpers ──────────────────────────────────────────────────────
def _clamp(x, lo, hi):
    return max(lo, min(hi, x))


def _round_clamp(x):
    """Round and clamp to 0..100 (the prototype's `ff`)."""
    return int(_clamp(round(x), 0, 100))


def _finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _f(v):
    """Coerce a DB/CSV value to float, or None if not numeric/finite."""
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _ip_to_real(ip):
    """Baseball IP notation (6.2 = 6 2/3) to a real number. Mirrors routes._ip_to_real."""
    if ip is None:
        return 0.0
    try:
        ip = float(ip)
    except (TypeError, ValueError):
        return 0.0
    whole = int(ip)
    frac = round((ip - whole) * 10)
    if frac >= 3:  # already a true decimal, not notation
        return ip
    return whole + frac / 3.0


def _pos_family(pos):
    """Map an exact position to its family (the prototype's `nh`)."""
    if pos == "C":
        return "C"
    if pos in ("1B", "3B"):
        return "Corner IF"
    if pos in ("2B", "SS"):
        return "Middle IF"
    if pos in ("LF", "RF"):
        return "Corner OF"
    if pos == "CF":
        return "CF"
    if pos == "DH":
        return "DH"
    return "N/A"


def _group(row, side, mode):
    """Position/role group for a row under a match mode (the prototype's `Bl`).
    Returns None when no grouping applies (mode 'any')."""
    if mode == "any":
        return None
    if side == "pitcher":
        return row.get("role")
    if mode == "family":
        return _pos_family(row.get("position"))
    return row.get("position")  # exact


# ── Percentiles (rank-based, within a pool) ────────────────────────────────────
def _pct_in_sorted(value, sorted_vals, direction):
    """Percentile of `value` within a pre-sorted ascending list (the prototype's
    `Du`): empty -> 50, single -> 100, else clamp((count-1)/(n-1)*100, 0, 100).

    Uses bisect (O(log n)) instead of a linear scan. This is called for every
    metric of every candidate (thousands x thousands) when ranking comps, so the
    old O(n) scan made compute_comps ~O(candidates x metrics x pool) — ~21s per
    cold comp. bisect on the already-sorted pool gives byte-for-byte identical
    counts in O(log n): for "higher", count of v <= value == bisect_right; for
    "lower", count of v >= value == n - bisect_left."""
    if not _finite(value) or not sorted_vals:
        return 50.0
    n = len(sorted_vals)
    if n == 1:
        return 100.0
    if direction == "lower":
        count = n - bisect.bisect_left(sorted_vals, value)
    else:
        count = bisect.bisect_right(sorted_vals, value)
    return _clamp((count - 1) / (n - 1) * 100.0, 0.0, 100.0)


def _trait_pct(player, pool_rows, key, direction):
    """Rounded percentile of player[key] among a pool's finite values (the
    prototype's `it`), used for archetype trait scoring."""
    val = player.get(key)
    vals = sorted(v for v in (r.get(key) for r in pool_rows) if _finite(v))
    if not _finite(val) or not vals:
        return 50
    if len(vals) == 1:
        return 100
    if direction == "lower":
        count = sum(1 for v in vals if v >= val)
    else:
        count = sum(1 for v in vals if v <= val)
    return _round_clamp((count - 1) / (len(vals) - 1) * 100.0)


def _ordinal(n):
    n = int(round(n))
    if 11 <= n % 100 <= 13:
        return f"{n}th"
    return f"{n}{ {1:'st', 2:'nd', 3:'rd'}.get(n % 10, 'th') }"


def _describe_traits(traits):
    """Top-two traits by score -> 'Label NNth pct., Label NNth pct.' (prototype `pf`)."""
    top = sorted(traits, key=lambda t: -t["score"])[:2]
    return ", ".join(f"{t['label']} {_ordinal(t['score'])} pct." for t in top)


# ── Per-metric breakdown + why-text (prototype `bp`, `th`, `eh`) ───────────────
def _breakdown(selected, candidate, metrics, pools):
    out = []
    for m in metrics:
        k = m["key"]
        sp = _pct_in_sorted(selected.get(k), pools[k]["sel"], m["direction"])
        cp = _pct_in_sorted(candidate.get(k), pools[k]["cand"], m["direction"])
        out.append({
            "key": k,
            "label": m["label"],
            "format": m["format"],
            "selectedValue": selected.get(k),
            "comparedValue": candidate.get(k),
            "selectedPercentile": round(sp, 1),
            "comparedPercentile": round(cp, 1),
            "weightedDifference": abs(sp - cp) * m["weight"],
        })
    out.sort(key=lambda x: x["weightedDifference"])
    return out


def _gap_text(b):
    t = round(b["comparedPercentile"] - b["selectedPercentile"])
    if abs(t) <= 3:
        return "nearly identical percentile"
    return f"{abs(t)} percentile points {'higher' if t > 0 else 'lower'}"


def _why_text(breakdown):
    closest = [b["label"] for b in breakdown[:2]]
    biggest = breakdown[-1] if breakdown else None
    if not biggest or not closest:
        return "Similar overall statistical shape."
    clo = closest[0] if len(closest) == 1 else f"{closest[0]} and {closest[1]}"
    return f"Closest adjusted percentiles: {clo}. Biggest percentile gap: {biggest['label']} ({_gap_text(biggest)})."


# ── Archetypes (prototype `Ch` hitter / `Ph` pitcher) ──────────────────────────
def _archetype_hitter(selected, pool):
    power = _trait_pct(selected, pool, "iso", "higher")
    approach = _trait_pct(selected, pool, "bbPct", "higher")
    contact = _trait_pct(selected, pool, "kPct", "lower")
    production = _round_clamp(
        (_trait_pct(selected, pool, "wrcPlus", "higher") + _trait_pct(selected, pool, "woba", "higher")) / 2
    )
    traits = [
        {"key": "power", "label": "Power", "radarLabel": "Power", "score": power},
        {"key": "approach", "label": "Approach", "radarLabel": "Zone", "score": approach},
        {"key": "contact", "label": "Contact", "radarLabel": "Contact", "score": contact},
        {"key": "production", "label": "Production", "radarLabel": "Prod", "score": production},
    ]
    a = {"title": "Balanced Run Creator",
         "description": "Well-rounded offensive shape without one extreme carrying the profile.",
         "tags": ["Balanced", "Run creation", "Stat shape"]}
    if power >= 75 and approach >= 65 and production >= 70:
        a = {"title": "Middle-Order Power Bat",
             "description": "Run-production profile built around damage, on-base ability, and above-average offensive impact.",
             "tags": ["Damage", "OBP", "Run producer"]}
    elif power >= 75 and contact <= 45:
        a = {"title": "Three-True-Outcome Slugger",
             "description": "Power-forward bat where extra-base damage is the separator, with more swing-and-miss in the profile.",
             "tags": ["Power", "Patience", "Swing-and-miss"]}
    elif approach >= 75 and contact >= 65:
        a = {"title": "Selective On-Base Bat",
             "description": "Controls the zone, avoids empty plate appearances, and creates value through quality at-bats.",
             "tags": ["Zone control", "Contact", "OBP"]}
    elif contact >= 75 and power < 55:
        a = {"title": "Contact-Oriented Table Setter",
             "description": "Low-strikeout profile built around bat-to-ball skill and keeping pressure on the defense.",
             "tags": ["Contact", "Bat control", "Table setter"]}
    elif power >= 65 and contact >= 60:
        a = {"title": "Gap-to-Gap Damage Bat",
             "description": "Balanced offensive profile with enough contact skill to let the extra-base impact play.",
             "tags": ["Gap power", "Contact", "Production"]}
    elif production >= 75:
        a = {"title": "Balanced Run Creator",
             "description": "Strong overall offensive performer whose value comes from the full stat line instead of one carrying tool.",
             "tags": ["Production", "Balance", "Reliability"]}
    a["traits"] = traits
    a["explanation"] = f"Why: {_describe_traits(traits)} among eligible NW hitters."
    return a


def _archetype_pitcher(selected, pool):
    bat_missing = _trait_pct(selected, pool, "kPct", "higher")
    command = _trait_pct(selected, pool, "bbPct", "lower")
    run_prev = _round_clamp(
        (_trait_pct(selected, pool, "eraPlus", "higher")
         + _trait_pct(selected, pool, "fip", "lower")
         + _trait_pct(selected, pool, "xfip", "lower")) / 3
    )
    traffic = _trait_pct(selected, pool, "whip", "lower")
    traits = [
        {"key": "batMissing", "label": "Bat-Missing", "radarLabel": "Whiff", "score": bat_missing},
        {"key": "command", "label": "Command", "radarLabel": "Cmd", "score": command},
        {"key": "runPrevention", "label": "Run Prevention", "radarLabel": "Run", "score": run_prev},
        {"key": "traffic", "label": "Traffic Control", "radarLabel": "WHIP", "score": traffic},
    ]
    a = {"title": "Balanced Pitching Profile",
         "description": "Broad pitching shape without one dominant separator, useful for keeping comps centered on the full line.",
         "tags": ["Balanced", "Role fit", "Stat shape"]}
    if bat_missing >= 75 and command >= 65:
        a = {"title": "Power Command Arm",
             "description": "Misses bats while limiting free passes, the cleanest profile for stable pitcher comparisons.",
             "tags": ["Whiffs", "Command", "Leverage"]}
    elif bat_missing >= 75 and command <= 45:
        a = {"title": "High-Whiff Volatility Arm",
             "description": "Big swing-and-miss ability with some command risk, making role and sample size especially important.",
             "tags": ["Strikeouts", "Walk risk", "Upside"]}
    elif command >= 75 and traffic >= 65:
        a = {"title": "Strike-Throwing Starter",
             "description": "Efficient strike-throwing profile that limits baserunners and keeps outings under control.",
             "tags": ["Efficiency", "WHIP", "Command"]}
    elif run_prev >= 75:
        a = {"title": "Run Prevention Arm",
             "description": "Results and fielding-independent indicators point toward a pitcher who suppresses damage well.",
             "tags": ["ERA+", "FIP", "Damage control"]}
    elif traffic >= 75 and bat_missing < 60:
        a = {"title": "Contact Manager",
             "description": "Keeps runners off base and survives more through contact quality and control than pure strikeouts.",
             "tags": ["WHIP", "Contact", "Efficiency"]}
    a["traits"] = traits
    a["explanation"] = f"Why: {_describe_traits(traits)} among eligible NW pitchers."
    return a


def _archetype(selected, pool, side):
    return _archetype_hitter(selected, pool) if side == "hitter" else _archetype_pitcher(selected, pool)


# ── Reliability range (prototype `ih`) ─────────────────────────────────────────
def _has_handedness(row, side):
    v = row.get("bats" if side == "hitter" else "throws")
    return bool(v and v != "N/A")


def _reliability(selected, candidate, side, score, opts):
    i = selected.get("sample") or 0
    o = candidate.get("sample") or 0
    s = STRONG_SAMPLE[side]
    u = THRESHOLD_VAL[side]
    unit = SAMPLE_LABEL[side]
    dec = 0 if side == "hitter" else 1
    y = _clamp(i / s, 0, 1)
    w = _clamp(o / s, 0, 1)
    v = min(y, w)
    R = 0
    reasons = []
    if i < u or o < u:
        R += 4
        reasons.append(f"Small sample: selected {i:.{dec}f} {unit}, comp {o:.{dec}f} {unit}")
    elif i >= s and o >= s:
        reasons.append(f"Strong samples: both players are at or above {s} {unit}")
    else:
        reasons.append(f"Samples: selected {i:.{dec}f} {unit}, comp {o:.{dec}f} {unit}")

    mode = opts.get("positionMatchMode", "any")
    if mode == "family":
        reasons.append("Position-family context")
    elif mode == "any":
        R += 2
        reasons.append("Any position/role broadens the comp context")
    else:
        reasons.append("Strict position/role context")

    if opts.get("candidatePool") == "mlb":
        R += 2
        reasons.append("MLB comps use cross-environment percentile matching")

    if opts.get("applyHandednessMatch"):
        R -= 1
        reasons.append("Handedness matched where data exists")
    elif not _has_handedness(selected, side) or not _has_handedness(candidate, side):
        R += 1
        reasons.append("Bats/Throws data missing for one or both players")

    if opts.get("includeSmallSamples"):
        R += 1

    margin = int(round(_clamp(4 + (1 - v) * 10 + R, 4, 22)))
    label = "High" if margin <= 9 else ("Medium" if margin <= 15 else "Low")
    return {
        "label": label,
        "margin": margin,
        "lower": _clamp(score - margin, 0, 100),
        "upper": _clamp(score + margin, 0, 100),
        "selectedSample": round(i, dec),
        "comparedSample": round(o, dec),
        "reasons": reasons,
        "primaryReason": reasons[0],
    }


# ── Pool loaders ───────────────────────────────────────────────────────────────
def _nw_hitter_row(r):
    return {
        "id": r["id"],
        "name": r["name"],
        "team": r.get("team"),
        "level": r.get("level"),
        "conference": r.get("conference"),
        "position": r.get("position"),
        "classYear": r.get("year_in_school"),
        "bats": r.get("bats"),
        "throws": r.get("throws"),
        "headshot_url": r.get("headshot_url"),
        "sample": _f(r.get("pa")) or 0.0,
        "pa": _f(r.get("pa")) or 0.0,
        "wrcPlus": _f(r.get("wrc_plus")),
        "woba": _f(r.get("woba")),
        "kPct": _f(r.get("k_pct")),
        "bbPct": _f(r.get("bb_pct")),
        "iso": _f(r.get("iso")),
    }


def _nw_pitcher_row(r):
    ip_true = _ip_to_real(r.get("innings_pitched"))
    g = _f(r.get("games")) or 0
    gs = _f(r.get("games_started")) or 0
    role = "SP" if gs >= 1 and (g == 0 or gs / g >= 0.5) else "RP"
    era_minus = _f(r.get("era_minus"))
    era_plus = (10000.0 / era_minus) if (era_minus and era_minus > 0) else None
    return {
        "id": r["id"],
        "name": r["name"],
        "team": r.get("team"),
        "level": r.get("level"),
        "conference": r.get("conference"),
        "position": "P",
        "role": role,
        "classYear": r.get("year_in_school"),
        "bats": r.get("bats"),
        "throws": r.get("throws"),
        "headshot_url": r.get("headshot_url"),
        "sample": ip_true,
        "ip": ip_true,
        "kPct": _f(r.get("k_pct")),
        "bbPct": _f(r.get("bb_pct")),
        "fip": _f(r.get("fip")),
        "xfip": _f(r.get("xfip")),
        "eraPlus": era_plus,
        "whip": _f(r.get("whip")),
    }


@lru_cache(maxsize=8)
def _load_nw_pool(side, season):
    """All NW player-season rows for the side that have the metric columns. Cached
    per (side, season); the in-memory cache is reset on service restart."""
    with get_connection() as conn:
        cur = conn.cursor()
        if side == "hitter":
            cur.execute(
                """
                SELECT p.id,
                       (p.first_name || ' ' || p.last_name) AS name,
                       t.short_name AS team, d.level AS level, c.name AS conference,
                       p.position, p.year_in_school, p.bats, p.throws, p.headshot_url,
                       b.plate_appearances AS pa, b.wrc_plus, b.woba, b.k_pct, b.bb_pct, b.iso
                FROM batting_stats b
                JOIN players p ON p.id = b.player_id
                JOIN teams t ON t.id = b.team_id
                LEFT JOIN conferences c ON c.id = t.conference_id
                LEFT JOIN divisions d ON d.id = c.division_id
                WHERE b.season = %s AND b.plate_appearances >= 1
                  AND COALESCE(p.is_phantom, FALSE) = FALSE
                """,
                (season,),
            )
            rows = [_nw_hitter_row(r) for r in cur.fetchall()]
        else:
            cur.execute(
                """
                SELECT p.id,
                       (p.first_name || ' ' || p.last_name) AS name,
                       t.short_name AS team, d.level AS level, c.name AS conference,
                       p.year_in_school, p.bats, p.throws, p.headshot_url,
                       ps.innings_pitched, ps.games, ps.games_started,
                       ps.k_pct, ps.bb_pct, ps.fip, ps.xfip, ps.era_minus, ps.whip
                FROM pitching_stats ps
                JOIN players p ON p.id = ps.player_id
                JOIN teams t ON t.id = ps.team_id
                LEFT JOIN conferences c ON c.id = t.conference_id
                LEFT JOIN divisions d ON d.id = c.division_id
                WHERE ps.season = %s AND ps.innings_pitched > 0
                  AND COALESCE(p.is_phantom, FALSE) = FALSE
                """,
                (season,),
            )
            rows = [_nw_pitcher_row(r) for r in cur.fetchall()]
    return rows


def _csv_rows(filename):
    path = DATA_DIR / filename
    with open(path, newline="", encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


def _mlb_team(raw):
    """Normalize the FanGraphs Team field. Traded players get a "- - -" marker
    (the only thing the export carries for a multi-team season), which would
    otherwise render as a bare dash on the comps pages. Show "Multiple Teams"
    instead. Returns None for a genuinely empty value so the UI can fall back."""
    t = (raw or "").strip()
    if not t:
        return None
    if set(t) <= {"-", " "}:  # "- - -", "---", "--", etc.
        return "Multiple Teams"
    return t


@lru_cache(maxsize=2)
def _load_mlb_pool(side):
    """Recent MLB player-seasons from the bundled reference CSVs. Cached."""
    out = []
    if side == "hitter":
        for i, r in enumerate(_csv_rows("mlb_hitting_recent.csv")):
            out.append({
                "id": f"mlb-h-{r.get('PlayerId','')}-{r.get('Season','')}-{i}",
                "name": r.get("Name") or r.get("NameASCII"),
                "team": _mlb_team(r.get("Team")),
                "season": int(r["Season"]) if (r.get("Season") or "").strip().isdigit() else None,
                "level": "MLB",
                "position": (r.get("Pos") or "").strip(),
                "bats": (r.get("Bats") or "").strip() or None,
                "throws": (r.get("Throws") or "").strip() or None,
                "sample": _f(r.get("PA")) or 0.0,
                "pa": _f(r.get("PA")) or 0.0,
                "wrcPlus": _f(r.get("wRC+")),
                "woba": _f(r.get("wOBA")),
                "kPct": _f(r.get("K%")),
                "bbPct": _f(r.get("BB%")),
                "iso": _f(r.get("ISO")),
            })
    else:
        for i, r in enumerate(_csv_rows("mlb_pitching_recent.csv")):
            ip = _f(r.get("IP")) or 0.0
            out.append({
                "id": f"mlb-p-{r.get('PlayerId','')}-{r.get('Season','')}-{i}",
                "name": r.get("Name") or r.get("NameASCII"),
                "team": _mlb_team(r.get("Team")),
                "season": int(r["Season"]) if (r.get("Season") or "").strip().isdigit() else None,
                "level": "MLB",
                "position": (r.get("Pos") or "").strip(),
                "role": (r.get("Pos") or "").strip() or None,
                "throws": (r.get("Throws") or "").strip() or None,
                "bats": None,
                "sample": ip,
                "ip": ip,
                "kPct": _f(r.get("K%")),
                "bbPct": _f(r.get("BB%")),
                "fip": _f(r.get("FIP")),
                "xfip": _f(r.get("xFIP")),
                "eraPlus": _f(r.get("ERA+")),
                "whip": _f(r.get("WHIP")),
            })
    return out


# ── Eligibility + pools ────────────────────────────────────────────────────────
def _eligible(rows, side, include_small):
    """Rows that have every metric finite and (unless include_small) meet the
    qualification threshold (the prototype's `Mn`)."""
    metrics = METRICS[side]
    tkey, tval = THRESHOLD_KEY[side], THRESHOLD_VAL[side]
    out = []
    for r in rows:
        if not include_small and (r.get(tkey) or 0) < tval:
            continue
        if all(_finite(r.get(m["key"])) for m in metrics):
            out.append(r)
    return out


def _metric_pools(sel_rows, cand_rows, metrics):
    """{key: {sel: sorted finite values from sel pool, cand: sorted from cand pool}}
    (the prototype's `qp` + `Fu`)."""
    pools = {}
    for m in metrics:
        k = m["key"]
        pools[k] = {
            "sel": sorted(v for v in (r.get(k) for r in sel_rows) if _finite(v)),
            "cand": sorted(v for v in (r.get(k) for r in cand_rows) if _finite(v)),
        }
    return pools


def _public_row(r, side):
    out = {
        "id": r["id"], "name": r["name"], "team": r.get("team"),
        "level": r.get("level"), "conference": r.get("conference"),
        "bats": r.get("bats"), "throws": r.get("throws"),
        "classYear": r.get("classYear"), "sample": round(r.get("sample") or 0, 1),
    }
    if side == "hitter":
        out["position"] = r.get("position")
    else:
        out["role"] = r.get("role")
    if r.get("season"):
        out["season"] = r["season"]
    if r.get("headshot_url"):
        out["headshot_url"] = r["headshot_url"]
    return out


def compute_comps(selected_id, side, pool, season, opts, limit=5):
    """Core engine (the prototype's `oh`). Returns selectedPlayer + ranked results.
    The selected player is always drawn from the NW pool; candidates from `pool`."""
    metrics = METRICS[side]
    include_small = bool(opts.get("includeSmallSamples"))
    nw_rows = _load_nw_pool(side, season)
    cand_source = nw_rows if pool == "nw" else _load_mlb_pool(side)

    sel_pool = _eligible(nw_rows, side, include_small)       # `a`
    cand_pool = _eligible(cand_source, side, include_small)  # `y`

    selected = next((r for r in sel_pool if str(r["id"]) == str(selected_id)), None)
    if not selected:
        return {"selectedPlayer": None, "results": [], "eligibleCount": len(cand_pool)}

    mode = opts.get("positionMatchMode", "any")
    sel_group = _group(selected, side, mode)
    # Position match only meaningful if the selected player has a real group AND
    # at least one candidate shares it (prototype `rh`).
    apply_pos = bool(mode != "any" and sel_group and sel_group != "N/A"
                     and any(_group(c, side, mode) == sel_group for c in cand_pool))
    # Handedness match only when requested + data present on selected + a candidate (prototype `lh`).
    hkey = "bats" if side == "hitter" else "throws"
    sel_hand = selected.get(hkey)
    apply_hand = bool(opts.get("matchHandedness") and sel_hand and sel_hand != "N/A"
                      and any(c.get(hkey) == sel_hand for c in cand_pool))

    filt = opts.get("filters") or {}  # {level, conference, classYear} -> value

    def keep(c):
        if str(c["id"]) == str(selected["id"]):
            return False
        if apply_pos and _group(c, side, mode) != sel_group:
            return False
        if apply_hand and c.get(hkey) != sel_hand:
            return False
        for fk, fv in filt.items():
            if fv and c.get(fk) != fv:
                return False
        return True

    candidates = [c for c in cand_pool if keep(c)]
    pools = _metric_pools(sel_pool, cand_pool, metrics)

    scored = []
    for c in candidates:
        bd = _breakdown(selected, c, metrics, pools)
        dist = sum(b["weightedDifference"] for b in bd)
        scored.append((dist, c, bd))
    scored.sort(key=lambda x: x[0])

    results = []
    for dist, c, bd in scored[:limit]:
        score = _clamp(100 - dist, 0, 100)
        results.append({
            **_public_row(c, side),
            "similarityScore": round(score, 1),
            "whyText": _why_text(bd),
            "metricBreakdown": [
                {kk: b[kk] for kk in ("key", "label", "format", "selectedValue",
                                      "comparedValue", "selectedPercentile", "comparedPercentile")}
                for b in bd
            ],
            "closestMetrics": [b["label"] for b in bd[:3]],
            "reliabilityRange": _reliability(
                selected, c, side, score,
                {"candidatePool": pool, "positionMatchMode": mode,
                 "applyHandednessMatch": apply_hand, "includeSmallSamples": include_small},
            ),
        })

    sel_public = _public_row(selected, side)
    sel_public["metrics"] = {m["key"]: selected.get(m["key"]) for m in metrics}
    sel_public["percentiles"] = {
        m["key"]: round(_pct_in_sorted(selected.get(m["key"]), pools[m["key"]]["sel"], m["direction"]), 1)
        for m in metrics
    }
    sel_public["qualified"] = (selected.get(THRESHOLD_KEY[side]) or 0) >= THRESHOLD_VAL[side]
    sel_public["archetype"] = _archetype(selected, sel_pool, side)

    return {"selectedPlayer": sel_public, "results": results, "eligibleCount": len(candidates)}


# ── Side resolution for a given player ─────────────────────────────────────────
def _resolve_side(player_id, season):
    """Pick hitter vs pitcher for a player the same way the profile page does:
    pitching if careerIP*4 > careerPA, else batting; one-sided uses what exists.
    Returns (side, found_in_eligible_for_side?) using current-season eligibility."""
    hit = next((r for r in _load_nw_pool("hitter", season) if str(r["id"]) == str(player_id)), None)
    pit = next((r for r in _load_nw_pool("pitcher", season) if str(r["id"]) == str(player_id)), None)
    pa = (hit or {}).get("pa") or 0
    ip = (pit or {}).get("ip") or 0
    has_h = hit is not None and pa > 0
    has_p = pit is not None and ip > 0
    if has_h and has_p:
        return "pitcher" if (ip * 4) > pa else "hitter"
    if has_p:
        return "pitcher"
    if has_h:
        return "hitter"
    return None


# ── Endpoints ──────────────────────────────────────────────────────────────────
def _config(side):
    return {
        "metrics": [{k: m[k] for k in ("key", "label", "format", "direction", "weight")}
                    for m in METRICS[side]],
        "thresholdLabel": THRESHOLD_LABEL[side],
        "positionOrder": POSITION_ORDER,
        "batsOrder": BATS_ORDER,
    }


@router.get("/comps")
@cached_endpoint(ttl_seconds=1800)
def get_comps(
    player_id: int = Query(..., description="NW player id to find comps for"),
    side: str = Query("hitter", pattern="^(hitter|pitcher)$"),
    pool: str = Query("nw", pattern="^(nw|mlb)$"),
    season: int = Query(SEASON_DEFAULT),
    position_match: str = Query("any", pattern="^(any|family|exact)$"),
    match_handedness: bool = Query(False),
    include_small: bool = Query(False),
    level: Optional[str] = Query(None),
    conference: Optional[str] = Query(None),
    class_year: Optional[str] = Query(None),
):
    filters = {}
    if pool == "nw":  # level/conference/class only apply inside the NW pool
        if level:
            filters["level"] = level
        if conference:
            filters["conference"] = conference
        if class_year:
            filters["classYear"] = class_year
    opts = {
        "positionMatchMode": position_match,
        "matchHandedness": match_handedness,
        "includeSmallSamples": include_small,
        "filters": filters,
    }
    out = compute_comps(player_id, side, pool, season, opts)
    out["side"] = side
    out["pool"] = pool
    out["season"] = season
    out["config"] = _config(side)
    return out


@router.get("/comps/players")
@cached_endpoint(ttl_seconds=1800)
def get_comp_players(
    side: str = Query("hitter", pattern="^(hitter|pitcher)$"),
    season: int = Query(SEASON_DEFAULT),
):
    """Selectable NW players for the picker (the selected player is always NW).
    Returns everyone with the full metric set for the side, flagged qualified."""
    rows = _eligible(_load_nw_pool(side, season), side, include_small=True)
    tkey, tval = THRESHOLD_KEY[side], THRESHOLD_VAL[side]
    out = [{
        "id": r["id"], "name": r["name"], "team": r.get("team"),
        "level": r.get("level"), "conference": r.get("conference"),
        "position": r.get("position") if side == "hitter" else r.get("role"),
        "qualified": (r.get(tkey) or 0) >= tval,
        "sample": round(r.get("sample") or 0, 1),
    } for r in rows]
    out.sort(key=lambda x: x["name"] or "")
    return {"side": side, "season": season, "players": out,
            "thresholdLabel": THRESHOLD_LABEL[side]}


@router.get("/players/{player_id}/comps")
@cached_endpoint(ttl_seconds=1800)
def player_comps_widget(
    player_id: int,
    side: str = Query("auto"),
    season: int = Query(SEASON_DEFAULT),
):
    """Trimmed payload for the on-player-page 'Similar Players' card: the three
    closest recent-MLB player-seasons plus the single closest NW comparable.
    Includes small samples so the card still renders for sub-threshold players
    (reliability flags it). `archetype` is returned for compatibility but the
    card no longer renders it."""
    resolved = side if side in ("hitter", "pitcher") else _resolve_side(player_id, season)
    if not resolved:
        return {"side": None, "nw": [], "mlb": None, "archetype": None, "qualified": False}

    # Prefer the qualified-only pool (matches the dedicated page's default) so a
    # qualified player sees the same numbers in both places; fall back to
    # including small samples only when the player is sub-threshold, so the card
    # still renders for thin-sample players (reliability flags it).
    opts = {"positionMatchMode": "any", "matchHandedness": False, "includeSmallSamples": False, "filters": {}}
    nw = compute_comps(player_id, resolved, "nw", season, opts, limit=5)
    if not nw["selectedPlayer"]:
        opts["includeSmallSamples"] = True
        nw = compute_comps(player_id, resolved, "nw", season, opts, limit=5)
    if not nw["selectedPlayer"]:
        return {"side": None, "nw": [], "mlb": None, "archetype": None, "qualified": False}
    mlb = compute_comps(player_id, resolved, "mlb", season, opts, limit=3)

    def slim(r):
        out = {"id": r["id"], "name": r["name"], "team": r.get("team"),
               "level": r.get("level"), "similarityScore": r["similarityScore"],
               "whyText": r["whyText"], "closestMetrics": r.get("closestMetrics", [])}
        if r.get("season"):
            out["season"] = r["season"]
        return out

    sel = nw["selectedPlayer"]
    return {
        "side": resolved,
        "player": {"id": sel["id"], "name": sel["name"], "archetype": sel["archetype"]},
        "archetype": sel["archetype"],
        "qualified": sel["qualified"],
        "nw": [slim(r) for r in nw["results"]],
        "mlb": [slim(r) for r in mlb["results"][:3]],
    }


# ── Reverse comps: pick an MLB player-season, find the closest NW seasons ────────
def compute_reverse_comps(mlb_id, side, season, opts, limit=5):
    """Reverse of compute_comps: the *selected* player is an MLB player-season and
    the candidates are NW seasons. Same cross-environment percentile model — the
    selected is ranked within the MLB pool, each candidate within the NW pool — so
    the only change is which pool is `sel` vs `cand`."""
    metrics = METRICS[side]
    include_small = bool(opts.get("includeSmallSamples"))
    nw_rows = _load_nw_pool(side, season)
    mlb_rows = _load_mlb_pool(side)

    sel_pool = _eligible(mlb_rows, side, include_small=True)   # MLB seasons all qualify
    cand_pool = _eligible(nw_rows, side, include_small)        # NW candidates

    selected = next((r for r in sel_pool if str(r["id"]) == str(mlb_id)), None)
    if not selected:
        return {"selectedPlayer": None, "results": [], "eligibleCount": len(cand_pool)}

    mode = opts.get("positionMatchMode", "any")
    sel_group = _group(selected, side, mode)
    apply_pos = bool(mode != "any" and sel_group and sel_group != "N/A"
                     and any(_group(c, side, mode) == sel_group for c in cand_pool))
    hkey = "bats" if side == "hitter" else "throws"
    sel_hand = selected.get(hkey)
    apply_hand = bool(opts.get("matchHandedness") and sel_hand and sel_hand != "N/A"
                      and any(c.get(hkey) == sel_hand for c in cand_pool))
    filt = opts.get("filters") or {}  # {level, conference, classYear} on the NW side

    def keep(c):
        if apply_pos and _group(c, side, mode) != sel_group:
            return False
        if apply_hand and c.get(hkey) != sel_hand:
            return False
        for fk, fv in filt.items():
            if fv and c.get(fk) != fv:
                return False
        return True

    candidates = [c for c in cand_pool if keep(c)]
    pools = _metric_pools(sel_pool, cand_pool, metrics)  # sel = MLB, cand = NW

    scored = []
    for c in candidates:
        bd = _breakdown(selected, c, metrics, pools)
        dist = sum(b["weightedDifference"] for b in bd)
        scored.append((dist, c, bd))
    scored.sort(key=lambda x: x[0])

    results = []
    for dist, c, bd in scored[:limit]:
        score = _clamp(100 - dist, 0, 100)
        results.append({
            **_public_row(c, side),
            "similarityScore": round(score, 1),
            "whyText": _why_text(bd),
            "metricBreakdown": [
                {kk: b[kk] for kk in ("key", "label", "format", "selectedValue",
                                      "comparedValue", "selectedPercentile", "comparedPercentile")}
                for b in bd
            ],
            "closestMetrics": [b["label"] for b in bd[:3]],
            # Cross-environment regardless of direction, so flag it like the MLB pool.
            "reliabilityRange": _reliability(
                selected, c, side, score,
                {"candidatePool": "mlb", "positionMatchMode": mode,
                 "applyHandednessMatch": apply_hand, "includeSmallSamples": include_small},
            ),
        })

    sel_public = _public_row(selected, side)
    sel_public["metrics"] = {m["key"]: selected.get(m["key"]) for m in metrics}
    sel_public["percentiles"] = {
        m["key"]: round(_pct_in_sorted(selected.get(m["key"]), pools[m["key"]]["sel"], m["direction"]), 1)
        for m in metrics
    }
    sel_public["qualified"] = True
    sel_public["archetype"] = _archetype(selected, sel_pool, side)
    return {"selectedPlayer": sel_public, "results": results, "eligibleCount": len(candidates)}


@router.get("/comps/mlb-players")
@cached_endpoint(ttl_seconds=3600)
def get_comp_mlb_players(side: str = Query("hitter", pattern="^(hitter|pitcher)$")):
    """Selectable MLB player-seasons for the reverse-search picker. Returns every
    bundled MLB season with the full metric set, newest first then by name."""
    rows = _eligible(_load_mlb_pool(side), side, include_small=True)
    out = [{
        "id": r["id"],
        "name": r["name"],
        "season": r.get("season"),
        "team": r.get("team"),
        "position": r.get("position") if side == "hitter" else (r.get("role") or r.get("position")),
        "sample": round(r.get("sample") or 0, 1),
    } for r in rows]
    out.sort(key=lambda x: (-(x["season"] or 0), x["name"] or ""))
    return {"side": side, "players": out, "sampleLabel": SAMPLE_LABEL[side]}


@router.get("/comps/reverse")
@cached_endpoint(ttl_seconds=1800)
def get_reverse_comps(
    mlb_id: str = Query(..., description="MLB player-season id from /comps/mlb-players"),
    side: str = Query("hitter", pattern="^(hitter|pitcher)$"),
    season: int = Query(SEASON_DEFAULT, description="NW season to search within"),
    position_match: str = Query("any", pattern="^(any|family|exact)$"),
    match_handedness: bool = Query(False),
    include_small: bool = Query(False),
    level: Optional[str] = Query(None),
    conference: Optional[str] = Query(None),
    class_year: Optional[str] = Query(None),
):
    filters = {}
    if level:
        filters["level"] = level
    if conference:
        filters["conference"] = conference
    if class_year:
        filters["classYear"] = class_year
    opts = {
        "positionMatchMode": position_match,
        "matchHandedness": match_handedness,
        "includeSmallSamples": include_small,
        "filters": filters,
    }
    out = compute_reverse_comps(mlb_id, side, season, opts)
    out["side"] = side
    out["pool"] = "nw"
    out["direction"] = "reverse"
    out["season"] = season
    out["config"] = _config(side)
    return out
