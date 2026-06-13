"""Project a full team roster's 2027 lines -- hitters AND pitchers -- with the
complete projected stat set (counting + rate), year-over-year deltas, and
projected pitch-level stats.

Model pieces (all backtest-validated unless noted):
  - rate stats from the nwbb_v1 component model (weighted history, tiered
    regression, class aging, level translations)
  - PITCHER run projection = 50/50 blend of FIP-reconstruction (from projected
    K%/BB%/HR, the stable stuff) and direct ERA. Beats direct ERA in backtest
    (.0417 vs .0425) -- this is the "great FIP, middling ERA -> project up" fix.
  - PBP stats (Whiff%, GB%, AirPull%/Strike%) regressed toward league mean with
    DATA-FIT ballasts (whiff is sticky -> light regression; GB heavy), plus a
    small youth-development nudge.
  - counting stats from fitted playing-time models + the player's career
    extra-base mix.

Returning = played for the team in 2026 with eligibility left (Sr/Gr excluded).

Usage:
  PYTHONPATH=backend python3 scripts/projections/team_projection.py "Bushnell"
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
    BAT_COMPONENTS, PIT_COMPONENTS, PERIPH_FEATS, CLASS_NEXT, RECENCY, fit_training_constants,
    project_player, center_peripherals, load_pbp_peripherals, load_summer_batting,
)
from compute_player_projections import SIGMA, Z10, build_summer_lookup  # noqa: E402

TARGET = 2027
# Playing time: weight last season heavily with a small floor, so established
# roles hold and marginal guys DON'T balloon to 30+ IP / a full-time PA load.
PA_A, PA_B, PA_C = 0.65, 0.05, 30.0
BF_A, BF_B, BF_C = 0.65, 0.05, 30.0
GRADUATING = {"Sr", "Sr+", "Gr", "5th"}
FIP_BLEND = 0.5    # weight on FIP-reconstruction vs direct ERA (backtest-best)
# PBP signature-skill ballasts (pitches-seen units). Kept LOW: strike%, whiff%,
# GB% are stable signature traits (a sinkerballer stays a sinkerballer); the
# raw YoY reliability looked low only because narrative-derived tags are noisy,
# so we trust the player's own level and barely regress these. (sign = youth
# development nudge direction.)
HIT_PBP = {"p_whiff": (120, 0), "p_gb": (200, 0), "p_airpull": (160, +1)}
PIT_PBP = {"p_whiff": (170, +1), "p_gb": (220, 0), "p_strike": (160, +1)}
YOUTH_NUDGE = {"Fr": 0.004, "So": 0.006, "Jr": 0.002, "Sr": 0.0}  # per-stat, applied * sign
PBP_LABEL = {"p_whiff": "Whiff%", "p_gb": "GB%", "p_airpull": "AirPull%", "p_strike": "Strike%"}


def proj_pt(hist, a, b, c):
    s = {int(r["season"]): r["wt_n"] for _, r in hist.iterrows()}
    return a * s.get(TARGET - 1, 0) + b * s.get(TARGET - 2, 0) + c


def fit_run_estimator(pit):
    """ER/BF ~ K% + BB% + HR/BF (the FIP-style run weights), on pre-target data."""
    f = pit[pit["season"] < TARGET].dropna(subset=["era_rate", "k_pct", "bb_pct", "hr_bf"])
    X = np.column_stack([f.k_pct, f.bb_pct, f.hr_bf, np.ones(len(f))])
    coef, *_ = np.linalg.lstsq(X, f.era_rate.to_numpy(), rcond=None)
    return coef


def pbp_projection(periph_raw, feats, cls_last, anchors=None):
    """Per-pid PBP rate regressed toward an anchor by sample (data-fit ballast),
    plus a youth nudge. Each season is weighted by recency (5/4/3) AND sample
    (pitches), matching the core model -- so a tiny cameo season barely counts.
    The regression anchor defaults to the league mean, but `anchors[pid][feat]`
    overrides it with a TALENT-appropriate target (e.g. a power arm's whiff
    regresses toward a K%-implied whiff, not the scrub average -- the Courtney
    fix). Returns {pid:{feat:(proj,last)}}."""
    anchors = anchors or {}
    lg = {f: np.average(periph_raw[f].dropna(),
                        weights=periph_raw.loc[periph_raw[f].dropna().index, "p_n"])
          for f in feats if periph_raw[f].notna().any()}
    out = {}
    for pid, g in periph_raw.groupby("pid"):
        d = {}
        for f, (K, sign) in feats.items():
            gg = g.dropna(subset=[f]).copy()
            if gg.empty or f not in lg:
                continue
            gg["w"] = gg.apply(lambda r: RECENCY.get(TARGET - int(r["season"]), 2.0) * r["p_n"], axis=1)
            eff_n = gg["w"].sum() / RECENCY[1]
            career = np.average(gg[f], weights=gg["w"])
            anchor = anchors.get(pid, {}).get(f, lg[f])
            proj = (career * eff_n + anchor * K) / (eff_n + K)
            if sign:
                proj += sign * YOUTH_NUDGE.get(cls_last.get(pid, "Sr"), 0.0)
            last = gg[gg["season"] == TARGET - 1]
            d[f] = (proj, float(last[f].iloc[0]) if not last.empty else None)
        if d:
            out[pid] = d
    return out


# Pitcher whiff regresses toward a K%-implied target (whiff = a + b*K%), so a
# power arm anchors to a power-arm whiff, not the global mean. Fit from data
# (whiff = 0.047 + 0.759*K%); a tie on RMSE but far more sensible than the mean.
WHIFF_FROM_K = (0.047, 0.759)


def load_fip_luck(cur):
    """{canonical_id: BF-weighted career (ERA - FIP)}. Negative => persistently
    beats FIP (run-prevention skill / luck); positive => underperforms FIP
    (unlucky -> rebound candidate). BF-weighted so tiny cameos don't distort."""
    cur.execute("""
        WITH canon AS (SELECT linked_id pid, canonical_id cid FROM player_links)
        SELECT COALESCE(c.cid, ps.player_id) cid, ps.batters_faced bf,
               ps.era::float era, ps.fip::float fip
        FROM pitching_stats ps LEFT JOIN canon c ON c.pid = ps.player_id
        WHERE ps.batters_faced >= 50 AND ps.era IS NOT NULL AND ps.fip IS NOT NULL
    """)
    rows = {}
    for r in cur.fetchall():
        rows.setdefault(r["cid"], []).append((r["bf"], r["era"] - r["fip"]))
    out = {}
    for cid, lst in rows.items():
        w = sum(bf for bf, _ in lst)
        out[cid] = sum(bf * g for bf, g in lst) / w if w else None
    return out


def fmt_delta(proj, last):
    return f"{proj*100:.0f}" + (f"({(proj-last)*100:+.0f})" if last is not None else "")


def career_xbh_mix(bat, cid):
    g = bat[bat["pid"] == cid]
    d2, d3, hr = g["d2"].sum(), g["d3"].sum(), g["hr"].sum()
    tot = d2 + d3 + hr
    if tot < 5:
        return 0.78, 0.06, 0.16   # league-ish 2B/3B/HR shares of XBH
    return d2 / tot, d3 / tot, hr / tot


def main():
    team = sys.argv[1] if len(sys.argv) > 1 else "Bushnell"
    with get_connection() as conn:
        cur = conn.cursor()
        bat = load_batting(cur)
        pit = load_pitching(cur)
        summer = load_summer_batting(cur)
        bat_p = load_pbp_peripherals(cur, "bat")
        pit_p = load_pbp_peripherals(cur, "pit")
        run_coef = fit_run_estimator(pit)
        fip_luck = load_fip_luck(cur)

        rosters = {}
        for side, tbl, idc in [("bat", "batting_stats", "plate_appearances"),
                               ("pit", "pitching_stats", "batters_faced")]:
            cur.execute(f"""
                SELECT COALESCE(c.canonical_id,b.player_id) cid,
                       p.first_name||' '||p.last_name name, p.position pos,
                       ps.year_in_school cls26
                FROM {tbl} b JOIN teams t ON t.id=b.team_id JOIN players p ON p.id=b.player_id
                LEFT JOIN player_links c ON c.linked_id=b.player_id
                LEFT JOIN player_seasons ps ON ps.player_id=b.player_id AND ps.season=2026
                WHERE b.season=2026 AND lower(t.short_name)=lower(%s) AND b.{idc}>=20
            """, (team,))
            rosters[side] = cur.fetchall()

    def run_side(side):
        df = bat if side == "bat" else pit
        periph = bat_p if side == "bat" else pit_p
        comps = BAT_COMPONENTS if side == "bat" else PIT_COMPONENTS
        pa_args = (PA_A, PA_B, PA_C) if side == "bat" else (BF_A, BF_B, BF_C)
        pbp_feats = HIT_PBP if side == "bat" else PIT_PBP
        df_feat = df.merge(periph, on=["pid", "season"], how="left")
        df_feat["p_n"] = df_feat["p_n"].fillna(0)
        df_feat = center_peripherals(df_feat, PERIPH_FEATS[side])
        C = fit_training_constants(df_feat, comps, TARGET)
        hist_all = C["train"].sort_values("wt_n", ascending=False).drop_duplicates(["pid", "season"])
        summer_lookup = build_summer_lookup(summer, TARGET) if side == "bat" else {}
        # class map for youth nudge
        clsmap = {}
        for r in rosters[side]:
            h = hist_all[(hist_all["pid"] == r["cid"]) & (hist_all["season"] < TARGET)]
            if not h.empty:
                clsmap[r["cid"]] = h.sort_values("season").iloc[-1]["cls"] or "Sr"
        # talent-aware whiff anchor for pitchers (K%-implied; Courtney fix)
        anchors = {}
        if side == "pit":
            a0, a1 = WHIFF_FROM_K
            for cid, cls in clsmap.items():
                hk = hist_all[(hist_all["pid"] == cid) & (hist_all["season"] < TARGET)]
                hk = hk.dropna(subset=["k_pct"])
                if not hk.empty:
                    kbar = np.average(hk["k_pct"], weights=hk["wt_n"])
                    anchors[cid] = {"p_whiff": a0 + a1 * kbar}
        pbp_proj = pbp_projection(periph, pbp_feats, clsmap, anchors)
        a_sig, b_sig = SIGMA[side]
        rows = []
        for r in rosters[side]:
            cid = r["cid"]
            h = hist_all[(hist_all["pid"] == cid) & (hist_all["season"] < TARGET)]
            if h.empty:
                continue
            last = h.sort_values("season").iloc[-1]
            if last["cls"] in GRADUATING:
                continue
            proj = project_player(h, summer_lookup.get(cid, []), C, comps, last["level"], TARGET, last["cls"])
            pt = proj_pt(h, *pa_args)
            row = {"name": r["name"], "pos": r["pos"], "cls": r["cls26"], "rel": round(proj.get("woba", proj.get("era_rate", (0, 0)))[1], 2)}
            if side == "bat":
                if "woba" not in proj:
                    continue
                woba, rel = proj["woba"]
                bb, k, hr_pa, avg, iso = (proj.get(s, (0, 0))[0] for s in ["bb_pct", "k_pct", "hr_pa", "avg", "iso"])
                obp = proj.get("obp", (0, 0))[0]
                ab = pt * (1 - bb - 0.02)
                h_ct = avg * ab
                hr = hr_pa * pt
                xbh = max(iso * ab, 0)           # 2B + 2*3B + 3*HR
                rem = max(xbh - 3 * hr, 0)       # 2B + 2*3B
                s2, s3, _ = career_xbh_mix(bat, cid)
                tot_nonhr = s2 + s3 if (s2 + s3) > 0 else 1
                d3 = rem * (s3 / tot_nonhr) / (1 + s3 / tot_nonhr)   # approx split
                d2 = rem - 2 * d3
                sigma = max(a_sig + b_sig * rel, 0.015)
                # R/RBI are context-dependent: scale league per-PA rates by the
                # player's OBP (scores runs) / SLG (drives them). Rough estimates.
                runs = pt * 0.16 * (obp / 0.360)
                rbi = pt * 0.15 * ((avg + iso) / 0.420)
                row.update({"PA": round(pt), "AB": round(ab), "H": round(h_ct),
                            "2B": round(max(d2, 0), 1), "3B": round(max(d3, 0), 1),
                            "HR": round(hr, 1), "R": round(runs), "RBI": round(rbi),
                            "BB": round(bb * pt), "SO": round(k * pt),
                            "AVG": f"{avg:.3f}", "OBP": f"{obp:.3f}", "SLG": f"{avg+iso:.3f}",
                            "wOBA": f"{woba:.3f}", "wOBA_rng": f"{woba-Z10*sigma:.3f}-{woba+Z10*sigma:.3f}"})
            else:
                if "era_rate" not in proj:
                    continue
                era_d, rel = proj["era_rate"]
                k, bb, hrb = (proj.get(s, (0, 0))[0] for s in ["k_pct", "bb_pct", "hr_bf"])
                fip_rate = run_coef[0]*k + run_coef[1]*bb + run_coef[2]*hrb + run_coef[3]
                era_rate = FIP_BLEND * fip_rate + (1 - FIP_BLEND) * era_d
                sigma = max(a_sig + b_sig * rel, 0.015)
                luck = fip_luck.get(cid)
                row.update({"BF": round(pt), "ERA~": f"{era_rate*39.6:.2f}",
                            "FIP~": f"{fip_rate*39.6:.2f}", "K%": f"{k:.3f}", "BB%": f"{bb:.3f}",
                            "HR/BF": f"{hrb:.3f}",
                            "FIPluck": (f"{luck:+.2f}" if luck is not None else "-"),
                            "ERA_rng": f"{(era_rate-Z10*sigma)*39.6:.2f}-{(era_rate+Z10*sigma)*39.6:.2f}"})
            for f in pbp_feats:
                pv = pbp_proj.get(cid, {}).get(f)
                row[PBP_LABEL[f]] = fmt_delta(*pv) if pv else "-"
            rows.append((proj.get("woba", proj.get("era_rate"))[0], row))
        rows.sort(key=lambda x: x[0], reverse=(side == "bat"))
        return [r for _, r in rows]

    hitters, pitchers = run_side("bat"), run_side("pit")
    print(f"\n{'='*72}\n{team} — 2027 PROJECTED HITTERS (returning)\n{'='*72}")
    if hitters:
        cols = ["name", "pos", "cls", "PA", "AB", "H", "2B", "3B", "HR", "R", "RBI",
                "BB", "SO", "AVG", "OBP", "SLG", "wOBA", "Whiff%", "GB%", "AirPull%", "rel"]
        print(pd.DataFrame(hitters)[cols].to_string(index=False))
    print(f"\n{'='*72}\n{team} — 2027 PROJECTED PITCHERS (returning)\n{'='*72}")
    if pitchers:
        cols = ["name", "pos", "cls", "BF", "ERA~", "FIP~", "FIPluck", "K%", "BB%", "HR/BF",
                "Whiff%", "GB%", "Strike%", "rel"]
        print(pd.DataFrame(pitchers)[cols].to_string(index=False))
    print("\nPBP stats: projected value with (Δ vs 2026); '-' = no PBP coverage.")
    print("Pitcher ERA~ = 50/50 blend of FIP-reconstruction and direct ERA.")
    print("FIPluck = career BF-weighted (ERA-FIP): negative = beats FIP (skill/luck),")
    print("positive = underperforms FIP (unlucky -> rebound candidate). ~16% carries forward.")


if __name__ == "__main__":
    main()
