#!/usr/bin/env python3
"""Count total freshmen (Fr / R-Fr) on each four-year program's roster for a season.

Why this exists: rostered-but-didn't-play freshmen (redshirts, deep bench) never get
a row in our stats DB, so the "how many freshmen were rostered" number can't be
derived from a query — it has to be read off the archived roster pages. This script
re-parses those rosters (reusing the same parsers as backfill_player_seasons.py) and
prints the per-division totals to paste into FRESHMAN_ROSTERED in routes.py.

NWAC is intentionally excluded: its rosters don't publish class consistently, so we
can't tell a freshman from an upperclassman there.

Usage:  PYTHONPATH=backend python3 scripts/count_rostered_freshmen.py [SEASON]
"""
import sys
import os
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
from backfill_player_seasons import NUXT_TEAMS, SIDEARM_TEAMS, fetch_roster_classes  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))
from app.models.database import get_connection  # noqa: E402

FRESH = ('Fr', 'R-Fr')
FOUR_YEAR = ('D1', 'D2', 'NAIA', 'D3')


def main(season: int):
    teams = {**NUXT_TEAMS, **SIDEARM_TEAMS}
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT t.short_name, d.level FROM teams t "
            "JOIN conferences c ON t.conference_id=c.id "
            "JOIN divisions d ON c.division_id=d.id WHERE t.short_name = ANY(%s)",
            (list(teams),),
        )
        div = {r['short_name']: r['level'] for r in cur.fetchall()}

    rostered = defaultdict(int)
    for short, base in teams.items():
        lvl = div.get(short)
        if lvl not in FOUR_YEAR:
            continue
        classes = fetch_roster_classes(base, season, short in NUXT_TEAMS)
        fr = sum(1 for c in classes.values() if c in FRESH)
        rostered[lvl] += fr
        print(f"  {short:<22} {lvl:<5} {fr} freshmen")

    print(f"\nFRESHMAN_ROSTERED entry for {season}:")
    print("    %d: {%s}," % (
        season,
        ", ".join(f'"{lvl}": {rostered[lvl]}' for lvl in FOUR_YEAR),
    ))


if __name__ == '__main__':
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 2026)
