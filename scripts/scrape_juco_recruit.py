#!/usr/bin/env python3
"""
JUCO Recruit scraper (out-of-region junior-college stats)
=========================================================

Pulls season batting + pitching totals for the out-of-region JUCO
conferences we track ONLY for recruiting (Scenic West / NJCAA Region 18
now; California CCCAA next). Writes to the isolated juco_recruit_* tables
so the data never appears anywhere on the site except the JUCO tracker.

Source: PrestoSports central stats sites, which expose a clean,
server-rendered stats table via the AJAX category-template endpoint
(same mechanism as the NWAC scraper):

  {team_url}?tmpl=brief-category-template&pos={h|he|p}&r=0

  pos=h  batting   : #, Name, Yr, Pos, g, ab, r, h, 2b, 3b, hr, rbi, bb, k, sb, cs, avg, obp, slg
  pos=he ext hit   : #, Name, Yr, Pos, g, hbp, sf, sh, tb, xbh, hdp, go, fo, go/fo, pa
  pos=p  pitching  : #, Name, Yr, Pos, era, w, l, app, gs, sv, ip, h, r, er, bb, k, k/9, hr, whip, bf, wp, hbp

Each team row in juco_recruit_teams carries a stats_url template (with a
{season} placeholder) and a stats_format dispatch key. The central NJCAA
Presto site is directly reachable (no WAF), so this can run from the Mac
or the server. It throttles rapid hits (returns a tiny stub / HTTP 459),
so we back off and retry.

Usage:
    PYTHONPATH=backend python3 scripts/scrape_juco_recruit.py --season 2025-26
    PYTHONPATH=backend python3 scripts/scrape_juco_recruit.py --season 2025-26 --conference "Scenic West"
    PYTHONPATH=backend python3 scripts/scrape_juco_recruit.py --season 2025-26 --school "College of Southern Idaho" --dry-run
"""

import sys
import time
import random
import argparse
import logging
import re
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

try:
    import cloudscraper
    _have_cloudscraper = True
except ImportError:
    _have_cloudscraper = False

import requests
from bs4 import BeautifulSoup

from app.models.database import get_connection

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("scrape_juco_recruit")

# ============================================================
# HTTP
# ============================================================

if _have_cloudscraper:
    session = cloudscraper.create_scraper(
        browser={"browser": "chrome", "platform": "darwin", "mobile": False}
    )
else:
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    })

_last_request = 0.0


def fetch(url, retries=5):
    """Fetch a Presto page, backing off on the throttle stub (tiny body / 459)."""
    global _last_request
    backoff = 4.0
    for attempt in range(retries):
        elapsed = time.time() - _last_request
        gap = random.uniform(3.0, 5.5)
        if elapsed < gap:
            time.sleep(gap - elapsed)
        try:
            resp = session.get(url, timeout=60, headers={"X-Requested-With": "XMLHttpRequest"})
            _last_request = time.time()
            # Throttle signatures: HTTP 459 or a tiny stub body
            if resp.status_code in (429, 459) or len(resp.text) < 2000:
                raise requests.RequestException(f"throttled (status={resp.status_code}, {len(resp.text)}b)")
            return resp.text
        except requests.RequestException as e:
            wait = backoff * (attempt + 1) + random.uniform(0, 2)
            logger.warning(f"  fetch retry {attempt+1}/{retries} in {wait:.0f}s ({e})")
            time.sleep(wait)
    logger.error(f"  giving up on {url}")
    return None


# ============================================================
# Parsing
# ============================================================

def _clean(text):
    return re.sub(r"\s+", " ", (text or "")).strip()


def parse_category_table(html):
    """Parse the first stats <table> in a fragment/page into row dicts.

    The Presto category-template fragment is a single <table>; Sidearm pages
    have many, so callers that need a specific one use _rows_from_table directly.
    """
    if not html:
        return []
    soup = BeautifulSoup(html, "html.parser")
    return _rows_from_table(soup.find("table"))


def _rows_from_table(table):
    """Map a stats <table>'s header <th> row onto each data row's cells.

    Returns row dicts keyed by lowercased header text, with row['name'] taken
    from a roster/player anchor or the player/name column.
    """
    if table is None:
        return []
    rows = table.find_all("tr")
    if not rows:
        return []

    # Header = the row with the most <th>
    header = None
    for tr in rows:
        ths = tr.find_all("th")
        if len(ths) > 5:
            header = [_clean(th.get_text()).lower() for th in ths]
            break
    if not header:
        return []

    name_cols = ("player", "full name", "name")
    stat_headers = [h for h in header if h not in name_cols]

    out = []
    for tr in rows:
        tds = tr.find_all("td")
        row_th = tr.find("th")          # Sidearm puts the player name in a row-header <th>
        link = tr.find("a", href=re.compile(r"/players/|/roster/"))
        link_txt = _clean(link.get_text()) if link else ""

        if row_th is not None and tds and len(tds) == len(stat_headers):
            # Sidearm layout: name in the row-header <th>, the <td> cells are the
            # stat columns. The name is the <th>'s own anchor (href="#"); the row's
            # /roster/ link is a separate "View Bio" button, so don't use link_txt.
            th_a = row_th.find("a")
            row = dict(zip(stat_headers, [_clean(td.get_text(" ")) for td in tds]))
            row["name"] = _clean(th_a.get_text()) if th_a else _clean(row_th.get_text())
        else:
            # Presto / standard layout: every cell (incl. name) is a <td>.
            if len(tds) < 5:
                continue
            cells = [_clean(td.get_text(" ")) for td in tds]
            offset = len(cells) - len(header)   # Presto sometimes leads with a rank col
            if offset > 0:
                cells = cells[offset:]
            row = dict(zip(header, cells))
            row["name"] = link_txt or row.get("name") or row.get("player") or row.get("full name")

        # Skip summary rows + misaligned rows whose "name" is really a stat.
        nm = (row.get("name") or "").lower()
        if not nm or nm in ("totals", "total", "opponents", "opponent", "team", "tm"):
            continue
        if not re.search(r"[A-Za-z]", nm):
            continue
        out.append(row)
    return out


def parse_roster_table(html):
    """Parse the team roster table (#, Name, Position, Year, ..., Bats, Throws, Hometown).

    Returns {lowercased full name: {position, year, height, weight, bats, throws, hometown, #}}.
    """
    if not html:
        return {}
    soup = BeautifulSoup(html, "html.parser")
    for table in soup.find_all("table"):
        heads = [_clean(th.get_text()).lower() for th in table.find_all("th")]
        if "position" in heads and "year" in heads:
            out = {}
            for tr in table.find_all("tr"):
                tds = tr.find_all("td")
                if len(tds) < len(heads) - 1:
                    continue
                cells = [_clean(td.get_text(" ")) for td in tds]
                offset = len(cells) - len(heads)
                if offset > 0:
                    cells = cells[offset:]
                row = dict(zip(heads, cells))
                link = tr.find("a", href=re.compile(r"/players/"))
                nm = _clean(link.get_text()) if link else row.get("name", "")
                if nm:
                    out[_name_key(nm)] = row
            return out
    return {}


def parse_full_name(full):
    full = _clean(full)
    # Sidearm stats tables render names "Last, First"; Presto uses "First Last".
    if "," in full:
        last, first = full.split(",", 1)
        return first.strip(), last.strip()
    parts = full.split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], parts[0]
    # treat suffix tokens as part of last name
    return parts[0], " ".join(parts[1:])


def _name_key(full):
    """Canonical 'first last' key so 'Blackwell, Beau' and 'Beau Blackwell' match."""
    first, last = parse_full_name(full)
    return f"{first} {last}".strip().lower()


def safe_int(v):
    try:
        return int(float(str(v).replace(",", "")))
    except (TypeError, ValueError):
        return None


def safe_num(v):
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


def norm_year(v):
    """Map Presto class abbreviations to Fr/So (JUCO is 2-year)."""
    if not v:
        return None
    v = v.strip().lower().rstrip(".")
    if v in ("fr", "fy", "freshman", "1"):
        return "Fr"
    if v in ("so", "sophomore", "2"):
        return "So"
    return None


# ============================================================
# DB upsert
# ============================================================

def upsert_player(cur, team_id, first, last, **bio):
    cur.execute(
        """SELECT id FROM juco_recruit_players
           WHERE team_id=%s AND lower(first_name)=lower(%s) AND lower(last_name)=lower(%s)""",
        (team_id, first, last),
    )
    row = cur.fetchone()
    if row:
        pid = row["id"]
        sets, vals = [], []
        for k, val in bio.items():
            if val not in (None, ""):
                sets.append(f"{k}=%s")
                vals.append(val)
        if sets:
            sets.append("updated_at=now()")
            cur.execute(f"UPDATE juco_recruit_players SET {', '.join(sets)} WHERE id=%s", vals + [pid])
        return pid
    cols = ["team_id", "first_name", "last_name"] + list(bio.keys())
    vals = [team_id, first, last] + list(bio.values())
    ph = ", ".join(["%s"] * len(vals))
    cur.execute(
        f"INSERT INTO juco_recruit_players ({', '.join(cols)}) VALUES ({ph}) RETURNING id",
        vals,
    )
    return cur.fetchone()["id"]


def upsert_batting(cur, pid, team_id, season, b, ext):
    pa = safe_int(ext.get("pa"))
    ab = safe_int(b.get("ab")) or 0
    bb = safe_int(b.get("bb")) or 0
    hbp = safe_int(ext.get("hbp")) or 0
    sf = safe_int(ext.get("sf")) or 0
    sh = safe_int(ext.get("sh")) or 0
    if not pa and ab:
        pa = ab + bb + hbp + sf + sh
    cur.execute(
        """INSERT INTO juco_recruit_batting
           (player_id, team_id, season, games, plate_appearances, at_bats, runs, hits,
            doubles, triples, home_runs, rbi, total_bases, walks, strikeouts, hit_by_pitch,
            sacrifice_flies, sacrifice_bunts, stolen_bases, caught_stealing,
            batting_avg, on_base_pct, slugging_pct, ops)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (player_id, season) DO UPDATE SET
             team_id=excluded.team_id, games=excluded.games,
             plate_appearances=excluded.plate_appearances, at_bats=excluded.at_bats,
             runs=excluded.runs, hits=excluded.hits, doubles=excluded.doubles,
             triples=excluded.triples, home_runs=excluded.home_runs, rbi=excluded.rbi,
             total_bases=excluded.total_bases, walks=excluded.walks,
             strikeouts=excluded.strikeouts, hit_by_pitch=excluded.hit_by_pitch,
             sacrifice_flies=excluded.sacrifice_flies, sacrifice_bunts=excluded.sacrifice_bunts,
             stolen_bases=excluded.stolen_bases, caught_stealing=excluded.caught_stealing,
             batting_avg=excluded.batting_avg, on_base_pct=excluded.on_base_pct,
             slugging_pct=excluded.slugging_pct, ops=excluded.ops, updated_at=now()""",
        (pid, team_id, season, safe_int(b.get("g")), pa, ab,
         safe_int(b.get("r")), safe_int(b.get("h")), safe_int(b.get("2b")),
         safe_int(b.get("3b")), safe_int(b.get("hr")), safe_int(b.get("rbi")),
         safe_int(ext.get("tb")), bb, safe_int(b.get("k")), hbp, sf, sh,
         safe_int(b.get("sb")), safe_int(b.get("cs")),
         safe_num(b.get("avg")), safe_num(b.get("obp")), safe_num(b.get("slg")),
         (safe_num(b.get("obp")) or 0) + (safe_num(b.get("slg")) or 0)),
    )


def upsert_pitching(cur, pid, team_id, season, p):
    cur.execute(
        """INSERT INTO juco_recruit_pitching
           (player_id, team_id, season, games, games_started, wins, losses, saves,
            innings_pitched, hits_allowed, runs_allowed, earned_runs, walks, strikeouts,
            home_runs_allowed, hit_batters, wild_pitches, batters_faced,
            era, whip, k_per_9)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (player_id, season) DO UPDATE SET
             team_id=excluded.team_id, games=excluded.games,
             games_started=excluded.games_started, wins=excluded.wins, losses=excluded.losses,
             saves=excluded.saves, innings_pitched=excluded.innings_pitched,
             hits_allowed=excluded.hits_allowed, runs_allowed=excluded.runs_allowed,
             earned_runs=excluded.earned_runs, walks=excluded.walks, strikeouts=excluded.strikeouts,
             home_runs_allowed=excluded.home_runs_allowed, hit_batters=excluded.hit_batters,
             wild_pitches=excluded.wild_pitches, batters_faced=excluded.batters_faced,
             era=excluded.era, whip=excluded.whip, k_per_9=excluded.k_per_9, updated_at=now()""",
        (pid, team_id, season, safe_int(p.get("app")), safe_int(p.get("gs")),
         safe_int(p.get("w")), safe_int(p.get("l")), safe_int(p.get("sv")),
         safe_num(p.get("ip")), safe_int(p.get("h")), safe_int(p.get("r")),
         safe_int(p.get("er")), safe_int(p.get("bb")), safe_int(p.get("k")),
         safe_int(p.get("hr")), safe_int(p.get("hbp")), safe_int(p.get("wp")),
         safe_int(p.get("bf")), safe_num(p.get("era")), safe_num(p.get("whip")),
         safe_num(p.get("k/9"))),
    )


# ============================================================
# Driver
# ============================================================

def _split_pair(v):
    """Split a combined Sidearm cell like '20-18' / '5-7' into (first, second)."""
    if not v:
        return None, None
    parts = re.split(r"[-/]", str(v))
    return (parts[0].strip() or None if parts else None,
            parts[1].strip() or None if len(parts) > 1 else None)


def _find_table(soup, must_have):
    for t in soup.find_all("table"):
        heads = {_clean(th.get_text()).lower() for th in t.find_all("th")}
        if all(h in heads for h in must_have):
            return t
    return None


def _parse_sidearm_roster(html):
    """Roster table: # | full name | ht. | wt. | pos. | bat/throw | class | hometown."""
    if not html:
        return {}
    soup = BeautifulSoup(html, "html.parser")
    tbl = _find_table(soup, ("full name", "pos.", "class"))
    if tbl is None:
        return {}
    out = {}
    for r in _rows_from_table(tbl):
        nm = _name_key(r.get("name") or r.get("full name") or "")
        if not nm:
            continue
        bats, throws = _split_pair(r.get("bat/throw"))
        out[nm] = {
            "position": r.get("pos."), "year": r.get("class"),
            "bats": bats, "throws": throws,
            "height": r.get("ht."), "weight": r.get("wt."),
            "hometown": r.get("hometown"), "#": r.get("#"),
        }
    return out


def _fetch_presto(team, season_str):
    base = team["stats_url"].format(season=season_str)
    batting = parse_category_table(fetch(f"{base}?tmpl=brief-category-template&pos=h&r=0"))
    ext     = parse_category_table(fetch(f"{base}?tmpl=brief-category-template&pos=he&r=0"))
    pitch   = parse_category_table(fetch(f"{base}?tmpl=brief-category-template&pos=p&r=0"))
    roster  = parse_roster_table(fetch(f"{base}?view=lineup&r=0&pos=h"))
    ext_by_name = {_name_key(e.get("name", "")): e for e in ext}
    return base, batting, pitch, roster, ext_by_name


def _fetch_sidearm(team, season_year):
    """A Sidearm school site: one HTML stats page (batting + pitching tables) +
    a roster page. Column names differ from Presto and some are combined."""
    base = team["stats_url"].rstrip("/")
    soup = BeautifulSoup(fetch(f"{base}/stats/{season_year}") or "", "html.parser")
    batting_raw = _rows_from_table(_find_table(soup, ("avg", "ab", "ob%")))
    pitch_raw   = _rows_from_table(_find_table(soup, ("era", "ip", "whip")))

    batting, ext_by_name = [], {}
    for r in batting_raw:
        gp, _gs = _split_pair(r.get("gp-gs"))
        sb, att = _split_pair(r.get("sb-att"))
        cs = None
        if safe_int(sb) is not None and safe_int(att) is not None:
            cs = safe_int(att) - safe_int(sb)
        b = {"name": r.get("name"), "#": r.get("#"), "g": gp,
             "ab": r.get("ab"), "r": r.get("r"), "h": r.get("h"), "2b": r.get("2b"),
             "3b": r.get("3b"), "hr": r.get("hr"), "rbi": r.get("rbi"), "bb": r.get("bb"),
             "k": r.get("so"), "sb": sb, "cs": cs,
             "avg": r.get("avg"), "obp": r.get("ob%"), "slg": r.get("slg%")}
        batting.append(b)
        ext_by_name[_name_key(b["name"] or "")] = {
            "hbp": r.get("hbp"), "sf": r.get("sf"), "sh": r.get("sh"), "tb": r.get("tb"), "pa": None}

    pitch = []
    for r in pitch_raw:
        app, gs = _split_pair(r.get("app-gs"))
        w, l = _split_pair(r.get("w-l"))
        pitch.append({"name": r.get("name"), "#": r.get("#"), "app": app, "gs": gs,
                      "w": w, "l": l, "sv": r.get("sv"), "ip": r.get("ip"), "h": r.get("h"),
                      "r": r.get("r"), "er": r.get("er"), "bb": r.get("bb"), "k": r.get("so"),
                      "hr": r.get("hr"), "hbp": r.get("hbp"), "wp": r.get("wp"), "bf": None,
                      "era": r.get("era"), "whip": r.get("whip"), "k/9": None})

    roster = _parse_sidearm_roster(fetch(f"{base}/roster/{season_year}"))
    return base, batting, pitch, roster, ext_by_name


def scrape_team(cur, team, season_str, season_year, dry_run=False):
    name = team["school_name"]
    fmt = (team.get("stats_format") or "").lower()
    if fmt == "sidearm_html":
        base, batting, pitch, roster, ext_by_name = _fetch_sidearm(team, season_year)
    else:  # presto_njcaa / presto_cccaa
        base, batting, pitch, roster, ext_by_name = _fetch_presto(team, season_str)
    logger.info(f"{'='*52}\nScraping {name}  [{fmt or 'presto'}]  ({base})")
    logger.info(f"  batting={len(batting)}  pitching={len(pitch)}  roster={len(roster)}")

    def bio(stat_row):
        """Merge roster bio for a player, preferring roster over the (often blank) stats row."""
        r = roster.get(_name_key(stat_row.get("name", "")), {})
        return dict(
            position=r.get("position") or stat_row.get("pos") or None,
            year_in_school=norm_year(r.get("year") or stat_row.get("yr")),
            jersey_number=r.get("#") or stat_row.get("#"),
            bats=(r.get("bats") or None),
            throws=(r.get("throws") or None),
            height=(r.get("height") or None),
            weight=safe_int(r.get("weight")),
            hometown=(r.get("hometown") or None),
            roster_year=season_year,
        )

    n_bat = n_pit = 0
    for b in batting:
        first, last = parse_full_name(b.get("name", ""))
        if not last:
            continue
        if (safe_int(b.get("ab")) or 0) == 0 and (safe_int(b.get("g")) or 0) == 0:
            continue
        if dry_run:
            n_bat += 1
            continue
        pid = upsert_player(cur, team["id"], first, last, **bio(b))
        upsert_batting(cur, pid, team["id"], season_year, b, ext_by_name.get(_name_key(b.get("name","")), {}))
        n_bat += 1

    for p in pitch:
        first, last = parse_full_name(p.get("name", ""))
        if not last:
            continue
        if dry_run:
            n_pit += 1
            continue
        pb = bio(p)
        # Appearing in the pitching table makes them a pitcher: default position
        # to 'P' so they classify + filter correctly even if the roster (which
        # carries the precise RHP/LHP) was throttled out this run.
        pb["position"] = pb.get("position") or "P"
        pid = upsert_player(cur, team["id"], first, last, **pb)
        upsert_pitching(cur, pid, team["id"], season_year, p)
        n_pit += 1

    logger.info(f"  -> wrote {n_bat} batting, {n_pit} pitching{' (dry-run)' if dry_run else ''}")
    return n_bat, n_pit


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", default="2025-26", help="Presto academic-year season, e.g. 2025-26")
    ap.add_argument("--conference", help="Only this conference_name")
    ap.add_argument("--school", help="Only this school_name")
    ap.add_argument("--dry-run", action="store_true", help="Parse + count, write nothing")
    args = ap.parse_args()

    # Derive the integer DB season from the academic-year string (2025-26 -> 2026)
    season_year = int(args.season.split("-")[0]) + 1 if "-" in args.season else int(args.season)

    with get_connection() as conn:
        cur = conn.cursor()
        q = "SELECT * FROM juco_recruit_teams WHERE is_active AND stats_url IS NOT NULL"
        params = []
        if args.conference:
            q += " AND conference_name=%s"; params.append(args.conference)
        if args.school:
            q += " AND school_name=%s"; params.append(args.school)
        q += " ORDER BY id"
        cur.execute(q, params)
        teams = cur.fetchall()
        if not teams:
            logger.error("No teams with a stats_url matched. Seed sources first.")
            return
        logger.info(f"Scraping {len(teams)} team(s) for season {args.season} (DB season {season_year})")

        tot_b = tot_p = 0
        for team in teams:
            try:
                b, p = scrape_team(cur, dict(team), args.season, season_year, dry_run=args.dry_run)
                tot_b += b; tot_p += p
                if not args.dry_run:
                    conn.commit()
            except Exception as e:
                logger.error(f"  FAILED {team['school_name']}: {e}")
                conn.rollback()
        logger.info(f"{'='*52}\nDONE. {tot_b} batting + {tot_p} pitching rows across {len(teams)} teams.")


if __name__ == "__main__":
    main()
