"""Explain a player's 2027 projection: show the prior-season inputs the model
saw (spring lines + PBP peripherals + class + level) next to the projection so
the reasoning is auditable.

Usage:
  PYTHONPATH=backend python3 scripts/projections/explain_projection.py "Jackson Jaha" "Brandon Nguyen" ...
  (no args = a curated set of illustrative cases)
"""
import sys
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "backend"))
from app.models.database import get_connection  # noqa: E402

BAT = pd.read_csv(REPO / "scripts/projections/player_projections_2027_batting.csv")
PIT = pd.read_csv(REPO / "scripts/projections/player_projections_2027_pitching.csv")

CURATED = [
    "Jackson Jaha", "Brandon Nguyen",   # high-reliability returning bats
]


def canon_map(cur):
    cur.execute("SELECT linked_id, canonical_id FROM player_links")
    return {r["linked_id"]: r["canonical_id"] for r in cur.fetchall()}


def hist_batting(cur, cmap, raw_pid, canon_id):
    cur.execute("""
        SELECT b.season, d.level, t.short_name AS team, b.plate_appearances AS pa,
               ROUND(b.k_pct::numeric,3) AS k_pct, ROUND(b.bb_pct::numeric,3) AS bb_pct,
               ROUND(b.iso::numeric,3) AS iso, ROUND(b.babip::numeric,3) AS babip,
               ROUND(b.woba::numeric,3) AS woba, ps.year_in_school AS cls
        FROM batting_stats b
        JOIN teams t ON t.id=b.team_id
        JOIN conferences cf ON cf.id=t.conference_id
        JOIN divisions d ON d.id=cf.division_id
        LEFT JOIN player_seasons ps ON ps.player_id=b.player_id AND ps.season=b.season
        WHERE b.player_id = ANY(%s) AND b.plate_appearances >= 20
        ORDER BY b.season
    """, ([k for k, v in cmap.items() if v == canon_id] + [raw_pid, canon_id],))
    return cur.fetchall()


def peripherals(cur, canon_id, cmap, season):
    ids = [k for k, v in cmap.items() if v == canon_id] + [canon_id]
    cur.execute("""
        SELECT
          SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'S',''))) AS s,
          SUM(LENGTH(pitch_sequence)-LENGTH(REPLACE(pitch_sequence,'F',''))) AS f,
          COUNT(*) FILTER (WHERE was_in_play) AS inplay,
          COUNT(*) FILTER (WHERE bb_type='GB') AS gb,
          COUNT(*) FILTER (WHERE bb_type IS NOT NULL) AS bip,
          COUNT(*) FILTER (WHERE bb_type IN ('LD','FB')
            AND ((UPPER(p.bats)='R' AND field_zone='LEFT')
              OR (UPPER(p.bats)='L' AND field_zone='RIGHT'))) AS airpull
        FROM game_events ge JOIN games g ON g.id=ge.game_id
        JOIN players p ON p.id=ge.batter_player_id
        WHERE ge.batter_player_id = ANY(%s) AND g.season=%s
    """, (ids, season))
    r = cur.fetchone()
    if not r or not r["bip"]:
        return None
    swings = (r["s"] or 0) + (r["f"] or 0) + (r["inplay"] or 0)
    return {
        "whiff%": round((r["s"] or 0) / swings, 3) if swings else None,
        "gb%": round((r["gb"] or 0) / r["bip"], 3),
        "airpull%": round((r["airpull"] or 0) / r["bip"], 3),
        "bip": r["bip"],
    }


def explain_batter(cur, cmap, name):
    row = BAT[BAT["name"] == name]
    if row.empty:
        print(f"\n(no batting projection for {name})")
        return
    row = row.iloc[0]
    print("\n" + "=" * 78)
    print(f"{name} — {row['team']} ({row['level']}), last class: {row['class_last']}")
    print("=" * 78)
    print("Prior seasons the model used:")
    print(f"  {'yr':>4} {'lvl':>5} {'team':<14} {'PA':>4} {'K%':>6} {'BB%':>6} "
          f"{'ISO':>6} {'BABIP':>6} {'wOBA':>6} {'class':>5}")
    for h in hist_batting(cur, cmap, int(row["player_id"]), int(row["canonical_id"])):
        print(f"  {h['season']:>4} {h['level']:>5} {h['team'][:14]:<14} {h['pa']:>4} "
              f"{_f(h['k_pct']):>6} {_f(h['bb_pct']):>6} {_f(h['iso']):>6} "
              f"{_f(h['babip']):>6} {_f(h['woba']):>6} {str(h['cls']):>5}")
    per = peripherals(cur, int(row["canonical_id"]), cmap, int(row["last_season"]))
    if per:
        print(f"  PBP peripherals ({row['last_season']}, {per['bip']} BIP): "
              f"whiff%={per['whiff%']}  GB%={per['gb%']}  air-pull%={per['airpull%']}")
    print(f"\n  2027 PROJECTION:  wOBA {row['proj_woba']:.3f}  "
          f"(P10 {row['proj_woba_p10']:.3f} ... P90 {row['proj_woba_p90']:.3f})")
    print(f"  reliability={row['reliability']:.2f}   peripheral nudge={row['periph_adj']:+.4f}")
    print(f"  component proj: K%={row['proj_k_pct']:.3f} BB%={row['proj_bb_pct']:.3f} "
          f"ISO={row['proj_iso']:.3f} BABIP={row['proj_babip']:.3f}")


def _f(v):
    return f"{v:.3f}" if v is not None and not pd.isna(v) else "-"


def main():
    names = sys.argv[1:] or CURATED
    with get_connection() as conn:
        cur = conn.cursor()
        cmap = canon_map(cur)
        for n in names:
            explain_batter(cur, cmap, n)


if __name__ == "__main__":
    main()
