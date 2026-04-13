# Player Matching Diagnosis Report

**Date**: 2026-04-07
**Script**: `diagnose_player_matching.py`
**Database**: Supabase Postgres (pnwbaseballstats.com)

## Executive Summary

The database has a **severe player matching problem** for season 2026:
- **82.34%** of game_batting rows (16,401 out of 19,918) have NULL player_id
- **70.37%** of game_pitching rows (3,358 out of 4,772) have NULL player_id

This means player statistics are not linked to player records, preventing accurate player stat calculations and leaderboards.

---

## Findings

### 1. Null player_id Distribution

**game_batting (season 2026)**:
- Total rows: 19,918
- NULL player_id: 16,401 (82.34%)

**game_pitching (season 2026)**:
- Total rows: 4,772
- NULL player_id: 3,358 (70.37%)

### 2. Teams with Worst Matching Problems (Top 20)

| Team | NULL Count | Issue Severity |
|------|-----------|------------------|
| C of I | 719 | CRITICAL |
| Corban | 509 | CRITICAL |
| Warner Pacific | 485 | CRITICAL |
| Pacific | 483 | CRITICAL |
| Bushnell | 482 | CRITICAL |
| SMU | 482 | CRITICAL |
| NNU | 479 | CRITICAL |
| UBC | 466 | CRITICAL |
| LCSC | 461 | CRITICAL |
| EOU | 459 | CRITICAL |
| OIT | 441 | CRITICAL |
| WOU | 433 | CRITICAL |
| Whitworth | 422 | CRITICAL |
| CWU | 412 | CRITICAL |
| Whitman | 403 | CRITICAL |
| Gonzaga | 402 | CRITICAL |
| Linfield | 380 | CRITICAL |
| Wash. St. | 371 | CRITICAL |
| MSUB | 355 | CRITICAL |
| PLU | 345 | CRITICAL |

### 3. Sample Unmatched Player Names

All sampled unmatched names from top 5 teams show **NO MATCH** in the players table, indicating the players don't exist in the database.

#### C of I (719 NULLs)
- A. Banuelos
- A. Demianew
- A. Moon
- Achen III
- Alvillar, Giovanny
- Ammerman, Ethan
- B. Mahlke
- bA. Banuelos (note: prefixed with 'b')
- bA. Milton
- bA. Moon

#### Corban (509 NULLs)
- A. Munoz
- A. Sherrell
- Adachi, Keitaro
- Anthony Karagiannopoulos
- Austin Moon
- B. Valladao
- B. Young
- bA. Flynn (note: prefixed with 'b')
- bA. Munoz
- bA. Sherrell

#### Warner Pacific, Pacific, Bushnell
Similar pattern: abbreviated names, full names, and names with 'b' prefix.

### 4. Name Format Issues Identified

**In game_batting (16,401 NULL rows)**:
- Last, First (comma format): 9,976 rows (60.83%)
- First Last (space format): 6,425 rows (39.17%)

**In game_pitching (3,358 NULL rows)**:
- Last, First (comma format): 1,971 rows (58.70%)
- First Last (space format): 1,387 rows (41.30%)

**Critical Observation**: Names are inconsistently formatted. Some use "Last, First" and some use "First Last", but many also have problematic patterns:
- Abbreviated first names (A. Banuelos, B. Young)
- Names with 'b' prefix (bA. Banuelos, bB. Young) - likely data corruption
- Suffixes not handled (Achen III)

---

## Root Cause Analysis

### Primary Issues

1. **Players don't exist in the players table**
   - The game_batting and game_pitching data is from box scores that include players not yet added to the players database
   - Non-PNW opponents and visiting teams' players are especially missing

2. **Data corruption in player names**
   - Names prefixed with 'b' (e.g., bA. Banuelos) indicate parsing errors
   - Likely from scraper issues when extracting from HTML

3. **Name format inconsistency**
   - Parser produces both "First Last" and "Last, First" formats
   - Matching algorithm would need to handle both, but doesn't

4. **Partial/abbreviated names**
   - Many names are abbreviated to first initial + last name (A. Banuelos)
   - players table likely has full first names
   - Matching on "A." to "Anthony" or "Austin" is ambiguous

---

## Impact

- **Leaderboards**: Cannot aggregate stats by player
- **Player pages**: Cannot display individual player statistics
- **Team analysis**: Can see team box scores but not individual performance
- **Export/reporting**: Statistics are orphaned without player context

---

## Recommendations

### Short-term (Data Cleanup)

1. **Remove 'b' prefix corruption**
   ```sql
   UPDATE game_batting
   SET player_name = SUBSTRING(player_name, 2)
   WHERE player_name LIKE 'b%'
   AND season = 2026;
   ```

2. **Add missing players to players table**
   - Extract distinct player names from game_batting with NULL player_id
   - Match them to roster data if available
   - Create records for unknown players

3. **Normalize name format**
   - Choose one format (recommend "First Last")
   - Parse "Last, First" format to "First Last"

### Medium-term (Scraper Fix)

1. Fix scraper to:
   - Detect and report data corruption (b prefix)
   - Standardize name format
   - Validate against known rosters before storing

2. Add roster validation step:
   - Match player names from box scores to team rosters
   - Flag unmatched names for manual review

3. Implement fallback player creation:
   - If name not in players table, create a new record
   - Link it immediately in game_batting/game_pitching

### Long-term (Architecture)

1. Separate internal player IDs from external box score data
   - Store "raw" box score player names alongside matched player_id
   - Allow for multiple names pointing to same player

2. Build player name matching algorithm
   - Handle abbreviations, typos, suffixes
   - Store confidence scores for matches

3. Add audit table
   - Track which player_ids are "auto-matched" vs manual
   - Allow for corrections without re-scraping

---

## Query Details

All queries used:
- WHERE season = 2026 (current year)
- Joined game_batting/game_pitching through games table to filter by season
- Grouped by team short_name to identify problem areas
- Limited to top 20 teams and 15 sample comparisons for readability

Script location: `/sessions/adoring-upbeat-brown/mnt/pnw-baseball/diagnose_player_matching.py`

Run again with:
```bash
cd /sessions/adoring-upbeat-brown/mnt/pnw-baseball
PYTHONPATH=backend python diagnose_player_matching.py
```
