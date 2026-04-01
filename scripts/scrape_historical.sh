#!/bin/bash
# Scrape historical data for all divisions (2018-2021)
# Run on server: nohup bash scripts/scrape_historical.sh > /tmp/historical_scrape.log 2>&1 &

cd /opt/pnw-baseball
export PYTHONPATH=backend

echo "========================================"
echo "Starting historical scrape: $(date)"
echo "========================================"

# D1: 2020, 2019, 2018 (2021 already done)
for YEAR in 2020 2019 2018; do
    echo ""
    echo "=== D1 $YEAR === $(date)"
    python3 scripts/scrape_d1.py --season $YEAR --skip-rosters
    echo "D1 $YEAR done: $(date)"
done

# D2: 2021, 2020, 2019, 2018
for YEAR in 2021 2020 2019 2018; do
    echo ""
    echo "=== D2 $YEAR === $(date)"
    python3 scripts/scrape_d2.py --season $YEAR --skip-rosters
    echo "D2 $YEAR done: $(date)"
done

# D3: 2021, 2020, 2019, 2018
for YEAR in 2021 2020 2019 2018; do
    echo ""
    echo "=== D3 $YEAR === $(date)"
    python3 scripts/scrape_d3.py --season $YEAR --skip-rosters
    echo "D3 $YEAR done: $(date)"
done

# NAIA: 2021, 2020, 2019, 2018
for YEAR in 2021 2020 2019 2018; do
    echo ""
    echo "=== NAIA $YEAR === $(date)"
    python3 scripts/scrape_naia.py --season $YEAR --skip-rosters
    echo "NAIA $YEAR done: $(date)"
done

# NWAC: 2020-21, 2019-20, 2018-19 (uses academic year format)
# Note: 2020-21 season was likely cancelled due to COVID
for YEAR in 2020-21 2019-20 2018-19; do
    echo ""
    echo "=== NWAC $YEAR === $(date)"
    python3 scripts/scrape_nwac.py --season $YEAR --skip-rosters
    echo "NWAC $YEAR done: $(date)"
done

echo ""
echo "========================================"
echo "Historical scrape complete: $(date)"
echo "========================================"
