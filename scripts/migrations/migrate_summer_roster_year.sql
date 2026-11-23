-- 2026-06: mark which summer_players are on a given season's official roster
-- (scraped from wclstats.com), so team pages can show the full current roster
-- instead of only players who appeared in a box score. Populated by
-- scripts/reconcile_wcl_rosters.py. Applied to prod 2026-06-03.
ALTER TABLE summer_players ADD COLUMN IF NOT EXISTS roster_year integer;
