# Diagnosis: Conference Game Count Imbalance in Playoff Projections

## Executive Summary

The conference game count imbalance is caused by **inaccurate `is_conference` flags in future_schedules.json**. The system has three tiers of detection:

1. **Tier 1 (Primary):** Sidearm HTML/Nuxt data - unreliable across sites
2. **Tier 2 (Override):** Database conference_id matching - validates/corrects Tier 1
3. **Tier 3 (Calculations):** Counting conference games remaining per team

**The root cause is that `future_schedules.json` is empty or not being populated**, so no games (conference or non-conference) reach the projection system at all.

## The Core Rule

For every team in a conference, this equation MUST hold:
```
(conference_wins + conference_losses) + conference_games_remaining = SAME for all teams in that conference
```

Why? Because every conference game involves exactly 2 teams from the same conference, so if Team A plays Team B (both in Conference X), that counts as 1 game for each of them.

## Current State

1. **future_schedules.json is empty**
   - File: `/sessions/adoring-upbeat-brown/mnt/pnw-baseball/backend/data/future_schedules.json`
   - Content: `{"games": [], "last_updated": null, "season": 2026, "total_games": 0}`
   - Result: **ZERO games are loaded into projections**

2. **Database exists and has team/conference data**
   - DB: `/sessions/adoring-upbeat-brown/mnt/pnw-baseball/backend/data/pnw_baseball.db`
   - Tables: teams (87 teams), conferences, divisions
   - Tables for games/schedules: EMPTY (not yet populated)

3. **Projection system has no games to project**
   - Routes.py line 1962: `future_data = load_future_schedules()`
   - Projections.py line 133-141: Reads future_schedules.json
   - Result: `conf_games_remaining` calculated as 0 for every team

## How the System Works

### Three-Step Conference Detection (in scrape_future_schedules.py)

**Step 1: Site-level detection (unreliable)**
- Sidearm sites: Parse HTML `<td data-is-conference>` attributes
- NWAC: Check if both teams exist in NWAC_TEAMS_SET and are in the same division
- Problem: Different sites encode this differently

**Step 2: Database validation (authoritative)**
```python
# Lines 884-912 in scrape_future_schedules.py
for g in all_games:
    home_id = g.get("home_team_id")
    away_id = g.get("away_team_id")
    if home_id and away_id:
        home_conf = team_conf_map.get(home_id)      # From database
        away_conf = team_conf_map.get(away_id)      # From database
        if home_conf and away_conf and home_conf == away_conf:
            g["is_conference"] = True    # Mark as conference
        else:
            g["is_conference"] = False   # Unmark if not same conference
```

This is the CORRECT approach: two teams are in a conference game if and only if their conference_id matches in the database.

**Step 3: Projections use the flag**
```python
# Lines 450-451 in build_projected_standings()
"games_remaining": len(proj.get("games", [])),
"conf_games_remaining": sum(1 for g in proj.get("games", []) if g.get("is_conference")),
```

## Why Imbalance Occurs

### Scenario 1: Games not scraped (CURRENT SITUATION)
- **Result:** 0 conference games for every team → 0 = 0 for everyone → No imbalance visible
- **But:** Projections show no remaining games, so playoffs look impossible

### Scenario 2: Incomplete scraping (likely after data is populated)
Example: Conference has 8 teams, should be round-robin = 7 games per team
- Team A has games vs B, C, D, E, F, G (6 games) → Missing opponent
- Team H is never scraped (unknown reason)
- Result: Team A shows 6 remaining, others show 7 → IMBALANCE

### Scenario 3: Cross-conference games marked as conference games (most common cause)
- Sidearm site has bad HTML that marks exhibition or non-conference games as conference
- Database validation SHOULD catch this, but only if team_conf_map is complete
- If a team is missing from team_conf_map, validation skips that game

### Scenario 4: Duplicates not properly deduplicated
- Same game appears twice with different `is_conference` values
- Deduplication happens BEFORE database validation (line 881)
- If dedup keeps wrong copy, imbalance results

## The Database Conference ID Logic

Teams are grouped by:
- `teams.conference_id` (foreign key to conferences table)
- `conferences.name` (e.g., "GNAC", "NWC", "CCC", "NWAC North Division")

Two teams share a conference if:
```sql
SELECT COUNT(DISTINCT conference_id) FROM teams
WHERE short_name IN ('Team A', 'Team B');
-- If result = 1, they're in the same conference
```

## How to Debug When Data Populates

Once scrape_future_schedules.py runs successfully and data populates:

### Check 1: Verify future_schedules.json structure
```json
{
  "games": [
    {
      "game_date": "2026-04-10",
      "home_team": "UPS",
      "away_team": "Whitworth",
      "home_team_id": 10,
      "away_team_id": 13,
      "is_conference": true,
      "season": 2026
    },
    ...
  ],
  "total_games": 147,
  "last_updated": "2026-04-06T...",
  "season": 2026
}
```

### Check 2: Run diagnostic script
```bash
cd /sessions/adoring-upbeat-brown/mnt/pnw-baseball
python3 diagnose_conf_imbalance.py
```

This script:
1. Loads future_schedules.json
2. Loads teams & conferences from database
3. For each conference, counts conference games remaining per team
4. Reports if all teams have the SAME count
5. If imbalanced, lists which games are causing it

### Check 3: Validate team mapping
```python
# In scrape_future_schedules.py, after line 888:
print(f"Team map entries: {len(team_map)}")
for name, entry in list(team_map.items())[:5]:
    print(f"  {name}: {entry}")

# Verify all teams in database are in team_map
cur.execute("SELECT COUNT(*) as cnt FROM teams WHERE is_active = 1")
db_count = cur.fetchone()['cnt']
print(f"Database teams: {db_count}, Mapped teams: {len(team_map)}")
```

### Check 4: Inspect a problematic conference
```python
# After running scraper, in Python shell:
import json
from pathlib import Path

with open("backend/data/future_schedules.json") as f:
    data = json.load(f)

# Find all games involving NWC teams
nwc_games = [g for g in data["games"] if g.get("home_team") in ["UPS", "Whitman", "PLU", "Whitworth", "Linfield", "L&C", "Willamette", "Pacific", "GFU"]]

# Group by team to see count per team
from collections import defaultdict
by_team = defaultdict(list)
for g in nwc_games:
    if g.get("is_conference"):
        by_team[g["home_team"]].append(g)
        by_team[g["away_team"]].append(g)

for team, games in sorted(by_team.items()):
    print(f"{team:15} {len(games)} conference games")
```

## Immediate Action Required

1. **Run scrape_future_schedules.py** to populate the data
   ```bash
   cd /sessions/adoring-upbeat-brown/mnt/pnw-baseball
   PYTHONPATH=backend python3 scripts/scrape_future_schedules.py --season 2026
   ```

2. **Run diagnostic script** to verify balance
   ```bash
   python3 diagnose_conf_imbalance.py
   ```

3. **If imbalance is found**, check:
   - Are all teams in the database mapped? (See Check 3 above)
   - Are cross-conference games being mislabeled? (Check Scenario 3)
   - Are there duplicate games? (Check Scenario 4)

## Key Files

- **Scraper:** `/sessions/adoring-upbeat-brown/mnt/pnw-baseball/scripts/scrape_future_schedules.py`
  - Lines 884-912: Database validation of `is_conference`
  - Line 898-911: The logic that should prevent imbalance

- **Projection calculations:** `/sessions/adoring-upbeat-brown/mnt/pnw-baseball/backend/app/stats/projections.py`
  - Lines 148-242: `project_remaining_games()` - accumulates games by team
  - Lines 385-474: `build_projected_standings()` - calculates `conf_games_remaining`
  - Line 451: `sum(1 for g in proj.get("games", []) if g.get("is_conference"))`

- **API endpoint:** `/sessions/adoring-upbeat-brown/mnt/pnw-baseball/backend/app/api/routes.py`
  - Lines 1948-2079: `/playoff-projections` endpoint
  - Line 2042: Calls `project_remaining_games()`
  - Line 2050-2052: Calls `build_projected_standings()`

- **Diagnostic tool:** `/sessions/adoring-upbeat-brown/mnt/pnw-baseball/diagnose_conf_imbalance.py`
  - Validates conference game counts per team
  - Identifies which games are causing imbalance
