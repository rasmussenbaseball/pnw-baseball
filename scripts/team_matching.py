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
    # Disambiguate schools whose names fuzzy-match multiple teams. The Portland
    # site refers to UW as "Washington" in URLs/opponent strings; without this
    # alias it would fall through to fuzzy match and collide with Wash. St.
    "washington": "UW",
    "washington state": "Wash. St.",
}


def normalize_opponent(name):
    """Strip rankings, parenthetical state tags, and extra whitespace.

    Examples:
        "#5 Lewis-Clark State"  -> "Lewis-Clark State"
        "Pacific (Ore.)"        -> "Pacific"
    """
    if not name:
        return ""
    name = re.sub(r'^#\d+\s+', '', name)
    name = re.sub(r'\s*\(.*?\)\s*$', '', name)
    return name.strip()


def get_team_id_by_short_name(cur, short_name):
    """Exact short_name lookup. Returns team_id or None."""
    cur.execute("SELECT id FROM teams WHERE short_name = %s", (short_name,))
    row = cur.fetchone()
    return row["id"] if row else None


def get_team_id_by_school(cur, name_fragment, prefer_division_of_team_id=None):
    """Fuzzy-lookup a team by school_name, name, or short_name.

    Resolution order:
      1. Alias table match on raw and normalized name
      2. Exact short_name match (case-insensitive)
      3. Exact school_name or name match
      4. Bidirectional LIKE match (only if exact match returned nothing)
      5. If multiple fuzzy hits, prefer the shortest name; then prefer a team
         in the same division as prefer_division_of_team_id when provided.

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

    names_to_try = [name_fragment]
    normalized = normalize_opponent(name_fragment)
    if normalized.lower() != name_fragment.strip().lower():
        names_to_try.append(normalized)

    rows = []

    # 2) + 3) Exact matches
    for frag in names_to_try:
        # Exact short_name match — highest confidence
        cur.execute(
            """
            SELECT t.id, t.short_name, t.school_name, c.division_id
            FROM teams t
            JOIN conferences c ON c.id = t.conference_id
            WHERE LOWER(t.short_name) = LOWER(%s)
            """,
            (frag,),
        )
        rows = cur.fetchall()
        if len(rows) == 1:
            return rows[0]["id"]
        if rows:
            break

        # Exact school_name or name match
        cur.execute(
            """
            SELECT t.id, t.short_name, t.school_name, c.division_id
            FROM teams t
            JOIN conferences c ON c.id = t.conference_id
            WHERE LOWER(t.school_name) = LOWER(%s)
               OR LOWER(t.name) = LOWER(%s)
            """,
            (frag, frag),
        )
        rows = cur.fetchall()
        if len(rows) == 1:
            return rows[0]["id"]
        if rows:
            break

    # 4) Fuzzy matching only when exact matches found nothing
    if not rows:
        for frag in names_to_try:
            cur.execute(
                """
                SELECT t.id, t.short_name, t.school_name, c.division_id
                FROM teams t
                JOIN conferences c ON c.id = t.conference_id
                WHERE LOWER(t.school_name) LIKE LOWER(%s)
                   OR LOWER(t.name) LIKE LOWER(%s)
                   OR LOWER(%s) LIKE '%%' || LOWER(t.school_name) || '%%'
                   OR LOWER(%s) LIKE '%%' || LOWER(t.name) || '%%'
                """,
                (f"%{frag}%", f"%{frag}%", frag, frag),
            )
            rows = cur.fetchall()
            if rows:
                if len(rows) > 1:
                    frag_low = frag.strip().lower()
                    exact_sub = [
                        r for r in rows
                        if r["school_name"] and r["school_name"].lower() == frag_low
                    ]
                    if exact_sub:
                        rows = exact_sub
                    else:
                        # Prefer the SHORTEST short_name. This handles both
                        # "Pacific" beating "Warner Pacific" AND "Washington"
                        # picking UW (short "UW", len 2) over Wash. St. (short
                        # "Wash. St.", len 9). The previous heuristic used
                        # abs(len(short) - len(frag)) which broke for long
                        # inputs like "Washington" because it picked whichever
                        # candidate was closest in length to the input.
                        rows.sort(
                            key=lambda r: len(r.get("short_name", "") or "")
                        )
                break

    if not rows:
        return None
    if len(rows) == 1:
        return rows[0]["id"]

    # 5) Multiple matches — prefer same division when caller supplied a hint
    if prefer_division_of_team_id:
        cur.execute(
            """
            SELECT c.division_id
            FROM teams t
            JOIN conferences c ON c.id = t.conference_id
            WHERE t.id = %s
            """,
            (prefer_division_of_team_id,),
        )
        div_row = cur.fetchone()
        if div_row:
            same_div = [
                r for r in rows
                if r["division_id"] == div_row["division_id"]
            ]
            if same_div:
                return same_div[0]["id"]

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
