-- Link summer players to spring players where the summer player matched
-- multiple spring records that are all the SAME person (transfers).
-- Uses player_links.canonical_id to pick one consistent spring ID.

-- Only process summer players that don't already have a link
WITH unlinked_summer AS (
    SELECT sp.id as summer_id, sp.first_name, sp.last_name
    FROM summer_players sp
    WHERE NOT EXISTS (
        SELECT 1 FROM summer_player_links spl WHERE spl.summer_player_id = sp.id
    )
    AND LENGTH(sp.first_name) > 2
),
-- Find all spring matches for each unlinked summer player (full name match)
spring_matches AS (
    SELECT us.summer_id, us.first_name, us.last_name,
           p.id as spring_id,
           COALESCE(pl.canonical_id, p.id) as canonical_id
    FROM unlinked_summer us
    JOIN players p ON LOWER(p.first_name) = LOWER(us.first_name)
                  AND LOWER(p.last_name) = LOWER(us.last_name)
    LEFT JOIN player_links pl ON pl.linked_id = p.id
),
-- Count distinct canonical IDs per summer player
-- If all spring matches resolve to the same canonical, it's safe to link
grouped AS (
    SELECT summer_id, first_name, last_name,
           MIN(canonical_id) as canonical_id,
           COUNT(DISTINCT canonical_id) as distinct_persons,
           COUNT(*) as total_matches
    FROM spring_matches
    GROUP BY summer_id, first_name, last_name
)
INSERT INTO summer_player_links (summer_player_id, spring_player_id, confidence)
SELECT summer_id, canonical_id, 'auto_transfer'
FROM grouped
WHERE distinct_persons = 1
  AND total_matches > 1;
