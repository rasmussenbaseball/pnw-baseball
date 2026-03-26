# PNW Baseball Analytics Dashboard — Project Status

**Last updated:** 2026-03-25

## Architecture
- **Backend:** FastAPI + SQLite (`backend/app/api/routes.py`, DB at `backend/data/pnw_baseball.db`)
- **Frontend:** React + Vite + Tailwind (`frontend/src/`), runs on localhost:3001, proxies API to localhost:8000
- **Scrapers:** Python scripts in `scripts/` — one per division level (D1, D2, D3, NAIA, NWAC)
- **Advanced stats:** `backend/app/stats/advanced.py` — wOBA, wRC+, FIP, xFIP, SIERA, WAR calculations with `division_level` param

## How to Run
```bash
# Backend
cd pnw-baseball
PYTHONPATH=backend uvicorn app.main:app --reload --port 8000

# Frontend
cd frontend && npm run dev

# Scrapers (each division)
PYTHONPATH=backend python3 scripts/scrape_d1.py --season 2026
PYTHONPATH=backend python3 scripts/scrape_d2.py --season 2026
PYTHONPATH=backend python3 scripts/scrape_d3.py --season 2026
PYTHONPATH=backend python3 scripts/scrape_naia.py --season 2026
PYTHONPATH=backend python3 scripts/scrape_nwac.py --season 2026
```

## Division/Team Coverage
- **D1 (7 teams):** UW, Oregon, Oregon St., Wash. St., Gonzaga, Portland, Seattle U
- **D2 (5 teams):** CWU, MSUB, NNU, SMU, WOU
- **D3 (9 teams):** GFU, L&C, Linfield, PLU, Pacific, UPS, Whitman, Whitworth, Willamette
- **NAIA (8 teams):** Various PNW NAIA programs
- **NWAC/JUCO (28 teams):** Community college programs

## D1 Scraper Technical Details (`scripts/scrape_d1.py`)

### Sidearm Sports Platforms
Most D1 sites use Sidearm Sports. There are two generations:
1. **Older Sidearm** (Gonzaga, Portland): Server-rendered HTML stat tables. Standard `<table>` parsing works.
2. **Newer Sidearm / Nuxt 3** (UW, Oregon, Oregon St., Wash. St.): Stats are client-side rendered. Data is embedded in a `<script id="__NUXT_DATA__">` tag as a flat JSON array using "devalue" serialization where values reference other array indices.

### Nuxt Payload Parsing
The scraper has `parse_nuxt_pitching(html)` and `parse_nuxt_batting(html)` functions that:
- Find `<script id="__NUXT_DATA__">` and parse the JSON array
- Locate objects with `playerName` + `earnedRunAverage` (pitching) or `playerName` + `battingAverage` + `atBats` (batting)
- Resolve devalue references via `_nuxt_resolve()` which handles ShallowReactive/Reactive/ShallowRef wrappers
- Deduplicate by taking first occurrence of each player name (Overall stats, not Conference)
- Map camelCase keys to standard abbreviations (e.g., `earnedRunAverage` → `ERA`)

### Column Header Normalization
Newer Sidearm HTML tables return **lowercase** column headers (`r`, `h`, `bb`, `so`, `hr`, etc.) but older ones use uppercase. The scraper normalizes all header keys to UPPERCASE in `parse_sidearm_table()` after parsing, keeping `Player`, `#`, `player_url`, and `sidearm_player_id` as special cases.

### Seattle U — STILL BROKEN
- URL: `goseattleu.com`
- The stats page `/sports/baseball/stats` returns 200 but has **0 HTML tables** AND the Nuxt payload parser finds **0 batting/pitching objects**
- The site might use a completely different platform or a different Nuxt payload structure
- The roster JSON endpoint (`/services/responsive-roster.ashx`) returns 404
- **Needs investigation:** Try fetching the page in a browser, inspect what platform it uses, check if stats are loaded via a separate AJAX call, or if the Nuxt data structure differs

## Frontend Pages

| Route | File | Description |
|-------|------|-------------|
| `/` | `BattingLeaderboard.jsx` | Batting stat leaders with filters |
| `/pitching` | `PitchingLeaderboard.jsx` | Pitching stat leaders with filters |
| `/war` | `WarLeaderboard.jsx` | WAR leaderboard with WAR/PA, WAR/IP, pitching stats, sortable columns |
| `/teams` | `TeamsPage.jsx` | Teams overview grouped by conference |
| `/team/:teamId` | `TeamDetail.jsx` | Individual team batting/pitching tables |
| `/compare` | `TeamComparison.jsx` | Side-by-side team comparison (2-6 teams) |
| `/scatter` | `ScatterPlot.jsx` | SVG scatter plot — pick 2 stats, see all teams plotted |
| `/players` | `PlayerSearch.jsx` | Player search |
| `/player/:playerId` | `PlayerDetail.jsx` | Individual player profile |
| `/juco-tracker` | `JucoTracker.jsx` | JUCO/uncommitted player tracker |

## API Endpoints

### New endpoints (added this session)
- `GET /api/v1/teams/compare?season=2026&team_ids=1,2,3` — Aggregate batting/pitching stats per team
- `GET /api/v1/teams/scatter?season=2026&x_stat=team_avg&y_stat=team_era&division_id=1` — Team scatter plot data
- `GET /api/v1/league-environments?season=2026` — Runs/game and league averages per division level

### Route ordering note
`/teams/compare` and `/teams/scatter` MUST be declared before `/teams/{team_id}` in routes.py, otherwise FastAPI tries to parse "compare" as an int team_id.

## WAR Leaderboard Features
- Shows both batting and pitching stats in one table
- WAR/PA and WAR/IP rate stats (blue accent)
- Min PA and Min IP filters
- All columns sortable (click header to sort, click again to reverse)
- `LOWER_IS_BETTER` set for ERA, WHIP, FIP (sort ascending = better)
- Pitching stats: IP, ERA, FIP, WHIP, K/9, W-L

## League Run Environment Data (sample from current DB)
Note: D1 numbers will be wrong until Seattle U is fixed and scraper re-run with corrected data.
- D2: ~5.1 R/G, .285 AVG
- D3: ~5.8 R/G, .284 AVG
- NAIA: ~5.2 R/G, .290 AVG
- JUCO: ~4.3 R/G, .242 AVG

## Known Issues / TODO

### Immediate
1. **Seattle U stats not scraping** — The page loads but contains no parseable stats data. Needs browser inspection to determine what platform/data format Seattle U uses.

### Future Features Discussed
1. **League-adjusted wRC+ and FIP+** — Use the league run environments to compute cross-level comparison stats. The `/league-environments` endpoint provides the raw data; the advanced.py module needs to be updated to accept league-specific run values rather than hardcoded constants.
2. **Cross-level comparison advanced stats** — Any other metrics that normalize for league difficulty.
3. **General polish** — The team comparison and scatter plot pages are functional but could benefit from refinements based on user feedback.

## Key Files Modified This Session
- `scripts/scrape_d1.py` — Column header normalization, Nuxt payload parsers, Seattle U URL handling
- `backend/app/api/routes.py` — Added /teams/compare, /teams/scatter, /league-environments endpoints; route reordering
- `frontend/src/pages/TeamComparison.jsx` — NEW: team comparison page
- `frontend/src/pages/ScatterPlot.jsx` — NEW: scatter plot page
- `frontend/src/pages/WarLeaderboard.jsx` — Added WAR/PA, WAR/IP, pitching stats, sortable columns
- `frontend/src/components/FilterBar.jsx` — Added Min IP filter for WAR view
- `frontend/src/components/Header.jsx` — Added Compare and Scatter nav items
- `frontend/src/App.jsx` — Added routes for /compare and /scatter
