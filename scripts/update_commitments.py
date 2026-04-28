"""
Update NWAC player commitment statuses.
Usage: PYTHONPATH=backend python3 scripts/update_commitments.py
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

from app.models.database import get_connection

# (last_name, first_name, team_short_name) -> committed_to
COMMITMENTS = [
    ("Davidson", "Samuel", "Lower Columbia", "Utah Tech"),
    ("Hubbs", "Quinn", "Lower Columbia", "Gonzaga"),
    ("Kosderka", "Matthew", "Lower Columbia", "Western Kentucky"),
    ("Rowe", "Harlan", "Lower Columbia", "Old Dominion"),
    ("Spanier", "Caden", "Lower Columbia", "Akron"),
    ("Reeser", "Gage", "Yakima Valley", "Washington State"),
    ("Green", "Trace", "Walla Walla", "Bushnell"),
    ("Moses-Gomera", "Nakoa", "Walla Walla", "Bushnell"),
    ("Perlinski", "Carter", "Wenatchee Valley", "Lewis-Clark State"),
    ("Palmer", "Luke", "Walla Walla", "Montana State Billings"),
    ("Figuered", "Noah", "Edmonds", "University of Pacific"),
    ("Roth", "Jacob", "Blue Mountain", "Lewis-Clark State"),
    ("Kakuda", "Dylan", "Walla Walla", "Bethany Lutheran"),
    ("Wagner", "Wiley", "Walla Walla", "Lewis-Clark State"),
    ("Scott", "Griffin", "Lane", "Oregon"),
    ("Price", "Kenneth", "Lane", "Old Dominion"),
    ("Hooper", "Wyatt", "Chemeketa", "Western Oregon"),
    ("Pashales", "Jase", "Clark", "Lewis-Clark State"),
    ("Arnold", "Levi", "Edmonds", "Vanguard University"),
    ("Gooler", "Garren", "Yakima Valley", "Portland"),
    ("Greenough-Groom", "Dylan", "Spokane", "New Mexico State"),
    ("Boyd", "Braiden", "Spokane", "New Mexico State"),
    ("Snyder", "Boston", "Yakima Valley", "Utah"),
    ("Hirai", "Alex", "Big Bend", "Warner Pacific"),
    ("Imai", "Yuji", "Olympic", "Tabor College"),
    ("Tordiffe", "Anderson", "Clackamas", "Washington State"),
]

def main():
    with get_connection() as conn:
        cur = conn.cursor()
        updated = 0
        not_found = []

        for last, first, team_short, committed_to in COMMITMENTS:
            # Find the player by name + team short_name
            cur.execute("""
                SELECT p.id, p.first_name, p.last_name, t.short_name,
                       p.is_committed, p.committed_to
                FROM players p
                JOIN teams t ON p.team_id = t.id
                WHERE LOWER(p.last_name) = LOWER(%s)
                  AND LOWER(p.first_name) = LOWER(%s)
                  AND LOWER(t.short_name) = LOWER(%s)
            """, (last, first, team_short))

            rows = cur.fetchall()
            if not rows:
                not_found.append(f"  {first} {last} ({team_short})")
                continue

            for row in rows:
                pid = row['id']
                already = row['committed_to']
                if already and already == committed_to:
                    print(f"  SKIP {first} {last} ({team_short}) — already committed to {committed_to}")
                    continue

                cur.execute("""
                    UPDATE players
                    SET is_committed = 1, committed_to = %s
                    WHERE id = %s
                """, (committed_to, pid))
                print(f"  ✓ {first} {last} ({team_short}) → {committed_to}")
                updated += 1

        conn.commit()
        print(f"\nUpdated {updated} players")
        if not_found:
            print(f"\nNot found ({len(not_found)}):")
            for nf in not_found:
                print(nf)

if __name__ == "__main__":
    main()
