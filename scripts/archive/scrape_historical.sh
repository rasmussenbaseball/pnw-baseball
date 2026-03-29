#!/bin/bash
# ══════════════════════════════════════════════════════════════
# Historical data scraper for PNW College Baseball
# Pulls stats for 2022-2025 seasons (run from project root)
#
# Usage:
#   cd pnw-baseball
#   chmod +x scripts/scrape_historical.sh
#   ./scripts/scrape_historical.sh
#
# Or run a single season:
#   ./scripts/scrape_historical.sh 2025
# ══════════════════════════════════════════════════════════════

set -e

SEASONS="${1:-2025 2024 2023 2022}"

for SEASON in $SEASONS; do
    echo "════════════════════════════════════════════════════"
    echo "  SCRAPING SEASON: $SEASON"
    echo "════════════════════════════════════════════════════"

    # Convert to NWAC academic year format (2025 → 2024-25)
    PREV=$((SEASON - 1))
    SHORT=$(echo $SEASON | cut -c3-4)
    NWAC_SEASON="${PREV}-${SHORT}"

    echo ""
    echo "--- D1 (season=$SEASON) ---"
    PYTHONPATH=backend python3 scripts/scrape_d1.py --season "$SEASON" --skip-rosters 2>&1 | tail -5
    echo ""

    echo "--- NAIA (season=$SEASON) ---"
    PYTHONPATH=backend python3 scripts/scrape_naia.py --season "$SEASON" --skip-rosters 2>&1 | tail -5
    echo ""

    echo "--- D2/GNAC (season=$SEASON) ---"
    PYTHONPATH=backend python3 scripts/scrape_d2.py --season "$SEASON" --skip-rosters 2>&1 | tail -5
    echo ""

    echo "--- D3/NWC (season=$SEASON) ---"
    PYTHONPATH=backend python3 scripts/scrape_d3.py --season "$SEASON" --skip-rosters 2>&1 | tail -5
    echo ""

    echo "--- NWAC/JUCO (season=$NWAC_SEASON) ---"
    PYTHONPATH=backend python3 scripts/scrape_nwac.py --season "$NWAC_SEASON" --skip-rosters 2>&1 | tail -5
    echo ""

    echo "Season $SEASON complete!"
    echo ""
done

echo "════════════════════════════════════════════════════"
echo "  ALL HISTORICAL SCRAPES COMPLETE"
echo "════════════════════════════════════════════════════"

# Show summary
PYTHONPATH=backend python3 -c "
import sqlite3
conn = sqlite3.connect('backend/data/pnw_baseball.db')
print('\nData summary:')
for table in ['batting_stats', 'pitching_stats']:
    rows = conn.execute(f'SELECT season, COUNT(*) FROM {table} GROUP BY season ORDER BY season').fetchall()
    print(f'\n  {table}:')
    for s, c in rows:
        print(f'    {s}: {c} rows')
conn.close()
"
