"""Project a full team roster's 2027 lines -- hitters AND pitchers -- with the
complete projected stat set and the year-over-year change vs 2026.

The core product: pull up a current team and see every returning player's
projected line for next season, plus how each stat is projected to move from
last year. Returning = played for the team in 2026 with eligibility left
(graduating Sr/Gr excluded).

Rate stats come from the validated nwbb_v1 component model. Counting stats use
the fitted playing-time models. Pitch-level stats (whiff%, GB%, ... ) are
projected by regressing the player's career PBP rate toward the league mean by
sample size -- shown only where we have PBP coverage.

Usage:
  PYTHONPATH=backend python3 scripts/projections/team_projection.py "Bushnell" [--pbp]
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.models.database import get_connection  # noqa: E402
from derive_constants import load_batting, load_pitching  # noqa: E402
from backtest import (  # noqa: E402
    BAT_COMPONENTS, PIT_COMPONENTS, PERIPH_FEATS, fit_training_constants,
    project_player, center_peripherals, load_pbp_peripherals, load_summer_batting,
)
from compute_player_projections import SIGMA, Z10, build_summer_lookup  # noqa: E402

TARGET = 2027
PA_A, PA_B, PA_C = 0.454, 0.023, 96.8     # fitted PA model (R^2 .22)
BF_A, BF_B, BF_C = 0.538, -0.027, 101.2   # fitted BF model (R^2 .22)
GRADUATING = {"Sr", "Sr+", "Gr", "5th"}
# PBP display stats: (regression ballast in pitches/BIP). Career rate is
# regressed toward the league mean by sample size, then shown with delta.
HIT_PBP = {"p_whiff": 200, "p_gb": 70, "p_airpull": 70}
PIT_PBP = {"p_whiff": 200, "p_gb": 70, "p_strike": 150}
PBP_LABEL = {"p_whiff": "Whiff%", "p_gb": "GB%", "p_airpull": "AirPull%", "p_strike": "Strike%"}


def proj_pt(hist, a, b, c):
    s = {int(r["season"]): r["wt_n"] for _, r in hist.iterrows()}
    return a * s.get(TARGET - 1, 0) + b * s.get(TARGET - 2, 0) + c


def pbp_projection(periph_raw, feats_ballast):
    """Per-pid career PBP rate, regressed to league mean by sample, + the 2026
    value for the delta. Returns {pid: {feat: (proj, last)}}."""
    lg = {f: np.average(periph_raw[f].dropna(),
                        weights=periph_raw.loc[periph_raw[f].dropna().index, "p_n"])
          for f in feats_ballast if periph_raw[f].notna().any()}
    out = {}
    for pid, g in periph_raw.groupby("pid"):
        d = {}
        for f, K in feats_ballast.items():
            gg = g.dropna(subset=[f])
            if gg.empty or f not in lg:
                continue
            n = gg["p_n"].sum()
            career = np.average(gg[f], weights=gg["p_n"])
            proj = (career * n + lg[f] * K) / (n + K)
            last = gg[gg["season"] == TARGET - 1]
            last_v = float(last[f].iloc[0]) if not last.empty else None
            d[f] = (proj, last_v)
        if d:
            out[pid] = d
    return out


def delta(proj, last, pct=True):
    if last is None:
        return ""
    dv = proj - last
    return f" ({dv:+.3f})" if not pct else f" ({dv*100:+.1f})"


def project_side(team, side):
    load_fn = load_batting if side == "bat" else load_pitching
    comps = BAT_COMPONENTS if side == "bat" else PIT_COMPONENTS
    headline = "woba" if side == "bat" else "era_rate"
    pa_args = (PA_A, PA_B, PA_C) if side == "bat" else (BF_A, BF_B, BF_C)
    pbp_feats = HIT_PBP if side == "bat" else PIT_PBP
    stat_tbl = "batting_stats" if side == "bat" else "pitching_stats"

    with get_connection() as conn:
        cur = conn.cursor()
        df = load_fn(cur)
        summer = load_summer_batting(cur) if side == "bat" else None
        periph_raw = load_pbp_peripherals(cur, side)
        periph_c = periph_raw.copy()
        df_feat = df.merge(periph_raw, on=["pid", "season"], how="left")
        df_feat["p_n"] = df_feat["p_n"].fillna(0)
        df_feat = center_peripherals(df_feat, PERIPH_FEATS[side])
        C = fit_training_constants(df_feat, comps, TARGET)
        hist_all = C["train"].sort_values("wt_n", ascending=False).drop_duplicates(["pid", "season"])
        summer_lookup = build_summer_lookup(summer, TARGET) if side == "bat" else {}
        pbp_proj = pbp_projection(periph_raw, pbp_feats)

        idcol = "plate_appearances" if side == "bat" else "batters_faced"
        cur.execute(f"""
            SELECT COALESCE(c.canonical_id, b.player_id) AS cid,
                   p.first_name||' '||p.last_name AS name, p.position AS pos,
                   ps.year_in_school AS cls26
            FROM {stat_tbl} b
            JOIN teams t ON t.id = b.team_id
            JOIN players p ON p.id = b.player_id
            LEFT JOIN player_links c ON c.linked_id = b.player_id
            LEFT JOIN player_seasons ps ON ps.player_id=b.player_id AND ps.season=2026
            WHERE b.season=2026 AND lower(t.short_name)=lower(%s) AND b.{idcol} >= 20
        """, (team,))
        roster = cur.fetchall()

    a_sig, b_sig = SIGMA[side]
    out = []
    for r in roster:
        cid = r["cid"]
        h = hist_all[(hist_all["pid"] == cid) & (hist_all["season"] < TARGET)]
        if h.empty:
            continue
        last = h.sort_values("season").iloc[-1]
        if last["cls"] in GRADUATING:
            continue
        proj = project_player(h, summer_lookup.get(cid, []), C, comps, last["level"], TARGET, last["cls"])
        if headline not in proj:
            continue
        head, rel = proj[headline]
        pt = proj_pt(h, *pa_args)
        last26 = h[h["season"] == 2026]
        last26 = last26.iloc[0] if not last26.empty else None
        sigma = max(a_sig + b_sig * rel, 0.015)
        row = {"name": r["name"], "pos": r["pos"], "cls26": r["cls26"], "rel": round(rel, 2)}
        if side == "bat":
            bb, k, hr, avg, iso, obp = (proj.get(s, (0, 0))[0] for s in
                                        ["bb_pct", "k_pct", "hr_pa", "avg", "iso", "obp"])
            row.update({"PA": round(pt), "AVG": f"{avg:.3f}", "OBP": f"{obp:.3f}",
                        "SLG": f"{avg+iso:.3f}", "HR": round(hr*pt, 1),
                        "K%": f"{k:.3f}", "BB%": f"{bb:.3f}", "wOBA": f"{head:.3f}",
                        "wOBA_rng": f"{head-Z10*sigma:.3f}-{head+Z10*sigma:.3f}"})
        else:
            era = head * 39.6  # ER/BF -> ~ERA
            k, bb = proj.get("k_pct", (0, 0))[0], proj.get("bb_pct", (0, 0))[0]
            row.update({"BF": round(pt), "ERA~": f"{era:.2f}", "K%": f"{k:.3f}",
                        "BB%": f"{bb:.3f}",
                        "ERA_rng": f"{(head-Z10*sigma)*39.6:.2f}-{(head+Z10*sigma)*39.6:.2f}"})
        # PBP projected stats + delta vs 2026
        pp = pbp_proj.get(cid, {})
        for f in pbp_feats:
            if f in pp:
                pv, lv = pp[f]
                row[PBP_LABEL[f]] = f"{pv*100:.0f}{delta(pv, lv)}"
            else:
                row[PBP_LABEL[f]] = "-"
        out.append((head, row))
    out.sort(key=lambda x: x[0], reverse=(side == "bat"))
    return [r for _, r in out]


def main():
    team = sys.argv[1] if len(sys.argv) > 1 else "Bushnell"
    hitters = project_side(team, "bat")
    pitchers = project_side(team, "pit")

    print(f"\n{'='*70}\n{team} — 2027 PROJECTED HITTERS (returning)\n{'='*70}")
    if hitters:
        cols = ["name", "pos", "cls26", "PA", "AVG", "OBP", "SLG", "HR", "K%", "BB%",
                "wOBA", "Whiff%", "GB%", "AirPull%", "rel"]
        print(pd.DataFrame(hitters)[cols].to_string(index=False))
    print(f"\n{'='*70}\n{team} — 2027 PROJECTED PITCHERS (returning)\n{'='*70}")
    if pitchers:
        cols = ["name", "pos", "cls26", "BF", "ERA~", "K%", "BB%", "Whiff%", "GB%",
                "Strike%", "rel"]
        print(pd.DataFrame(pitchers)[cols].to_string(index=False))
    print("\nPBP stats show projected value (× vs 2026 change in parens); '-' = no PBP coverage.")


if __name__ == "__main__":
    main()
