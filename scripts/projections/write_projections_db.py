"""Compute 2027 player projections for the whole region and write them to the
`player_projections` table, assigned to each player's 2027 team.

Roster logic (so the projection page shows the RIGHT players on the RIGHT team):
  - Returning players -> their current team, projected at their current level.
  - Departing players DROPPED: 4-year Sr/Gr/5th, and JUCO sophomores (NWAC is a
    2-year level, so a So is leaving). Exception: if they're committed elsewhere
    they appear on the NEW team instead (grad transfers, JUCO-to-4yr).
  - Incoming transfers -> their destination team, projected at the DESTINATION
    level (so the level-translation factors apply). Sources: players.is_committed
    + committed_to (free-text school), and backend/data/transfer_portal.json.

Run from repo root:
  PYTHONPATH=backend python3 scripts/projections/write_projections_db.py [--season 2027]
"""
import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.models.database import get_connection  # noqa: E402
from app.stats.advanced import (  # noqa: E402
    DEFAULT_WEIGHTS, DIVISION_SEASON, CollegeWAR, compute_college_war,
)
from derive_constants import load_batting, load_pitching  # noqa: E402
from backtest import (  # noqa: E402
    BAT_COMPONENTS, PIT_COMPONENTS, PERIPH_FEATS, CLASS_NEXT, RECENCY,
    fit_training_constants, project_player, center_peripherals,
    load_pbp_peripherals, load_summer_batting, make_pairs,
)
from compute_player_projections import SIGMA, Z10, build_summer_lookup  # noqa: E402
from team_projection import (  # noqa: E402
    PA_A, PA_B, PA_C, BF_A, BF_B, BF_C, FIP_BLEND, HIT_PBP, PIT_PBP, YOUTH_NUDGE,
    WHIFF_FROM_K, fit_run_estimator, pbp_projection, career_xbh_mix, load_fip_luck,
)

FOURYR = {"D1", "D2", "D3", "NAIA"}

# ISO -> HR-rate (fit from data): lets weak-power hitters project toward ~0 HR
# instead of the league-average ~2 HR. ISO .05 -> ~0.2 HR/150; ISO .25 -> ~6.
ISO_HR_B0, ISO_HR_B1 = -0.00844, 0.2037

# Pitcher projections are too compressed toward the mean (backtest calibration
# slope 1.17); expanding the deviation from the level mean improves accuracy AND
# lets elite arms reach sub-3 / weak ones 7+. Hitters are well-calibrated (0.92).
PIT_EXPAND = 1.15

# Real innings-per-batter-faced (notation-corrected league avg). Used to turn a
# projected BF into IP and to put WHIP on a per-inning basis. The old 0.245
# overstated IP and made WHIP read far too low.
IP_PER_BF = 0.217

# Minimum PA/BF for a season to help FIT model constants (reliability, aging,
# translations, refinement). Players below this are still projected (to fill out
# rosters and depth charts), just not used to derive the constants.
FIT_MIN = 50

# Low-sample handling: a player with little career data is unproven, and unproven
# players are below average (the good ones earn playing time). Below LOW_N total
# career PA/BF we pull their rates toward the level's 25th-percentile (poor)
# value, scaled by how little data they have; below INSUF_N we also flag the line
# "not enough data to project" and cap their playing time. They still appear in
# rosters / depth charts / totals, just as weak, low-volume players.
LOW_N = 60
INSUF_N = 20
POOR_Q = 0.25                       # 25th-percentile-quality anchor
# stats where a HIGH value is bad (so "poor" = the high quantile)
LOW_GOOD = {"bat": {"k_pct"},
            "pit": {"bb_pct", "hr_bf", "babip_against", "whip_rate", "era_rate"}}

# Cross-validated multi-stat refinements: project a stat from the peripheral
# skills that produce it, not from itself alone (analyze_all_stats.py CV gains).
# {target: [predictors]} — predictors are box components (from proj) or PBP
# rates (from pbp_proj). Applied only when all predictors are available.
# order matters: babip refined first (feeds avg). All CV-validated, well-calibrated.
BAT_REFINE = {"babip": ["babip", "p_ld", "p_gb", "p_airpull"],  # CV -6.6%
              "avg": ["avg", "k_pct", "babip", "p_ld"]}          # CV -5%
PIT_REFINE = {"bb_pct": ["bb_pct", "p_strike", "p_whiff"]}       # CV -15%


def fit_refine(df_feat, target, preds, target_season):
    """Fit target_next ~ predictors_now on training pairs. Returns (preds, coef)."""
    P = make_pairs(df_feat[df_feat["season"] < target_season], same_level=True)
    cols1 = [f"{p}_1" for p in preds]
    need = cols1 + [f"{target}_2", "hmean_n"]
    if any(c not in P.columns for c in need):
        return None
    sub = P.dropna(subset=need)
    if len(sub) < 150:
        return None
    X = np.column_stack([sub[c].to_numpy(float) for c in cols1] + [np.ones(len(sub))])
    sw = np.sqrt(sub["hmean_n"].to_numpy(float))
    coef, *_ = np.linalg.lstsq(X * sw[:, None], sub[f"{target}_2"].to_numpy(float) * sw, rcond=None)
    return (preds, coef)


def apply_refine(spec, proj, pbp_for_pid):
    """Refined stat from the player's projected predictors, or None if any
    predictor is unavailable (-> caller keeps the baseline projection)."""
    preds, coef = spec
    vals = []
    for p in preds:
        if p in proj:
            v = proj[p][0]
        else:
            t = pbp_for_pid.get(p)
            v = t[0] if t else None
        if v is None:
            return None
        vals.append(v)
    return float(np.dot(coef[:-1], vals) + coef[-1])


def band_half(rel, side):
    """Credible reliability-scaled half-width for the low/median/high range.
    Replaces the raw next-season outcome sigma, which made ERA bands ~4 runs
    wide (useless). Tighter for high-confidence players; capped so no band is
    absurd. Units: ERA runs for pitchers, wOBA points for hitters."""
    rel = max(0.0, min(1.0, rel or 0.0))
    # Reliability-scaled, NOT capped: confident players get tight ranges, and
    # nothing is artificially limited (a real outlier can range to extremes).
    if side == "pit":
        return round(0.40 + 1.60 * (1 - rel), 3)    # ERA half-width
    return round(0.028 + 0.075 * (1 - rel), 4)      # wOBA half-width


def departing(level, cls):
    """True if this player is leaving their current program after 2026."""
    if level == "JUCO":
        return cls in {"So", "Sr", "Sr+", "Gr", "5th"}   # JUCO is 2 years
    return cls in {"Sr", "Sr+", "Gr", "5th"}             # 4-year seniors graduate


def team_name_map(cur):
    """lower(name|short_name|school_name) -> (team_id, level)."""
    cur.execute("""
        SELECT t.id, t.name, t.short_name, t.school_name, d.level
        FROM teams t JOIN conferences c ON c.id=t.conference_id
        JOIN divisions d ON d.id=c.division_id WHERE COALESCE(t.is_active,1)=1
    """)
    m = {}
    for r in cur.fetchall():
        for nm in (r["short_name"], r["name"], r["school_name"]):
            if nm:
                m.setdefault(nm.strip().lower(), (r["id"], r["level"]))
    return m


def resolve_commit(name, tname_map):
    """Free-text committed_to -> (team_id, level) if it's a tracked PNW team."""
    if not name:
        return None
    key = name.strip().lower()
    if key in tname_map:
        return tname_map[key]
    # loose contains-match (e.g. "Oregon State" vs "Oregon St")
    for nm, val in tname_map.items():
        if key in nm or nm in key:
            return val
    return None


def proj_pt(hist, a, b, c):
    s = {int(r["season"]): r["wt_n"] for _, r in hist.iterrows()}
    return a * s.get(TARGET - 1, 0) + b * s.get(TARGET - 2, 0) + c


# Stats to stretch to the realistically-achievable distribution, with the SQL
# expression for their actual 2026 values (per level). Deliberate product choice
# (Nate): rank by the model's skill read, but scale to what players actually do
# every year so the best hitter projects ~.400, etc. Keeps the projection mean
# and ranking; only widens the spread (never compresses) and clamps to the
# achievable 2nd–98th percentile.
# Only the DRIVER rates are stretched; OBP/SLG/wOBA are RECONSTRUCTED from them
# so the slash line stays internally consistent.
# hr_pa is NOT rank-mapped — HR is anchored to demonstrated ISO in the line
# build so modest-power hitters don't get inflated to masher HR totals.
BAT_ACHIEVE = {"AVG": "batting_avg", "iso": "iso",
               "k_pct": "k_pct", "bb_pct": "bb_pct"}
# ERA is NOT mapped independently — it's derived from FIP (skill) so projected
# ERA and FIP stay aligned. Mapping ERA to the actual ERA distribution projected
# every lucky-low arm to STAY lucky (2.0 ERA vs 4.5 FIP), which read as a bug.
PIT_ACHIEVE = {"FIP": "fip", "K_pct": "k_pct", "BB_pct": "bb_pct"}

# wOBA-ish linear weights for reconstructing wOBA from the slash components.
_WBB, _WHBP, _W1B, _W2B, _W3B, _WHR = 0.69, 0.72, 0.88, 1.25, 1.58, 2.00


def pos_factor(pos):
    """Playing-time multiplier by position. Catchers rarely exceed ~70% of team
    games unless they also DH/play the field; everyone else can play ~full-time."""
    if not pos:
        return 1.0
    parts = pos.upper().split("/")
    if parts == ["C"]:
        return 0.72
    if "C" in parts:
        return 0.88        # catcher who also DHs / plays another spot
    return 1.0


def _pt_distributions(cur):
    """Per (side, level): sorted np.array of actual 2026 playing time (PA / BF),
    so we can map a projected-quality rank to a realistic workload."""
    out = {}
    for side, tbl, col, mn in [("bat", "batting_stats", "plate_appearances", 15),
                               ("pit", "pitching_stats", "batters_faced", 15)]:
        cur.execute(f"""SELECT d.level lvl, b.{col} v FROM {tbl} b
            JOIN teams t ON t.id=b.team_id JOIN conferences c ON c.id=t.conference_id
            JOIN divisions d ON d.id=c.division_id WHERE b.season=2026 AND b.{col}>=%s""", (mn,))
        tmp = {}
        for r in cur.fetchall():
            tmp.setdefault(r["lvl"], []).append(float(r["v"]))
        for lvl, vals in tmp.items():
            out[(side, lvl)] = np.array(sorted(vals))
    return out


def _achievable_targets(cur):
    """Per (side, level, stat): sorted np.array of actual 2026 qualified values,
    for quantile-mapping. Includes SLG/wOBA for clamping the reconstructed line."""
    out = {}
    for side, tbl, idc, mn, specs in [
            ("bat", "batting_stats", "plate_appearances", 100,
             {**BAT_ACHIEVE, "SLG": "slugging_pct", "wOBA": "woba"}),
            ("pit", "pitching_stats", "batters_faced", 60, PIT_ACHIEVE)]:
        for key, expr in specs.items():
            cur.execute(f"""SELECT d.level lvl, ({expr})::float x
                FROM {tbl} b JOIN teams t ON t.id=b.team_id
                JOIN conferences c ON c.id=t.conference_id JOIN divisions d ON d.id=c.division_id
                WHERE b.season=2026 AND b.{idc}>=%s AND ({expr}) IS NOT NULL""", (mn,))
            tmp = {}
            for r in cur.fetchall():
                tmp.setdefault(r["lvl"], []).append(float(r["x"]))
            for lvl, vals in tmp.items():
                if len(vals) >= 8:
                    out[(side, lvl, key)] = np.array(sorted(vals))
    return out


def _quantile_map(proj_vals, target_arr):
    """Map each projected value to the actual distribution at its rank-percentile
    (smooth, no clamp-piling). Percentiles are compressed to [0.03, 0.97] so the
    extremes land on achievable values, not tiny-sample freaks (a 47.00 ERA or a
    .250 ERA at the literal min/max)."""
    n = len(proj_vals)
    order = np.argsort(np.argsort(proj_vals))
    return [float(np.quantile(target_arr, 0.03 + 0.94 * ((order[i] + 0.5) / n))) for i in range(n)]


def _zscores(vals):
    a = np.array(vals, dtype=float)
    sd = a.std() or 1e-9
    return (a - a.mean()) / sd


def poor_anchors(df_fit, comps, side):
    """Per (level, stat) value at the 25th-quality-percentile, from qualified
    actuals. For stats where high is bad (K% for hitters, ERA/BB% for pitchers)
    that's the 75th raw percentile; otherwise the 25th. Used to pull unproven
    (low-sample) players toward a believably below-average line."""
    low_good = LOW_GOOD[side]
    out = {}
    for lvl, g in df_fit.groupby("level"):
        for s in comps:
            v = g[s].dropna()
            if len(v) >= 15:
                q = (1 - POOR_Q) if s in low_good else POOR_Q
                out[(lvl, s)] = float(np.quantile(v, q))
    return out


def _league_baselines(cur):
    """2026 league wOBA (PA-weighted) and FIP (IP-weighted) per division level.
    Projections are translated INTO a 2026-like run environment, so WAR is
    anchored to that season's league context."""
    cur.execute("""SELECT d.level lvl,
          SUM(b.woba*b.plate_appearances)/NULLIF(SUM(b.plate_appearances),0) v
        FROM batting_stats b JOIN teams t ON t.id=b.team_id
        JOIN conferences c ON c.id=t.conference_id JOIN divisions d ON d.id=c.division_id
        WHERE b.season=2026 AND b.plate_appearances>=20 AND b.woba IS NOT NULL GROUP BY 1""")
    lg_woba = {r["lvl"]: float(r["v"]) for r in cur.fetchall() if r["v"]}
    cur.execute("""SELECT d.level lvl,
          SUM(p.fip*p.innings_pitched)/NULLIF(SUM(p.innings_pitched),0) v
        FROM pitching_stats p JOIN teams t ON t.id=p.team_id
        JOIN conferences c ON c.id=t.conference_id JOIN divisions d ON d.id=c.division_id
        WHERE p.season=2026 AND p.innings_pitched>=10 AND p.fip IS NOT NULL GROUP BY 1""")
    lg_fip = {r["lvl"]: float(r["v"]) for r in cur.fetchall() if r["v"]}
    return lg_woba, lg_fip


def add_war(rows, pos_fracs):
    """Projected WAR via the site's compute_college_war (same formula as the
    actual-season WAR on player pages, so projected and real WAR are directly
    comparable). Batting runs from projected wOBA vs league wOBA at the
    destination level + positional + replacement; pitching from FIP vs league."""
    with get_connection() as conn:
        lg_woba, lg_fip = _league_baselines(conn.cursor())
    DEF_WOBA, DEF_FIP = 0.345, 5.0
    for r in rows:
        p = r["proj"]; level = p.get("level") or "D2"
        w = DEFAULT_WEIGHTS.get(level, DEFAULT_WEIGHTS["D1"])
        if r["side"] == "bat":
            pa = p.get("PT") or 0
            woba = p.get("wOBA")
            if not pa or woba is None:
                continue
            wraa = ((woba - lg_woba.get(level, DEF_WOBA)) / w.woba_scale) * pa
            pw = pos_fracs.get(r["canonical_id"])
            war = compute_college_war(
                batting=SimpleNamespace(wraa=wraa), position_weights=pw,
                position=(p.get("pos") or "DH").split("/")[0].upper(),
                plate_appearances=int(pa), division_level=level)
        else:
            ip = p.get("IP") or 0
            fip = p.get("FIP")
            if not ip or fip is None:
                continue
            # pitching runs above replacement, on the site's runs_per_win scale
            pwar = ((lg_fip.get(level, DEF_FIP) - fip) / w.runs_per_win
                    + 0.025) * (ip / 9.0)
            war = compute_college_war(
                pitching=SimpleNamespace(pitching_war=pwar),
                innings_pitched=ip, division_level=level)
        p["WAR"] = round(war.total_war, 1)


_FIELD_SLOTS = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"]
_SLOT_SRC = {"C": ["C"], "1B": ["1B", "3B"], "2B": ["2B", "SS", "3B"],
             "3B": ["3B", "1B", "2B", "SS"], "SS": ["SS", "2B", "3B"],
             "LF": ["LF", "CF", "RF", "OF"], "CF": ["LF", "CF", "RF", "OF"],
             "RF": ["LF", "CF", "RF", "OF"]}
_DC = dict(CAP=0.90, PRIMARY=0.80, BACKUP_MAX=0.34, DH_MAX=0.60, FLOOR=0.05)


def allocate_hitter_pa(rows):
    """Set each hitter's PA from a realistic playing-time share rather than a
    compressed per-player guess. Per team we build a depth chart: each spot goes
    to whoever played it most last year, the rest fill in (OF interchangeable;
    1B/3B and 2B/SS/3B interchangeable), the best idle bat DHs, everyone rests
    some, and the deep bench still gets a ~5% spot share. A player's total share
    of games x the level's full-season PA = his projected PA, so a full-time
    starter lands near a full season and a backup gets a back-up's reps."""
    by_team = {}
    for r in rows:
        if r["side"] == "bat":
            by_team.setdefault(r["team_id"], []).append(r)
    for team_rows in by_team.values():
        players = []
        for r in team_rows:
            pg = r["proj"].get("pos_games") or {}
            if not pg:
                toks = [t.strip() for t in (r.get("pos") or "").upper().split("/") if t.strip()]
                pg = {t: 1 for t in toks}
            players.append({"r": r, "woba": r["proj"].get("wOBA", 0) or 0, "games": pg})
        if not players:
            continue
        cg = lambda p, s: sum(p["games"].get(x, 0) for x in _SLOT_SRC[s])
        primary, claimed = {}, {}
        claims = sorted(((p["games"].get(s, 0), p["woba"], i, s)
                         for i, p in enumerate(players) for s in _FIELD_SLOTS if p["games"].get(s, 0) > 0),
                        reverse=True)
        for _, _, i, s in claims:
            if i not in primary and s not in claimed:
                primary[i] = s; claimed[s] = i
        for s in _FIELD_SLOTS:
            if s not in claimed:
                cand = sorted((p for k, p in enumerate(players) if k not in primary and cg(p, s) > 0),
                              key=lambda p: (cg(p, s), p["woba"]), reverse=True)
                if cand:
                    i = players.index(cand[0]); primary[i] = s; claimed[s] = i
        alloc = [0.0] * len(players); cap = [_DC["CAP"]] * len(players)
        for i, s in primary.items():
            alloc[i] += _DC["PRIMARY"]; cap[i] -= _DC["PRIMARY"]
        for s in _FIELD_SLOTS:
            rem = 1.0 - (alloc[claimed[s]] if s in claimed else 0.0)
            backups = sorted((k for k, p in enumerate(players) if primary.get(k) != s and cg(p, s) > 0 and cap[k] > 1e-6),
                             key=lambda k: (cg(players[k], s), players[k]["woba"]), reverse=True)
            for k in backups:
                if rem <= 1e-6:
                    break
                t = min(cap[k], rem, _DC["BACKUP_MAX"])
                if t > 0:
                    alloc[k] += t; cap[k] -= t; rem -= t
        dh = 1.0
        for k in sorted(range(len(players)), key=lambda k: -players[k]["woba"]):
            if dh <= 1e-6:
                break
            t = min(cap[k], dh, _DC["DH_MAX"])
            if t > 0:
                alloc[k] += t; cap[k] -= t; dh -= t
        for k in range(len(players)):
            if alloc[k] < _DC["FLOOR"]:
                alloc[k] = _DC["FLOOR"]
        for k, p in enumerate(players):
            r = p["r"]
            full_pa = DIVISION_SEASON.get(r["proj"]["level"], DIVISION_SEASON["NAIA"])["pa"]
            pa = round(min(alloc[k], _DC["CAP"]) * full_pa)
            if r["proj"].get("insufficient"):
                pa = min(pa, 45)
            r["proj"]["PT"] = pa


def expand_to_achievable(rows):
    """Two product-driven passes:
      1. Stretch each driver rate's spread to its real achievable distribution
         (best hitter ~.400, ERAs sub-2 to 8+), preserving mean + ranking.
      2. Assign playing time by PROJECTED QUALITY, not last year: the best
         hitters/arms get near-full workloads (scaled by position; pitchers also
         rewarded for strike-throwing durability), the worst get the fewest.
    Then reconstruct the slash line + counts from the stretched rates."""
    with get_connection() as conn:
        cur = conn.cursor()
        tgt = _achievable_targets(cur)
        ptd = _pt_distributions(cur)
    specs = {"bat": BAT_ACHIEVE, "pit": PIT_ACHIEVE}
    for side in ("bat", "pit"):
        for level in {r["proj"]["level"] for r in rows if r["side"] == side}:
            grp = [r for r in rows if r["side"] == side and r["proj"]["level"] == level]
            # --- pass 1: quantile-map driver rates to the achievable distribution ---
            # Map ONLY projected regulars onto the (PA>=100) qualified distribution,
            # so the regular pool matches the actual regular distribution 1:1. If we
            # mapped every rostered hitter, the bench would fill the low ranks and
            # shove every starter above the qualified median (so everyone hit .300+).
            # Fringe/part-time players keep their regressed projection (lower).
            reg_pt = 100 if side == "bat" else 60
            for key in specs[side]:
                arr = tgt.get((side, level, key))
                if arr is None:
                    continue
                idxs = [i for i, r in enumerate(grp)
                        if r["proj"].get(key) is not None and (r["proj"].get("PT") or 0) >= reg_pt]
                if len(idxs) < 5:
                    continue
                mapped = _quantile_map([grp[i]["proj"][key] for i in idxs], arr)
                for j, i in enumerate(idxs):
                    grp[i]["proj"][key] = round(mapped[j], 4)
            # --- pass 2: playing time by projected quality (pitchers only;
            # hitter PA is set from the depth-chart share in allocate_hitter_pa) ---
            arr = ptd.get((side, level))
            if side == "pit" and arr is not None and len(grp) >= 3:
                if side == "pit":
                    # quality + strike-throwing durability decide the workload
                    qz = _zscores([r["sort_val"] for r in grp])     # sort_val = -ER (higher=better)
                    sz = _zscores([(r["proj"].get("p_strike") or 0.62) for r in grp])
                    score = qz + 0.4 * sz
                else:
                    score = np.array([r["sort_val"] for r in grp])  # wOBA (higher=better)
                order = np.argsort(score)                            # ascending; best last
                n = len(order)
                for rank, gi in enumerate(order):
                    pctile = (rank + 0.5) / n
                    pt_q = float(np.quantile(arr, pctile))
                    r = grp[gi]
                    last = r["proj"].get("PT", 0) or 0
                    pt_new = 0.7 * pt_q + 0.3 * last
                    if side == "bat":
                        pt_new *= pos_factor(r.get("pos"))
                    # established players don't lose much of their prior workload
                    # just because the quality map nudges them — floor at 85% of
                    # last year (so a returning starter keeps starting).
                    r["proj"]["PT"] = round(max(pt_new, 0.85 * last))
                    # unproven players don't get inflated workloads by the quality map
                    if r["proj"].get("insufficient"):
                        r["proj"]["PT"] = min(r["proj"]["PT"], 45 if side == "bat" else 50)
    # achievable caps (99th pctile) for the reconstructed combo stats, per level
    # p90 caps: a double-max contact+power profile (.400 AVG AND elite ISO) is an
    # impossible combo, so cap the reconstructed SLG/wOBA at a great-but-real level.
    slg_cap = {lvl: float(np.quantile(tgt[("bat", lvl, "SLG")], 0.90))
               for (s, lvl, k) in tgt if s == "bat" and k == "SLG"}
    woba_cap = {lvl: float(np.quantile(tgt[("bat", lvl, "wOBA")], 0.90))
                for (s, lvl, k) in tgt if s == "bat" and k == "wOBA"}
    # --- reconstruct slash + counts from stretched rates and the new PT ---
    for r in rows:
        p = r["proj"]; pt = p.get("PT", 0)
        if r["side"] == "bat":
            bb_pct = p.get("bb_pct", 0); avg = p.get("AVG", 0); iso = p.get("iso", 0)
            hr_pa = p.get("hr_pa", 0); k_pct = p.get("k_pct", 0)
            # cap ISO so SLG (=AVG+ISO) can't exceed the achievable max — prevents
            # a contact+power double-max producing an impossible .700 SLG.
            cap = slg_cap.get(p.get("level"))
            if cap is not None:
                iso = min(iso, max(0.0, cap - avg))
            hbp_pa = 0.01
            ab = pt * (1 - bb_pct - hbp_pa - 0.01)        # minus BB, HBP, sac
            hr = hr_pa * pt
            h = avg * ab
            xb_bases = max(iso * ab, 0)                    # 2B + 2*3B + 3*HR
            non_hr_xb = max(xb_bases - 3 * hr, 0)          # 2B + 2*3B
            d3 = non_hr_xb * 0.06
            d2 = max(non_hr_xb - 2 * d3, 0)
            singles = max(h - d2 - d3 - hr, 0)
            bb = bb_pct * pt; hbp = hbp_pa * pt
            slg = avg + iso
            obp = (h + bb + hbp) / pt if pt else 0
            woba = ((_WBB * bb + _WHBP * hbp + _W1B * singles + _W2B * d2
                     + _W3B * d3 + _WHR * hr) / pt) if pt else 0
            wcap = woba_cap.get(p.get("level"))
            if wcap is not None:
                woba = min(woba, wcap)
            p.update({"AB": round(ab), "H": round(h), "HR": round(hr, 1),
                      "2B": round(d2, 1), "3B": round(d3, 1), "BB": round(bb), "SO": round(k_pct * pt),
                      "R": round(pt * 0.16 * (obp / 0.360)), "RBI": round(pt * 0.15 * (slg / 0.420)),
                      "OBP": round(obp, 3), "SLG": round(slg, 3), "wOBA": round(woba, 3)})
        else:
            p["BF"] = round(pt)
            p["IP"] = round(pt * IP_PER_BF, 1)
            if p.get("HR_bf") is not None:
                p["HR_allowed"] = round(p["HR_bf"] * pt, 1)
                p["HR9"] = round(p["HR_bf"] * 9 / IP_PER_BF, 2)
            # ERA derived from FIP (skill) + only the repeatable ~16% of a
            # pitcher's career ERA-FIP gap, so ERA and FIP stay consistent and
            # no one systematically "beats their FIP".
            fip = p.get("FIP")
            if fip is not None:
                gap = p.get("fip_luck") or 0.0          # career ERA - FIP
                era = fip + 0.16 * gap
                p["ERA"] = round(era, 2)
                hw = band_half(p.get("reliability", 0.3), "pit")
                p["ERA_lo"] = round(era - hw, 2); p["ERA_hi"] = round(era + hw, 2)


def main():
    global TARGET
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2027)
    TARGET = ap.parse_args().season

    with get_connection() as conn:
        cur = conn.cursor()
        # Load EVERY rostered player (min 1 PA/BF) so depth charts and position
        # gaps fill out. Model constants are still fit only on the >=FIT_MIN
        # subset (below) so tiny samples don't add noise; the extra low-PA
        # players are projected with those clean constants (heavy regression).
        bat = load_batting(cur, min_pa=1)
        pit = load_pitching(cur, min_bf=1)
        summer = load_summer_batting(cur)
        bat_p = load_pbp_peripherals(cur, "bat")
        pit_p = load_pbp_peripherals(cur, "pit")
        run_coef = fit_run_estimator(pit[pit["wt_n"] >= FIT_MIN])
        fip_luck = load_fip_luck(cur)
        tname_map = team_name_map(cur)

        # commitments: player_id -> destination (team_id, level).
        # `left` = anyone who has LEFT their 2026 team: committed elsewhere OR
        # entered the portal (even if not yet committed). They get removed from
        # the old roster; committed ones reappear on the new team.
        commits, left = {}, set()
        cur.execute("""SELECT id, committed_to FROM players WHERE is_committed = 1""")
        for r in cur.fetchall():
            left.add(r["id"])
            dest = resolve_commit(r["committed_to"], tname_map)
            if dest:
                commits[r["id"]] = dest
        tp_path = REPO / "backend" / "data" / "transfer_portal.json"
        if tp_path.exists():
            for e in json.loads(tp_path.read_text()).get("players", []):
                pid = e.get("player_id")
                if not pid:
                    continue
                left.add(int(pid))   # in the portal = gone from old team
                dest = resolve_commit(e.get("committed_to"), tname_map)
                if dest:
                    commits[int(pid)] = dest
        # canonical-id remap (history is keyed on canonical id)
        cur.execute("SELECT linked_id, canonical_id FROM player_links")
        cmap = {r["linked_id"]: r["canonical_id"] for r in cur.fetchall()}
        commits_canon = {cmap.get(pid, pid): dest for pid, dest in commits.items()}
        left_canon = {cmap.get(pid, pid) for pid in left}

        # roster meta: most-recent (2026) team + class + name per player
        meta = {}
        for tbl, idc in [("batting_stats", "plate_appearances"), ("pitching_stats", "batters_faced")]:
            cur.execute(f"""
                SELECT COALESCE(c.canonical_id,b.player_id) cid, b.player_id raw,
                       p.first_name||' '||p.last_name name, p.position pos,
                       b.team_id, ps.year_in_school cls26
                FROM {tbl} b JOIN players p ON p.id=b.player_id
                LEFT JOIN player_links c ON c.linked_id=b.player_id
                LEFT JOIN player_seasons ps ON ps.player_id=b.player_id AND ps.season=2026
                WHERE b.season=2026 AND b.{idc}>=1
            """)
            for r in cur.fetchall():
                meta.setdefault(r["cid"], r)   # first side wins for name/pos; fine

        # per-level HR-per-fly-ball (the xFIP normalizer). FB% is a stable pitcher
        # skill; HR/FB is mostly luck + park/level, so projecting HR as
        # (projected FB% x level HR/FB) is far more predictive than a pitcher's
        # own noisy HR rate. NWAC's HR/FB (~.037) is a third of the 4-year levels.
        cur.execute("""
            SELECT d.level lvl, COUNT(*) FILTER (WHERE ge.bb_type='FB') fb,
                   COUNT(*) FILTER (WHERE ge.result_type='home_run') hr
            FROM game_events ge JOIN games g ON g.id=ge.game_id
            JOIN players p ON p.id=ge.pitcher_player_id JOIN teams t ON t.id=p.team_id
            JOIN conferences c ON c.id=t.conference_id JOIN divisions d ON d.id=c.division_id
            WHERE g.season=2026 GROUP BY 1
        """)
        hr_per_fb = {r["lvl"]: (r["hr"] / r["fb"]) for r in cur.fetchall() if r["fb"]}

        # all positions each player actually played in 2026 (>=15% of his games),
        # most-used first — so the roster shows e.g. "1B/OF", revealing how a team
        # fits multiple same-primary guys via secondary spots.
        cur.execute("""
            WITH canon AS (SELECT linked_id pid, canonical_id cid FROM player_links)
            SELECT COALESCE(c.cid, gb.player_id) cid, gb.position pos, COUNT(*) n
            FROM game_batting gb JOIN games g ON g.id=gb.game_id
            LEFT JOIN canon c ON c.pid=gb.player_id
            WHERE g.season=2026 AND gb.position IS NOT NULL AND gb.position <> ''
            GROUP BY 1, 2
        """)
        pos_counts = {}
        for r in cur.fetchall():
            # game-log position can be a slashed string ("1B/2B"); split + tally each
            for raw in (r["pos"] or "").upper().split("/"):
                pos = raw.strip()
                if pos in ("", "PH", "PR", "DR"):    # pinch-hit/run aren't real positions
                    continue
                agg = pos_counts.setdefault(r["cid"], {})
                agg[pos] = agg.get(pos, 0) + r["n"]
        all_positions = {}
        pos_fracs = {}   # cid -> {pos: fraction of games} for the WAR positional adj
        for cid, agg in pos_counts.items():
            tot = sum(agg.values())
            keep = [p for p, n in sorted(agg.items(), key=lambda kv: kv[1], reverse=True)
                    if n >= max(2, 0.15 * tot)]
            if keep:
                all_positions[cid] = "/".join(keep[:3])
            if tot:
                pos_fracs[cid] = {p: n / tot for p, n in agg.items()}

        # --- usage-based role detection (smart role logic) ---
        # A player's role is decided by their MOST RECENT season's actual usage,
        # not a static position label. If a two-way player's latest season is all
        # pitching (e.g. a JUCO 1B/OF who became a D1 pitcher), we drop the stale
        # hitting projection -- and vice versa. True current two-ways get both.
        # per-level league mean ER/BF (most recent season) = expansion center
        lvl_mean_er = {}
        for lv, g in pit[(pit["season"] == TARGET - 1) & (pit["wt_n"] >= FIT_MIN)].groupby("level"):
            v = g["era_rate"].dropna()
            if len(v):
                lvl_mean_er[lv] = float(np.average(v, weights=g.loc[v.index, "wt_n"]))
        bat_latest = bat.groupby("pid")["season"].max()
        pit_latest = pit.groupby("pid")["season"].max()
        role = {}
        for pid in set(bat_latest.index) | set(pit_latest.index):
            bl = int(bat_latest.get(pid, -1)); pl = int(pit_latest.get(pid, -1))
            latest = max(bl, pl)
            role[pid] = {"bat": bl == latest and bl > 0, "pit": pl == latest and pl > 0}

        rows = []
        for side in ("bat", "pit"):
            df = bat if side == "bat" else pit
            periph = bat_p if side == "bat" else pit_p
            comps = BAT_COMPONENTS if side == "bat" else PIT_COMPONENTS
            pa_args = (PA_A, PA_B, PA_C) if side == "bat" else (BF_A, BF_B, BF_C)
            pbp_feats = HIT_PBP if side == "bat" else PIT_PBP
            headline = "woba" if side == "bat" else "era_rate"
            df_feat = df.merge(periph, on=["pid", "season"], how="left")
            df_feat["p_n"] = df_feat["p_n"].fillna(0)
            df_feat = center_peripherals(df_feat, PERIPH_FEATS[side])
            # constants fit on the qualified subset; history (who we project from)
            # is the full roster so low-PA returners still get a projection.
            df_fit = df_feat[df_feat["wt_n"] >= FIT_MIN].copy()
            C = fit_training_constants(df_fit, comps, TARGET)
            anchors_poor = poor_anchors(df_fit[df_fit["season"] < TARGET], comps, side)
            hist_all = (df_feat[df_feat["season"] < TARGET]
                        .sort_values("wt_n", ascending=False).drop_duplicates(["pid", "season"]))
            summer_lookup = build_summer_lookup(summer, TARGET) if side == "bat" else {}
            a_sig, b_sig = SIGMA[side]

            # PITCHER run prevention from the full peripheral set (K%, BB%, whiff,
            # GB, strike) — cross-validated to beat self/FIP by ~12% (era_rate
            # is volatile; its stable inputs predict it far better than ERA does).
            era_periph = None
            if side == "pit":
                tr = df_feat[(df_feat["season"] < TARGET) & (df_feat["wt_n"] >= FIT_MIN)]
                pr = make_pairs(tr, same_level=True)
                EF = ["k_pct_1", "bb_pct_1", "p_whiff_1", "p_gb_1", "p_strike_1"]
                prc = pr.dropna(subset=EF + ["era_rate_2", "hmean_n"])
                if len(prc) >= 150:
                    Xc = np.column_stack([prc[f].to_numpy(float) for f in EF] + [np.ones(len(prc))])
                    sw = np.sqrt(prc["hmean_n"].to_numpy(float))
                    era_periph, *_ = np.linalg.lstsq(Xc * sw[:, None], prc["era_rate_2"].to_numpy(float) * sw, rcond=None)
            # multi-stat refinement models (avg / bb_pct from their peripherals)
            refine = {}
            for tgt, preds in (BAT_REFINE if side == "bat" else PIT_REFINE).items():
                spec = fit_refine(df_feat[df_feat["wt_n"] >= FIT_MIN], tgt, preds, TARGET)
                if spec:
                    refine[tgt] = spec

            # who do we project on this side? everyone with a recent qualified season
            recent = hist_all[hist_all["season"].isin([TARGET - 1, TARGET - 2])]
            pids = recent.sort_values("season").drop_duplicates("pid", keep="last")["pid"].tolist()

            # class map + whiff anchors for pitchers
            clsmap = {}
            for pid in pids:
                h = hist_all[(hist_all["pid"] == pid) & (hist_all["season"] < TARGET)]
                if not h.empty:
                    clsmap[pid] = h.sort_values("season").iloc[-1]["cls"] or "Sr"
            anchors = {}
            if side == "pit":
                a0, a1 = WHIFF_FROM_K
                for pid in pids:
                    hk = hist_all[(hist_all["pid"] == pid) & (hist_all["season"] < TARGET)].dropna(subset=["k_pct"])
                    if not hk.empty:
                        anchors[pid] = {"p_whiff": a0 + a1 * np.average(hk["k_pct"], weights=hk["wt_n"])}
            pbp_proj = pbp_projection(periph, pbp_feats, clsmap, anchors)

            for pid in pids:
                h = hist_all[(hist_all["pid"] == pid) & (hist_all["season"] < TARGET)]
                if h.empty:
                    continue
                last = h.sort_values("season").iloc[-1]
                cur_level, cls = last["level"], last["cls"]
                cls = cls if isinstance(cls, str) else None   # NaN -> None (JSON-safe)
                m = meta.get(pid, {})
                # smart role gate: only project the side the player still plays,
                # judged by their most recent season's usage (drops stale roles
                # for players who consolidated to one role at the next level).
                if not role.get(pid, {}).get(side, True):
                    continue
                # decide 2027 team + level
                if pid in commits_canon:
                    team_id, level = commits_canon[pid]
                    incoming = True
                elif pid in left_canon:
                    continue   # left the program (portal/committed) - no known destination
                elif not departing(cur_level, cls):
                    if not m:
                        continue
                    team_id, level, incoming = m["team_id"], cur_level, False
                else:
                    continue   # graduating, no destination
                proj = project_player(h, summer_lookup.get(pid, []), C, comps, level, TARGET, cls)
                if headline not in proj:
                    continue
                # unproven (low-sample) players: blend every projected rate toward
                # the level's 25th-pct (poor) value, weighted by how thin the data
                # is. Very thin samples get flagged "insufficient" and capped PT.
                career_n = float(h["wt_n"].sum())
                insufficient = career_n < INSUF_N
                if career_n < LOW_N:
                    dw = max(0.12, career_n / LOW_N)
                    for s in list(proj):
                        anc = anchors_poor.get((level, s))
                        if anc is not None:
                            val, r_ = proj[s]
                            proj[s] = (dw * val + (1 - dw) * anc, r_)
                head, rel = proj[headline]
                pt = proj_pt(h, *pa_args)
                if insufficient:
                    pt = min(pt, 45 if side == "bat" else 50)
                line = {"reliability": round(rel, 3), "PT": round(pt), "level": level,
                        "from_level": cur_level, "incoming": incoming, "insufficient": insufficient,
                        "class_2027": (CLASS_NEXT.get(cls) if cls else None)}
                for s in comps:
                    if s in proj:
                        line[s] = round(proj[s][0], 4)
                pbp_for = pbp_proj.get(pid, {})
                if side == "bat":
                    # refine BABIP first (from LD%/GB%/air-pull) so AVG uses it
                    if "babip" in refine:
                        br = apply_refine(refine["babip"], proj, pbp_for)
                        if br is not None:
                            proj["babip"] = (max(0.20, min(0.45, br)), proj["babip"][1])
                    bb, k, hr_pa, avg, iso = (proj.get(s, (0, 0))[0] for s in ["bb_pct", "k_pct", "hr_pa", "avg", "iso"])
                    # refine AVG from its peripherals (K%, BABIP, LD%) when available
                    if "avg" in refine:
                        av = apply_refine(refine["avg"], proj, pbp_for)
                        if av is not None:
                            avg = max(0.15, min(0.45, av))
                    ab = pt * (1 - bb - 0.02)
                    # HR anchored to DEMONSTRATED ISO (a stable, true-power signal
                    # that doesn't get inflated by league-mean regression or the
                    # rank-map). A near-zero-ISO hitter projects ~0 HR; a real
                    # masher's high ISO carries his power through. A small slice of
                    # the regressed HR rate nudges proven-over-ISO guys up.
                    hh = h.dropna(subset=["iso"])
                    iso_demo = (float(np.average(hh["iso"], weights=hh["wt_n"]))
                                if len(hh) else iso)
                    iso_hr = max(0.0, ISO_HR_B0 + ISO_HR_B1 * iso_demo)
                    hr_pa_eff = max(0.0, 0.7 * iso_hr + 0.3 * hr_pa)
                    line["hr_pa"] = round(hr_pa_eff, 4)   # used by the reconstruction
                    hr = hr_pa_eff * pt
                    s2, s3, _ = career_xbh_mix(bat, pid)
                    rem = max(iso * ab - 3 * hr, 0)
                    tot = s2 + s3 if (s2 + s3) > 0 else 1
                    d3 = rem * (s3 / tot) / (1 + s3 / tot)
                    hw = band_half(rel, "bat")
                    line.update({"AB": round(ab), "H": round(avg * ab), "HR": round(hr, 1),
                                 "2B": round(max(rem - 2 * d3, 0), 1), "3B": round(max(d3, 0), 1),
                                 "R": round(pt * 0.16 * (proj.get("obp", (0.33, 0))[0] / 0.360)),
                                 "RBI": round(pt * 0.15 * ((avg + iso) / 0.420)),
                                 "BB": round(bb * pt), "SO": round(k * pt),
                                 "AVG": round(avg, 3), "OBP": round(proj.get("obp", (0, 0))[0], 3),
                                 "SLG": round(avg + iso, 3), "wOBA": round(head, 3),
                                 "wOBA_lo": round(head - hw, 3), "wOBA_hi": round(head + hw, 3)})
                    sort_val = head
                else:
                    k, bb, hrb = (proj.get(s, (0, 0))[0] for s in ["k_pct", "bb_pct", "hr_bf"])
                    # refine BB% from strike%/whiff% (a strike-thrower walks fewer)
                    if "bb_pct" in refine:
                        bbr = apply_refine(refine["bb_pct"], proj, pbp_for)
                        if bbr is not None:
                            bb = max(0.02, min(0.25, bbr))
                    # xFIP-style HR rate: projected FB% (a stable skill) x the
                    # level's HR-per-fly-ball, blended over the pitcher's own noisy
                    # HR rate. Far more predictive, and it carries the level's power
                    # environment (NWAC arms give up HR on far fewer fly balls).
                    p_fb = pbp_for.get("p_fb", (None,))[0]
                    if p_fb is not None and level in hr_per_fb:
                        bip_frac = max(0.40, 1 - k - bb - 0.02)
                        xhr_bf = hr_per_fb[level] * p_fb * bip_frac
                        hrb = 0.7 * xhr_bf + 0.3 * hrb
                    fip_rate = run_coef[0]*k + run_coef[1]*bb + run_coef[2]*hrb + run_coef[3]
                    # Prefer the validated peripheral run model (K%,BB%,whiff,GB,
                    # strike) when we have the player's pitch-level rates; else
                    # fall back to the FIP/ERA blend.
                    pv = pbp_proj.get(pid, {})
                    wh, gbp, st = (pv.get(f, (None, None))[0] for f in ("p_whiff", "p_gb", "p_strike"))
                    if era_periph is not None and None not in (wh, gbp, st):
                        er_bf = (era_periph[0]*k + era_periph[1]*bb + era_periph[2]*wh
                                 + era_periph[3]*gbp + era_periph[4]*st + era_periph[5])
                    else:
                        er_bf = FIP_BLEND * fip_rate + (1 - FIP_BLEND) * head
                    # de-compress: pitcher projections are statistically too
                    # squashed toward the mean (calibration slope 1.17 in
                    # backtest -- expanding improves RMSE). Expand the deviation
                    # from the level mean so elite arms reach sub-3 and weak ones
                    # 7+, instead of everyone bunched at ~5.
                    lg_er = lvl_mean_er.get(level, er_bf)
                    # don't expand unproven arms past their (already poor) anchor —
                    # keep them around the 25th-pct level instead of overshooting.
                    expand = 1.0 if insufficient else PIT_EXPAND
                    er = (lg_er + expand * (er_bf - lg_er)) * 39.6   # ERA scale
                    fip_rate = lg_er + expand * (fip_rate - lg_er)
                    hw = band_half(rel, "pit")
                    ip = pt * IP_PER_BF
                    whip_rate = proj.get("whip_rate", (None, 0))[0]   # (H+BB) per BF
                    whip = round(whip_rate / IP_PER_BF, 2) if whip_rate else None
                    hr9 = round(hrb * 9 / IP_PER_BF, 2)               # HR allowed per 9 IP
                    # opponent AVG reconstructed from the components that actually
                    # predict it: strikeouts (no ball in play), HR, and a REGRESSED
                    # BABIP-against (pitchers barely control BABIP, so the regressed
                    # value forecasts next year far better than demonstrated hits).
                    babip_ag = proj.get("babip_against", (None, 0))[0]
                    if not babip_ag or babip_ag <= 0:
                        babip_ag = 0.310                       # league-ish fallback
                    ab_frac = max(0.5, 1 - bb - 0.025)         # AB per BF (minus BB/HBP/sac)
                    bip_frac = max(0.0, ab_frac - k - hrb)     # balls in play (not K/HR)
                    h_frac = hrb + babip_ag * bip_frac         # hits per BF
                    opp_avg = round(min(0.40, max(0.15, h_frac / ab_frac)), 3)
                    line.update({"BF": round(pt), "IP": round(ip, 1),
                                 "ERA": round(er, 2), "FIP": round(fip_rate * 39.6, 2),
                                 "WHIP": whip, "HR_allowed": round(hrb * pt, 1), "HR9": hr9,
                                 "opp_avg": opp_avg,
                                 "K_pct": round(k, 3), "BB_pct": round(bb, 3), "HR_bf": round(hrb, 4),
                                 "ERA_lo": round(er - hw, 2), "ERA_hi": round(er + hw, 2),
                                 "fip_luck": (round(fip_luck.get(pid), 2) if fip_luck.get(pid) is not None else None)})
                    sort_val = -er   # lower ERA = better, so negate for desc sort
                for f in pbp_feats:
                    pv = pbp_proj.get(pid, {}).get(f)
                    if pv:
                        line[f] = round(pv[0], 3)
                        if pv[1] is not None:
                            line[f + "_prev"] = round(pv[1], 3)
                # last-year share of games at each position (drives the depth-chart
                # / playing-time tool on the frontend); only meaningful for hitters
                if side == "bat" and pos_fracs.get(pid):
                    line["pos_share"] = {p: round(f, 3) for p, f in pos_fracs[pid].items() if f >= 0.05}
                    # absolute games at each position last year, so the depth-chart
                    # tool can hand each spot to whoever played it most.
                    line["pos_games"] = {p: int(n) for p, n in pos_counts.get(pid, {}).items()}
                rows.append({"season": TARGET, "team_id": team_id, "player_id": int(m.get("raw", pid)),
                             "canonical_id": int(pid), "side": side, "name": m.get("name", "?"),
                             "pos": all_positions.get(pid) or m.get("pos"), "class_last": cls, "is_incoming": incoming,
                             "from_team_id": int(m.get("team_id")) if m.get("team_id") else None,
                             "sort_val": round(float(sort_val), 5), "proj": line})

    allocate_hitter_pa(rows)
    expand_to_achievable(rows)
    add_war(rows, pos_fracs)

    # write to DB
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS player_projections (
                season int NOT NULL, team_id int NOT NULL, player_id int NOT NULL,
                canonical_id int, side text NOT NULL, name text, pos text,
                class_last text, is_incoming boolean, from_team_id int,
                sort_val double precision, proj jsonb,
                PRIMARY KEY (season, team_id, player_id, side)
            )
        """)
        cur.execute("DELETE FROM player_projections WHERE season = %s", (TARGET,))
        for r in rows:
            cur.execute("""
                INSERT INTO player_projections
                  (season, team_id, player_id, canonical_id, side, name, pos,
                   class_last, is_incoming, from_team_id, sort_val, proj)
                VALUES (%(season)s,%(team_id)s,%(player_id)s,%(canonical_id)s,%(side)s,
                        %(name)s,%(pos)s,%(class_last)s,%(is_incoming)s,%(from_team_id)s,
                        %(sort_val)s,%(proj)s)
                ON CONFLICT (season, team_id, player_id, side) DO UPDATE SET
                  proj=EXCLUDED.proj, sort_val=EXCLUDED.sort_val, is_incoming=EXCLUDED.is_incoming,
                  name=EXCLUDED.name, pos=EXCLUDED.pos, class_last=EXCLUDED.class_last
            """, {**r, "proj": json.dumps(r["proj"])})
        conn.commit()
    n_in = sum(1 for r in rows if r["is_incoming"])
    print(f"Wrote {len(rows)} projection rows for {TARGET} ({n_in} incoming transfers) "
          f"across {len(set(r['team_id'] for r in rows))} teams.")


if __name__ == "__main__":
    main()
