#!/usr/bin/env python3
"""Load PBR rankings (state lists + national top 500) into the recruits table.

PBR rankings are paid content. They are read from Nate's logged-in PBR
session in the desktop app's browser and saved to PRIVATE text files outside
the repo (never commit them). Each line:

    <yy>|<list>|<rank>|<name>|<home state>|<pos>|<commitment>

where <yy> is the class (26 = 2026), <list> is the PBR list ("Overall" for
the national top 500, else the state list label: WA, OR, CA, "New England",
"Dakotas", ON ...). How to regenerate them: see "Refreshing" below.

What this does for each class:
  * Matches every row to a recruit by normalized name + class. Matched
    recruits get pbr_national_rank / pbr_state_rank / pbr_rank_list (their
    committed team is NOT changed; BBNW stays authoritative for that).
  * Rows whose commitment resolves to one of our 57 programs but who are not
    in the table yet are INSERTED (this is how out-of-region commits from any
    state come in).
  * Re-scores the whole class with app.recruit_scoring (one national scale).

Only the derived recruit_score is ever shown on the site.

Refreshing (a few times a year): open https://www.prepbaseballreport.com/rankings
in the desktop app's browser with Nate signed in, then have Claude read each
list via /myincludes/filter_Ranking.php (pclass, country, site) the same way as
on 2026-11-22, write the rows to a private file, and run:

    PYTHONPATH=backend python3 scripts/ingest_pbr_live_rankings.py \
        --rows /path/rows1.txt /path/rows2.txt --grad-years 2026 2027 [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.models.database import get_connection  # noqa: E402
from app import recruit_scoring as rs  # noqa: E402
import scrape_recruits as sr  # noqa: E402

SCHOOL_MAP = Path(__file__).resolve().parent.parent / "backend" / "data" / "recruit_school_map.json"

# PBR commitment spellings that differ from recruit_school_map.json school_name.
# Keyed by our short_name. Bare "Pacific" is deliberately absent: on the
# California list it means University of the Pacific, not Pacific (OR).
ALIASES = {
    "UW": ["Washington"], "Wash. St.": ["Washington State"], "Oregon": ["Oregon"],
    "Oregon St.": ["Oregon State"], "Seattle U": ["Seattle"], "Portland": ["Portland"],
    "Gonzaga": ["Gonzaga"], "UPS": ["Puget Sound"], "Pacific": ["Pacific University (OR)"],
    "Linfield": ["Linfield College"], "L&C": ["Lewis & Clark College", "Lewis and Clark College"],
    "LCSC": ["Lewis-Clark State College", "Lewis-Clark State"], "C of I": ["College of Idaho"],
    "NNU": ["Northwest Nazarene University", "Northwest Nazarene"], "WOU": ["Western Oregon University", "Western Oregon"],
    "EOU": ["Eastern Oregon University", "Eastern Oregon"], "OIT": ["Oregon Institute of Technology", "Oregon Tech"],
    "SMU": ["Saint Martin's University", "St. Martin's University"], "PLU": ["Pacific Lutheran University", "Pacific Lutheran"],
    "CWU": ["Central Washington University", "Central Washington"], "MSUB": ["Montana State University-Billings", "MSU Billings"],
    "UBC": ["British Columbia", "University of British Columbia"], "Everett": ["Everett CC", "Everett Community College"],
    "Edmonds": ["Edmonds Community College", "Edmonds College"], "Treasure Valley": ["Treasure Valley CC", "Treasure Valley Community College"],
    "Whitman": ["Whitman College"], "Whitworth": ["Whitworth University"], "Willamette": ["Willamette University"],
    "Corban": ["Corban University"], "Warner Pacific": ["Warner Pacific University"], "GFU": ["George Fox University"],
    "Bushnell": ["Bushnell University"], "Douglas": ["Douglas College"],
}


def _key(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = s.replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def build_resolver():
    m = json.loads(SCHOOL_MAP.read_text())
    by_short = {v["short_name"]: int(k) for k, v in m.items()}
    table = {}
    for k, v in m.items():
        if v.get("school_name"):
            table[_key(v["school_name"])] = int(k)
    for short, names in ALIASES.items():
        tid = by_short.get(short)
        if tid is None:
            continue
        for n in names:
            table[_key(n)] = tid
    table.pop(_key("Pacific"), None)
    return lambda commit: table.get(_key(commit)) if commit else None


def _name_key(full: str) -> str:
    full = re.sub(r"\([^)]*\)", " ", full or "")          # "Cervantes (CJ) Gatterson"
    k = sr.norm_name(full)
    return re.sub(r"\s+", " ", re.sub(r"\b(jr|sr|ii|iii|iv)\b", "", k)).strip()


def _nick_key(full: str) -> str:
    """Spelling-tolerant key, shared with the weekly scraper (Jake/Jacob, "(CJ)", Jr)."""
    return sr.canon_name_key(full)


def parse_rows(paths):
    """{(grad_year, name_key): info} with national rank and the best state-list rank."""
    out = {}
    for p in paths:
        for line in Path(p).read_text().splitlines():
            parts = line.split("|")
            if len(parts) != 7:
                continue
            yy, lst, rank, name, home, pos, commit = parts
            gy = 2000 + int(yy)
            k = (gy, _name_key(name))
            rec = out.setdefault(k, {"name": name.strip(), "nick": _nick_key(name), "home": home.strip().upper(), "pos": pos.strip() or None,
                                      "commit": commit.strip() or None, "national": None, "lists": {}})
            if lst == "Overall":
                rec["national"] = int(rank)
            else:
                rec["lists"][lst] = int(rank)
            if commit.strip() and not rec["commit"]:
                rec["commit"] = commit.strip()
    for rec in out.values():
        home_list = rs.list_for_state(rec["home"])
        if home_list in rec["lists"]:
            rec["list"], rec["state_rank"] = home_list, rec["lists"][home_list]
        elif rec["lists"]:
            rec["list"], rec["state_rank"] = min(rec["lists"].items(), key=lambda kv: kv[1])
        else:
            rec["list"], rec["state_rank"] = None, None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", nargs="+", required=True)
    ap.add_argument("--grad-years", nargs="+", type=int, default=[2027])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    resolve = build_resolver()
    pbr = parse_rows(args.rows)
    excluded = getattr(sr, "RECRUIT_EXCLUDE", set())

    with get_connection() as conn:
        cur = conn.cursor()
        rs.ensure_columns(cur)
        for gy in args.grad_years:
            cur.execute("""SELECT id, first_name, last_name, sources FROM recruits WHERE grad_year = %s""", (gy,))
            have, have_nick = defaultdict(list), defaultdict(list)
            for r in cur.fetchall():
                full = f"{r['first_name']} {r['last_name']}"
                have[_name_key(full)].append(r)
                have_nick[_nick_key(full)].append(r)
            # exact-name rows first, so a nickname pass never steals an exact match
            items = sorted(((k, v) for k, v in pbr.items() if k[0] == gy), key=lambda kv: kv[0][1] not in have)
            claimed = set()
            matched = inserted = skipped_excluded = 0
            new_by_team = defaultdict(list)
            for (yr, nk), rec in items:
                if rec["national"] is None and rec["state_rank"] is None:
                    continue
                rows = [r for r in have.get(nk, []) if r["id"] not in claimed]
                if not rows:
                    cands = [r for r in have_nick.get(rec["nick"], []) if r["id"] not in claimed]
                    rows = cands if len(cands) == 1 else []
                if rows:
                    for r in rows:          # duplicate rows of one player all get the rank
                        srcs = sorted(set((r["sources"] or []) + ["pbr"]))
                        cur.execute("""UPDATE recruits SET pbr_national_rank = %s, pbr_state_rank = %s,
                                              pbr_rank_list = %s, sources = %s
                                       WHERE id = %s""",
                                    (rec["national"], rec["state_rank"], rec["list"], srcs, r["id"]))
                        claimed.add(r["id"])
                    matched += 1
                    continue
                tid = resolve(rec["commit"])
                if tid is None:
                    continue
                first, last = sr.split_name(rec["name"])
                if (sr.norm_name(first), sr.norm_name(last), gy) in excluded:
                    skipped_excluded += 1
                    continue
                cur.execute("""INSERT INTO recruits (first_name, last_name, position, grad_year, state,
                                   committed_team_id, committed_raw, pbr_national_rank, pbr_state_rank,
                                   pbr_rank_list, sources, last_seen)
                               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
                               ON CONFLICT (first_name, last_name, grad_year) DO UPDATE SET
                                   pbr_national_rank = EXCLUDED.pbr_national_rank,
                                   pbr_state_rank = EXCLUDED.pbr_state_rank,
                                   pbr_rank_list = EXCLUDED.pbr_rank_list""",
                            (first, last, rec["pos"], gy, rec["home"], tid, rec["commit"],
                             rec["national"], rec["state_rank"], rec["list"], ["pbr"]))
                inserted += 1
                new_by_team[tid].append(rec["name"])
            n = rs.rescore_class(cur, gy)
            print(f"{gy}: matched {matched} existing recruits, inserted {inserted} new commits "
                  f"({len(new_by_team)} programs), skipped {skipped_excluded} excluded; rescored {n}")
        if args.dry_run:
            conn.rollback()
            print("DRY RUN: rolled back")
        else:
            conn.commit()


if __name__ == "__main__":
    main()
