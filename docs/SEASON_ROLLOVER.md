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

What follows on its own after the bump (added Nov 2026, nothing to edit):
- The homepage "Last results" strip mounts itself while CURRENT_SEASON is in
  progress and hides once June is over (`isSeasonFinal()` in seasons.js).
- `STATS_SEASON` (frontend `seasons.js`) / `stats_season()` (backend
  `config.py`) keep the homepage awards and ratings, every coach scouting
  tool (Series Planner, scouting/bullpen sheets, pocket cards, alignments,
  splits, lineup helper, ...) and the Series Planner data file on 2026 until
  March 15, 2027, then switch to 2027 by themselves. Award copy says "so far"
  until July 1 and "final" / "of the year" after.
- `generate_series_planner.py` refuses to overwrite the plan file with fewer
  than 30 teams of data, so the first 2027 daily run cannot blank it.
- The JUCO / transfer-portal trackers keep last season's stats until the new
  season has 60% as many batting rows as the old one.
- The team page Returning tab defaults to the last COMPLETED season
  (`LAST_COMPLETED_SEASON`), Identity to `STATS_SEASON`.

### 1b. The offseason gate lifts on its own once step 1 is done

`daily_update.sh`, live scores and the morning box-score rescrape skip
themselves outside Jan 15 to Jun 30 of the scrape season
(`season_utils.in_scrape_window()`, added 2026-11-22). Until CURRENT_SEASON is
bumped to 2027 they keep saying "Offseason ... skipping" in
`/var/log/nwbb-scrape.log`, so step 1 is what turns them back on. Any manual
run can pass `--force`.

### 1c. ScraperAPI budget for the NWAC season [decide before step 2]

NWAC blocks the server and GitHub runners, so every NWAC page costs
ScraperAPI credits. The account is on the 1,000-credit monthly plan, which
cannot carry an NWAC season. Estimated in-season use with today's schedules
and the new client (standard proxy first, premium only when blocked):

| Job | Credits / month |
|---|---|
| `nwac-stats.yml` daily (about 27 teams x 3 pages) | ~2,500 |
| Future schedules, NWAC team pages, 4 runs a day | ~3,200 |
| `nwac-boxscores.yml` (new games + 2-day rescrape) | ~550 |
| `nwac-schedule.yml` 8 runs a day | ~480 |
| `nwac-pbp.yml` (was ~1,600 when every game paid premium) | ~160 |
| Total | ~7,000 |

Pick one before re-enabling the NWAC workflows:
- Upgrade ScraperAPI for February through May only (the next plan up is far
  above 7,000 credits), then drop back to the free plan in June.
- Run the NWAC jobs from a home connection instead (NWAC loads fine from a
  residential IP, verified 2026-11-22), which costs nothing but needs a
  machine that is on at the scheduled times.
- Cut frequency to fit 1,000 (stats weekly, schedule twice a day, future
  schedules once a day). NWAC pages would update days late.

Every workflow carries a `SCRAPERAPI_RUN_BUDGET` cap, and the client stops
paying when the account nears zero, so a bad month degrades to stale NWAC
data instead of a pile of failed requests. Usage per run is logged in
`/var/log/nwbb-scraperapi.log` (server) or the Actions log (`[scraperapi]`).

### 1d. Restore the server's scrape cron jobs [Server]

All automated scraping was paused on 2026-11-22 (Nate: nothing needs to run
until spring). The server crontab lines are commented out with the prefix
`# PAUSED 2026-11-22 (no scraping until spring): `. To restore them:

```bash
# [Server]
crontab -l > /root/crontab.backup-before-restore
crontab -l | sed "s/^# PAUSED 2026-11-22 (no scraping until spring): //" | crontab -
crontab -l | grep -vE "^#|^$"      # daily_update, live scores, dedup, pbp, boxscores are back
```

Also uncomment the `schedule:` block in `.github/workflows/wcl-daily.yml`
before June. Still running on purpose: the weekly recruit scrape (Mon 8 AM PT,
direct fetches only, `SCRAPERAPI_DISABLED=1` so it can never spend credits),
the daily Rapsodo model refresh, and the GitHub projections workflow (neither
of those scrapes anything).

### 2. Turn the paused scrapers back on [Mac]

- `scripts/daily_update.sh`: uncomment the blocks marked
  `Spring rollover: uncomment when 2027 games start` (D2 / D3 / NAIA season
  stats, the D2 / D3 / NAIA box-score lines, and the future-schedules step).
- `.github/workflows/nwac-schedule.yml`, `nwac-boxscores.yml`,
  `nwac-pbp.yml`, `nwac-stats.yml`: uncomment each `schedule:` block. The
  season year inside them follows CURRENT_SEASON (via season_utils), so the
  step 1 bump is all they need.
- Decide: should the 2027 projections freeze at opening day?
  `.github/workflows/projections.yml` re-runs Mon/Wed/Fri and rewrites the
  2027 rows each time. Comment out its `schedule:` block to freeze them.
- `.github/workflows/wcl-daily.yml` needs nothing: it skips itself outside
  May through August.

### 3. NWAC tournament data (only once the bracket is announced, usually
May) [Mac]

These are real-event literals and are meant to be edited by hand:

- `backend/app/stats/projections.py`: add the new year to
  `NWAC_CHAMP_FIELDS` (`2027: {1: team_id, ... 8: team_id}`); the NWAC
  tournament sheet (`/portal/nwac-tournament-sheet`) reads it and shows
  "field not set" for any year without an entry. (The old championship-odds
  and MVP-tracker endpoints were removed in Nov 2026; nothing on the site
  called them.)
- `frontend/src/lib/brackets.js`: the `TOURNAMENTS` entries (dates, seeds).
  The bracket graphic opens on the FIRST entry, so put the new year first.

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
  - Prepend 2027 to `SUMMER_SEASONS` in `frontend/src/lib/seasons.js` (the
    WCL graphics' season picker). The WCL graphic pages read SUMMER_SEASON,
    so they need nothing else.
- Once the spring rosters are final, regenerate `FRESHMAN_ROSTERED` in
  `backend/app/api/recruiting.py` (`scripts/archive/count_rostered_freshmen.py`) and
  add the 2027 entry; the Recruiting Tips freshman study reads the last
  completed season from July 1.

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

## Server housekeeping found in the Sept 2026 audit (one-time, root on the server)

DONE 2026-11-22: logrotate installed (also covers the new recruits and
ScraperAPI logs), the three `--season 2026` crontab flags removed (backup at
`/root/crontab.backup-2026-11-22`), and the weekly recruit scrape moved from
GitHub Actions to the server crontab (Mon 8 AM PT). Kept below for reference.

- Log rotation: the live-score log was 112 MB with no rotation. Install once:
  `cp /opt/pnw-baseball/deploy/logrotate-nwbb /etc/logrotate.d/nwbb` (then
  `logrotate -d /etc/logrotate.d/nwbb` as a dry run).
- The crontab still passes `--season 2026` on three lines (live scores twice,
  the morning box-score rescrape). Drop that flag so they follow CURRENT_SEASON:
  `crontab -l > /root/crontab.backup && crontab -l | sed "s/ --season 2026//" | crontab -`
- League adjustments (wRC+, FIP+, WAR, park factors) are written ONLY by
  `recalculate_league_adjusted.py`, which runs from `.github/workflows/nwac-stats.yml`
  (deliberately not from daily_update.sh: it would race the NWAC job). That
  workflow's schedule is commented out for the offseason. Re-enable it with the
  other NWAC workflows at season start or every advanced stat stays unadjusted.
- `daily_update.sh` now exits non-zero and lists the failed steps when any
  scraper fails (it used to report success no matter what). Check
  `/var/log/nwbb-scrape.log` for "FAILED" after the first few runs of a season.
