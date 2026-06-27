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


import re

# stats.ncaa.org TEAM "Scoring" ranking gives every team's G, total R, runs/game,
# and conference (in parens) in one table — exactly the run environment, with the
# conference split, in a single pull per division.
NCAA_SCORING_STAT_SEQ = 213
NCAA_DIV_LEVEL = {"1": "D1", "2": "D2", "3": "D3"}


def _scraperapi(url, key):
    return requests.get("https://api.scraperapi.com/",
                        params={"api_key": key, "url": url}, timeout=150).text


def _ncaa_final_period(div, key):
    """The 'Final Statistics' ranking_period id for a division (full-season)."""
    h = _scraperapi(f"https://stats.ncaa.org/rankings?sport_code=MBA&division={div}", key)
    soup = BeautifulSoup(h, "html.parser")
    sel = next((s for s in soup.find_all("select") if (s.get("name") or "") == "rp"), None)
    if sel:
        for o in sel.find_all("option"):
            if "final" in o.get_text(" ", strip=True).lower():
                return o.get("value", "").replace(".0", "")
        # fall back to the highest-numbered period (latest)
        ids = [o.get("value", "").replace(".0", "") for o in sel.find_all("option") if o.get("value")]
        ids = [i for i in ids if i.isdigit()]
        if ids:
            return max(ids, key=int)
    return None


def _ncaa_runenv(div, rp, key):
    """sum-runs / sum-games for a division's team Scoring ranking → level +
    per-conference run env (runs per team-game). Conference is in '(...)'."""
    url = (f"https://stats.ncaa.org/rankings/national_ranking?academic_year=2026.0"
           f"&division={div}.0&ranking_period={rp}.0&sport_code=MBA&stat_seq={NCAA_SCORING_STAT_SEQ}")
    soup = BeautifulSoup(_scraperapi(url, key), "html.parser")
    tbl = soup.find("table")
    if not tbl:
        return None
    heads = [th.get_text(strip=True).lower() for th in tbl.find_all("th")]
    try:
        gi, ri = heads.index("g"), heads.index("r")
    except ValueError:
        return None
    by_conf, tg, tr_ = {}, 0.0, 0.0
    for row in tbl.find_all("tr"):
        cells = [c.get_text(" ", strip=True) for c in row.find_all(["th", "td"])]
        if len(cells) <= max(gi, ri):
            continue
        m = re.search(r"\(([^)]+)\)", cells[1])
        try:
            g = float(cells[gi].replace(",", "")); r = float(cells[ri].replace(",", ""))
        except ValueError:
            continue
        if not g:
            continue
        tg += g; tr_ += r
        if m:
            c = m.group(1).strip()
            by_conf.setdefault(c, [0.0, 0.0])
            by_conf[c][0] += r; by_conf[c][1] += g
    if not tg:
        return None

    def env(r, g):  # runs/team-game; runs_pg (both teams) = 2x (league identity)
        rs = round(r / g, 3)
        return {"rs_pg": rs, "ra_pg": rs, "runs_pg": round(2 * rs, 3)}

    confs = {c: {**env(r, g), "teams": 0} for c, (r, g) in by_conf.items() if g}
    # team counts per conference
    for row in tbl.find_all("tr"):
        cells = [c.get_text(" ", strip=True) for c in row.find_all(["th", "td"])]
        if len(cells) > 1:
            m = re.search(r"\(([^)]+)\)", cells[1])
            if m and m.group(1).strip() in confs:
                confs[m.group(1).strip()]["teams"] += 1
    nat = env(tr_, tg)
    nat["teams"] = sum(1 for row in tbl.find_all("tr") if row.find_all("td"))
    return {"national": nat, "conferences": confs}


def scrape_ncaa_via_scraperapi(divs=("1", "2", "3")):
    """D1/D2/D3 level + per-conference run environments from stats.ncaa.org's team
    Scoring ranking, via ScraperAPI (the site is WAF-blocked). Needs SCRAPER_API_KEY."""
    key = os.getenv("SCRAPER_API_KEY")
    if not key:
        print("  [ncaa] SCRAPER_API_KEY not set — skipping D1/D2/D3.")
        return {}
    out = {}
    for div in divs:
        rp = _ncaa_final_period(div, key)
        if not rp:
            print(f"  [ncaa] div {div}: no ranking period found — skipping.")
            continue
        res = _ncaa_runenv(div, rp, key)
        if res:
            out[NCAA_DIV_LEVEL[div]] = res
            print(f"  [ncaa] {NCAA_DIV_LEVEL[div]} (rp {rp}): national {res['national']['runs_pg']} "
                  f"runs/G, {len(res['conferences'])} conferences")
    return out


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
