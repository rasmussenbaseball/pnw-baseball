"""
Shared team-name matching helpers for all box-score scrapers.

Every scraper that attributes player stats to a team (scrape_boxscores.py,
backfill_sidearm_boxscores.py, backfill_wmt_boxscores.py, and future scrapers)
should use get_or_create_ooc_team from this module to map a string opponent
name to a team_id.

History: prior to April 2026, the backfill scripts each had their own naive
resolver that used `WHERE name ILIKE '%{opp}%' LIMIT 1` with no ORDER BY and
no alias table. That caused ghost rows (e.g. "Washington" matching UW when
it should have matched Washington State) which this module is designed to
prevent. See project memory for the cleanup that followed.

All functions take a psycopg2 cursor (with RealDictCursor) as their first
argument — no database connection is created here.
"""

import logging
import re

logger = logging.getLogger("team_matching")


# Cache of normalized team-name variants, lazily loaded for is_nonperson_name().
_TEAM_NAME_SET = None

# A roster cell whose "jersey number" is actually a date (e.g. "Apr 11",
# "May 6") is a misparsed schedule fragment, never a real player. This single
# signal accounts for every one of the 30 team/showcase rows cleaned in
# June 2026 (Mt Hood, Skagit Valley, Utah Yaks, "NW Scout", ...).
_MONTH_RE = re.compile(
    r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b", re.I
)

# Tokens that essentially never appear in a real person's name but are dead
# giveaways for a team / showcase org / scout service / JV squad that leaked
# in as a "player" (e.g. "Pacific University JV", "Idaho Prospects Baseball",
# "Spokane Crew Scout", "Western Washington University"). Kept deliberately to
# unambiguous organizational words so a real surname is never rejected.
_NONPERSON_TOKENS = {
    "university", "college", "collegiate", "juco", "academy", "showcase",
    "scout", "scouts", "prospects", "athletics", "baseball", "softball",
    "sports",
}

# Institution suffixes stripped when deriving a bare team name from school_name,
# so "Skagit Valley College" yields the variant "skagit valley".
_SCHOOL_SUFFIXES = (
    "community college", "state university", "college", "university",
    "cc", "jc", "juco",
)


def _norm_person_name(s):
    """Lowercase, drop punctuation (periods, apostrophes), collapse whitespace.
    'Mt. Hood' -> 'mt hood', "O'Neill" -> 'oneill'. Used so a team name still
    matches regardless of how the source punctuated it."""
    if not s:
        return ""
    s = s.lower().replace(".", " ").replace("'", "").replace("’", "")
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _load_team_name_set(cur):
    """Lazily build the set of punctuation-normalized team-name variants:
    short_name, name, school_name, name-minus-mascot, and school-minus-suffix.
    The last two catch cases like 'Blue Mountain' (from 'Blue Mountain
    Timberwolves' / 'Blue Mountain Community College') that an exact short_name
    match misses."""
    global _TEAM_NAME_SET
    if _TEAM_NAME_SET is not None:
        return _TEAM_NAME_SET
    variants = set()
    cur.execute("SELECT name, school_name, short_name FROM teams")
    for r in cur.fetchall():
        for fld in ("name", "school_name", "short_name"):
            v = _norm_person_name(r[fld])
            if v:
                variants.add(v)
        # name minus trailing mascot word: 'blue mountain timberwolves' -> 'blue mountain'
        nm = _norm_person_name(r["name"]).split()
        if len(nm) >= 3:
            variants.add(" ".join(nm[:-1]))
        # school_name minus an institution suffix: 'skagit valley college' -> 'skagit valley'
        sc = _norm_person_name(r["school_name"])
        for suf in _SCHOOL_SUFFIXES:
            if sc.endswith(" " + suf):
                variants.add(sc[: -(len(suf) + 1)].strip())
    _TEAM_NAME_SET = {v for v in variants if v}
    return _TEAM_NAME_SET


def is_nonperson_name(cur, first_name, last_name, jersey_number=None):
    """True if a parsed 'player' is really a team name, showcase org, scout
    service, JV squad, or a schedule/location fragment ("at Edmonds",
    "vs Big Bend") rather than a person.

    Player-creation paths should call this and skip the row when it returns
    True. Opponent / schedule strings leaking in as players produced ~351 (and
    a further 30) garbage "player" rows that cluttered search, cleaned up
    June 2026 — this is the anti-recurrence guard.

    Pass jersey_number when available: a roster row whose jersey is actually a
    date ("Apr 11") is a misparsed schedule cell, never a real player.
    """
    full = _norm_person_name(f"{first_name or ''} {last_name or ''}")
    if not full:
        return True

    # 1) Leading schedule/location fragment: "at Edmonds", "vs Big Bend"
    #    ('@'/punctuation already stripped by _norm_person_name).
    if full.split(" ", 1)[0] in ("at", "vs", "the"):
        return True

    # 2) Date-shaped jersey number => misparsed schedule cell, not a player.
    if jersey_number and _MONTH_RE.search(str(jersey_number)):
        return True

    # 3) Unambiguous organization / showcase / scout / JV tokens.
    if _NONPERSON_TOKENS & set(full.split()):
        return True

    # 4) Exact (punctuation-normalized) match to a team-name variant, incl.
    #    "at X" / "vs X" prefixed forms.
    team_set = _load_team_name_set(cur)
    if full in team_set:
        return True
    for pre in ("at ", "vs "):
        if full.startswith(pre) and full[len(pre):] in team_set:
            return True

    return False


# Known aliases for teams whose conventional Sidearm name doesn't match
# our short_name or school_name via fuzzy lookup. Keep keys lowercase.
_TEAM_ALIASES = {
    "montana state billings": "MSUB",
    "montana state-billings": "MSUB",
    "montana state university billings": "MSUB",
    "montana st university billings": "MSUB",
    "msu billings": "MSUB",
    "msu-billings": "MSUB",
    "mt hood": "Mt. Hood",
    "mt hood cc": "Mt. Hood",
    "mount hood": "Mt. Hood",
    "st. martin's": "SMU",
    "saint martin's": "SMU",
    "st martins": "SMU",
    "saint martins": "SMU",
    "college of idaho": "C of I",
    "the college of idaho": "C of I",
    "lewis-clark state": "LCSC",
    "lewis-clark st": "LCSC",
    "lewis-clark st.": "LCSC",
    "lc state": "LCSC",
    "northwest nazarene": "NNU",
    # Abbreviated / renamed JUCO + small-college forms PBR uses in HS recruit
    # commitments that don't fuzzy-match school_name (added 2026-06-14 while
    # ingesting the PBR rankings PDF).
    "everett cc": "Everett",                # school_name "Everett Community College"
    "edmonds community college": "Edmonds", # renamed to "Edmonds College"
    "edmonds cc": "Edmonds",
    "treasure valley cc": "Treasure Valley",
    "linfield college": "Linfield",         # renamed to "Linfield University"
    # UBC (British Columbia) is written a few ways by opponent sites.
    "british columbia": "UBC",
    "british colum.": "UBC",
    "british colum": "UBC",
    "univ. of british columbia": "UBC",
    "university of british columbia": "UBC",
    # Disambiguate schools whose names fuzzy-match multiple teams. The Portland
    # site refers to UW as "Washington" in URLs/opponent strings; without this
    # alias it would fall through to fuzzy match and collide with Wash. St.
    "washington": "UW",
    "washington state": "Wash. St.",
}


def normalize_opponent(name):
    """Strip rankings, parenthetical state tags, and extra whitespace.

    Examples:
        "#5 Lewis-Clark State"     -> "Lewis-Clark State"
        "No. 7 Oregon State"       -> "Oregon State"
        "Pacific (Ore.)"           -> "Pacific"
    """
    if not name:
        return ""
    # Strip "#5 " style rankings
    name = re.sub(r'^#\d+\s+', '', name)
    # Strip "No. 7 " or "No 7 " style rankings (Sidearm sites use this)
    name = re.sub(r'^No\.?\s*\d+\s+', '', name, flags=re.IGNORECASE)
    # Strip "1-seed " / "3-Seed " NCAA regional prefixes. Before this, every
    # regional opponent got its own OOC placeholder ("2-seed Portland",
    # "3-seed Central Wash.") instead of resolving to the real team.
    name = re.sub(r'^\d+\s*-\s*seed\s+', '', name, flags=re.IGNORECASE)
    # Strip trailing parenthetical like "(Ore.)"
    name = re.sub(r'\s*\(.*?\)\s*$', '', name)
    return name.strip()


# Words that carry no identity when comparing two spellings of a school.
# "Pomona-Pitzer Colleges" == "Pomona-Pitzer", "University of La Verne" ==
# "La Verne", "Jessup University" == "Jessup".
_KEY_GENERIC = {
    "university", "univ", "college", "colleges", "community", "cc",
    "of", "the", "at",
}
# NOTE: "and" is deliberately NOT generic -- "Lewis & Clark" (NWC, D3) and
# "Lewis-Clark" (LCSC, NAIA) must never key to the same school.

# Abbreviation expansions applied to the punctuation-stripped lowercase key
# (both the input and the stored names go through the same function, so
# a rule only has to make the two sides agree, not be "correct").
_KEY_ABBREV = (
    (r"\bwash\b", "washington"),
    (r"\bore\b", "oregon"),
    (r"\bcalif\b", "california"),
    (r"\bcal state\b", "california state"),
    (r"\bcal st\b", "california state"),
    (r"\bst\b", "state"),
    (r"\bmt\b", "mount"),
)


def _name_key(s):
    """Reduce a school spelling to a comparison key.

    "California State University Monterey Bay" -> "california state monterey bay"
    "Cal St. Monterey Bay"                      -> "california state monterey bay"
    "Concordia University Texas"                -> "concordia texas"
    "St. Thomas University"                     -> "state thomas"

    Used to recognise that a freshly scraped opponent string is the same
    school as an existing row, so the OOC auto-creator stops minting a new
    placeholder for every spelling variant (June-Sept 2026 audit found ~40
    such duplicate pairs).
    """
    if not s:
        return ""
    s = normalize_opponent(s).lower()
    s = s.replace("&", " and ").replace("'", "").replace("\u2019", "")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    for pat, rep in _KEY_ABBREV:
        s = re.sub(pat, rep, s)
    return " ".join(w for w in s.split() if w not in _KEY_GENERIC)


def _fuzzy_remainder_ok(frag_low, field_low):
    """True when `field_low` contains `frag_low` and everything OUTSIDE the
    match is generic filler ("university", "of", ...).

    "pacific"   in "pacific university"            -> True   (same school)
    "texas"     in "texas tech"                    -> False  (different school)
    "hawaii"    in "hawaii pacific"                -> False
    "lsu"       in "lsu shreveport"                -> False
    "arizona"   in "arizona state"                 -> False
    "pacific"   in "warner pacific university"     -> False

    The bare substring rule this replaces resolved Oregon's June 2026 NCAA
    games vs Texas to the OOC row "Texas Tech" (and Hawaii -> Hawaii
    Pacific, LSU -> LSU Shreveport, Arizona -> Arizona State), which then
    produced a shadow copy of the same game under a second opponent id.
    """
    if not frag_low or frag_low not in field_low:
        return False
    remainder = field_low.replace(frag_low, " ")
    remainder = re.sub(r"[^a-z0-9]+", " ", remainder)
    return all(w in _KEY_GENERIC for w in remainder.split())


def _pick_best(rows, hint_div, frag_low=None):
    """Tie-break a candidate list: same division as the caller's hint, then an
    exact school_name match, then the shortest short_name (so "Pacific" beats
    "Warner Pacific" and "UW" beats "Wash. St.")."""
    rows = _prefer_same_division(rows, hint_div)
    if frag_low and len(rows) > 1:
        exact = [r for r in rows
                 if (r.get("school_name") or "").lower() == frag_low]
        if exact:
            rows = exact
    return sorted(rows, key=lambda r: len(r.get("short_name") or ""))[0]


def get_team_id_by_short_name(cur, short_name):
    """Exact short_name lookup. Returns team_id or None."""
    cur.execute("SELECT id FROM teams WHERE short_name = %s", (short_name,))
    row = cur.fetchone()
    return row["id"] if row else None


def _get_hint_division(cur, prefer_division_of_team_id):
    """Look up the division_id of prefer_division_of_team_id, or None."""
    if not prefer_division_of_team_id:
        return None
    cur.execute(
        """
        SELECT c.division_id
        FROM teams t JOIN conferences c ON c.id = t.conference_id
        WHERE t.id = %s
        """,
        (prefer_division_of_team_id,),
    )
    row = cur.fetchone()
    return row["division_id"] if row else None


def _prefer_same_division(rows, hint_div):
    """If hint_div is given and any row matches it, return only those;
    otherwise return rows unchanged. Used to break ties between two teams
    whose short_name or school_name collides (e.g. NWC Pacific vs WCC
    University of the Pacific both have short_name='Pacific')."""
    if not hint_div:
        return rows
    same_div = [r for r in rows if r.get("division_id") == hint_div]
    return same_div if same_div else rows


def get_team_id_by_school(cur, name_fragment, prefer_division_of_team_id=None):
    """Fuzzy-lookup a team by school_name, name, or short_name.

    Candidate tiers, in priority order:
      1. Alias table match on raw and normalized name (returns immediately).
      2. Exact short_name / school_name / name match (case-insensitive), on
         the normalized string first, then the raw string.
      3. Normalized-key match (_name_key): spelling variants of the same
         school ("Cal State Monterey Bay" == "California State University
         Monterey Bay", "Pomona-Pitzer Colleges" == "Pomona-Pitzer").
      4. Guarded substring match: the input must be contained in
         school_name/name AND the leftover words must all be generic
         ("university", "of", ...). A bare "Texas" therefore no longer
         matches "Texas Tech", and "Hawaii" no longer matches "Hawaii
         Pacific" (both happened in 2026 and produced shadow games).

    Within each tier an ACTIVE team beats an inactive OOC placeholder, and
    an active hit in a lower tier beats an inactive hit in a higher tier
    (so an OOC shadow row named exactly "Western Oregon" never outranks the
    real WOU whose school_name is "Western Oregon University"). Ties are
    broken by prefer_division_of_team_id, then exact school_name, then the
    shortest short_name.

    Returns team_id or None when nothing could be matched.
    """
    if not name_fragment:
        return None

    raw_lower = name_fragment.strip().lower()
    norm_lower = normalize_opponent(name_fragment).lower()

    # 1) Alias table
    for alias_key, alias_short in _TEAM_ALIASES.items():
        if raw_lower == alias_key or norm_lower == alias_key:
            cur.execute(
                "SELECT t.id FROM teams t WHERE LOWER(t.short_name) = LOWER(%s)",
                (alias_short,),
            )
            row = cur.fetchone()
            if row:
                return row["id"]

    # Try NORMALIZED name first so ranking prefixes ("No. 7 ...", "#5 ...")
    # and trailing state tags ("(Ore.)") don't accidentally exact-match an
    # OOC placeholder that a past scraper auto-created with the raw string.
    names_to_try = []
    normalized = normalize_opponent(name_fragment)
    if normalized:
        names_to_try.append(normalized)
    if name_fragment.strip().lower() != normalized.lower():
        names_to_try.append(name_fragment)

    hint_div = _get_hint_division(cur, prefer_division_of_team_id)
    frag_low = (normalized or name_fragment).strip().lower()

    # 2) Exact matches (short_name, then school_name / name)
    exact_rows = []
    seen = set()
    for frag in names_to_try:
        cur.execute(
            """
            SELECT t.id, t.short_name, t.school_name, t.name, t.is_active,
                   c.division_id
            FROM teams t
            JOIN conferences c ON c.id = t.conference_id
            WHERE LOWER(t.short_name) = LOWER(%s)
               OR LOWER(t.school_name) = LOWER(%s)
               OR LOWER(t.name) = LOWER(%s)
            ORDER BY t.is_active DESC, LENGTH(t.short_name) ASC, t.id ASC
            """,
            (frag, frag, frag),
        )
        for r in cur.fetchall():
            if r["id"] not in seen:
                seen.add(r["id"])
                exact_rows.append(r)

    # 3) Normalized-key matches over every team row (321 rows; cheap)
    key_rows = []
    key = _name_key(name_fragment)
    if key:
        cur.execute(
            """
            SELECT t.id, t.short_name, t.school_name, t.name, t.is_active,
                   c.division_id
            FROM teams t
            JOIN conferences c ON c.id = t.conference_id
            """
        )
        for r in cur.fetchall():
            if r["id"] in seen:
                continue
            if key in (_name_key(r["short_name"]), _name_key(r["school_name"]),
                       _name_key(r["name"])):
                seen.add(r["id"])
                key_rows.append(r)

    # 4) Guarded substring matches
    fuzzy_rows = []
    for frag in names_to_try:
        fl = frag.strip().lower()
        if not fl:
            continue
        cur.execute(
            """
            SELECT t.id, t.short_name, t.school_name, t.name, t.is_active,
                   c.division_id
            FROM teams t
            JOIN conferences c ON c.id = t.conference_id
            WHERE LOWER(t.school_name) LIKE LOWER(%s)
               OR LOWER(t.name) LIKE LOWER(%s)
            """,
            (f"%{frag}%", f"%{frag}%"),
        )
        for r in cur.fetchall():
            if r["id"] in seen:
                continue
            if (_fuzzy_remainder_ok(fl, (r["school_name"] or "").lower())
                    or _fuzzy_remainder_ok(fl, (r["name"] or "").lower())):
                seen.add(r["id"])
                fuzzy_rows.append(r)

    tiers = (exact_rows, key_rows, fuzzy_rows)

    # Active (real) teams first, best tier wins ...
    for rows in tiers:
        active = [r for r in rows if r.get("is_active")]
        if active:
            return _pick_best(active, hint_div, frag_low)["id"]
    # ... then inactive OOC placeholders, best tier wins.
    for rows in tiers:
        if rows:
            return _pick_best(rows, hint_div, frag_low)["id"]

    return None


def get_or_create_ooc_team(cur, opponent_name, prefer_division_of_team_id=None):
    """Resolve an opponent name to a team_id, auto-creating an Out-of-Conference
    placeholder (is_active=0) when no match is found.

    This prevents NULL team_id rows in game_batting / game_pitching when we
    scrape games against teams that aren't yet in our teams table.

    The placeholder team is:
      - is_active = 0 (hidden from site listings)
      - state = 'N/A'
      - conference_id = the OOC conference (auto-created with abbreviation 'OOC')

    Returns a team_id (existing or newly created) or None only when opponent_name
    is blank after normalization.
    """
    if not opponent_name:
        return None
    cleaned = normalize_opponent(opponent_name).strip()
    if not cleaned:
        return None

    existing = get_team_id_by_school(
        cur, cleaned, prefer_division_of_team_id=prefer_division_of_team_id
    )
    if existing:
        return existing

    # Resolve / create the OOC conference
    cur.execute("SELECT id FROM conferences WHERE abbreviation = 'OOC' LIMIT 1")
    row = cur.fetchone()
    if row:
        ooc_conf_id = row["id"]
    else:
        cur.execute(
            """
            INSERT INTO conferences (name, abbreviation, division_id)
            VALUES ('Out of Conference', 'OOC', 1)
            RETURNING id
            """
        )
        ooc_conf_id = cur.fetchone()["id"]
        logger.info(f"Created OOC conference id={ooc_conf_id}")

    cur.execute(
        """
        INSERT INTO teams (name, school_name, short_name,
                           state, conference_id, is_active)
        VALUES (%s, %s, %s, 'N/A', %s, 0)
        RETURNING id
        """,
        (cleaned, cleaned, cleaned, ooc_conf_id),
    )
    new_id = cur.fetchone()["id"]
    logger.info(f"Auto-created OOC team '{cleaned}' (id={new_id}, is_active=0)")
    return new_id
