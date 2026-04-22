#!/bin/bash
# Run this from your pnw-baseball directory on Mac:
#   cd ~/Desktop/pnw-baseball && bash ~/Desktop/NWBB\ Stats/apply_changes.sh

set -e

# ── 1. Add PNW D1 filter to routes.py ──
# Insert the filter block before "# ── 6. Rank hitters by performance score ──"
python3 -c "
import re

with open('backend/app/api/routes.py', 'r') as f:
    content = f.read()

old = '        # ── 6. Rank hitters by performance score ──'
new = '''        # ── 5b. Filter out non-PNW D1 teams ──
        # D2/D3/NAIA/JUCO conferences are all PNW, but D1 conferences
        # (Big Ten, MWC, WCC) include many non-PNW schools.
        PNW_D1_TEAMS = {
            'Oregon', 'Oregon St.', 'UW', 'Wash. St.',
            'Gonzaga', 'Portland', 'Seattle U',
        }
        batting_rows = [
            b for b in batting_rows
            if b.get('division') != 'D1'
            or b.get('team_short') in PNW_D1_TEAMS
        ]
        pitching_rows = [
            p for p in pitching_rows
            if p.get('division') != 'D1'
            or p.get('team_short') in PNW_D1_TEAMS
        ]

        # ── 6. Rank hitters by performance score ──'''

if old not in content:
    if 'PNW_D1_TEAMS' in content:
        print('PNW D1 filter already applied, skipping.')
    else:
        print('ERROR: Could not find insertion point in routes.py')
        exit(1)
else:
    content = content.replace(old, new, 1)
    with open('backend/app/api/routes.py', 'w') as f:
        f.write(content)
    print('routes.py: PNW D1 filter added.')
"

# ── 2. Update DailyScoresGraphic.jsx performer sizes ──
python3 -c "
with open('frontend/src/pages/DailyScoresGraphic.jsx', 'r') as f:
    content = f.read()

replacements = [
    # Section height 180 -> 240
    (\"hasPerformers ? 180 : 0\", \"hasPerformers ? 240 : 0\"),
    # drawStatTable titleH, rowH, logoSize
    (\"const titleH = 16\", \"const titleH = 20\"),
    (\"const rowH = Math.min(26, (h - titleH) / Math.max(1, rowCount))\", \"const rowH = Math.min(34, (h - titleH) / Math.max(1, rowCount))\"),
    (\"Math.min(28, (h - titleH)\", \"Math.min(34, (h - titleH)\"),
    (\"const logoSize = Math.max(10, rowH - 6)\", \"const logoSize = Math.max(14, rowH - 8)\"),
    (\"const logoSize = Math.max(12, rowH - 6)\", \"const logoSize = Math.max(14, rowH - 8)\"),
    # Section title font
    (\"'700 10px \\\"Inter\\\", system-ui, sans-serif'\", \"'700 13px \\\"Inter\\\", system-ui, sans-serif'\"),
    (\"'700 11px \\\"Inter\\\", system-ui, sans-serif'\", \"'700 13px \\\"Inter\\\", system-ui, sans-serif'\"),
    # Column header font
    (\"'600 7px \\\"Inter\\\", system-ui, sans-serif'\", \"'600 10px \\\"Inter\\\", system-ui, sans-serif'\"),
    (\"'600 8px \\\"Inter\\\", system-ui, sans-serif'\", \"'600 10px \\\"Inter\\\", system-ui, sans-serif'\"),
    # Player name font
    (\"'600 9px \\\"Inter\\\", system-ui, sans-serif'\", \"'600 14px \\\"Inter\\\", system-ui, sans-serif'\"),
    (\"'600 11px \\\"Inter\\\", system-ui, sans-serif'\", \"'600 14px \\\"Inter\\\", system-ui, sans-serif'\"),
    # Team abbrev font
    (\"'400 7px \\\"Inter\\\", system-ui, sans-serif'\", \"'400 10px \\\"Inter\\\", system-ui, sans-serif'\"),
    (\"'400 8px \\\"Inter\\\", system-ui, sans-serif'\", \"'400 10px \\\"Inter\\\", system-ui, sans-serif'\"),
    # Stat number fonts (both normal and HR-highlighted)
    (\"'600 9px \\\"Inter\\\", system-ui, sans-serif'\", \"'600 13px \\\"Inter\\\", system-ui, sans-serif'\"),
    (\"'600 10px \\\"Inter\\\", system-ui, sans-serif'\", \"'600 13px \\\"Inter\\\", system-ui, sans-serif'\"),
    (\"'700 9px \\\"Inter\\\", system-ui, sans-serif'\", \"'700 13px \\\"Inter\\\", system-ui, sans-serif'\"),
    (\"'700 10px \\\"Inter\\\", system-ui, sans-serif'\", \"'700 13px \\\"Inter\\\", system-ui, sans-serif'\"),
    # Center text on row (remove -1 offset)
    ('ctx.fillText(displayName, curX, rMidY - 1)', 'ctx.fillText(displayName, curX, rMidY)'),
    ('ctx.fillText(team, curX + nameW, rMidY - 1)', 'ctx.fillText(team, curX + nameW, rMidY)'),
]

count = 0
for old, new in replacements:
    if old in content and old != new:
        content = content.replace(old, new)
        count += 1

with open('frontend/src/pages/DailyScoresGraphic.jsx', 'w') as f:
    f.write(content)
print(f'DailyScoresGraphic.jsx: {count} replacements applied.')
"

echo ""
echo "All changes applied! Now run:"
echo "  git add backend/app/api/routes.py frontend/src/pages/DailyScoresGraphic.jsx"
echo "  git commit -m 'Filter non-PNW D1 teams, enlarge top performers text'"
echo "  git push origin main"
