"""Precompute All-Conference honors → backend/data/all_conference_honors.json.

Replays the /all-conference generator for each (season, conference) and records
every player who made a 1st team, 2nd team, or honorable mention, with position.
The player profile (/players/{id}) reads this snapshot — the live generator is
far too slow (~12s cold per conference) to run per profile request.

Re-run whenever stats change / at season freeze:
    PYTHONPATH=backend python3 scripts/compute_all_conference_honors.py

Covers the regional conferences the generator builds: GNAC (D2), NWC (D3),
CCC (NAIA), and the four NWAC (JUCO) divisions.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.api.all_conference import all_conference  # noqa: E402
from app.api.routes import _AC_REAL_KEYS, _AC_CONF_LABEL, _ac_norm_pos  # noqa: E402

SEASONS = [2024, 2025, 2026]
OUT = os.path.join(os.path.dirname(__file__), "..", "backend", "data", "all_conference_honors.json")


def main():
    honors, seen = [], set()
    for season in SEASONS:
        for key in _AC_REAL_KEYS:
            try:
                res = all_conference(conf=key, season=season)
            except Exception as e:
                print(f"  ! {key} {season}: {e}")
                continue
            if not isinstance(res, dict) or res.get("error"):
                continue
            label = _AC_CONF_LABEL.get(key, key)
            n0 = len(honors)
            for container, level in ((res.get("first_team"), "1st"),
                                     (res.get("second_team"), "2nd"),
                                     (res.get("honorable_mentions"), "HM")):
                for slot, v in (container or {}).items():
                    pos = _ac_norm_pos(slot)
                    for pl in (v if isinstance(v, list) else [v]):
                        if isinstance(pl, dict) and pl.get("player_id"):
                            k = (pl["player_id"], season, label, level, pos)
                            if k in seen:
                                continue
                            seen.add(k)
                            honors.append({"player_id": pl["player_id"], "season": season,
                                           "scope": label, "team": level, "position": pos})
            print(f"  {label} {season}: +{len(honors) - n0}")

    import datetime
    payload = {"updated": datetime.date.today().isoformat(), "honors": honors}
    with open(OUT, "w") as f:
        json.dump(payload, f, indent=2)
    print(f"\nWrote {len(honors)} honors to {OUT}")


if __name__ == "__main__":
    main()
