#!/usr/bin/env python3
"""
Populate the (currently empty) `player_seasons` table with each player's TRUE
class year per season, scraped from archived roster pages.

Why: freshman/transfer production was being back-calculated from a player's
single current `players.year_in_school` (e.g. "a Jr in 2026 was a Fr in 2024"),
which breaks for redshirts, transfers, and anyone who has left the program.
Archived rosters carry the real per-season class (Nuxt `academicYearShort`,
Sidearm roster cards), so we capture it once here and join on it instead.

For each four-year program x season, we fetch the roster, parse each player's
normalized class, match to the player_ids that actually have stats for that
team-season (the rows the production charts care about), and UPSERT into
player_seasons. Idempotent: clears + rewrites each (team, season) it processes.

NWAC (JUCO) is excluded — those are all Fr/So by definition and Presto rosters
don't reliably publish class.

Usage:
    PYTHONPATH=backend python3 scripts/backfill_player_seasons.py --dry-run
    PYTHONPATH=backend python3 scripts/backfill_player_seasons.py --seasons 2022-2026
    PYTHONPATH=backend python3 scripts/backfill_player_seasons.py --team "Oregon St."
"""
import argparse
import json
import logging
import re
import time
import unicodedata

import requests
from bs4 import BeautifulSoup

from app.models.database import get_connection

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("backfill_player_seasons")
UA = {"User-Agent": "Mozilla/5.0 (compatible; pnw-baseball-rosters/1.0)"}

# Sidearm-Nuxt D1 sites (class lives in the __NUXT_DATA__ payload).
NUXT_TEAMS = {
    "UW": "https://gohuskies.com", "Oregon": "https://goducks.com",
    "Oregon St.": "https://osubeavers.com", "Wash. St.": "https://wsucougars.com",
    "Seattle U": "https://goseattleu.com",
}
# Classic Sidearm sites (class on the roster card).
SIDEARM_TEAMS = {
    "CWU": "https://wildcatsports.com", "SMU": "https://smusaints.com",
    "MSUB": "https://msubsports.com", "WOU": "https://wouwolves.com", "NNU": "https://nnusports.com",
    "UPS": "https://loggerathletics.com", "PLU": "https://golutes.com",
    "Whitman": "https://athletics.whitman.edu", "Whitworth": "https://whitworthpirates.com",
    "L&C": "https://golcathletics.com", "Pacific": "https://goboxers.com",
    "Linfield": "https://golinfieldwildcats.com", "GFU": "https://athletics.georgefox.edu",
    "LCSC": "https://lcwarriors.com", "EOU": "https://eousports.com", "OIT": "https://oregontechowls.com",
    "C of I": "https://yoteathletics.com", "Corban": "https://corbanwarriors.com",
    "Bushnell": "https://bushnellbeacons.com", "Warner Pacific": "https://wpuknights.com",
    "Gonzaga": "https://gozags.com", "Portland": "https://portlandpilots.com",
}


def _na(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s or "") if not unicodedata.combining(c))


def _norm(s):
    return re.sub(r"[^a-z]", "", _na(s).lower())


def normalize_class(txt):
    """Map any roster class string to Fr / R-Fr / So / R-So / Jr / R-Jr / Sr / R-Sr / Gr."""
    if not txt:
        return None
    t = _na(txt).strip().lower()
    rs = ("redshirt" in t) or t.startswith("r-") or bool(re.match(r"^rs[\s.\-]", t)) or bool(re.match(r"^r[\s.\-]?(fr|so|jr|sr)", t))
    base = None
    if "fresh" in t:
        base = "Fr"
    elif "soph" in t:
        base = "So"
    elif "jun" in t:
        base = "Jr"
    elif "sen" in t:
        base = "Sr"
    elif "grad" in t:
        base = "Gr"
    else:
        m = re.search(r"\b(fr|so|jr|sr|gr)\b", t.replace(".", " "))
        if m:
            base = {"fr": "Fr", "so": "So", "jr": "Jr", "sr": "Sr", "gr": "Gr"}[m.group(1)]
    if not base:
        return None
    return ("R-" + base) if (rs and base != "Gr") else base


def parse_nuxt_classes(html):
    """{(first_lc, last_lc): class} from a Sidearm-Nuxt roster payload."""
    node = BeautifulSoup(html, "html.parser").find("script", id="__NUXT_DATA__")
    if not node or not node.string:
        return {}
    try:
        data = json.loads(node.string)
    except Exception:  # noqa: BLE001
        return {}
    if not isinstance(data, list):
        return {}

    def rs(idx):
        return data[idx] if isinstance(idx, int) and 0 <= idx < len(data) and isinstance(data[idx], str) else None

    out = {}
    for v in data:
        if not isinstance(v, dict):
            continue
        first = rs(v.get("firstName")) or rs(v.get("first_name"))
        last = rs(v.get("lastName")) or rs(v.get("last_name"))
        if not first or not last:
            continue
        cls = normalize_class(rs(v.get("academicYearShort")) or rs(v.get("academicYearLong")))
        # legacy schema: profile_field_values list with a class entry
        if not cls:
            for idx in v.values():
                if isinstance(idx, int) and 0 <= idx < len(data) and isinstance(data[idx], list):
                    for m in data[idx]:
                        if isinstance(m, int) and 0 <= m < len(data) and isinstance(data[m], dict):
                            for vv in data[m].values():
                                c = normalize_class(rs(vv)) if isinstance(vv, int) else None
                                if c:
                                    cls = c
                                    break
                        if cls:
                            break
                if cls:
                    break
        if cls:
            out[(first.lower(), last.lower())] = cls
    return out


def parse_sidearm_classes(html):
    """{(first_lc, last_lc): class} from classic Sidearm roster cards."""
    soup = BeautifulSoup(html, "html.parser")
    cards = soup.select("li.sidearm-roster-player") or soup.select(".sidearm-roster-player")
    out = {}
    for c in cards:
        nm = c.select_one(".sidearm-roster-player-name") or c.find("a")
        name = nm.get_text(" ", strip=True) if nm else ""
        name = re.sub(r"^\s*#?\d+\s+", "", name).strip()
        parts = name.split()
        if len(parts) < 2:
            continue
        cls = None
        # Prefer the academic-year span, else scan spans/tds for a class token.
        ay = c.select_one(".sidearm-roster-player-academic-year, .sidearm-roster-player-class")
        if ay:
            cls = normalize_class(ay.get_text(" ", strip=True))
        if not cls:
            for el in c.find_all(["span", "td", "div"]):
                cls = normalize_class(el.get_text(" ", strip=True))
                if cls:
                    break
        if cls:
            out[(parts[0].lower(), parts[-1].lower())] = cls
    return out


def fetch_roster_classes(base, year, is_nuxt):
    """Union of class data from the season URL (+ bare /roster for current)."""
    base = base.rstrip("/")
    urls = [f"{base}/sports/baseball/roster/{year}"]
    urls.append(f"{base}/sports/baseball/roster")  # bare = current; some sites 404 the year path
    merged = {}
    for url in urls:
        try:
            r = requests.get(url, headers=UA, timeout=30)
            if r.status_code != 200:
                continue
            parsed = parse_nuxt_classes(r.text) if is_nuxt else parse_sidearm_classes(r.text)
        except Exception as e:  # noqa: BLE001
            log.warning("    %s error: %s", url, str(e)[:80])
            parsed = {}
        for k, v in parsed.items():
            merged.setdefault(k, v)
        time.sleep(0.3)
    return merged


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--team", help="Only this DB short_name")
    ap.add_argument("--seasons", default="2022-2026", help="Inclusive range")
    args = ap.parse_args()

    lo, hi = (int(x) for x in args.seasons.split("-"))
    seasons = list(range(lo, hi + 1))
    teams = {**NUXT_TEAMS, **SIDEARM_TEAMS}
    if args.team:
        teams = {args.team: teams[args.team]}

    tot_ins = tot_unmatched = 0
    with get_connection() as conn:
        conn.autocommit = False
        cur = conn.cursor()
        for short, base in teams.items():
            is_nuxt = short in NUXT_TEAMS
            cur.execute("SELECT id FROM teams WHERE short_name = %s ORDER BY is_active DESC LIMIT 1", (short,))
            row = cur.fetchone()
            if not row:
                log.warning("  %s: team not found", short)
                continue
            team_id = row["id"]
            log.info("%s (team_id=%s) [%s]", short, team_id, "Nuxt" if is_nuxt else "Sidearm")

            for season in seasons:
                # Players who actually have stats for this team-season (the rows the charts use)
                cur.execute("""
                    SELECT DISTINCT p.id, p.first_name, p.last_name
                    FROM players p
                    WHERE p.id IN (
                        SELECT player_id FROM batting_stats WHERE team_id = %s AND season = %s
                        UNION
                        SELECT player_id FROM pitching_stats WHERE team_id = %s AND season = %s
                    )
                """, (team_id, season, team_id, season))
                stat_players = cur.fetchall()
                if not stat_players:
                    continue

                classes = fetch_roster_classes(base, season, is_nuxt)
                if not classes:
                    log.info("    %s: no roster class data (stat players=%d)", season, len(stat_players))
                    continue

                by_last = {}
                for (fl, ll), cl in classes.items():
                    by_last.setdefault(_norm(ll), []).append((_norm(fl), cl))
                exact = {(_norm(fl), _norm(ll)): cl for (fl, ll), cl in classes.items()}

                rows = []
                for p in stat_players:
                    fl, ll = _norm(p["first_name"]), _norm(p["last_name"])
                    cl = exact.get((fl, ll))
                    if cl is None:
                        cands = by_last.get(ll, [])
                        if len(cands) == 1:
                            cl = cands[0][1]
                        else:
                            same = [c for c in cands if c[0][:1] == fl[:1]]
                            if len(same) == 1:
                                cl = same[0][1]
                    if cl is None:
                        tot_unmatched += 1
                        continue
                    rows.append((p["id"], team_id, season, cl))

                log.info("    %s: matched %d/%d stat players to a class", season, len(rows), len(stat_players))
                if rows and not args.dry_run:
                    cur.execute("DELETE FROM player_seasons WHERE team_id = %s AND season = %s", (team_id, season))
                    cur.executemany(
                        "INSERT INTO player_seasons (player_id, team_id, season, year_in_school, is_primary_team) "
                        "VALUES (%s, %s, %s, %s, 1)",
                        rows,
                    )
                    conn.commit()
                tot_ins += len(rows)

    log.info("=" * 56)
    log.info("DONE — player_seasons rows written: %d, unmatched stat players: %d%s",
             tot_ins, tot_unmatched, "  (DRY RUN)" if args.dry_run else "")


if __name__ == "__main__":
    main()
