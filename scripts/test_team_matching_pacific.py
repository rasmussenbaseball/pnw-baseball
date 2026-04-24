#!/usr/bin/env python3
"""
Test that team_matching.py now handles the three Pacific-ghost cases
correctly. Run this before the nightly cron to confirm the patch prevents
re-insertion of the 16 ghost rows we just deleted.

Usage:
    PYTHONPATH=backend python3 scripts/test_team_matching_pacific.py
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.models.database import get_connection
from team_matching import get_team_id_by_school  # noqa: E402


def lookup_team_by_short(cur, short):
    cur.execute(
        "SELECT id, short_name FROM teams WHERE short_name = %s AND is_active = 1",
        (short,),
    )
    return cur.fetchone()


def lookup_pacifics(cur):
    cur.execute(
        """
        SELECT t.id, t.short_name, t.school_name, t.is_active,
               c.division_id, d.name AS division
        FROM teams t
        JOIN conferences c ON c.id = t.conference_id
        LEFT JOIN divisions d ON d.id = c.division_id
        WHERE LOWER(t.short_name) = 'pacific'
        ORDER BY t.id
        """
    )
    return cur.fetchall()


def run_case(cur, label, input_name, hint_tid, expected):
    got = get_team_id_by_school(
        cur, input_name, prefer_division_of_team_id=hint_tid
    )
    ok = "PASS" if got == expected else "FAIL"
    print(f"  [{ok}] {label:55s} expected={expected}  got={got}")
    return ok == "PASS"


def main():
    with get_connection() as conn:
        cur = conn.cursor()

        print("Pacifics in the teams table:")
        for p in lookup_pacifics(cur):
            print(f"  id={p['id']:>6}  short={p['short_name']:<10}  "
                  f"school={p['school_name']:<30}  div={p['division']}")
        print()

        # Look up the scraping teams' IDs so we can pass them as the
        # prefer_division_of_team_id hint, mirroring scrape_boxscores.py.
        pacific_d3 = lookup_team_by_short(cur, "Pacific")
        if not pacific_d3:
            print("ERROR: could not find Pacific D3 by short_name")
            return
        seattle_u = lookup_team_by_short(cur, "Seattle U")
        gonzaga = lookup_team_by_short(cur, "Gonzaga")
        wou = lookup_team_by_short(cur, "WOU") or lookup_team_by_short(
            cur, "Western Oregon"
        )

        print(f"Scraping team ids: Pacific D3={pacific_d3['id'] if pacific_d3 else None}  "
              f"Seattle U={seattle_u['id'] if seattle_u else None}  "
              f"Gonzaga={gonzaga['id'] if gonzaga else None}  "
              f"WOU={wou['id'] if wou else None}")
        print()

        # Find D1 Pacific id by school_name
        cur.execute(
            """
            SELECT id FROM teams
            WHERE LOWER(school_name) LIKE '%university of the pacific%'
            """
        )
        d1_row = cur.fetchone()
        d1_pacific_id = d1_row["id"] if d1_row else None
        d3_pacific_id = pacific_d3["id"]
        print(f"D3 Pacific id={d3_pacific_id}   D1 Pacific id={d1_pacific_id}")
        print()

        results = []

        print("Fix A: Exact-short_name disambiguation via division hint")
        results.append(run_case(
            cur, "Pacific  (no hint) — returns first of two",
            "Pacific", None, d3_pacific_id,
        ))
        if seattle_u:
            results.append(run_case(
                cur, "Pacific  (Seattle U hint, D1) — should pick D1 Pacific",
                "Pacific", seattle_u["id"], d1_pacific_id,
            ))
        if gonzaga:
            results.append(run_case(
                cur, "Pacific  (Gonzaga hint, D1) — should pick D1 Pacific",
                "Pacific", gonzaga["id"], d1_pacific_id,
            ))
        results.append(run_case(
            cur, "Pacific  (Pacific D3 hint, D3) — should pick D3 Pacific",
            "Pacific", d3_pacific_id, d3_pacific_id,
        ))
        print()

        print("Fix B: Qualifier-prefix strings stop over-matching")
        # These three should NOT return D3 Pacific (id=17). They should
        # return either None or an OOC placeholder id (created on first
        # run of get_or_create_ooc_team; get_team_id_by_school itself
        # should return None if no team row exists).
        if wou:
            got = get_team_id_by_school(
                cur, "Fresno Pacific University (Calif.)",
                prefer_division_of_team_id=wou["id"],
            )
            ok = "PASS" if got != d3_pacific_id else "FAIL"
            results.append(ok == "PASS")
            print(f"  [{ok}] Fresno Pacific University (Calif.), WOU hint     "
                  f"expected != {d3_pacific_id}  got={got}")

            got = get_team_id_by_school(
                cur, "Fresno Pacific",
                prefer_division_of_team_id=wou["id"],
            )
            ok = "PASS" if got != d3_pacific_id else "FAIL"
            results.append(ok == "PASS")
            print(f"  [{ok}] Fresno Pacific, WOU hint                          "
                  f"expected != {d3_pacific_id}  got={got}")

        got = get_team_id_by_school(cur, "Warner Pacific")
        cur.execute(
            "SELECT id FROM teams WHERE LOWER(short_name) = 'warner pacific' "
            "OR LOWER(school_name) LIKE '%warner pacific%'"
        )
        warner_row = cur.fetchone()
        warner_id = warner_row["id"] if warner_row else None
        ok = ("PASS" if (got == warner_id and got != d3_pacific_id)
              else "WARN" if got is None
              else "FAIL")
        results.append(ok in ("PASS", "WARN"))
        print(f"  [{ok}] Warner Pacific (no hint)                         "
              f"expected={warner_id}  got={got}")
        print()

        print("Regression: normalize still strips state tags")
        results.append(run_case(
            cur, "Pacific (Ore.) with no hint                       ",
            "Pacific (Ore.)", None, d3_pacific_id,
        ))
        print()

        passed = sum(results)
        total = len(results)
        print(f"Result: {passed}/{total} cases passed")
        if passed == total:
            print("Patch looks good. Safe to let the cron run tonight.")
        else:
            print("Some cases failed — DO NOT deploy yet.")


if __name__ == "__main__":
    main()
