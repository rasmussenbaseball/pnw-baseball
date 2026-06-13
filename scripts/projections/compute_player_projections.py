"""Produce player projections for an upcoming season (default: 2027).

Uses the nwbb_v1p model validated in backtest.py:
  - per-component weighted history (5/4/3 recency), level translations with
    sample-size shrinkage, cross-level weight discount, summer-ball seasons
    at reduced weight with wood-bat corrections
  - regression to class-tiered division means with ballasts fit from our
    own year-over-year data
  - class-transition aging step
  - PBP peripheral adjustments (whiff%, GB%, air-pull% / strike%) with
    sign priors, applied when fit on enough training pairs
  - P10/P50/P90 bands from sigma(reliability) curves calibrated on
    backtest residuals (19.2% bat / 18.1% pit outside band vs 20% target)

Players are projected at their most recent level/team; transfers will be
re-leveled when new rosters are scraped.

Writes scripts/projections/player_projections_<season>.csv. NO database
writes — output is for review until the site integration ships.

Run from repo root:
  PYTHONPATH=backend python3 scripts/projections/compute_player_projections.py [--season 2027]
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.models.database import get_connection  # noqa: E402
from backtest import (  # noqa: E402
    BAT_COMPONENTS, PIT_COMPONENTS, PERIPH_FEATS, PERIPH_SIGNS, RECENCY,
    fit_training_constants, fit_peripheral_betas, center_peripherals,
    load_pbp_peripherals, load_summer_batting, project_player, env_mean,
)
from derive_constants import load_batting, load_pitching  # noqa: E402

# sigma(reliability) fit on backtest residuals 2023-2026 (see project notes)
SIGMA = {"bat": (0.0580, -0.0081), "pit": (0.0517, -0.0275)}
Z10 = 1.2816  # 10th/90th percentile z


def build_summer_lookup(summer_df, max_season):
    """Summer history rows per pid with wood-bat -> spring corrections fit
    on seasons before max_season."""
    out = {}
    if summer_df is None or summer_df.empty:
        return out
    for pid, g in summer_df[summer_df["season"] < max_season].groupby("pid"):
        rows = []
        for _, r in g.iterrows():
            d = {"season": int(r["season"]), "wt_n": float(r["wt_n"])}
            for s in ("k_pct", "bb_pct", "iso", "woba"):
                if s in r and pd.notna(r[s]):
                    d[s] = float(r[s])
            rows.append(d)
        out[pid] = rows
    return out


def project_side(df, summer_df, components, headline, side, target, cur):
    C = fit_training_constants(df, components, target)
    feats = PERIPH_FEATS[side]
    fit = fit_peripheral_betas(C["train_c"], C, headline, feats, target,
                               signs=PERIPH_SIGNS[side])
    betas = fit[0] if fit else {}
    if betas:
        print(f"  peripheral betas active: " +
              ", ".join(f"{f}={b:+.4f} (n={n})" for f, (b, n) in betas.items()))

    hist = C["train"].sort_values("wt_n", ascending=False).drop_duplicates(["pid", "season"])
    summer_lookup = build_summer_lookup(summer_df, target)
    periph_lookup = {}
    if f"{feats[0]}_c" in df.columns:
        prev = df[df["season"] == target - 1]
        for _, r in prev.iterrows():
            periph_lookup[r["pid"]] = {f: r.get(f"{f}_c") for f in feats}

    # project everyone with a qualified season in the last two years
    recent = hist[hist["season"].isin([target - 1, target - 2])]
    pids = recent.sort_values("season").drop_duplicates("pid", keep="last")

    a_sig, b_sig = SIGMA[side]
    rows = []
    for _, last in pids.iterrows():
        pid, level = last["pid"], last["level"]
        h = hist[(hist["pid"] == pid) & (hist["season"] < target)]
        cls_last = h.sort_values("season").iloc[-1]["cls"]
        proj = project_player(h, summer_lookup.get(pid, []), C, components,
                              level, target, cls_last)
        if headline not in proj:
            continue
        head_val, rel = proj[headline]
        adj = 0.0
        for f, (b, _n) in betas.items():
            v = periph_lookup.get(pid, {}).get(f)
            if v is not None and pd.notna(v):
                adj += b * v
        head_val += adj
        sigma = max(a_sig + b_sig * rel, 0.015)
        row = {
            "player_id": int(last["raw_pid"]), "canonical_id": int(pid),
            "level": level, "season": target, "class_last": cls_last,
            "last_season": int(last["season"]), "last_n": int(last["wt_n"]),
            "reliability": round(rel, 3),
            f"proj_{headline}": round(head_val, 4),
            f"proj_{headline}_p10": round(head_val - Z10 * sigma, 4),
            f"proj_{headline}_p90": round(head_val + Z10 * sigma, 4),
            "periph_adj": round(adj, 4),
        }
        for s in components:
            if s != headline and s in proj:
                row[f"proj_{s}"] = round(proj[s][0], 4)
        rows.append(row)

    out = pd.DataFrame(rows)
    # readable names/teams
    cur.execute("""
        SELECT p.id, p.first_name || ' ' || p.last_name AS name,
               t.short_name AS team
        FROM players p JOIN teams t ON t.id = p.team_id
        WHERE p.id = ANY(%s)
    """, ([int(x) for x in out["player_id"]],))
    names = pd.DataFrame(cur.fetchall())
    out = out.merge(names, left_on="player_id", right_on="id", how="left").drop(columns=["id"])
    front = ["name", "team", "level", "class_last", "reliability"]
    out = out[front + [c for c in out.columns if c not in front]]
    return out.sort_values(f"proj_{headline}", ascending=(side == "pit"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2027)
    args = ap.parse_args()
    T = args.season

    with get_connection() as conn:
        cur = conn.cursor()
        print("Loading data…")
        bat = load_batting(cur)
        pit = load_pitching(cur)
        summer_bat = load_summer_batting(cur)
        bat_periph = load_pbp_peripherals(cur, "bat")
        pit_periph = load_pbp_peripherals(cur, "pit")
        if not bat_periph.empty:
            bat = bat.merge(bat_periph, on=["pid", "season"], how="left")
            bat["p_n"] = bat["p_n"].fillna(0)
            bat = center_peripherals(bat, PERIPH_FEATS["bat"])
        if not pit_periph.empty:
            pit = pit.merge(pit_periph, on=["pid", "season"], how="left")
            pit["p_n"] = pit["p_n"].fillna(0)
            pit = center_peripherals(pit, PERIPH_FEATS["pit"])

        print(f"Projecting batting, {T}…")
        bat_out = project_side(bat, summer_bat, BAT_COMPONENTS, "woba", "bat", T, cur)
        print(f"  {len(bat_out)} batters projected")
        print(f"Projecting pitching, {T}…")
        pit_out = project_side(pit, None, PIT_COMPONENTS, "era_rate", "pit", T, cur)
        print(f"  {len(pit_out)} pitchers projected")

    out_dir = Path(__file__).resolve().parent
    bat_path = out_dir / f"player_projections_{T}_batting.csv"
    pit_path = out_dir / f"player_projections_{T}_pitching.csv"
    bat_out.to_csv(bat_path, index=False)
    pit_out.to_csv(pit_path, index=False)
    print(f"\nWrote {bat_path}\nWrote {pit_path}")

    for label, frame, col in [("BATTING (proj wOBA)", bat_out, "proj_woba"),
                              ("PITCHING (proj ER/BF, lower=better)", pit_out, "proj_era_rate")]:
        print(f"\nTop 10 — {label}")
        cols = ["name", "team", "level", "class_last", "reliability",
                col, f"{col}_p10", f"{col}_p90"]
        print(frame.head(10)[cols].to_string(index=False))


if __name__ == "__main__":
    main()
