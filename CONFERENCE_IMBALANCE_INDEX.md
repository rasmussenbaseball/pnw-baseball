# Conference Game Count Imbalance - Analysis & Diagnostic Tools

## Quick Links

**START HERE:** Read `ANALYSIS_SUMMARY.txt` for a 5-minute overview

**For Step-by-Step Debugging:** See `DEBUG_STEPS.md`

**For Technical Deep Dive:** See `DIAGNOSIS_CONFERENCE_IMBALANCE.md`

**For Data Flow Visualization:** See `DATA_FLOW_ANALYSIS.md`

**For Quick One-Pager:** See `QUICK_FIX.md`

## The Problem

Conference game counts in playoff projections are imbalanced. When displaying projected standings, some teams in the same conference show different numbers of remaining conference games.

**Rule:** For all teams in a conference:
```
(conf_wins + conf_losses) + conf_games_remaining = CONSTANT
```

If this is violated, projections are incorrect.

## Root Cause

The `is_conference` flag in `future_schedules.json` is either:
1. **Not populated yet** (file is empty - current state), or
2. **Incorrectly flagged** for some games (what causes imbalance once data exists)

## The Solution

Three steps:

1. **Run the scraper** to populate `future_schedules.json`:
   ```bash
   cd /sessions/adoring-upbeat-brown/mnt/pnw-baseball
   export PYTHONPATH=backend
   python3 scripts/scrape_future_schedules.py --season 2026
   ```

2. **Run the diagnostic** to check for imbalances:
   ```bash
   python3 diagnose_conf_imbalance.py
   ```

3. **If imbalanced**, follow `DEBUG_STEPS.md` to identify and fix the root cause

## Provided Tools

### 1. `diagnose_conf_imbalance.py` (Created for this analysis)

**Purpose:** Validates that all teams in each conference have the same `conf_games_remaining` count

**Usage:**
```bash
python3 diagnose_conf_imbalance.py
```

**Output:**
- Lists each conference
- Shows game count per team
- Highlights imbalances
- Lists exact games causing the problem

**Status:** Ready to use after scraper populates `future_schedules.json`

## Documentation Files

### ANALYSIS_SUMMARY.txt (Start here!)
- 5-minute executive summary
- High-level overview
- Quick reference guide for all key files

### QUICK_FIX.md
- One-page summary
- What to do now
- Common root causes
- Quick reference to key files

### DIAGNOSIS_CONFERENCE_IMBALANCE.md (Comprehensive)
- Full technical analysis
- How the system works
- Three-tier detection system
- Database validation logic
- All code explanations
- Expected behavior

### DATA_FLOW_ANALYSIS.md (Visual)
- Complete data flow diagram
- The imbalance rule with math
- Five imbalance scenarios
- How to verify data checksums
- Verification checklist

### DEBUG_STEPS.md (Operational)
- Step-by-step debugging guide
- Commands to run at each phase
- Root cause investigation procedures
- Specific fixes for each scenario
- Validation commands
- Red flags to watch for

## Key Code Locations

**Scraper (creates future_schedules.json):**
```
/sessions/adoring-upbeat-brown/mnt/pnw-baseball/scripts/scrape_future_schedules.py
Lines 884-912: Database validation of is_conference (THE CRITICAL PART)
```

**Projections (uses the is_conference flag):**
```
/sessions/adoring-upbeat-brown/mnt/pnw-baseball/backend/app/stats/projections.py
Line 451: Counts conference games remaining
Lines 148-242: project_remaining_games()
Lines 385-474: build_projected_standings()
```

**API Endpoint:**
```
/sessions/adoring-upbeat-brown/mnt/pnw-baseball/backend/app/api/routes.py
Lines 1948-2079: /playoff-projections endpoint
```

**Frontend Display:**
```
/sessions/adoring-upbeat-brown/mnt/pnw-baseball/frontend/src/pages/PlayoffProjections.jsx
Line 170: Displays conf_games_remaining
```

## Five Imbalance Scenarios

1. **Game Never Scraped** - Website doesn't list it or parser can't read it
2. **Team Not in Team Map** - Exists in database but scraper doesn't know about it
3. **Wrong Conference ID in Database** - Team moved but database wasn't updated
4. **Duplicate Games with Different Flags** - Same game appears twice with different is_conference values
5. **Cross-Conference Game Mislabeled** - Exhibition/neutral opponent marked as conference game

Each has a specific debug procedure and fix in `DEBUG_STEPS.md`.

## Current Status

- **Database:** READY - 87 teams with correct conference assignments
- **future_schedules.json:** EMPTY - Needs scraper to run
- **Projection System:** READY - Code is correct, just needs data
- **Diagnostic Tool:** READY - Can identify imbalances once data exists

## Next Steps (In Order)

1. Read `ANALYSIS_SUMMARY.txt` (5 minutes)
2. Run scraper: `python3 scripts/scrape_future_schedules.py --season 2026`
3. Run diagnostic: `python3 diagnose_conf_imbalance.py`
4. If balanced → Done!
5. If imbalanced → Read `DEBUG_STEPS.md` and follow the procedures

## Expected Result When Fixed

```
CONFERENCE: Northwest Conference
Conference games remaining analysis:
  BALANCED: All teams have 8 conference games remaining

CONFERENCE: NWAC North Division
Conference games remaining analysis:
  BALANCED: All teams have 5 conference games remaining

...

SUMMARY
All conferences have balanced conference game counts!
```

## Questions?

Check the relevant documentation:
- "How does the system work?" → `DIAGNOSIS_CONFERENCE_IMBALANCE.md`
- "What's the data flow?" → `DATA_FLOW_ANALYSIS.md`
- "How do I debug?" → `DEBUG_STEPS.md`
- "Give me the overview" → `ANALYSIS_SUMMARY.txt`
- "Just tell me what to do" → `QUICK_FIX.md`

## File Locations

All analysis and tools are in:
```
/sessions/adoring-upbeat-brown/mnt/pnw-baseball/
```

- `diagnose_conf_imbalance.py` - Diagnostic tool
- `ANALYSIS_SUMMARY.txt` - This index and quick ref
- `QUICK_FIX.md` - One-page summary
- `DIAGNOSIS_CONFERENCE_IMBALANCE.md` - Technical deep dive
- `DATA_FLOW_ANALYSIS.md` - Data flow + math + scenarios
- `DEBUG_STEPS.md` - Step-by-step procedures

And the core files being analyzed:
- `backend/data/future_schedules.json` - The data source (currently empty)
- `backend/data/pnw_baseball.db` - The team/conference database
- `scripts/scrape_future_schedules.py` - The scraper (creates above)
- `backend/app/stats/projections.py` - The projection engine
- `backend/app/api/routes.py` - The API that serves projections
- `frontend/src/pages/PlayoffProjections.jsx` - The display layer

---

Created: April 6, 2026
Analysis: Deep investigation of conference game count imbalance in playoff projections
Tools: Diagnostic script to validate conference game balance across all conferences
