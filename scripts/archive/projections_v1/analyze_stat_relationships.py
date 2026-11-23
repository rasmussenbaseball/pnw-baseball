"""Figure out (1) which stats are STABLE signature skills (regress lightly) vs
volatile, and (2) which OUTCOME stats are best projected from MULTIPLE stable
skills rather than in isolation (e.g. HR from FB% + air-pull% + ISO, not ISO
alone). Drives the multi-stat projection rebuild.

Run: PYTHONPATH=backend python3 scripts/projections/analyze_stat_relationships.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from app.models.database import get_connection  # noqa: E402
from derive_constants import load_batting, COVID_SEASONS  # noqa: E402


def wcorr(x, y, w):
    m = ~(np.isnan(x) | np.isnan(y))
    x, y, w = x[m], y[m], w[m]
    if len(x) < 20:
        return np.nan, 0
    mx, my = np.average(x, weights=w), np.average(y, weights=w)
    vx, vy = np.average((x - mx) ** 2, weights=w), np.average((y - my) ** 2, weights=w)
    if vx <= 0 or vy <= 0:
        return np.nan, len(x)
    return float(np.average((x - mx) * (y - my), weights=w) / np.sqrt(vx * vy)), len(x)


def main():
    with get_connection() as conn:
        cur = conn.cursor()
        # hitter PBP rates per player-season
        cur.execute("""
            WITH canon AS (SELECT linked_id pid, canonical_id cid FROM player_links)
            SELECT COALESCE(c.cid, ge.batter_player_id) pid, g.season,
              COUNT(*) FILTER (WHERE bb_type='GB') gb, COUNT(*) FILTER (WHERE bb_type='FB') fb,
              COUNT(*) FILTER (WHERE bb_type='LD') ld, COUNT(*) FILTER (WHERE bb_type='PU') pu,
              COUNT(*) FILTER (WHERE bb_type IS NOT NULL) bip,
              COUNT(*) FILTER (WHERE bb_type IN ('LD','FB') AND ((UPPER(p.bats)='R' AND field_zone='LEFT') OR (UPPER(p.bats)='L' AND field_zone='RIGHT'))) airpull,
              SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'S',''))) sw,
              SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'F',''))) f,
              COUNT(*) FILTER (WHERE was_in_play) inplay, COALESCE(SUM(pitches_thrown),0) pit
            FROM game_events ge JOIN games g ON g.id=ge.game_id JOIN players p ON p.id=ge.batter_player_id
            LEFT JOIN canon c ON c.pid=ge.batter_player_id
            WHERE bb_type IS NOT NULL AND batter_player_id IS NOT NULL GROUP BY 1,2""")
        pbp = pd.DataFrame(cur.fetchall())
        for col in pbp.columns:
            if col != 'pid':
                pbp[col] = pd.to_numeric(pbp[col])
        pbp = pbp[pbp.bip >= 40]
        pbp['fb_pct'] = pbp.fb / pbp.bip; pbp['gb_pct'] = pbp.gb / pbp.bip
        pbp['ld_pct'] = pbp.ld / pbp.bip; pbp['airpull_pct'] = pbp.airpull / pbp.bip
        sw = (pbp.sw + pbp.f + pbp.inplay).clip(lower=1)
        pbp['whiff_pct'] = pbp.sw / sw; pbp['swing_pct'] = sw / pbp.pit.clip(lower=1)
        bat = load_batting(cur)

    box = bat[['pid', 'season', 'k_pct', 'bb_pct', 'iso', 'babip', 'hr_pa', 'avg', 'woba', 'wt_n']]
    d = box.merge(pbp[['pid', 'season', 'fb_pct', 'gb_pct', 'ld_pct', 'airpull_pct', 'whiff_pct', 'swing_pct']],
                  on=['pid', 'season'], how='left')
    d = d.sort_values('wt_n', ascending=False).drop_duplicates(['pid', 'season'])

    # YoY pairs
    pairs = []
    for pid, g in d.groupby('pid'):
        s = {int(r.season): r for _, r in g.iterrows()}
        for yr in s:
            if (yr - 1) in s and (yr - 1) not in COVID_SEASONS and yr not in COVID_SEASONS:
                pairs.append((s[yr - 1], s[yr]))
    P = pd.DataFrame([{**{f'{k}_1': a[k] for k in d.columns if k != 'pid'},
                       **{f'{k}_2': b[k] for k in d.columns if k != 'pid'}} for a, b in pairs])
    w = (2 / (1 / P.wt_n_1 + 1 / P.wt_n_2)).values

    print("=== STABILITY: year-to-year self-correlation (high = stable signature skill) ===")
    for stat in ['k_pct', 'bb_pct', 'swing_pct', 'whiff_pct', 'gb_pct', 'fb_pct', 'ld_pct',
                 'airpull_pct', 'iso', 'hr_pa', 'avg', 'babip', 'woba']:
        r, n = wcorr(P[f'{stat}_1'].values, P[f'{stat}_2'].values, w)
        tag = 'STABLE' if (r or 0) >= 0.5 else ('volatile' if (r or 0) < 0.35 else 'medium')
        print(f"  {stat:<12} r={r:+.3f}  n={n:<4} {tag}")

    print("\n=== HR rate: ISO-only vs multi-stat (ISO + FB% + air-pull%) ===")
    sub = P.dropna(subset=['hr_pa_2', 'iso_1', 'fb_pct_1', 'airpull_pct_1', 'hr_pa_1'])
    ww = (2 / (1 / sub.wt_n_1 + 1 / sub.wt_n_2)).values
    y = sub.hr_pa_2.values
    def fit_rmse(feats):
        X = np.column_stack([sub[f].values for f in feats] + [np.ones(len(sub))])
        swt = np.sqrt(ww); coef, *_ = np.linalg.lstsq(X * swt[:, None], y * swt, rcond=None)
        pred = X @ coef
        return np.sqrt(np.average((pred - y) ** 2, weights=ww)), dict(zip(feats, coef.round(4)))
    for feats in [['hr_pa_1'], ['iso_1'], ['iso_1', 'fb_pct_1'], ['iso_1', 'airpull_pct_1'],
                  ['iso_1', 'fb_pct_1', 'airpull_pct_1'], ['hr_pa_1', 'iso_1', 'fb_pct_1', 'airpull_pct_1']]:
        rmse, coefs = fit_rmse(feats)
        print(f"  {str(feats):<52} RMSE={rmse:.5f}  {coefs}")
    # does FB%/air-pull differentiate same-ISO guys? corr of FB%/airpull with next HR controlling ISO
    print(f"\n  n={len(sub)}. corr(FB%_1, next HR)={np.corrcoef(sub.fb_pct_1, y)[0,1]:+.3f}, "
          f"corr(airpull_1, next HR)={np.corrcoef(sub.airpull_pct_1, y)[0,1]:+.3f}, corr(ISO_1, next HR)={np.corrcoef(sub.iso_1, y)[0,1]:+.3f}")

    print("\n=== BABIP from batted-ball mix (LD%/GB%) vs raw BABIP ===")
    sub2 = P.dropna(subset=['babip_2', 'ld_pct_1', 'gb_pct_1', 'babip_1'])
    ww2 = (2 / (1 / sub2.wt_n_1 + 1 / sub2.wt_n_2)).values; y2 = sub2.babip_2.values
    for feats in [['babip_1'], ['ld_pct_1'], ['ld_pct_1', 'gb_pct_1'], ['babip_1', 'ld_pct_1']]:
        X = np.column_stack([sub2[f].values for f in feats] + [np.ones(len(sub2))])
        s = np.sqrt(ww2); coef, *_ = np.linalg.lstsq(X * s[:, None], y2 * s, rcond=None)
        rmse = np.sqrt(np.average((X @ coef - y2) ** 2, weights=ww2))
        print(f"  {str(feats):<28} RMSE={rmse:.5f}")


if __name__ == "__main__":
    main()
