#!/bin/bash
# Phase A — derive-only re-run for the 2026 season.
# Skips the rescrape step since the DB already has fresh events from
# the Sidearm + NWAC backfills. This just re-runs the state machine
# with whatever parser code is currently checked out.
# Usage:  bash scripts/run_phase_a_derive_only.sh
# Runtime: ~2-3 minutes.

set -e
cd "$(dirname "$0")/.."
export PYTHONPATH=backend

echo "===  Re-deriving state for all 2026 games (latest parser code)  ==="
python3 scripts/derive_event_state.py --season 2026 --force

echo
echo "===  Audit: overall  ==="
python3 scripts/audit_pbp_state.py

echo
echo "===  Audit: mismatched games (top 30)  ==="
python3 scripts/audit_pbp_state.py --bad-only --limit 30
