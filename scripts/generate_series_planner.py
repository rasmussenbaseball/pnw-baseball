#!/usr/bin/env python3
"""
Series Planner batch generator.

Builds the per-team aggregate "records" the live /portal/series-planner endpoint
needs, and dumps them (plus per-hitter spray) to backend/data/series_planner.json.

The heavy work (crunching full-league leaderboards, fetching ~500 hitters' spray)
happens here, once per day. The live endpoint then runs the cheap per-pairing
planning logic on any (own team, opponent) combination — so every coach sees
THEIR team as the "our" side without us pre-generating 57×57 plans.

Data comes from our own public leaderboard API. Point --base at the running
API (default http://localhost:8000/api/v1, i.e. the nwbb service on the server);
override with --base https://nwbaseballstats.com/api/v1 to run from anywhere.

Usage:
    PYTHONPATH=backend python3 scripts/generate_series_planner.py --season 2026
    PYTHONPATH=backend python3 scripts/generate_series_planner.py --base https://nwbaseballstats.com/api/v1
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.api.series_planner import make_team_record, grade_strengths  # noqa: E402
from app.config import CURRENT_SEASON  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = REPO_ROOT / "backend" / "data" / "series_planner.json"


def get_json(base, path, params=None, retries=3, timeout=35):
    url = base + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    last_exc = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as response:
                return json.load(response)
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if attempt < retries - 1:
                time.sleep(0.6 * (attempt + 1))
    raise last_exc


def load(base, label, path, params=None):
    print(f"loading {label}...", flush=True)
    return get_json(base, path, params)


def group(rows):
    out = {}
    for row in rows:
        out.setdefault(row.get("team_id"), []).append(row)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=CURRENT_SEASON)
    ap.add_argument("--base", default=os.environ.get("NWBB_API_BASE", "http://localhost:8000/api/v1"))
    ap.add_argument("--out", default=str(OUT_PATH))
    ap.add_argument("--max-spray", type=int, default=4, help="spray-fetch thread pool size (keep low for single-worker APIs)")
    args = ap.parse_args()
    season, base = args.season, args.base.rstrip("/")
    print(f"Series Planner generator · season {season} · base {base}", flush=True)

    teams = [t for t in load(base, "teams", "/teams") if t.get("is_active")]
    team_stats_rows = load(base, "team stats", "/team-stats", {"season": season})
    batting = load(base, "batting leaderboard", "/leaderboards/batting", {"season": season, "limit": 5000})["data"]
    pitching = load(base, "pitching leaderboard", "/leaderboards/pitching", {"season": season, "limit": 5000})["data"]
    batting_pbp = load(base, "batting pbp leaderboard", "/leaderboards/batting-pbp", {"season": season, "limit": 5000})["data"]
    pitching_pbp = load(base, "pitching pbp leaderboard", "/leaderboards/pitching-pbp", {"season": season, "limit": 5000})["data"]
    fielding = load(base, "fielding leaderboard", "/leaderboards/fielding", {"season": season, "limit": 5000})["data"]
    relievers = load(base, "reliever leaderboard", "/leaderboards/relievers", {"season": season, "limit": 5000})["data"]

    stats_by_team = {r["team_id"]: r for r in team_stats_rows}
    batting_by_team = group(batting)
    pitching_by_team = group(pitching)
    batting_pbp_by_team = group(batting_pbp)
    pitching_pbp_by_team = group(pitching_pbp)
    fielding_by_team = group(fielding)
    relievers_by_team = group(relievers)

    records = {}
    for team in teams:
        tid = team["id"]
        if tid not in stats_by_team:
            continue
        records[tid] = make_team_record(
            team,
            stats_by_team.get(tid),
            batting_by_team.get(tid, []),
            pitching_by_team.get(tid, []),
            batting_pbp_by_team.get(tid, []),
            pitching_pbp_by_team.get(tid, []),
            fielding_by_team.get(tid, []),
            relievers_by_team.get(tid, []),
        )
    print(f"built {len(records)} team records", flush=True)

    # Pre-compute strengths with full peer context so the live endpoint doesn't
    # need every team loaded just to grade one (it still passes peers, but this
    # bakes in a stable snapshot).
    peer_records = list(records.values())

    # Fetch spray only for each team's projected top-9 hitters.
    # Spray for anyone who might hit in a series (~8+ PA, up to 30/team) — the
    # Defensive Alignments card shows every such hitter, not just the regulars.
    spray_ids = set()
    for rec in records.values():
        top = sorted([h for h in rec["hitters"] if (h.get("plate_appearances") or 0) >= 8],
                     key=lambda r: r.get("plate_appearances") or 0, reverse=True)[:30]
        spray_ids.update(h.get("player_id") for h in top if h.get("player_id"))

    def fetch_spray(pid):
        try:
            return pid, get_json(base, f"/players/{pid}/pitch-level-stats", {"season": season}, retries=3, timeout=30)
        except Exception:  # noqa: BLE001
            return pid, None

    spray_by_player = {}
    ids = sorted(spray_ids)
    print(f"fetching spray for {len(ids)} hitters...", flush=True)
    done = 0
    with ThreadPoolExecutor(max_workers=args.max_spray) as pool:
        for fut in as_completed([pool.submit(fetch_spray, pid) for pid in ids]):
            pid, payload = fut.result()
            done += 1
            if done % 50 == 0 or done == len(ids):
                print(f"  spray {done}/{len(ids)}", flush=True)
            if payload:
                # Keep only the fields positioning uses — trims the file a lot.
                spray_by_player[pid] = {
                    "spray_chart": payload.get("spray_chart"),
                    "contact_profile": payload.get("contact_profile"),
                    "bats": payload.get("bats"),
                }

    data = {
        "season": season,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": base,
        "records": {str(tid): rec for tid, rec in records.items()},
        "spray": {str(pid): sp for pid, sp in spray_by_player.items()},
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    size_mb = out.stat().st_size / 1e6
    print(f"wrote {out} ({size_mb:.1f} MB) · {len(records)} teams · {len(spray_by_player)} spray", flush=True)


if __name__ == "__main__":
    main()
