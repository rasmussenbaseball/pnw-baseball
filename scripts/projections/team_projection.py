"""Project a full team roster's 2027 hitting lines.

The core product: pull up a current team and see every returning player's
projected stat line for next season. Returning = played for the team in the
most recent season (2026) with eligibility left (graduating Sr/Gr excluded).

Each line is the model's projected rate stats (from the validated nwbb_v1
component model) turned into a full counting-stat line via the fitted
playing-time model.

Usage:
  PYTHONPATH=backend python3 scripts/projections/team_projection.py "Bushnell"
"""
import sys
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.models.database import get_connection  # noqa: E402
from derive_constants import load_batting  # noqa: E402
from backtest import (  # noqa: E402
    BAT_COMPONENTS, PERIPH_FEATS, fit_training_constants, project_player,
    center_peripherals, load_pbp_peripherals, load_summer_batting,
)
from compute_player_projections import SIGMA, Z10, build_summer_lookup  # noqa: E402

TARGET = 2027
# Playing-time model fit from our YoY data (R^2 .22, RMSE 50 PA):
#   proj_PA = 0.454*PA(t-1) + 0.023*PA(t-2) + 96.8
PA_A, PA_B, PA_C = 0.454, 0.023, 96.8
GRADUATING = {"Sr", "Sr+", "Gr", "5th"}   # class values that won't return


def proj_pa(hist):
    s = {int(r["season"]): r["wt_n"] for _, r in hist.iterrows()}
    pa1 = s.get(TARGET - 1, 0)
    pa2 = s.get(TARGET - 2, 0)
    return PA_A * pa1 + PA_B * pa2 + PA_C


def main():
    team = sys.argv[1] if len(sys.argv) > 1 else "Bushnell"
    with get_connection() as conn:
        cur = conn.cursor()
        bat = load_batting(cur)
        summer = load_summer_batting(cur)
        periph = load_pbp_peripherals(cur, "bat")
        if not periph.empty:
            bat = bat.merge(periph, on=["pid", "season"], how="left")
            bat["p_n"] = bat["p_n"].fillna(0)
            bat = center_peripherals(bat, PERIPH_FEATS["bat"])
        C = fit_training_constants(bat, BAT_COMPONENTS, TARGET)
        hist_all = C["train"].sort_values("wt_n", ascending=False).drop_duplicates(["pid", "season"])
        summer_lookup = build_summer_lookup(summer, TARGET)

        # roster = players whose most-recent (2026) team is this team
        cur.execute("""
            SELECT COALESCE(c.canonical_id, b.player_id) AS cid,
                   p.first_name||' '||p.last_name AS name, p.position AS pos,
                   ps.year_in_school AS cls_2026
            FROM batting_stats b
            JOIN teams t ON t.id = b.team_id
            JOIN players p ON p.id = b.player_id
            LEFT JOIN player_links c ON c.linked_id = b.player_id
            LEFT JOIN player_seasons ps ON ps.player_id=b.player_id AND ps.season=2026
            WHERE b.season = 2026 AND lower(t.short_name) = lower(%s)
              AND b.plate_appearances >= 20
        """, (team,))
        roster = cur.fetchall()
        if not roster:
            print(f"no 2026 roster found for '{team}'"); return
        level = hist_all[hist_all["season"] == 2026]

        a_sig, b_sig = SIGMA["bat"]
        out = []
        for r in roster:
            cid = r["cid"]
            h = hist_all[hist_all["pid"] == cid]
            h = h[h["season"] < TARGET]
            if h.empty:
                continue
            last = h.sort_values("season").iloc[-1]
            cls_last = last["cls"]
            if cls_last in GRADUATING:
                continue   # graduating senior - not returning
            lvl = last["level"]
            proj = project_player(h, summer_lookup.get(cid, []), C, BAT_COMPONENTS,
                                  lvl, TARGET, cls_last)
            if "woba" not in proj:
                continue
            woba, rel = proj["woba"]
            pa = proj_pa(h)
            bb_pct = proj.get("bb_pct", (0, 0))[0]
            k_pct = proj.get("k_pct", (0, 0))[0]
            hr_pa = proj.get("hr_pa", (0, 0))[0]
            avg = proj.get("avg", (0, 0))[0]
            iso = proj.get("iso", (0, 0))[0]
            obp = proj.get("obp", (0, 0))[0]
            ab = pa * (1 - bb_pct - 0.02)   # minus walks + ~2% hbp/sf
            sigma = max(a_sig + b_sig * rel, 0.015)
            out.append({
                "name": r["name"], "pos": r["pos"], "cls26": r["cls_2026"],
                "PA": round(pa), "AVG": round(avg, 3), "OBP": round(obp, 3),
                "SLG": round(avg + iso, 3), "ISO": round(iso, 3),
                "HR": round(hr_pa * pa, 1), "BB%": round(bb_pct, 3),
                "K%": round(k_pct, 3), "wOBA": round(woba, 3),
                "wOBA_lo": round(woba - Z10 * sigma, 3),
                "wOBA_hi": round(woba + Z10 * sigma, 3), "rel": round(rel, 2),
            })

    df = pd.DataFrame(out).sort_values("wOBA", ascending=False)
    print(f"\n{team} — 2027 projected hitting (returning players)\n")
    cols = ["name", "pos", "cls26", "PA", "AVG", "OBP", "SLG", "ISO", "HR",
            "BB%", "K%", "wOBA", "wOBA_lo", "wOBA_hi", "rel"]
    print(df[cols].to_string(index=False))
    print(f"\n{len(df)} returning hitters. (Graduating Sr/Gr excluded; incoming "
          f"transfers/freshmen not yet on roster.)")


if __name__ == "__main__":
    main()
