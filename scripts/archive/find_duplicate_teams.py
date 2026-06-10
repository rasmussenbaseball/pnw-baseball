"""
Find duplicate team records — same school listed twice with slightly
different names (e.g. "Occidental" + "Occidental College").

Strategy: normalize each team's name by stripping common suffixes
("College", "University", "(CA)", trailing punctuation) and lowercasing.
Group teams whose normalized name matches. Anything with 2+ teams in
the same normalized group is a candidate duplicate.

Output also shows: roster size, game count, phantom count per team
— useful for picking which one is canonical.

Run on Mac:
    cd ~/Desktop/pnw-baseball
    PYTHONPATH=backend python3 scripts/find_duplicate_teams.py
"""
from __future__ import annotations
import sys
import re
from collections import defaultdict

from app.models.database import get_connection


# Normalize the team name to a canonical key for grouping.
TRIM_RE = re.compile(
    r"(?:\s+university\b|\s+college\b|\s+\((?:ca|or|wa|id|mt)\)$)",
    re.IGNORECASE,
)
PUNCT_RE = re.compile(r"[^\w\s]")


def normalize(name: str) -> str:
    if not name:
        return ""
    s = TRIM_RE.sub("", name)
    s = PUNCT_RE.sub("", s)
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s


def main() -> int:
    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute("""
            SELECT t.id, t.name, t.short_name, t.school_name, t.state,
                   c.abbreviation AS conf, d.level AS div,
                   (SELECT COUNT(*) FROM players WHERE team_id = t.id) AS n_roster,
                   (SELECT COUNT(*) FROM players WHERE team_id = t.id AND is_phantom = TRUE) AS n_phantom,
                   (SELECT COUNT(*) FROM players WHERE team_id = t.id AND is_phantom = FALSE) AS n_real,
                   (SELECT COUNT(*) FROM games WHERE home_team_id = t.id OR away_team_id = t.id) AS n_games
            FROM teams t
            LEFT JOIN conferences c ON c.id = t.conference_id
            LEFT JOIN divisions d   ON d.id = c.division_id
        """)
        teams = list(cur.fetchall())

        # Group by normalized name
        groups = defaultdict(list)
        for t in teams:
            key = normalize(t["name"] or t["short_name"] or t["school_name"] or "")
            if key:
                groups[key].append(t)

        # Find groups with multiple teams
        duplicates = {k: v for k, v in groups.items() if len(v) > 1}
        print(f"Total teams: {len(teams)}")
        print(f"Duplicate groups: {len(duplicates)}")
        print()

        for key, group in sorted(duplicates.items()):
            # Sort: most active first (more games / more real roster wins)
            group.sort(key=lambda t: (-(t["n_real"] or 0), -(t["n_games"] or 0), t["id"]))
            print(f"── '{key}' ({len(group)} entries) ──")
            for t in group:
                marker = " ← CANONICAL?" if t == group[0] else ""
                print(f"  id={t['id']:>5}  short={(t['short_name'] or '?'):<10}  "
                      f"name={(t['name'] or '?'):<35}  "
                      f"div={(t['div'] or '?'):<6}  conf={(t['conf'] or '?'):<5}  "
                      f"roster={t['n_real']:>3}+{t['n_phantom']:>3}p  "
                      f"games={t['n_games']:>3}{marker}")
            print()

    return 0


if __name__ == "__main__":
    sys.exit(main())
