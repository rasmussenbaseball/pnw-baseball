#!/usr/bin/env python3
"""
Backfill self-play games: create OOC opponent team rows and fix game records.

Context: 148 games in the 2026 season have home_team_id == away_team_id because
the scraper couldn't resolve the out-of-conference opponent. The opponent's
batting/pitching lines were still written but with team_id=NULL.

This script:
  1) Parses the opponent name from each game's source_url slug
  2) Looks for an existing matching team in the teams table
  3) If not found, creates a new team with is_active=0 (so it won't appear
     on the site — teams are filtered WHERE is_active = 1)
  4) Updates the game row so home_team_id != away_team_id
  5) Updates the orphan NULL team_id game_batting / game_pitching rows
     to point at the new opponent team_id

Home/away heuristic: we assume the scraping team was HOME (it's the first
team we can resolve, and we set away_team_id to the new opponent). For OOC
early-season games many PNW teams actually travel south, so some may be
wrong — but the important fix is getting the opponent resolved. Home/away
polish can happen later via a JSON-LD re-parse pass.

Usage (on server):
    cd /opt/pnw-baseball
    PYTHONPATH=backend python3 scripts/backfill_self_play_games.py --dry-run
    PYTHONPATH=backend python3 scripts/backfill_self_play_games.py
"""

import argparse
import logging
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
from app.models.database import get_connection

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


# ---- Slug parsing ---------------------------------------------------------

def extract_opponent_slug(url):
    """Pull the opponent slug from a Sidearm boxscore URL.

    URL format:
        https://host/sports/baseball/stats/{YEAR}/{OPPONENT-SLUG}/boxscore/{ID}
    Some URLs use academic year (2025-26) instead of calendar year.
    """
    if not url:
        return None
    m = re.search(r"/stats/[^/]+/([^/]+)/boxscore/", url)
    if not m:
        return None
    return m.group(1)


def normalize_slug(slug):
    """Turn 'california-state-university-monterey-bay' into a display name."""
    if not slug:
        return None
    s = slug

    # Strip trailing game-type suffixes like -7-inn-, -9-inn-, -dh-
    s = re.sub(r"-\d+-inn-?$", "", s)
    s = re.sub(r"-dh-?$", "", s)
    s = s.strip("-")

    # Strip leading ranking like "-13-oklahoma" -> "oklahoma"
    m = re.match(r"^-?\d+-(.+)$", s)
    if m and len(m.group(1)) > 2:
        s = m.group(1)

    # Common phrase substitutions BEFORE title casing
    s = re.sub(r"california-state-university", "cal-state", s)
    s = re.sub(r"cal-state-university", "cal-state", s)
    s = re.sub(r"-university-?$", "", s)

    # Dashes -> spaces, then title case
    name = s.replace("-", " ").strip()
    name = " ".join(w.capitalize() for w in name.split())

    # State abbreviations + special cases
    name = re.sub(r"\bAriz\b", "(AZ)", name)
    name = re.sub(r"\bCalif\b", "(CA)", name)
    name = re.sub(r"\bAz\b", "(AZ)", name)
    name = re.sub(r"\bUsc\b", "USC", name)
    name = re.sub(r"\bUcla\b", "UCLA", name)
    name = re.sub(r"\bUnlv\b", "UNLV", name)
    name = re.sub(r"\bCsun\b", "Cal State Northridge", name)
    name = re.sub(r"\bUc\b", "UC", name)
    # Remove stray leading or trailing punctuation
    name = re.sub(r"\s+\(\s*\)", "", name)
    name = name.strip()

    # Alias post-processing: collapse same-school duplicates where slug variants
    # produce different but equivalent names. Key = output from the steps above.
    aliases = {
        "Occidental College":                "Occidental",
        "Whittier College":                  "Whittier",
        "University Of La Verne":            "La Verne",
        "Benedictine Mesa":                  "Benedictine Mesa (AZ)",
        "Benedictine University Mesa (AZ)":  "Benedictine Mesa (AZ)",
        "Ouaz":                              "Ottawa University Arizona",
        "Nelson Aic":                        "Nelson University (AZ)",
    }
    if name in aliases:
        name = aliases[name]

    return name if name else None


# ---- Opponent resolution --------------------------------------------------

def find_existing_team(cur, name):
    """Look for an existing team matching this name. Returns (id, label) or None."""
    if not name:
        return None

    # 1) exact short_name
    cur.execute(
        "SELECT id, short_name, school_name FROM teams WHERE LOWER(short_name) = LOWER(%s) LIMIT 1",
        (name,),
    )
    r = cur.fetchone()
    if r:
        return (r["id"], f"exact short_name ({r['short_name']!r})")

    # 2) exact school_name
    cur.execute(
        "SELECT id, short_name, school_name FROM teams WHERE LOWER(school_name) = LOWER(%s) LIMIT 1",
        (name,),
    )
    r = cur.fetchone()
    if r:
        return (r["id"], f"exact school_name ({r['school_name']!r})")

    # 3) substring on school_name (either direction)
    like = f"%{name.lower()}%"
    cur.execute(
        """
        SELECT id, short_name, school_name
        FROM teams
        WHERE LOWER(school_name) LIKE %s
           OR LOWER(%s) LIKE CONCAT('%%', LOWER(school_name), '%%')
        ORDER BY ABS(LENGTH(school_name) - LENGTH(%s))
        LIMIT 1
        """,
        (like, name, name),
    )
    r = cur.fetchone()
    if r:
        return (r["id"], f"fuzzy school_name ({r['school_name']!r})")

    return None


def get_or_create_ooc_conference(cur, dry_run):
    """Look up or create the 'Out of Conference' bucket. All backfilled OOC
    opponents point at this one conference so they're easy to find, inspect,
    or clean up later. division_id=1 matches the existing 'Independent'
    conference's umbrella bucket."""
    cur.execute(
        "SELECT id FROM conferences WHERE abbreviation = 'OOC' LIMIT 1"
    )
    r = cur.fetchone()
    if r:
        return r["id"]
    if dry_run:
        return -1
    cur.execute(
        """
        INSERT INTO conferences (name, abbreviation, division_id)
        VALUES ('Out of Conference', 'OOC', 1)
        RETURNING id
        """
    )
    return cur.fetchone()["id"]


def create_opponent(cur, name, dry_run, ooc_conference_id):
    """Create a new is_active=0 team row. Returns new id, or -1 in dry-run."""
    if dry_run:
        return -1
    cur.execute(
        """
        INSERT INTO teams (name, school_name, short_name,
                           state, conference_id, is_active)
        VALUES (%s, %s, %s, 'N/A', %s, 0)
        RETURNING id
        """,
        (name, name, name, ooc_conference_id),
    )
    return cur.fetchone()["id"]


# ---- Per-game processing --------------------------------------------------

def process_game(cur, game, dry_run, opponent_cache, ooc_conference_id):
    """Resolve opponent, update game, re-attribute orphan rows. Returns dict."""
    gid = game["id"]
    url = game["source_url"]
    scraping_tid = game["home_team_id"]
    scraping_name = game["scraping_team_name"]

    slug = extract_opponent_slug(url)
    name = normalize_slug(slug) if slug else None

    result = {
        "gid": gid,
        "date": game["game_date"],
        "scraping_team": scraping_name,
        "slug": slug,
        "opp_name": name,
        "opp_id": None,
        "status": "",
        "orphan_bat": 0,
        "orphan_pit": 0,
    }

    if not name:
        result["status"] = "ERR: could not parse opponent from URL"
        return result

    # Cache key: use the NORMALIZED NAME so different slug variants that refer
    # to the same school share one team row (e.g. `chapman` vs `chapman-university`,
    # `cal-state-east-bay` vs `cal-state-east-bay-7-inn-`).
    cache_key = name
    if cache_key in opponent_cache:
        result["opp_id"] = opponent_cache[cache_key]["id"]
        result["status"] = "reuse: " + opponent_cache[cache_key]["label"]
    else:
        found = find_existing_team(cur, name)
        if found:
            opp_id, label = found
            result["opp_id"] = opp_id
            result["status"] = f"existing id={opp_id} ({label})"
        else:
            opp_id = create_opponent(cur, name, dry_run, ooc_conference_id)
            result["opp_id"] = opp_id
            result["status"] = (
                f"create new team {name!r} is_active=0"
                if dry_run else
                f"created new team id={opp_id} ({name}) is_active=0"
            )
        opponent_cache[cache_key] = {"id": result["opp_id"], "label": result["status"]}

    # Count orphan rows that will be re-attributed
    cur.execute("SELECT COUNT(*) AS n FROM game_batting WHERE game_id = %s AND team_id IS NULL", (gid,))
    result["orphan_bat"] = cur.fetchone()["n"]
    cur.execute("SELECT COUNT(*) AS n FROM game_pitching WHERE game_id = %s AND team_id IS NULL", (gid,))
    result["orphan_pit"] = cur.fetchone()["n"]

    if dry_run or result["opp_id"] in (None, -1):
        return result

    # APPLY: default scraping team = HOME, opponent = AWAY
    cur.execute("UPDATE games SET away_team_id = %s WHERE id = %s", (result["opp_id"], gid))
    cur.execute(
        "UPDATE game_batting SET team_id = %s WHERE game_id = %s AND team_id IS NULL",
        (result["opp_id"], gid),
    )
    cur.execute(
        "UPDATE game_pitching SET team_id = %s WHERE game_id = %s AND team_id IS NULL",
        (result["opp_id"], gid),
    )

    return result


# ---- Main -----------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Preview changes, no writes")
    args = parser.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        cur.execute(
            """
            SELECT g.id, g.game_date, g.home_team_id, g.away_team_id, g.source_url,
                   t.short_name AS scraping_team_name
            FROM games g
            LEFT JOIN teams t ON t.id = g.home_team_id
            WHERE g.home_team_id IS NOT NULL
              AND g.home_team_id = g.away_team_id
            ORDER BY g.game_date
            """
        )
        games = cur.fetchall()
        logger.info(f"{'DRY RUN — ' if args.dry_run else ''}"
                    f"Found {len(games)} self-play games")

        ooc_conference_id = get_or_create_ooc_conference(cur, args.dry_run)
        logger.info(f"OOC conference id: {ooc_conference_id}")

        opponent_cache = {}
        totals = {"created": 0, "matched": 0, "errors": 0,
                  "orphan_bat": 0, "orphan_pit": 0}
        new_teams = []

        for g in games:
            r = process_game(cur, g, args.dry_run, opponent_cache, ooc_conference_id)
            totals["orphan_bat"] += r["orphan_bat"]
            totals["orphan_pit"] += r["orphan_pit"]
            if r["status"].startswith("ERR"):
                totals["errors"] += 1
            elif "create" in r["status"] or "created" in r["status"]:
                totals["created"] += 1
                if r["slug"] not in [t["slug"] for t in new_teams]:
                    new_teams.append({"slug": r["slug"], "name": r["opp_name"]})
            else:
                totals["matched"] += 1

            print(f"  gid={r['gid']:<5} {r['date']}  "
                  f"scr={r['scraping_team']!s:<10} "
                  f"slug={r['slug']!s:<45} "
                  f"opp_name={r['opp_name']!s:<35}")
            print(f"         {r['status']}")
            print(f"         orphan batting={r['orphan_bat']}, pitching={r['orphan_pit']}")

        print()
        print("=" * 70)
        print("Summary")
        print("=" * 70)
        print(f"  Games processed:          {len(games)}")
        print(f"  Opponent matches (existing): {totals['matched']}")
        print(f"  New opponent teams created:  {totals['created']}")
        print(f"  Parse errors:                {totals['errors']}")
        print(f"  Orphan batting rows to re-attribute:  {totals['orphan_bat']}")
        print(f"  Orphan pitching rows to re-attribute: {totals['orphan_pit']}")
        print()
        if new_teams:
            print(f"  Unique new teams to create (is_active=0):")
            for t in sorted(new_teams, key=lambda x: x["name"] or ""):
                print(f"    {t['slug']:<45}  ->  {t['name']}")

        if args.dry_run:
            print()
            print("DRY RUN — no changes committed.")
        else:
            conn.commit()
            print()
            print("Committed.")


if __name__ == "__main__":
    main()
