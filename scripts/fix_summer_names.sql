-- Fix "x " prefix in summer player last names
-- Pointstreak marks released/inactive players with "x " before their name.
-- Our scraper stored this in last_name (e.g., "x Santana" instead of "Santana").

-- Preview affected rows first:
-- SELECT id, first_name, last_name FROM summer_players WHERE last_name LIKE 'x %';

-- Fix them:
UPDATE summer_players
SET last_name = LTRIM(SUBSTRING(last_name FROM 3)),
    updated_at = NOW()
WHERE last_name LIKE 'x %';
