"""
Season helpers shared by every scraper / maintenance script.

Why this exists
---------------
Until Sept 2026 almost every script carried its own `default=2026` and its
own copy of the "2026 -> 2025-26" academic-year conversion. Rolling the site
over to a new spring season meant hand-editing dozens of literals. Now the
scripts ask these helpers instead, so the ONLY things left to bump by hand at
season rollover are the two CURRENT_SEASON constants (backend config.py and
frontend seasons.js) plus the items listed in docs/SEASON_ROLLOVER.md.

How to import from a script (scripts/ is sys.path[0] whenever a script is run
as `python3 scripts/foo.py`, so no path setup is needed):

    from season_utils import scrape_season, summer_season, presto_season_str

From a one-liner (GitHub Actions, daily_update.sh) run from the repo root:

    python3 -c "import sys; sys.path.insert(0,'scripts'); from season_utils import scrape_season; print(scrape_season())"

Three different "seasons" live here on purpose:

  current_season()  what the SITE calls the current season (backend
                    CURRENT_SEASON). Bumped by hand in config.py. Read from
                    the file itself when the package is not importable, so
                    GitHub Actions and the server cron see the same value.
  scrape_season()   what the SCRAPERS should target = current_season().
                    Deliberately NOT derived from the calendar: a date rule
                    would flip every cron job to the new year on Sept 1,
                    while the old season's data (Series Planner, stats
                    recalcs) is still what the site shows. One bump of
                    CURRENT_SEASON in January moves scrapers and site together.
  upcoming_season() the calendar rule (next year from September on), used
                    only where "the year being recruited for" is meant, e.g.
                    the HS recruiting class the weekly recruits job scrapes.
  summer_season()   the WCL / summer-ball year = plain calendar year.
"""

from __future__ import annotations

import datetime as _dt


_CONFIG_PATH = __import__("pathlib").Path(__file__).resolve().parent.parent / "backend" / "app" / "config.py"


def current_season() -> int:
    """The site's current season: backend/app/config.py CURRENT_SEASON.

    Tries the package import first (PYTHONPATH=backend), then reads the
    constant straight out of config.py so a bare GitHub Actions runner or a
    cron shell gets the same answer. Last resort: the calendar rule.
    """
    try:
        from app.config import CURRENT_SEASON  # needs PYTHONPATH=backend
        return int(CURRENT_SEASON)
    except Exception:
        pass
    try:
        import re
        m = re.search(r"^CURRENT_SEASON\s*=\s*(\d{4})", _CONFIG_PATH.read_text(), re.M)
        if m:
            return int(m.group(1))
    except Exception:
        pass
    return upcoming_season()


def scrape_season(today: _dt.date | None = None) -> int:
    """The spring season the scrapers should target: the site's CURRENT_SEASON.

    This used to be a calendar rule (next year from September). That flipped
    every no-argument cron job to an empty 2027 season on 2026-09-01 while
    the site was still serving 2026, so the rule now follows the one constant
    the owner bumps by hand (docs/SEASON_ROLLOVER.md). `today` is accepted
    for call-site compatibility and ignored.
    """
    return current_season()


def upcoming_season(today: _dt.date | None = None) -> int:
    """Calendar rule: the year through August, next year from September on.

    Why September: the academic year starts in the fall, when schools post
    next spring's rosters and the HS class that will enroll next fall is the
    one committing. Use this only where "the year being recruited for" is
    meant (the recruits workflow); scrapers use scrape_season().
    """
    today = today or _dt.date.today()
    return today.year if today.month <= 8 else today.year + 1


def summer_season(today: _dt.date | None = None) -> int:
    """The summer-league (WCL) season = the calendar year. WCL plays
    June to August only, so there is never a year-boundary question."""
    today = today or _dt.date.today()
    return today.year


def presto_season_str(season) -> str:
    """Integer season -> PrestoSports / NWAC academic-year URL string.

    2027 -> "2026-27", 2026 -> "2025-26". Accepts an int or a numeric string.
    """
    season = int(season)
    return f"{season - 1}-{str(season)[2:]}"


def season_from_presto(s) -> int:
    """Inverse of presto_season_str: "2026-27" -> 2027. A plain "2027"
    (or int) passes through unchanged so callers can accept either form."""
    text = str(s).strip()
    if "-" in text:
        return int(text.split("-")[0]) + 1
    return int(text)


if __name__ == "__main__":
    # `python3 scripts/season_utils.py` prints the values for a quick check.
    print(f"current_season = {current_season()}")
    print(f"scrape_season  = {scrape_season()}  ({presto_season_str(scrape_season())})")
    print(f"summer_season  = {summer_season()}")


def page_matches_season(html, season) -> bool:
    """Does a Sidearm/Presto page's heading talk about `season`?

    Used before trusting a YEAR-LESS fallback URL (`/sports/baseball/stats`
    instead of `/stats/2027`). In January the year-less page still shows the
    finished season, so saving it under the new year would copy last year's
    finals into this year's tables. Looks at the <title> and the first
    headings for "2027" or "2026-27"; absent either, the page is not trusted.
    """
    if not html:
        return False
    try:
        season = int(season)
    except (TypeError, ValueError):
        return False
    import re as _re
    head = html[:20000]
    parts = _re.findall(r"<(?:title|h1|h2|h3)[^>]*>(.*?)</(?:title|h1|h2|h3)>", head, _re.I | _re.S)
    hay = _re.sub(r"<[^>]+>", " ", " ".join(parts)) if parts else _re.sub(r"<[^>]+>", " ", head)
    return (str(season) in hay) or (f"{season - 1}-{str(season)[2:]}" in hay)
