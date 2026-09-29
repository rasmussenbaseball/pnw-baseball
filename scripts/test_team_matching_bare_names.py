#!/usr/bin/env python3
"""
Read-only regression test for team_matching.get_team_id_by_school.

Covers the September 2026 "bare name matched a longer school" audit:
  "Texas"   was resolving to the OOC row "Texas Tech"
  "Hawaii"  -> "Hawaii Pacific",  "LSU" -> "LSU Shreveport",
  "Arizona" -> "Arizona State"
plus the spelling-variant collapse (_name_key) that stops the OOC
auto-creator from minting "Cal State Monterey Bay" / "California State
University Monterey Bay" / "3-seed Cal St. Monterey Bay" as three teams.

Usage (Mac or server, talks to the live DB, never writes):
    PYTHONPATH=backend python3 scripts/test_team_matching_bare_names.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
sys.path.insert(0, os.path.dirname(__file__))

from app.models.database import get_connection          # noqa: E402
from team_matching import get_team_id_by_school, _name_key  # noqa: E402


def short(cur, tid):
    if tid is None:
        return None
    cur.execute("SELECT short_name FROM teams WHERE id = %s", (tid,))
    r = cur.fetchone()
    return r["short_name"] if r else f"<missing {tid}>"


def main():
    fails = 0
    with get_connection() as conn:
        cur = conn.cursor()

        def by_short(name):
            cur.execute(
                "SELECT id FROM teams WHERE short_name = %s ORDER BY is_active DESC, id LIMIT 1",
                (name,),
            )
            r = cur.fetchone()
            return r["id"] if r else None

        def check(label, name, hint, expect):
            """expect: an id, None, or a callable(id) -> bool."""
            nonlocal fails
            got = get_team_id_by_school(cur, name, prefer_division_of_team_id=hint)
            if callable(expect):
                ok = expect(got)
            else:
                ok = got == expect
            print(f"  [{'PASS' if ok else 'FAIL'}] {label:58s} -> {got} ({short(cur, got)})")
            if not ok:
                fails += 1

        oregon, osu, uw, seattle_u = 2, 3, 1, 484
        pacific_d3, pacific_d1 = 17, 32857
        gonzaga, wou, nnu = 483, 8, 9

        print("Bare names must NOT fall into a longer school:")
        # These rows may or may not exist yet; the rule is "never the wrong one".
        check("Texas (Oregon hint) != Texas Tech", "Texas", oregon,
              lambda g: g is None or short(cur, g) not in ("Texas Tech",))
        check("Hawaii (OSU hint) != Hawaii Pacific", "Hawaii", osu,
              lambda g: g is None or "Pacific" not in (short(cur, g) or ""))
        check("LSU (OSU hint) != LSU Shreveport", "LSU", osu,
              lambda g: g is None or "Shreveport" not in (short(cur, g) or ""))
        check("Arizona (Oregon hint) != Arizona State", "Arizona", oregon,
              lambda g: g is None or "State" not in (short(cur, g) or ""))
        check("No. 19 Arizona (WSU hint) != Arizona State", "No. 19 Arizona", 4,
              lambda g: g is None or "State" not in (short(cur, g) or ""))
        check("Utah (UW hint) != Utah Tech / Utah Valley", "Utah", uw,
              lambda g: g is None or short(cur, g) == "Utah")
        check("Oklahoma != Oklahoma State", "Oklahoma", oregon,
              lambda g: g is None or short(cur, g) == "Oklahoma")
        print()

        print("Pacific disambiguation (both rows share short_name 'Pacific'):")
        check("Pacific (Seattle U hint) -> D1 Pacific", "Pacific", seattle_u, pacific_d1)
        check("Pacific (Gonzaga hint) -> D1 Pacific", "Pacific", gonzaga, pacific_d1)
        check("Pacific (D3 Pacific hint) -> D3 Pacific", "Pacific", pacific_d3, pacific_d3)
        check("Pacific (no hint) -> D3 Pacific (first row)", "Pacific", None, pacific_d3)
        check("Pacific (Ore.) (Whitworth hint) -> D3", "Pacific (Ore.)", 13, pacific_d3)
        check("Fresno Pacific != D3 Pacific", "Fresno Pacific", wou,
              lambda g: g != pacific_d3)
        check("Warner Pacific -> Warner Pacific", "Warner Pacific", wou, by_short("Warner Pacific"))
        print()

        print("Real PNW teams still resolve from common spellings:")
        check("Washington -> UW (alias)", "Washington", osu, uw)
        check("Oregon State -> Oregon St.", "Oregon State", uw, osu)
        check("Western Oregon -> WOU", "Western Oregon", nnu, wou)
        check("1-seed Western Oregon -> WOU", "1-seed Western Oregon", nnu, wou)
        check("2-seed Portland -> Portland", "2-seed Portland", gonzaga, 482)
        check("3-seed Central Wash. -> CWU", "3-seed Central Wash.", nnu, 5)
        check("Lewis-Clark State -> LCSC", "Lewis-Clark State", 21, 22)
        check("Lewis & Clark -> L&C", "Lewis & Clark", 14, 15)
        check("Lewis-Clark != L&C", "Lewis-Clark", 14, lambda g: g != 15)
        check("Seattle University -> Seattle U", "Seattle University", uw, seattle_u)
        check("Central Washington University -> CWU", "Central Washington University", 6, 5)
        check("Montana State Billings -> MSUB", "Montana State Billings", wou, 7)
        check("Gonzaga -> Gonzaga", "Gonzaga", 482, gonzaga)
        print()

        print("Spelling variants collapse onto the existing OOC row:")
        csumb = get_team_id_by_school(cur, "Cal State Monterey Bay", prefer_division_of_team_id=nnu)
        check("California State University Monterey Bay == Cal State Monterey Bay",
              "California State University Monterey Bay", nnu, csumb)
        check("3-seed Cal St. Monterey Bay == Cal State Monterey Bay",
              "3-seed Cal St. Monterey Bay", nnu, csumb)
        cmsc = get_team_id_by_school(cur, "Claremont-Mudd-Scripps", prefer_division_of_team_id=13)
        check("Claremont-Mudd-Scripps Colleges == Claremont-Mudd-Scripps",
              "Claremont-Mudd-Scripps Colleges", 11, cmsc)
        pp = get_team_id_by_school(cur, "Pomona-Pitzer", prefer_division_of_team_id=13)
        check("Pomona-Pitzer Colleges == Pomona-Pitzer", "Pomona-Pitzer Colleges", 11, pp)
        check("Pomona Pitzer == Pomona-Pitzer", "Pomona Pitzer", 11, pp)
        lv = get_team_id_by_school(cur, "La Verne", prefer_division_of_team_id=13)
        check("University of La Verne == La Verne", "University of La Verne", 14, lv)
        ct = get_team_id_by_school(cur, "Concordia Texas", prefer_division_of_team_id=18)
        check("Concordia University Texas == Concordia Texas", "Concordia University Texas", 11, ct)
        check("Concordia (Mich.) != Concordia Texas", "Concordia (Mich.)", 22,
              lambda g: g is None or g != ct)
        jes = get_team_id_by_school(cur, "Jessup", prefer_division_of_team_id=20)
        check("Jessup University (Calif.) == Jessup", "Jessup University (Calif.)", 24, jes)
        print()

        print("_name_key samples:")
        for s in ("California State University Monterey Bay", "Cal St. Monterey Bay",
                  "3-seed Cal State Monterey Bay", "St. Thomas University", "Texas Tech",
                  "Univ. of British Columbia", "Lewis & Clark College", "Lewis-Clark State College"):
            print(f"  {s!r:45s} -> {_name_key(s)!r}")

    print()
    print("ALL PASS" if not fails else f"{fails} FAILURES")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
