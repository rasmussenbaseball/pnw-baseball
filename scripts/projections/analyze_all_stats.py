"""Microscope on EVERY projected stat (hitters + pitchers, box + PBP). For each
target stat, report:
  - YoY self-correlation (stability) and the implied regression ballast
  - whether any OTHER stat (or a multivariate mix) predicts next year better
    than the stat itself
  - a verdict: light vs heavy regression, and the best projection recipe.

Run: PYTHONPATH=backend python3 scripts/projections/analyze_all_stats.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from app.models.database import get_connection  # noqa: E402
from derive_constants import load_batting, load_pitching, COVID_SEASONS  # noqa: E402


def wls_rmse(df, feats, target, w):
    sub = df.dropna(subset=feats + [target])
    if len(sub) < 40:
        return None, 0
    ww = w[sub.index]
    X = np.column_stack([sub[f].values for f in feats] + [np.ones(len(sub))])
    s = np.sqrt(ww / ww.mean())
    coef, *_ = np.linalg.lstsq(X * s[:, None], sub[target].values * s, rcond=None)
    pred = X @ coef
    return float(np.sqrt(np.average((pred - sub[target].values) ** 2, weights=ww))), len(sub)


def wcorr(df, a, b, w):
    sub = df.dropna(subset=[a, b]);
    if len(sub) < 40: return np.nan
    ww = sub.index.map(lambda i: w[i]).values if False else w[sub.index]
    x, y = sub[a].values, sub[b].values
    mx, my = np.average(x, weights=ww), np.average(y, weights=ww)
    vx, vy = np.average((x-mx)**2, weights=ww), np.average((y-my)**2, weights=ww)
    return float(np.average((x-mx)*(y-my), weights=ww)/np.sqrt(vx*vy)) if vx>0 and vy>0 else np.nan


def hitter_table(cur):
    cur.execute("""
        WITH canon AS (SELECT linked_id pid, canonical_id cid FROM player_links)
        SELECT COALESCE(c.cid, ge.batter_player_id) pid, g.season,
          COUNT(*) FILTER (WHERE bb_type='GB') gb, COUNT(*) FILTER (WHERE bb_type='FB') fb,
          COUNT(*) FILTER (WHERE bb_type='LD') ld, COUNT(*) FILTER (WHERE bb_type='PU') pu,
          COUNT(*) FILTER (WHERE bb_type IS NOT NULL) bip,
          COUNT(*) FILTER (WHERE bb_type IN ('LD','FB') AND ((UPPER(p.bats)='R' AND field_zone='LEFT') OR (UPPER(p.bats)='L' AND field_zone='RIGHT'))) airpull,
          SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'S',''))) sw,
          SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'F',''))) f,
          COUNT(*) FILTER (WHERE was_in_play) inp, COALESCE(SUM(pitches_thrown),0) pit
        FROM game_events ge JOIN games g ON g.id=ge.game_id JOIN players p ON p.id=ge.batter_player_id
        LEFT JOIN canon c ON c.pid=ge.batter_player_id
        WHERE bb_type IS NOT NULL AND batter_player_id IS NOT NULL GROUP BY 1,2""")
    pbp = pd.DataFrame(cur.fetchall())
    for c in pbp.columns:
        if c != 'pid': pbp[c] = pd.to_numeric(pbp[c])
    pbp = pbp[pbp.bip >= 40]
    for k, num in [('fb_pct', pbp.fb), ('gb_pct', pbp.gb), ('ld_pct', pbp.ld), ('airpull_pct', pbp.airpull)]:
        pbp[k] = num / pbp.bip
    swc = (pbp.sw + pbp.f + pbp.inp).clip(lower=1)
    pbp['whiff_pct'] = pbp.sw / swc; pbp['contact_pct'] = (pbp.f + pbp.inp) / swc; pbp['swing_pct'] = swc / pbp.pit.clip(lower=1)
    bat = load_batting(cur)
    box = bat[['pid', 'season', 'k_pct', 'bb_pct', 'iso', 'babip', 'hr_pa', 'avg', 'obp', 'woba', 'wobacon', 'wt_n']]
    return box.merge(pbp[['pid', 'season', 'fb_pct', 'gb_pct', 'ld_pct', 'airpull_pct', 'whiff_pct', 'contact_pct', 'swing_pct']], on=['pid', 'season'], how='left')


def pitcher_table(cur):
    cur.execute("""
        WITH canon AS (SELECT linked_id pid, canonical_id cid FROM player_links)
        SELECT COALESCE(c.cid, ge.pitcher_player_id) pid, g.season,
          COUNT(*) FILTER (WHERE bb_type='GB') gb, COUNT(*) FILTER (WHERE bb_type IS NOT NULL) bip,
          SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'S',''))) sw,
          SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'K',''))) k,
          SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'F',''))) f,
          COUNT(*) FILTER (WHERE was_in_play) inp, COALESCE(SUM(pitches_thrown),0) pit
        FROM game_events ge JOIN games g ON g.id=ge.game_id
        LEFT JOIN canon c ON c.pid=ge.pitcher_player_id
        WHERE pitcher_player_id IS NOT NULL GROUP BY 1,2""")
    pbp = pd.DataFrame(cur.fetchall())
    for c in pbp.columns:
        if c != 'pid': pbp[c] = pd.to_numeric(pbp[c])
    pbp = pbp[pbp.pit >= 150]
    swc = (pbp.sw + pbp.f + pbp.inp).clip(lower=1)
    pbp['p_whiff'] = pbp.sw / swc; pbp['p_gb'] = pbp.gb / pbp.bip.clip(lower=1)
    pbp['p_strike'] = (pbp.k + pbp.sw + pbp.f + pbp.inp) / pbp.pit.clip(lower=1)
    pit = load_pitching(cur)
    box = pit[['pid', 'season', 'k_pct', 'bb_pct', 'hr_bf', 'babip_against', 'whip_rate', 'era_rate', 'wt_n']]
    return box.merge(pbp[['pid', 'season', 'p_whiff', 'p_gb', 'p_strike']], on=['pid', 'season'], how='left')


def pairs_of(d):
    d = d.sort_values('wt_n', ascending=False).drop_duplicates(['pid', 'season'])
    rows = []
    for pid, g in d.groupby('pid'):
        s = {int(r.season): r for _, r in g.iterrows()}
        for yr in s:
            if (yr - 1) in s and (yr - 1) not in COVID_SEASONS and yr not in COVID_SEASONS:
                rows.append((s[yr - 1], s[yr]))
    cols = [c for c in d.columns if c != 'pid']
    P = pd.DataFrame([{**{f'{c}_1': a[c] for c in cols}, **{f'{c}_2': b[c] for c in cols}} for a, b in rows]).reset_index(drop=True)
    w = (2 / (1 / P.wt_n_1 + 1 / P.wt_n_2)).values
    return P, w


def report(name, d, targets, candidates):
    P, w = pairs_of(d)
    print(f"\n{'='*78}\n{name}: per-stat microscope (n_pairs up to {len(P)})\n{'='*78}")
    print(f"{'stat':<14}{'self_r':>7}{'ballast':>8}{'self_RMSE':>11}{'best_multi_RMSE':>16}  best recipe")
    for t in targets:
        t1, t2 = f'{t}_1', f'{t}_2'
        r = wcorr(P, t1, t2, w)
        avg_n = np.nanmean(P['wt_n_1'])
        rc = min(max(r if not np.isnan(r) else 0.05, 0.05), 0.95)
        ballast = round(avg_n * (1 - rc) / rc)
        self_rmse, _ = wls_rmse(P, [t1], t2, w)
        # try the target itself + each candidate; keep best 1-2 extra predictors
        best = (self_rmse, [t1])
        others = [f'{c}_1' for c in candidates if c != t and f'{c}_1' in P.columns]
        for o in others:
            rmse, n = wls_rmse(P, [t1, o], t2, w)
            if rmse and rmse < best[0]:
                best = (rmse, [t1, o])
        # try adding a 2nd extra on top of the best
        if len(best[1]) == 2:
            for o in others:
                if o in best[1]: continue
                rmse, n = wls_rmse(P, best[1] + [o], t2, w)
                if rmse and rmse < best[0]:
                    best = (rmse, best[1] + [o])
        gain = (self_rmse - best[0]) / self_rmse * 100 if (self_rmse and best[0]) else 0
        recipe = 'self only' if best[1] == [t1] else '+'.join(x[:-2] for x in best[1] if x != t1) + f' (−{gain:.1f}%)'
        sr = f"{self_rmse:.5f}" if self_rmse else 'n/a'
        br = f"{best[0]:.5f}" if best[0] else 'n/a'
        stab = 'STABLE' if rc >= 0.5 else ('volatile' if rc < 0.35 else 'medium')
        print(f"{t:<14}{r:>7.3f}{ballast:>8}{sr:>11}{br:>16}  {stab}; {recipe}")


def main():
    with get_connection() as conn:
        cur = conn.cursor()
        H = hitter_table(cur)
        Pt = pitcher_table(cur)
    hcand = ['k_pct', 'bb_pct', 'iso', 'babip', 'hr_pa', 'avg', 'obp', 'woba', 'wobacon',
             'fb_pct', 'gb_pct', 'ld_pct', 'airpull_pct', 'whiff_pct', 'contact_pct', 'swing_pct']
    report('HITTERS', H, ['k_pct', 'bb_pct', 'iso', 'babip', 'hr_pa', 'avg', 'obp', 'woba', 'wobacon'], hcand)
    pcand = ['k_pct', 'bb_pct', 'hr_bf', 'babip_against', 'whip_rate', 'era_rate', 'p_whiff', 'p_gb', 'p_strike']
    report('PITCHERS', Pt, ['k_pct', 'bb_pct', 'hr_bf', 'babip_against', 'whip_rate', 'era_rate'], pcand)


if __name__ == "__main__":
    main()
