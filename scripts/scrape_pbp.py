#!/usr/bin/env python3
"""
PBP scraper — Phase 1 (full per-PA event extraction)
=====================================================

Walks games whose play-by-play hasn't been scraped, re-fetches the
box-score URL from `games.source_url`, parses every plate appearance
into the `game_events` table, and (as a derived secondary write) keeps
`game_pitching.home_runs_allowed` in sync from those events.

Designed to run once per night (3 AM Pacific via cron) so we can wait
for the official scorer to push the StatCrew PBP file to Sidearm —
that often lags the box-score totals by hours.

Usage
-----
Default (cron mode — last 14 days, max 3 attempts, only unscraped games):
    PYTHONPATH=backend python3 scripts/scrape_pbp.py

Backfill all 2026 games (one-time historical pass):
    PYTHONPATH=backend python3 scripts/scrape_pbp.py --backfill --season 2026

Test on one game (no DB writes):
    PYTHONPATH=backend python3 scripts/scrape_pbp.py --game-id 3539 --dry-run

Re-scrape an already-scraped game:
    PYTHONPATH=backend python3 scripts/scrape_pbp.py --game-id 3539 --rescrape
"""

import argparse
import logging
import os
import re
import sys
import time
import unicodedata
from difflib import SequenceMatcher

import requests
import psycopg2.extras

# Project imports
from app.models.database import get_connection

# Local script imports — same scripts/ dir
sys.path.insert(0, "scripts")
from parse_pbp_events import parse_pbp_events  # noqa: E402
from parse_presto_events import parse_presto_events  # noqa: E402
from scrape_boxscores import find_player_id  # noqa: E402

# ── ScraperAPI for NWAC and other Presto sites ──
SCRAPER_API_KEY = os.environ.get("SCRAPER_API_KEY", "")
SCRAPER_API_BASE = "https://api.scraperapi.com"

# Hosts that run on PrestoSports (need ?view=plays + ScraperAPI)
PRESTO_HOSTS = ("nwacsports.com", "wubearcats.com")


def _normalize_name(name):
    """Strip apostrophes, dashes, accents, and extra whitespace from a name.

    Used so PBP names like "ONeil,Dillon" can match roster names like
    "O'Neil, Dillon" — and similar accent / punctuation variations.
    """
    if not name:
        return ""
    # Decompose accents (é → e + combining accent), then drop non-ASCII
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    # Strip any character that isn't a letter, comma, or whitespace
    s = re.sub(r"[^\w,\s]", "", s)
    # Collapse whitespace
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _phantom_parse_name(name: str) -> tuple[str, str]:
    """Parse a PBP-format name into (first, last) for phantom creation.

    Handles 'First Last', 'F. Last', 'Last, First', 'Last,First',
    'GAMBOA, AJ', and single-token names ('HOWARD'). Mirrors the parsing
    in scripts/create_phantom_players.py — keep them in sync.
    """
    name = (name or "").strip()
    if not name:
        return "", ""
    if "," in name:
        parts = name.split(",", 1)
        return parts[1].strip(), parts[0].strip()
    if " " in name:
        m = re.match(r"^([A-Z]\.?)\s+(.+)$", name)
        if m:
            first = m.group(1)
            if not first.endswith("."):
                first += "."
            return first, m.group(2).strip()
        first, last = name.rsplit(" ", 1)
        return first.strip(), last.strip()
    return "", name


def _resolve_phantom(cur, team_id: int, name: str) -> int | None:
    """Look up an existing phantom for (team_id, name) — or create one
    if none exists. Returns the player_id.

    Phantoms are flagged via players.is_phantom = TRUE. They give OOC
    opponents (Cal D3, etc.) a player_id we can group PA-level stats
    by, even though we never roster-scraped them. See
    scripts/create_phantom_players.py for the backfill rationale.
    """
    first, last = _phantom_parse_name(name)
    if not first and not last:
        return None
    cur.execute(
        """
        SELECT id FROM players
        WHERE team_id = %s
          AND COALESCE(first_name, '') = %s
          AND COALESCE(last_name, '') = %s
          AND is_phantom = TRUE
        LIMIT 1
        """,
        (team_id, first, last),
    )
    existing = cur.fetchone()
    if existing:
        return existing["id"]
    cur.execute(
        """
        INSERT INTO players
            (team_id, first_name, last_name, position, is_phantom,
             created_at, updated_at)
        VALUES (%s, %s, %s, 'P', TRUE, NOW(), NOW())
        RETURNING id
        """,
        (team_id, first, last),
    )
    return cur.fetchone()["id"]


def find_player_id_with_fallback(cur, team_id, name, season, game_id=None):
    """find_player_id, then a normalized-name fallback if that misses.

    The fallback fetches all players on the team once per call, normalizes
    each name, and matches against the normalized input. This handles
    apostrophes (O'Neil/ONeil), accents (José/Jose), and similar.

    When the fallback finds MULTIPLE candidates (e.g. two "Bertram"s on
    one team) AND we have a game_id, we disambiguate by asking game_batting
    which of those candidates actually appeared in the box for that game.
    If exactly one of the candidates is in the box, we use that one.

    Returns (player_id, fallback_used) where fallback_used is True if
    the original lookup missed.
    """
    pid = find_player_id(cur, team_id, name, season)
    if pid:
        return pid, False
    norm_input = _normalize_name(name).lower()
    if not norm_input:
        return None, False
    # Pull the input's last token (often the lastname) for hyphenated
    # match attempts ("KATAYAMA, C" → input_last = "katayama" matches
    # DB lastname "Katayama-Stall").
    input_parts = norm_input.split()
    # Strip trailing commas left over from "Last, First" splits.
    input_last = (input_parts[0] if "," in name
                  else (input_parts[-1] if input_parts else ""))
    input_last = input_last.rstrip(",").strip()
    cur.execute("""
        SELECT id, first_name, last_name FROM players WHERE team_id = %s
    """, (team_id,))
    candidates = []
    for r in cur.fetchall():
        first = r["first_name"] or ""
        last = r["last_name"] or ""
        first_init = first[0] if first else ""
        forms = [
            _normalize_name(f"{first} {last}").lower(),
            _normalize_name(f"{last}, {first}").lower(),
            _normalize_name(f"{last},{first}").lower(),
            _normalize_name(last).lower(),
            # "Last, F" / "Last, F." — accent-stripped lookups for
            # "Sanchez, R" (PBP) → "Sánchez, Ricky" (DB).
            f"{_normalize_name(last).lower()}, {first_init.lower()}",
            f"{_normalize_name(last).lower()},{first_init.lower()}",
        ]
        if any(f == norm_input for f in forms):
            candidates.append(r["id"])
            continue
        # Hyphenated-lastname fallback: if the input's last token matches
        # any HYPHEN-SEPARATED PART of the DB lastname, count as candidate.
        # Handles "KATAYAMA, C" → "Katayama-Stall", "Smith" → "McFarland-Smith".
        if input_last and "-" in last:
            parts = [_normalize_name(p).lower() for p in last.split("-") if p]
            if input_last in parts:
                candidates.append(r["id"])
    if len(candidates) == 1:
        return candidates[0], True
    if len(candidates) > 1 and game_id is not None:
        # Ambiguous on team — disambiguate via game_batting presence.
        cur.execute("""
            SELECT DISTINCT player_id FROM game_batting
            WHERE game_id = %s AND team_id = %s AND player_id = ANY(%s)
        """, (game_id, team_id, candidates))
        in_game = [r["player_id"] for r in cur.fetchall()]
        if len(in_game) == 1:
            return in_game[0], True

    # Truncated-lastname fallback for "F. Lastname" inputs.
    # Some Sidearm sites truncate long names at ~12 characters in PBP
    # (e.g. "M. Thoma-Bri" instead of "M. Thoma-Britt"). Match by
    # first-initial + last_name STARTING WITH the input prefix.
    m_init = re.match(r"^([A-Za-z])\.?\s+(.+?)\.?$", name.strip())
    if m_init:
        initial = m_init.group(1)
        last_prefix = m_init.group(2).strip()
        if last_prefix:
            # Match if last_name STARTS WITH the prefix, OR if any word
            # within last_name (split on space/hyphen) starts with it.
            # The latter handles cases like "J. hoy" → "Au Hoy" where
            # the source truncates a multi-word lastname to just one word.
            cur.execute("""
                SELECT p.id FROM players p
                WHERE p.team_id = %s
                  AND LOWER(SUBSTRING(p.first_name FROM 1 FOR 1)) = LOWER(%s)
                  AND (
                    LOWER(p.last_name) LIKE LOWER(%s)
                    OR EXISTS (
                      SELECT 1 FROM regexp_split_to_table(LOWER(p.last_name), %s) AS word
                      WHERE word LIKE LOWER(%s)
                    )
                  )
                LIMIT 3
            """, (team_id, initial, last_prefix + "%", r'[\s\-]+', last_prefix.lower() + "%"))
            rows = cur.fetchall()
            if len(rows) == 1:
                return rows[0]["id"], True
            if len(rows) > 1 and game_id is not None:
                cand_ids = [r["id"] for r in rows]
                cur.execute("""
                    SELECT DISTINCT player_id FROM game_batting
                    WHERE game_id = %s AND team_id = %s AND player_id = ANY(%s)
                """, (game_id, team_id, cand_ids))
                in_game = [r["player_id"] for r in cur.fetchall()]
                if len(in_game) == 1:
                    return in_game[0], True

    return None, False


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("scrape_pbp")


USER_AGENT = "Mozilla/5.0 (compatible; pnw-baseball-pbp/0.1)"
RECENT_DAYS = 14
MAX_ATTEMPTS = 3


# ─────────────────────────────────────────────────────────────────
# HTML fetch
# ─────────────────────────────────────────────────────────────────

def fetch_html(url, timeout=30):
    headers = {"User-Agent": USER_AGENT}
    resp = requests.get(url, headers=headers, timeout=timeout)
    resp.raise_for_status()
    return resp.text


def _is_presto_url(url):
    """True if this URL needs Presto parsing + ScraperAPI."""
    return any(h in (url or "") for h in PRESTO_HOSTS)


def _presto_pbp_url(url):
    """Append ?view=plays so we get the play-by-play, not the box."""
    if "view=plays" in url:
        return url
    sep = "&" if "?" in url else "?"
    return url + sep + "view=plays"


def fetch_html_smart(url, timeout=60):
    """Auto-route: ScraperAPI for Presto hosts (NWAC blocks direct), direct for Sidearm.

    Adds the ?view=plays query for Presto so we get the PBP page rather
    than the standard box score.
    """
    if _is_presto_url(url):
        target = _presto_pbp_url(url)
        if not SCRAPER_API_KEY:
            log.warning("Presto URL fetched without SCRAPER_API_KEY — likely to fail")
            return fetch_html(target, timeout=timeout)
        params = {"api_key": SCRAPER_API_KEY, "url": target, "premium": "true"}
        resp = requests.get(SCRAPER_API_BASE, params=params, timeout=timeout)
        resp.raise_for_status()
        return resp.text
    # Sidearm: direct fetch
    return fetch_html(url, timeout=timeout)


# ─────────────────────────────────────────────────────────────────
# Team-name → team_id mapping
# ─────────────────────────────────────────────────────────────────

def _similarity(a, b):
    return SequenceMatcher(None, (a or "").lower(), (b or "").lower()).ratio()


def _expand_with_acronyms(variants):
    """Generate acronyms for multi-word variants and append them.

    Without this, a PBP caption like 'CSUSB' has only character-similarity
    to compete with — and will sometimes false-positive against another
    team's abbreviation (e.g. 'CSUSB' vs 'MSUB' = 0.67) instead of matching
    its own full name ('Cal State University San Bernardino' = 0.25).
    Adding 'CSUSB' (the acronym of the full name) to the variants gives a
    1.0 perfect match in those cases.
    """
    out = list(variants)
    seen = {v.lower() for v in variants if v}
    for v in variants:
        if not v or " " not in v:
            continue
        words = re.findall(r"[A-Za-z]+", v)
        # Acronym from initial letters
        if len(words) >= 2:
            acro = "".join(w[0] for w in words).upper()
            if acro and acro.lower() not in seen and 2 <= len(acro) <= 8:
                out.append(acro)
                seen.add(acro.lower())
    return out


def _best_score(pbp_name, candidate_strings):
    candidates = _expand_with_acronyms(candidate_strings)
    best = 0.0
    for c in candidates:
        if not c:
            continue
        s = _similarity(pbp_name, c)
        if s > best:
            best = s
    return best


def map_caption_to_team_id(pbp_team_names, home_team_id, home_variants, away_team_id, away_variants):
    """Match each PBP-caption team name to home_team_id or away_team_id.

    BIPARTITE ASSIGNMENT: when there are exactly two PBP captions, force
    them to map to DIFFERENT team_ids. We compute all four (caption,
    team) similarity scores and pick the pairing that maximizes the
    total score subject to the constraint.

    This prevents short-abbreviation collisions like "CSUSB" mapping to
    CWU instead of "Cal State San Bernardino" because "CSUSB" vs "CWU"
    SequenceMatcher ratio (0.50) beats "CSUSB" vs "Cal State..." (0.28)
    on raw character similarity. Bipartite matching forces the lower-
    confidence caption onto the other team rather than letting both
    collide on the same side.

    For !=2 captions (rare/never), falls back to independent matching
    with the 0.5 threshold.
    """
    names = list(pbp_team_names)
    home_vars = [v for v in home_variants if v]
    away_vars = [v for v in away_variants if v]

    if len(names) == 2:
        n0, n1 = names
        s00 = _best_score(n0, home_vars)   # n0 → home
        s01 = _best_score(n0, away_vars)   # n0 → away
        s10 = _best_score(n1, home_vars)   # n1 → home
        s11 = _best_score(n1, away_vars)   # n1 → away
        # Two valid assignments under the must-be-different constraint:
        opt_a = s00 + s11   # n0=home, n1=away
        opt_b = s01 + s10   # n0=away, n1=home
        # Each assignment requires at least one side to clear a low bar
        # so we don't fabricate a match for two unrelated names. 0.3 is
        # well below the old 0.5 threshold but above noise.
        out = {}
        if opt_a >= opt_b and max(s00, s11) >= 0.3:
            out[n0] = home_team_id
            out[n1] = away_team_id
        elif opt_b > opt_a and max(s01, s10) >= 0.3:
            out[n0] = away_team_id
            out[n1] = home_team_id
        return out

    # Fallback (one or three+ captions — shouldn't happen for a normal
    # nine-inning game but handle gracefully).
    out = {}
    for pbp_name in names:
        s_home = _best_score(pbp_name, home_vars)
        s_away = _best_score(pbp_name, away_vars)
        if s_home >= s_away and s_home >= 0.5:
            out[pbp_name] = home_team_id
        elif s_away > s_home and s_away >= 0.5:
            out[pbp_name] = away_team_id
    return out


# ─────────────────────────────────────────────────────────────────
# Per-game processing
# ─────────────────────────────────────────────────────────────────

def get_starters(cur, game_id):
    """Return {team_id: starter_name} from existing game_pitching rows."""
    cur.execute("""
        SELECT team_id, player_name
        FROM game_pitching
        WHERE game_id = %s AND is_starter = TRUE
    """, (game_id,))
    return {r["team_id"]: r["player_name"] for r in cur.fetchall()}


def process_game(cur, game, dry_run=False, verbose=False):
    """Scrape one game's PBP, write events to game_events, update HR-allowed.

    Always increments pbp_attempt_count. Sets pbp_scraped_at only when
    we successfully extracted at least one event (or confirmed there's
    legitimately no PBP available on the page).
    """
    gid = game["id"]
    url = game["source_url"]
    season = game["season"]

    result = {
        "game_id": gid,
        "url": url,
        "fetched": False,
        "had_pbp": False,
        "events_total": 0,
        "events_inserted": 0,
        "batters_resolved": 0,
        "pitchers_resolved": 0,
        "hr_pitchers_updated": 0,
        "warnings": [],
        "error": None,
    }

    # ── Skip Presto URLs when no API key (server cron) ──
    # These will be picked up by the GH Actions workflow that has the
    # SCRAPER_API_KEY secret. Don't bump attempt count — we want to try
    # again next time the script runs in an environment that can fetch.
    if _is_presto_url(url) and not SCRAPER_API_KEY:
        result["error"] = "skipped:no_scraper_api_key"
        return result

    # ── Fetch (auto-routes Presto via ScraperAPI) ──
    try:
        html = fetch_html_smart(url)
        result["fetched"] = True
    except Exception as e:
        result["error"] = f"fetch:{type(e).__name__}:{e}"
        if not dry_run:
            cur.execute("""
                UPDATE games SET pbp_attempt_count = pbp_attempt_count + 1
                WHERE id = %s
            """, (gid,))
        return result

    # ── Parse: pick parser based on source host ──
    parser_fn = parse_presto_events if _is_presto_url(url) else parse_pbp_events

    # Build kwargs that only the Presto parser accepts. Sidearm
    # parser ignores these — we only pass them to Presto.
    parser_kwargs = {}
    if parser_fn is parse_presto_events:
        # Use the team's full name as it would appear in PBP narrative;
        # falls back through several db name fields. The Presto parser
        # uses these to recover from missing offscreen-span markup.
        parser_kwargs["home_team_name"] = (
            game.get("home_team_name") or game.get("home_db_name")
            or game.get("home_db_school")
        )
        parser_kwargs["away_team_name"] = (
            game.get("away_team_name") or game.get("away_db_name")
            or game.get("away_db_school")
        )

    _, meta = parser_fn(html, **parser_kwargs)
    if meta.get("team_fallback_used"):
        log.info("game %d: presto team-name fallback applied (offscreen span missing)", gid)
    if not meta["has_pbp"]:
        # No PBP section — Oregon/OSU/WSU home games etc. Bump counter so
        # we eventually give up after MAX_ATTEMPTS.
        if not dry_run:
            cur.execute("""
                UPDATE games SET pbp_attempt_count = pbp_attempt_count + 1
                WHERE id = %s
            """, (gid,))
        return result

    result["had_pbp"] = True

    # ── Map PBP captions → DB team_ids ──
    home_variants = [
        game["home_team_name"], game.get("home_db_name"),
        game.get("home_db_school"), game.get("home_db_short"),
    ]
    away_variants = [
        game["away_team_name"], game.get("away_db_name"),
        game.get("away_db_school"), game.get("away_db_short"),
    ]
    name_to_team = map_caption_to_team_id(
        meta["all_team_names"],
        game["home_team_id"], home_variants,
        game["away_team_id"], away_variants,
    )
    for n in meta["all_team_names"]:
        if n not in name_to_team:
            result["warnings"].append(f"<unmappable_team:{n!r}>")

    # ── Seed starters from game_pitching ──
    starters_by_team_id = get_starters(cur, gid)
    starters_by_pbp_name = {}
    for pbp_name, team_id in name_to_team.items():
        if team_id in starters_by_team_id:
            starters_by_pbp_name[pbp_name] = starters_by_team_id[team_id]

    # ── Second-pass parse with starters seeded (same parser as before) ──
    events, _ = parser_fn(html, starters=starters_by_pbp_name, **parser_kwargs)
    result["events_total"] = len(events)

    # ── Resolve player_ids per event ──
    # batter is on batting_team; pitcher is on defending_team.
    # Cache lookups within one game to avoid hammering find_player_id.
    batter_cache = {}    # (team_id, name) -> player_id or None
    pitcher_cache = {}

    def resolve(name, team_id, cache):
        """Resolve a name to a player_id.

        Tries the real-player matcher first. If that misses (typically
        an OOC opponent we never roster-scraped), creates a phantom
        player record on the team and uses that. Phantoms are flagged
        with players.is_phantom = TRUE so leaderboards can filter them
        out — see scripts/create_phantom_players.py for the bulk
        backfill that introduced this pattern.
        """
        if not name or name == "<UNKNOWN STARTER>":
            return None
        key = (team_id, name)
        if key in cache:
            return cache[key]
        if not team_id:
            cache[key] = None
            return None
        # 1. Try real-player match.
        pid, _used_fallback = find_player_id_with_fallback(cur, team_id, name, season, game_id=gid)
        if pid:
            cache[key] = pid
            return pid
        # 2. Fall back to phantom: lookup-or-create.
        pid = _resolve_phantom(cur, team_id, name)
        cache[key] = pid
        return pid

    enriched = []
    for ev in events:
        batting_team_id = name_to_team.get(ev["batting_team_name"])
        defending_team_id = name_to_team.get(ev["defending_team_name"])
        if not batting_team_id or not defending_team_id:
            continue   # team unmappable — already warned above
        batter_pid = resolve(ev["batter_name"], batting_team_id, batter_cache)
        pitcher_pid = resolve(ev["pitcher_name"], defending_team_id, pitcher_cache)
        if batter_pid:
            result["batters_resolved"] += 1
        if pitcher_pid:
            result["pitchers_resolved"] += 1
        enriched.append({
            **ev,
            "batting_team_id": batting_team_id,
            "defending_team_id": defending_team_id,
            "batter_player_id": batter_pid,
            "pitcher_player_id": pitcher_pid,
        })

    if verbose:
        log.info(f"  game {gid}: parsed {len(events)} events, "
                 f"{result['batters_resolved']} batter IDs, "
                 f"{result['pitchers_resolved']} pitcher IDs")

    # ── Write game_events (idempotent: DELETE then INSERT) ──
    if not dry_run and enriched:
        cur.execute("DELETE FROM game_events WHERE game_id = %s", (gid,))
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO game_events (
                game_id, inning, half, sequence_idx,
                batting_team_id, defending_team_id,
                batter_player_id, batter_name,
                pitcher_player_id, pitcher_name,
                balls_before, strikes_before, pitch_sequence,
                pitches_thrown, was_in_play,
                result_type, result_text, rbi
            ) VALUES %s
            """,
            [(
                gid, ev["inning"], ev["half"], ev["sequence_idx"],
                ev["batting_team_id"], ev["defending_team_id"],
                ev["batter_player_id"], ev["batter_name"],
                ev["pitcher_player_id"], ev["pitcher_name"],
                ev["balls_before"], ev["strikes_before"], ev["pitch_sequence"],
                ev["pitches_thrown"], ev["was_in_play"],
                ev["result_type"], ev["result_text"], ev["rbi"],
            ) for ev in enriched],
            page_size=200,
        )
        result["events_inserted"] = len(enriched)

    # ── Derived: update game_pitching.home_runs_allowed from events ──
    # Count HRs per (defending_team_id, pitcher_player_id) and UPDATE.
    # Pitchers we couldn't resolve are silently dropped — same OOC
    # behavior as Phase 0.
    hr_by_pp = {}   # (team_id, pitcher_pid) -> count
    for ev in enriched:
        if ev["result_type"] != "home_run":
            continue
        if not ev["pitcher_player_id"]:
            continue
        key = (ev["defending_team_id"], ev["pitcher_player_id"])
        hr_by_pp[key] = hr_by_pp.get(key, 0) + 1

    if not dry_run:
        for (team_id, pid), n in hr_by_pp.items():
            cur.execute("""
                UPDATE game_pitching
                SET home_runs_allowed = %s
                WHERE game_id = %s AND team_id = %s AND player_id = %s
            """, (n, gid, team_id, pid))
            if cur.rowcount > 0:
                result["hr_pitchers_updated"] += 1

        # ── Derived: backfill game_pitching.pitches_thrown (NP) from events ──
        # Box-score scrapers don't always capture pitch counts (especially
        # on sources that omit them from their pitching tables). Sum NP
        # from events when available so player game logs show NP for the
        # majority of games.
        cur.execute("""
            UPDATE game_pitching gp
            SET pitches_thrown = sub.np
            FROM (
              SELECT pitcher_player_id, SUM(pitches_thrown) AS np
              FROM game_events
              WHERE game_id = %s
                AND pitcher_player_id IS NOT NULL
                AND pitches_thrown IS NOT NULL
              GROUP BY pitcher_player_id
              HAVING SUM(pitches_thrown) > 0
            ) sub
            WHERE gp.game_id = %s
              AND gp.player_id = sub.pitcher_player_id
              AND (gp.pitches_thrown IS NULL OR gp.pitches_thrown = 0)
        """, (gid, gid))

        # ── Derive base/out/score state for the freshly-written events ──
        # Powers situational splits, leverage, WPA. Logs a warning on
        # score-mismatch but doesn't block — the audit lives in derive.
        try:
            from derive_event_state import derive_game
            derive_game(cur, gid, dry_run=False, force=True)
        except Exception as e:
            log.warning(f"  derive_event_state failed for game {gid}: {e}")

        # ── Classify batted-ball type + field zone from narrative ──
        # Powers spray / Pull-Center-Oppo splits and contact-profile cards.
        # Operates on result_text we already wrote — pure Python regex,
        # no extra HTTP/DB cost.
        try:
            from classify_batted_ball import classify, _CONTACT_TYPES
            cur.execute("""
                SELECT id, result_type, result_text
                FROM game_events WHERE game_id = %s
                  AND result_type = ANY(%s)
            """, (gid, list(_CONTACT_TYPES)))
            bb_updates = []
            for r in cur.fetchall():
                bb, zone, zone_fine = classify(r["result_type"], r["result_text"])
                bb_updates.append((bb, zone, zone_fine, r["id"]))
            if bb_updates:
                psycopg2.extras.execute_batch(
                    cur,
                    """
                    UPDATE game_events
                    SET bb_type = %s,
                        field_zone = %s,
                        field_zone_fine = %s,
                        bb_derived_at = now()
                    WHERE id = %s
                    """,
                    bb_updates,
                    page_size=200,
                )
        except Exception as e:
            log.warning(f"  classify_batted_ball failed for game {gid}: {e}")

    # ── Mark game complete ──
    if not dry_run:
        cur.execute("""
            UPDATE games
            SET pbp_scraped_at = NOW(),
                pbp_attempt_count = pbp_attempt_count + 1
            WHERE id = %s
        """, (gid,))

    return result


# ─────────────────────────────────────────────────────────────────
# Game selection
# ─────────────────────────────────────────────────────────────────

def select_games(cur, args):
    where = [
        "g.source_url IS NOT NULL",
        # NOTE: %% — psycopg2 treats % as parameter marker even in quoted strings.
        # Match either Sidearm box URL pattern OR Presto/NWAC box URL pattern.
        "(g.source_url LIKE 'https://%%/sports/baseball/stats/%%/boxscore/%%'"
        " OR g.source_url LIKE '%%nwacsports.com/sports/%%/boxscores/%%.xml'"
        " OR g.source_url LIKE '%%wubearcats.com/sports/%%/boxscores/%%.xml')",
    ]
    params = []
    # MAX_ATTEMPTS budget skipped on --rescrape so re-derive runs after a
    # parser change re-process previously-scraped games regardless of count.
    if not args.rescrape:
        where.append("g.pbp_attempt_count < %s")
        params.append(MAX_ATTEMPTS)

    if args.game_id:
        where.append("g.id = %s")
        params.append(args.game_id)
    else:
        if args.season:
            where.append("g.season = %s")
            params.append(args.season)
        if not args.backfill:
            where.append(f"g.game_date >= CURRENT_DATE - INTERVAL '{RECENT_DAYS} days'")
        if not args.rescrape:
            where.append("g.pbp_scraped_at IS NULL")

    sql = f"""
        SELECT g.id, g.source_url, g.season, g.game_date,
               g.home_team_id, g.home_team_name,
               g.away_team_id, g.away_team_name,
               ht.name AS home_db_name, ht.school_name AS home_db_school, ht.short_name AS home_db_short,
               at.name AS away_db_name, at.school_name AS away_db_school, at.short_name AS away_db_short
        FROM games g
        JOIN teams ht ON ht.id = g.home_team_id
        JOIN teams at ON at.id = g.away_team_id
        WHERE {' AND '.join(where)}
        ORDER BY g.game_date DESC, g.id DESC
        {f'LIMIT {args.limit}' if args.limit else ''}
    """
    cur.execute(sql, params)
    return [dict(r) for r in cur.fetchall()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--backfill", action="store_true",
                    help="Process all games in season, not just last 14 days")
    ap.add_argument("--rescrape", action="store_true",
                    help="Include games already marked pbp_scraped_at")
    ap.add_argument("--game-id", type=int,
                    help="Process exactly one game by id")
    ap.add_argument("--limit", type=int,
                    help="Cap total games processed")
    ap.add_argument("--dry-run", action="store_true",
                    help="Parse and report but write nothing")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()
        games = select_games(cur, args)
        log.info(f"{len(games)} games to process "
                 f"(backfill={args.backfill}, dry_run={args.dry_run})")

        totals = {
            "fetched": 0, "had_pbp": 0,
            "events_total": 0, "events_inserted": 0,
            "batters_resolved": 0, "pitchers_resolved": 0,
            "hr_pitchers_updated": 0, "errors": 0,
        }

        for i, g in enumerate(games, 1):
            log.info(f"[{i}/{len(games)}] game_id={g['id']}  {g['game_date']}  "
                     f"{g['away_team_name']}@{g['home_team_name']}")
            try:
                r = process_game(cur, g, dry_run=args.dry_run, verbose=args.verbose)
            except Exception as e:
                log.exception(f"  exception: {e}")
                totals["errors"] += 1
                continue

            if r["error"]:
                log.warning(f"  error: {r['error']}")
                totals["errors"] += 1
            else:
                if r["fetched"]: totals["fetched"] += 1
                if r["had_pbp"]: totals["had_pbp"] += 1
                totals["events_total"] += r["events_total"]
                totals["events_inserted"] += r["events_inserted"]
                totals["batters_resolved"] += r["batters_resolved"]
                totals["pitchers_resolved"] += r["pitchers_resolved"]
                totals["hr_pitchers_updated"] += r["hr_pitchers_updated"]
                if r["warnings"]:
                    log.warning(f"  warnings: {r['warnings']}")
                else:
                    log.info(f"  ok: {r['events_total']} events, "
                             f"{r['batters_resolved']} batter IDs, "
                             f"{r['pitchers_resolved']} pitcher IDs, "
                             f"{r['hr_pitchers_updated']} HR pitcher updates")

            if not args.dry_run:
                conn.commit()

            time.sleep(0.5)

        log.info("─" * 60)
        log.info(
            f"DONE: fetched={totals['fetched']}, had_pbp={totals['had_pbp']}, "
            f"events_total={totals['events_total']}, events_inserted={totals['events_inserted']}, "
            f"batter_ids={totals['batters_resolved']}, pitcher_ids={totals['pitchers_resolved']}, "
            f"hr_updates={totals['hr_pitchers_updated']}, errors={totals['errors']}"
        )


if __name__ == "__main__":
    main()
