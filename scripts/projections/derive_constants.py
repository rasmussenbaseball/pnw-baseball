"""Derive PNW-specific projection model constants from our own historical data.

Everything here is fit from the NWBB database — no MLB constants. Produces
backend/data/projection_constants.json with:

  1. reliability   — per-stat, per-division year-over-year reliability and the
                     regression ballast (the "add K PA of average" amount).
                     Method: weighted correlation of consecutive-season rates
                     (centered on division-season means to remove environment
                     drift), weight = harmonic mean of the two samples.
                     Ballast K solves r = N / (N + K) at the average sample size.
  2. aging         — class-year development deltas (Fr->So, So->Jr, Jr->Sr)
                     per stat, delta method with harmonic-mean weighting,
                     computed on same-division stayers in centered space.
  3. translations  — level-change factors (JUCO->D1/D2/D3/NAIA etc.) per stat:
                     raw delta for movers minus the aging delta for same-class
                     stayers (so the factor isolates the level change).
  4. summer        — spring->same-summer environment deltas and
                     summer->next-spring predictive deltas (WCL etc.).
  5. league_means  — PA-weighted division-season means per stat (the
                     regression targets, pre-tiering).

Run from repo root:
  PYTHONPATH=backend python3 scripts/projections/derive_constants.py
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "backend"))
from app.models.database import get_connection  # noqa: E402

OUT_PATH = REPO / "backend" / "data" / "projection_constants.json"

MIN_PA = 50
MIN_BF = 50
MIN_PAIRS = 25       # don't publish a constant fit on fewer pairs than this
COVID_SEASONS = {2020}  # excluded from pair-based fits (truncated season)

BAT_STATS = ["k_pct", "bb_pct", "iso", "hr_pa", "babip", "avg", "obp", "woba"]
PIT_STATS = ["k_pct", "bb_pct", "hr_bf", "babip_against", "whip_rate", "era_rate"]

CLASS_ORDER = {"Fr": 1, "So": 2, "Jr": 3, "Sr": 4, "Gr": 5, "5th": 5}


def norm_class(y):
    """'R-So' -> 'So', '5th'/'Gr' -> 'Sr+' bucket."""
    if y is None or (isinstance(y, float) and pd.isna(y)):
        return None
    y = y.replace("R-", "")
    if y in ("Gr", "5th"):
        return "Sr+"
    return y if y in ("Fr", "So", "Jr", "Sr") else None


def wcorr(x, y, w):
    """Weighted Pearson correlation."""
    w = np.asarray(w, dtype=float)
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    mx = np.average(x, weights=w)
    my = np.average(y, weights=w)
    cov = np.average((x - mx) * (y - my), weights=w)
    vx = np.average((x - mx) ** 2, weights=w)
    vy = np.average((y - my) ** 2, weights=w)
    if vx <= 0 or vy <= 0:
        return np.nan
    return cov / np.sqrt(vx * vy)


def load_batting(cur):
    cur.execute("""
        WITH canon AS (SELECT linked_id AS player_id, canonical_id FROM player_links)
        SELECT COALESCE(c.canonical_id, b.player_id) AS pid,
               b.player_id AS raw_pid, b.season, d.level,
               b.plate_appearances AS pa, b.at_bats AS ab, b.hits AS h,
               b.doubles AS d2, b.triples AS d3, b.home_runs AS hr,
               b.walks AS bb, b.strikeouts AS k, b.hit_by_pitch AS hbp,
               b.sacrifice_flies AS sf, b.woba,
               ps.year_in_school AS class_ps, pl.year_in_school AS class_pl
        FROM batting_stats b
        JOIN teams t ON t.id = b.team_id
        JOIN conferences cf ON cf.id = t.conference_id
        JOIN divisions d ON d.id = cf.division_id
        JOIN players pl ON pl.id = b.player_id
        LEFT JOIN canon c ON c.player_id = b.player_id
        LEFT JOIN player_seasons ps
               ON ps.player_id = b.player_id AND ps.season = b.season
        WHERE b.plate_appearances >= %s
    """, (MIN_PA,))
    df = pd.DataFrame(cur.fetchall())
    for col in ["pa", "ab", "h", "d2", "d3", "hr", "bb", "k", "hbp", "sf"]:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)
    df["woba"] = pd.to_numeric(df["woba"], errors="coerce")
    df["k_pct"] = df["k"] / df["pa"]
    df["bb_pct"] = df["bb"] / df["pa"]
    df["hr_pa"] = df["hr"] / df["pa"]
    df["iso"] = (df["d2"] + 2 * df["d3"] + 3 * df["hr"]) / df["ab"].clip(lower=1)
    df["avg"] = df["h"] / df["ab"].clip(lower=1)
    df["obp"] = (df["h"] + df["bb"] + df["hbp"]) / df["pa"]
    bip = (df["ab"] - df["k"] - df["hr"] + df["sf"]).clip(lower=0)
    df["babip"] = np.where(bip >= 20, (df["h"] - df["hr"]) / bip.clip(lower=1), np.nan)
    # class: prefer the season-specific record, fall back to roster field
    df["cls"] = df["class_ps"].combine_first(df["class_pl"]).map(norm_class)
    df["wt_n"] = df["pa"]
    return df


def load_pitching(cur):
    cur.execute("""
        WITH canon AS (SELECT linked_id AS player_id, canonical_id FROM player_links)
        SELECT COALESCE(c.canonical_id, p.player_id) AS pid,
               p.player_id AS raw_pid, p.season, d.level,
               p.batters_faced AS bf, p.strikeouts AS k, p.walks AS bb,
               p.home_runs_allowed AS hr, p.hits_allowed AS ha,
               p.hit_batters AS hb, p.earned_runs AS er,
               p.innings_pitched AS ip_notation,
               ps.year_in_school AS class_ps, pl.year_in_school AS class_pl
        FROM pitching_stats p
        JOIN teams t ON t.id = p.team_id
        JOIN conferences cf ON cf.id = t.conference_id
        JOIN divisions d ON d.id = cf.division_id
        JOIN players pl ON pl.id = p.player_id
        LEFT JOIN canon c ON c.player_id = p.player_id
        LEFT JOIN player_seasons ps
               ON ps.player_id = p.player_id AND ps.season = p.season
        WHERE p.batters_faced >= %s
    """, (MIN_BF,))
    df = pd.DataFrame(cur.fetchall())
    for col in ["bf", "k", "bb", "hr", "ha", "hb", "er"]:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)
    # innings_pitched stores baseball notation: 6.2 means 6 and 2/3
    ipn = pd.to_numeric(df["ip_notation"], errors="coerce").fillna(0)
    whole = np.floor(ipn)
    df["outs"] = (whole * 3 + np.round((ipn - whole) * 10)).astype(int)
    df["k_pct"] = df["k"] / df["bf"]
    df["bb_pct"] = df["bb"] / df["bf"]
    df["hr_bf"] = df["hr"] / df["bf"]
    bip = (df["bf"] - df["k"] - df["bb"] - df["hb"] - df["hr"]).clip(lower=0)
    df["babip_against"] = np.where(bip >= 20, (df["ha"] - df["hr"]) / bip.clip(lower=1), np.nan)
    df["whip_rate"] = (df["ha"] + df["bb"]) / df["bf"]          # baserunners per BF
    df["era_rate"] = np.where(df["outs"] >= 30, df["er"] / df["bf"], np.nan)  # ER per BF
    df["cls"] = df["class_ps"].combine_first(df["class_pl"]).map(norm_class)
    df["wt_n"] = df["bf"]
    return df


def league_means(df, stats):
    """PA-weighted division-season mean for each stat."""
    out = {}
    for (level, season), g in df.groupby(["level", "season"]):
        key = f"{level}|{season}"
        out[key] = {}
        for s in stats:
            v = g[s].dropna()
            w = g.loc[v.index, "wt_n"]
            out[key][s] = float(np.average(v, weights=w)) if len(v) else None
        out[key]["n_players"] = int(len(g))
    return out


def center(df, stats, means):
    """Add stat_c columns: rate minus division-season league mean."""
    df = df.copy()
    for s in stats:
        df[f"{s}_c"] = df.apply(
            lambda r: r[s] - means[f"{r['level']}|{r['season']}"][s]
            if pd.notna(r[s]) and means[f"{r['level']}|{r['season']}"][s] is not None
            else np.nan, axis=1)
    return df


def make_pairs(df, same_level=True):
    """Join season N to season N+1 for the same canonical player."""
    a = df.copy()
    b = df.copy()
    pairs = a.merge(b, on="pid", suffixes=("_1", "_2"))
    pairs = pairs[pairs["season_2"] == pairs["season_1"] + 1]
    pairs = pairs[~pairs["season_1"].isin(COVID_SEASONS) & ~pairs["season_2"].isin(COVID_SEASONS)]
    if same_level:
        pairs = pairs[pairs["level_1"] == pairs["level_2"]]
    else:
        pairs = pairs[pairs["level_1"] != pairs["level_2"]]
    # if a player has multiple rows in a season (multi-team), keep biggest sample
    pairs = pairs.sort_values("wt_n_1", ascending=False).drop_duplicates(["pid", "season_1"])
    pairs["hmean_n"] = 2 / (1 / pairs["wt_n_1"] + 1 / pairs["wt_n_2"])
    return pairs


def reliability(pairs, stats, label):
    """Per-stat (and per-division) YoY reliability + regression ballast."""
    results = {}
    groups = [("ALL", pairs)] + [(lv, g) for lv, g in pairs.groupby("level_1")]
    for lv, g in groups:
        for s in stats:
            sub = g.dropna(subset=[f"{s}_c_1", f"{s}_c_2"])
            if len(sub) < MIN_PAIRS:
                continue
            r = wcorr(sub[f"{s}_c_1"], sub[f"{s}_c_2"], sub["hmean_n"])
            avg_n = float(np.average(sub["hmean_n"]))
            if np.isnan(r):
                continue
            r_clip = min(max(r, 0.02), 0.98)
            ballast = avg_n * (1 - r_clip) / r_clip
            results.setdefault(lv, {})[s] = {
                "r": round(float(r), 3),
                "avg_n": round(avg_n),
                "ballast": round(float(ballast)),
                "n_pairs": int(len(sub)),
            }
    print(f"\n=== RELIABILITY / BALLASTS ({label}) ===")
    for lv, d in results.items():
        print(f"  [{lv}]")
        for s, v in d.items():
            print(f"    {s:<14} r={v['r']:+.3f}  ballast={v['ballast']:>5}  "
                  f"(avg_n={v['avg_n']}, pairs={v['n_pairs']})")
    return results


def aging(pairs, stats, label):
    """Class-transition deltas in centered space (same-division stayers)."""
    pairs = pairs.dropna(subset=["cls_1"]).copy()
    pairs["transition"] = pairs["cls_1"] + "->" + pairs["cls_2"].fillna("?")
    keep = ["Fr->So", "So->Jr", "Jr->Sr", "Sr->Sr+"]
    results = {}
    for tr, g in pairs.groupby("transition"):
        if tr not in keep or len(g) < MIN_PAIRS:
            continue
        results[tr] = {"n_pairs": int(len(g))}
        for s in stats:
            sub = g.dropna(subset=[f"{s}_c_1", f"{s}_c_2"])
            if len(sub) < MIN_PAIRS:
                continue
            delta = np.average(sub[f"{s}_c_2"] - sub[f"{s}_c_1"], weights=sub["hmean_n"])
            results[tr][s] = round(float(delta), 4)
    print(f"\n=== CLASS-YEAR AGING DELTAS ({label}) — centered, +=improvement in raw stat ===")
    for tr, d in results.items():
        line = "  ".join(f"{s}={d[s]:+.4f}" for s in stats if s in d)
        print(f"  {tr} (n={d['n_pairs']}): {line}")
    return results


def translations(df, stats, means, label, aging_deltas):
    """Level-change factors: raw mover delta minus stayer aging delta."""
    pairs = make_pairs(df, same_level=False)
    results = {}
    # pooled JUCO -> any 4-year, plus each specific route with enough pairs
    routes = [("JUCO", "4YR")] + sorted(
        {(a, b) for a, b in zip(pairs["level_1"], pairs["level_2"])})
    for frm, to in routes:
        if to == "4YR":
            g = pairs[(pairs["level_1"] == "JUCO") & (pairs["level_2"] != "JUCO")]
        else:
            g = pairs[(pairs["level_1"] == frm) & (pairs["level_2"] == to)]
        if len(g) < 15:   # translations get a lower floor; flag small n
            continue
        results[f"{frm}->{to}"] = {"n_pairs": int(len(g))}
        for s in stats:
            sub = g.dropna(subset=[f"{s}_1", f"{s}_2"])
            if len(sub) < 15:
                continue
            raw = np.average(sub[f"{s}_2"] - sub[f"{s}_1"], weights=sub["hmean_n"])
            # net out typical same-class improvement (pooled aging across transitions,
            # weighted by this group's class mix)
            ag = 0.0
            n_ag = 0
            for tr, d in aging_deltas.items():
                if s in d:
                    n_tr = int((sub["cls_1"] + "->" + sub["cls_2"].fillna("?") == tr).sum())
                    ag += d[s] * n_tr
                    n_ag += n_tr
            ag = ag / n_ag if n_ag else 0.0
            results[f"{frm}->{to}"][s] = {
                "raw_delta": round(float(raw), 4),
                "aging_corrected": round(float(raw - ag), 4),
                "n": int(len(sub)),
            }
    print(f"\n=== LEVEL TRANSLATIONS ({label}) — what happens to the raw stat on moving ===")
    for route, d in results.items():
        print(f"  {route} (n={d['n_pairs']})")
        for s in stats:
            if s in d:
                v = d[s]
                print(f"    {s:<14} raw={v['raw_delta']:+.4f}  "
                      f"aging-corrected={v['aging_corrected']:+.4f} (n={v['n']})")
    return results


def summer_factors(cur):
    """Spring->same-summer environment deltas + summer->next-spring deltas (batting)."""
    cur.execute("""
        SELECT l.spring_player_id, sb.season AS summer_season,
               sb.plate_appearances AS s_pa, sb.at_bats AS s_ab, sb.hits AS s_h,
               sb.doubles AS s_d2, sb.triples AS s_d3, sb.home_runs AS s_hr,
               sb.walks AS s_bb, sb.strikeouts AS s_k, sb.woba AS s_woba,
               b0.plate_appearances AS p0_pa, b0.k_pct AS p0_k, b0.bb_pct AS p0_bb,
               b0.iso AS p0_iso, b0.woba AS p0_woba,
               b1.plate_appearances AS p1_pa, b1.k_pct AS p1_k, b1.bb_pct AS p1_bb,
               b1.iso AS p1_iso, b1.woba AS p1_woba
        FROM summer_player_links l
        JOIN summer_batting_stats sb ON sb.player_id = l.summer_player_id
        LEFT JOIN batting_stats b0
          ON b0.player_id = l.spring_player_id AND b0.season = sb.season
        LEFT JOIN batting_stats b1
          ON b1.player_id = l.spring_player_id AND b1.season = sb.season + 1
        WHERE sb.plate_appearances >= 40
    """)
    df = pd.DataFrame(cur.fetchall())
    if df.empty:
        return {}
    for c in df.columns:
        if c != "spring_player_id":
            df[c] = pd.to_numeric(df[c], errors="coerce")
    df["s_k_pct"] = df["s_k"] / df["s_pa"]
    df["s_bb_pct"] = df["s_bb"] / df["s_pa"]
    df["s_iso"] = (df["s_d2"] + 2 * df["s_d3"] + 3 * df["s_hr"]) / df["s_ab"].clip(lower=1)
    out = {}
    # environment shift: same player, spring season N vs summer season N
    env = df.dropna(subset=["p0_pa"]).query("p0_pa >= 40")
    if len(env) >= 25:
        w = 2 / (1 / env["s_pa"] + 1 / env["p0_pa"])
        out["spring_to_summer_env"] = {
            "n_pairs": int(len(env)),
            "k_pct": round(float(np.average(env["s_k_pct"] - env["p0_k"], weights=w)), 4),
            "bb_pct": round(float(np.average(env["s_bb_pct"] - env["p0_bb"], weights=w)), 4),
            "iso": round(float(np.average(env["s_iso"] - env["p0_iso"], weights=w)), 4),
            "woba": round(float(np.average(env["s_woba"] - env["p0_woba"], weights=w)), 4),
        }
    # predictive: summer N -> spring N+1
    pred = df.dropna(subset=["p1_pa"]).query("p1_pa >= 40")
    if len(pred) >= 25:
        w = 2 / (1 / pred["s_pa"] + 1 / pred["p1_pa"])
        out["summer_to_next_spring"] = {
            "n_pairs": int(len(pred)),
            "k_pct": round(float(np.average(pred["p1_k"] - pred["s_k_pct"], weights=w)), 4),
            "bb_pct": round(float(np.average(pred["p1_bb"] - pred["s_bb_pct"], weights=w)), 4),
            "iso": round(float(np.average(pred["p1_iso"] - pred["s_iso"], weights=w)), 4),
            "woba": round(float(np.average(pred["p1_woba"] - pred["s_woba"], weights=w)), 4),
        }
        # how well does summer performance correlate with next spring?
        for s_sum, s_spr, name in [("s_k_pct", "p1_k", "k_pct"), ("s_woba", "p1_woba", "woba")]:
            sub = pred.dropna(subset=[s_sum, s_spr])
            if len(sub) >= 25:
                ww = 2 / (1 / sub["s_pa"] + 1 / sub["p1_pa"])
                out.setdefault("summer_predictive_r", {})[name] = round(
                    float(wcorr(sub[s_sum], sub[s_spr], ww)), 3)
    print("\n=== SUMMER BALL FACTORS (batting) ===")
    print(json.dumps(out, indent=2))
    return out


def main():
    with get_connection() as conn:
        cur = conn.cursor()
        print("Loading batting…")
        bat = load_batting(cur)
        print(f"  {len(bat)} batting player-seasons (PA>={MIN_PA})")
        print("Loading pitching…")
        pit = load_pitching(cur)
        print(f"  {len(pit)} pitching player-seasons (BF>={MIN_BF})")

        bat_means = league_means(bat, BAT_STATS)
        pit_means = league_means(pit, PIT_STATS)
        bat = center(bat, BAT_STATS, bat_means)
        pit = center(pit, PIT_STATS, pit_means)

        bat_pairs = make_pairs(bat, same_level=True)
        pit_pairs = make_pairs(pit, same_level=True)
        print(f"\nSame-division YoY pairs: batting={len(bat_pairs)}, pitching={len(pit_pairs)}")

        constants = {
            "meta": {
                "derived_from": "NWBB database, seasons 2018-2026 (2020 excluded from pairs)",
                "min_pa": MIN_PA, "min_bf": MIN_BF,
                "note": "rates are per-PA (batting) / per-BF (pitching); "
                        "centered = relative to division-season mean",
            },
            "batting": {
                "league_means": bat_means,
                "reliability": reliability(bat_pairs, BAT_STATS, "BATTING"),
                "aging": aging(bat_pairs, BAT_STATS, "BATTING"),
                "translations": translations(bat, BAT_STATS, bat_means, "BATTING",
                                             aging(bat_pairs, BAT_STATS, "BATTING (for translation correction)")),
            },
            "pitching": {
                "league_means": pit_means,
                "reliability": reliability(pit_pairs, PIT_STATS, "PITCHING"),
                "aging": aging(pit_pairs, PIT_STATS, "PITCHING"),
                "translations": translations(pit, PIT_STATS, pit_means, "PITCHING",
                                             aging(pit_pairs, PIT_STATS, "PITCHING (for translation correction)")),
            },
            "summer": summer_factors(cur),
        }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(constants, indent=2))
    print(f"\nWrote {OUT_PATH}")


if __name__ == "__main__":
    main()
