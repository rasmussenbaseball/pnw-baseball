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
import park  # noqa: E402  — home-park HR / run factors (de-park inputs, re-park outputs)

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

# Workload discount for incoming transfers. A returning starter has earned his
# role; an incoming transfer (esp. JUCO->4yr) is judged on talent but should NOT
# be handed a returner's workload — not every NWAC starter starts at the next
# level. So a transfer competes for ~half the innings/at-bats his projected
# talent alone would imply, which lets him fill a returning team's NEED (open
# innings from graduation) without vacuuming a returning ace's load.
TRANS_IP_DISCOUNT = 0.5             # pitchers: fraction of talent-implied innings
TRANS_PA_GAMES_MULT = 0.6          # hitters: prior games weigh less when claiming a job
TRANS_PA_WOBA_MULT = 0.85          # hitters: must be clearly better to take at-bats
# stats where a HIGH value is bad (so "poor" = the high quantile)
LOW_GOOD = {"bat": {"k_pct"},
            "pit": {"bb_pct", "hr_bf", "babip_against", "whip_rate", "era_rate"}}

# Cross-validated multi-stat refinements: project a stat from the peripheral
# skills that produce it, not from itself alone (analyze_all_stats.py CV gains).
# {target: [predictors]} — predictors are box components (from proj) or PBP
# rates (from pbp_proj). Applied only when all predictors are available.
# order matters: babip refined first (feeds avg). All CV-validated, well-calibrated.
BAT_REFINE = {"babip": ["babip", "p_ld", "p_gb", "p_airpull"],  # CV -6.6%
              "avg": ["avg", "k_pct", "babip", "p_ld"],          # CV -5%
              # K% from whiff/swing (contact skills), BB% from swing rate
              # (plate discipline) — drive these off PBP skill, not a static lag.
              "k_pct": ["p_whiff", "p_swing", "k_pct"],
              "bb_pct": ["p_swing", "p_whiff", "bb_pct"]}
# BB% / K% blend the pitcher's OWN track record with his strike-throwing and
# whiff skill. The lagged rate has to stay in: dropping it made the model use
# only the population trend (high-whiff arms walk more on average), which
# inverted proven control artists (Wolfe 7% BB -> 13%). With the lag, a strike%
# nudge adjusts a real track record instead of overwriting it.
PIT_REFINE = {"bb_pct": ["bb_pct", "p_strike", "p_whiff"],
              "k_pct": ["k_pct", "p_whiff", "p_strike"]}


def _waterfill(weights, total, cap):
    """Distribute `total` across items proportional to weights, capping each at
    `cap` and redistributing the overflow to the uncapped. Lets a team's PA/IP sum
    to its level average while no individual exceeds a realistic max."""
    n = len(weights); alloc = [0.0] * n; active = set(range(n)); rem = float(total)
    for _ in range(8):
        sw = sum(weights[i] for i in active)
        if sw <= 1e-9 or not active or rem <= 1e-9:
            break
        per = rem / sw; capped = []
        for i in active:
            if weights[i] * per >= cap:
                alloc[i] = cap; capped.append(i)
        if not capped:
            for i in active:
                alloc[i] = weights[i] * per
            break
        for i in capped:
            active.discard(i); rem -= cap
    return alloc


def team_workload(cur):
    """Per-level average TEAM PA and TEAM IP, a realistic individual cap (97th
    pctile), innings-per-BF, and the sorted per-pitcher IP shape — so every team's
    projected PA/IP sums to its league's actual team average."""
    def tip(n):
        w = int(n); return w + round((n - w) * 10) / 3.0
    wl = {}
    cur.execute("""SELECT d.level lvl, b.team_id tid, SUM(b.plate_appearances) tpa,
              array_agg(b.plate_appearances) pas
        FROM batting_stats b JOIN teams t ON t.id=b.team_id
        JOIN conferences c ON c.id=t.conference_id JOIN divisions d ON d.id=c.division_id
        WHERE b.season=2026 AND t.state IN ('WA','OR','ID','MT','BC') GROUP BY 1,2""")
    tpa, ipa = {}, {}
    for r in cur.fetchall():
        tpa.setdefault(r["lvl"], []).append(r["tpa"]); ipa.setdefault(r["lvl"], []).extend(r["pas"])
    cur.execute("""SELECT d.level lvl, p.team_id tid, array_agg(p.innings_pitched) ips,
              SUM(FLOOR(p.innings_pitched)+(p.innings_pitched-FLOOR(p.innings_pitched))*10/3.0) tip,
              SUM(p.batters_faced) bf
        FROM pitching_stats p JOIN teams t ON t.id=p.team_id
        JOIN conferences c ON c.id=t.conference_id JOIN divisions d ON d.id=c.division_id
        WHERE p.season=2026 AND t.state IN ('WA','OR','ID','MT','BC') GROUP BY 1,2""")
    tipd, iip, ipnum, bfden = {}, {}, {}, {}
    for r in cur.fetchall():
        lvl = r["lvl"]
        tipd.setdefault(lvl, []).append(sum(tip(float(x)) for x in r["ips"]))
        iip.setdefault(lvl, []).extend(tip(float(x)) for x in r["ips"])
        ipnum[lvl] = ipnum.get(lvl, 0) + float(r["tip"] or 0); bfden[lvl] = bfden.get(lvl, 0) + (r["bf"] or 0)
    for lvl in tpa:
        wl[lvl] = {"pa": float(np.mean(tpa[lvl])), "pa_cap": float(np.quantile(ipa[lvl], 0.97)),
                   "ip": float(np.mean(tipd.get(lvl, [0]))), "ip_cap": float(np.quantile(iip.get(lvl, [1]), 0.97)),
                   "ip_per_bf": (ipnum[lvl] / bfden[lvl]) if bfden.get(lvl) else 0.217,
                   "ip_shape": sorted(iip.get(lvl, [10]))}
    return wl


def to_ip_notation(decimal_ip):
    """Decimal innings -> baseball notation (.1 = 1/3 inning, .2 = 2/3).
    51.6 decimal -> 51 and ~2 thirds -> 51.2."""
    whole = int(decimal_ip)
    thirds = round((decimal_ip - whole) * 3)
    if thirds >= 3:
        whole += 1; thirds = 0
    return round(whole + thirds / 10.0, 1)


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


# Out-of-region schools whose name loosely collides with a PNW team — they must
# resolve to None (player leaves the region), not the same-city PNW school.
# "Bellevue University" (NAIA, Nebraska) vs "Bellevue" CC (NWAC, WA).
_NON_PNW_COMMITS = {"bellevue university"}


def resolve_commit(name, tname_map):
    """Free-text committed_to -> (team_id, level) if it's a tracked PNW team."""
    if not name:
        return None
    key = name.strip().lower()
    if key in _NON_PNW_COMMITS:
        return None
    if key in tname_map:
        return tname_map[key]
    # loose contains-match (e.g. "Oregon State" vs "Oregon St")
    for nm, val in tname_map.items():
        if key in nm or nm in key:
            return val
    return None


def _incoming_side(pos):
    """Crude hitter/pitcher split for a roster-only incoming player. Pure
    pitcher designations -> pitcher; everything else (incl. two-way / unknown)
    goes on the hitter side so it still shows up somewhere."""
    if pos and pos.strip().upper() in ("RHP", "LHP", "P", "SP", "RP"):
        return "pit"
    return "bat"


def add_incoming_no_data(rows, target):
    """Append roster-only rows for incoming FRESHMEN (committed recruits) and
    stat-less incoming TRANSFERS. Neither has college history to project, so
    they're written with proj.no_data=True: they appear on the team's projected
    roster (so the full incoming class is visible) but are explicitly flagged
    "no projection yet" on the page. Synthetic player_ids (large offsets) keep
    them from colliding with real players.player_id and with each other.

    Called AFTER all model post-processing (PT/IP allocation, WAR, breakout) so
    these zero-data rows never perturb the projections."""
    seen_ids = {(r["team_id"], r["player_id"], r["side"]) for r in rows}
    # If a transfer/recruit already projects on that team from real stats, skip
    # the duplicate roster-only row.
    seen_names = {(r["team_id"], (r["name"] or "").strip().lower()) for r in rows}
    n_fr = n_tr = 0
    with get_connection() as conn:
        cur = conn.cursor()
        tname_map = team_name_map(cur)
        cur.execute("""SELECT t.id, d.level FROM teams t
                       JOIN conferences c ON c.id=t.conference_id
                       JOIN divisions d ON d.id=c.division_id""")
        lvl = {r["id"]: r["level"] for r in cur.fetchall()}

        # Committed recruits. grad_year == target-1 are true incoming freshmen;
        # earlier classes are on-roster recruits who may never have played but are
        # still on the team (show them too, with their approximate class).
        _CLASSES = ["Fr", "So", "Jr", "Sr", "Sr+"]
        cur.execute("""SELECT id, first_name, last_name, position, committed_team_id,
                              bbnw_state_rank, pbr_state_rank, state, grad_year
                       FROM recruits
                       WHERE committed_team_id IS NOT NULL AND grad_year IS NOT NULL
                         AND grad_year <= %s""",
                    (target - 1,))
        for r in cur.fetchall():
            tid = r["committed_team_id"]
            name = f"{r['first_name'] or ''} {r['last_name'] or ''}".strip()
            side = _incoming_side(r["position"])
            pid = 90_000_000 + int(r["id"])
            if (tid, pid, side) in seen_ids or (tid, name.lower()) in seen_names:
                continue
            rank = r["bbnw_state_rank"] or r["pbr_state_rank"]
            is_fresh = r["grad_year"] == target - 1
            cls = "Fr" if is_fresh else _CLASSES[min(max(target - int(r["grad_year"]) - 1, 0), 4)]
            proj = {"no_data": True, "insufficient": True, "is_freshman": is_fresh,
                    "class_2027": cls, "level": lvl.get(tid),
                    "state_rank": rank, "recruit_state": r["state"],
                    ("PT" if side == "bat" else "BF"): 0}
            rows.append({"season": target, "team_id": tid, "player_id": pid,
                         "canonical_id": pid, "side": side, "name": name or "?",
                         "pos": r["position"], "class_last": None, "is_incoming": True,
                         "from_team_id": None, "sort_val": -1e9, "proj": proj})
            seen_ids.add((tid, pid, side))
            n_fr += 1

        # Stat-less incoming transfers (manually tracked; no stats in our DB).
        cur.execute("""SELECT id, name, from_school, to_team_id, position
                       FROM incoming_transfers WHERE to_team_id IS NOT NULL""")
        for r in cur.fetchall():
            tid = r["to_team_id"]
            name = (r["name"] or "").strip()
            side = _incoming_side(r["position"])
            pid = 91_000_000 + int(r["id"])
            if (tid, pid, side) in seen_ids or (tid, name.lower()) in seen_names:
                continue
            dest = resolve_commit(r["from_school"], tname_map)
            proj = {"no_data": True, "insufficient": True, "is_transfer": True,
                    "class_2027": None, "level": lvl.get(tid),
                    "from_school": r["from_school"],
                    ("PT" if side == "bat" else "BF"): 0}
            rows.append({"season": target, "team_id": tid, "player_id": pid,
                         "canonical_id": pid, "side": side, "name": name or "?",
                         "pos": r["position"], "class_last": None, "is_incoming": True,
                         "from_team_id": (dest[0] if dest else None),
                         "sort_val": -1e9, "proj": proj})
            seen_ids.add((tid, pid, side))
            n_tr += 1
    print(f"  + {n_fr} incoming freshmen, {n_tr} stat-less transfers (no_data roster rows)")


def proj_pt(hist, a, b, c):
    s = {int(r["season"]): r["wt_n"] for _, r in hist.iterrows()}
    return a * s.get(TARGET - 1, 0) + b * s.get(TARGET - 2, 0) + c


# Stats to stretch to the realistically-achievable distribution, with the SQL
# expression for their actual 2026 values (per level). Deliberate product choice
# (Nate): rank by the model's skill read, but scale to what players actually do
# every year so the best hitter projects ~.400, etc. Keeps the projection mean
# and ranking; only widens the spread (never compresses) and clamps to the
# achievable 2nd–98th percentile.
# Every projected rate is mapped to its OWN league-level actual distribution, so
# each stat is calibrated to that level's run environment (NWAC HR/9 != NAIA HR/9,
# etc.) AND de-compressed to a realistic spread. The model's projection only sets
# each player's RANK within his level; the map sets the absolute value from what
# players at that level actually do. hr_pa's rank comes from demonstrated ISO (set
# in the line build) so small-sample power doesn't inflate; OBP/wOBA map directly
# (reconstructing them from the slash systematically understated both).
# Map only the INDEPENDENT skills to each level's actual distribution. The
# DEPENDENT stats (OBP, wOBA, SLG, WHIP, Opp AVG) are DERIVED from these so they
# stay internally consistent — mapping them on their own broke the relationships
# (e.g. a 3% walk hitter showing OBP 110 pts over his AVG).
BAT_ACHIEVE = {"AVG": "batting_avg", "iso": "iso",
               "hr_pa": "home_runs::float/NULLIF(plate_appearances,0)",
               "k_pct": "k_pct", "bb_pct": "bb_pct",
               # wOBAcon (contact quality) is a repeatable skill (YoY r .50) but was
               # left out of the map, so its spread got squeezed to ~63% of real.
               # Map it like the other contact/power skills to keep its full spread.
               "wobacon": "wobacon"}
# K%, BB%, and HR-per-BF are the independent skills mapped per level. FIP is NOT
# mapped independently — it's RECONSTRUCTED from the mapped K%/BB%/HR (so it always
# matches the displayed components); WHIP and Opp AVG are derived the same way.
PIT_ACHIEVE = {"K_pct": "k_pct", "BB_pct": "bb_pct",
               "HR_bf": "home_runs_allowed::float / NULLIF(batters_faced,0)"}

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
            ("pit", "pitching_stats", "batters_faced", 60,
             {**PIT_ACHIEVE, "ERA": "era", "WHIP": "whip"})]:
        for key, expr in specs.items():
            cur.execute(f"""SELECT d.level lvl, ({expr})::float x
                FROM {tbl} b JOIN teams t ON t.id=b.team_id
                JOIN conferences c ON c.id=t.conference_id JOIN divisions d ON d.id=c.division_id
                WHERE b.season=2026 AND b.{idc}>=%s AND ({expr}) IS NOT NULL""", (mn,))
            tmp = {}
            for r in cur.fetchall():
                tmp.setdefault(r["lvl"], []).append(float(r["x"]))
            for lvl, vals in tmp.items():
                # ERA/WHIP are derived OUTCOME stats whose actual distribution has a
                # garbage high tail — a 60-BF arm shelled for a 20+ ERA isn't a real
                # talent level, but it inflates the winsorized ceiling so bad projected
                # arms map up to absurd 17 ERAs. Drop the unrealistic high end (the LOW
                # end, the sub-2 floor Nate cares about, is kept).
                if key in ("ERA", "WHIP"):
                    cap = 11.0 if key == "ERA" else 2.6
                    vals = [v for v in vals if 0 < v <= cap]
                if len(vals) >= 8:
                    out[(side, lvl, key)] = np.array(sorted(vals))
    # Per-level ELITE-STARTER ERA floor: the 5th-pctile ERA among actual BF>=200
    # arms (real starters/long men, not small-sample relievers). The lowest ERAs in
    # any league belong to short relievers; a workhorse starter's realistic best is
    # far higher (2026 NAIA: only ONE BF>=200 arm was sub-2, p5 = 2.87; JUCO wood-bat
    # p5 = 1.87, genuinely sub-2). Pass 3 floors projected starters here so no team
    # projects a sub-2 starter in a league whose starters never throw one.
    cur.execute("""SELECT d.level lvl, ps.era::float e FROM pitching_stats ps
        JOIN teams t ON t.id=ps.team_id JOIN conferences c ON c.id=t.conference_id
        JOIN divisions d ON d.id=c.division_id
        WHERE ps.season=2026 AND ps.batters_faced>=200 AND ps.era IS NOT NULL AND ps.era>0""")
    sp = {}
    for r in cur.fetchall():
        sp.setdefault(r["lvl"], []).append(r["e"])
    for lvl, vals in sp.items():
        if len(vals) >= 8:
            out[("pit", lvl, "ERA_SP_FLOOR")] = float(np.quantile(vals, 0.05))
    return out


def _quantile_map(proj_vals, target_arr):
    """Map each projected value to the actual distribution at its rank-percentile.
    Freak protection is on the TARGET (winsorize the actual distribution to its
    [2,98] band so a 60-BF fluke at the literal max can't be a mapping target),
    NOT on the rank — the old version squeezed ranks into [0.03,0.97], which
    clipped a legitimately #2-ranked, well-sampled returner down to the 96th-pctile
    value (an NWAC ace's elite K% pulled toward the middle). Now a true elite rank
    reaches a real elite (but de-freaked) value."""
    n = len(proj_vals)
    order = np.argsort(np.argsort(proj_vals))
    lo, hi = np.quantile(target_arr, 0.02), np.quantile(target_arr, 0.98)
    clean = np.clip(target_arr, lo, hi)
    return [float(np.quantile(clean, (order[i] + 0.5) / n)) for i in range(n)]


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


def add_breakout(rows):
    """Flag players the model expects to break out because last year sold them
    short. Hitters: a real sample, unlucky BABIP, and a big projected wOBA jump to
    a strong level. Pitchers: 2026 ERA well above their 2026 FIP (unlucky run
    prevention) and a big projected ERA improvement to a good level. Consumes the
    stashed _-prefixed 2026 signals."""
    for r in rows:
        p = r["proj"]
        n = p.pop("_n", 0) or 0
        bo = False
        if r["side"] == "bat":
            w26 = p.pop("_w26", None); bb26 = p.pop("_bb26", None)
            woba = p.get("wOBA")
            if (not p.get("insufficient") and not p.get("no_data") and n >= 50
                    and w26 is not None and woba is not None
                    and woba - w26 >= 0.025 and woba >= 0.335 and (bb26 is None or bb26 < 0.320)):
                bo = True
        else:
            e26 = p.pop("_e26", None); f26 = p.pop("_f26", None); era = p.get("ERA")
            if (not p.get("insufficient") and not p.get("no_data") and n >= 30
                    and e26 is not None and era is not None
                    and e26 - era >= 0.7 and era <= 4.3 and f26 is not None and e26 - f26 >= 0.4):
                bo = True
        if bo:
            p["breakout"] = True


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

# Skill-ranked playing-time trickle. The best regular plays ~95% of games, then a
# slow trickle down the lineup; bench plays much less. (Nate's spec.)
HIT_TRICKLE = [0.95, 0.92, 0.87, 0.83, 0.79, 0.74, 0.69, 0.63, 0.57]
# Pitchers: a level's weekend rotation size, then everyone else is a reliever.
SP_COUNT = {"D1": 4, "D2": 4, "NAIA": 4, "D3": 3, "JUCO": 4}
# Starter IP trickle (× the level's top-starter IP): ace -> #4. Reliever trickle
# is a separate, smaller curve led by the workhorse/closer.
SP_TRICKLE = [1.00, 0.90, 0.80, 0.70, 0.55]
RP_TRICKLE = [0.45, 0.38, 0.32, 0.27, 0.22, 0.18, 0.15, 0.12, 0.09, 0.07, 0.05]


def load_prior_workload(cur, season):
    """canonical_id -> player's actual IP in `season` (notation-corrected, so
    6.2 reads as 6.667 not 6.2). Used to anchor a returner's projected workload
    to the role he already held, instead of re-deciding it from quality alone."""
    cur.execute("""
        WITH canon AS (SELECT linked_id AS pid, canonical_id AS cid FROM player_links)
        SELECT COALESCE(c.cid, p.player_id) AS cid,
               SUM(FLOOR(p.innings_pitched)
                   + (p.innings_pitched - FLOOR(p.innings_pitched)) * 10/3.0) AS ip
        FROM pitching_stats p LEFT JOIN canon c ON c.pid = p.player_id
        WHERE p.season = %s GROUP BY 1
    """, (season,))
    return {r["cid"]: float(r["ip"] or 0) for r in cur.fetchall()}


def load_prior_pa(cur, season):
    """canonical_id -> player's actual PA in `season`. Anchors a returning hitter's
    projected playing time to the role he already held, so a returning everyday bat
    and a part-timer don't both snap to the same league cap."""
    cur.execute("""
        WITH canon AS (SELECT linked_id AS pid, canonical_id AS cid FROM player_links)
        SELECT COALESCE(c.cid, b.player_id) AS cid, SUM(b.plate_appearances) AS pa
        FROM batting_stats b LEFT JOIN canon c ON c.pid = b.player_id
        WHERE b.season = %s GROUP BY 1
    """, (season,))
    return {r["cid"]: float(r["pa"] or 0) for r in cur.fetchall()}


def load_prior_starts(cur, season):
    """canonical_id -> (games_started, appearances) in `season`. Used to read a
    pitcher's ROLE: prior GS (did he start?) plus IP/G (does he go multiple innings,
    so could stretch into a starter, or is he a one-inning reliever who shouldn't)."""
    cur.execute("""
        WITH canon AS (SELECT linked_id AS pid, canonical_id AS cid FROM player_links)
        SELECT COALESCE(c.cid, p.player_id) AS cid,
               SUM(COALESCE(p.games_started, 0)) AS gs,
               SUM(COALESCE(p.games, 0)) AS g
        FROM pitching_stats p LEFT JOIN canon c ON c.pid = p.player_id
        WHERE p.season = %s GROUP BY 1
    """, (season,))
    return {r["cid"]: (int(r["gs"] or 0), int(r["g"] or 0)) for r in cur.fetchall()}


def _level_quality(rows):
    """{(side, level): (mean, std)} of a quality metric among projected players
    (pitchers: -ERA, hitters: wOBA). Lets the allocators dock a low-quality
    returner's workload against his LEVEL, not just against his teammates."""
    acc = {}
    for r in rows:
        p = r["proj"]
        if p.get("no_data"):
            continue
        if r["side"] == "pit" and p.get("ERA") is not None:
            acc.setdefault(("pit", p["level"]), []).append(-float(p["ERA"]))
        elif r["side"] == "bat" and p.get("wOBA") is not None:
            acc.setdefault(("bat", p["level"]), []).append(float(p["wOBA"]))
    out = {}
    for k, a in acc.items():
        arr = np.array(a, dtype=float)
        out[k] = (float(arr.mean()), float(arr.std()) or 1e-9)
    return out


def allocate_hitter_pa(rows, workload, qlev, prior_pa):
    """Distribute each team's PA. Each returner gets the REALISTIC at-bats his
    depth-chart role + projected quality earn (a poor projected hitter is docked,
    not handed 150+ PA just to fill a thin lineup); incoming transfers are
    discounted into open spots. The at-bats the returning roster doesn't merit
    become an 'incoming freshmen & transfers' pool (returned per team) instead of
    being force-fed to returners. Returns {team_id: pool_pa}."""
    pools = {}
    by_team = {}
    for r in rows:
        if r["side"] == "bat":
            by_team.setdefault(r["team_id"], []).append(r)
    for tid, team_rows in by_team.items():
        players = []
        for r in team_rows:
            pg = r["proj"].get("pos_games") or {}
            if not pg:
                toks = [t.strip() for t in (r.get("pos") or "").upper().split("/") if t.strip()]
                pg = {t: 1 for t in toks}
            inc = bool(r.get("is_incoming"))
            players.append({"r": r, "woba": r["proj"].get("wOBA", 0) or 0, "games": pg,
                            # transfers' prior games count for less when claiming a
                            # job (NWAC reps != ready to start at the new level) and
                            # they must be clearly better to take a returner's at-bats.
                            "gmult": TRANS_PA_GAMES_MULT if inc else 1.0,
                            "wmult": TRANS_PA_WOBA_MULT if inc else 1.0})
        if not players:
            continue
        cg = lambda p, s: sum(p["games"].get(x, 0) for x in _SLOT_SRC[s]) * p["gmult"]
        primary, claimed = {}, {}
        claims = sorted(((p["games"].get(s, 0) * p["gmult"], p["woba"] * p["wmult"], i, s)
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
                             key=lambda k: (cg(players[k], s), players[k]["woba"] * players[k]["wmult"]), reverse=True)
            for k in backups:
                if rem <= 1e-6:
                    break
                t = min(cap[k], rem, _DC["BACKUP_MAX"])
                if t > 0:
                    alloc[k] += t; cap[k] -= t; rem -= t
        dh = 1.0
        for k in sorted(range(len(players)), key=lambda k: -players[k]["woba"] * players[k]["wmult"]):
            if dh <= 1e-6:
                break
            t = min(cap[k], dh, _DC["DH_MAX"])
            if t > 0:
                alloc[k] += t; cap[k] -= t; dh -= t
        for k in range(len(players)):
            if alloc[k] < _DC["FLOOR"]:
                alloc[k] = _DC["FLOOR"]
        lvl = players[0]["r"]["proj"]["level"]
        wl = workload.get(lvl) or {"pa": 1900, "pa_cap": 240}
        total = wl["pa"]; pcap = wl["pa_cap"]
        full_pa = pcap / HIT_TRICKLE[0]      # PA for a 100%-games player (rank 0 ~= pcap)
        # SKILL-RANKED TRICKLE: the depth chart decides who starts (positions), then
        # the lineup's PA trickles down by projected quality — best regular ~95% of
        # games, next 92%, 87%, ... bench gets a small share. Catchers capped lower.
        regulars = sorted((k for k in range(len(players)) if alloc[k] >= 0.5),
                          key=lambda k: players[k]["woba"] * players[k]["wmult"], reverse=True)
        bench = [k for k in range(len(players)) if alloc[k] < 0.5]
        poscap = lambda k: 0.72 if primary.get(k) == "C" else 1.0
        qm, qs = qlev.get(("bat", lvl), (0.0, 1e-9))
        merit = [0.0] * len(players)
        for rank, k in enumerate(regulars):
            gf = HIT_TRICKLE[rank] if rank < len(HIT_TRICKLE) else max(0.45 - 0.04 * (rank - len(HIT_TRICKLE) + 1), 0.28)
            # SOFT cap: scale the games fraction DOWN by level-relative quality (capped
            # at 1.0 so only a truly elite bat reaches the ceiling) so PA spreads instead
            # of every team's leadoff man landing on the exact same max — an average
            # regular plays a bit fewer games, a weak one fewer still.
            wob = players[k]["r"]["proj"].get("wOBA")
            z = ((wob - qm) / qs) if wob is not None else 0.0
            qmult = min(1.0, max(0.80, 0.95 + 0.06 * z))
            base = min(poscap(k), gf * qmult) * full_pa
            # anchor a RETURNING regular to his real prior PA (both directions, slight
            # role growth) so an established everyday bat and a part-timer don't both
            # snap to the league cap. Incoming bats have no prior PA here -> base only.
            cid = players[k]["r"]["canonical_id"]
            ppa = prior_pa.get(cid, 0.0)
            if ppa > 0 and not players[k]["r"].get("is_incoming"):
                merit[k] = 0.5 * base + 0.5 * min(poscap(k) * full_pa, ppa * 1.08)
            else:
                merit[k] = base
        for k in bench:
            merit[k] = min(poscap(k), 0.40 * alloc[k] + 0.05) * full_pa
        sm = sum(merit)
        pool = 0.0
        if sm > total:                       # deep returning roster -> scale to fit
            sc = total / sm
            merit = [m * sc for m in merit]
        else:                                # thin roster -> remainder to incoming pool
            pool = total - sm
        for k, p in enumerate(players):
            r = p["r"]
            pa = round(merit[k])
            if r["proj"].get("insufficient"):
                pa = min(pa, 45)
            r["proj"]["PT"] = pa
        pools[tid] = pool
    return pools


def allocate_pitcher_ip(rows, workload, prior_ip, prior_starts, qlev):
    """Distribute each team's innings as a STARTING ROTATION + a BULLPEN. The top
    SP_COUNT[level] arms by starter-score (level-relative quality + a bonus for a
    proven prior starter) form the rotation: the ace gets ~the level's top-starter
    IP, trickling down by skill. Everyone else is a reliever on a separate, smaller
    trickle led by the workhorse/closer. Returning starters/relievers are anchored
    so a proven arm isn't cut below his role; transfers are talent-ranked but
    discounted. Leftover innings become an incoming pool. Returns {team_id: pool}."""
    pools = {}
    by_team = {}
    for r in rows:
        if r["side"] == "pit":
            by_team.setdefault(r["team_id"], []).append(r)
    for tid, team_rows in by_team.items():
        lvl = team_rows[0]["proj"]["level"]
        wl = workload.get(lvl)
        if not wl:
            continue
        ipbf = wl["ip_per_bf"]; cap = wl["ip_cap"]; total = wl["ip"]
        qm, qs = qlev.get(("pit", lvl), (0.0, 1e-9))
        n_sp = SP_COUNT.get(lvl, 4)
        gate = lambda z: 1.0 if z >= 0 else max(0.40, 1.0 + 0.45 * z)   # below-avg arms shed IP
        scored = []
        for i, r in enumerate(team_rows):
            era = r["proj"].get("ERA")
            q = -float(era) if era is not None else -float(r.get("sort_val") or 0)
            z = (q - qm) / qs                      # level-relative quality (higher=better)
            gs, g = prior_starts.get(r["canonical_id"], (0, 0))
            pi = prior_ip.get(r["canonical_id"], 0.0)
            ipg = (pi / g) if g >= 1 else None      # innings per appearance = role signal
            inc = bool(r.get("is_incoming"))
            proven_sp = (not inc) and gs >= 5
            # a CLEAR reliever (many appearances, ~no starts, almost always 1 inning)
            # should NOT be converted to a starter no matter how good — bench him in
            # the pen. A multi-inning swingman (IP/G >= 2.3) is a real conversion option.
            clear_rp = (not inc) and g >= 8 and gs < 3 and ipg is not None and ipg < 1.5
            swing = ipg is not None and ipg >= 2.3
            sp = z + (0.8 if proven_sp else 0.0) + (0.3 if swing else 0.0)
            scored.append({"i": i, "r": r, "z": z, "gs": gs, "pi": pi, "inc": inc,
                           "proven_sp": proven_sp, "eligible": not clear_rp, "sp": sp})
        # rotation = top n_sp among STARTER-ELIGIBLE arms (clear relievers excluded);
        # everyone else is a reliever.
        eligible = sorted([d for d in scored if d["eligible"]], key=lambda d: d["sp"], reverse=True)
        starters = eligible[:n_sp]
        sp_set = {d["i"] for d in starters}
        relievers = [d for d in scored if d["i"] not in sp_set]
        merit = [0.0] * len(team_rows)
        starters.sort(key=lambda d: d["z"], reverse=True)       # ace first
        for rank, d in enumerate(starters):
            # SOFT cap: scale the rotation IP by the arm's LEVEL-relative quality so
            # aces spread by skill instead of every one snapping to the p97 ceiling —
            # a strong staff's ace nears the cap, an average team's ace sits below it,
            # a weak arm sheds IP toward the incoming pool.
            qmult = min(1.0, max(0.40, 0.88 + 0.15 * d["z"]))
            base = (SP_TRICKLE[rank] if rank < len(SP_TRICKLE) else 0.45) * cap * qmult
            if d["inc"]:
                base *= TRANS_IP_DISCOUNT
            elif d["pi"] > 0:                          # returning arm: pull toward his
                # REAL prior workload (both directions, nudged for a returning starter
                # role) so history drives the IP and a proven workhorse can top the p97.
                anchor = min(cap * 1.12, d["pi"] * 1.08)
                wt = 0.55 if d["proven_sp"] else 0.30
                base = (1 - wt) * base + wt * anchor
            merit[d["i"]] = min(cap * 1.12, max(0.0, base))
        relievers.sort(key=lambda d: d["z"], reverse=True)      # best bullpen arm first
        for rank, d in enumerate(relievers):
            qmult = min(1.0, max(0.50, 0.92 + 0.12 * d["z"]))   # spread bullpen IP by quality
            base = (RP_TRICKLE[rank] if rank < len(RP_TRICKLE) else 0.04) * cap * qmult
            if d["inc"]:
                base *= TRANS_IP_DISCOUNT
            elif d["pi"] >= 15:                       # established role -> anchor (gated)
                base = max(base, min(cap, d["pi"] * gate(d["z"])))
            else:
                base *= gate(d["z"])
            merit[d["i"]] = base
        sm = sum(merit)
        pool = 0.0
        if sm > total:                             # deep, quality staff -> scale to fit
            sc = total / sm
            merit = [m * sc for m in merit]
        else:                                      # not enough quality -> rest to incoming pool
            pool = total - sm
        for k, r in enumerate(team_rows):
            ip = merit[k]
            if r["proj"].get("insufficient"):
                ip = min(ip, 12)
            r["proj"]["PT"] = round(ip / ipbf) if ipbf else round(ip / 0.217)
        pools[tid] = pool
    return pools


def _pool_row(tid, side, level, amount):
    """A synthetic roster row carrying the team's pooled incoming workload."""
    pid = (95_000_000 if side == "bat" else 96_000_000) + int(tid)
    proj = {"is_pool": True, "no_data": True, "level": level}
    proj["PT" if side == "bat" else "IP"] = amount
    return {"season": TARGET, "team_id": tid, "player_id": pid, "canonical_id": pid,
            "side": side, "name": "Incoming freshmen & transfers", "pos": None,
            "class_last": None, "is_incoming": True, "from_team_id": None,
            "sort_val": -2e9, "proj": proj}


def add_pool_rows(rows, pools_pa, pools_ip):
    """One row per team/side carrying the PA/IP the returning roster didn't merit
    -- the workload that goes to incoming freshmen & transfers we don't project
    individually. Keeps team totals realistic and visibly takes weight off
    returners on thin rosters."""
    lvl_by_team = {}
    for r in rows:
        lvl_by_team.setdefault(r["team_id"], r["proj"].get("level"))
    n = 0
    for tid, pa in pools_pa.items():
        if pa and pa >= 10:
            rows.append(_pool_row(tid, "bat", lvl_by_team.get(tid), round(pa)))
            n += 1
    for tid, ip in pools_ip.items():
        if ip and ip >= 8:
            rows.append(_pool_row(tid, "pit", lvl_by_team.get(tid), round(ip)))
            n += 1
    print(f"  + {n} incoming-pool workload rows")


def expand_to_achievable(rows, workload, run_coef):
    """Map each driver rate to its level's actual distribution (de-compress +
    calibrate per run environment), then reconstruct the slash/counts. Playing
    time (PA/IP) is already set by allocate_hitter_pa / allocate_pitcher_ip."""
    ip_per_bf = {lvl: w["ip_per_bf"] for lvl, w in workload.items()}
    with get_connection() as conn:
        cur = conn.cursor()
        tgt = _achievable_targets(cur)
        ptd = _pt_distributions(cur)
        # batting hand, for the handedness-directional park HR factor (LH pulls to
        # RF, RH to LF). Synthetic incoming ids (>=90M) simply won't match → None.
        cur.execute("SELECT id, bats FROM players WHERE id = ANY(%s)",
                    ([r["player_id"] for r in rows] or [0],))
        bats_by_pid = {r["id"]: r["bats"] for r in cur.fetchall()}
        # per-level HBP / SF / SH rates (per PA) — needed to DERIVE OBP and wOBA
        # consistently. College HBP is ~3% of PA (not the ~1% guessed before),
        # which is why reconstructed OBP/wOBA were ~20 pts low.
        cur.execute("""SELECT d.level lvl,
              AVG(b.hit_by_pitch::float/NULLIF(b.plate_appearances,0)) hbp,
              AVG(b.sacrifice_flies::float/NULLIF(b.plate_appearances,0)) sf,
              AVG(GREATEST(b.plate_appearances - b.at_bats - b.walks - b.hit_by_pitch - b.sacrifice_flies, 0)::float
                  / NULLIF(b.plate_appearances,0)) sh
            FROM batting_stats b JOIN teams t ON t.id=b.team_id
            JOIN conferences c ON c.id=t.conference_id JOIN divisions d ON d.id=c.division_id
            WHERE b.season=2026 AND b.plate_appearances>=100 GROUP BY 1""")
        bat_env = {r["lvl"]: {"hbp": float(r["hbp"] or 0.03), "sf": float(r["sf"] or 0.01),
                              "sh": float(r["sh"] or 0.012)} for r in cur.fetchall()}
    DEF_ENV = {"hbp": 0.030, "sf": 0.011, "sh": 0.012}
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
                proj_vals = [grp[i]["proj"][key] for i in idxs]
                # Park-sensitive skills (HR/ISO for hitters; HR-allowed/FIP for
                # pitchers) are DE-PARKED before ranking (so the rank reflects true
                # talent, not the home park) and RE-PARKED after the level map (so
                # the projection reflects the park he'll play in). De-park uses the
                # PRIOR park (a transfer's old yard), re-park the 2027 destination.
                def _park_factors(i):
                    r = grp[i]
                    pid, tid = r["player_id"], r["team_id"]
                    prior_tid = r.get("from_team_id") if r.get("is_incoming") else tid
                    if side == "bat":
                        bats = bats_by_pid.get(pid)
                        ap = r["proj"].get("p_airpull")
                        return (park.hr_mult(prior_tid or tid, bats, ap),
                                park.hr_mult(tid, bats, ap))
                    mf = park.pit_hr_mult if key == "HR_bf" else park.pit_fip_mult
                    return (mf(prior_tid or tid), mf(tid))

                park_key = (side == "bat" and key in ("iso", "hr_pa")) or \
                           (side == "pit" and key in ("HR_bf", "FIP"))
                if park_key:
                    facs = [_park_factors(i) for i in idxs]
                    deparked = [v / f[0] for v, f in zip(proj_vals, facs)]
                    mapped = _quantile_map(deparked, arr)
                    mapped = [m * f[1] for m, f in zip(mapped, facs)]
                    if key in ("iso", "HR_bf"):   # stamp the park factor once, for transparency
                        tag = "park_hr_mult" if side == "bat" else "park_run_mult"
                        for j, i in enumerate(idxs):
                            grp[i]["proj"][tag] = round(facs[j][1], 3)
                else:
                    mapped = _quantile_map(proj_vals, arr)
                # The achievable map exists to DE-COMPRESS (restore the spread that
                # regression removed) — push above-average guys up toward the real
                # high end, below-average guys down. It must NEVER pull a player back
                # TOWARD the mean past their own regressed projection. The [3,97]
                # freak-cap was doing exactly that to legit returners (an NWAC ace's
                # ~34% K% clipped to ~30%). Clamp so the map only moves a value away
                # from the level mean. A small-sample freak is unaffected: regression
                # already pulled his regressed value inward, so the cap still binds.
                mu = float(np.mean(arr))
                for j, i in enumerate(idxs):
                    v, m = proj_vals[j], mapped[j]
                    val = max(v, m) if v >= mu else min(v, m)
                    # Pull the de-compressed value halfway back toward the regressed one
                    # where the map over-stretches. AVG: SYMMETRIC — it's mostly luck and
                    # whole teams were projecting .350+. Pitcher peripherals (K%/BB%/HR):
                    # only on the BAD side (below-mean K%, above-mean BB%/HR), so a
                    # below-average arm isn't pushed to the league bottom and compounded
                    # into an absurd FIP (Hagler: real 6 FIP -> 9+), while ELITE arms keep
                    # their de-compressed edge (Marsalis stays ~35% K%).
                    bad_side = (key == "K_pct" and v < mu) or (key in ("BB_pct", "HR_bf") and v > mu)
                    if key == "AVG" or bad_side:
                        val = 0.5 * v + 0.5 * val
                    grp[i]["proj"][key] = round(val, 4)
    # achievable caps (99th pctile) for the reconstructed combo stats, per level
    # p90 caps: a double-max contact+power profile (.400 AVG AND elite ISO) is an
    # impossible combo, so cap the reconstructed SLG/wOBA at a great-but-real level.
    slg_cap = {lvl: float(np.quantile(tgt[("bat", lvl, "SLG")], 0.90))
               for (s, lvl, k) in tgt if s == "bat" and k == "SLG"}
    woba_cap = {lvl: float(np.quantile(tgt[("bat", lvl, "wOBA")], 0.90))
                for (s, lvl, k) in tgt if s == "bat" and k == "wOBA"}
    # --- reconstruct COUNTING stats from the (already level-mapped) rates ---
    # OBP, wOBA, SLG-inputs, WHIP, Opp AVG, HR-rate are all mapped per level above,
    # so here we only derive the counting line and keep the slash internally
    # consistent (SLG is recomputed from the actual reconstructed hits).
    for r in rows:
        p = r["proj"]; pt = p.get("PT", 0)
        if r["side"] == "bat":
            bb_pct = p.get("bb_pct", 0); avg = p.get("AVG", 0); iso = p.get("iso", 0)
            hr_pa = p.get("hr_pa", 0); k_pct = p.get("k_pct", 0)
            cap = slg_cap.get(p.get("level"))
            if cap is not None:
                iso = min(iso, max(0.0, cap - avg))
            env = bat_env.get(p.get("level"), DEF_ENV)
            hbp_pa, sf_pa, sh_pa = env["hbp"], env["sf"], env["sh"]
            ab = pt * max(0.4, 1 - bb_pct - hbp_pa - sf_pa - sh_pa)
            hr = hr_pa * pt
            h = avg * ab
            xb_bases = max(iso * ab, 3 * hr)               # ensure room for the HR (2B/3B>=0)
            non_hr_xb = max(xb_bases - 3 * hr, 0)          # 2B + 2*3B
            d3 = non_hr_xb * 0.06
            d2 = max(non_hr_xb - 2 * d3, 0)
            singles = max(h - d2 - d3 - hr, 0)
            bb = bb_pct * pt; hbp = hbp_pa * pt
            # SLG from the actual reconstructed bases, so the slash always adds up
            slg = (singles + 2 * d2 + 3 * d3 + 4 * hr) / ab if ab else 0
            # OBP and wOBA DERIVED from this same line (denominator AB+BB+HBP+SF =
            # PA minus sac bunts) so they always track AVG/BB%/HBP — a low-walk
            # hitter can't show a high OBP. HBP is the real ~3%/PA, not 1%.
            denom = pt * (1 - sh_pa)
            obp = (h + bb + hbp) / denom if denom else 0
            woba = ((_WBB * bb + _WHBP * hbp + _W1B * singles + _W2B * d2
                     + _W3B * d3 + _WHR * hr) / denom) if denom else 0
            wcap = woba_cap.get(p.get("level"))
            if wcap is not None:
                woba = min(woba, wcap)
            # ISO is DERIVED from the final slash (SLG - AVG) so the three always add
            # up — and so the capped/HR-reconstructed power is reflected in ISO too.
            p.update({"AB": round(ab), "H": round(h), "HR": round(hr, 1),
                      "2B": round(d2, 1), "3B": round(d3, 1), "BB": round(bb), "SO": round(k_pct * pt),
                      "R": round(pt * 0.16 * (obp / 0.360)), "RBI": round(pt * 0.15 * (slg / 0.420)),
                      "AVG": round(avg, 3), "OBP": round(obp, 3), "SLG": round(slg, 3),
                      "iso": round(max(0.0, slg - avg), 3), "wOBA": round(woba, 3)})
        else:
            ipbf = ip_per_bf.get(p.get("level"), IP_PER_BF)
            k = p.get("K_pct", 0) or 0; bb = p.get("BB_pct", 0) or 0
            babip = p.get("babip_against") or 0.31
            # HR rate can't realistically be 0 over a full season. A pitcher who
            # allowed 0 HR in a small 2026 sample (Joe Thornton: 0 HR in 30 IP)
            # ranks as the best HR-suppressor and the per-level map sends him to the
            # distribution's 0.0 floor (D1 has 0-HR qualified arms). Floor the mapped
            # HR_bf at half his FB%-based (xFIP-style) estimate so a fly-ball arm
            # always projects a believable HR rate. `hr_bf` (lowercase) is that
            # component value; it survives the map.
            hrb = max(p.get("HR_bf", 0) or 0, 0.5 * (p.get("hr_bf") or 0))
            p["HR_bf"] = round(hrb, 4)
            # FIP RECONSTRUCTED from the final (mapped) K%/BB%/HR via the run model, so
            # it always matches the displayed components instead of being mapped
            # independently to a bad extreme (Hagler: a real 6 FIP -> a mapped 9.3).
            fip_rate = run_coef[0] * k + run_coef[1] * bb + run_coef[2] * hrb + run_coef[3]
            p["FIP"] = round(min(9.5, max(1.5, fip_rate * 39.6)), 2)
            p["BF"] = round(pt)
            p["IP"] = to_ip_notation(pt * ipbf)           # baseball notation (.1=1/3)
            p["HR_allowed"] = round(hrb * pt, 1)
            p["HR9"] = round(hrb * 9 / ipbf, 2)
            # Opp AVG and WHIP DERIVED from K%, HR, BB%, and the regressed BABIP
            # (pitchers barely control BABIP), so they track the skills and each
            # other instead of being mapped independently.
            ab_frac = max(0.5, 1 - bb - 0.025)            # AB per BF (minus BB/HBP/sac)
            bip_frac = max(0.0, ab_frac - k - hrb)        # balls in play (not K/HR)
            h_frac = hrb + babip * bip_frac               # hits per BF
            p["opp_avg"] = round(min(0.40, max(0.15, h_frac / ab_frac)), 3)
            p["WHIP"] = round((h_frac + bb) / ipbf, 2)    # (H+BB) per IP
            # ERA SEED from FIP (skill) + the repeatable ~16% of a pitcher's career
            # ERA-FIP gap. This only ranks the pitcher; pass 3 below maps it to the
            # level's ACTUAL ERA distribution (so low-run/wood-bat environments where
            # arms systematically beat FIP get their real, lower ERAs).
            fip = p.get("FIP")
            if fip is not None:
                # career ERA - FIP, CLAMPED: a tiny-sample blow-up outing can poison
                # the career ERA-FIP average (Diego Gutierrez's was +178, projecting a
                # 33 ERA off a 5.04 FIP). The repeatable part of beating/trailing FIP is
                # small, so bound the gap to a sane ±3 runs before taking 16% of it.
                gap = max(-3.0, min(3.0, p.get("fip_luck") or 0.0))
                era = fip + 0.16 * gap
                p["ERA"] = round(era, 2)
                hw = band_half(p.get("reliability", 0.3), "pit")
                p["ERA_lo"] = round(era - hw, 2); p["ERA_hi"] = round(era + hw, 2)

    # --- pass 3: map the DERIVED ERA to each level's actual distribution,
    # WORKLOAD-AWARE. (WHIP is intentionally NOT mapped here — it stays derived from
    # K%/BB%/HR/BABIP above so BB% and WHIP always move together, per Nate.)
    # ERA is built from FIP (so it ranks arms by skill), but in low-run / wood-bat
    # environments (NWAC most of all) arms beat that estimate, so the achievable floor
    # sits below what FIP-anchoring produces. The catch: the lowest ERAs in any
    # league come from SMALL-SAMPLE RELIEVERS — a workhorse starter throws enough
    # innings that his ERA regresses most of the way back to his FIP (2026: |ERA-FIP|
    # shrinks 2.1 -> 0.9 from short relievers to 320+ BF starters, and the 320+ group
    # had ZERO sub-2 ERAs vs many among short relievers). So we map to the achievable
    # (reliever-reachable) value, then BLEND each arm back toward its FIP-anchored
    # seed by projected workload: a full-time reliever keeps the whole map move, a
    # workhorse starter keeps ~40% of it and lands near his FIP. Rank by skill (never
    # demonstrated ERA), regulars only (BF>=60).
    RP_BF, SP_BF, MAX_SHRINK = 100, 350, 0.58   # realize: 1.0 at <=100 BF -> 0.42 at >=350
    for level in {r["proj"]["level"] for r in rows if r["side"] == "pit"}:
        grp = [r for r in rows if r["side"] == "pit" and r["proj"]["level"] == level]
        for stat in ("ERA",):
            arr = tgt.get(("pit", level, stat))
            if arr is None:
                continue
            idxs = [i for i, r in enumerate(grp)
                    if r["proj"].get(stat) is not None and (r["proj"].get("BF") or 0) >= 60]
            if len(idxs) < 5:
                continue
            seeds = [grp[i]["proj"][stat] for i in idxs]
            mapped = _quantile_map(seeds, arr)
            sp_floor = tgt.get(("pit", level, "ERA_SP_FLOOR"))
            for j, i in enumerate(idxs):
                bf = grp[i]["proj"].get("BF") or 0
                sp_w = min(1.0, max(0.0, (bf - RP_BF) / (SP_BF - RP_BF)))
                realize = 1.0 - MAX_SHRINK * sp_w
                val = round(seeds[j] + realize * (mapped[j] - seeds[j]), 2)
                # A workhorse STARTER can't beat the level's elite-starter ERA floor —
                # the reliever-driven map floor isn't reachable over a full starter's
                # innings. Floor by workload: full starter gets the whole floor, a
                # reliever none, so wood-bat JUCO arms (sub-2 floor) stay free to dip.
                if sp_floor is not None and sp_w > 0 and val < sp_floor:
                    val = round(val + sp_w * (sp_floor - val), 2)
                grp[i]["proj"][stat] = val
                if stat == "ERA":
                    hw = band_half(grp[i]["proj"].get("reliability", 0.3), "pit")
                    grp[i]["proj"]["ERA_lo"] = round(max(0.0, val - hw), 2)
                    grp[i]["proj"]["ERA_hi"] = round(val + hw, 2)


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
        # Live transfer-portal membership now lives in the DB table (the Commitment
        # Editor writes here, not the legacy JSON) — anyone in it has left their
        # old team. Committed ones still reappear on the new team via `commits`.
        try:
            cur.execute("SELECT player_id FROM transfer_portal_members")
            for r in cur.fetchall():
                left.add(int(r["player_id"]))
        except Exception:
            pass
        # Returning-status tool: players manually marked 'departing' for the season
        # just played (transfer/quit/cut, often no known destination) — drop them
        # from the old roster like portal leavers.
        cur.execute(
            "SELECT player_id FROM player_returning_overrides WHERE season = %s AND status = 'departing'",
            (TARGET - 1,))
        for r in cur.fetchall():
            left.add(int(r["player_id"]))
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
            # skill-only anchors (single predictor each) blended 50/50 with the
            # track-record projection so a pitcher's strike% / whiff% genuinely
            # moves his BB% / K% (a strike-thrower is projected to walk fewer)
            # without a strong track record being overwritten.
            skill = {}
            if side == "pit":
                for tgt, preds in {"bb_pct": ["p_strike"], "k_pct": ["p_whiff"]}.items():
                    sp = fit_refine(df_feat[df_feat["wt_n"] >= FIT_MIN], tgt, preds, TARGET)
                    if sp:
                        skill[tgt] = sp

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
                # below ~10 PA / ~5 IP there isn't enough to project a real line —
                # flag it so the page shows "not enough data" (the player is still
                # listed with projected playing time).
                no_data = career_n < (10 if side == "bat" else 22)
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
                        "no_data": no_data, "class_2027": (CLASS_NEXT.get(cls) if cls else None)}
                # stash 2026 luck signals for the post-expand breakout check
                line["_n"] = career_n
                if side == "bat":
                    line["_w26"] = float(last["woba"]) if pd.notna(last["woba"]) else None
                    line["_bb26"] = float(last["babip"]) if pd.notna(last["babip"]) else None
                else:
                    line["_e26"] = float(last["era_rate"]) * 39.6 if pd.notna(last["era_rate"]) else None
                    lk, lbb, lhr = last["k_pct"], last["bb_pct"], last["hr_bf"]
                    line["_f26"] = ((run_coef[0]*lk + run_coef[1]*lbb + run_coef[2]*lhr + run_coef[3]) * 39.6
                                    if all(pd.notna(x) for x in (lk, lbb, lhr)) else None)
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
                    # K% from whiff/swing, BB% from swing/whiff (when PBP available).
                    # Both refines mean-revert, so (as on the pitcher side) pull the
                    # refined rate back toward the demonstrated/ballast base in
                    # proportion to reliability — a well-sampled elite-eye hitter
                    # (Katayama-Stall 17% BB% over 218 PA, rel .68) keeps his skill;
                    # a thin sample still leans on the refine.
                    if "k_pct" in refine:
                        kr = apply_refine(refine["k_pct"], proj, pbp_for)
                        if kr is not None:
                            kr = (1 - rel) * kr + rel * proj["k_pct"][0]
                            proj["k_pct"] = (max(0.03, min(0.45, kr)), proj["k_pct"][1])
                            line["k_pct"] = round(proj["k_pct"][0], 4)
                    if "bb_pct" in refine:
                        bbr = apply_refine(refine["bb_pct"], proj, pbp_for)
                        if bbr is not None:
                            bbr = (1 - rel) * bbr + rel * proj["bb_pct"][0]
                            proj["bb_pct"] = (max(0.01, min(0.25, bbr)), proj["bb_pct"][1])
                            line["bb_pct"] = round(proj["bb_pct"][0], 4)
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
                    iso_raw = (float(np.average(hh["iso"], weights=hh["wt_n"]))
                               if len(hh) else iso)
                    # regress demonstrated ISO toward league power by sample size,
                    # so a few HR in 20-30 PA don't project a masher's HR total.
                    iso_demo = (iso_raw * career_n + 0.130 * 120) / (career_n + 120)
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
                    # and K% from whiff/strike% (a whiff-getter strikes out more)
                    if "bb_pct" in refine:
                        bbr = apply_refine(refine["bb_pct"], proj, pbp_for)
                        if bbr is not None:
                            bb = max(0.02, min(0.25, bbr))
                    if "k_pct" in refine:
                        kr = apply_refine(refine["k_pct"], proj, pbp_for)
                        if kr is not None:
                            k = max(0.05, min(0.45, kr))
                    # blend the track-record rate 50/50 with the strike%/whiff%
                    # skill anchor, so command/stuff visibly move the projection
                    if "bb_pct" in skill:
                        bs = apply_refine(skill["bb_pct"], proj, pbp_for)
                        if bs is not None:
                            bb = max(0.02, min(0.25, 0.5 * bb + 0.5 * bs))
                    if "k_pct" in skill:
                        ks = apply_refine(skill["k_pct"], proj, pbp_for)
                        if ks is not None:
                            k = max(0.05, min(0.45, 0.5 * k + 0.5 * ks))
                    # Trust the DEMONSTRATED rate more the more data backs it. The
                    # refine + whiff/strike skill anchor each mean-revert hard, and
                    # stacked they over-regress well-sampled elite arms (Marsalis: a
                    # 37% K% over 89 IP got dragged to 24% before the achievable map).
                    # Pull back toward the track-record (ballast-regressed) rate in
                    # proportion to reliability, so a big reliable sample keeps its
                    # demonstrated rate; a thin sample still leans on the skill anchor.
                    # Applied to BOTH K% and BB% — elite control artists (Gutierrez,
                    # 0.6% BB% over 359 BF) were getting their walk rate inflated by
                    # the strike% anchor the same way K% was.
                    base_k = proj.get("k_pct", (k,))[0]
                    k = max(0.05, min(0.45, (1 - rel) * k + rel * base_k))
                    base_bb = proj.get("bb_pct", (bb,))[0]
                    bb = max(0.02, min(0.25, (1 - rel) * bb + rel * base_bb))
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

    with get_connection() as conn:
        cur = conn.cursor()
        workload = team_workload(cur)             # per-level team PA/IP + caps
        prior_ip = load_prior_workload(cur, TARGET - 1)   # returner 2026 innings
        prior_starts = load_prior_starts(cur, TARGET - 1) # returner 2026 GS + ERA
        prior_pa = load_prior_pa(cur, TARGET - 1)         # returner 2026 plate appearances
    qlev = _level_quality(rows)                   # per-level quality baselines (gate poor returners)
    pools_pa = allocate_hitter_pa(rows, workload, qlev, prior_pa)
    pools_ip = allocate_pitcher_ip(rows, workload, prior_ip, prior_starts, qlev)
    expand_to_achievable(rows, workload, run_coef)
    add_breakout(rows)
    add_war(rows, pos_fracs)
    # Roster-only incoming freshmen + stat-less transfers (no projection). Added
    # last so they never affect PT/IP allocation, WAR, or breakout above.
    add_incoming_no_data(rows, TARGET)
    # Pooled workload (PA/IP the returning roster didn't merit) -> incoming class.
    add_pool_rows(rows, pools_pa, pools_ip)

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
