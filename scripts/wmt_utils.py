"""
Seattle U WMT Games API helpers.

Seattle U's Sidearm V3 site renders everything client-side, so its stats,
schedule, records and box scores all come from https://api.wmt.games. Every
WMT season has its own numeric team id. Before Sept 2026 five scripts each
carried a copy of `{2025: 552115, 2026: 614833}` and silently skipped Seattle
U for any other season; only scrape_nwac.py knew how to discover a missing
id. This module is that discovery, shared.

Usage (scripts/ is already on sys.path when run as `python3 scripts/foo.py`):

    from wmt_utils import seattle_u_wmt_id
    wmt_team_id = seattle_u_wmt_id(season_year)   # int or None
"""

from __future__ import annotations

import logging

import requests

logger = logging.getLogger(__name__)

WMT_API = "https://api.wmt.games/api"

# Seattle U's WMT school slug (goseattleu.com).
SEATTLE_U_WMT_DOMAIN = "goseattleu"

# Known ids, kept as a fast path + offline fallback. New seasons do NOT need
# to be added here: resolve_wmt_team_id() looks them up. Add one only if the
# lookup ever breaks and you want a hard override.
SEATTLE_U_WMT_IDS = {
    2025: 552115,
    2026: 614833,
}

_UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}

# Per-process cache so a script that asks several times only hits the API once.
_cache: dict[tuple[str, int], int | None] = {}


def resolve_wmt_team_id(domain: str, season: int, known_ids: dict | None = None,
                        headers: dict | None = None) -> int | None:
    """Return the WMT baseball team id for `domain` (e.g. "goseattleu") in
    `season` (spring year, e.g. 2027).

    Order: known_ids -> in-process cache -> WMT API lookup (school endpoint
    gives the org id, then the statistics/teams endpoint filtered to baseball
    + that academic year). Returns None if nothing is found; callers decide
    whether that is a skip or an error.
    """
    season = int(season)
    if known_ids and known_ids.get(season):
        return known_ids[season]
    key = (domain, season)
    if key in _cache:
        return _cache[key]

    headers = headers or _UA
    found = None
    logger.info(f"  Looking up WMT team_id for {domain} season {season}...")
    try:
        r = requests.get(f"{WMT_API}/schools/{domain}", headers=headers, timeout=15)
        school_data = r.json().get("data", {})
        school_id = school_data.get("statistic_configuration", {}).get("school_id")
        if school_id:
            r2 = requests.get(
                f"{WMT_API}/statistics/teams",
                params={"filter[org_id]": school_id, "filter[sport_code]": "MBA",
                        "filter[season_academic_year]": season, "per_page": 5},
                headers=headers, timeout=15,
            )
            teams = r2.json().get("data", [])
            if teams:
                found = teams[0]["id"]
                logger.info(f"  Found WMT team_id: {found}")
    except Exception as e:
        logger.warning(f"  Could not discover WMT team_id for {domain} {season}: {e}")

    if found is None:
        logger.warning(f"  No WMT team id for {domain} season {season}")
    _cache[key] = found
    return found


def seattle_u_wmt_id(season: int) -> int | None:
    """Seattle U's WMT team id for a spring season (known map, then lookup)."""
    return resolve_wmt_team_id(SEATTLE_U_WMT_DOMAIN, season, known_ids=SEATTLE_U_WMT_IDS)
