-- Migration 04: Add partial unique index on game_batting(game_id, player_id)
--
-- Mirrors migration 03 (game_pitching). Prevents the same duplicate-row bug
-- where two scrapers inserting the same batter for the same game under
-- different name formats produced two rows with the same player_id.
-- Duplicate batting rows inflate per-game box score totals (AB, H, HR, etc.)
-- in game detail views even though team-level season aggregates already sum
-- from batting_stats (the canonical per-player season table).
--
-- Partial predicate (WHERE player_id IS NOT NULL) preserves legitimate
-- orphan rows where player_id IS NULL (opposing-team batters whose rosters
-- we don't scrape). Multiple orphans per game are fine.
--
-- Prerequisite: run scripts/dedup_game_batting.py first to remove any existing
-- duplicates. This CREATE INDEX will fail if duplicates still exist.
--
-- Apply (on Mac, against prod DB via .env):
--   psql "$DATABASE_URL" -f scripts/migrate_04_game_batting_unique.sql
--
-- Or on the server:
--   cd /opt/pnw-baseball
--   psql "$DATABASE_URL" -f scripts/migrate_04_game_batting_unique.sql

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_game_batting_game_player
  ON game_batting (game_id, player_id)
  WHERE player_id IS NOT NULL;

COMMIT;

-- Verify:
--   \d game_batting
-- Should show:  "uniq_game_batting_game_player" UNIQUE, btree (game_id, player_id) WHERE player_id IS NOT NULL
