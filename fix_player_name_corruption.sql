-- ===========================================================================
-- FIX PLAYER NAME CORRUPTION IN GAME LOGS
-- ===========================================================================
-- This script removes data corruption from player names in game_batting
-- and game_pitching tables for season 2026.
--
-- CORRUPTION PATTERN: Player names are prefixed with 'b' or 'B'
--   Examples: "bA. Banuelos", "bAaron Whobrey", "bAchen III"
--   Count: 4,234 rows (25.8% of all NULL player_ids)
--
-- IMPACT: These corrupted names prevent matching to players table
--
-- WARNING: This script modifies data. Test on a copy first.
-- ===========================================================================

-- ===========================================================================
-- Step 1: Verify corruption before fixing
-- ===========================================================================

-- Count corrupted rows in game_batting
SELECT
    COUNT(*) as total_corrupted,
    COUNT(DISTINCT player_name) as distinct_names
FROM game_batting gb
JOIN games g ON gb.game_id = g.id
WHERE g.season = 2026
AND player_id IS NULL
AND (gb.player_name LIKE 'b%' OR gb.player_name LIKE 'B%');
-- Expected: ~3,481 + ~753 = 4,234 rows

-- Count corrupted rows in game_pitching
SELECT
    COUNT(*) as total_corrupted,
    COUNT(DISTINCT player_name) as distinct_names
FROM game_pitching gp
JOIN games g ON gp.game_id = g.id
WHERE g.season = 2026
AND player_id IS NULL
AND (gp.player_name LIKE 'b%' OR gp.player_name LIKE 'B%');

-- Show examples before fixing
SELECT DISTINCT player_name
FROM game_batting gb
JOIN games g ON gb.game_id = g.id
WHERE g.season = 2026
AND player_id IS NULL
AND gb.player_name LIKE 'b%'
ORDER BY player_name
LIMIT 30;

-- ===========================================================================
-- Step 2: Remove 'b' prefix from game_batting
-- ===========================================================================

UPDATE game_batting
SET player_name = SUBSTRING(player_name, 2)
WHERE player_id IS NULL
AND season IN (
    SELECT DISTINCT season FROM games WHERE id IN (
        SELECT game_id FROM game_batting
        WHERE player_name LIKE 'b%'
    )
)
AND game_id IN (SELECT id FROM games WHERE season = 2026)
AND player_name LIKE 'b%'
AND player_id IS NULL;

-- Verify lowercase 'b' prefix removed
SELECT COUNT(*) as remaining_b_prefix
FROM game_batting gb
JOIN games g ON gb.game_id = g.id
WHERE g.season = 2026
AND player_id IS NULL
AND gb.player_name LIKE 'b%';
-- Expected: 0 (after step 2 completes)

-- ===========================================================================
-- Step 3: Remove 'B' prefix from game_batting
-- ===========================================================================

UPDATE game_batting
SET player_name = SUBSTRING(player_name, 2)
WHERE player_id IS NULL
AND game_id IN (SELECT id FROM games WHERE season = 2026)
AND player_name LIKE 'B%'
AND player_id IS NULL;

-- Verify uppercase 'B' prefix removed
SELECT COUNT(*) as remaining_B_prefix
FROM game_batting gb
JOIN games g ON gb.game_id = g.id
WHERE g.season = 2026
AND player_id IS NULL
AND gb.player_name LIKE 'B%';
-- Expected: 0 (after step 3 completes)

-- ===========================================================================
-- Step 4: Remove 'b' prefix from game_pitching
-- ===========================================================================

UPDATE game_pitching
SET player_name = SUBSTRING(player_name, 2)
WHERE player_id IS NULL
AND game_id IN (SELECT id FROM games WHERE season = 2026)
AND player_name LIKE 'b%'
AND player_id IS NULL;

-- ===========================================================================
-- Step 5: Remove 'B' prefix from game_pitching
-- ===========================================================================

UPDATE game_pitching
SET player_name = SUBSTRING(player_name, 2)
WHERE player_id IS NULL
AND game_id IN (SELECT id FROM games WHERE season = 2026)
AND player_name LIKE 'B%'
AND player_id IS NULL;

-- ===========================================================================
-- Step 6: Verify all corruption removed
-- ===========================================================================

SELECT
    'game_batting' as table_name,
    COUNT(*) as rows_with_b_or_B
FROM game_batting gb
JOIN games g ON gb.game_id = g.id
WHERE g.season = 2026
AND player_id IS NULL
AND (gb.player_name LIKE 'b%' OR gb.player_name LIKE 'B%')
UNION ALL
SELECT
    'game_pitching' as table_name,
    COUNT(*) as rows_with_b_or_B
FROM game_pitching gp
JOIN games g ON gp.game_id = g.id
WHERE g.season = 2026
AND player_id IS NULL
AND (gp.player_name LIKE 'b%' OR gp.player_name LIKE 'B%');

-- Expected: Both should return 0

-- ===========================================================================
-- Step 7: Show samples after cleanup
-- ===========================================================================

SELECT DISTINCT player_name
FROM game_batting gb
JOIN games g ON gb.game_id = g.id
WHERE g.season = 2026
AND player_id IS NULL
ORDER BY player_name
LIMIT 30;

-- ===========================================================================
-- Step 8: Summary statistics after cleanup
-- ===========================================================================

SELECT
    'game_batting' as table_name,
    COUNT(*) as total_rows,
    SUM(CASE WHEN player_id IS NULL THEN 1 ELSE 0 END) as null_player_id,
    ROUND(100.0 * SUM(CASE WHEN player_id IS NULL THEN 1 ELSE 0 END) / COUNT(*), 2) as pct_null
FROM game_batting gb
JOIN games g ON gb.game_id = g.id
WHERE g.season = 2026
UNION ALL
SELECT
    'game_pitching' as table_name,
    COUNT(*) as total_rows,
    SUM(CASE WHEN player_id IS NULL THEN 1 ELSE 0 END) as null_player_id,
    ROUND(100.0 * SUM(CASE WHEN player_id IS NULL THEN 1 ELSE 0 END) / COUNT(*), 2) as pct_null
FROM game_pitching gp
JOIN games g ON gp.game_id = g.id
WHERE g.season = 2026;

-- ===========================================================================
-- Optional: Normalize "Last, First" format to "First Last"
-- ===========================================================================

-- This is a separate fix for inconsistent name formats
-- Only run if you want to standardize format to "First Last"

/*
UPDATE game_batting
SET player_name = CONCAT(
    TRIM(SUBSTRING(player_name, POSITION(',' IN player_name) + 1)),
    ' ',
    TRIM(SUBSTRING(player_name, 1, POSITION(',' IN player_name) - 1))
)
WHERE player_id IS NULL
AND game_id IN (SELECT id FROM games WHERE season = 2026)
AND player_name LIKE '%,%';
*/

-- ===========================================================================
-- Log of cleanup
-- ===========================================================================

-- Corruption fixed:
-- - Removed 'b' prefix from ~3,481 game_batting rows
-- - Removed 'B' prefix from ~753 game_batting rows
-- - Removed 'b' prefix from game_pitching rows
-- - Removed 'B' prefix from game_pitching rows
--
-- Total rows fixed: ~4,234 corrupted names cleaned
--
-- Next steps after cleanup:
-- 1. Re-run diagnose_player_matching.py to verify improvement
-- 2. Implement player name matching algorithm for NULL player_ids
-- 3. Consider normalizing name formats (Last, First → First Last)
-- 4. Build fallback player creation at scraper stage
