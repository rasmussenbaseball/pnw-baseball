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
    # Strip trailing parenthetical like "(Ore.)"
    name = re.sub(r'\s*\(.*?\)\s*$', '', name)
    return name.strip()


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

    Resolution order:
      1. Alias table match on raw and normalized name
      2. Exact short_name match (case-insensitive). Ties between multiple
         actives broken by prefer_division_of_team_id.
      3. Exact school_name or name match. Same tie-break.
      4. Forward LIKE fuzzy match (team name contained in or containing
         the input). The bare `input LIKE '%team_name%'` form was removed
         because it silently matched "Fresno Pacific University" to D3
         Pacific. Prefix-unqualified schools now fall through to OOC.
      5. If multiple fuzzy hits, prefer the shortest short_name, then
         prefer a team in the same division as the caller's hint.

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
    rows = []

    # 2) + 3) Exact matches. Each query orders is_active=1 rows first so
    # that if a real team and an OOC placeholder share the same name, the
    # real team wins. This is the guard that keeps us from ever resolving
    # to an OOC shadow again.
    for frag in names_to_try:
        # Exact short_name match — highest confidence.
        # When two real teams share a short_name (NWC Pacific id=17 vs
        # WCC Pacific id=32857), caller's division hint picks the right one.
        cur.execute(
            """
            SELECT t.id, t.short_name, t.school_name, t.is_active, c.division_id
            FROM teams t
            JOIN conferences c ON c.id = t.conference_id
            WHERE LOWER(t.short_name) = LOWER(%s)
            ORDER BY t.is_active DESC, LENGTH(t.short_name) ASC
            """,
            (frag,),
        )
        rows = cur.fetchall()
        if rows:
            # If any active team matched, use it; ignore inactive placeholders.
            active = [r for r in rows if r.get("is_active")]
            if active:
                chosen = _prefer_same_division(active, hint_div)
                return chosen[0]["id"]
            # No active match — fall through to try school/name before accepting OOC
            pass

        # Exact school_name or name match
        cur.execute(
            """
            SELECT t.id, t.short_name, t.school_name, t.is_active, c.division_id
            FROM teams t
            JOIN conferences c ON c.id = t.conference_id
            WHERE LOWER(t.school_name) = LOWER(%s)
               OR LOWER(t.name) = LOWER(%s)
            ORDER BY t.is_active DESC, LENGTH(t.short_name) ASC
            """,
            (frag, frag),
        )
        rows = cur.fetchall()
        if rows:
            active = [r for r in rows if r.get("is_active")]
            if active:
                chosen = _prefer_same_division(active, hint_div)
                return chosen[0]["id"]
            break

    # 4) Fuzzy matching only when exact matches found nothing active.
    # NOTE: The previous backward LIKE `input LIKE '%team_name%'` was
    # removed — it silently matched "Fresno Pacific University" against
    # D3 Pacific's school_name "Pacific University" and created ghost
    # games. Forward LIKE is kept because it handles the useful case
    # where the caller passes a prefix of a longer school_name (e.g.
    # input "Pacific" matching school_name "Pacific University"). Inputs
    # with a qualifying prefix that no team row covers (e.g. "Fresno
    # Pacific") now fall through to get_or_create_ooc_team, which
    # creates a clearly-visible OOC placeholder.
    if not rows or not any(r.get("is_active") for r in rows):
        for frag in names_to_try:
            cur.execute(
                """
                SELECT t.id, t.short_name, t.school_name, t.is_active, c.division_id
                FROM teams t
                JOIN conferences c ON c.id = t.conference_id
                WHERE LOWER(t.school_name) LIKE LOWER(%s)
                   OR LOWER(t.name) LIKE LOWER(%s)
                """,
                (f"%{frag}%", f"%{frag}%"),
            )
            rows = cur.fetchall()
            if rows:
                # Prefer active teams first; only fall back to OOC if no active match
                active_rows = [r for r in rows if r.get("is_active")]
                if active_rows:
                    rows = active_rows
                if len(rows) > 1:
                    frag_low = frag.strip().lower()
                    exact_sub = [
                        r for r in rows
                        if r["school_name"] and r["school_name"].lower() == frag_low
                    ]
                    if exact_sub:
                        rows = exact_sub
                    else:
                        # Prefer the SHORTEST short_name. Handles "Pacific" beating
                        # "Warner Pacific" AND "Washington" picking UW (short len 2)
                        # over Wash. St. (short len 9). The previous heuristic used
                        # abs(len(short) - len(frag)) which broke for long inputs.
                        rows.sort(
                            key=lambda r: len(r.get("short_name", "") or "")
                        )
                break

    if not rows:
        return None
    if len(rows) == 1:
        return rows[0]["id"]

    # 5) Multiple fuzzy matches — prefer same division when caller supplied a hint
    if hint_div:
        filtered = _prefer_same_division(rows, hint_div)
        if filtered:
            return filtered[0]["id"]

    return rows[0]["id"]


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
