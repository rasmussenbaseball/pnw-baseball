"""
Scrape TRUE national run environments per level (and per conference) from each
level's own stats site, so projections can blend 50% conference + 50% full-level
run environment (next-season only) and the About page can show the difference.

We pull a single team-stats LEADERBOARD per level (never per-team crawling):
  • NAIA  -> naiastats.prestosports.com  (PrestoSports, server-rendered with
            ?sort=&pos=h&r=0; /conf/<slug>/teams for a conference).  Works anywhere.
  • D1    -> warrennolan.com offense/defense runs-per-game (no WAF).  Level only;
            WarrenNolan's R/G is already vs-D1-opponents-only, a clean environment.
  • D1/D2/D3 (+ conferences) -> stats.ncaa.org team rankings via ScraperAPI
            (stats.ncaa.org is WAF-blocked, so this needs SCRAPER_API_KEY and is
            meant to run on the SERVER or a GitHub Action, like the NWAC pipeline).

Run env value = runs per TEAM-game (sum team runs / sum team games). Stored both
scored + allowed; `runs_pg` (both teams) ~= rs_pg + ra_pg.

Writes backend/data/run_environments.json:
  { "season": 2026,
    "levels": { "NAIA": {"national": {rs_pg, ra_pg, runs_pg, teams},
                         "conferences": {"Cascade Collegiate Conference": {...}}},
                "D1": {...}, ... } }

    PYTHONPATH=backend python3 scripts/scrape_run_environments.py            # NAIA + D1
    PYTHONPATH=backend python3 scripts/scrape_run_environments.py --ncaa     # + D1/D2/D3 via ScraperAPI (server)
"""
import os
import sys
import json
import argparse
import statistics
from pathlib import Path

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

OUT = Path(__file__).resolve().parent.parent / "backend" / "data" / "run_environments.json"
NAIA_SEASON = "2025-26"
SEASON = 2026
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"}

# Conferences our PNW teams actually play in — what the About page compares the
# national level against. NAIA slug is the PrestoSports conf path segment.
OUR_NAIA_CONF = ("Cascade Collegiate Conference", "cascade")


def _runenv_from_presto(url):
    """(rs_pg, ra_pg, teams) from a PrestoSports team-stats leaderboard page.
    Batting 'scoring' table gives gp + r (runs scored); pitching table gives r
    (runs allowed). Sum across teams -> runs per team-game."""
    soup = BeautifulSoup(requests.get(url, timeout=120, headers=UA).text, "html.parser")
    tbls = soup.find_all("table")

    def heads(t):
        return [th.get_text(strip=True).lower() for th in t.find_all("th")]

    def col(t, name):
        idx = heads(t).index(name)
        vals = []
        for tr in t.find_all("tr"):
            if not tr.find_all("td"):
                continue
            cells = [c.get_text(" ", strip=True) for c in tr.find_all(["th", "td"])]
            try:
                vals.append(float(cells[idx].replace(",", "")))
            except (ValueError, IndexError):
                vals.append(None)
        return vals

    bat = next(t for t in tbls if heads(t)[:4] == ["rk", "team", "gp", "r"])
    pit = next(t for t in tbls if "era" in heads(t) and "ip" in heads(t))
    gp, rs = col(bat, "gp"), col(bat, "r")
    ra = col(pit, "r")
    tg = sum(g for g in gp if g)
    trs = sum(r for r in rs if r is not None)
    tra = sum(r for r in ra if r is not None)
    n = sum(1 for g in gp if g)
    if not tg:
        return None
    return {"rs_pg": round(trs / tg, 3), "ra_pg": round(tra / tg, 3),
            "runs_pg": round((trs + tra) / tg, 3), "teams": n}


def scrape_naia():
    base = f"https://naiastats.prestosports.com/sports/bsb/{NAIA_SEASON}"
    out = {"national": _runenv_from_presto(f"{base}/teams?sort=&pos=h&r=0"),
           "conferences": {}}
    name, slug = OUR_NAIA_CONF
    conf = _runenv_from_presto(f"{base}/conf/{slug}/teams?sort=&pos=h&r=0")
    if conf:
        out["conferences"][name] = conf
    return out


def _warrennolan_level(stat):
    """Mean team runs/game from a WarrenNolan stat leaderboard (D1 only)."""
    url = f"https://www.warrennolan.com/college-baseball/stats/team/_/season/{SEASON}/stat/{stat}"
    soup = BeautifulSoup(requests.get(url, timeout=90, headers=UA).text, "html.parser")
    t = soup.find("table")
    import re
    vals = []
    for tr in t.find_all("tr"):
        if not tr.find_all("td"):
            continue
        txt = tr.get_text(" ", strip=True)
        # take the LAST decimal in 1.0–20.0 (the current R/G; ignores ranks, years)
        cands = [float(x) for x in re.findall(r"[0-9]+\.[0-9]+", txt)]
        cands = [v for v in cands if 1.0 <= v <= 20.0]
        if cands:
            vals.append(cands[-1])
    return (statistics.mean(vals), len(vals)) if vals else (None, 0)


def scrape_d1_warrennolan():
    rs, n = _warrennolan_level("offense-runs-per-game")
    ra, _ = _warrennolan_level("defense-runs-per-game")
    if rs is None:
        return None
    return {"national": {"rs_pg": round(rs, 3),
                         "ra_pg": round(ra, 3) if ra is not None else None,
                         "runs_pg": round(rs + (ra if ra is not None else rs), 3),
                         "teams": n},
            "conferences": {}}


def scrape_ncaa_via_scraperapi(levels=("1", "2", "3")):
    """D1/D2/D3 level + conference run environments from stats.ncaa.org via
    ScraperAPI (WAF bypass). Runs on the SERVER / GH Action where SCRAPER_API_KEY
    exists. Returns {} (and logs) if the key is absent so local runs degrade
    gracefully. NOTE: stats.ncaa.org ranking-id discovery is finalized on the
    server where the page is reachable."""
    key = os.getenv("SCRAPER_API_KEY")
    if not key:
        print("  [ncaa] SCRAPER_API_KEY not set — skipping D1/D2/D3 (run on server).")
        return {}
    # Placeholder for the server pass: fetch stats.ncaa.org team 'Scoring' and
    # 'Scoring Defense' rankings per division (all teams, with conference) and
    # aggregate to level + per-conference runs/team-game. Implemented/iterated on
    # the server where stats.ncaa.org is reachable through ScraperAPI.
    print("  [ncaa] ScraperAPI present — server pass not yet wired; see runbook.")
    return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ncaa", action="store_true", help="also pull D1/D2/D3 via ScraperAPI (server)")
    args = ap.parse_args()

    # Preserve anything already scraped (so a local NAIA+D1 run doesn't wipe a
    # prior server NCAA pass, and vice-versa).
    data = {"season": SEASON, "levels": {}}
    if OUT.exists():
        try:
            data = json.loads(OUT.read_text())
            data.setdefault("levels", {})
        except Exception:
            pass

    print("NAIA (PrestoSports)…")
    data["levels"]["NAIA"] = scrape_naia()
    print("D1 (WarrenNolan)…")
    d1 = scrape_d1_warrennolan()
    if d1:
        # keep any conference data a prior NCAA pass attached
        prior = data["levels"].get("D1", {}).get("conferences", {})
        d1["conferences"] = {**prior, **d1["conferences"]}
        data["levels"]["D1"] = d1

    if args.ncaa:
        print("D1/D2/D3 (stats.ncaa.org via ScraperAPI)…")
        for lvl, res in scrape_ncaa_via_scraperapi().items():
            data["levels"][lvl] = res

    OUT.write_text(json.dumps(data, indent=2) + "\n")
    print(f"\nWrote {OUT}")
    for lvl, d in data["levels"].items():
        nat = d.get("national") or {}
        confs = d.get("conferences") or {}
        print(f"  {lvl}: national runs/G={nat.get('runs_pg')} ({nat.get('teams')} teams)"
              + ("".join(f" | {c} {v.get('runs_pg')}" for c, v in confs.items())))


if __name__ == "__main__":
    main()
