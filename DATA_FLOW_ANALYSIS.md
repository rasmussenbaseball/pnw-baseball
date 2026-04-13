# Conference Game Count Data Flow Analysis

## Complete Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. SCRAPING PHASE (scrape_future_schedules.py)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  A. Scrape team websites (Sidearm, NWAC PrestoSports, Willamette)          │
│     └─> Extract game data with initial is_conference flag                   │
│         (based on site-specific HTML parsing)                               │
│                                                                              │
│  B. Load team metadata from database (lines 888-894)                        │
│     ```python                                                               │
│     team_conf_map = {}  # Maps team_id -> conference_id                     │
│     for name, entry in team_map.items():                                    │
│         team_conf_map[entry["team_id"]] = entry["conference_id"]            │
│     ```                                                                      │
│                                                                              │
│  C. DATABASE VALIDATION (lines 884-912) ← CRITICAL STEP                     │
│     For EVERY game:                                                         │
│     - Get home_team_id and away_team_id                                     │
│     - Look up each team's conference_id from database                       │
│     - IF both conference_ids exist AND match:                               │
│       └─> Mark g["is_conference"] = True                                    │
│     - ELSE:                                                                 │
│       └─> Mark g["is_conference"] = False                                   │
│                                                                              │
│     This OVERWRITES any incorrect site-level detection!                     │
│                                                                              │
│  D. Write to future_schedules.json (line 929)                               │
│     ```json                                                                 │
│     {                                                                       │
│       "games": [                                                            │
│         {                                                                   │
│           "game_date": "2026-04-10",                                        │
│           "home_team": "UPS",                                               │
│           "away_team": "Whitworth",                                         │
│           "home_team_id": 10,                                               │
│           "away_team_id": 13,                                               │
│           "is_conference": true,  ← This is what matters!                   │
│           ...                                                               │
│         },                                                                  │
│         ...                                                                 │
│       ]                                                                     │
│     }                                                                       │
│     ```                                                                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. PROJECTION PHASE (projections.py & routes.py)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  /playoff-projections endpoint (routes.py:1948)                             │
│     ↓                                                                        │
│  load_future_schedules() (projections.py:133-141)                           │
│     ↓                                                                        │
│     Returns: {"games": [...], "last_updated": "...", "season": 2026}        │
│     ↓                                                                        │
│  project_remaining_games() (projections.py:148-242)                         │
│     For each game in future_games:                                          │
│     - home_team gets game with weight home_win_prob                         │
│     - away_team gets game with weight away_win_prob                         │
│     - If is_conference=true:                                                │
│       └─> Increment projected_conf_wins/losses for both teams               │
│     - Append game to each team's games list                                 │
│                                                                              │
│     Returns: dict[team_id] -> {                                             │
│       "projected_wins": float,                                              │
│       "projected_losses": float,                                            │
│       "projected_conf_wins": float,                                         │
│       "projected_conf_losses": float,                                       │
│       "games": [list of games with is_conference flag]                      │
│     }                                                                       │
│     ↓                                                                        │
│  build_projected_standings() (projections.py:385-474)                       │
│     For each team in current_standings:                                     │
│     - Get projections[team_id]                                              │
│     - current_conf_wins = team.conf_wins from DB                            │
│     - current_conf_losses = team.conf_losses from DB                        │
│     - final_conf_wins = current_conf_wins + projected_conf_wins             │
│     - final_conf_losses = current_conf_losses + projected_conf_losses       │
│     ↓ ↓ ↓ KEY CALCULATION (lines 450-451) ↓ ↓ ↓                            │
│     conf_games_remaining = sum(1 for g in proj.get("games", [])            │
│                                 if g.get("is_conference"))                  │
│                                 ^^^^^^^^^^^^^^^^^^^^^^^^^                   │
│                      Counts games where is_conference=true                  │
│                                                                              │
│     Returns: list of conferences with projected teams                       │
│     Each team has:                                                          │
│     {                                                                       │
│       "current_conf_wins": int,                                             │
│       "current_conf_losses": int,                                           │
│       "projected_conf_wins": float,                                         │
│       "projected_conf_losses": float,                                       │
│       "conf_games_remaining": int,  ← This is displayed!                    │
│       ...                                                                   │
│     }                                                                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. DISPLAY PHASE (PlayoffProjections.jsx)                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Fetch: GET /api/v1/playoff-projections?season=2026                         │
│  Display conference standings table (line 70-214)                           │
│  Show conf_games_remaining in cell (line 170):                              │
│     <td className="text-center px-1 py-1.5 text-gray-400">                  │
│       {team.conf_games_remaining}                                           │
│     </td>                                                                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## The Imbalance Rule

For any conference, **all teams must have the same conf_games_remaining**.

Why? Let's use NWC (Northwest Conference) as an example:

```
9 teams: UPS, PLU, Whitman, Whitworth, Linfield, L&C, Willamette, Pacific, GFU

If it's a 8-game round-robin (each team plays each other once):
- Team A should have 8 remaining games
- Team B should have 8 remaining games
- Team C should have 8 remaining games
...
- Team I should have 8 remaining games

If Team A shows 7 but Team B shows 8, there's a missing game!
```

Mathematically:
```
Sum of all remaining games per team = 2 × total games in conference
(because each game involves 2 teams)

If all teams have N remaining:
  total_teams × N = 2 × total_games
  N = 2 × total_games / total_teams

NWC example: 9 teams, 8-game round-robin = 8×9/2 = 36 games
  Each team should have: 36 × 2 / 9 = 8 games

If one team shows 7 and others show 8:
  Sum = 1×7 + 8×8 = 71 ≠ 36×2 = 72
  One game is missing!
```

## Why Imbalance Happens: 5 Scenarios

### Scenario 1: Game never scraped (incomplete website)
```
Website shows Team A vs Team B, but:
- Scraper doesn't handle that page format
- OR game is listed on Team A's site but not Team B's
- Result: One team counts the game, the other doesn't
```

### Scenario 2: Team not in team_map (database mismatch)
```python
# Scraper does this validation (lines 901-902):
home_id = g.get("home_team_id") or name_to_id.get(g.get("home_team"))
away_id = g.get("away_team_id") or name_to_id.get(g.get("away_team"))

# Then validates (lines 904-907):
if home_conf and away_conf and home_conf == away_conf:
    g["is_conference"] = True

# But what if home_id is None?
# Then home_conf is None, and condition fails
# Game gets marked as NOT CONFERENCE, even if it should be!
```

### Scenario 3: Team in database but wrong conference_id
```
Database has:
  teams: id=100, name="Whitworth", conference_id=5 (NWC - correct)
         id=200, name="Whitman", conference_id=6 (DIFFERENT - wrong!)

Game: Whitworth vs Whitman

Validation (line 904):
  home_conf = 5 (Whitworth's conference)
  away_conf = 6 (Whitman's conference - wrong in DB!)
  5 ≠ 6 → Mark as NOT CONFERENCE

Result: Both teams have fewer remaining games than they should
```

### Scenario 4: Duplicate games with different is_conference values
```
Same game appears twice:
  Game 1: Whitworth @ UPS, is_conference=true
  Game 2: Whitworth @ UPS, is_conference=false (malformed HTML?)

Deduplication (line 881) keeps one, loses the other
If it keeps the FALSE one, both teams lose a conference game count
```

### Scenario 5: Exhibition/neutral game marked as conference
```
Game: NWC Team A @ Non-NWC Team B
Website marks it as "conference" (wrong)
Team A and Team B have different conferences
Database validation SHOULD catch this... UNLESS
Team B isn't in team_map, so away_id is None, validation skips

Result: Game counted by Team A but Team B has no way to count it
```

## How to Detect the Root Cause

1. Run diagnostic: `python3 diagnose_conf_imbalance.py`
2. See which conference is imbalanced
3. See which teams have fewer vs more remaining games
4. Check "Extra games" list - those games are the culprits
5. For each culprit game, ask:
   - Is it actually a conference game? (both teams in same conference?)
   - Is each team in the database?
   - Is each team's conference_id correct?
   - Why was one team's count off by X?

## Verification Checklist

After running scraper:

```bash
# 1. Check file exists and isn't empty
wc -l backend/data/future_schedules.json

# 2. Run diagnostic
python3 diagnose_conf_imbalance.py

# 3. If imbalanced, count games per team manually
python3 << 'EOF'
import json
from collections import defaultdict

with open("backend/data/future_schedules.json") as f:
    data = json.load(f)

# For one conference (e.g., NWC)
nwc_teams = {"UPS", "PLU", "Whitman", "Whitworth", "Linfield", "L&C", "Willamette", "Pacific", "GFU"}
nwc_games = [g for g in data["games"] if g.get("is_conference") and
             g.get("home_team") in nwc_teams and g.get("away_team") in nwc_teams]

by_team = defaultdict(int)
for g in nwc_games:
    by_team[g["home_team"]] += 1
    by_team[g["away_team"]] += 1

for team in sorted(nwc_teams):
    print(f"{team:15} {by_team[team]} games")
EOF
```

All teams should have the same count!
