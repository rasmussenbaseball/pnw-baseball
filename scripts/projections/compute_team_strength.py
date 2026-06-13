"""Historical team-strength ratings for the projection system.

CPI / composite_rankings only exist for the current season, but we need a
competition-quality signal for EVERY season 2018-2026 to (a) adjust a player's
raw stats for the strength of schedule he faced and (b) differentiate
destinations by skill, not just division (Oregon is a far tougher place to be
elite than Seattle U, though both are D1).

Method: an SRS (Simple Rating System) on run margin, opponent-adjusted and
iterated to convergence, with two robustness fixes for messy college schedules:
  - margin capped at +/-10 so blowouts don't dominate
  - each team's rating regressed toward 0 by games played (add REG pseudo-games
    at neutral margin) so a 1-game OOC opponent isn't rated +12

Outputs backend/data/team_strength.json:
  { "<season>": { "<team_id>": {"srs": float, "sos": float, "n": int} } }
where srs = team rating in runs/game vs an average team, sos = average rating
of opponents faced (the strength of schedule).

Run:  PYTHONPATH=backend python3 scripts/projections/compute_team_strength.py
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "backend"))
from app.models.database import get_connection  # noqa: E402

OUT = REPO / "backend" / "data" / "team_strength.json"
MARGIN_CAP = 10
REG_GAMES = 6      # pseudo-games at neutral margin (sample-size shrinkage)
ITERS = 100


def srs_for_season(games):
    """games: list of (home, away, home_score, away_score). Returns {team: srs}."""
    teams = set()
    margins = defaultdict(list)
    opps = defaultdict(list)
    for h, a, hs, as_ in games:
        teams.add(h); teams.add(a)
        m = max(-MARGIN_CAP, min(MARGIN_CAP, hs - as_))
        margins[h].append(m); opps[h].append(a)
        margins[a].append(-m); opps[a].append(h)
    # raw margin, regressed toward 0 by REG_GAMES neutral games
    # raw[t] = games-shrunk average margin; rating adds opponent strength,
    # also weighted by how many games we actually have on the team.
    raw = {t: sum(margins[t]) / (len(margins[t]) + REG_GAMES) for t in teams}
    rating = dict(raw)
    for _ in range(ITERS):
        new = {}
        for t in teams:
            sos = np.mean([rating[o] for o in opps[t]]) if opps[t] else 0.0
            n = len(margins[t])
            new[t] = raw[t] + sos * (n / (n + REG_GAMES))
        mu = np.mean(list(new.values()))
        rating = {t: new[t] - mu for t in teams}
    sos_out = {t: float(np.mean([rating[o] for o in opps[t]]) if opps[t] else 0.0) for t in teams}
    return rating, sos_out, {t: len(margins[t]) for t in teams}


def main():
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""SELECT season, home_team_id h, away_team_id a, home_score hs, away_score a_s
                       FROM games WHERE status='final'
                         AND home_score IS NOT NULL AND away_score IS NOT NULL
                         AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL
                         AND home_team_id <> away_team_id""")
        by_season = defaultdict(list)
        for r in cur.fetchall():
            by_season[r["season"]].append((r["h"], r["a"], r["hs"], r["a_s"]))
        cur.execute("SELECT id, short_name FROM teams")
        nm = {r["id"]: r["short_name"] for r in cur.fetchall()}

    out = {}
    for season, games in sorted(by_season.items()):
        rating, sos, ng = srs_for_season(games)
        out[str(season)] = {str(t): {"srs": round(rating[t], 3), "sos": round(sos[t], 3),
                                     "n": ng[t]} for t in rating}
        # report a couple of anchors per season
        ranked = sorted(rating.items(), key=lambda x: -x[1])
        std = np.std([v for v in rating.values()])
        print(f"{season}: {len(rating)} teams, SRS std={std:.2f}")

    OUT.write_text(json.dumps(out, indent=0))
    print(f"\nWrote {OUT}")

    # validation: 2026 PNW anchors
    print("\n2026 PNW anchors (srs / sos, higher = stronger):")
    s26 = out["2026"]
    for name in ["Oregon", "Oregon St", "Gonzaga", "Portland", "Seattle U",
                 "Lewis-Clark St", "Lower Columbia", "Bushnell"]:
        tid = next((str(t) for t, n in nm.items() if n == name), None)
        if tid and tid in s26:
            d = s26[tid]
            print(f"  {name:<18} srs {d['srs']:+.2f}  sos {d['sos']:+.2f}  ({d['n']} g)")


if __name__ == "__main__":
    main()
