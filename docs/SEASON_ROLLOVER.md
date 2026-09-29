# Season Rollover Checklist

What still has to be done BY HAND when a new season starts. Everything not
listed here rolls over on its own (see "What is automatic now" at the bottom).

Terminal labels: **[Mac]** = run in a Terminal on your Mac inside
`~/code/pnw-baseball`. **[Server]** = run after `ssh root@137.184.181.113`
and `cd /opt/pnw-baseball`.

---

## A. Start of the spring season (late Jan / early Feb 2027)

Do these in order. Steps 1 to 3 are file edits on the Mac, step 4 deploys.

### 1. Bump the two CURRENT_SEASON constants [Mac]

- `backend/app/config.py`: `CURRENT_SEASON = 2026` -> `2027`
  (NEXT_SEASON follows automatically; leave PORTAL_SEASON alone here, see C).
- `frontend/src/lib/seasons.js`: `CURRENT_SEASON = 2026` -> `2027`, and
  prepend 2027 to `SEASONS` (`[2027, 2026, 2025, ...]`). Add 2027 to
  `PBP_SEASONS` once play-by-play is being scraped for it.
- `TRACKER_SEASONS` in the same file lists past years by hand
  (`[2026, 2025, 2024]`); add 2026 there if it is missing.

### 2. Turn the paused scrapers back on [Mac]

- `scripts/daily_update.sh`: uncomment the blocks marked
  `Spring rollover: uncomment when 2027 games start` (D2 / D3 / NAIA season
  stats, the D2 / D3 / NAIA box-score lines, and the future-schedules step).
- `.github/workflows/nwac-schedule.yml`, `nwac-boxscores.yml`,
  `nwac-pbp.yml`, `nwac-stats.yml`: uncomment each `schedule:` block. The
  season year inside them is already date-derived; nothing else to edit.
- `.github/workflows/wcl-daily.yml` needs nothing: it skips itself outside
  May through August.

### 3. NWAC tournament data (only once the bracket is announced, usually
May) [Mac]

These are real-event literals and are meant to be edited by hand:

- `backend/app/api/routes.py` around lines 3392 and 3473: the tournament
  date window (`'2026-05-21'` to `'2026-05-26'`).
- `backend/app/stats/projections.py`: `NWAC_2026_CHAMP_SEEDS`,
  `NWAC_2026_CHAMP_HOST_ID`, `NWAC_2026_CHAMP_GRAPH` (seeds, host, game graph).
- `frontend/src/lib/brackets.js`: the `TOURNAMENTS` entries (dates, seeds).

### 4. Deploy [Mac then Server]

```bash
# [Mac]
git add -A && git commit -m "Season rollover: 2027" && git push origin main

# [Server]
ssh root@137.184.181.113
cd /opt/pnw-baseball && git pull origin main
cd frontend && npm run build && cd ..
sudo systemctl restart nwbb
```

### 5. Health checks [Server, then any browser]

```bash
# [Server] service is up
systemctl status nwbb --no-pager | head -5

# [Server] one manual daily run to confirm the season it picked
bash scripts/daily_update.sh            # header line prints "Season 2027"

# [Mac or Server] what the scripts think the season is
PYTHONPATH=backend python3 scripts/season_utils.py
```

Then open https://nwbaseballstats.com and confirm the season selector
defaults to 2027, and `https://nwbaseballstats.com/api/v1/teams` returns
JSON (a quick "is the API alive" URL; there is no dedicated health endpoint).

Note on trackers: the transfer-portal / WCL-portal / JUCO trackers remember
the last season you picked in the browser's sessionStorage. If a tracker
looks "stuck" on an old year after a rollover, close the tab and reopen it
(or clear site data); it is not a server bug.

---

## B. Summer (when the WCL starts, early June)

- The WCL scrapers and the `wcl-daily.yml` workflow use the calendar year
  automatically (`summer_season()`), and the workflow un-pauses itself in May.
- Bump `SUMMER_SEASON` in BOTH layers once the new WCL season has enough
  games to show (it points at the most recent summer WITH DATA on purpose,
  so do not bump it on opening day):
  - `backend/app/config.py`: `SUMMER_SEASON = 2026` -> `2027`
  - `frontend/src/lib/seasons.js`: `SUMMER_SEASON = 2026` -> `2027`
  - Two graphic pages still carry their own literal
    (`CURRENT_SUMMER_SEASON` in `frontend/src/pages/WclStandingsGraphic.jsx`
    and `WclLeaderboardGraphic.jsx`); bump those too, or point them at
    `SUMMER_SEASON` from `lib/seasons.js`.

---

## C. Each fall (once the summer transfer portal closes, ~September)

Bump `PORTAL_SEASON` in BOTH layers, by one:

- `backend/app/config.py`
- `frontend/src/lib/seasons.js`

Why: PORTAL_SEASON is the transfer cycle that is currently OPEN. The
trackers (transfer portal, WCL portal, JUCO) default to it, a player added
to a portal today belongs to it, and a commitment made today is for
PORTAL_SEASON + 1 unless the editor picks another year. It runs one year
AHEAD of CURRENT_SEASON in the offseason (fall 2026: CURRENT 2026, PORTAL
2027) and catches up when the spring season starts. It is deliberately not
date-derived because the "open cycle" moment is a judgment call.

---

## What is automatic now (do not hand-edit these)

- `scripts/season_utils.py` gives every scraper its default season:
  `scrape_season()` = the site's `CURRENT_SEASON` (read from
  `backend/app/config.py`, so the server cron and GitHub Actions agree with
  the site). Bumping that one constant moves the scrapers and the site
  together. It is deliberately not a calendar rule: a Sept 1 flip would
  point every cron job at an empty new season while the site still shows
  the finished one. `summer_season()` = calendar year (WCL only).
  `upcoming_season()` = calendar rule (next year from September), used only
  by the weekly recruits job for the HS class being recruited.
  `presto_season_str(2027)` = `"2026-27"` for NWAC / PrestoSports URLs.
- Every `--season` default in `scripts/`, the `SEASON = ...` constants, and
  `scripts/daily_update.sh` (which also accepts `--season YEAR`).
- The GitHub workflows compute their season the same way; the dispatch
  `season` input overrides it for backfills (`nwac-*.yml`, `wcl-daily.yml`,
  `recruits.yml` grad year).
- Seattle U's WMT team id: `scripts/wmt_utils.py` looks up a new season's id
  from the WMT API when it is not in the known map, so Seattle U is no
  longer silently skipped in a new season.

Gotcha to remember: nothing flips on its own. Until `CURRENT_SEASON` is
bumped to 2027, every no-argument script and cron job keeps targeting 2026.
Pass `--season 2027` explicitly for early 2027 work (rosters, future
schedules) before the bump.
