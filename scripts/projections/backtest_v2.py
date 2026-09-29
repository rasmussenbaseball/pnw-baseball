"""Backtest the v2 engine against Marcel, repeat-last-season, league average
and the v1 core, on 2023-2026, using only pre-target data each year.

Scores (sample-weighted RMSE after rescaling every system to the realized
level environment): wOBA for hitters, ER/BF for pitchers, plus the components.
Also reports calibration slope (actual ~ projection; 1.0 = honest spread) and
P10-P90 coverage (target 80%).

  PYTHONPATH=backend python3 scripts/projections/backtest_v2.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "backend"))

from app.models.database import get_connection  # noqa: E402
import v2_engine as E  # noqa: E402
from backtest import (fit_training_constants, project_player, BAT_COMPONENTS,  # noqa: E402
                      PIT_COMPONENTS, quiet)

TARGETS = [2023, 2024, 2025, 2026]


def wrmse(a, b, w):
    a, b, w = map(np.asarray, (a, b, w))
    return float(np.sqrt(np.average((a - b) ** 2, weights=w)))


def rescale(df, col):
    for lv, g in df.groupby("level"):
        shift = np.average(g["actual"], weights=g["w"]) - np.average(g[col], weights=g["w"])
        df.loc[g.index, col] = g[col] + shift
    return df


def run_side(side, bat, pit, sbat, spit, pbp_b, pbp_p, bat_v1, pit_v1):
    df = bat if side == "bat" else pit
    sdf = sbat if side == "bat" else spit
    pbp = pbp_b if side == "bat" else pbp_p
    stats = E.BAT if side == "bat" else E.PIT
    headline = "woba" if side == "bat" else "er_rate"
    rows = []
    for T in TARGETS:
        C = E.fit_constants(bat, pit, sbat, spit, T)
        S = C[side]
        tc, sc = S["train_c"], S["summer_c"]
        refine = E.fit_refine(C, side, tc, pbp, T)
        # centered peripherals for season T-1
        plast = {}
        if pbp is not None and not pbp.empty:
            pv = pbp[pbp["season"] == T - 1].merge(tc[["pid", "season", "level"]].drop_duplicates(), on=["pid", "season"], how="inner")
            feats = E.PBP_BAT if side == "bat" else E.PBP_PIT
            for f in feats:
                if f in pv.columns:
                    mu = pv.groupby("level")[f].transform("mean")
                    pv[f + "_c"] = pv[f] - mu
            for _, r in pv.iterrows():
                plast[r["pid"]] = {f: r.get(f + "_c") for f in feats}
        hist_by = {pid: g for pid, g in tc.groupby("pid")}
        sum_by = {pid: g for pid, g in sc.groupby("pid")} if sc is not None and not sc.empty else {}
        # v1 constants (same training window)
        v1df = bat_v1 if side == "bat" else pit_v1
        C1 = quiet(fit_training_constants, v1df, BAT_COMPONENTS if side == "bat" else PIT_COMPONENTS, T)
        h1 = C1["train"].sort_values("wt_n", ascending=False).drop_duplicates(["pid", "season"])
        h1_by = {pid: g for pid, g in h1.groupby("pid")}
        div_avg_n = tc[tc["wt_n"] >= 40].groupby("level")["wt_n"].mean().to_dict()
        actual = df[(df["season"] == T) & (df["wt_n"] >= 40)].sort_values("wt_n", ascending=False).drop_duplicates("pid")
        run_coef = (E.fit_run_model_talent(tc, S["means"], S.get("drift"), S["ballast"]) if E.DRIFT
                    else E.fit_run_model(tc, S["means"])) if side == "pit" else None
        for _, a in actual.iterrows():
            pid, level = a["pid"], a["level"]
            lg = E.env_mean(S["means"], level, T - 1, headline)
            if lg is None or pd.isna(a[headline]):
                continue
            h = hist_by.get(pid)
            h = h[h["season"] < T] if h is not None else None
            had = h is not None and len(h) > 0
            rec = {"pid": pid, "level": level, "season": T, "actual": float(a[headline]), "w": float(a["wt_n"]),
                   "had": had, "changed": bool(had and h.sort_values("season").iloc[-1]["level"] != level),
                   "lgavg": lg, "hist_n": float(h["wt_n"].sum()) if had else 0.0}
            rec["juco_up"] = bool(had and h.sort_values("season").iloc[-1]["level"] == "JUCO" and level != "JUCO")
            last_cls = h.sort_values("season").iloc[-1]["cls"] if had else None
            last_cls = last_cls if isinstance(last_cls, str) else None
            # repeat
            rec["repeat"] = float(h.sort_values("season").iloc[-1][headline]) if had and pd.notna(h.sort_values("season").iloc[-1][headline]) else lg
            # marcel
            num = den = 0.0
            if had:
                for _, r in h.iterrows():
                    back = T - int(r["season"])
                    if back in E.RECENCY and pd.notna(r[headline]):
                        num += E.RECENCY[back] * r["wt_n"] * r[headline]; den += E.RECENCY[back] * r["wt_n"]
            K = 2 * div_avg_n.get(level, 150); eff = den / 5.0
            rec["marcel"] = (num / 5.0 + K * lg) / (eff + K) if eff + K > 0 else lg
            # v1 core
            h1 = h1_by.get(pid); h1 = h1[h1["season"] < T] if h1 is not None else None
            v1_head = "era_rate" if headline == "er_rate" else headline
            if h1 is not None and len(h1):
                cls1 = h1.sort_values("season").iloc[-1]["cls"]
                p1 = project_player(h1, [], C1, [v1_head], level, T, cls1 if isinstance(cls1, str) else None)
                rec["v1"] = p1.get(v1_head, (lg, 0))[0]
            else:
                rec["v1"] = lg
            # v2
            sh = sum_by.get(pid); sh = sh[sh["season"] < T] if sh is not None else None
            pr = E.project(C, side, h if had else tc.iloc[0:0], sh, plast.get(pid), level, T, last_cls,
                           dest_team_id=a["team_id"], refine=refine)
            if side == "bat":
                comp = {s: pr[s]["value"] for s in stats if pr[s]["value"] is not None}
                if all(k in comp for k in ("k_pct", "bb_pct", "hr_pa", "iso", "babip")):
                    rc = E.reconstruct_bat(comp)
                    rec["v2"] = rc["wOBA"]
                else:
                    rec["v2"] = pr["woba"]["value"] if pr["woba"]["value"] is not None else lg
                rec["v2_direct"] = pr["woba"]["value"] if pr["woba"]["value"] is not None else lg
                sd = pr["woba"]["sd"]
                for s in ("k_pct", "bb_pct", "iso", "babip", "hr_pa"):
                    rec[f"v2_{s}"] = pr[s]["value"]; rec[f"act_{s}"] = float(a[s]) if pd.notna(a[s]) else np.nan
                    rec[f"rep_{s}"] = float(h.sort_values("season").iloc[-1][s]) if had and pd.notna(h.sort_values("season").iloc[-1][s]) else np.nan
            else:
                comp = {s: pr[s]["value"] for s in stats if pr[s]["value"] is not None}
                if all(k in comp for k in ("k_pct", "bb_pct", "hr_bf", "babip_against")):
                    rc = E.reconstruct_pit(comp, run_coef, 0.22)
                    rec["v2"] = rc["er_rate"]
                else:
                    rec["v2"] = pr["er_rate"]["value"] if pr["er_rate"]["value"] is not None else lg
                rec["v2_direct"] = pr["er_rate"]["value"] if pr["er_rate"]["value"] is not None else lg
                sd = pr["er_rate"]["sd"]
                for s in ("k_pct", "bb_pct", "hr_bf", "babip_against"):
                    rec[f"v2_{s}"] = pr[s]["value"]; rec[f"act_{s}"] = float(a[s]) if pd.notna(a[s]) else np.nan
                    rec[f"rep_{s}"] = float(h.sort_values("season").iloc[-1][s]) if had and pd.notna(h.sort_values("season").iloc[-1][s]) else np.nan
            # outcome band: posterior sd of talent + sampling noise at the realized n
            ev = E.samp_var({headline: rec["v2"]}, headline)
            rec["sd_out"] = float(np.sqrt(sd ** 2 + ev / max(a["wt_n"], 1)))
            rec["rel"] = pr[headline]["rel"]
            rows.append(rec)
    res = pd.DataFrame(rows)
    systems = ["lgavg", "repeat", "marcel", "v1", "v2", "v2_direct"]
    for s in systems:
        res = rescale(res, s)

    def report(mask, name):
        g = res[mask]
        if len(g) < 20:
            return
        sc = {s: wrmse(g[s], g["actual"], g["w"]) for s in systems}
        print(f"  {name:<30} n={len(g):>5}  " + "  ".join(f"{s}={sc[s]:.4f}" for s in systems) + f"   best={min(sc, key=sc.get)}")

    print(f"\n=== {side.upper()} : {headline} sample-weighted RMSE ===")
    report(res["had"], "returning players")
    report(res["had"] & ~res["changed"], "  same level")
    report(res["had"] & res["changed"], "  level changers")
    report(res["had"] & res["juco_up"], "  JUCO -> 4yr")
    report(res["had"] & (res["hist_n"] < 100), "  thin history (<100)")
    report(res["had"] & (res["hist_n"] >= 300), "  deep history (>=300)")
    report(~res["had"], "no history")
    report(res.index >= 0, "everyone")
    for T in TARGETS:
        report((res["season"] == T) & res["had"], f"  returning {T}")
    # calibration slope + coverage (returning players, v2 reconstructed)
    g = res[res["had"]]
    for s in ("v2", "v1", "marcel"):
        x = g[s] - g["lgavg"]; y = g["actual"] - g["lgavg"]; w = g["w"]
        mx, my = np.average(x, weights=w), np.average(y, weights=w)
        slope = np.average((x - mx) * (y - my), weights=w) / max(np.average((x - mx) ** 2, weights=w), 1e-12)
        print(f"  calibration slope {s:<7}: {slope:.2f}  (proj sd {np.sqrt(np.average((x-mx)**2, weights=w)):.4f} vs actual sd {np.sqrt(np.average((y-my)**2, weights=w)):.4f})")
    z = 1.2816
    inside = ((g["actual"] >= g["v2"] - z * g["sd_out"]) & (g["actual"] <= g["v2"] + z * g["sd_out"]))
    print(f"  P10-P90 coverage (v2): {np.average(inside, weights=g['w'])*100:.1f}% (target 80%)")
    mult = float(np.sqrt(np.average((g["actual"] - g["v2"]) ** 2, weights=g["w"]) / np.average(g["sd_out"] ** 2, weights=g["w"])))
    inside2 = ((g["actual"] >= g["v2"] - z * mult * g["sd_out"]) & (g["actual"] <= g["v2"] + z * mult * g["sd_out"]))
    print(f"  implied band multiplier: {mult:.2f} -> coverage {np.average(inside2, weights=g['w'])*100:.1f}%")
    # components
    comps = ["k_pct", "bb_pct", "iso", "babip"] if side == "bat" else ["k_pct", "bb_pct"]
    print("  components (returning players): RMSE v2 vs repeat-last")
    for s in comps:
        gg = g.dropna(subset=[f"v2_{s}", f"act_{s}", f"rep_{s}"])
        print(f"    {s:<8} v2={wrmse(gg[f'v2_{s}'], gg[f'act_{s}'], gg['w']):.4f}  repeat={wrmse(gg[f'rep_{s}'], gg[f'act_{s}'], gg['w']):.4f}")
    return res


def main():
    with get_connection() as conn:
        cur = conn.cursor()
        bat, pit = E.load_spring(cur, min_n=1)
        sbat, spit = E.load_summer(cur)
        pbp_b, pbp_p = E.load_pbp(cur)
        from derive_constants import load_batting, load_pitching
        bat_v1 = load_batting(cur); pit_v1 = load_pitching(cur)
    # v2 offsets summary for the last fit
    C = E.fit_constants(bat, pit, sbat, spit, 2027)
    for side in ("bat", "pit"):
        print(f"\n=== {side} level offsets (lift to D1, centered units) ===")
        for s, d in C[side]["offsets"].items():
            print(f"  {s:<14} " + "  ".join(f"{lv}={v:+.4f}" for lv, v in d.items()))
        print(f"=== {side} talent drift (AR1 phi, persistent var tau2, season-effect var) ===")
        for st, d in C[side].get("drift", {}).items():
            print(f"  {st:<14} phi={d['phi']:.2f}  gamma={d.get('gamma', 0):.1f}  tau2={d['tau2']:.5f}  sig_s2={d['sig_s2']:.5f}  share persistent={d['tau2']/(d['tau2']+d['sig_s2']):.2f}  internal mse {d.get('mse', 0):.6f} vs constant-talent {d.get('mse_const', 0) or 0:.6f}")
        Sg = C[side].get("talent_cov")
        if Sg is not None:
            comps = E.JOINT_COMPS[side]; d = np.sqrt(np.diag(Sg))
            print(f"=== {side} talent correlations (joint shrinkage) ===")
            for i, a in enumerate(comps):
                print(f"  {a:<14} " + " ".join(f"{Sg[i, j] / (d[i] * d[j]):+.2f}" for j in range(len(comps))))
        print(f"=== {side} ballasts (ALL) ===")
        for (lv, s), b in C[side]["ballast"].items():
            if lv == "ALL":
                print(f"  {s:<14} M={b['M']:>6.0f}  sd_true={b['sd_true']:.4f}  n={b['n']}")
    out = []
    for side in ("bat", "pit"):
        out.append(run_side(side, bat, pit, sbat, spit, pbp_b, pbp_p, bat_v1, pit_v1).assign(side=side))
    import os
    dest = os.getenv("V2_OUT") or str(Path(__file__).resolve().parent / "backtest_v2_results.csv")
    pd.concat(out).to_csv(dest, index=False)


if __name__ == "__main__":
    main()
