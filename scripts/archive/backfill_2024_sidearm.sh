#!/usr/bin/env bash
# One-time 2024 Sidearm backfill (D1/D2/D3/NAIA): rosters + schedules +
# season stats + box scores + play-by-play + PBP derivations + fielding.
# NWAC (JUCO) is intentionally excluded here — its AWS WAF blocks the
# server, so it runs separately via GitHub Actions.
#
# Run detached on the server:
#   nohup nice -n 15 bash scripts/backfill_2024_sidearm.sh > /tmp/bf2024.log 2>&1 &
#
# No `set -e`: the scrapers handle per-team errors internally, and one
# team failing should not abort the whole season backfill.

SEASON=2024
cd /opt/pnw-baseball || exit 1
export PYTHONPATH=backend

banner() { echo; echo "============================================================"; echo ">>> $(date '+%Y-%m-%d %H:%M:%S')  $*"; echo "============================================================"; }
run()    { echo "+ $*"; python3 "$@"; echo "  (exit $?)"; }

banner "STAGE 1/7 — rosters + schedules + season stats (D1/D2/D3/NAIA)"
run scripts/scrape_d1.py   --season $SEASON
run scripts/scrape_d2.py   --season $SEASON
run scripts/scrape_d3.py   --season $SEASON
run scripts/scrape_naia.py --season $SEASON

banner "STAGE 2/7 — box scores (games + per-game lines + fielding + source_urls)"
run scripts/scrape_boxscores.py --season $SEASON --division D1
run scripts/scrape_boxscores.py --season $SEASON --division D2
run scripts/scrape_boxscores.py --season $SEASON --division D3
run scripts/scrape_boxscores.py --season $SEASON --division NAIA

banner "STAGE 3/7 — play-by-play (archived-layout parser)"
run scripts/scrape_pbp.py --backfill --season $SEASON

banner "STAGE 4/7 — derive base/out/score state"
run scripts/derive_event_state.py --season $SEASON

banner "STAGE 5/7 — derive batted-ball type + field zone"
run scripts/derive_batted_ball.py --season $SEASON

banner "STAGE 6/7 — compute WPA"
run scripts/compute_wpa.py --season $SEASON

banner "STAGE 7/7 — aggregate fielding"
run scripts/aggregate_fielding.py --season $SEASON

banner "DONE — 2024 Sidearm backfill complete"
