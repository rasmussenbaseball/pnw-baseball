#!/usr/bin/env python3
"""
HS Recruit / Commit ingestion → `recruits` table.

Ingests high-school commits to OUR ~57 PNW schools (WA/OR/ID/MT/BC) from
Baseball Northwest (BBNW) and Prep Baseball Report (PBR).

Two sources, two roles:
  • BBNW per-school pages → commits (local-states players only) + the ONLY
    rank source (per-state BBNW rankings pages). BBNW carries scoring.
  • PBR per-school pages  → commits too, and crucially the OUT-OF-REGION ones
    (a TX/CA/AZ kid committing to Gonzaga) that BBNW never lists. PBR per-school
    pages carry NO rank, so PBR contributes COMMITS, not ranks, in v1.

Pipeline (per the "Recruiting Classes" plan):
  1. Read backend/data/recruit_school_map.json  → team_id → {bbnw_slug, pbr_code}.
  2. Fetch each PNW state's BBNW rankings page → (norm_name, grad_year) →
     {bbnw_rank, height, weight}. Static HTML holds the top ~60 per state
     (load-more is JS/AJAX driven); we accept that cap and log it.
  3. BBNW pass: for each mapped school fetch its BBNW page (/schools/{slug}),
     parse its commit table, join ranks. The school page IS the destination, so
     committed_team_id is known directly from the map.
  4. PBR pass: for each mapped school with a pbr_code fetch /schools/{code},
     parse its commit table (same Name|State|HS|Class|Pos. shape). Merge by
     (first,last,grad_year): a player already from BBNW gains 'pbr' in sources +
     missing fields filled; a PBR-only player (out-of-region) is inserted new
     with committed_team_id = that school and baseline score 25.
  5. Score: better (lower) of bbnw/pbr rank → clamp(100-(rank-1)*1.2, 20, 100);
     unranked → baseline 25.
  6. Upsert into recruits ON CONFLICT (first_name,last_name,grad_year).

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

# Home states for which we have a ranking source (BBNW + the PBR PDF). A
# recruit from a state NOT in this set has no ranking data and is excluded
# from class scoring (not penalized). Shared with the API.
sys.path.insert(0, str(ROOT / "backend"))
from app.recruiting_constants import RANKED_STATES  # noqa: E402
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
PBR_BASE = "https://www.prepbaseballreport.com"

# Player home-states that count as "in region" for the PNW. A PBR per-school
# commit whose home state is NOT one of these is an out-of-region commit — the
# exact value PBR adds over BBNW (BBNW only lists local-state players).
PNW_HOME_STATES = {"WA", "OR", "ID", "MT", "BC"}

# Curve shape. The score is a SMOOTH harmonic decay of the effective rank:
#   score = 100 / (1 + SCORE_DECAY * (eff_rank - 1)) * quality
# Harmonic (not linear) on purpose: a linear curve slid to a hard floor, so it
# fell off a cliff in the middle (OR #30 -> #65 dropped 40 pts) and then pinned
# every deep player at the same floor (every WA player past ~#67 was a flat 20).
# The harmonic curve eases off gradually and never flatlines, so #100 and #150
# still separate. SCORE_DECAY is tuned so OR #30 ~= 63 and OR #65 ~= 44 (the
# anchors Nate gave). DEPTH then stretches/compresses the rank before the curve.
SCORE_DECAY = 0.018
# Unranked / no-rank-data commits sit at this baseline. Kept low on purpose so a
# CLASS average is driven by ranked talent, not by how many depth / out-of-region
# commits a program stacks up. Out-of-region PBR commits have no rank only
# because PBR per-school pages don't list one, so this is an "unknown"
# placeholder, not a judgment that they're weak. A ranked player always scores
# at least UNRANKED_BASELINE + 1, so ranked > unranked everywhere.
UNRANKED_BASELINE = 12.0


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


# Manual destination corrections for recruits the SOURCES mislabel — keyed by
# (norm first, norm last, grad_year) -> committed_team_id, reapplied every scrape
# so the fix sticks (the upsert otherwise overwrites committed_team_id).
# Pacific (OR, id 17) vs University of the Pacific / UOP (CA D1, id 32857): PBR
# tags some UOP commits as "Pacific Boxers" (Pacific OR's mascot), so the string
# alone can't disambiguate. Add a line here when a recruit is confirmed mis-homed.
RECRUIT_DEST_OVERRIDES = {
    ("nick", "schikore", 2026): 32857,       # UOP (CA), not Pacific OR
    ("luke", "van de braak", 2026): 32857,   # UOP (CA), not Pacific OR
}


def derive_bbnw_slug(school_name):
    """Derive a BBNW /schools/{slug} slug from a school_name.

    BBNW renders " & " as a DOUBLE hyphen: "Lewis & Clark College" ->
    "lewis--clark-college" (confirmed live). Everything else collapses to single
    hyphens. This is a fallback for schools added to the map without a slug; the
    authoritative slugs in recruit_school_map.json were verified by probing.
    """
    s = unicodedata.normalize("NFKD", school_name or "").encode("ascii", "ignore").decode()
    s = s.lower().replace(" & ", " -- ").replace("&", " -- ")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-{3,}", "--", s)
    return s.strip("-")


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


def parse_pbr_school_commits(html, grad_year):
    """Parse a PBR per-school page (/schools/{code}).

    PBR school pages carry ONE table with the SAME column shape as BBNW school
    pages: Name | State | School(HS) | Class(grad year) | Pos. — so the BBNW
    row parser is reused verbatim. The State column is the player's HOME state,
    so out-of-region commits (CA/TX/AZ/...) appear here and are kept (we do NOT
    filter by state). PBR soft-404s render the 'Page Cannot Be Found' shell and
    a real header row 'Name'/'State'; guard both so a missing code yields [].
    """
    if not html or "page cannot be found" in html.lower():
        return []
    return parse_school_commits(html, grad_year)


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
# Cross-state weighting. A state rank is only comparable WITHIN its state —
# the #5 player in Washington is a better prospect than the #5 in Idaho,
# because WA has a far deeper HS talent pool. So we scale each state's rank
# curve by a strength factor (strongest PNW state = 1.0). Factors are seeded
# from BBNW's own ranking depth (WA lists ~60, OR ~30, ID ~25) plus known
# regional baseball strength, and are a transparent editable dial — tune
# here if a state looks over/under-rated. Out-of-region factors (CA/TX/...)
# only matter if we ever attach a cross-state rank to those players; today
# they're unranked (PBR's full rankings are paywalled), so they stay at the
# flat baseline regardless.
# Two knobs per state, because "how good is a #N from here?" has two
# independent answers:
#   QUALITY = top-end strength: how good the state's BEST prospects are vs WA's
#             #1. A multiplier on the whole curve (WA = 1.0 baseline).
#   DEPTH   = pool depth: a divisor on rank-distance. A deep pool ranks hundreds
#             of real prospects, so its #64 is a far better player than a #64 in
#             a shallow pool. WA = 1.0 (no compression). California is the
#             deepest pool we touch (PBR ranks run past 340), so a CA #64 maps
#             to roughly WA's top-10 — which is what it actually is.
# WA/OR/ID/MT keep their approved QUALITY and DEPTH 1.0 so their scores are
# unchanged from the last tuning. Only deep states get DEPTH > 1.
STATE_QUALITY = {
    "WA": 1.00, "OR": 0.97, "ID": 0.78, "MT": 0.60,
    "CA": 1.05, "TX": 1.06, "FL": 1.04, "AZ": 0.98, "GA": 1.02,
    "NV": 0.88, "UT": 0.85, "CO": 0.85, "HI": 0.78,
    # Canada bumped up: the BC/AB/ON pipelines were badly underrated before.
    "BC": 0.90, "AB": 0.88, "ON": 0.90,
}
# DEPTH > 1 compresses the ladder (deep pools: a #64 is still strong); DEPTH < 1
# stretches it so a thin pool falls off fast. ID/MT use DEPTH < 1 because they
# rank only a shallow top tier — a state #12 there is NOT a #12-caliber player,
# so it should drop quickly (Nate: "Idaho needs to drop off way faster").
STATE_DEPTH = {
    "WA": 1.0, "OR": 1.0, "ID": 0.35, "MT": 0.40,
    "CA": 6.0, "TX": 4.5, "FL": 4.0, "GA": 3.5, "AZ": 2.5,
    "NV": 1.2, "UT": 1.2, "CO": 1.2, "HI": 0.7,
    "BC": 2.0, "AB": 1.8, "ON": 2.5,
}
STATE_DEFAULT_QUALITY = 0.82
STATE_DEFAULT_DEPTH = 1.1


def combined_state_rank(bbnw_rank, pbr_rank):
    """The player's single State Rank = the AVERAGE of the outlet ranks we
    have, rounded to a whole number (no fractions, per Nate): #10 and #20 →
    15. One source → that rank. Neither → None. We never surface which
    outlets these came from."""
    ranks = [r for r in (bbnw_rank, pbr_rank) if r]
    if not ranks:
        return None
    return int(sum(ranks) / len(ranks) + 0.5)  # round half up


def compute_score(bbnw_rank, pbr_rank, state=None):
    """Combined State Rank (avg of the outlet ranks) → effective rank (DEPTH
    stretch/compress) → smooth harmonic decay → QUALITY scale, so ranks are
    cross-state comparable. e.g. WA #5≈93, #30≈63, #100≈36; CA's deep pool
    keeps #64≈88; thin ID drops fast, #12≈50.

    Unranked players split by whether we have ANY ranking source for their
    home state (RANKED_STATES):
      - state HAS rankings, player just didn't make the list → flat baseline
        (a real "depth piece" signal; counts in the class average).
      - state has NO ranking source (HI, MT, CO, AZ, ...) → return None. We
        have no data, so they're EXCLUDED from class math rather than
        penalized (per Nate). The site shows them as commits with no rank.
    A ranked player always scores above a baseline one."""
    st = (state or "").strip().upper()
    rank = combined_state_rank(bbnw_rank, pbr_rank)
    if rank is None:
        return UNRANKED_BASELINE if st in RANKED_STATES else None
    depth = STATE_DEPTH.get(st, STATE_DEFAULT_DEPTH)
    quality = STATE_QUALITY.get(st, STATE_DEFAULT_QUALITY)
    # Map the raw rank to a WA-equivalent "effective rank" (depth stretches or
    # compresses it), run it through the smooth harmonic decay, then scale by
    # top-end quality. Capped at 100; floored just above the unranked baseline
    # so a ranked player always beats an unranked one.
    eff_rank = 1.0 + (rank - 1) / depth
    decay = 100.0 / (1.0 + SCORE_DECAY * (eff_rank - 1.0))
    score = min(100.0, decay * quality)
    return round(max(UNRANKED_BASELINE + 1.0, score), 1)


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

    # Pull team names for committed_raw reference, plus any PBR ranks already in
    # the DB. PBR's full state rankings are paywalled, so most pbr_state_rank
    # values were ingested from PDF exports (ingest_pbr_pdf_rankings.py), NOT
    # scraped here — this scraper has no way to re-derive them. We load them so
    # the rebuild below can carry them forward; without this they'd be wiped
    # every run and CA/Canada classes would collapse to unranked.
    team_names = {}
    existing_pbr = {}
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, name, short_name FROM teams")
        for r in cur.fetchall():
            team_names[r["id"]] = r["name"] or r["short_name"]
        cur.execute("SELECT first_name, last_name, pbr_state_rank FROM recruits "
                    "WHERE grad_year = %s AND pbr_state_rank IS NOT NULL", (grad_year,))
        for r in cur.fetchall():
            existing_pbr[(norm_name(r["first_name"]),
                          norm_name(r["last_name"]))] = r["pbr_state_rank"]

    # 1) Rankings indexes
    bbnw_index, pbr_index = fetch_state_indexes(grad_year, states)

    # Commits accumulate into a dict keyed on the upsert key (first, last,
    # grad_year) so the two passes (BBNW then PBR) merge in place: a player
    # listed by both sources becomes ONE row with sources=['bbnw','pbr']; a
    # player only on PBR (out-of-region) is a new row with sources=['pbr'].
    by_key = {}
    per_school_bbnw = {}
    per_school_pbr_new = {}
    dup_count = 0

    def upsert_key(c):
        return (norm_name(c["first_name"]), norm_name(c["last_name"]),
                c["grad_year"])

    # 2) BBNW pass — walk each mapped school, parse its commits + join ranks.
    for team_id, info in sorted(school_map.items()):
        bbnw_slug = info.get("bbnw_slug")
        short = info.get("short_name", str(team_id))
        if not bbnw_slug:
            # Fall back to deriving a slug from the school name. Verified slugs
            # live in the map; this only helps a newly-added school whose slug
            # wasn't probed yet (and harmlessly 404s if BBNW lacks the page).
            derived = derive_bbnw_slug(info.get("school_name", ""))
            if derived:
                logger.info("%s (team %s): no bbnw_slug in map; trying derived "
                            "slug %r", short, team_id, derived)
                bbnw_slug = derived
            else:
                logger.info("%s (team %s): no bbnw_slug; skipping BBNW", short, team_id)
                per_school_bbnw[short] = 0
                continue
        url = f"{BBNW_BASE}/schools/{bbnw_slug}"
        html = scraperapi_fetch(SCRAPER_API_KEY, url, min_size=3000,
                                label=f"BBNW school {short}")
        if not html:
            logger.warning("%s: BBNW school page fetch failed", short)
            per_school_bbnw[short] = 0
            continue
        commits = parse_school_commits(html, grad_year)
        # If a state filter is set, keep only commits from that state.
        if state_filter:
            commits = [c for c in commits if c.get("state") == state_filter.upper()]
        per_school_bbnw[short] = len(commits)

        for c in commits:
            nk = norm_name(c["full_name"])
            br = bbnw_index.get(nk)
            bbnw_rank = br["rank"] if br else None
            bbnw_url = br["url"] if br else None
            height = br["height"] if br else None
            weight = br["weight"] if br else None
            pbr_rank = pbr_index.get(nk)
            pbr_url = pbr_index.get((nk, "url"))
            sources = ["bbnw"]
            if pbr_rank:
                sources.append("pbr")
            score = compute_score(bbnw_rank, pbr_rank, c.get("state"))
            rec = {
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
            }
            k = upsert_key(c)
            if k in by_key:
                # BBNW listed the same commit twice on a page — keep the better.
                dup_count += 1
                if score > by_key[k]["recruit_score"]:
                    by_key[k] = rec
            else:
                by_key[k] = rec

    # 3) PBR pass — per-school commit pages. Mirrors the BBNW pass but PBR pages
    # carry NO rank (rank enrichment stays BBNW-only for v1). The value PBR adds
    # is COMMITS, especially OUT-OF-REGION players (a TX/CA/AZ kid → Gonzaga)
    # that BBNW (local-states-only) never lists. For a commit already present
    # from BBNW: keep committed_team_id, add 'pbr' to sources, fill any missing
    # state / HS / position / score-baseline. For a NEW PBR-only commit: insert
    # with committed_team_id = this school and the baseline score (25).
    for team_id, info in sorted(school_map.items()):
        pbr_code = info.get("pbr_code")
        short = info.get("short_name", str(team_id))
        if not pbr_code:
            continue
        url = f"{PBR_BASE}/schools/{pbr_code}"
        html = scraperapi_fetch(SCRAPER_API_KEY, url, min_size=3000,
                                label=f"PBR school {short}")
        if not html:
            logger.warning("%s: PBR school page fetch failed", short)
            per_school_pbr_new[short] = 0
            continue
        commits = parse_pbr_school_commits(html, grad_year)
        if state_filter:
            commits = [c for c in commits if c.get("state") == state_filter.upper()]
        new_here = 0
        for c in commits:
            k = upsert_key(c)
            existing = by_key.get(k)
            if existing:
                # Merge: this player already came from BBNW (or another PBR
                # school). Keep their committed_team_id; just record PBR as a
                # source and backfill any missing descriptive fields.
                if "pbr" not in existing["sources"]:
                    existing["sources"].append("pbr")
                if not existing.get("pbr_url"):
                    existing["pbr_url"] = url
                for fld in ("state", "high_school", "position"):
                    if not existing.get(fld) and c.get(fld):
                        existing[fld] = c[fld]
            else:
                # New commit seen only on PBR — the out-of-region pickup. PBR
                # per-school pages carry no rank, so baseline score (25).
                by_key[k] = {
                    **c,
                    "committed_team_id": team_id,
                    "committed_raw": team_names.get(team_id),
                    "bbnw_state_rank": None,
                    "bbnw_url": None,
                    "pbr_state_rank": None,
                    "pbr_url": url,
                    "height": None,
                    "weight": None,
                    "recruit_score": UNRANKED_BASELINE,
                    "sources": ["pbr"],
                }
                new_here += 1
        per_school_pbr_new[short] = new_here

    # Final BBNW-rank enrichment + uniform (re)scoring across BOTH passes. This
    # closes two gaps the per-pass logic left:
    #   1) A commit found only on a PBR school page (so the BBNW pass never saw
    #      it) can still appear on a BBNW state ranking list. Keegan Matson is a
    #      PBR-listed Oregon St commit who is BBNW WA #34 — the PBR pass alone
    #      would store him unranked. Apply the BBNW rank to every commit by name.
    #   2) The state a player is RANKED in governs his score, not his hometown.
    #      Anthony Karis lives in ID but is ranked on Washington's list, so he is
    #      scored as a WA prospect. We score each ranked commit from its ranking
    #      state and fall back to the hometown only when he isn't ranked.
    for rec in by_key.values():
        nk = norm_name(rec.get("full_name")
                       or f"{rec['first_name']} {rec['last_name']}")
        br = bbnw_index.get(nk)
        if br and not rec.get("bbnw_state_rank"):
            rec["bbnw_state_rank"] = br["rank"]
            rec["bbnw_url"] = rec.get("bbnw_url") or br.get("url")
            rec["height"] = rec.get("height") or br.get("height")
            rec["weight"] = rec.get("weight") or br.get("weight")
            if "bbnw" not in rec["sources"]:
                rec["sources"].append("bbnw")
        # Carry forward a PDF-ingested PBR rank this scrape couldn't see, so the
        # score below reflects it (and the upsert COALESCE keeps it in place).
        if not rec.get("pbr_state_rank"):
            ek = (norm_name(rec["first_name"]), norm_name(rec["last_name"]))
            if ek in existing_pbr:
                rec["pbr_state_rank"] = existing_pbr[ek]
                if "pbr" not in rec["sources"]:
                    rec["sources"].append("pbr")
        rank_state = br["state"] if br else rec.get("state")
        rec["recruit_score"] = compute_score(
            rec.get("bbnw_state_rank"), rec.get("pbr_state_rank"), rank_state)

    all_recruits = list(by_key.values())
    matched_ranks = sum(1 for r in all_recruits
                        if r["bbnw_state_rank"] or r["pbr_state_rank"])
    if dup_count:
        logger.info("Collapsed %d duplicate commit row(s) on (name, grad_year).",
                    dup_count)

    # Apply manual destination corrections (mislabeled sources, e.g. UOP commits
    # tagged "Pacific Boxers"). Reapplied every run so the fix survives re-scrapes.
    for r in all_recruits:
        ov = RECRUIT_DEST_OVERRIDES.get(
            (norm_name(r["first_name"]), norm_name(r["last_name"]), r["grad_year"]))
        if ov and r["committed_team_id"] != ov:
            logger.info("Override dest: %s %s (%s) -> team %s",
                        r["first_name"], r["last_name"], r["grad_year"], ov)
            r["committed_team_id"] = ov
            r["committed_raw"] = "University of the Pacific (CA)"

    # Per-school commit totals (BBNW + any PBR-only adds) for reporting.
    per_school_counts = {}
    short_by_team = {tid: info.get("short_name", str(tid))
                     for tid, info in school_map.items()}
    for r in all_recruits:
        s = short_by_team.get(r["committed_team_id"], str(r["committed_team_id"]))
        per_school_counts[s] = per_school_counts.get(s, 0) + 1

    pbr_only = sum(1 for r in all_recruits if r["sources"] == ["pbr"])
    out_of_region = sum(
        1 for r in all_recruits
        if (r.get("state") or "").upper() not in PNW_HOME_STATES
        and (r.get("state") or "")
    )
    logger.info("PBR pass: %d commit(s) only on PBR (new), %d total out-of-region "
                "(home state not WA/OR/ID/MT/BC).", pbr_only, out_of_region)

    total = len(all_recruits)
    rank_rate = (matched_ranks / total * 100) if total else 0.0
    logger.info("=" * 60)
    logger.info("Grad year %s: %d commits across %d schools; %d ranked "
                "(%.1f%% rank-match rate)", grad_year, total,
                sum(1 for v in per_school_counts.values() if v), matched_ranks, rank_rate)
    logger.info("Per-school commits (total | BBNW rows | PBR-only new):")
    for short in sorted(per_school_counts, key=lambda s: -per_school_counts[s]):
        if per_school_counts[short]:
            logger.info("  %-20s %3d | bbnw %3d | pbr-new %2d", short,
                        per_school_counts[short], per_school_bbnw.get(short, 0),
                        per_school_pbr_new.get(short, 0))

    if dry_run:
        logger.info("DRY RUN — nothing written.")
        # show a small sample with scores
        sample = sorted(all_recruits, key=lambda r: -r["recruit_score"])[:10]
        logger.info("Top 10 by score (dry run):")
        for r in sample:
            logger.info("  %.1f  %s %s (%s) → %s  [bbnw#%s pbr#%s src=%s]",
                        r["recruit_score"], r["first_name"], r["last_name"],
                        r["position"], r["committed_raw"],
                        r["bbnw_state_rank"], r["pbr_state_rank"], r["sources"])
        # show out-of-region PBR pickups — the headline new value
        oor = [r for r in all_recruits
               if (r.get("state") or "").upper() not in PNW_HOME_STATES
               and (r.get("state") or "")]
        logger.info("Sample out-of-region commits (PBR's new value), %d total:",
                    len(oor))
        for r in oor[:10]:
            logger.info("  %s %s (%s) home=%s → %s  src=%s",
                        r["first_name"], r["last_name"], r["position"],
                        r.get("state"), r["committed_raw"], r["sources"])
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
                    pbr_state_rank    = COALESCE(EXCLUDED.pbr_state_rank, recruits.pbr_state_rank),
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
