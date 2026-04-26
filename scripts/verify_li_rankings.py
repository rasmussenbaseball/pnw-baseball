"""
Phase D.5 — verify the empirical LI table preserves the correct
relative ranking of pitchers (closers > starters > mop-up).

Magnitudes will be compressed compared to the parametric MVP because
sparse high-leverage buckets get smoothed toward the global mean. The
question that matters: does the RELATIVE rank order still surface
closers at the top?

Per project_pbp_phases_b_c_d.md, the parametric LI top 5 closers were:
  Luke Ivanoff (2.58), Matt Palmateer (2.52), Luke Morris (2.48),
  Santiago Herrera (2.43), Kyler Wasley (2.40)

If those names still occupy the top of this list (with values likely
in the 1.4-1.8 range due to compression), the empirical LI is sound.

Run on Mac OR server:
    cd ~/Desktop/pnw-baseball   (or /opt/pnw-baseball)
    PYTHONPATH=backend python3 scripts/verify_li_rankings.py
"""

from __future__ import annotations
import sys

from app.models.database import get_connection
from app.api.leverage import compute_li


SEASON = 2026


def main() -> int:
    with get_connection() as conn:
        cur = conn.cursor()

        # Pull every PBP event for every pitcher (min 30 BFs) along with
        # the state. We compute AVG LI in Python using the same lookup
        # the API uses.
        cur.execute("""
            SELECT
                ge.pitcher_player_id AS pid,
                p.first_name, p.last_name, p.position,
                t.short_name AS team,
                CASE WHEN d.name = 'NWAC' THEN 'NWAC' ELSE 'NCAA' END
                    AS division_group,
                ge.inning, ge.half,
                ge.bat_score_before, ge.fld_score_before,
                ge.bases_before, ge.outs_before
            FROM game_events ge
            JOIN games g       ON g.id = ge.game_id
            JOIN players p     ON p.id = ge.pitcher_player_id
            JOIN teams t       ON t.id = p.team_id
            JOIN conferences c ON c.id = t.conference_id
            JOIN divisions d   ON d.id = c.division_id
            WHERE g.season = %s
              AND ge.bases_before IS NOT NULL
        """, (SEASON,))
        events = cur.fetchall()

        # Aggregate per pitcher
        per_p = {}
        for e in events:
            pid = e["pid"]
            if pid not in per_p:
                per_p[pid] = {
                    "name": f"{e['first_name']} {e['last_name']}",
                    "team": e["team"],
                    "pos": e["position"],
                    "div": e["division_group"],
                    "lis": [],
                }
            li = compute_li(
                e["inning"], e["half"],
                (e["bat_score_before"] or 0) - (e["fld_score_before"] or 0),
                e["bases_before"], e["outs_before"],
                division_group=e["division_group"],
            )
            per_p[pid]["lis"].append(li)

        # Compute averages and sort
        ranked = []
        for pid, d in per_p.items():
            n = len(d["lis"])
            if n < 30:
                continue
            avg = sum(d["lis"]) / n
            mx = max(d["lis"])
            ranked.append({
                "pid": pid, "name": d["name"], "team": d["team"],
                "pos": d["pos"], "div": d["div"], "n": n,
                "avg_li": avg, "max_li": mx,
            })

        ranked.sort(key=lambda r: r["avg_li"], reverse=True)

        print(f"\n── Top 15 pitchers by empirical AVG LI (min 30 BFs) ──")
        print(f"  {'AVG LI':>6}  {'BFs':>4}  {'peak':>5}  {'div':<4}  player")
        for r in ranked[:15]:
            print(f"  {r['avg_li']:>6.2f}  {r['n']:>4}  {r['max_li']:>5.2f}  "
                  f"{r['div']:<4}  {r['name']} ({r['team']}, {r['pos'] or '?'})")

        print(f"\n── Bottom 5 pitchers by AVG LI (mop-up types) ──")
        for r in ranked[-5:]:
            print(f"  {r['avg_li']:>6.2f}  {r['n']:>4}  "
                  f"{r['name']} ({r['team']}, {r['pos'] or '?'})")

        # Look for the parametric-LI top 5 specifically
        target_names = ["Ivanoff", "Palmateer", "Morris", "Herrera", "Wasley"]
        print(f"\n── Where the parametric top-5 closers landed ──")
        for tn in target_names:
            hits = [r for r in ranked if tn in r["name"]]
            for h in hits:
                rank = ranked.index(h) + 1
                print(f"  #{rank}: {h['name']} ({h['team']}) — "
                      f"AVG LI {h['avg_li']:.2f}, {h['n']} BFs")

    return 0


if __name__ == "__main__":
    sys.exit(main())
