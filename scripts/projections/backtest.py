"""Backtest harness for player projections.

For each target season T (2023..2026):
  - fit all constants (league means, class-tier offsets, reliability ballasts,
    aging deltas, level translations) on seasons < T ONLY — no peeking
  - project every batter/pitcher who actually played in T using only
    their pre-T history (spring all divisions + linked summer ball)
  - score projections against actuals: sample-weighted RMSE on wOBA
    (batting) and ER/BF (pitching), after rescaling every system to the
    realized division environment (standard practice — we grade player
    evaluation, not run-environment guessing)

Systems compared:
  lgavg   — everyone projects to their division mean (floor)
  repeat  — repeat your last season's rate
  marcel  — Marcel transplanted: 5/4/3 weights, ballast = 2x division avg
            sample, regress to division mean, no translations/aging
  nwbb_v1 — component model: level translations + summer ball + class-tier
            regression targets + fitted per-stat ballasts + aging deltas

Run from repo root:
  PYTHONPATH=backend python3 scripts/projections/backtest.py
"""
import contextlib
import io
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.models.database import get_connection  # noqa: E402
from derive_constants import (  # noqa: E402
    BAT_STATS, PIT_STATS, MIN_PA, MIN_BF,
    load_batting, load_pitching, league_means, center, make_pairs,
    reliability, aging, translations,
)

TARGET_SEASONS = [2023, 2024, 2025, 2026]
RECENCY = {1: 5.0, 2: 4.0, 3: 3.0}     # seasons back -> weight
SUMMER_RECENCY_MULT = 0.6              # summer season weight vs its spring slot
CLASS_NEXT = {"Fr": "So", "So": "Jr", "Jr": "Sr", "Sr": "Sr+", "Sr+": "Sr+"}

BAT_COMPONENTS = ["k_pct", "bb_pct", "iso", "babip", "hr_pa", "woba", "avg", "obp"]
PIT_COMPONENTS = ["k_pct", "bb_pct", "hr_bf", "babip_against", "whip_rate", "era_rate"]


def quiet(fn, *args, **kwargs):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        return fn(*args, **kwargs)


def fit_training_constants(df, stats, max_season):
    """Fit everything on seasons < max_season."""
    train = df[df["season"] < max_season].copy()
    means = league_means(train, stats)
    train_c = center(train, stats, means)
    pairs = make_pairs(train_c, same_level=True)
    rel = quiet(reliability, pairs, stats, "")
    ag = quiet(aging, pairs, stats, "")
    trans = quiet(translations, train_c, stats, means, "", ag)
    # class-tier offsets: PA-weighted mean of centered stat by (level, class)
    tier = {}
    t = train_c.dropna(subset=["cls"])
    for (level, cls), g in t.groupby(["level", "cls"]):
        if len(g) < 30:
            continue
        tier[f"{level}|{cls}"] = {
            s: {"off": float(np.average(g[f"{s}_c"].dropna(),
                                        weights=g.loc[g[f"{s}_c"].dropna().index, "wt_n"])),
                "n": int(g[f"{s}_c"].notna().sum())}
            for s in stats if g[f"{s}_c"].notna().sum() >= 30
        }
    return {"means": means, "rel": rel, "aging": ag, "trans": trans,
            "tier": tier, "train": train}


def env_mean(C, level, target_season, stat):
    """Best available environment estimate for (level, stat) at target time:
    most recent training season's league mean."""
    for back in range(1, 6):
        key = f"{level}|{target_season - back}"
        if key in C["means"] and C["means"][key].get(stat) is not None:
            return C["means"][key][stat]
    return None


TRANS_SHRINK_N = 40   # trust a translation factor ~n/(n+40)
TIER_SHRINK_N = 80    # trust a class-tier offset ~n_cell/(n_cell+80)
CROSS_LEVEL_DISCOUNT = 0.6   # a translated season is worth less than a same-level one


def translation_delta(C, from_level, to_level, stat):
    if from_level == to_level:
        return 0.0
    d = C["trans"].get(f"{from_level}->{to_level}")
    if d is None and from_level == "JUCO":
        d = C["trans"].get("JUCO->4YR")
    if d and isinstance(d.get(stat), dict):
        n = d[stat].get("n", 0)
        return d[stat]["aging_corrected"] * (n / (n + TRANS_SHRINK_N))
    return 0.0


def ballast(C, level, stat, default=200):
    for key in (level, "ALL"):
        v = C["rel"].get(key, {}).get(stat)
        if v:
            return max(v["ballast"], 10)
    return default


def aging_delta(C, cls_now, stat):
    """Delta for the transition the player is about to make."""
    if not cls_now:
        return 0.0
    tr = f"{cls_now}->{CLASS_NEXT.get(cls_now, '?')}"
    d = C["aging"].get(tr, {})
    return d.get(stat, 0.0) or 0.0


def project_player(history, summer_history, C, stats, target_level,
                   target_season, cls_last):
    """nwbb_v1: per-component weighted average of translated history,
    regressed to a class-tiered division mean, plus an aging step.
    Returns dict stat -> (projection, reliability_weight)."""
    out = {}
    next_cls = CLASS_NEXT.get(cls_last) if cls_last else None
    for s in stats:
        num, den = 0.0, 0.0
        for _, row in history.iterrows():
            back = target_season - row["season"]
            if back not in RECENCY or pd.isna(row[s]):
                continue
            v = row[s] + translation_delta(C, row["level"], target_level, s)
            w = RECENCY[back] * row["wt_n"]
            if row["level"] != target_level:
                w *= CROSS_LEVEL_DISCOUNT
            num += w * v
            den += w
        for srow in summer_history:
            back = target_season - srow["season"]   # summer year Y sits before spring Y+1
            if back not in RECENCY or s not in srow or pd.isna(srow.get(s)):
                continue
            v = srow[s] + srow.get(f"{s}_to_spring_delta", 0.0)
            w = RECENCY[back] * SUMMER_RECENCY_MULT * srow["wt_n"]
            num += w * v
            den += w
        lg = env_mean(C, target_level, target_season, s)
        if lg is None:
            continue
        tier_off = 0.0
        tier_cls = next_cls or cls_last
        if tier_cls:
            cell = C["tier"].get(f"{target_level}|{tier_cls}", {}).get(s)
            if cell:
                tier_off = cell["off"] * (cell["n"] / (cell["n"] + TIER_SHRINK_N))
        target_mean = lg + tier_off
        K = ballast(C, target_level, s)
        # scale recency-weighted sample back to raw-sample units for the ballast
        eff_n = den / RECENCY[1]
        proj = (num / RECENCY[1] + K * target_mean) / (eff_n + K) if (eff_n + K) > 0 else target_mean
        proj += aging_delta(C, cls_last, s) * (eff_n / (eff_n + K))
        out[s] = (proj, eff_n / (eff_n + K))
    return out


def load_summer_batting(cur):
    """Summer batting seasons keyed to the spring player's canonical id."""
    cur.execute("""
        WITH canon AS (SELECT linked_id AS player_id, canonical_id FROM player_links)
        SELECT COALESCE(c.canonical_id, l.spring_player_id) AS pid,
               sb.season,
               sb.plate_appearances AS pa, sb.at_bats AS ab,
               sb.doubles AS d2, sb.triples AS d3, sb.home_runs AS hr,
               sb.walks AS bb, sb.strikeouts AS k, sb.woba
        FROM summer_player_links l
        JOIN summer_batting_stats sb ON sb.player_id = l.summer_player_id
        LEFT JOIN canon c ON c.player_id = l.spring_player_id
        WHERE sb.plate_appearances >= 40
    """)
    df = pd.DataFrame(cur.fetchall())
    if df.empty:
        return df
    for col in df.columns:
        if col != "pid":
            df[col] = pd.to_numeric(df[col], errors="coerce")
    df["k_pct"] = df["k"] / df["pa"]
    df["bb_pct"] = df["bb"] / df["pa"]
    df["iso"] = (df["d2"] + 2 * df["d3"] + 3 * df["hr"]) / df["ab"].clip(lower=1)
    df["wt_n"] = df["pa"]
    return df


def wrmse(pred, actual, w):
    pred, actual, w = map(np.asarray, (pred, actual, w))
    return float(np.sqrt(np.average((pred - actual) ** 2, weights=w)))


def rescale_to_env(rows, value_key):
    """Shift each (division) group so its weighted projected mean matches the
    realized weighted actual mean — applied identically to all systems."""
    df = pd.DataFrame(rows)
    for level, g in df.groupby("level"):
        shift = (np.average(g["actual"], weights=g["w"]) -
                 np.average(g[value_key], weights=g["w"]))
        df.loc[g.index, value_key] = g[value_key] + shift
    return df


def backtest_side(df, summer_df, stats, headline, label):
    """Run the full backtest for one side (batting or pitching)."""
    print(f"\n{'#' * 70}\n# {label} — headline stat: {headline}\n{'#' * 70}")
    all_rows = []
    for T in TARGET_SEASONS:
        C = fit_training_constants(df, stats, T)
        train = C["train"]
        # one history table lookup: biggest sample per (pid, season)
        hist = train.sort_values("wt_n", ascending=False).drop_duplicates(["pid", "season"])
        hist_by_pid = dict(tuple(hist.groupby("pid")))
        summer_by_pid = {}
        if summer_df is not None and not summer_df.empty:
            sdeltas = {}
            # summer->next-spring deltas fit on training years only
            strain = summer_df[summer_df["season"] < T - 1]
            for s in ("k_pct", "bb_pct", "iso", "woba"):
                merged = strain.merge(
                    hist[["pid", "season", s, "wt_n"]],
                    left_on=["pid"], right_on=["pid"], suffixes=("", "_spr"))
                merged = merged[merged["season_spr"] == merged["season"] + 1]
                merged = merged.dropna(subset=[s, f"{s}_spr"])
                if len(merged) >= 25:
                    w = 2 / (1 / merged["wt_n"] + 1 / merged["wt_n_spr"])
                    sdeltas[s] = float(np.average(
                        merged[f"{s}_spr"] - merged[s], weights=w))
            for pid, g in summer_df[summer_df["season"] < T].groupby("pid"):
                rows = []
                for _, r in g.iterrows():
                    d = {"season": int(r["season"]), "wt_n": float(r["wt_n"])}
                    for s in ("k_pct", "bb_pct", "iso", "woba"):
                        if s in r and pd.notna(r[s]):
                            d[s] = float(r[s])
                            d[f"{s}_to_spring_delta"] = sdeltas.get(s, 0.0)
                    rows.append(d)
                summer_by_pid[pid] = rows

        actual = df[(df["season"] == T)].sort_values("wt_n", ascending=False)
        actual = actual.drop_duplicates(["pid"])
        div_avg_n = train.groupby("level")["wt_n"].mean().to_dict()

        for _, row in actual.iterrows():
            pid, level = row["pid"], row["level"]
            h = hist_by_pid.get(pid)
            h = h[h["season"] < T] if h is not None else None
            had_history = h is not None and len(h) > 0
            lg = env_mean(C, level, T, headline)
            if lg is None or pd.isna(row[headline]):
                continue
            rec = {"pid": pid, "level": level, "season": T,
                   "actual": float(row[headline]), "w": float(row["wt_n"]),
                   "had_history": had_history,
                   "changed_level": bool(had_history and h.iloc[-1]["level"] != level)}

            rec["lgavg"] = lg

            if had_history:
                last = h.sort_values("season").iloc[-1]
                rec["repeat"] = float(last[headline]) if pd.notna(last[headline]) else lg
            else:
                rec["repeat"] = lg

            # marcel: 5/4/3 raw, ballast 2x division avg sample, division mean
            num, den = 0.0, 0.0
            if had_history:
                for _, hr_ in h.iterrows():
                    back = T - hr_["season"]
                    if back in RECENCY and pd.notna(hr_[headline]):
                        num += RECENCY[back] * hr_["wt_n"] * hr_[headline]
                        den += RECENCY[back] * hr_["wt_n"]
            K = 2 * div_avg_n.get(level, 150)
            eff = den / RECENCY[1]
            rec["marcel"] = (num / RECENCY[1] + K * lg) / (eff + K) if eff + K > 0 else lg

            # nwbb_v1
            cls_last = None
            if had_history:
                hsort = h.sort_values("season")
                cls_last = hsort.iloc[-1]["cls"]
            proj = project_player(
                h if had_history else pd.DataFrame(columns=df.columns),
                summer_by_pid.get(pid, []), C, [headline], level, T, cls_last)
            rec["nwbb_v1"] = proj.get(headline, (lg, 0.0))[0]
            rec["reliability"] = proj.get(headline, (lg, 0.0))[1]
            all_rows.append(rec)

    res = pd.DataFrame(all_rows)
    systems = ["lgavg", "repeat", "marcel", "nwbb_v1"]
    for sys_ in systems:
        res = rescale_to_env(res.to_dict("records"), sys_)

    def report(mask, name):
        g = res[mask]
        if len(g) < 20:
            return
        scores = {s: wrmse(g[s], g["actual"], g["w"]) for s in systems}
        best = min(scores, key=scores.get)
        line = "  ".join(f"{s}={scores[s]:.4f}" for s in systems)
        print(f"  {name:<28} n={len(g):>4}  {line}   best={best}")

    print(f"\nSample-weighted RMSE on {headline} (lower = better):")
    report(res["had_history"], "returning players")
    report(res["had_history"] & res["changed_level"], "level changers")
    report(res["had_history"] & ~res["changed_level"], "same-level returners")
    report(~res["had_history"], "no history (floor check)")
    report(res.index >= 0, "everyone")
    for T in TARGET_SEASONS:
        report((res["season"] == T) & res["had_history"], f"  returning, {T}")
    return res


def main():
    with get_connection() as conn:
        cur = conn.cursor()
        bat = load_batting(cur)
        pit = load_pitching(cur)
        summer_bat = load_summer_batting(cur)
    bat_res = backtest_side(bat, summer_bat, BAT_COMPONENTS, "woba", "BATTING")
    pit_res = backtest_side(pit, None, PIT_COMPONENTS, "era_rate", "PITCHING")
    out = Path(__file__).resolve().parent / "backtest_results.csv"
    pd.concat([bat_res.assign(side="bat"), pit_res.assign(side="pit")]).to_csv(out, index=False)
    print(f"\nWrote per-player results to {out}")


if __name__ == "__main__":
    main()
