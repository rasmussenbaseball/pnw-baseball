# Scripts Directory

Classification of every script in this folder so future-you knows what runs, when, and why.

If a script is not listed here, it belongs in `scripts/archive/` (one-time fixes, diagnostics, or deprecated code).

---

## Production cron (server, chained through `daily_update.sh`)

These run nightly on the DigitalOcean droplet. They are the steady-state data pipeline. Do not rename or delete without also editing `daily_update.sh`.

| Script | Purpose |
| --- | --- |
| `scrape_d1.py` | D1 season stats (Pac-12 / WCC PNW teams). |
| `scrape_d2.py` | D2 season stats (GNAC). |
| `scrape_d3.py` | D3 season stats (NWC). |
| `scrape_naia.py` | NAIA season stats (CCC). |
| `scrape_boxscores.py` | Game-by-game batting/pitching lines from schedule pages. |
| `update_positions.py` | Updates player positions from box-score game logs. |
| `scrape_records.py` | Team records and conference standings. |
| `scrape_national_ratings.py` | Pear Ratings + CBR rankings for cross-division comparison. |
| `scrape_future_schedules.py` | Remaining schedule data used by playoff projections. |
| `backfill_player_ids.py` | Matches `game_batting` / `game_pitching` rows to `player_id`. Runs after box scores. |
| `daily_update.sh` | Orchestrator. Runs all of the above in order with a flock lockfile for concurrency safety. |

`recalculate_league_adjusted.py` is **NOT** called from `daily_update.sh` anymore — it is owned by the GitHub Actions workflow at `.github/workflows/nwac-stats.yml` which runs after NWAC + Willamette + Seattle U scraping completes. See memory `feedback_war_oscillation_fix.md` for rationale.

## Separate cron jobs (server, independent schedule)

| Script | Schedule | Purpose |
| --- | --- | --- |
| `dedup_games.py` | 2 AM Pacific daily | Merges duplicate `games` rows created by home/away scraping overlap. |
| `scrape_live_scores.py` | Every few minutes in-season | Pulls in-progress game scores and writes `backend/data/live_scores.json`. |
| `scrape_nwac_boxscores.py` | After NWAC scrape | Parses NWAC box scores from XML feeds. See `project_nwac_boxscores.md`. |

## GitHub Actions (runs in CI, not on the server)

| Script | Purpose |
| --- | --- |
| `scrape_nwac.py` | NWAC season stats. Must run through ScraperAPI to bypass WAF. See `feedback_nwac_scraper_api.md`. Also scrapes Willamette + Seattle U. |
| `scrape_nwac_schedule.py` | NWAC game schedules and results. Also used by Actions. |

## Shell orchestration helpers

| Script | Purpose |
| --- | --- |
| `scrape_historical.sh` | Runs all scrapers for a past season (manual, one season at a time). |
| `setup_persistent_logos.sh` | Configures `/opt/headshots/` and `/opt/logos/` persistent mounts on the server. |
| `download_summer_logos.sh` | Fetches summer-ball team logos. |

## Imported utility modules (not standalone)

These are `import`ed by other scripts. They do nothing on their own.

| Module | Used by |
| --- | --- |
| `team_matching.py` | All box-score scrapers for name-to-team-id resolution. See `project_team_matching_module.md`. |
| `record_utils.py` | `scrape_records.py`. |
| `fix_pitching_hbp_from_boxscores.py` | Imported by `scrape_nwac.py` to patch HBP columns Sidearm omits. Do NOT delete. |
| `parse_nwac_boxscore.py` | Imported by `scrape_nwac_boxscores.py`. XML parser for NWAC feeds. |

## Manual backfills (run ad-hoc, keep in scripts/)

These are not on any cron, but they are kept in the main `scripts/` folder because they get re-run when rosters change, schemes change, or data issues show up.

| Script | When to run |
| --- | --- |
| `backfill_headshots.py` | Start of season when rosters update. Run from Mac. |
| `download_headshots.py` | After `backfill_headshots.py` to pull the files. Run from Mac. |
| `backfill_roster_coaching.py` | When a school updates its coaching staff or roster history. |
| `backfill_team_records.py` | When team records are missing or drift from the true standings. |
| `backfill_team_ids.py` | When box scores have NULL team_ids after a scrape. |
| `backfill_game_team_ids.py` | When `games.home_team_id` / `games.away_team_id` drift. |
| `backfill_self_play_games.py` | Fixes games where a team plays itself in the raw data. |
| `backfill_sidearm_boxscores.py` | Re-pulls Sidearm box scores for a date range. |
| `backfill_wmt_boxscores.py` | Re-pulls Willamette box scores for a date range. |
| `recover_nwac_batting.py` | NWAC-specific batting recovery after scraper regression. |
| `resync_pitching_stats_from_boxscores.py` | Rebuilds `pitching_stats` aggregates from `game_pitching`. |
| `retry_missing_boxscores.py` | Re-scrapes box scores flagged as incomplete. |
| `fix_home_away.py` | Repairs team_id flip bugs. See `project_home_away_flip_bug.md`. |
| `fix_orphan_batting.py` | Removes `game_batting` rows with no parent game. |
| `fix_team_scheme.py` | Fixes Sidearm schema drift (http vs https, subdomain changes). |
| `dedup_game_batting.py` | Removes duplicate `game_batting` rows. Read `feedback_player_matcher_fallback.md` first. |
| `dedup_game_pitching.py` | Same as above for `game_pitching`. |
| `force_rescrape_one_game.py` | Re-pulls a single game by `game_id`. |
| `link_transfers.py` | Links transfer players across programs. |
| `add_roster_year.py` | Adds current season's roster_year column to players. |
| `update_commitments.py` | Refreshes verbal commitments table. |
| `verify_opponent_trends.py` | Sanity check for the opponent trends page. |
| `wipe_team_batting.py` | Nukes a single team's batting aggregates before re-running. Use with care. |

## Historical / one-time scrapers

Used for backfilling old seasons. Not part of the normal cycle.

| Script | Purpose |
| --- | --- |
| `scrape_summer.py` | Summer ball leagues (one-time backfills, see `project_summer_scraper_progress.md`). |
| `scrape_nwac_historical.py` | NWAC past seasons. |
| `compute_summer_advanced.py` | Advanced metrics for summer ball. |

## Social / generated assets

| Script | Purpose |
| --- | --- |
| `generate_social_graphic.py` | Produces weekly recap graphics. See `project_series_recap.md` + `project_social_media.md`. |

---

## Archive folder

`scripts/archive/` holds deprecated scripts, diagnostics, and one-time migrations. Don't run anything from there without checking git history first. The most important "DO NOT RUN" file is `archive/DEPRECATED_recalculate_war.py` — it uses hardcoded league averages and will clobber correct WAR values.
