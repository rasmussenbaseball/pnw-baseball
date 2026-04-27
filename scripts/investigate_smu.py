"""
Investigate the SMU player resolution mystery.

Top unresolved pitcher names showed "Nikki Scott" (80 events) and
"Scott,Nikki" (54 events) — same person, different formats — on team
short_name='SMU' (id=6) which has 125 rostered players. But no player
on team_id=6 has last name "Scott". Either:
  (a) team_id=6 is the wrong SMU — events are being routed to it from
      a different SMU's PBP page
  (b) SMU is the right team but the roster scrape missed Scott
  (c) something else

Run on Mac:
    cd ~/Desktop/pnw-baseball
    PYTHONPATH=backend python3 scripts/investigate_smu.py
"""
from __future__ import annotations
import sys
from app.models.database import get_connection


def main() -> int:
    with get_connection() as conn:
        cur = conn.cursor()

        # 1. What is team_id=6?
        print("── 1. team_id=6 details ──")
        cur.execute("""
            SELECT t.id, t.name, t.short_name, t.school_name, t.state,
                   c.name AS conference, c.abbreviation AS conf_abbrev,
                   d.name AS division, d.level
            FROM teams t
            LEFT JOIN conferences c ON c.id = t.conference_id
            LEFT JOIN divisions d   ON d.id = c.division_id
            WHERE t.id = 6
        """)
        r = cur.fetchone()
        if r:
            for k, v in dict(r).items():
                print(f"  {k}: {v}")

        # 2. How many other teams have 'SMU' or 'Saint Mart' in their name?
        print("\n── 2. Other 'SMU'-ish teams in the DB ──")
        cur.execute("""
            SELECT t.id, t.name, t.short_name, t.state,
                   d.level, c.abbreviation AS conf,
                   (SELECT COUNT(*) FROM players WHERE team_id = t.id AND roster_year = 2026) AS roster_2026
            FROM teams t
            LEFT JOIN conferences c ON c.id = t.conference_id
            LEFT JOIN divisions d   ON d.id = c.division_id
            WHERE t.short_name ILIKE %s
               OR t.name ILIKE %s
               OR t.school_name ILIKE %s
            ORDER BY t.id
        """, ("%smu%", "%saint mart%", "%saint mart%"))
        for r in cur.fetchall():
            print(f"  id={r['id']:>5}  short={r['short_name']:<10}  "
                  f"name={r['name']:<35}  state={r['state'] or '?':<3}  "
                  f"div={r['level']:<6}  conf={r['conf'] or '?':<5}  "
                  f"roster_2026={r['roster_2026']}")

        # 3. Are there any players named Scott on team_id=6 (any season)?
        print("\n── 3. Players named Scott on team_id=6 (any season) ──")
        cur.execute("""
            SELECT id, first_name, last_name, position, year_in_school,
                   roster_year, is_phantom
            FROM players
            WHERE team_id = 6
              AND (LOWER(last_name) LIKE %s OR LOWER(first_name) LIKE %s)
            ORDER BY roster_year DESC NULLS LAST, last_name, first_name
        """, ("%scott%", "%scott%"))
        rows = list(cur.fetchall())
        if not rows:
            print("  (no players named Scott on team_id=6)")
        for r in rows:
            print(f"  id={r['id']}  {r['first_name']} {r['last_name']}  "
                  f"pos={r['position']}  yr={r['year_in_school']}  "
                  f"roster_year={r['roster_year']}  phantom={r['is_phantom']}")

        # 4. Where does Nikki Scott actually exist in our players table?
        print("\n── 4. Players named 'Scott' or 'Nikki' anywhere ──")
        cur.execute("""
            SELECT p.id, p.first_name, p.last_name, p.team_id, p.position,
                   p.roster_year, p.is_phantom,
                   t.short_name, t.name AS team_name, d.level
            FROM players p
            LEFT JOIN teams t       ON t.id = p.team_id
            LEFT JOIN conferences c ON c.id = t.conference_id
            LEFT JOIN divisions d   ON d.id = c.division_id
            WHERE LOWER(p.first_name) = 'nikki'
               OR (LOWER(p.last_name) = 'scott' AND LOWER(p.first_name) LIKE 'n%%')
               OR p.last_name = 'Scott'  -- exact case
            ORDER BY t.short_name, p.last_name
            LIMIT 25
        """)
        for r in cur.fetchall():
            print(f"  id={r['id']:>6}  {r['first_name']} {r['last_name']:<20}  "
                  f"team_id={r['team_id']:>5}  ({r['short_name']:<8}/{r['team_name']:<25}  "
                  f"div={r['level']:<6})  roster={r['roster_year']}  "
                  f"phantom={r['is_phantom']}")

        # 5. Pick one game where Nikki Scott appeared as the unresolved
        #    pitcher. What URL did the PBP come from? That will reveal
        #    which school's page actually generated the data.
        print("\n── 5. A few games where 'Nikki Scott' appeared as a pitcher ──")
        cur.execute("""
            SELECT DISTINCT g.id AS game_id, g.game_date, g.source_url,
                   g.home_team_id, g.away_team_id,
                   th.short_name AS home_short, ta.short_name AS away_short,
                   ge.defending_team_id
            FROM game_events ge
            JOIN games g   ON g.id = ge.game_id
            JOIN teams th  ON th.id = g.home_team_id
            JOIN teams ta  ON ta.id = g.away_team_id
            WHERE g.season = 2026
              AND ge.pitcher_name ILIKE '%%nikki%%scott%%'
                OR ge.pitcher_name ILIKE '%%scott%%nikki%%'
            ORDER BY g.game_date DESC
            LIMIT 5
        """)
        for r in cur.fetchall():
            print(f"  game {r['game_id']:>5}  {r['game_date']}  "
                  f"{r['away_short']} @ {r['home_short']}")
            print(f"    URL: {r['source_url']}")
            print(f"    home_team_id={r['home_team_id']}  away_team_id={r['away_team_id']}  "
                  f"defending_team_id={r['defending_team_id']}")

        # 6. Which team_ids are showing up most often as defending team
        #    when Nikki Scott pitches? If it's varied, we have a name-
        #    matching problem; if it's always the same wrong team_id,
        #    that team_id is the issue.
        print("\n── 6. Top defending_team_ids for events with 'Nikki Scott' ──")
        cur.execute("""
            SELECT t.id, t.short_name, t.name, COUNT(*) AS n
            FROM game_events ge
            LEFT JOIN teams t ON t.id = ge.defending_team_id
            JOIN games g ON g.id = ge.game_id
            WHERE g.season = 2026
              AND (ge.pitcher_name ILIKE '%%nikki%%scott%%'
                   OR ge.pitcher_name ILIKE '%%scott%%nikki%%')
            GROUP BY t.id, t.short_name, t.name
            ORDER BY n DESC
        """)
        for r in cur.fetchall():
            print(f"  team_id={r['id']:>5}  short={r['short_name']:<10}  "
                  f"name={r['name']:<40}  n={r['n']}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
