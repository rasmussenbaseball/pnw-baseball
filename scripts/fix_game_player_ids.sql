-- Fix NULL player_ids in game_batting and game_pitching
-- by matching player names to the players table

-- game_batting: "First Last" format
UPDATE game_batting gb
SET player_id = p.id
FROM players p
WHERE gb.player_id IS NULL
  AND gb.team_id = p.team_id
  AND LOWER(TRIM(gb.player_name)) = LOWER(p.first_name || ' ' || p.last_name);

-- game_batting: "Last, First" format
UPDATE game_batting gb
SET player_id = p.id
FROM players p
WHERE gb.player_id IS NULL
  AND gb.team_id = p.team_id
  AND LOWER(TRIM(gb.player_name)) = LOWER(p.last_name || ', ' || p.first_name);

-- game_batting: partial match fallback (handles suffixes like "Jr.", middle initials, etc.)
UPDATE game_batting gb
SET player_id = sub.pid
FROM (
    SELECT DISTINCT ON (gb2.id) gb2.id as gbid, p.id as pid
    FROM game_batting gb2
    JOIN players p ON p.team_id = gb2.team_id
    WHERE gb2.player_id IS NULL
      AND (
        -- "First Last" where last name matches and first name starts with same chars
        (LOWER(SPLIT_PART(TRIM(gb2.player_name), ' ', 1)) = LOWER(p.first_name)
         AND LOWER(p.last_name) = LOWER(
           CASE WHEN POSITION(',' IN gb2.player_name) > 0
             THEN TRIM(SPLIT_PART(gb2.player_name, ',', 1))
             ELSE TRIM(REGEXP_REPLACE(gb2.player_name, '^\S+\s+', ''))
           END
         ))
      )
    ORDER BY gb2.id, p.id
) sub
WHERE gb.id = sub.gbid;

-- game_pitching: "First Last" format
UPDATE game_pitching gp
SET player_id = p.id
FROM players p
WHERE gp.player_id IS NULL
  AND gp.team_id = p.team_id
  AND LOWER(TRIM(gp.player_name)) = LOWER(p.first_name || ' ' || p.last_name);

-- game_pitching: "Last, First" format
UPDATE game_pitching gp
SET player_id = p.id
FROM players p
WHERE gp.player_id IS NULL
  AND gp.team_id = p.team_id
  AND LOWER(TRIM(gp.player_name)) = LOWER(p.last_name || ', ' || p.first_name);

-- game_pitching: partial match fallback
UPDATE game_pitching gp
SET player_id = sub.pid
FROM (
    SELECT DISTINCT ON (gp2.id) gp2.id as gpid, p.id as pid
    FROM game_pitching gp2
    JOIN players p ON p.team_id = gp2.team_id
    WHERE gp2.player_id IS NULL
      AND (
        (LOWER(SPLIT_PART(TRIM(gp2.player_name), ' ', 1)) = LOWER(p.first_name)
         AND LOWER(p.last_name) = LOWER(
           CASE WHEN POSITION(',' IN gp2.player_name) > 0
             THEN TRIM(SPLIT_PART(gp2.player_name, ',', 1))
             ELSE TRIM(REGEXP_REPLACE(gp2.player_name, '^\S+\s+', ''))
           END
         ))
      )
    ORDER BY gp2.id, p.id
) sub
WHERE gp.id = sub.gpid;

-- Report results
SELECT 'game_batting' as table_name,
       COUNT(*) as total,
       COUNT(player_id) as matched,
       COUNT(*) - COUNT(player_id) as still_missing
FROM game_batting
UNION ALL
SELECT 'game_pitching',
       COUNT(*),
       COUNT(player_id),
       COUNT(*) - COUNT(player_id)
FROM game_pitching;
