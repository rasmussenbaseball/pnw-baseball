# Player Matching Diagnosis Tools

This directory contains diagnostic scripts and reports for investigating why box score game logs aren't matching to players in the database.

## Files Included

### Python Diagnostic Scripts

1. **diagnose_player_matching.py** — Primary diagnostic queries
   - Query 1: Total NULL vs matched player_id counts by table
   - Query 2: Teams with most NULL player_ids (top 20)
   - Query 3: Sample player names with NULL player_id from top 5 teams
   - Query 4: Name comparison between unmatched box score names and players table
   - Query 5: Player name format analysis (comma vs space separated)

   **Usage**:
   ```bash
   cd /sessions/adoring-upbeat-brown/mnt/pnw-baseball
   PYTHONPATH=backend python diagnose_player_matching.py
   ```

2. **diagnose_data_corruption.py** — Deep corruption pattern analysis
   - Analysis 1: 'b' prefix corruption patterns (4,234 rows found!)
   - Analysis 2: Name abbreviation patterns
   - Analysis 3: Special characters and suffixes
   - Analysis 4: Duplicate player names with different player_ids
   - Analysis 5: Same player appearing both matched and unmatched

   **Usage**:
   ```bash
   cd /sessions/adoring-upbeat-brown/mnt/pnw-baseball
   PYTHONPATH=backend python diagnose_data_corruption.py
   ```

### SQL Cleanup Script

3. **fix_player_name_corruption.sql** — Fixes corrupted player names
   - Removes 'b' and 'B' prefixes from player names
   - Verifies corruption before and after
   - Shows examples of cleaned data
   - Includes optional name format normalization

   **Usage**:
   ```bash
   # Test on development database first
   psql $DATABASE_URL < fix_player_name_corruption.sql

   # Verify results
   psql $DATABASE_URL -c "SELECT COUNT(*) FROM game_batting WHERE player_name LIKE 'b%';"
   ```

### Reports

4. **PLAYER_MATCHING_DIAGNOSIS.md** — Executive summary report
   - Key findings and statistics
   - Teams with worst matching problems
   - Sample unmatched player names
   - Root cause analysis
   - Recommendations (short, medium, long-term)

5. **PLAYER_MATCHING_FULL_REPORT.md** — Comprehensive technical report
   - Detailed findings with tables and examples
   - Data corruption pattern analysis
   - Architecture issues
   - Impact assessment
   - Specific SQL recommendations

6. **DIAGNOSIS_README.md** — This file

## Quick Start

### 1. Run Diagnostics

Run both diagnostic scripts to assess the situation:

```bash
PYTHONPATH=backend python diagnose_player_matching.py
PYTHONPATH=backend python diagnose_data_corruption.py
```

This will generate output like:

```
PLAYER MATCHING DIAGNOSIS
================================================================================

QUERY 1: Total rows vs NULL player_id (season 2026)
  Table: game_batting
    Total rows: 19,918
    NULL player_id: 16,401
    Percentage NULL: 82.34%

  Table: game_pitching
    Total rows: 4,772
    NULL player_id: 3,358
    Percentage NULL: 70.37%

[... more details ...]
```

### 2. Review Reports

Read the summary report first:
```bash
cat PLAYER_MATCHING_DIAGNOSIS.md
```

Then dive into technical details:
```bash
cat PLAYER_MATCHING_FULL_REPORT.md
```

### 3. Fix Corruption (Optional - Next Week)

When ready to clean data:

```bash
# First verify what will be changed
psql $DATABASE_URL -c "
SELECT COUNT(*) as corrupted_rows
FROM game_batting gb
JOIN games g ON gb.game_id = g.id
WHERE g.season = 2026
AND player_id IS NULL
AND gb.player_name LIKE 'b%';"

# Then run the cleanup
psql $DATABASE_URL < fix_player_name_corruption.sql

# Verify cleanup succeeded
PYTHONPATH=backend python diagnose_player_matching.py
```

## Key Findings Summary

### The Problem

- **82.34%** of batting stats (16,401 rows) have NULL player_id
- **70.37%** of pitching stats (3,358 rows) have NULL player_id
- **4,234 rows (25.8%)** have corrupted names with 'b' or 'B' prefix
- **15 cases** where same player name is both matched and unmatched (inconsistent)

### The Root Causes

1. **Scraper data corruption** — 'b' prefix concatenated to player names
2. **Missing players** — Visiting team players not in database
3. **Name format mismatch** — Parser uses "Last, First" but players table expects "First Last"
4. **Abbreviations** — "A. Moon" vs "Austin Moon" can't be matched
5. **Inconsistent matching** — Same player sometimes matched, sometimes not

### The Impact

- Leaderboards don't work (no aggregation by player)
- Player pages can't display stats (no player_id link)
- Individual stat tracking is impossible
- Exports/API output is unusable

## Recommendations

### This Week
1. Run diagnostics to confirm findings
2. Review reports with team
3. Decide on cleanup approach

### Next Week
1. Remove 'b' prefix corruption (run fix_player_name_corruption.sql)
2. Implement name format normalization
3. Fix scraper to prevent future corruption

### Long-term
1. Build player name matching algorithm (fuzzy matching)
2. Implement fallback player creation at scraper stage
3. Add visiting team rosters to database
4. Build player resolution service

## Database Connection

Scripts use:
```python
from app.models.database import get_connection()
```

This connects via `DATABASE_URL` environment variable from `.env` file.

Verify connection works:
```bash
cd /sessions/adoring-upbeat-brown/mnt/pnw-baseball
PYTHONPATH=backend python -c "from app.models.database import get_connection;
with get_connection() as conn:
    cur = conn.cursor()
    cur.execute('SELECT COUNT(*) as total FROM games WHERE season = 2026')
    print(cur.fetchone())"
```

## Troubleshooting

### "ModuleNotFoundError: No module named 'app'"

Make sure you're in the right directory and using the correct PYTHONPATH:
```bash
cd /sessions/adoring-upbeat-brown/mnt/pnw-baseball
PYTHONPATH=backend python diagnose_player_matching.py
```

### "psycopg2.OperationalError: could not connect"

Check that DATABASE_URL is set in .env:
```bash
cat .env | grep DATABASE_URL
```

If not set, the script will fail. Make sure Supabase is accessible.

### Need to see specific team's data?

Edit the query in the Python script to filter by team:
```python
# In diagnose_player_matching.py, modify Query 2:
cur.execute("""
    SELECT ...
    WHERE t.short_name = 'C of I'  # Change this team
    ...
""")
```

## Next Steps

1. **Today**: Run `diagnose_player_matching.py` and `diagnose_data_corruption.py`
2. **This week**: Review reports and plan fix approach
3. **Next week**: Run cleanup scripts and verify improvement
4. **Long-term**: Implement player name matching algorithm

## Questions?

Check the reports for detailed analysis:
- Quick summary: `PLAYER_MATCHING_DIAGNOSIS.md`
- Technical details: `PLAYER_MATCHING_FULL_REPORT.md`
- Specific data: Run the Python scripts again with modifications

---

**Created**: 2026-04-07
**Status**: Investigation Complete - Diagnostics Ready
**Action Required**: YES - Data cleanup needed
