#!/bin/bash
# ONE-TIME SETUP: Move all logos to /opt/logos/ so they survive deploys
# This mirrors the headshot pattern: nginx serves /logos/ from /opt/logos/
#
# After running this, logos are served by nginx directly and are completely
# independent of the git repo and frontend build process.
#
# Run on server: bash /opt/pnw-baseball/scripts/setup_persistent_logos.sh

set -e

echo "=== Setting up persistent logo storage ==="

# Create persistent logo directories
mkdir -p /opt/logos/teams
mkdir -p /opt/logos/nwac
mkdir -p /opt/logos/summer

# Copy existing logos from frontend/public/logos/ to /opt/logos/
echo "Copying team logos..."
if [ -d /opt/pnw-baseball/frontend/public/logos/teams ]; then
    cp -n /opt/pnw-baseball/frontend/public/logos/teams/* /opt/logos/teams/ 2>/dev/null || true
fi

echo "Copying NWAC logos..."
if [ -d /opt/pnw-baseball/frontend/public/logos/nwac ]; then
    cp -n /opt/pnw-baseball/frontend/public/logos/nwac/* /opt/logos/nwac/ 2>/dev/null || true
fi

echo "Copying summer logos (if any)..."
if [ -d /opt/pnw-baseball/frontend/public/logos/summer ]; then
    cp -n /opt/pnw-baseball/frontend/public/logos/summer/* /opt/logos/summer/ 2>/dev/null || true
fi

# Copy any root-level logos
for f in /opt/pnw-baseball/frontend/public/logos/*.png /opt/pnw-baseball/frontend/public/logos/*.svg; do
    [ -f "$f" ] && cp -n "$f" /opt/logos/ 2>/dev/null || true
done

# Also copy from dist/ in case logos exist there but not in public/
if [ -d /opt/pnw-baseball/frontend/dist/logos ]; then
    echo "Copying from dist/logos as backup..."
    cp -rn /opt/pnw-baseball/frontend/dist/logos/* /opt/logos/ 2>/dev/null || true
fi

echo ""
echo "Logo counts:"
echo "  teams: $(ls /opt/logos/teams/ 2>/dev/null | wc -l) files"
echo "  nwac:  $(ls /opt/logos/nwac/ 2>/dev/null | wc -l) files"
echo "  summer: $(ls /opt/logos/summer/ 2>/dev/null | wc -l) files"

echo ""
echo "=== Now download summer logos ==="
bash /opt/pnw-baseball/scripts/download_summer_logos.sh

echo ""
echo "Summer logos after download: $(ls /opt/logos/summer/ 2>/dev/null | wc -l) files"

echo ""
echo "=== IMPORTANT: Add this to /etc/nginx/sites-enabled/nwbb ==="
echo "Add this location block BEFORE the 'location /' block:"
echo ""
echo '    location /logos/ {'
echo '        alias /opt/logos/;'
echo '        expires 30d;'
echo '        add_header Cache-Control "public, immutable";'
echo '    }'
echo ""
echo "Then run: sudo nginx -t && sudo systemctl reload nginx"
echo ""
echo "=== Done ==="
