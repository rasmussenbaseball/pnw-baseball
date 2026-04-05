#!/bin/bash
# ============================================================
# PNW Baseball — Daily Update Script
# ============================================================
# Run this once per day to refresh all stats, box scores,
# records, ratings, and advanced metrics.
#
# Usage:
#   cd ~/Desktop/pnw-baseball
#   bash scripts/daily_update.sh
#
# Or make executable:
#   chmod +x scripts/daily_update.sh
#   ./scripts/daily_update.sh
#
# Optional: pass --season YEAR (default: 2026)
# ============================================================

set -e  # Exit on first error

SEASON="${1:-2026}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

export PYTHONPATH="$PROJECT_DIR/backend"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $1"; }
warn() { echo -e "${YELLOW}[$(date '+%H:%M:%S')] WARNING:${NC} $1"; }
fail() { echo -e "${RED}[$(date '+%H:%M:%S')] FAILED:${NC} $1"; }

ERRORS=0

run_step() {
    local name="$1"
    shift
    log "Starting: $name"
    if "$@" 2>&1 | tail -5; then
        log "Done: $name ✓"
    else
        fail "$name"
        ERRORS=$((ERRORS + 1))
    fi
    echo ""
}

echo "============================================"
echo "  PNW Baseball Daily Update — Season $SEASON"
echo "  $(date)"
echo "============================================"
echo ""

# ── Step 1: Scrape season stats for all 5 leagues ──────────
# These pull batting, pitching, and roster data from team websites.
# Each script handles one conference/division.

run_step "D1 stats (Pac-12 / WCC PNW teams)" \
    python3 scripts/scrape_d1.py --season "$SEASON"

run_step "D2 stats (GNAC)" \
    python3 scripts/scrape_d2.py --season "$SEASON"

run_step "D3 stats (NWC)" \
    python3 scripts/scrape_d3.py --season "$SEASON"

run_step "NAIA stats (CCC)" \
    python3 scripts/scrape_naia.py --season "$SEASON"

run_step "NWAC stats (JUCO)" \
    python3 scripts/scrape_nwac.py --season "$SEASON"

# ── Step 2: Scrape box scores (game-by-game stats) ─────────
# Fetches individual game batting/pitching lines from schedule pages.

run_step "Box scores (all divisions)" \
    python3 scripts/scrape_boxscores.py --season "$SEASON"

# ── Step 2b: Update player positions from game logs ────────
# Uses most-played position from box scores instead of generic roster data.

run_step "Update positions from game logs" \
    python3 scripts/update_positions.py --season "$SEASON"

# ── Step 3: Scrape team records/standings ───────────────────
# Pulls W-L records from conference standings pages.

run_step "Team records & standings" \
    python3 scripts/scrape_records.py --season "$SEASON"

# ── Step 4: Scrape national ratings ────────────────────────
# Pulls Pear Ratings and CBR data for cross-division comparisons.

run_step "National ratings (Pear + CBR)" \
    python3 scripts/scrape_national_ratings.py --season "$SEASON"

# ── Step 5: Recalculate advanced metrics ───────────────────
# Must run AFTER all stats are loaded so league averages are current.

run_step "Recalculate league-adjusted stats (wRC+, FIP+, ERA-)" \
    python3 scripts/recalculate_league_adjusted.py --season "$SEASON"

run_step "Recalculate WAR" \
    python3 scripts/recalculate_war.py --season "$SEASON"

# ── Headshots ─────────────────────────────────────────────
# Headshots are stored in /opt/headshots/ (outside git repo) and persist
# across deploys. Run backfill_headshots.py + download_headshots.py
# manually from Mac when rosters change (e.g., start of season).

# ── Summary ────────────────────────────────────────────────
echo "============================================"
if [ $ERRORS -eq 0 ]; then
    log "All steps completed successfully! ✓"
else
    fail "$ERRORS step(s) had errors. Check output above."
fi
echo "============================================"
