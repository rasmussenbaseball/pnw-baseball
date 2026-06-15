#!/usr/bin/env python3
"""
One-time ingester for the PBR (Prep Baseball Report) state-rankings PDF.

PBR's full state rankings are paywalled, but Nate exported them to a PDF
(`PBR RANKINGS.pdf`, 37 pages, ~1289 ranked rows). This script parses every
2026-class ranked player out of that PDF, resolves each player's *commitment*
to one of our PNW teams, and upserts into the `recruits` table:

  * For a recruit we ALREADY track (matched by normalized first+last+grad_year)
    we just attach `pbr_state_rank` and keep their existing committed_team_id
    (don't clobber a destination BBNW already resolved).
  * For a NEW player we INSERT with the resolved committed_team_id — this is how
    we finally capture out-of-region commits to the hard-to-reach schools
    (Whitworth, Olympic, Spokane Falls, Western Oregon, Columbia Basin, ...).

`recruit_score` is recomputed for every affected row with the existing
cross-state weighting (scrape_recruits.compute_score / STATE_FACTOR).

PDF structure (verified):
  * All-caps STATE HEADER lines start each section: WASHINGTON, OREGON,
    CALIFORNIA, UTAH, NEVADA, CANADA. The per-row 2-letter "State" column is the
    player's HOME state/province (AB/ON/BC/QC under CANADA).
  * Under each state a header row "Rank Name State School Class Pos Commitment"
    then data rows: `<rank> <Name...> <home-state> <School> <classYear> <Pos>
    <Commitment...>`. Long commitments wrap onto a following continuation line
    (e.g. "Northwest Nazarene" + "University").
  * Promo / event / "HEADLINES" blurbs are interleaved and are skipped.

Usage:
    PYTHONPATH=backend python3 scripts/ingest_pbr_pdf_rankings.py [--dry-run]
    PYTHONPATH=backend python3 scripts/ingest_pbr_pdf_rankings.py \
        --pdf "/Users/naterasmussen/Downloads/PBR RANKINGS.pdf" --grad-year 2026
"""

import argparse
import re
import sys
from collections import Counter
from pathlib import Path

import pdfplumber

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scrape_recruits import compute_score, norm_name, split_name  # noqa: E402
from team_matching import get_team_id_by_school, normalize_opponent  # noqa: E402

from app.models.database import get_connection  # noqa: E402

DEFAULT_PDF = "/Users/naterasmussen/Downloads/PBR RANKINGS.pdf"
SCHOOL_MAP_PATH = (
    Path(__file__).resolve().parent.parent / "backend" / "data" / "recruit_school_map.json"
)

# All-caps section headers that set the "current state" we're under.
STATE_HEADERS = {"WASHINGTON", "OREGON", "CALIFORNIA", "UTAH", "NEVADA", "CANADA"}

# Valid 2-letter home-state / province codes used to delimit the player name
# from the rest of the row. US states + Canadian provinces. A bare 2-letter
# uppercase token that ISN'T one of these (initials like "AJ"/"JW", suffix
# "IV") is NOT treated as the state delimiter.
_US_STATES = set(
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO "
    "MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split()
)
_CA_PROVINCES = set("AB BC MB NB NL NS NT NU ON PE QC SK YT".split())
HOME_CODES = _US_STATES | _CA_PROVINCES

# Lines that are promo / event / divider blurbs, never data rows or commitment
# spills. When we hit one we close the current row so a real commitment never
# gets a promo fragment appended to it.
_PROMO_RE = re.compile(
    r"(^\+)"                     # "+ Full Rankings List", "+ Event Info | Register"
    r"|(^Find a Player)"
    r"|(^Create )"
    r"|(^Click here)"
    r"|(PLAYER Rankings)"
    r"|(^Class of )"
    r"|(Summer ID)"
    r"|(Rising Stars)"
    r"|(\(Invite-Only\))"
    r"|(@ )"                     # event location lines "July 7th @ Bannerwood Park ..."
    r"|(Event Info)"
    r"|(^PLAYER)"
    r"|(Spring/Sum|Spring/SUM)"  # "2026 Spring/SUMMER EVENTS"
    r"|(EVENTS$)"
    r"|(State Games)"
    r"|(Quick Hits)"
    r"|(Data Dives)"
    r"|(Stats \|)"
    r"|(Event Statistics)"
    r"|(Rankings Release)"
    r"|(Full Rankings List)"
    r"|(Profile)",
    re.IGNORECASE,
)

_RANK_RE = re.compile(r"^(\d+)\s+(.+)$")
_YEAR_RE = re.compile(r"^(?:19|20)\d{2}$")

# Commitment strings that fuzzily resolve to one of OUR teams but are NOT ours,
# so we must NOT attach them. The shared resolver's forward-LIKE fuzzy step
# matches these as substrings of a PNW school_name:
#   * "Columbia" -> University of British Columbia (also ambiguous w/ Columbia
#     University / Columbia Basin), so a bare "Columbia" is refused.
#   * "Washington University (MO)" / "Washington University" is WashU in
#     St. Louis, but "Washington University" is a substring of CWU's
#     "Central Washington University". Block it.
# Keys compared against normalize_opponent(commitment).lower() (parenthetical
# state tags like "(MO)" already stripped).
_AMBIGUOUS_COMMITMENTS = {
    "columbia",
    "washington university",
}


def _is_promo(line):
    return line == "HEADLINES" or bool(_PROMO_RE.search(line))


def extract_rows(pdf_path):
    """Parse the PDF into raw data rows: list of dicts {rank, section, rest}.

    `rest` is everything after the leading rank number, with any wrapped
    continuation line (a commitment spill) joined on. Promo/event lines are
    skipped and close the current row so they never pollute a commitment.
    """
    with pdfplumber.open(pdf_path) as pdf:
        text = "\n".join((p.extract_text() or "") for p in pdf.pages)

    rows = []
    section = None
    cur = None
    for raw in text.splitlines():
        s = raw.strip()
        if not s:
            continue
        if s in STATE_HEADERS:
            section = s
            cur = None
            continue
        if section is None:
            continue
        if s.startswith("Rank Name State"):  # column header row
            cur = None
            continue
        if _is_promo(s):
            cur = None
            continue
        m = _RANK_RE.match(s)
        # A real data row starts with a rank number followed by either a class
        # year (most rows) OR a valid 2-letter home code near the front (covers
        # rows whose SCHOOL name wrapped so the year landed on a continuation
        # line, e.g. "124 Wesley Saunders ON ÉCOLE SECONDAIRE CATHOLIQUE").
        # The "2026 Spring/SUMMER EVENTS" promo also starts with a number but is
        # already caught by _is_promo above.
        looks_like_row = False
        if m:
            has_year = bool(re.search(r"(?:19|20)\d{2}", s))
            head = m.group(2).split()[:5]
            has_home_code = any(
                len(t) == 2 and t.isupper() and t in HOME_CODES for t in head[1:]
            )
            looks_like_row = has_year or has_home_code
        if looks_like_row:
            cur = {"rank": int(m.group(1)), "section": section, "rest": m.group(2)}
            rows.append(cur)
        elif cur is not None:
            # Continuation line: a wrapped commitment spill. Join it on.
            cur["rest"] += " " + s
    return rows


def parse_row(rest):
    """Split a row's `rest` into (name, home_code, high_school, class_year,
    position, commitment_raw). Returns None if it doesn't parse as a player.

    name = tokens between the rank and the first valid 2-letter home code
    (>= 1 name token must precede it). class_year token splits school from
    pos/commitment.
    """
    toks = rest.split()
    code_idx = None
    for i, t in enumerate(toks):
        if i >= 1 and len(t) == 2 and t.isupper() and t in HOME_CODES:
            code_idx = i
            break
    if code_idx is None:
        return None
    name = " ".join(toks[:code_idx])
    home_code = toks[code_idx]
    after = toks[code_idx + 1:]

    year_idx = None
    for j, t in enumerate(after):
        if _YEAR_RE.match(t):
            year_idx = j
            break
    if year_idx is None:
        return None
    high_school = " ".join(after[:year_idx])
    class_year = int(after[year_idx])
    tail = after[year_idx + 1:]
    position = tail[0] if tail else ""
    commitment_raw = " ".join(tail[1:]) if len(tail) > 1 else ""
    if not name:
        return None
    return {
        "name": name,
        "home_code": home_code,
        "high_school": high_school,
        "class_year": class_year,
        "position": position,
        "commitment_raw": commitment_raw.strip(),
    }


def resolve_commitment(cur, commitment_raw, our_team_ids):
    """Resolve a raw commitment string to one of OUR team_ids, or None.

    Returns (team_id_or_None, status) where status is one of:
      'ours'      -> resolved to a PNW team we track
      'blank'     -> empty commitment (uncommitted)
      'non_pnw'   -> resolved to a team that isn't one of ours
      'unmatched' -> looks like it might be ours but didn't resolve
    """
    raw = (commitment_raw or "").strip()
    if not raw:
        return None, "blank"
    if normalize_opponent(raw).lower() in _AMBIGUOUS_COMMITMENTS:
        return None, "non_pnw"
    tid = get_team_id_by_school(cur, raw)
    if tid is None:
        return None, "unmatched"
    if tid in our_team_ids:
        return tid, "ours"
    return None, "non_pnw"


# Specific PNW school-name fragments. A commitment that contains one of these
# but fails to resolve to one of our teams is surfaced so we can add a
# team_matching alias. Deliberately NOT including generic words like "college"
# or bare state names, which match dozens of out-of-region JUCOs/D3s.
_PNW_HINT_RE = re.compile(
    r"(spokane falls|columbia basin|yakima valley|everett|edmonds|olympic college"
    r"|whitworth|nazarene|bellevue college|big bend|chemeketa|wenatchee|centralia"
    r"|shoreline|tacoma community|walla walla|grays harbor|skagit|pierce college"
    r"|treasure valley|blue mountain|clackamas|umpqua|mt\.? hood|mount hood"
    r"|linn-benton|linfield|willamette|whitman|george fox|corban|bushnell"
    r"|puget sound|warner pacific|gonzaga|university of british columbia"
    r"|douglas college|eastern oregon|pacific lutheran|western oregon"
    r"|oregon tech|oregon institute|lower columbia|lewis-clark|lewis & clark"
    r"|northwest nazarene|seattle university|university of portland)",
    re.IGNORECASE,
)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pdf", default=DEFAULT_PDF)
    ap.add_argument("--grad-year", type=int, default=2026)
    ap.add_argument("--dry-run", action="store_true",
                    help="Report what would change; write nothing.")
    args = ap.parse_args()

    pdf_path = Path(args.pdf)
    if not pdf_path.exists():
        print(f"PDF not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    import json
    school_map = json.loads(SCHOOL_MAP_PATH.read_text())
    our_team_ids = {int(k) for k in school_map}

    raw_rows = extract_rows(pdf_path)
    print(f"Parsed {len(raw_rows)} data rows from {pdf_path.name}")

    sections_seen = Counter()
    parsed = []
    for r in raw_rows:
        p = parse_row(r["rest"])
        if p is None:
            continue
        if p["class_year"] != args.grad_year:
            continue
        sections_seen[r["section"]] += 1
        p["rank"] = r["rank"]
        p["section"] = r["section"]
        first, last = split_name(p["name"])
        p["first"] = first
        p["last"] = last
        parsed.append(p)

    print(f"States ingested: {dict(sections_seen)}")
    print(f"{args.grad_year} rows parsed: {len(parsed)}")

    with get_connection() as conn:
        cur = conn.cursor()

        # Resolve every commitment.
        to_apply = []           # rows that resolve to one of our teams
        skipped_non_pnw = 0
        skipped_blank = 0
        failed_pnw_looking = []  # (commitment_raw, name) needing an alias
        for p in parsed:
            tid, status = resolve_commitment(cur, p["commitment_raw"], our_team_ids)
            if status == "ours":
                p["team_id"] = tid
                to_apply.append(p)
            elif status == "blank":
                skipped_blank += 1
            elif status == "non_pnw":
                skipped_non_pnw += 1
            else:  # unmatched
                skipped_non_pnw += 1
                if p["commitment_raw"] and _PNW_HINT_RE.search(p["commitment_raw"]):
                    failed_pnw_looking.append((p["commitment_raw"], p["name"]))

        print(f"Rows resolving to OUR teams: {len(to_apply)}")
        print(f"Skipped (blank/uncommitted): {skipped_blank}")
        print(f"Skipped (non-PNW commit / unmatched): {skipped_non_pnw}")
        if failed_pnw_looking:
            print(f"PNW-LOOKING commitments that FAILED to resolve "
                  f"({len(failed_pnw_looking)}) — may need a team_matching alias:")
            for raw, nm in sorted(set(failed_pnw_looking)):
                print(f"    {raw!r}  (e.g. {nm})")
        else:
            print("No PNW-looking commitments failed to resolve.")

        # Load existing recruits keyed by (norm first+last, grad_year).
        cur.execute(
            "SELECT id, first_name, last_name, state, committed_team_id, "
            "bbnw_state_rank, sources FROM recruits WHERE grad_year = %s",
            (args.grad_year,),
        )
        existing = {}
        for row in cur.fetchall():
            key = norm_name(f"{row['first_name']} {row['last_name']}")
            existing[key] = row

        inserted = updated = 0
        for p in to_apply:
            key = norm_name(f"{p['first']} {p['last']}")
            ex = existing.get(key)
            if ex:
                # Keep an already-resolved destination; only attach pbr rank.
                team_id = ex["committed_team_id"] or p["team_id"]
                bbnw_rank = ex["bbnw_state_rank"]
                score = compute_score(bbnw_rank, p["rank"], p["home_code"])
                if not args.dry_run:
                    cur.execute(
                        "UPDATE recruits SET "
                        "pbr_state_rank = %s, committed_team_id = %s, "
                        "state = COALESCE(%s, state), "
                        "high_school = COALESCE(NULLIF(%s,''), high_school), "
                        "position = COALESCE(NULLIF(%s,''), position), "
                        "committed_raw = COALESCE(committed_raw, %s), "
                        "recruit_score = %s, "
                        "sources = (SELECT ARRAY(SELECT DISTINCT unnest("
                        "COALESCE(sources,'{}') || %s))), "
                        "last_seen = now() WHERE id = %s",
                        (p["rank"], team_id, p["home_code"], p["high_school"],
                         p["position"], p["commitment_raw"], score, ["pbr"], ex["id"]),
                    )
                updated += 1
            else:
                # New player — INSERT with the resolved destination.
                score = compute_score(None, p["rank"], p["home_code"])
                if not args.dry_run:
                    cur.execute(
                        "INSERT INTO recruits ("
                        "first_name, last_name, position, grad_year, high_school, "
                        "state, committed_team_id, committed_raw, pbr_state_rank, "
                        "recruit_score, sources, last_seen) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now()) "
                        "ON CONFLICT (first_name, last_name, grad_year) DO UPDATE SET "
                        "pbr_state_rank = EXCLUDED.pbr_state_rank, "
                        "committed_team_id = COALESCE(recruits.committed_team_id, "
                        "EXCLUDED.committed_team_id), "
                        "state = COALESCE(EXCLUDED.state, recruits.state), "
                        "high_school = COALESCE(EXCLUDED.high_school, recruits.high_school), "
                        "position = COALESCE(EXCLUDED.position, recruits.position), "
                        "recruit_score = EXCLUDED.recruit_score, "
                        "sources = (SELECT ARRAY(SELECT DISTINCT unnest("
                        "COALESCE(recruits.sources,'{}') || EXCLUDED.sources))), "
                        "last_seen = now()",
                        (p["first"], p["last"], p["position"] or None, args.grad_year,
                         p["high_school"] or None, p["home_code"], p["team_id"],
                         p["commitment_raw"] or None, p["rank"], score, ["pbr"]),
                    )
                inserted += 1

        mode = "DRY RUN — nothing written" if args.dry_run else "APPLIED"
        if not args.dry_run:
            conn.commit()
        print(f"[{mode}] would-insert={inserted}  would-update={updated}")


if __name__ == "__main__":
    main()
