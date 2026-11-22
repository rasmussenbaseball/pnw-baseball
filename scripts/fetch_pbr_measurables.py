#!/usr/bin/env python3
"""Store each recruit's public PBR profile measurables (internal only).

Why: rankings stop at the bottom of each state list, so every unranked
commit used to share one flat score. PBR's public player profiles carry
measurables for most commits from any state (fastball max, secondary velo,
exit velo, bat / hand speed, position velo, pop time, 60 time). The recruit
score model (backend/app/recruit_scoring.py) learns how those map to the
ranked players' scores and uses that to separate the unranked ones.

How: our programs' public PBR school pages list every commit with a profile
link. Each recruit in the class is matched by spelling-tolerant name + class,
then his profile is fetched directly (PBR serves the server and a home IP;
no ScraperAPI) and parsed. Results go to recruits.pbr_profile_url and
recruits.measurables (jsonb). Nothing here is shown on the site.

    PYTHONPATH=backend python3 scripts/fetch_pbr_measurables.py --grad-years 2026 2027 [--refresh-days 60]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.models.database import get_connection  # noqa: E402
from app import recruit_scoring as rs  # noqa: E402
import scrape_recruits as sr  # noqa: E402

PBR = "https://www.prepbaseballreport.com"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
SCHOOL_MAP = Path(__file__).resolve().parent.parent / "backend" / "data" / "recruit_school_map.json"

_LABELS = {
    "60 TIME": "sixty", "10 YD": "ten_yd", "INF VELO": "inf_velo", "OF VELO": "of_velo",
    "C VELO": "c_velo", "POP TIME": "pop", "EXIT VELO": "exit_velo", "HAND SPEED": "hand_speed",
    "BAT SPEED": "bat_speed", "FB MAX": "fb_max", "FB SPIN RATE": "fb_spin",
    "CB": "cb", "SL": "sl", "CH": "ch", "SPL": "spl", "CT": "ct",
}
_PAIR = re.compile(r"(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s+("
                   + "|".join(re.escape(k) for k in sorted(_LABELS, key=len, reverse=True)) + r")\b")


def parse_profile(html: str) -> dict:
    """Measurables from the profile's snapshot strip (the part before
    'Commitment' / 'Videos'). A range like 66-69 CB keeps the top number."""
    text = BeautifulSoup(html, "html.parser").get_text(" ", strip=True)
    i = text.find("State Rankings available")
    seg = text[i:] if i >= 0 else text
    for stop in ("Commitment (", "Videos", "Best Of"):
        j = seg.find(stop)
        if j > 0:
            seg = seg[:j]
            break
    out = {}
    for lo, hi, lab in _PAIR.findall(seg):
        key = _LABELS[lab]
        if key not in out:
            out[key] = float(hi or lo)
    return out


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", sr.norm_name(name)).strip("-")


def guess_profile(session, first, last, state, grad_year):
    """Many PBR profiles live at /profiles/<ST>/<first>-<last>. Accept a guess
    only if the page shows the player's last name and his class year, so a
    namesake from another class never slips in."""
    if not state or not first or not last:
        return None, None
    path = f"/profiles/{state.upper()}/{_slug(first)}-{_slug(last)}"
    try:
        r = session.get(PBR + path, timeout=30)
    except requests.RequestException:
        return None, None
    if r.status_code != 200:
        return None, None
    head = BeautifulSoup(r.text, "html.parser").get_text(" ", strip=True)[:4000].lower()
    if sr.norm_name(last) in sr.norm_name(head) and str(grad_year) in head:
        return path, r.text
    return None, None


def school_profiles(session, codes, years):
    """{(grad_year, canon_name): profile_path} from our programs' PBR school pages."""
    out = {}
    for code in codes:
        try:
            r = session.get(f"{PBR}/schools/{code}", timeout=30)
        except requests.RequestException:
            continue
        if r.status_code != 200:
            continue
        soup = BeautifulSoup(r.text, "html.parser")
        for tr in soup.select("tbody tr"):
            td = tr.find_all("td")
            if len(td) < 5:
                continue
            a = td[0].find("a")
            try:
                gy = int(td[3].get_text(strip=True))
            except ValueError:
                continue
            if gy in years and a and a.get("href"):
                out[(gy, sr.canon_name_key(td[0].get_text(" ", strip=True)))] = a["href"]
        time.sleep(0.6)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--grad-years", nargs="+", type=int, default=[2027])
    ap.add_argument("--refresh-days", type=int, default=60, help="re-fetch profiles older than this")
    ap.add_argument("--delay", type=float, default=1.0)
    args = ap.parse_args()
    years = set(args.grad_years)

    s = requests.Session()
    s.headers.update({"User-Agent": UA})
    codes = sorted({v["pbr_code"] for v in json.loads(SCHOOL_MAP.read_text()).values() if v.get("pbr_code")})
    links = school_profiles(s, codes, years)
    print(f"school pages: {len(links)} commit profile links for {sorted(years)}")

    cutoff = datetime.now(timezone.utc) - timedelta(days=args.refresh_days)
    with get_connection() as conn:
        cur = conn.cursor()
        for stmt in ("ALTER TABLE recruits ADD COLUMN IF NOT EXISTS pbr_profile_url text",
                     "ALTER TABLE recruits ADD COLUMN IF NOT EXISTS measurables jsonb",
                     "ALTER TABLE recruits ADD COLUMN IF NOT EXISTS measurables_at timestamptz"):
            cur.execute(stmt)
        conn.commit()
        cur.execute("""SELECT id, first_name, last_name, grad_year, state, pbr_profile_url, measurables_at
                       FROM recruits WHERE grad_year = ANY(%s)""", (list(years),))
        todo, guesses = [], []
        for r in cur.fetchall():
            if r["measurables_at"] and r["measurables_at"] > cutoff:
                continue
            path = r["pbr_profile_url"] or links.get((r["grad_year"], sr.canon_name_key(f"{r['first_name']} {r['last_name']}")))
            if path:
                todo.append((r["id"], path))
            else:
                guesses.append(r)
        # Commits at programs PBR has no school page for (WOU, NNU, Whitworth,
        # L&C, OIT, Olympic, Columbia Basin) or that PBR files elsewhere.
        found = 0
        for r in guesses:
            path, html = guess_profile(s, r["first_name"], r["last_name"], r["state"], r["grad_year"])
            time.sleep(args.delay)
            if path:
                found += 1
                cur.execute("""UPDATE recruits SET pbr_profile_url = %s, measurables = %s, measurables_at = now()
                               WHERE id = %s""", (path, json.dumps(parse_profile(html)), r["id"]))
        conn.commit()
        print(f"guessed profile URLs: {found} of {len(guesses)} recruits without a school-page link")
        print(f"fetching {len(todo)} profiles")
        got = empty = failed = 0
        for n, (rid, path) in enumerate(todo, 1):
            url = path if path.startswith("http") else PBR + path
            try:
                resp = s.get(url, timeout=30)
                m = parse_profile(resp.text) if resp.status_code == 200 else None
            except requests.RequestException:
                m = None
            if m is None:
                failed += 1
            else:
                got += bool(m)
                empty += not m
                cur.execute("""UPDATE recruits SET pbr_profile_url = %s, measurables = %s, measurables_at = now()
                               WHERE id = %s""", (path, json.dumps(m), rid))
            if n % 50 == 0:
                conn.commit()
                print(f"  {n}/{len(todo)}  with measurables {got}, empty {empty}, failed {failed}", flush=True)
            time.sleep(args.delay)
        conn.commit()
        print(f"done: {got} with measurables, {empty} profiles without any, {failed} failed")
        for gy in sorted(years):
            n = rs.rescore_class(cur, gy)
            print(f"rescored {gy}: {n} recruits; model {getattr(rs.rescore_class, 'last_model', {})}")
        conn.commit()


if __name__ == "__main__":
    main()
