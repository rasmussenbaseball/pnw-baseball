#!/bin/bash
##############################################################################
# Browser-based Team Scraper for NWAC, Seattle U, and Willamette
##############################################################################
#
# Runs all the necessary steps for the 3 "problem" teams that require
# a real browser to bypass WAF/JS rendering issues.
#
# Steps:
#  1. Browser-based stats scrape (Seattle U, Willamette, NWAC)
#  2. NWAC box scores (browser-based)
#  3. Recalculate league-adjusted stats
#  4. Recalculate WAR
#
# Usage:
#    cd pnw-baseball
#    bash scripts/scrape_browser_teams.sh        # Default: 2026
#    bash scripts/scrape_browser_teams.sh 2025   # Specific year
#    bash scripts/scrape_browser_teams.sh 2026 --headless
#
# Run from Mac with:
#    cd ~/Desktop/pnw-baseball && bash scripts/scrape_browser_teams.sh
#
##############################################################################

set -e

SEASON="${1:-2026}"
HEADLESS_FLAG=""

# Check for --headless flag
if [[ "$2" == "--headless" ]]; then
    HEADLESS_FLAG="--headless"
fi

# Change to project root
cd "$(dirname "$0")/.."

export PYTHONPATH="backend"

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║     Browser Team Scraper — NWAC, Seattle U, Willamette    ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Season: $SEASON"
echo "Headless: ${HEADLESS_FLAG:-false}"
echo ""

# ============================================================
# Step 1: Browser-based stats scrape
# ============================================================

echo "▶ Step 1: Browser-based stats scrape"
echo "  Teams: Seattle U, Willamette, NWAC (all teams)"
echo ""

python3 scripts/scrape_browser_stats.py --season "$SEASON" $HEADLESS_FLAG

echo ""

# ============================================================
# Step 2: NWAC box scores (browser-based)
# ============================================================

echo "▶ Step 2: NWAC box scores (browser-based)"
echo ""

if [ -f "scripts/scrape_nwac_browser.py" ]; then
    python3 scripts/scrape_nwac_browser.py --season "$SEASON" $HEADLESS_FLAG
else
    echo "  Warning: scrape_nwac_browser.py not found — skipping"
fi

echo ""

# ============================================================
# Step 3: Recalculate league-adjusted stats
# ============================================================

echo "▶ Step 3: Recalculate league-adjusted stats"
echo ""

if [ -f "scripts/recalculate_league_adjusted.py" ]; then
    python3 scripts/recalculate_league_adjusted.py --season "$SEASON"
else
    echo "  Warning: recalculate_league_adjusted.py not found — skipping"
fi

echo ""

# ============================================================
# Step 4: Recalculate WAR
# ============================================================

echo "▶ Step 4: Recalculate WAR"
echo ""

if [ -f "scripts/recalculate_war.py" ]; then
    python3 scripts/recalculate_war.py --season "$SEASON"
else
    echo "  Warning: recalculate_war.py not found — skipping"
fi

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                     ALL DONE!                             ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
