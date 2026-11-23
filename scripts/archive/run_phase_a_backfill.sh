#!/bin/bash
# Phase A re-scrape + state-derive + audit for the 2026 season.
# Usage:  bash scripts/run_phase_a_backfill.sh
#
# Safe to re-run any time. The rescrape step skips games already at the
# attempt cap unless --rescrape is set (it is). The derive step
# re-computes state for every game with events when --force is set
# (also is). Together that picks up any parser fix you've shipped.

set -e
cd "$(dirname "$0")/.."
export PYTHONPATH=backend

echo "===  Re-scraping all Sidearm PBP (NWAC games will be skipped)  ==="
python3 scripts/scrape_pbp.py --season 2026 --backfill --rescrape

echo
echo "===  Re-deriving state for all 2026 games (picks up any parser fix)  ==="
python3 scripts/derive_event_state.py --season 2026 --force

echo
echo "===  Audit: overall  ==="
python3 scripts/audit_pbp_state.py

echo
echo "===  Audit: mismatched games (top 30)  ==="
python3 scripts/audit_pbp_state.py --bad-only --limit 30
