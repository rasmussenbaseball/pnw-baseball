"""
Update NWAC player commitment statuses.
Usage: PYTHONPATH=backend python3 scripts/update_commitments.py
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

from app.models.database import get_connection

# (last_name, first_name, team_short_name) -> committed_to
COMMITMENTS = [
    ("Davidson", "Sam", "Lower Columbia", "Utah Tech"),
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
    ("Mar", "Ethan", "Tacoma", "Washington"),
    ("Hendrix", "Basil", "Everett", "George Mason"),
    ("Wickstrom", "Sawyer", "Everett", "East Carolina"),
    ("Stenerson", "Silas", "Olympic", "Freed-Hardeman"),
    ("Allen", "Hunter", "Mt. Hood", "Western Oregon"),
    ("Fleming", "Chase", "Big Bend", "Jessup University"),
    ("Taguchi", "Rylan", "Clark", "Friends University"),
    ("Lee", "Jacob", "Clark", "Warner Pacific"),
    ("Brown", "Seamus", "Olympic", "Saint Martin's"),
    ("Berens", "Trig", "Clark", "Friends University"),
    ("Robinson", "Cole", "Clark", "Warner Pacific"),
    ("Maunu", "Garrett", "Clark", "Bellevue University"),
    ("McIntyre", "Jordan", "Treasure Valley", "Saint Martin's"),
    ("Walker", "Jackson", "Yakima Valley", "Saint Louis University"),
    # June 10, 2026 batch
    ("Jones", "Dillon", "Wenatchee Valley", "Lewis-Clark State"),
    ("Furuhata", "Daichi", "SW Oregon", "Saint Martin's"),
    ("Ringrose", "Tristan", "Pierce", "Lewis-Clark State"),
    # June 11, 2026 batch
    ("Robbins", "Jeremiah", "Umpqua", "Lewis-Clark State"),
    ("Camper", "Jackson", "Edmonds", "Saint Martin's"),
    ("Dyer", "Dylan", "Everett", "Charleston Southern"),
    ("Petty", "Liam", "Chemeketa", "Lewis-Clark State"),
    # June 12, 2026 batch ("Triston" is the DB/roster spelling)
    ("Wallace", "Triston", "Umpqua", "Lewis-Clark State"),
    ("Metzker", "Aiden", "Umpqua", "Western Oregon"),
    # June 15, 2026 batch
    ("Long", "Kaleb", "SW Oregon", "Ave Maria"),
    ("Hansen", "Karsten", "Lower Columbia", "Marshall"),
]

# (last_name, first_name, team_short_name) — players to set back to uncommitted.
# Use this when a recruit decommits or changes plans.
UNCOMMITS = [
    ("Tordiffe", "Anderson", "Clackamas"),
]

def main():
    with get_connection() as conn:
        # Autocommit so each statement releases its row locks immediately.
        # lock_timeout/statement_timeout make the script fail fast (instead of
        # hanging silently) if another session holds a lock on the players table.
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute("SET lock_timeout = '5s'")
        cur.execute("SET statement_timeout = '15s'")
        # Real commitment timestamp (June 2026). The commitments feed used to
        # sort by players.updated_at, which any scraper write re-stamps —
        # commitment dates drifted. Backfill existing committed players once.
        cur.execute("ALTER TABLE players ADD COLUMN IF NOT EXISTS commitment_date TIMESTAMP")
        cur.execute("""
            UPDATE players SET commitment_date = updated_at
            WHERE is_committed = 1 AND committed_to IS NOT NULL AND commitment_date IS NULL
        """)
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

                # Stamp commitment_date too — the commitments feed and the
                # homepage recruiting widget sort by it, and without this the
                # column kept whatever stale default it had.
                cur.execute("""
                    UPDATE players
                    SET is_committed = 1, committed_to = %s, commitment_date = NOW()
                    WHERE id = %s
                """, (committed_to, pid))
                print(f"  ✓ {first} {last} ({team_short}) → {committed_to}")
                updated += 1

        # ── Clear commitments for any players in UNCOMMITS ──
        cleared = 0
        for last, first, team_short in UNCOMMITS:
            cur.execute("""
                SELECT p.id, p.is_committed, p.committed_to
                FROM players p
                JOIN teams t ON p.team_id = t.id
                WHERE LOWER(p.last_name) = LOWER(%s)
                  AND LOWER(p.first_name) = LOWER(%s)
                  AND LOWER(t.short_name) = LOWER(%s)
            """, (last, first, team_short))

            rows = cur.fetchall()
            if not rows:
                not_found.append(f"  {first} {last} ({team_short}) [uncommit]")
                continue

            for row in rows:
                pid = row['id']
                if not row['is_committed'] and not row['committed_to']:
                    print(f"  SKIP {first} {last} ({team_short}) — already uncommitted")
                    continue
                cur.execute("""
                    UPDATE players
                    SET is_committed = 0, committed_to = NULL
                    WHERE id = %s
                """, (pid,))
                print(f"  ✗ {first} {last} ({team_short}) — cleared (was {row['committed_to']})")
                cleared += 1

        print(f"\nUpdated {updated} players, cleared {cleared}")
        if not_found:
            print(f"\nNot found ({len(not_found)}):")
            for nf in not_found:
                print(nf)

if __name__ == "__main__":
    main()
