"""Project one hitter's 2027 line at each destination LEVEL via MLE-style
level translation.

Method (the defensible one): project the player's true-talent line at his
CURRENT level, then apply the level-translation delta for each move. The delta
comes from players who actually made that move (raw), shrunk toward zero by
sample size n/(n+40) since some routes have few examples. We show both the
model's (shrunk) line and the raw historical signal so the uncertainty is
visible.

Why not regress to the destination's league mean instead? Because D1's league
ISO (.164) dwarfs JUCO's (.082), so regressing a JUCO bat toward the D1 mean
would *inflate* his power on promotion -- nonsense. Translation deltas keep the
move grounded in what actually happens to real movers.

LIMITATIONS: division granularity only (Oregon == Seattle U until park factors);
cross-division wOBA isn't on a perfectly common scale yet.

Usage:
  PYTHONPATH=backend python3 scripts/projections/project_at_levels.py "Karsten Hansen"
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
    BAT_COMPONENTS, PERIPH_FEATS, TRANS_SHRINK_N, fit_training_constants,
    project_player, center_peripherals, load_pbp_peripherals, load_summer_batting,
)
from compute_player_projections import SIGMA, Z10, build_summer_lookup  # noqa: E402

TARGET = 2027
DESTS = [
    ("JUCO", "stay JUCO (Lower Columbia)"),
    ("NAIA", "NAIA (Bushnell / LCSC)"),
    ("D3",   "D3 (Whitworth / Linfield)"),
    ("D2",   "D2 (MSU Billings / WOU)"),
    ("D1",   "D1 (Oregon / Oregon St / Seattle U)"),
]
SHOW = ["woba", "k_pct", "bb_pct", "iso", "babip"]


def trans(C, frm, to, stat, shrunk=True):
    if frm == to:
        return 0.0
    d = C["trans"].get(f"{frm}->{to}") or (C["trans"].get("JUCO->4YR") if frm == "JUCO" else None)
    if d and isinstance(d.get(stat), dict):
        raw = d[stat]["aging_corrected"]
        n = d[stat].get("n", 0)
        return raw * (n / (n + TRANS_SHRINK_N)) if shrunk else raw
    return 0.0


def route_n(C, frm, to):
    d = C["trans"].get(f"{frm}->{to}") or (C["trans"].get("JUCO->4YR") if frm == "JUCO" else None)
    return (d or {}).get("n_pairs", 0)


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "Karsten Hansen"
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

        cur.execute("""SELECT COALESCE(c.canonical_id, p.id) AS cid
                       FROM players p LEFT JOIN player_links c ON c.linked_id = p.id
                       WHERE lower(p.first_name||' '||p.last_name) = lower(%s)""", (name,))
        rows = cur.fetchall()
        if not rows:
            print(f"no player named {name}"); return
        cid = rows[0]["cid"]
        h = hist_all[hist_all["pid"] == cid]
        if h.empty:
            print(f"no qualifying history for {name}"); return
        cls_last = h.sort_values("season").iloc[-1]["cls"]
        frm = h.sort_values("season").iloc[-1]["level"]
        summer_lookup = build_summer_lookup(summer, TARGET)

        # 1) true-talent line at the CURRENT level
        base = project_player(h, summer_lookup.get(cid, []), C, BAT_COMPONENTS,
                              frm, TARGET, cls_last)
        a_sig, b_sig = SIGMA["bat"]

        print(f"\n{name} — currently {frm}, last class {cls_last}")
        print("Prior line(s):")
        for _, r in h.sort_values("season").iterrows():
            print(f"  {int(r['season'])} {r['level']:>4} {int(r['wt_n'])} PA  "
                  f"wOBA {r['woba']:.3f}  K% {r['k_pct']:.3f}  BB% {r['bb_pct']:.3f}  "
                  f"ISO {r['iso']:.3f}  BABIP {r['babip']:.3f}")

        hdr = (f"\n{'destination':<36}" + "".join(f"{s:>7}" for s in SHOW)
               + f"   {'wOBA range':>13}  movers")
        print(hdr); print("-" * len(hdr))
        for level, label in DESTS:
            line = {s: base[s][0] + trans(C, frm, level, s) for s in SHOW}
            rel = base["woba"][1] * (1.0 if level == frm else 0.85)  # more uncertainty on a move
            sigma = max(a_sig + b_sig * rel, 0.015)
            w = line["woba"]
            n = "-" if level == frm else route_n(C, frm, level)
            cells = "".join(f"{line[s]:>7.3f}" for s in SHOW)
            tag = "  <- current" if level == frm else ""
            print(f"{label:<36}{cells}   {w-Z10*sigma:.3f}-{w+Z10*sigma:.3f}  {str(n):>5}{tag}")

        print("\nRaw translation signal (unshrunk; what movers historically did, wOBA / K%):")
        for level, label in DESTS:
            if level == frm:
                continue
            print(f"  -> {level}: wOBA {trans(C, frm, level, 'woba', shrunk=False):+.3f}  "
                  f"K% {trans(C, frm, level, 'k_pct', shrunk=False):+.3f}  "
                  f"ISO {trans(C, frm, level, 'iso', shrunk=False):+.3f}  "
                  f"(n={route_n(C, frm, level)} movers)")
        print("\nModel applies these shrunk by n/(n+40), so thin routes (few movers) stay")
        print("conservative; differences sharpen as we log more transfers.")


if __name__ == "__main__":
    main()
