"""
Backfill home_team_id / away_team_id on games rows where a team name
was stored but never resolved to a team id.

Usage:
    PYTHONPATH=backend python3 scripts/backfill_team_ids.py           # dry run
    PYTHONPATH=backend python3 scripts/backfill_team_ids.py --apply   # write

Uses the same team-name normalizer as backend/app/api/routes.py so
"Montana State University Billings", "MSU-Billings", "MSUB", and
"Saint Martin's" all resolve to the canonical team id.
"""

import argparse
import re
import sys

# Ensure we can import the backend package
sys.path.insert(0, "backend")

from app.models.database import get_connection  # noqa: E402


ABBREV_MAP = {
    "wash.": "washington", "ore.": "oregon", "mont.": "montana",
    "so.": "southern", "no.": "northern",
    "e.": "eastern", "w.": "western", "cen.": "central",
    "s.": "southern", "n.": "northern",
    "u.": "university", "univ.": "university", "univ": "university",
    "coll.": "college", "coll": "college",
}
TRAILING_SUFFIX = ("university", "college", "institute", "academy")
LEADING_PREFIX = ("university of ", "college of ", "the ")
HARD_ALIASES = {
    "montana state billings": "msu billings",
    "montana state university billings": "msu billings",
}


def normalize(s):
    if not s:
        return ""
    s = s.strip().lower()
    s = re.sub(r"[-\u2013\u2014]", " ", s)
    s = s.replace("\u2019", "").replace("\u2018", "").replace("'", "")
    s = re.sub(r"\s*\([^)]*\)\s*$", "", s).strip()
    s = re.sub(r"^(?:no\.\s*\d+|#\d+)\s+", "", s).strip()
    s = re.sub(r"\s*\d+$", "", s).strip()
    if s.startswith("st. "):
        s = "saint " + s[4:]
    elif s.startswith("st "):
        s = "saint " + s[3:]
    s = re.sub(r"\bst\.", "state", s)
    s = " ".join(ABBREV_MAP.get(w, w) for w in s.split())
    s = re.sub(r"\s+", " ", s).strip()
    return HARD_ALIASES.get(s, s)


def strip_trail(s):
    for w in TRAILING_SUFFIX:
        if s.endswith(" " + w):
            return s[: -len(w) - 1].strip()
    return s


def strip_lead(s):
    for p in LEADING_PREFIX:
        if s.startswith(p):
            return s[len(p):].strip()
    return s


def build_cache(conn):
    cur = conn.cursor()
    cur.execute("SELECT id, short_name, name, school_name FROM teams")
    cache = {}

    def reg(k, v):
        if k and k not in cache:
            cache[k] = v

    for row in cur.fetchall():
        tid = row["id"]
        for field in ("short_name", "name", "school_name"):
            val = row[field]
            if not val:
                continue
            n = normalize(val)
            reg(n, tid)
            if field == "name":
                parts = n.split()
                if len(parts) >= 2:
                    reg(" ".join(parts[:-1]), tid)
            reg(strip_trail(n), tid)
            reg(strip_lead(n), tid)
            reg(strip_trail(strip_lead(n)), tid)
    return cache


def resolve(name, cache):
    if not name:
        return None
    n = normalize(name)
    tid = cache.get(n)
    if tid:
        return tid
    for variant in (strip_trail(n), strip_lead(n), strip_trail(strip_lead(n))):
        if variant != n:
            tid = cache.get(variant)
            if tid:
                return tid
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true",
                    help="actually write the UPDATEs (default is dry run)")
    ap.add_argument("--season", type=int, default=2026,
                    help="season to scan (default 2026)")
    args = ap.parse_args()

    with get_connection() as conn:
        cache = build_cache(conn)
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, home_team_id, away_team_id,
                   home_team_name, away_team_name
            FROM games
            WHERE season = %s
              AND (home_team_id IS NULL OR away_team_id IS NULL)
            """,
            (args.season,),
        )
        rows = cur.fetchall()

        home_fixed = 0
        away_fixed = 0
        unresolved = []
        updates = []

        for r in rows:
            gid = r["id"]
            new_home = r["home_team_id"]
            new_away = r["away_team_id"]

            if r["home_team_id"] is None and r["home_team_name"]:
                tid = resolve(r["home_team_name"], cache)
                if tid:
                    new_home = tid
                    home_fixed += 1
                else:
                    unresolved.append(("home", gid, r["home_team_name"]))

            if r["away_team_id"] is None and r["away_team_name"]:
                tid = resolve(r["away_team_name"], cache)
                if tid:
                    new_away = tid
                    away_fixed += 1
                else:
                    unresolved.append(("away", gid, r["away_team_name"]))

            if new_home != r["home_team_id"] or new_away != r["away_team_id"]:
                updates.append((gid, new_home, new_away))

        print(f"Scanned {len(rows)} games with missing team ids (season {args.season})")
        print(f"  home_team_id backfills:  {home_fixed}")
        print(f"  away_team_id backfills:  {away_fixed}")
        print(f"  total rows to update:    {len(updates)}")
        print(f"  unresolved names:        {len(unresolved)}")

        if unresolved:
            from collections import Counter
            by_name = Counter(name for _, _, name in unresolved)
            print("\nTop unresolved names (need alias or new team row):")
            for name, count in by_name.most_common(25):
                print(f"  {count:4d}  {name!r}")

        if not args.apply:
            print("\nDry run — add --apply to write changes.")
            return

        if not updates:
            print("\nNothing to update.")
            return

        cur.executemany(
            "UPDATE games SET home_team_id = %s, away_team_id = %s, "
            "updated_at = NOW() WHERE id = %s",
            [(h, a, gid) for gid, h, a in updates],
        )
        conn.commit()
        print(f"\nApplied {len(updates)} updates.")


if __name__ == "__main__":
    main()
