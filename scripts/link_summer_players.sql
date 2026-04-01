-- Link summer players to spring players.
-- Two-pass approach:
--   Pass 1: Full name match (high confidence) — for players with full first names from roster
--   Pass 2: Initial + last name match (lower confidence) — for players with only initials
-- Both passes only link when there is exactly ONE matching spring player.

-- Clear existing auto-matched links so we can re-run cleanly
DELETE FROM summer_player_links WHERE confidence IN ('auto', 'auto_initial');

-- ===========================================
-- PASS 1: Full first + last name match
-- Only for summer players with first_name longer than 2 chars (real names, not initials)
-- ===========================================
INSERT INTO summer_player_links (summer_player_id, spring_player_id, confidence)
SELECT
    sp.id AS summer_player_id,
    (SELECT p.id FROM players p
     WHERE LOWER(p.last_name) = LOWER(sp.last_name)
       AND LOWER(p.first_name) = LOWER(sp.first_name)
     LIMIT 1) AS spring_player_id,
    'auto' AS confidence
FROM summer_players sp
WHERE LENGTH(sp.first_name) > 2
  -- Exactly one spring player matches full name
  AND (SELECT COUNT(*) FROM players p
       WHERE LOWER(p.last_name) = LOWER(sp.last_name)
         AND LOWER(p.first_name) = LOWER(sp.first_name)) = 1
  -- Not already manually linked
  AND NOT EXISTS (
      SELECT 1 FROM summer_player_links spl
      WHERE spl.summer_player_id = sp.id AND spl.confidence = 'manual'
  )
ON CONFLICT (summer_player_id) DO NOTHING;

-- ===========================================
-- PASS 2: Initial + last name match (fallback)
-- For summer players with short first names (initials only)
-- ===========================================
INSERT INTO summer_player_links (summer_player_id, spring_player_id, confidence)
SELECT
    sp.id AS summer_player_id,
    (SELECT p.id FROM players p
     WHERE LOWER(p.last_name) = LOWER(sp.last_name)
       AND LOWER(LEFT(p.first_name, LENGTH(sp.first_name))) = LOWER(sp.first_name)
     LIMIT 1) AS spring_player_id,
    'auto_initial' AS confidence
FROM summer_players sp
WHERE LENGTH(sp.first_name) <= 2
  -- Exactly one spring player matches initial + last name
  AND (SELECT COUNT(*) FROM players p
       WHERE LOWER(p.last_name) = LOWER(sp.last_name)
         AND LOWER(LEFT(p.first_name, LENGTH(sp.first_name))) = LOWER(sp.first_name)) = 1
  -- Not already linked from pass 1 or manually
  AND NOT EXISTS (
      SELECT 1 FROM summer_player_links spl
      WHERE spl.summer_player_id = sp.id
  )
ON CONFLICT (summer_player_id) DO NOTHING;

-- ===========================================
-- Report results
-- ===========================================
SELECT 'Full name matches' AS type, COUNT(*) AS count
FROM summer_player_links WHERE confidence = 'auto'
UNION ALL
SELECT 'Initial matches' AS type, COUNT(*) AS count
FROM summer_player_links WHERE confidence = 'auto_initial'
UNION ALL
SELECT 'Total linked' AS type, COUNT(*) AS count
FROM summer_player_links
UNION ALL
SELECT 'Total summer players' AS type, COUNT(*) AS count
FROM summer_players
UNION ALL
SELECT 'Unlinked' AS type,
    (SELECT COUNT(*) FROM summer_players) - (SELECT COUNT(*) FROM summer_player_links) AS count;
