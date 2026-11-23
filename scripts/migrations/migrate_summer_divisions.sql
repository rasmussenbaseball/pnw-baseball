-- ============================================================
-- Summer league division support
--
-- WCL splits North / South for regular-season standings. Add a
-- division column + seed the 17 WCL teams. Idempotent.
-- ============================================================

ALTER TABLE summer_teams
    ADD COLUMN IF NOT EXISTS division TEXT;

CREATE INDEX IF NOT EXISTS idx_summer_teams_division
    ON summer_teams(league_id, division);

-- ── WCL 2026 division alignment ─────────────────────────────────
-- Source: westcoastleague.com (Aug 2025 realignment with Marion +
-- Springfield filling Yakima/Cowlitz/Walla Walla holes in South).
-- These match the 17 active WCL clubs as of the 2026 preseason.

-- NORTH (8 teams)
UPDATE summer_teams SET division = 'North'
WHERE league_id = (SELECT id FROM summer_leagues WHERE abbreviation = 'WCL')
  AND short_name IN ('Riverhawks', 'NorthPaws', 'Falcons', 'NightOwls',
                     'Lefties', 'HarbourCats', 'AppleSox', 'Bells');

-- SOUTH (9 teams)
UPDATE summer_teams SET division = 'South'
WHERE league_id = (SELECT id FROM summer_leagues WHERE abbreviation = 'WCL')
  AND short_name IN ('Elks', 'Knights', 'Bears', 'Berries',
                     'Pickles', 'Raptors', 'Drifters', 'Sweets', 'Pippins');
