# NWBB Stats — Project Guide for Claude

This file is the master onboarding doc for anyone (or any Claude session) starting work on this codebase. Read it before making changes.

---

## 1. What This Is

**NWBB Stats** is a college baseball analytics platform covering the Pacific Northwest (Washington, Oregon, Idaho, Montana, plus British Columbia for UBC). It tracks 57+ teams across five competitive tiers: NCAA Division I, II, III, NAIA, and NWAC (junior college / JUCO).

**Live URL:** https://nwbaseballstats.com (always this domain, never pnwbaseballstats.com or nwbbstats.com — "nwbb" is the systemd service name, not the domain)

**Audience:** Players, coaches, and fans. Everything written for the website or social media must be aimed at that audience — friendly, knowledgeable, never condescending.

**Brand voice rule:** No em-dashes anywhere on the public site or social media graphics. Use commas, periods, parentheses, or rewrite the sentence instead.

**Owner:** Nate Rasmussen ([nate.rasmussen26@gmail.com](mailto:nate.rasmussen26@gmail.com)). Nate is a novice coder who works primarily through AI assistance in VS Code. Always:
- Explain things one step at a time
- Specify clearly whether commands run on his Mac or on the production server
- Verify import paths and file locations before giving commands (don't guess)
- Pay attention to his current terminal directory before suggesting `cd` commands

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Tailwind CSS |
| Backend | FastAPI (Python 3) |
| Database | Supabase Postgres |
| Auth | Supabase Auth (JWT) |
| Server | DigitalOcean droplet (Ubuntu 22.04, $14.40/mo) |
| Frontend hosting | Vercel (auto-deploys on push to main) |
| Scrapers | Python + BeautifulSoup + Playwright + ScraperAPI |
| Cron / automation | Server crontab + GitHub Actions |

---

## 3. Repository & Code Locations

- **GitHub:** `rasmussenbaseball/pnw-baseball`
- **Local (Mac):** `~/code/pnw-baseball`
- **Production server:** `/opt/pnw-baseball` (NOT `/root/pnw-baseball`, NOT `/var/www/pnw-baseball`)
- **Branch:** `main` (all deploys happen from main)

---

## 4. Project Structure

```
pnw-baseball/
├── .env                          # DATABASE_URL, Supabase keys, SCRAPER_API_KEY
├── backend/
│   ├── app/
│   │   ├── main.py               # FastAPI app, CORS, static file serving
│   │   ├── api/
│   │   │   ├── routes.py         # ~60 endpoints (huge file, ~8000 lines)
│   │   │   ├── auth.py           # Supabase JWT auth
│   │   │   └── favorites.py      # User favorites endpoints
│   │   ├── models/
│   │   │   └── database.py       # get_connection() via psycopg2
│   │   ├── stats/
│   │   │   ├── advanced.py       # BattingLine, PitchingLine, wOBA, FIP
│   │   │   ├── ppi.py            # PNW Power Index formula
│   │   │   ├── projections.py    # Playoff projections, Monte Carlo
│   │   │   └── tiebreakers.py
│   │   └── utils/                # Empty folder, no modules here
│   ├── data/
│   │   ├── live_scores.json      # Gitignored, written by live scraper
│   │   ├── future_schedules.json # Gitignored, written by future schedule scraper
│   │   └── park_factors.json
│   └── requirements.txt
├── frontend/
│   ├── .env                      # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
│   ├── src/
│   │   ├── App.jsx               # Router with 40+ routes
│   │   ├── pages/                # 40+ page components
│   │   ├── components/           # Header, FilterBar, StatsTable, etc.
│   │   ├── hooks/useApi.js       # All API hooks
│   │   ├── context/AuthContext.jsx
│   │   ├── lib/supabase.js
│   │   ├── utils/stats.js        # Column defs, presets, badge colors
│   │   └── gm/                   # GM dynasty game (separate feature, see §13)
│   ├── public/
│   │   ├── logos/                # Team logos
│   │   └── headshots/            # Player photos
│   ├── vite.config.js            # Dev proxy to localhost:8000
│   └── vercel.json
├── scripts/                      # Scrapers and data jobs
│   ├── daily_update.sh           # Master daily script (server cron)
│   ├── team_matching.py          # SHARED team-name resolver (do not duplicate)
│   ├── scrape_d1.py, d2, d3, naia, nwac
│   ├── scrape_boxscores.py
│   ├── scrape_pbp.py             # Play-by-play scraper
│   ├── scrape_records.py
│   ├── scrape_national_ratings.py
│   ├── scrape_live_scores.py
│   ├── scrape_future_schedules.py
│   ├── scrape_summer.py
│   ├── recalculate_war.py
│   ├── recalculate_league_adjusted.py
│   ├── dedup_games.py
│   └── archive/                  # Old/one-time scripts
└── data/
    └── team_records_2026.csv
```

**Important folder note:** `backend/app/utils/` exists but is empty. Don't try to import from it.

---

## 5. Database (Supabase Postgres)

Connection: always via `from app.models.database import get_connection`. The connection module is `app.models.database`, NOT `app.db`, NOT `app.utils.*`.

Key tables (non-exhaustive):
- `teams` — short_name, school_name, conference_id, state, logo_url, is_active
- `conferences` — name, abbreviation, division_id
- `divisions` — level (D1, D2, D3, NAIA, JUCO)
- `players` — first_name, last_name, team_id, bats, throws, position, is_phantom, is_active
- `games` — season, game_date, home_team_id, away_team_id, scores, status, source_url
- `game_batting`, `game_pitching` — per-game lines (one row per player per game)
- `game_events` — per-PA play-by-play events
- `batting_stats`, `pitching_stats` — per-season totals (the source of truth for team aggregates)
- `team_season_stats` — season aggregate columns (DO NOT read these directly for team-level stats)
- `summer_*` tables — parallel structure for WCL, PIL, CCL summer leagues
- `national_ratings`, `composite_rankings`
- `user_favorites`
- `projection_snapshots`
- `*_frozen` versions of stats tables — for conference-freeze (snapshot at season end)

**Query DB from server CLI:**

```bash
cd /opt/pnw-baseball
PYTHONPATH=backend python3 -c "
from app.models.database import get_connection
with get_connection() as conn:
    cur = conn.cursor()
    cur.execute('YOUR SQL HERE')
    for r in cur.fetchall():
        print(dict(r))
"
```

The connection uses `RealDictCursor`, so rows behave like dicts.

---

## 6. Local Development

```bash
# Backend (from repo root)
cd ~/code/pnw-baseball
python3 -m uvicorn backend.app.main:app --port 8000 --reload

# Frontend (in another terminal)
cd ~/code/pnw-baseball/frontend
npm run dev
```

Vite proxies API calls from the dev server to `localhost:8000`.

All Python scripts use `PYTHONPATH=backend python3 scripts/<name>.py`. The `PYTHONPATH=backend` prefix is mandatory.

NWAC scrapers need `SCRAPER_API_KEY` from `.env`.

---

## 7. Deployment

The frontend and backend deploy through different paths.

### Frontend (Vercel auto-deploy)

Vercel watches `main` on the GitHub repo. Every push triggers an auto-build and deploy that takes about 60 seconds. No manual action needed.

For **frontend-only changes**, this is the entire deploy flow:
```bash
git add . && git commit -m "..." && git push origin main
```

### Backend (DigitalOcean server)

For backend changes (FastAPI, scrapers, data scripts):

```bash
# On Mac: push to GitHub
git add . && git commit -m "..." && git push origin main

# Then SSH to the server
ssh root@137.184.181.113
cd /opt/pnw-baseball
git pull origin main

# If frontend files also changed, rebuild
cd frontend && npm run build && cd ..

# Restart the API service
sudo systemctl restart nwbb
```

**Critical:** The frontend build (`npm run build`) must run on the SERVER, not on the Mac. `frontend/dist/` is gitignored, so building on Mac doesn't actually deploy.

Service name is `nwbb` (NOT `pnw-baseball` or `pnw-baseball-api`).

### Server quick facts

- **IP:** 137.184.181.113
- **Region:** SFO3
- **Specs:** 2 GB RAM, 1 vCPU, 50 GB SSD
- **Nginx config:** `/etc/nginx/sites-enabled/nwbb`
- **Headshots:** `/opt/headshots/` (served by nginx, NOT in git, persists across deploys)
- **Logos:** `/opt/logos/` (same pattern)
- **Live data files:** `/opt/pnw-baseball/backend/data/*.json` (gitignored)

---

## 8. Scrapers & Automation

### Server cron jobs (Pacific time)

| Job | Time | Command |
|---|---|---|
| Daily update | 1 PM, 4 PM, 7 PM, 11 PM | `daily_update.sh` |
| Live scores | Every 10 min, 8 AM to 8 PM | `scrape_live_scores.py` |
| Dedup games | 2 AM | `dedup_games.py` |

`daily_update.sh` runs (in order): scrape_d1, d2, d3, naia, boxscores, update_positions, records, national_ratings, future_schedules, backfill_player_ids, dedup_games.

The server does NOT scrape NWAC. The NWAC's AWS WAF blocks all datacenter IPs.

### GitHub Actions

NWAC scraping runs via GitHub Actions because the WAF blocks the server's datacenter IP. Workflows use ScraperAPI to bypass the WAF.

| Workflow | Schedule | Purpose |
|---|---|---|
| `nwac-schedule.yml` | Every 2 hrs, 11 AM to 9 PM PT | NWAC composite + master schedule |
| `nwac-boxscores.yml` | Daily 10 PM PT | NWAC individual box scores |
| `nwac-stats.yml` | Daily 7 PM PT | NWAC player season stats + recalculate_league_adjusted |

**Secrets:** `DATABASE_URL`, `SCRAPER_API_KEY`.

**Advanced stats ownership:** `recalculate_league_adjusted.py` runs ONLY in the `nwac-stats.yml` workflow. Running it on the server would race with GH Actions and compute league averages from incomplete data. Do NOT add it back to `daily_update.sh`.

`recalculate_war.py` is archived. Never run it. It uses hardcoded league averages and would clobber correct WAR values. Use `recalculate_league_adjusted.py` (which computes WAR as part of league adjustment).

### What each league gets

| Division | Box scores | Team game results | Player season stats | Where it runs |
|---|---|---|---|---|
| D1 (Sidearm) | yes | yes | yes | Server |
| D2 (Sidearm) | yes | yes | yes | Server |
| D3 (Sidearm) | yes | yes | yes | Server |
| NAIA (Sidearm) | yes | yes | yes | Server |
| NWAC (Presto) | yes | yes | yes | GitHub Actions |

### Common scraper commands

```bash
# Daily update (defaults to 2026 season)
bash scripts/daily_update.sh

# Individual league scrapers
PYTHONPATH=backend python3 scripts/scrape_d1.py --season 2026
PYTHONPATH=backend python3 scripts/scrape_nwac.py --season 2025-26  # academic-year format!

# Box scores
PYTHONPATH=backend python3 scripts/scrape_boxscores.py --season 2026 --division D1

# Future schedules (writes to backend/data/future_schedules.json)
PYTHONPATH=backend python3 scripts/scrape_future_schedules.py --season 2026

# Player linking (multi-school career)
PYTHONPATH=backend python3 scripts/link_transfers.py            # dry run
PYTHONPATH=backend python3 scripts/link_transfers.py --link     # commit

# PBP (play-by-play)
PYTHONPATH=backend python3 scripts/scrape_pbp.py --season 2026
PYTHONPATH=backend python3 scripts/derive_event_state.py
PYTHONPATH=backend python3 scripts/compute_wpa.py --season 2026
```

---

## 9. API Conventions

**Prefix:** All FastAPI routes are under `/api/v1/`, not `/api/`. Hitting the wrong prefix returns the SPA shell (HTML), not a 404.

**Envelopes:** Some endpoints wrap data, some don't. Critical example: `/api/v1/games/by-date` returns `{ "games": [...] }`, not a bare array. Always check the response shape.

**Team aggregates:** Always source from `pitching_stats` / `batting_stats` (per-season player rows). Never read the `team_season_stats` aggregate columns directly. The single source of truth helper is `get_team_aggregates()` in `routes.py`.

**Ghost row guard:** Endpoints that query `game_batting` or `game_pitching` MUST filter `team_id IN (g.home_team_id, g.away_team_id)`. Otherwise orphan rows from past scraping bugs leak into team pages.

**CORS:** `allow_methods=["*"]` in main.py is currently permissive. Eventually tighten for production but not urgent.

---

## 10. Critical Conventions and Gotchas

These are the things you can't derive by reading the code. Most are codified responses to past bugs.

### 10.1 Team-name resolution

Use `scripts/team_matching.py` for ALL opponent-name to team_id lookups. Never write a new inline resolver.

```python
from team_matching import get_or_create_ooc_team

team_id = get_or_create_ooc_team(
    cur,
    opponent_name,
    prefer_division_of_team_id=source_team_id,  # always pass this
)
```

The `prefer_division_of_team_id` hint is critical for disambiguating same-named teams.

### 10.2 The "Pacific" disambiguation rule

Two active rows in `teams` share `short_name='Pacific'`:

- **id=17** — Pacific University (NWC, D3). The PNW team we track.
- **id=32857** — University of the Pacific (WCC, D1). California school, OOC opponent.

Rule:
- A **D1 PNW team** (UW, Oregon, Oregon St., Wash. St., Gonzaga, Portland, Seattle U) playing "Pacific" means the D1 Pacific (id=32857).
- Any **non-D1 PNW team** playing "Pacific" means the D3 Pacific (id=17).
- No hint defaults to D3 Pacific (id=17).

`team_matching.py` already enforces this via the division-hint logic. If you find old data that violates the rule, that data was scraped before the April 2026 fix. Clean it up: update `games.home_team_id` / `away_team_id` AND the corresponding `game_batting` / `game_pitching` / `game_events` rows AND clear any name-fallback player_id links.

### 10.3 Other team-matching invariants

Per `team_matching.py`:
- Exact-match branches MUST consult the division hint (not just fuzzy fallback).
- Step 4 fuzzy MUST NOT reintroduce backward-LIKE (`LOWER(input) LIKE '%' || team_name || '%'`). It silently matched "Fresno Pacific University" to D3 Pacific and created ghost rows. Prefix-qualified names like "Fresno Pacific" / "Warner Pacific" / "Azusa Pacific" should fall through to `get_or_create_ooc_team`.
- Fuzzy tiebreaker sorts by `len(short_name)` ascending. Never by distance-to-input.

There's a regression test at `scripts/test_team_matching_pacific.py`. Run it before merging team_matching changes:

```bash
PYTHONPATH=backend python3 scripts/test_team_matching_pacific.py
```

### 10.4 Player matching pitfalls

`match_player_id()` has a last-name fallback that silently matches different players to the same `player_id` when first names don't match. Always inspect before deduping or aggregating by `player_id` alone. Memory: `feedback_player_matcher_fallback.md`.

### 10.5 Innings pitched is baseball notation

`game_pitching.innings_pitched` stores baseball notation (6.2 = 6 and 2/3 innings, NOT 6.2 as a decimal). Scrapers must preserve this. When computing rate stats, convert to outs (6.2 IP → 20 outs) before doing math, then convert back.

### 10.6 Strike% formula

`Strike% = (called strikes + swinging strikes + foul balls + balls in play) / total pitches`. Do NOT add `terminal_strikes` — that double-counts strikeouts and misses called strikes.

### 10.7 PBP narrative-shaped name guard

`scrape_pbp._resolve_phantom` must reject narrative-shaped names ("lined", "flied", "struck out", "was", etc.) when fuzzy-matching unknown batters. Otherwise polluted "player" rows pollute the site (e.g. "Albert Jennings was" became a player record).

### 10.8 WPA after re-scraping PBP

Re-scraping play-by-play nukes `wpa_batter` and `wpa_pitcher` columns on `game_events`. Always run `compute_wpa.py --season 2026` afterward, or season WPA totals will collapse.

### 10.9 Sidearm Nuxt `-1` sentinel filter

D1 Sidearm sites using Nuxt 3 include every roster player in BOTH the pitching and batting object arrays. Non-applicable stats use `-1` as a sentinel. `scrape_d1.py` MUST filter `-1` (and resolved-None) values before writing, or position players land in `pitching_stats` with IP=0 and pitchers land in `batting_stats` with AB=0. Memory: `feedback_nuxt_negative_one_filter.md`.

### 10.10 D1 Sidearm URL shapes

D1 Sidearm box-score URLs come in two shapes: legacy `.aspx` and modern Nuxt path-based URLs. Both must reach the API endpoint or HR data goes missing. Memory: `feedback_sidearm_url_shapes.md`.

### 10.11 Field naming between backend and frontend

The live ticker and similar live data flows are strict about field-name matching. If backend renames a field, the frontend must update in lockstep. Mismatches result in silent empty displays.

### 10.12 Date / year hardcoding

The current season `2026` is hardcoded in 13+ frontend files. Will need updating for 2027. Search for `2026` before assuming any helper function for "current season" exists.

Homepage WCL (summer ball) leaders use `2025` intentionally (summer 2025 is the most recent completed summer season).

### 10.13 NWAC season format

NWAC seasons use academic-year strings like `"2025-26"`, not just `2026`. Pass it correctly when calling NWAC scrapers.

### 10.14 NWAC playoff bracket structure

Four conferences (North, South, East, West). Top 4 from each qualify (16 teams).

Super Regionals (mid-May):
- North: N2 hosts. Single-elim W4 vs S3. Winner faces N2 best-of-3.
- East: E2 hosts. Single-elim N4 vs W3. Winner faces E2.
- West: W2 hosts. Single-elim S4 vs E3. Winner faces W2.
- South: S2 hosts. Single-elim E4 vs N3. Winner faces S2.

Championship (8 teams at Longview, WA): all 4 #1 seeds + 4 super regional winners.

Schedule sources often prefix team names with seed indicators like `"E4 Yakima Valley"` or `"vs. N3 Bellevue"`. The scrapers strip prefixes via `clean_opponent_name()` in `scrape_future_schedules.py` and `strip_seed_prefix()` in `scrape_nwac_schedule.py`. TBD opponent placeholders like `"W4 Clark/S3 Umpqua"` get filtered out via `is_tbd_opponent()`.

### 10.15 Phantom players

`players.is_phantom = TRUE` flags placeholder rows created when a PBP parser or box-score parser couldn't match a name to a real roster entry. Phantoms are used to keep stat lines from being lost; they get cleaned up via merge scripts when canonical players are later identified. As of 2026-05-04, PNW phantoms are down to 71 from a peak of 198. Memory: `project_phantom_cleanup_2026_05.md`.

### 10.16 Home/away team_id flips

A historical bug caused some games to have flipped `team_id` values relative to home_team_id/away_team_id. Slug-based sweep scripts exist to repair these. Look for `scripts/dedup_games.py` Pass 5 and related cleanup tooling before chasing apparent stat discrepancies. Memory: `project_home_away_flip_bug.md`.

### 10.17 NWAC scorer corrections

NWAC scorers update box scores for hours (sometimes a full day) after games conclude. The 6 AM Pacific re-scrape cron catches corrections. For one-off investigation: `debug_rescrape_game.py`.

### 10.18 Fielding data sources

Per-game / per-season fielding stats land in `game_fielding` and `fielding_stats`. Coverage:
- **D1 / D2 / D3 / NAIA (Sidearm)**: full coverage. The Sidearm API ships a `fielding` sub-object per player with putouts / assists / errors / DPs / TPs / passed_balls / SBA / CS / pickoffs / CI. `_parse_sidearm_api_response` in `scripts/scrape_boxscores.py` writes one `game_fielding` row per (player, position). Aggregation happens via `scripts/aggregate_fielding.py` (wired into `daily_update.sh`).
- **NWAC (Presto)**: NO fielding data. Presto box-score HTML exposes only Batting and Pitching tables; team season-stats pages don't expose fielding either. NWAC players show no fielding card on their profile (graceful empty). If NWAC ever adds it, the schema is ready.

For multi-position games (a single player playing SS for 7 innings and RF for 2 in the same game), the Sidearm JSON `position` collapses to the player's primary position, so the secondary-position fielding numbers blend into the primary row. This is rare in college baseball. A future Phase 2 can parse the HTML Fielding table for true per-position accuracy.

---

## 11. PBP (Play-by-Play) System

Shipped in phases April 24-25, 2026. Currently a major differentiator.

| Phase | What it adds |
|---|---|
| **Phase 0** | HR-allowed parser (closed the HR gap in Sidearm pitching tables) |
| **Phase 1** | `game_events` table, per-PA event extraction, 45k+ events backfilled |
| **Phase 2** | NWAC + Presto support via ScraperAPI / GH Actions |
| **Phase A** | Base/out/score state on every event + sub-events (steals, WP, PB, balks) |
| **Phase B/C/D** | 0-0 BIP%, putaway%, situational splits (RISP, late-and-close, by inning), Leverage Index |
| **Phase E** | Batted-ball type (GB/FB/LD/PU) + field zone + Pull/Center/Oppo classification |

Key files:
- `scripts/scrape_pbp.py` — the scraper
- `scripts/classify_batted_ball.py` — bb_type and field zone classifier
- `scripts/derive_event_state.py` — base/out/score derivation
- `scripts/derive_batted_ball.py` — bb_type backfill driver
- `scripts/compute_wpa.py` — WPA computation (run after any PBP re-scrape)
- API endpoints: `/players/{id}/pitch-level-stats` and `/players/{id}/pitch-level-stats-pitcher`
- Frontend: `PitchLevelStatsCard.jsx`, `PitcherPitchLevelStatsCard.jsx`, `SprayChart.jsx`, `PercentileBars.jsx`

Coverage on 2026 season: ~89% bb_type, ~85% field zone. Remaining gap is scorer omission (can't recover without source data).

---

## 12. Player Page Architecture (Phases F-T, 2026-04-24/25)

The player profile page (`frontend/src/pages/PlayerDetail.jsx`) is the most heavily designed surface on the site. Key elements:

- Two-column layout (bars on left, scrollable column on right)
- `PercentileBars` with savant-style 2026 metric set (`BATTING_PERCENTILE_METRICS_2026`, `PITCHING_PERCENTILE_METRICS_2026`)
- `SprayChart` (10-zone fan rendering)
- `PitchLevelStatsCard` with color-coded `ColorTile` and `LeverageTile`
- `ScrollColumn` with bottom fade + pulsing chevron hint
- `SeasonGlance` and `RecentGames` compact cards in right column
- `TeamAwards` and `PositionPieChart` for context

**Default-season logic:** When no query param, backend computes `max(season)` across BOTH batting and pitching lists, then only renders the side that has data for that season. For two-way players whose position is "P", the frontend renders pitching bars first. Don't revert to per-side `[-1]` defaults — that was the Saelens bug (defaulted to wrong year).

**Career button SQL gotcha:** Postgres rejects column aliases in HAVING. Use full expressions (e.g. `HAVING COUNT(DISTINCT bs.season) >= 2 AND SUM(bs.plate_appearances) >= 100`), not aliases.

---

## 13. The GM Dynasty Game (Separate Feature)

A general-manager / dynasty simulation game lives in the same repo but is a completely separate product.

**Where:**
- `frontend/src/gm/engine/` — game logic (schedule, coaches, recruits, summer ball, injuries, etc.)
- `frontend/src/pages/gm/` — page components (Dashboard, Roster, Schedule, Budget, Coaches, Recruiting, Calendar, SummerBall, WeeklyActions, Play, DepthChart, etc.)

**Access:** Gated by `GM_EARLY_ACCESS_EMAILS` allowlist in `App.jsx`. Public users never see it.

**Development home:** Claude Code (this `/gm/*` work happens there, not in Cowork).

If you're working on the stats site and an edit touches a GM file, back out — wrong product. If Nate brings up "dynasty", "recruiting class", "coach hires", "prospect camp", "Dashboard.jsx", etc., that's the GM game.

---

## 14. Recent Major Work (Timeline)

Reverse-chronological highlights so you can ramp on what's recent:

- **2026-05-15** — NWAC playoff scraper fixes. Strip seed prefixes (`E4`, `N3`, etc.), strip `vs.`/`at.` location indicators, filter TBD opponent rows like `"W4 Clark/S3 Umpqua"`. Files: `scrape_future_schedules.py`, `scrape_nwac_schedule.py`.
- **2026-05-15** — Repaired 3 Seattle U @ Pacific games (March 20-22) that had been resolved to D3 Pacific instead of D1 Pacific. Cleared one bad name-fallback player link.
- **2026-05-04** — Phantom player cleanup. 127 of 198 PNW phantoms resolved (66 orphan deletes + 59 auto-merges + 2 manual). Anti-recurrence added: scrapers track player_ids written each run and prune rows for that team-season that aren't in the new scrape.
- **2026-05-04** — Nuxt `-1` sentinel filter added to `scrape_d1.py`. Fixes Oregon St. position players landing in pitching_stats.
- **2026-04-25** — PBP Phase E shipped: batted-ball type + field zone + spray classification. 89% bb_type / 85% zone coverage on 2026.
- **2026-04-25** — Player page redesign Phases F-T. Spray chart, pitch-level cards, savant 2026 metrics, compact 2-column layout, ScrollColumn affordance.
- **2026-04-25** — PBP Phase 2: NWAC + Presto via ScraperAPI / GH Actions. 100% batter ID resolution on NWAC.
- **2026-04-24** — PBP Phase A through D: state derivation, sub-events, situational splits, Leverage Index.
- **2026-04-24** — PBP Phase 1: `game_events` table, full per-PA extraction, 45,294 events from 581 games backfilled.
- **2026-04-20** — Shared `team_matching.py` module shipped (commit 6d3c2f0). All box-score scrapers consolidated onto one resolver. Cleanup deleted 255+77 ghost batting rows and 52+12 ghost pitching rows.
- **April 2026 ongoing** — Per-conference playoff freeze system: tables `*_frozen`, `conference_freezes`, endpoint, `freeze_conference.py` CLI command, banner wiring.

---

## 15. How to Verify Before Recommending

Before suggesting any command or change:

1. **Confirm the import path.** `from app.models.database import get_connection` is the only correct DB import. Many memorized paths from older code are wrong (`app.db`, `app.utils.war_calculator`, etc. do NOT exist).
2. **Confirm the script exists.** Don't reference archived scripts. `link_transfers_pg.py` was archived. `fix_link_chains.py` was archived. `recalculate_war.py` was archived.
3. **Confirm the path.** Server project root is `/opt/pnw-baseball`, NOT `/root/pnw-baseball`, NOT `/var/www/pnw-baseball`.
4. **Confirm the service name.** Systemd service is `nwbb`, NOT `pnw-baseball` or `pnw-baseball-api`.
5. **Confirm the working directory.** Read the terminal prompt before suggesting `cd` commands. If Nate's prompt shows `naterasmussen@Mac frontend %`, he's already in `frontend/`.
6. **Confirm whether the change needs server vs Vercel.** Frontend-only → `git push` is enough (Vercel handles it). Backend → SSH and pull + `systemctl restart nwbb`.

---

## 16. Common Tasks Cheat Sheet

### "I changed a frontend file, how do I deploy?"

```bash
git add . && git commit -m "..." && git push origin main
# Wait ~60s. Vercel auto-deploys.
```

### "I changed a backend file (or scraper), how do I deploy?"

```bash
# Mac
git add . && git commit -m "..." && git push origin main

# Server
ssh root@137.184.181.113
cd /opt/pnw-baseball && git pull origin main
sudo systemctl restart nwbb
```

### "I changed both frontend and backend"

Mac push as above. On server:
```bash
cd /opt/pnw-baseball && git pull origin main
cd frontend && npm run build && cd ..
sudo systemctl restart nwbb
```

Vercel will also deploy the frontend, so users may briefly see two different versions during the transition.

### "Why is `vs. E4 Yakima Valley` showing as a separate team?"

NWAC playoff seed prefixes. `clean_opponent_name()` in `scrape_future_schedules.py` strips them. If you see this on the live site, the JSON wasn't regenerated after a scraper update. Re-run the scraper on the server.

### "Why is Seattle U showing D3 Pacific as their opponent?"

The team_matching resolver picks the correct Pacific now. If old data is wrong, manually fix via SQL: update `games.home_team_id` / `away_team_id` from 17 to 32857 and the corresponding `game_batting` / `game_pitching` rows.

### "How do I add a new alias for a school name we keep seeing wrong?"

Edit `_TEAM_ALIASES` in `scripts/team_matching.py`. Keys are lowercase. Values are the canonical `short_name`. All scrapers benefit instantly.

---

## 17. Memory / Context This Doc Doesn't Cover

If you need deeper history on a specific subsystem, the original session memory has detailed entries on:

- Box scoring HTML parsers (Sidearm v2/v3/legacy)
- Records / standings scraper team-name matching
- Headshot backfill system (`backfill_headshots.py` + `download_headshots.py`)
- Summer ball scraping (WCL/PIL/CCL)
- Social media automation plan
- Series recap graphic generator
- Recruiting guide research and methodology
- Monetization tier plan (4 tiers from free anonymous to paid recruiting)
- Future feature roadmap (alumni tracker, projections, articles, etc.)

Ask Nate, or read the corresponding source file, before designing around any of these.

---

## 18. Contact / Hand-off

- **Live site:** https://nwbaseballstats.com
- **Server:** 137.184.181.113 (SSH as root, password auth)
- **GitHub:** rasmussenbaseball/pnw-baseball
- **Owner:** Nate Rasmussen, nate.rasmussen26@gmail.com

When in doubt, ask Nate before changing anything load-bearing. He prefers one step at a time and clear Mac-vs-server instructions.
