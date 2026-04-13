# Step-by-Step Debugging Guide for Conference Game Imbalance

## Phase 1: Data Preparation (Do This First!)

### Step 1.1: Populate future_schedules.json
```bash
cd /sessions/adoring-upbeat-brown/mnt/pnw-baseball
export PYTHONPATH=backend
python3 scripts/scrape_future_schedules.py --season 2026
```

**What to look for in output:**
```
Starting to scrape Sidearm teams...
Scraped [N] games from [divisions/conferences]
Deduplicated: [X] -> [Y] games
Conference detection: [A] marked, [B] unmarked (via DB conference_id)
Wrote [Y] future games to backend/data/future_schedules.json
```

**Success indicator:** "Wrote [>0] future games" (should be 100+)

### Step 1.2: Verify future_schedules.json has content
```bash
python3 -c "
import json
with open('backend/data/future_schedules.json') as f:
    data = json.load(f)
print(f'Total games: {data[\"total_games\"]}')
print(f'Last updated: {data[\"last_updated\"]}')
if data['total_games'] > 0:
    print(f'First game: {data[\"games\"][0]}')
"
```

**Success indicator:** total_games > 0, all games have is_conference field

---

## Phase 2: Diagnostic Analysis

### Step 2.1: Run diagnostic script
```bash
python3 diagnose_conf_imbalance.py
```

**Output will look like:**

```
CONFERENCE: Northwest Conference
=================================
Teams (9):
  - UPS              (ID: 10)
  - PLU              (ID: 11)
  ...

Conference games remaining analysis:
  BALANCED: All teams have 8 conference games remaining

  Details:
    UPS            | W:4 L:2 Rem:8 | Total:14 | OK
    PLU            | W:3 L:3 Rem:8 | Total:14 | OK
    Whitman        | W:5 L:1 Rem:8 | Total:14 | OK
    ...

SUMMARY
=================================
All conferences have balanced conference game counts!
```

### Step 2.2: If diagnostic shows IMBALANCE, note the following:
- Which conference(s) are imbalanced?
- Min and max games_remaining per conference?
- Which teams have fewer vs more?
- Which games are listed as "Extra games (causing imbalance)"?

**Example imbalance output:**
```
CONFERENCE: NWAC North Division
================================
Conference games remaining analysis:
  IMBALANCED: Teams have 7 to 8 games (DIFF: 1)

  Details:
    Bellevue       | W:2 L:1 Rem:7 | Total:10 | IMBALANCED
    Douglas        | W:1 L:2 Rem:8 | Total:11 | OK
    Edmonds        | W:3 L:0 Rem:8 | Total:11 | OK
    ...

  Extra games (causing imbalance):
    2026-04-15 | Shoreline     @ Douglas       | Shoreline has 8 games, Douglas has 8 games
    ...
```

---

## Phase 3: Root Cause Investigation

### Step 3.1: Check if all teams are in the database
```bash
python3 << 'EOF'
import sqlite3
from pathlib import Path
import json

db = sqlite3.connect("backend/data/pnw_baseball.db")
db.row_factory = sqlite3.Row
cur = db.cursor()

# Load future games
with open("backend/data/future_schedules.json") as f:
    future = json.load(f)

# Collect all team names
teams_in_games = set()
for g in future["games"]:
    teams_in_games.add(g.get("home_team"))
    teams_in_games.add(g.get("away_team"))

print(f"Teams in future_schedules: {len(teams_in_games)}")

# Check how many are in database
cur.execute("SELECT short_name FROM teams WHERE is_active = 1")
db_teams = {r['short_name'] for r in cur.fetchall()}

missing = teams_in_games - db_teams
if missing:
    print(f"\nMISSING from database ({len(missing)}):")
    for t in sorted(missing):
        print(f"  - {t}")
else:
    print("\nAll teams in future_schedules are in database ✓")

# Find extra teams in database
extra = db_teams - teams_in_games
if extra:
    print(f"\nExtra in database ({len(extra)}):")
    for t in sorted(extra):
        print(f"  - {t}")

db.close()
EOF
```

**Success:** No missing teams, or only expected extras (teams with no future games)

**Failure:** Missing teams → These must be added to database before scraping

---

### Step 3.2: Check conference_id accuracy in database
```bash
python3 << 'EOF'
import sqlite3
import json

db = sqlite3.connect("backend/data/pnw_baseball.db")
db.row_factory = sqlite3.Row
cur = db.cursor()

# Load a problematic conference game from diagnostic output
# Replace "Bellevue" and "Douglas" with actual imbalanced teams
problematic_game = ("Bellevue", "Douglas")

# Get their conference info
for team_name in problematic_game:
    cur.execute("""
        SELECT t.short_name, t.id, c.name as conference_name, c.abbreviation
        FROM teams t
        JOIN conferences c ON t.conference_id = c.id
        WHERE t.short_name = ?
    """, (team_name,))
    row = cur.fetchone()
    if row:
        print(f"{row['short_name']:15} (ID: {row['id']}) -> {row['conference_name']}")
    else:
        print(f"{team_name:15} NOT FOUND in database!")

db.close()
EOF
```

**Expected:** Both teams show the SAME conference name

**Problem:** Different conferences → This game should be marked is_conference=false! Check scraper logic.

---

### Step 3.3: Examine the scraper's team_map
```bash
python3 << 'EOF'
import sys
from pathlib import Path

# Load team_map from scraper
sys.path.insert(0, str(Path("backend")))
from scripts.scrape_live_scores import SIDEARM_TEAMS

# Check a specific team
team_name = "Bellevue"  # Replace with problematic team
if team_name in SIDEARM_TEAMS:
    print(f"✓ {team_name} found in SIDEARM_TEAMS")
    print(f"  URL: {SIDEARM_TEAMS[team_name]['base_url']}")
    print(f"  Division: {SIDEARM_TEAMS[team_name].get('division', '?')}")
else:
    print(f"✗ {team_name} NOT in SIDEARM_TEAMS")
    print(f"  Available teams: {', '.join(sorted(SIDEARM_TEAMS.keys()))}")

EOF
```

**Success:** Team found with correct URL and division

**Failure:** Team not in SIDEARM_TEAMS → Add it! (See Fix section below)

---

### Step 3.4: Check actual game counts in future_schedules.json
```bash
python3 << 'EOF'
import json
from collections import defaultdict

with open("backend/data/future_schedules.json") as f:
    data = json.load(f)

# For problematic conference, count games per team
# Example: NWAC North Division teams
conference_teams = {"Bellevue", "Douglas", "Edmonds", "Everett", "Shoreline", "Skagit"}

by_team = defaultdict(list)
for g in data["games"]:
    if g.get("is_conference"):
        if g.get("home_team") in conference_teams:
            by_team[g["home_team"]].append(g)
        if g.get("away_team") in conference_teams:
            by_team[g["away_team"]].append(g)

print("Conference games per team:")
for team in sorted(conference_teams):
    count = len(by_team[team])
    print(f"  {team:15} {count:2} games")

# Find the odd one out
counts = [len(by_team[t]) for t in conference_teams]
if len(set(counts)) == 1:
    print(f"\nAll teams have {counts[0]} games ✓")
else:
    print(f"\nIMBALANCE: {min(counts)} to {max(counts)} games")
    for team in sorted(conference_teams):
        c = len(by_team[team])
        if c < max(counts):
            print(f"  {team} is SHORT by {max(counts) - c}")

EOF
```

---

## Phase 4: Fixes Based on Root Cause

### Fix A: Team not in database
```bash
python3 << 'EOF'
import sqlite3

db = sqlite3.connect("backend/data/pnw_baseball.db")
cur = db.cursor()

# First, find what conference_id to use
cur.execute("SELECT id, name FROM conferences WHERE name LIKE '%NWAC%' AND name LIKE '%North%'")
conf = cur.fetchone()
if conf:
    conf_id = conf[0]
    print(f"Found conference: {conf[1]} (ID: {conf_id})")

# ADD team (example: Bellevue if missing)
# NOTE: You should do this manually through the website UI if possible
# This is just for reference:
# cur.execute("""
#     INSERT INTO teams (name, short_name, conference_id, is_active)
#     VALUES (?, ?, ?, 1)
# """, ("Bellevue College", "Bellevue", conf_id))
# db.commit()

# Verify the team exists
cur.execute("SELECT id, short_name, conference_id FROM teams WHERE short_name = ?", ("Bellevue",))
team = cur.fetchone()
if team:
    print(f"Team found: {team[1]} in conference_id {team[2]}")

db.close()
EOF
```

**Then re-run scraper to pick up the team:**
```bash
python3 scripts/scrape_future_schedules.py --season 2026
```

---

### Fix B: Team in database with wrong conference_id
```bash
# Manual SQL fix (be careful!):
python3 << 'EOF'
import sqlite3

db = sqlite3.connect("backend/data/pnw_baseball.db")
cur = db.cursor()

# Find current (wrong) conference for Whitman
cur.execute("""
    SELECT t.id, t.short_name, c.name FROM teams t
    JOIN conferences c ON t.conference_id = c.id
    WHERE t.short_name = 'Whitman'
""")
team = cur.fetchone()
print(f"Current: {team[1]} in {team[2]}")

# Find correct conference (NWC)
cur.execute("SELECT id FROM conferences WHERE abbreviation = 'NWC'")
correct_conf = cur.fetchone()
if correct_conf:
    conf_id = correct_conf[0]
    # UPDATE (uncomment to execute):
    # cur.execute("UPDATE teams SET conference_id = ? WHERE short_name = ?", (conf_id, "Whitman"))
    # db.commit()
    print(f"Should update to conference_id {conf_id}")

db.close()
EOF
```

**Then re-run scraper:**
```bash
python3 scripts/scrape_future_schedules.py --season 2026
```

---

### Fix C: Team not in scraper's SIDEARM_TEAMS
Edit `scripts/scrape_live_scores.py` and add to SIDEARM_TEAMS dict:

```python
SIDEARM_TEAMS = {
    # ... existing teams ...
    "Bellevue": {
        "base_url": "https://bellevueblazeers.com",  # Check real website
        "name_on_site": "Bellevue",
        "division": "NWAC",
        "conference": "NWAC-N",
    },
    # ...
}
```

Then re-run scraper to pick it up.

---

## Phase 5: Validation

After any fix, run full validation:

```bash
# 1. Re-scrape
python3 scripts/scrape_future_schedules.py --season 2026

# 2. Check for success
python3 -c "
import json
with open('backend/data/future_schedules.json') as f:
    data = json.load(f)
print(f'Total games: {data[\"total_games\"]}')
print(f'Sample is_conference: {data[\"games\"][0][\"is_conference\"]}')
"

# 3. Run diagnostic
python3 diagnose_conf_imbalance.py

# 4. Manually check one conference
python3 << 'EOF'
import json
from collections import defaultdict

with open("backend/data/future_schedules.json") as f:
    data = json.load(f)

# Count by team for NWC
nwc_teams = {"UPS", "PLU", "Whitman", "Whitworth", "Linfield", "L&C", "Willamette", "Pacific", "GFU"}
by_team = defaultdict(int)
for g in data["games"]:
    if g.get("is_conference") and g.get("home_team") in nwc_teams and g.get("away_team") in nwc_teams:
        by_team[g["home_team"]] += 1
        by_team[g["away_team"]] += 1

counts = [by_team[t] for t in nwc_teams]
print(f"NWC game counts: {sorted(counts)}")
print(f"All equal? {len(set(counts)) == 1}")
EOF
```

---

## Red Flags During Debugging

| Symptom | Likely Cause | Action |
|---------|--------------|--------|
| Team in games but not in DB | Scraper found team that doesn't exist yet | Add team to DB first |
| Team in DB but wrong conference | Bad database seed data | Fix conference_id in DB |
| Team not in SIDEARM_TEAMS dict | Scraper doesn't know about team | Add to SIDEARM_TEAMS |
| Game is_conference is wrong | Sidearm HTML misparsed | Check website, file issue |
| One team missing a game | Incomplete scraping from website | Check team's website schedule |
| One team has extra game | Duplicate game in source | Check for weekend doubleheaders |
| All teams show 0 games | future_schedules.json empty | Re-run scraper with full output |

---

## Questions to Ask During Debugging

1. **Is this a real conference game?** Both teams in same conference? Check database.
2. **Is this team in the database?** Check teams table.
3. **Does this team have correct conference_id?** Compare with SIDEARM_TEAMS config.
4. **Is the game on the team's website?** Check their schedule page directly.
5. **Does the scraper know this team?** Grep SIDEARM_TEAMS and NWAC_TEAM_SLUGS.
6. **Is the game being deduplicated wrong?** Check if same game has different is_conference values.

---

## Final Validation Command

After all fixes, run this to confirm balance across all conferences:

```bash
python3 << 'EOF'
import json
import sqlite3
from collections import defaultdict

# Load data
with open("backend/data/future_schedules.json") as f:
    future = json.load(f)

db = sqlite3.connect("backend/data/pnw_baseball.db")
db.row_factory = sqlite3.Row
cur = db.cursor()

# Get all teams by conference
cur.execute("""
    SELECT c.name as conf, t.short_name as team
    FROM teams t
    JOIN conferences c ON t.conference_id = c.id
    WHERE t.is_active = 1
    ORDER BY c.name, t.short_name
""")

teams_by_conf = defaultdict(list)
for row in cur.fetchall():
    teams_by_conf[row['conf']].append(row['team'])

# Check balance for each conference
all_balanced = True
for conf_name, conf_teams in sorted(teams_by_conf.items()):
    by_team = defaultdict(int)
    for g in future["games"]:
        if g.get("is_conference"):
            if g.get("home_team") in conf_teams and g.get("away_team") in conf_teams:
                by_team[g["home_team"]] += 1
                by_team[g["away_team"]] += 1

    if by_team:
        counts = [by_team[t] for t in conf_teams]
        is_balanced = len(set(counts)) == 1
        status = "✓ BALANCED" if is_balanced else "✗ IMBALANCED"
        all_balanced = all_balanced and is_balanced
        print(f"{status:15} {conf_name:30} ({min(counts) if counts else 0} to {max(counts) if counts else 0})")
    else:
        print(f"{'EMPTY':15} {conf_name:30} (no conf games)")

db.close()
print(f"\nOverall: {'✓ ALL BALANCED' if all_balanced else '✗ SOME IMBALANCED'}")
EOF
```

Success = All conferences show "✓ BALANCED"
