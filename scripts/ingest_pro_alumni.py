"""
Ingest the "Pro alumni" spreadsheet into backend/data/pro_alumni.json.

The spreadsheet lists every PNW college player now in MiLB/MLB. This script:
  1. Cleans each row (strips stray non-breaking spaces / whitespace).
  2. Resolves the college(s) to our teams.id (handles multi-college transfers).
  3. Resolves the player to our players.id where we have a page for them
     (players who played pre-2018 won't be in our DB — they stay unlinked).
  4. Writes a flat JSON list the /pro-alumni endpoint serves.

Read-only against the DB (SELECTs only). Re-run whenever the spreadsheet
is updated:

    PYTHONPATH=backend python3 scripts/ingest_pro_alumni.py \
        --xlsx ~/Downloads/"Pro alumni.xlsx"
"""
import argparse
import json
import os
from datetime import datetime, timezone

import openpyxl

from app.models.database import get_connection

# Canonical college name (exact spelling as it appears in the sheet) -> teams.id.
# Substring matching against these keys handles multi-college rows like
# "Oregon State University and Lewis and Clarke State and Washington State University".
COLLEGE_TEAM_IDS = {
    "Oregon State University": 3,
    "University of Oregon": 2,
    "University of Washington": 1,
    "Gonzaga University": 483,
    "Washington State University": 4,
    "The University of British Columbia": 5720,
    "Seattle University": 484,
    "College of Idaho": 21,
    "Lewis-Clark State College": 22,     # LCSC (NAIA), not D3 Lewis & Clark
    "Lewis and Clarke State": 22,        # alt spelling seen in the sheet
    "Northwest Nazarene University": 9,
    "Corban University": 23,
    "Pacific Lutheran University": 11,
    "Whitworth University": 13,
    # NWAC (JUCO) programs — added as alumni from these schools appear.
    "Tacoma Community College": 53,
    "Linn-Benton Community College": 44,
    "Columbia Basin College": 34,
    "Umpqua Community College": 47,
    "Lane Community College": 43,
    "Chemeketa Community College": 41,
    "Everett Community College": 28,
    "Lower Columbia College": 52,
}


def clean(v):
    if v is None:
        return ""
    return str(v).replace("\xa0", " ").strip()


def resolve_college_team_ids(college_raw):
    """Return the list of teams.id mentioned in the raw college string,
    in the order they appear. Substring match against canonical names."""
    found = []
    for name, tid in COLLEGE_TEAM_IDS.items():
        idx = college_raw.find(name)
        if idx >= 0:
            found.append((idx, tid))
    found.sort(key=lambda x: x[0])
    # de-dup while preserving order
    out = []
    for _, tid in found:
        if tid not in out:
            out.append(tid)
    return out


def resolve_player_id(cur, name, team_ids):
    """Best-effort link to players.id, scoped to the player's college team(s)
    so we never mis-link a same-named player from a different school. Returns
    None when there's no confident match (e.g. pre-2018 players not in our DB)."""
    if not team_ids:
        return None
    toks = name.replace(".", "").split()
    if len(toks) < 2:
        return None
    first = toks[0]
    candidates = [" ".join(toks[1:]), toks[-1]]  # try full last name, then last token
    for last in candidates:
        cur.execute(
            """
            SELECT id
            FROM players
            WHERE LOWER(first_name) = LOWER(%s)
              AND LOWER(last_name) = LOWER(%s)
              AND team_id = ANY(%s)
            ORDER BY COALESCE(is_phantom, FALSE) ASC, id ASC
            """,
            (first, last, team_ids),
        )
        rows = cur.fetchall()
        if rows:
            return rows[0]["id"]

    # Nickname fallback: exact last name at the same college, with one first
    # name a prefix of the other (Trey -> Treyson, Nate -> Nathan). Scoped to
    # the college team + exact last name keeps this safe. Only link a unique
    # match so we never guess between two same-last-name teammates.
    if len(first) >= 3:
        last = toks[-1]
        cur.execute(
            """
            SELECT id, first_name
            FROM players
            WHERE LOWER(last_name) = LOWER(%s)
              AND team_id = ANY(%s)
            ORDER BY COALESCE(is_phantom, FALSE) ASC, id ASC
            """,
            (last, team_ids),
        )
        hits = []
        for r in cur.fetchall():
            fn = (r["first_name"] or "").lower()
            if fn and (fn.startswith(first.lower()) or first.lower().startswith(fn)):
                hits.append(r["id"])
        if len(hits) == 1:
            return hits[0]
    return None


def main():
    ap = argparse.ArgumentParser()
    default_xlsx = os.path.expanduser("~/Downloads/Pro alumni.xlsx")
    ap.add_argument("--xlsx", default=default_xlsx, help="Path to the Pro alumni .xlsx")
    ap.add_argument(
        "--out",
        default=os.path.join(os.path.dirname(__file__), "..", "backend", "data", "pro_alumni.json"),
    )
    args = ap.parse_args()

    wb = openpyxl.load_workbook(args.xlsx, data_only=True)
    ws = wb.worksheets[0]

    players = []
    unmapped_colleges = set()
    with get_connection() as conn:
        cur = conn.cursor()
        for row in ws.iter_rows(min_row=2, values_only=True):
            name = clean(row[0])
            if not name:
                continue
            college_raw = clean(row[1])
            team_ids = resolve_college_team_ids(college_raw)
            if not team_ids:
                unmapped_colleges.add(college_raw)
            year = clean(row[3])
            try:
                year = int(float(year)) if year else None
            except ValueError:
                year = None
            players.append({
                "name": name,
                "college_raw": college_raw,
                "college_team_ids": team_ids,
                "player_id": resolve_player_id(cur, name, team_ids),
                "drafted_by": clean(row[2]),
                "year_drafted": year,
                "pick": clean(row[4]),
                "current_team": clean(row[5]),
                "level": clean(row[6]),
                "affiliate": clean(row[7]),
                "stats_url": clean(row[8]),
            })

    # De-duplicate. The same player sometimes appears in multiple rows when
    # a college is added later (e.g. a row "Oregon State" plus a newer row
    # "Oregon State and Linn-Benton CC"). Key on the stats-page URL (unique
    # per player) and keep the most complete row — the one credited to the
    # most colleges, then the longest raw college string.
    def dedup_key(p):
        url = (p.get("stats_url") or "").strip().lower()
        return url or f"{p['name'].lower()}|{p.get('year_drafted')}|{p.get('pick')}"

    best = {}
    for p in players:
        k = dedup_key(p)
        cur_best = best.get(k)
        if cur_best is None or (
            (len(p["college_team_ids"]), len(p["college_raw"]))
            > (len(cur_best["college_team_ids"]), len(cur_best["college_raw"]))
        ):
            best[k] = p
    deduped = list(best.values())
    dropped = len(players) - len(deduped)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": os.path.basename(args.xlsx),
        "players": deduped,
    }
    players = deduped
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(payload, f, indent=2)

    linked = sum(1 for p in players if p["player_id"])
    print(f"Wrote {len(players)} players to {out}  (dropped {dropped} duplicate rows)")
    print(f"  linked to a player page: {linked}")
    print(f"  unlinked (pre-2018 / not in DB): {len(players) - linked}")
    if unmapped_colleges:
        print(f"  WARNING unmapped colleges: {sorted(unmapped_colleges)}")


if __name__ == "__main__":
    main()
