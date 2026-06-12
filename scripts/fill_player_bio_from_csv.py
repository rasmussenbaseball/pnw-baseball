"""
Fill missing player bio fields (bats / throws / year_in_school) from a
hand-completed CSV (intern workflow, June 2026).

Expected CSV columns (extra stat columns are ignored):
    Player, Team, Yr, and Bats and/or Throws
Players are matched by full name + team short_name (case-insensitive,
phantoms excluded). The CSVs are exports of the site's own leaderboards,
so Team should equal teams.short_name.

SAFETY RULES
  - Only NULL/empty DB fields are filled. An existing value that
    disagrees with the CSV is reported as a CONFLICT and left alone.
  - Rows that match zero players (name or team miss) are reported.
  - Rows that match MULTIPLE players are skipped and reported (never
    guess between two same-named players — see the player-matcher
    fallback gotcha in CLAUDE.md §10.4).
  - Dry-run by default; pass --apply to write.

Usage (server):
    PYTHONPATH=backend python3 scripts/fill_player_bio_from_csv.py \
        --csv /tmp/NWBB_Hitters_2026_Completed.csv [--apply]
"""

import argparse
import csv

from app.models.database import get_connection

# CSV value -> DB value. 'B' (both) is the same as switch.
BATS_MAP = {"L": "L", "R": "R", "S": "S", "B": "S"}
THROWS_MAP = {"L": "L", "R": "R"}
YEAR_OK = {"Fr", "So", "Jr", "Sr", "Gr", "5th",
           "R-Fr", "R-So", "R-Jr", "R-Sr"}


def norm_year(v):
    v = (v or "").strip()
    return v if v in YEAR_OK else None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--csv", required=True)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    with open(args.csv, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    has_bats = "Bats" in rows[0]
    has_throws = "Throws" in rows[0]

    filled = {"bats": 0, "throws": 0, "year_in_school": 0}
    agree = 0
    conflicts, unmatched_team, unmatched_player, multi = [], [], [], []

    with get_connection() as conn:
        cur = conn.cursor()

        # Team short_name -> id (case-insensitive), active teams only.
        cur.execute("SELECT id, short_name FROM teams WHERE COALESCE(is_active, 1) = 1")
        team_ids = {}
        for r in cur.fetchall():
            team_ids.setdefault(r["short_name"].strip().lower(), []).append(r["id"])

        for row in rows:
            name = (row.get("Player") or "").strip()
            team = (row.get("Team") or "").strip()
            if not name or not team:
                continue
            tids = team_ids.get(team.lower())
            if not tids:
                unmatched_team.append(team)
                continue

            cur.execute(
                """SELECT id, bats, throws, year_in_school
                   FROM players
                   WHERE LOWER(TRIM(first_name || ' ' || last_name)) = LOWER(%s)
                     AND team_id = ANY(%s)
                     AND COALESCE(is_phantom, FALSE) = FALSE""",
                (name, tids),
            )
            players = cur.fetchall()
            if not players:
                unmatched_player.append(f"{name} ({team})")
                continue
            if len(players) > 1:
                multi.append(f"{name} ({team}) x{len(players)}")
                continue

            p = players[0]
            updates = {}
            for db_field, csv_field, mapper in (
                ("bats", "Bats", BATS_MAP.get) if has_bats else (None, None, None),
                ("throws", "Throws", THROWS_MAP.get) if has_throws else (None, None, None),
                ("year_in_school", "Yr", norm_year),
            ):
                if db_field is None:
                    continue
                val = mapper((row.get(csv_field) or "").strip())
                if not val:
                    continue
                existing = (p[db_field] or "").strip() if p[db_field] else None
                if not existing:
                    updates[db_field] = val
                elif existing != val:
                    conflicts.append(f"{name} ({team}) {db_field}: DB={existing} CSV={val}")
                else:
                    agree += 1

            if updates and args.apply:
                sets = ", ".join(f"{k} = %s" for k in updates)
                cur.execute(f"UPDATE players SET {sets} WHERE id = %s",
                            (*updates.values(), p["id"]))
            for k in updates:
                filled[k] += 1

        if args.apply:
            conn.commit()

    mode = "APPLIED" if args.apply else "DRY RUN"
    print(f"[{mode}] {args.csv} — {len(rows)} rows")
    print(f"  filled: {filled}")
    print(f"  already-correct values confirmed: {agree}")
    if conflicts:
        print(f"  CONFLICTS (left untouched): {len(conflicts)}")
        for c in conflicts[:15]:
            print(f"    {c}")
    if unmatched_team:
        from collections import Counter
        print(f"  unmatched teams: {dict(Counter(unmatched_team))}")
    if unmatched_player:
        print(f"  unmatched players: {len(unmatched_player)}")
        for u in unmatched_player[:12]:
            print(f"    {u}")
    if multi:
        print(f"  ambiguous (multiple matches, skipped): {multi}")


if __name__ == "__main__":
    main()
