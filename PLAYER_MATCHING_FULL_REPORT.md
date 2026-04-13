# Player Matching Diagnosis - Full Technical Report

**Date**: 2026-04-07
**Season**: 2026 (current)
**Database**: Supabase Postgres (pnwbaseballstats.com)
**Analysis Scripts**:
- `diagnose_player_matching.py` — Primary diagnostic queries
- `diagnose_data_corruption.py` — Deep corruption pattern analysis

---

## Executive Summary

The PNW Baseball database has a **critical player matching failure** for season 2026:

- **82.34%** of game_batting rows (16,401 of 19,918) have NULL player_id
- **70.37%** of game_pitching rows (3,358 of 4,772) have NULL player_id

Additionally, **4,234 rows (25.8%)** of unmatched records have corrupted player names with a 'b' or 'B' prefix, indicating scraper parsing errors.

**Impact**: Player statistics cannot be aggregated or displayed because they're not linked to player records. Leaderboards, player pages, and individual stat tracking are non-functional.

---

## Detailed Findings

### 1. Null player_id Distribution

#### game_batting (Season 2026)
- Total rows: 19,918
- NULL player_id: 16,401 (82.34%)
- Matched player_id: 3,517 (17.66%)

#### game_pitching (Season 2026)
- Total rows: 4,772
- NULL player_id: 3,358 (70.37%)
- Matched player_id: 1,414 (29.63%)

**Observation**: Pitching has better match rate (70% vs 82%), suggesting batting box scores include more non-roster players (e.g., from visiting teams).

---

### 2. Teams with Highest NULL Rates

| Rank | Team | NULL Count | % of Team's Stats |
|------|------|-----------|------------------|
| 1 | C of I | 719 | 82% |
| 2 | Corban | 509 | 81% |
| 3 | Warner Pacific | 485 | 80% |
| 4 | Pacific | 483 | 80% |
| 5 | Bushnell | 482 | 80% |
| 6 | SMU | 482 | 81% |
| 7 | NNU | 479 | 81% |
| 8 | UBC | 466 | 80% |
| 9 | LCSC | 461 | 81% |
| 10 | EOU | 459 | 81% |

**Observation**: Consistent 80-82% NULL rate across all teams. This suggests a **systemic matching problem**, not team-specific data issues.

---

### 3. Data Corruption Patterns

#### 3.1: 'b' Prefix Corruption (CRITICAL)

**Total corrupted rows**: 4,234 (25.8% of all NULL rows)

- Lowercase 'b' prefix: 3,481 (82.2% of corrupted)
- Uppercase 'B' prefix: 753 (17.8% of corrupted)

**Examples**:
```
bA. Banuelos
bA. Milton
bAaron Whobrey
bAchen III
bAdachi, Keitaro
bA. Flynn
bB. Young
bBaruch II
```

**Root Cause**: Parser likely concatenates a batch/inning indicator ('b' for batting?) to player names, corrupting the data at insertion time.

**Impact**: These 4,234+ rows cannot be matched to the players table because the names are malformed. Even if matching algorithm fixed the NULL player_id, these corrupted names would prevent matches.

---

#### 3.2: Name Format Inconsistency

**Unmatched player names (NULL player_id) breakdown**:

| Format | Count | Percentage |
|--------|-------|-----------|
| Last, First (comma) | 9,535 | 58.2% |
| Other formats | 3,782 | 23.1% |
| First Last (full names) | 1,800 | 11.0% |
| Initial. Last | 1,264 | 7.7% |

**Key Issues**:

1. **Name format split**: 58% use "Last, First" but 19% use "First Last"
2. **Abbreviated names**: 1,264 rows use "Initial. Last" format (e.g., "A. Banuelos")
3. **Unidentified format**: 3,782 rows are "Other", including corrupted names and variations

**Matching Problem**: The players table likely stores names as "First Last". Matching algorithm cannot reliably convert:
- "Last, First" → "First Last" (formatting)
- "A. Moon" → "Austin Moon" (abbreviation expansion)
- "bA. Banuelos" → "A. Banuelos" → valid name (corruption removal)

---

#### 3.3: Special Characters and Suffixes

| Pattern | Count |
|---------|-------|
| No special chars | 15,987 |
| Hyphenated names | 218 |
| Apostrophes | 112 |
| Suffix: Jr | 63 |
| Suffix: II | 11 |
| Suffix: III | 10 |

**Examples with suffixes**:
```
Achen III
bAchen III
Baruch II
bBaruch II
Cruz Jr., Mikey
David Lally Jr.
Lally Jr., David
bTrippy Jr., Gino
```

**Matching Problem**: Suffixes add complexity. Players table may store "David Lally" while box score shows "David Lally Jr." — fuzzy matching needed.

---

#### 3.4: Same Player Appearing Both Matched and Unmatched (CRITICAL)

15 examples found where the SAME player name appears with both:
- NULL player_id (8-24 NULL rows)
- Matched player_id (10-24 matched rows)
- All mapped to same player_id when matched

**Examples**:
```
'Sam Decarlo'
  - NULL rows: 8
  - Matched rows: 24
  - Always maps to same player_id (1 distinct ID)

'Braeden Terry'
  - NULL rows: 8
  - Matched rows: 24
  - Always maps to same player_id (1 distinct ID)

'Cowan, Ty' vs 'Ty Cowan'
  - NULL rows: 8
  - Matched rows: 10
  - Both match to SAME player ID
```

**Critical Insight**: The matching algorithm is **inconsistent**. Same player name is sometimes matched, sometimes not. This indicates:
- Matching algorithm is nondeterministic (different logic for different rows)
- OR data was loaded in batches with inconsistent matching
- OR matching was added later, only updating some rows

---

### 4. Missing Players in Database

All sampled unmatched player names showed **NO MATCH** in the players table when searched by name. This means:

1. Players from visiting/opponent teams are not in the database
2. Player rosters were incomplete when games were scraped
3. New players appear in box scores but were never added to players table

**Examples of unmatchable names**:
- A. Banuelos (College of Idaho)
- Adachi, Keitaro (Corban)
- Anthony Karagiannopoulos (Bushnell)
- Alex Nisbet (Warner Pacific)
- Jayger Baldwin (Pacific)

These players either:
- Don't exist in the database (visiting team players)
- Exist but with different name format/spelling
- Never had player records created

---

## Root Cause Analysis

### Primary Causes (in priority order)

1. **Systemic Missing Players (82.34% of batting NULLs)**
   - Box scores include players not yet in players table
   - Scrapers run before roster data is available
   - No fallback: player record creation at game insert time

2. **Scraper Data Corruption (25.8% of NULLs)**
   - 'b' prefix contamination indicates parsing bug
   - Likely concatenating batch/inning markers to player names
   - Happens at scraper stage, not matching stage

3. **Name Format Inconsistency (58% are "Last, First")**
   - Parsers produce mixed formats
   - players table expects "First Last"
   - Matching algorithm incomplete or skipped

4. **Inconsistent Matching Logic (same name split NULL/matched)**
   - Some rows of same player matched, some not
   - Suggests batched updates with inconsistent logic
   - OR matching added after some games ingested

5. **Abbreviations Not Handled (7.7% are "Initial. Last")**
   - "A. Moon" cannot match to "Austin Moon"
   - players table has full names, box scores abbreviated
   - No fuzzy/probabilistic matching in place

---

## Architecture Issues

### Current Data Flow Problem

```
Box Score Scraper
  ↓
  ├─ Parses player names (produces: "bA. Moon", "A. Moon", "Moon, Alex")
  ├─ Looks up player_id in players table
  └─ If not found → inserts game_batting/game_pitching with NULL player_id

Players Table
  └─ Incomplete roster data (missing visiting team players)
  └─ Stores names as "First Last" format
```

### Why Matching Fails

1. **Format mismatch**: Parser produces "Last, First" but players table is "First Last"
2. **Abbreviation mismatch**: Parser: "A. Moon", Players table: "Austin Moon"
3. **Corruption**: Parser: "bA. Moon", Players table: "A. Moon" (no 'b' prefix)
4. **Missing records**: Some players never added to players table
5. **No fallback logic**: If not found, data is lost (NULL), not recovered

---

## Impact Assessment

| Component | Status | Impact |
|-----------|--------|--------|
| Game-level stats | ✓ Working | Batting team totals available |
| Player-level stats | ✗ Broken | 82% of batting stats orphaned |
| Leaderboards | ✗ Broken | Cannot aggregate by player |
| Player pages | ✗ Broken | Cannot display individual stats |
| Team statistics | ~ Partial | Team totals work, but missing individual breakdown |
| Export/API | ✗ Broken | Player stats unusable |
| Trending/Analysis | ✗ Broken | Cannot track individual performance |

---

## Recommendations

### Immediate (This Week)

1. **Remove data corruption** (4,234 rows, 25 minutes)
   ```sql
   UPDATE game_batting
   SET player_name = LTRIM(RTRIM(player_name, ' '), 'bB')
   WHERE player_name ~ '^[bB]'
   AND season = 2026;

   UPDATE game_pitching
   SET player_name = LTRIM(RTRIM(player_name, ' '), 'bB')
   WHERE player_name ~ '^[bB]'
   AND season = 2026;
   ```

2. **Normalize name format** (reformat "Last, First" → "First Last")
   ```sql
   -- Example logic
   UPDATE game_batting
   SET player_name = CONCAT(
       TRIM(SUBSTRING_INDEX(player_name, ',', -1)),
       ' ',
       TRIM(SUBSTRING_INDEX(player_name, ',', 1))
   )
   WHERE player_name LIKE '%,%'
   AND season = 2026;
   ```

3. **Disable broken scraper** until data pipeline fixed

---

### Short-term (1-2 Weeks)

1. **Fix scraper to validate names**
   - Remove 'b' prefix before storing
   - Normalize format to "First Last"
   - Validate against known rosters

2. **Implement fallback player creation**
   ```python
   if player_id is None:
       # Try fuzzy matching
       player_id = fuzzy_match_player(name, team_id)

       if player_id is None:
           # Create new player record
           player_id = create_player(name, team_id, is_temp=True)
   ```

3. **Add player name matching algorithm**
   - Handle "Last, First" ↔ "First Last" conversion
   - Handle abbreviations (A. Moon → Austin Moon)
   - Use Levenshtein distance for typos
   - Return confidence score

---

### Medium-term (1 Month)

1. **Historical data recovery**
   - Apply name cleanup to all corrupted rows
   - Attempt retroactive matching with fuzzy algorithm
   - Flag uncertain matches for manual review

2. **Build audit system**
   - Track auto-matched vs manual-matched player_ids
   - Allow corrections without re-scraping
   - Log match confidence scores

3. **Improve players table**
   - Add visiting team rosters
   - Add alternate names (nicknames, name changes)
   - Add birth date for disambiguation

---

### Long-term (Architecture)

1. **Separate internal IDs from external data**
   - Store raw box score player name alongside matched player_id
   - Allow multiple names to map to same player
   - Enable corrections without scraper changes

2. **Implement confidence-based matching**
   - Use probabilistic name matching
   - Assign confidence scores to all matches
   - Manual review workflow for uncertain matches

3. **Build player resolution service**
   - Centralized name → player_id lookup
   - Fuzzy matching engine
   - Caching layer for performance

---

## Query Details for Verification

All analysis used:
- WHERE season = 2026 (current year only)
- Joined through games table to filter by season
- Grouped by team short_name for problem identification
- Limited to reasonable samples for performance

Scripts:
- **diagnose_player_matching.py**: 5 main queries analyzing NULL rates, teams, names, formats
- **diagnose_data_corruption.py**: 5 detailed analyses of corruption patterns

**Run with**:
```bash
cd /sessions/adoring-upbeat-brown/mnt/pnw-baseball
PYTHONPATH=backend python diagnose_player_matching.py
PYTHONPATH=backend python diagnose_data_corruption.py
```

---

## Next Steps

1. Run data cleanup scripts (remove 'b' prefix, normalize format)
2. Test retroactive matching on cleaned data
3. Fix scraper to prevent future corruption
4. Implement fallback player creation
5. Build player name matching algorithm
6. Schedule recovery work for high-priority teams (C of I, Corban, etc.)

---

## Appendices

### Appendix A: Sample Corrupted Names
```
bA. Banuelos           bA. Angevine          bAaron Whobrey
bA. Milton             bA. Arecchi           bAchen III
bA. Moon               bA. Bazan             bAdachi, Keitaro
bB. Young              bB. Russell           bB. Valladao
bAustin Moon           bAustin Paul          bAustin Nisbet
bBrennan Aoki          bBaron Delameter      bC. Rohlmeier
bCade Westerlund       bChris Arce           bChris Mitchell
bFranco, Jr            bGino Trippy Jr       bPhillip Swinford III
```

### Appendix B: Same-Name Split Examples
```
'Sam Decarlo'
  - NULL: 8 rows → NOT MATCHED
  - Matched: 24 rows → Mapped to player_id X

'Braeden Terry'
  - NULL: 8 rows → NOT MATCHED
  - Matched: 24 rows → Mapped to player_id X

'Ty Cowan' vs 'Cowan, Ty'
  - NULL: 8 rows → NOT MATCHED (both formats)
  - Matched: 10 rows → Both map to same player_id X
```

### Appendix C: Missing Player Examples
```
Looking for: A. Banuelos (C of I, team_id = X)
  → No match in players table

Looking for: Adachi, Keitaro (Corban, team_id = Y)
  → No match in players table

Looking for: Anthony Karagiannopoulos (Bushnell, team_id = Z)
  → No match in players table
```

---

**Report Generated**: 2026-04-07
**Analysis Completed**: 100%
**Action Required**: YES - CRITICAL

