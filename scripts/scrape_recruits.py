#!/usr/bin/env python3
"""
HS Recruit / Commit ingestion → `recruits` table.

Ingests high-school commits to OUR ~57 PNW schools (WA/OR/ID/MT/BC) from
Baseball Northwest (BBNW) and enriches with Prep Baseball Report (PBR) state
rankings. BBNW carries the feature; PBR is enrichment-only.

Pipeline (per the "Recruiting Classes" plan):
  1. Read backend/data/recruit_school_map.json  → team_id → {bbnw_slug, pbr_code}.
  2. For each mapped school, fetch its BBNW page (/schools/{slug}) and parse its
     commit table. The school page IS the destination, so committed_team_id is
     known directly from the map (no committed_raw string resolution needed).
  3. Fetch each PNW state's BBNW rankings page → (norm_name, grad_year) →
     {bbnw_rank, height, weight}. Static HTML holds the top ~60 per state
     (load-more is JS/AJAX driven); we accept that cap and log it. Elite commits
     drive class scores; unranked-but-committed players still get a baseline.
  4. Fetch each state's PBR rankings (where a URL is known) → {pbr_rank}.
  5. Join ranks onto the commit universe by normalized name + grad_year.
  6. Score: better (lower) of bbnw/pbr rank → clamp(100-(rank-1)*1.2, 20, 100);
     unranked → baseline 25.
  7. Upsert into recruits ON CONFLICT (first_name,last_name,grad_year).

LIVE SCRAPING MUST RUN ON THE SERVER — SCRAPER_API_KEY lives only in the
server's /opt/pnw-baseball/.env. From the Mac, DATABASE_URL connects read-only
for exploration, but ScraperAPI calls will fail without the key.

Usage:
    PYTHONPATH=backend python3 scripts/scrape_recruits.py --grad-year 2026 --dry-run
    PYTHONPATH=backend python3 scripts/scrape_recruits.py --grad-year 2026
    PYTHONPATH=backend python3 scripts/scrape_recruits.py --grad-year 2026 --state WA
"""

import argparse
import json
import logging
import os
import re
import sys
import unicodedata
from pathlib import Path

import psycopg2
import psycopg2.extras
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
DATABASE_URL = os.environ.get("DATABASE_URL")
SCRAPER_API_KEY = os.environ.get("SCRAPER_API_KEY")
SCHOOL_MAP_PATH = ROOT / "backend" / "data" / "recruit_school_map.json"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("scrape_recruits")

# PNW states → BBNW ranking-page slug + PBR two-letter code.
# BC has no BBNW rankings page (try british-columbia, expect 404) and PBR is
# WA-only for v1 (PBR uses opaque ranking-page IDs we don't have per state).
PNW_STATES = ["WA", "OR", "ID", "MT", "BC"]
BBNW_STATE_SLUG = {
    "WA": "washington",
    "OR": "oregon",
    "ID": "idaho",
    "MT": "montana",
    "BC": "british-columbia",
}
# PBR per-state ranking URLs. PBR ranking pages use opaque IDs; only WA is known
# for v1 (from the plan). Other states are skipped gracefully — PBR is purely
# enrichment, BBNW carries the feature. Add URLs here as they are discovered.
PBR_STATE_URL = {
    # "WA": "https://www.prepbaseballreport.com/rankings/WA/2026-Washington-Rankings-...",
}

BBNW_BASE = "https://baseballnorthwest.com"

SCORE_FLOOR = 20.0
SCORE_K = 1.2
UNRANKED_BASELINE = 25.0


# ────────────────────────────── DB ──────────────────────────────
def get_conn():
    url = DATABASE_URL
    if url and "sslmode" not in url:
        url += ("&" if "?" in url else "?") + "sslmode=require"
    conn = psycopg2.connect(url)
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


CREATE_SQL = """
CREATE TABLE IF NOT EXISTS recruits (
    id              serial PRIMARY KEY,
    first_name      text NOT NULL,
    last_name       text NOT NULL,
    position        text,
    grad_year       int NOT NULL,
    high_school     text,
    city            text,
    state           text,
    height          text,
    weight          int,
    committed_team_id int REFERENCES teams(id),
    committed_raw   text,
    pbr_state_rank  int,
    pbr_url         text,
    bbnw_state_rank int,
    bbnw_url        text,
    recruit_score   numeric,
    sources         text[],
    commitment_date date,
    headshot_url    text,
    first_seen      timestamptz DEFAULT now(),
    last_seen       timestamptz,
    UNIQUE (first_name, last_name, grad_year)
)
"""


def ensure_schema(cur):
    cur.execute(CREATE_SQL)
    for stmt in (
        "CREATE INDEX IF NOT EXISTS recruits_committed_team_idx ON recruits (committed_team_id)",
        "CREATE INDEX IF NOT EXISTS recruits_grad_year_idx ON recruits (grad_year)",
        "CREATE INDEX IF NOT EXISTS recruits_state_idx ON recruits (state)",
    ):
        cur.execute(stmt)


# ────────────────────────── ScraperAPI ──────────────────────────
def scraperapi_fetch(api_key, target_url, min_size=3000, label="page"):
    """GET target_url through ScraperAPI, escalating proxy tiers if a WAF/CDN
    returns its tiny challenge page. Standard → premium (residential) →
    ultra_premium. Returns page HTML, or None if every tier was blocked.

    Copied verbatim (behaviour) from scripts/scrape_nwac_schedule.py — never hit
    ScraperAPI without this tier escalation.
    """
    tiers = [
        ("standard", {}),
        ("premium", {"premium": "true"}),
        ("ultra_premium", {"ultra_premium": "true"}),
    ]
    last_size = 0
    for tier_name, extra in tiers:
        params = {"api_key": api_key, "url": target_url}
        params.update(extra)
        try:
            resp = requests.get("http://api.scraperapi.com", params=params, timeout=120)
            resp.raise_for_status()
        except Exception as e:
            logger.warning(f"{label}: ScraperAPI {tier_name} request failed: {e}")
            continue
        last_size = len(resp.text)
        if last_size >= min_size and "captcha" not in resp.text.lower():
            logger.info(f"{label}: got {last_size:,} bytes via {tier_name} proxy")
            return resp.text
        logger.warning(f"{label}: blocked via {tier_name} proxy (size={last_size})")
    logger.warning(f"{label}: all proxy tiers blocked (last size={last_size})")
    return None


# ─────────────────────────── parsing ────────────────────────────
def norm_name(s):
    """Lowercase, strip accents/punctuation, collapse whitespace. The join key
    between commit rows and ranking rows. "Kepo'o-Sabate" → "kepoo sabate"."""
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = s.lower().replace(".", " ").replace("'", "").replace("’", "")
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def split_name(full):
    parts = (full or "").strip().split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], " ".join(parts[1:])


def parse_weight(s):
    if not s:
        return None
    m = re.search(r"\d+", s)
    return int(m.group()) if m else None


def parse_school_commits(html, grad_year):
    """Parse a BBNW per-school page (/schools/{slug}).

    Single <table>; each <tr> is: FirstName LastName | STATE | High School |
    ClassYear | Position. Grouped by class year. Returns commits matching
    grad_year as dicts: {full_name, first, last, state, high_school, position,
    grad_year}.
    """
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table")
    commits = []
    if not table:
        return commits
    for tr in table.find_all("tr"):
        cells = [c.get_text(strip=True) for c in tr.find_all(["td", "th"])]
        if len(cells) < 5:
            continue
        name, state, hs, cls, pos = cells[0], cells[1], cells[2], cells[3], cells[4]
        # header / non-data rows
        if not name or name.lower() in ("name", "player"):
            continue
        m = re.search(r"(19|20)\d{2}", cls or "")
        if not m or int(m.group()) != grad_year:
            continue
        first, last = split_name(name)
        if not last:
            continue
        commits.append({
            "full_name": name,
            "first_name": first,
            "last_name": last,
            "state": (state or "").strip().upper()[:3] or None,
            "high_school": hs or None,
            "position": pos or None,
            "grad_year": grad_year,
        })
    return commits


def parse_state_rankings(html, grad_year):
    """Parse a BBNW per-state rankings page.

    Rows are <div class="player-item"> (skip the .header-row). Child divs by
    class: .rank .name .position .height .weight .high_school
    .graduation-year .college_name. Returns norm_name → {rank, height, weight,
    position, college_name} for rows matching grad_year.
    """
    soup = BeautifulSoup(html, "html.parser")
    index = {}
    for item in soup.select(".player-item"):
        classes = item.get("class") or []
        if "header-row" in classes:
            continue

        def field(cls):
            el = item.select_one(f".{cls}")
            return el.get_text(strip=True) if el else ""

        name = field("name")
        if not name:
            continue
        cls_year = field("graduation-year")
        m = re.search(r"(19|20)\d{2}", cls_year)
        if not m or int(m.group()) != grad_year:
            continue
        rank_txt = field("rank")
        rm = re.search(r"\d+", rank_txt)
        if not rm:
            continue
        index[norm_name(name)] = {
            "rank": int(rm.group()),
            "height": field("height") or None,
            "weight": parse_weight(field("weight")),
            "position": field("position") or None,
            "college_name": field("college_name") or None,
        }
    return index


def parse_pbr_rankings(html, grad_year):
    """Best-effort parse of a PBR state rankings page → norm_name → pbr_rank.

    PBR's exact structure must be confirmed against a live fetch. This handles
    the common ranking-table shape (a <table> whose first column is a rank and
    a column holding the player name). Returns {} if nothing parseable, so PBR
    failures degrade gracefully. Refine once a real PBR sample is in hand.
    """
    soup = BeautifulSoup(html, "html.parser")
    index = {}
    for table in soup.find_all("table"):
        for tr in table.find_all("tr"):
            cells = [c.get_text(strip=True) for c in tr.find_all(["td", "th"])]
            if len(cells) < 2:
                continue
            rm = re.match(r"^\s*#?(\d+)\s*$", cells[0])
            if not rm:
                continue
            # name is the first non-numeric cell after the rank
            name = next((c for c in cells[1:] if re.search(r"[A-Za-z]{2,}", c)), None)
            if not name:
                continue
            index.setdefault(norm_name(name), int(rm.group()))
    return index


# ─────────────────────────── scoring ────────────────────────────
def compute_score(bbnw_rank, pbr_rank):
    """Better (lower) of the two ranks → score on a clamped linear curve.
    #1 ≈ 100, #25 ≈ 71, #65 ≈ 23. Unranked → baseline."""
    ranks = [r for r in (bbnw_rank, pbr_rank) if r]
    if not ranks:
        return UNRANKED_BASELINE
    best = min(ranks)
    return round(max(SCORE_FLOOR, min(100.0, 100.0 - (best - 1) * SCORE_K)), 1)


# ─────────────────────────── main run ───────────────────────────
def load_school_map():
    if not SCHOOL_MAP_PATH.exists():
        logger.error("School map not found: %s", SCHOOL_MAP_PATH)
        sys.exit(1)
    raw = json.loads(SCHOOL_MAP_PATH.read_text())
    # keys are team_id strings in JSON
    return {int(k): v for k, v in raw.items()}


def fetch_state_indexes(grad_year, states):
    """Fetch BBNW (+ PBR where known) rankings for each state. Returns
    (bbnw_index, pbr_index): norm_name → rank-info / rank. Logs the top-60 cap."""
    bbnw_index, pbr_index = {}, {}
    for st in states:
        # --- BBNW ---
        slug = BBNW_STATE_SLUG.get(st)
        if slug:
            url = f"{BBNW_BASE}/rankings/top-prospects-{slug}-{grad_year}"
            html = scraperapi_fetch(SCRAPER_API_KEY, url, min_size=3000,
                                    label=f"BBNW {st} rankings")
            if html:
                idx = parse_state_rankings(html, grad_year)
                logger.info("BBNW %s rankings: %d ranked players (static top-%d "
                            "cap; load-more not paginated)", st, len(idx), len(idx))
                for k, v in idx.items():
                    # keep the better (lower) rank if a name appears twice
                    if k not in bbnw_index or v["rank"] < bbnw_index[k]["rank"]:
                        bbnw_index[k] = {**v, "url": url, "state": st}
            else:
                logger.warning("BBNW %s rankings: no HTML (may 404, e.g. BC)", st)
        # --- PBR (enrichment) ---
        pbr_url = PBR_STATE_URL.get(st)
        if pbr_url:
            html = scraperapi_fetch(SCRAPER_API_KEY, pbr_url, min_size=3000,
                                    label=f"PBR {st} rankings")
            if html:
                idx = parse_pbr_rankings(html, grad_year)
                logger.info("PBR %s rankings: %d ranked players", st, len(idx))
                for k, rank in idx.items():
                    if k not in pbr_index or rank < pbr_index[k]:
                        pbr_index[k] = rank
                        # remember the source URL for storage
                        pbr_index[(k, "url")] = pbr_url
            else:
                logger.warning("PBR %s rankings: no HTML; skipping (enrichment only)", st)
        else:
            logger.info("PBR %s: no ranking URL configured; skipping (BBNW carries it)", st)
    return bbnw_index, pbr_index


def run(grad_year, state_filter, dry_run):
    if not SCRAPER_API_KEY and not dry_run:
        logger.error("SCRAPER_API_KEY not set — live scraping must run ON THE "
                     "SERVER. Aborting. (Use --dry-run only where the key exists.)")
        sys.exit(1)
    if not SCRAPER_API_KEY:
        logger.error("SCRAPER_API_KEY not set; even --dry-run needs it to fetch. "
                     "Run this on the server.")
        sys.exit(1)

    school_map = load_school_map()
    states = [state_filter.upper()] if state_filter else PNW_STATES

    # Pull team names for committed_raw reference.
    team_names = {}
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, name, short_name FROM teams")
        for r in cur.fetchall():
            team_names[r["id"]] = r["name"] or r["short_name"]

    # 1) Rankings indexes
    bbnw_index, pbr_index = fetch_state_indexes(grad_year, states)

    # 2) Walk each mapped school, parse its commits
    all_recruits = []
    per_school_counts = {}
    matched_ranks = 0
    for team_id, info in sorted(school_map.items()):
        bbnw_slug = info.get("bbnw_slug")
        short = info.get("short_name", str(team_id))
        if not bbnw_slug:
            logger.info("%s (team %s): no bbnw_slug; skipping", short, team_id)
            continue
        url = f"{BBNW_BASE}/schools/{bbnw_slug}"
        html = scraperapi_fetch(SCRAPER_API_KEY, url, min_size=3000,
                                label=f"BBNW school {short}")
        if not html:
            logger.warning("%s: school page fetch failed", short)
            per_school_counts[short] = 0
            continue
        commits = parse_school_commits(html, grad_year)
        # If a state filter is set, keep only commits from that state.
        if state_filter:
            commits = [c for c in commits if c.get("state") == state_filter.upper()]
        per_school_counts[short] = len(commits)

        for c in commits:
            key = norm_name(c["full_name"])
            br = bbnw_index.get(key)
            bbnw_rank = br["rank"] if br else None
            bbnw_url = br["url"] if br else None
            height = br["height"] if br else None
            weight = br["weight"] if br else None
            pbr_rank = pbr_index.get(key)
            pbr_url = pbr_index.get((key, "url"))
            if bbnw_rank or pbr_rank:
                matched_ranks += 1
            sources = ["bbnw"]
            if pbr_rank:
                sources.append("pbr")
            score = compute_score(bbnw_rank, pbr_rank)
            all_recruits.append({
                **c,
                "committed_team_id": team_id,
                "committed_raw": team_names.get(team_id),
                "bbnw_state_rank": bbnw_rank,
                "bbnw_url": bbnw_url or url,
                "pbr_state_rank": pbr_rank,
                "pbr_url": pbr_url,
                "height": height,
                "weight": weight,
                "recruit_score": score,
                "sources": sources,
            })

    # Dedup on the upsert key (first, last, grad_year). BBNW occasionally lists
    # the same commit twice on a school page, and the UNIQUE constraint would
    # collapse them on write anyway — do it here so dry-run counts match the
    # real write and we recount rank-matches on the deduped set. Keep the
    # higher-scored instance (a ranked row beats a duplicate unranked row).
    deduped = {}
    for r in all_recruits:
        k = (norm_name(r["first_name"]), norm_name(r["last_name"]), r["grad_year"])
        if k not in deduped or r["recruit_score"] > deduped[k]["recruit_score"]:
            deduped[k] = r
    dup_count = len(all_recruits) - len(deduped)
    all_recruits = list(deduped.values())
    matched_ranks = sum(1 for r in all_recruits
                        if r["bbnw_state_rank"] or r["pbr_state_rank"])
    if dup_count:
        logger.info("Collapsed %d duplicate commit row(s) on (name, grad_year).",
                    dup_count)

    total = len(all_recruits)
    rank_rate = (matched_ranks / total * 100) if total else 0.0
    logger.info("=" * 60)
    logger.info("Grad year %s: %d commits across %d schools; %d ranked "
                "(%.1f%% rank-match rate)", grad_year, total,
                sum(1 for v in per_school_counts.values() if v), matched_ranks, rank_rate)
    for short in sorted(per_school_counts, key=lambda s: -per_school_counts[s]):
        if per_school_counts[short]:
            logger.info("  %-20s %d commits", short, per_school_counts[short])

    if dry_run:
        logger.info("DRY RUN — nothing written.")
        # show a small sample with scores
        sample = sorted(all_recruits, key=lambda r: -r["recruit_score"])[:10]
        logger.info("Top 10 by score (dry run):")
        for r in sample:
            logger.info("  %.1f  %s %s (%s) → %s  [bbnw#%s pbr#%s]",
                        r["recruit_score"], r["first_name"], r["last_name"],
                        r["position"], r["committed_raw"],
                        r["bbnw_state_rank"], r["pbr_state_rank"])
        return

    # 3) Upsert
    written = 0
    with get_conn() as conn:
        cur = conn.cursor()
        ensure_schema(cur)
        for r in all_recruits:
            cur.execute("""
                INSERT INTO recruits (
                    first_name, last_name, position, grad_year, high_school,
                    state, height, weight, committed_team_id, committed_raw,
                    pbr_state_rank, pbr_url, bbnw_state_rank, bbnw_url,
                    recruit_score, sources, last_seen
                ) VALUES (
                    %(first_name)s, %(last_name)s, %(position)s, %(grad_year)s,
                    %(high_school)s, %(state)s, %(height)s, %(weight)s,
                    %(committed_team_id)s, %(committed_raw)s,
                    %(pbr_state_rank)s, %(pbr_url)s, %(bbnw_state_rank)s,
                    %(bbnw_url)s, %(recruit_score)s, %(sources)s, now()
                )
                ON CONFLICT (first_name, last_name, grad_year) DO UPDATE SET
                    position          = EXCLUDED.position,
                    high_school       = COALESCE(EXCLUDED.high_school, recruits.high_school),
                    state             = COALESCE(EXCLUDED.state, recruits.state),
                    height            = COALESCE(EXCLUDED.height, recruits.height),
                    weight            = COALESCE(EXCLUDED.weight, recruits.weight),
                    committed_team_id = EXCLUDED.committed_team_id,
                    committed_raw     = EXCLUDED.committed_raw,
                    pbr_state_rank    = EXCLUDED.pbr_state_rank,
                    pbr_url           = COALESCE(EXCLUDED.pbr_url, recruits.pbr_url),
                    bbnw_state_rank   = EXCLUDED.bbnw_state_rank,
                    bbnw_url          = EXCLUDED.bbnw_url,
                    recruit_score     = EXCLUDED.recruit_score,
                    sources           = EXCLUDED.sources,
                    last_seen         = now()
            """, r)
            written += 1
        conn.commit()
    logger.info("Upserted %d recruits for grad year %s.", written, grad_year)


def main():
    ap = argparse.ArgumentParser(description="Ingest HS commits to PNW schools.")
    ap.add_argument("--grad-year", type=int, default=2026)
    ap.add_argument("--state", default=None, help="Filter to one state (WA/OR/ID/MT/BC)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print per-school counts + rank-match rate; write nothing.")
    args = ap.parse_args()
    if not DATABASE_URL:
        logger.error("DATABASE_URL not set (check .env)")
        sys.exit(1)
    run(args.grad_year, args.state, args.dry_run)


if __name__ == "__main__":
    main()
