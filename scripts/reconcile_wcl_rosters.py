#!/usr/bin/env python3
"""Reconcile scraped 2026 WCL rosters (full names + hometowns) into
summer_players. Matches each 2026-active summer_player (one with 2026 game
stats) to its roster entry by last name + first initial, then fills full name +
hometown + position/year/B/T.

  python3 reconcile_wcl_rosters.py --json /tmp/wcl_rosters_2026.json            # preview
  python3 reconcile_wcl_rosters.py --json /tmp/wcl_rosters_2026.json --commit   # write
"""
import argparse
import difflib
import json
import os
import re

import psycopg2
import psycopg2.extras

SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def load_db_url():
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    for envf in ("/opt/pnw-baseball/.env", "backend/.env", ".env"):
        if os.path.exists(envf):
            for line in open(envf):
                s = line.strip()
                if s.startswith("DATABASE_URL="):
                    return s.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("no DATABASE_URL")


def norm_last(s):
    s = re.sub(r"[^a-z ]", "", (s or "").lower())
    toks = [t for t in s.split() if t not in SUFFIXES]
    return " ".join(toks).strip()


def first_ok(active_first, roster_first):
    a = (active_first or "").lower().strip().rstrip(".")
    r = (roster_first or "").lower().strip()
    if not a:
        return True               # box score had no first name
    if a == r:
        return True
    if len(a) <= 2 and r[:1] == a[:1]:
        return True               # initial match: "L" -> "Logan"
    if r.startswith(a) or a.startswith(r):
        return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", required=True)
    ap.add_argument("--commit", action="store_true")
    args = ap.parse_args()

    rosters = {int(k): v for k, v in json.load(open(args.json)).items()}
    c = psycopg2.connect(load_db_url(), cursor_factory=psycopg2.extras.RealDictCursor, connect_timeout=15)
    c.autocommit = not args.commit
    cur = c.cursor()
    cur.execute("SET statement_timeout='60s'")

    tot_upd = tot_ins = tot_amb = 0
    for tid, roster in rosters.items():
        # ALL existing summer_players on the team (the 300+ historical pile).
        cur.execute("SELECT id, first_name, last_name FROM summer_players WHERE team_id=%s", (tid,))
        existing = cur.fetchall()
        by_last = {}
        for e in existing:
            by_last.setdefault(norm_last(e["last_name"]), []).append(e)
        used = set()

        upd = ins = amb = 0
        for rp in roster:
            rl = norm_last(rp["last_name"])
            rf = (rp["first_name"] or "").lower().strip()
            cands = [e for e in by_last.get(rl, []) if e["id"] not in used]
            # Prefer an exact full-name match; fall back to last + first-initial
            # (catches any still-abbreviated box-score rows like "L Dykstra").
            exact = [e for e in cands if (e["first_name"] or "").lower().strip() == rf]
            hits = exact if exact else [e for e in cands if first_ok(e["first_name"], rp["first_name"])]
            if len(hits) == 1:
                e = hits[0]
                used.add(e["id"])
                if args.commit:
                    cur.execute("""
                        UPDATE summer_players SET
                          first_name = %s, last_name = %s,
                          hometown       = COALESCE(NULLIF(%s,''), hometown),
                          position       = COALESCE(NULLIF(%s,''), position),
                          year_in_school = COALESCE(NULLIF(%s,''), year_in_school),
                          bats           = COALESCE(NULLIF(%s,''), bats),
                          throws         = COALESCE(NULLIF(%s,''), throws),
                          roster_year = 2026, updated_at = now()
                        WHERE id = %s
                    """, (rp["first_name"], rp["last_name"], rp["hometown"] or "", rp["position"] or "",
                          rp["year_in_school"] or "", rp["bats"] or "", rp["throws"] or "", e["id"]))
                upd += 1
            elif not hits:
                if args.commit:
                    cur.execute("""
                        INSERT INTO summer_players
                          (first_name, last_name, team_id, position, bats, throws,
                           year_in_school, hometown, roster_year, created_at, updated_at)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,2026,now(),now())
                    """, (rp["first_name"], rp["last_name"], tid, rp["position"] or None,
                          rp["bats"] or None, rp["throws"] or None, rp["year_in_school"] or None,
                          rp["hometown"] or None))
                ins += 1
            else:
                amb += 1
        tot_upd += upd; tot_ins += ins; tot_amb += amb
        cur.execute("SELECT name FROM summer_teams WHERE id=%s", (tid,))
        tname = cur.fetchone()["name"]
        print(f"  {tname:<24} update {upd:>3}  insert {ins:>3}  ambiguous {amb}")

    if args.commit:
        c.commit()
    print("\n" + "=" * 60)
    print(f"TOTAL: {tot_upd} matched/updated, {tot_ins} inserted (bench), {tot_amb} ambiguous")
    print("COMMITTED" if args.commit else "PREVIEW ONLY — no DB writes. Re-run with --commit.")
    c.close()


if __name__ == "__main__":
    main()
