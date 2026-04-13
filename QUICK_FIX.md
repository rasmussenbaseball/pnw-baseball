# Quick Fix: Conference Game Imbalance

## Root Cause

**future_schedules.json is empty** → No games loaded into projections → Cannot calculate conference games remaining → No imbalance visible YET, but also no valid projections.

When data IS populated, imbalance will occur if the `is_conference` flag is incorrect for any game.

## Why This Matters

The projection system shows `conf_games_remaining` per team (line in PlayoffProjections.jsx:170).

**Rule:** For all teams in a conference, this must be true:
```
(conf_wins + conf_losses) + conf_games_remaining = SAME NUMBER
```

Why? Every conference game involves exactly 2 teams, so both must count it.

## The Detection System (3-tier)

1. **Sidearm HTML parsing** (unreliable) - looks for data-is-conference attribute
2. **Database validation** (authoritative) - checks if home_team and away_team share conference_id
3. **Counting games** - sums games where is_conference=true

## What To Do Now

### Immediate:

1. Run the scraper to populate games:
```bash
cd /sessions/adoring-upbeat-brown/mnt/pnw-baseball
PYTHONPATH=backend python3 scripts/scrape_future_schedules.py --season 2026
```

2. Run the diagnostic to check for imbalances:
```bash
python3 diagnose_conf_imbalance.py
```

### If Imbalance Is Found:

The diagnostic will show exactly which conference, how many games each team has remaining, and which games are causing the imbalance.

Look for:
- Teams in the same conference with different game counts
- Games listed as "causing imbalance" by the diagnostic
- Check if those games should really be conference games (both teams in same conference?)

### Root Causes (in priority order):

1. **Team not in database** - A team is being scraped but doesn't have a row in the database
   - Fix: Add team to database with correct conference_id

2. **Team not in team_map** - Team exists in database but scraper doesn't know about it
   - Fix: Update SIDEARM_TEAMS or NWAC_TEAM_SLUGS in scraper

3. **Wrong conference_id in database** - Team was moved to wrong conference
   - Fix: Update teams.conference_id in database

4. **Game wasn't scraped** - A scheduled conference game is missing entirely
   - Fix: Check team's website - may need to debug website parsing

5. **Cross-conference game marked as conference** - Exhibition or neutral opponent marked wrong
   - Fix: Database validation (line 904 in scraper) should catch this automatically

## The Code That Matters

File: `/sessions/adoring-upbeat-brown/mnt/pnw-baseball/scripts/scrape_future_schedules.py`

Lines 884-912 are the CORRECT logic:
```python
for g in all_games:
    home_id = g.get("home_team_id")
    away_id = g.get("away_team_id")
    if home_id and away_id:
        home_conf = team_conf_map.get(home_id)
        away_conf = team_conf_map.get(away_id)
        if home_conf and away_conf and home_conf == away_conf:
            g["is_conference"] = True   # <-- CORRECT: same conference
        else:
            g["is_conference"] = False  # <-- CORRECT: not same conference
```

This validates every game after scraping by checking the database.

## Files to Reference

- Diagnostic: `diagnose_conf_imbalance.py` (I created this for you)
- Full diagnosis: `DIAGNOSIS_CONFERENCE_IMBALANCE.md` (detailed analysis)
- Scraper: `scripts/scrape_future_schedules.py` (where is_conference is set)
- Projections: `backend/app/stats/projections.py` (where it's counted, line 451)
- Frontend: `frontend/src/pages/PlayoffProjections.jsx` (where it's displayed, line 170)
