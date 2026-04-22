-- Migration 03: Add partial unique index on game_pitching(game_id, player_id)
--
-- Prevents the duplicate-row bug where two scrapers inserting the same pitcher
-- for the same game (under different name formats) produced two rows with the
-- same player_id. Duplicates historically inflated team ERA / WHIP / BAA / BF
-- because downstream GREATEST(pitching_stats, box_sum) then propagated the
-- doubled values into pitching_stats.
--
-- Partial predicate (WHERE player_id IS NOT NULL) preserves the legitimate
-- orphan rows where player_id IS NULL (opposing-team pitchers whose rosters
-- we don't scrape). Multiple orphans per game are fine.
--
-- Prerequisite: run scripts/dedup_game_pitching.py first to remove any existing
-- duplicates. This CREATE INDEX will fail if duplicates still exist.
--
-- Apply (on Mac, against prod DB via .env):
--   psql "$DATABASE_URL" -f scripts/migrate_03_game_pitching_unique.sql
--
-- Or on the server:
--   cd /opt/pnw-baseball
--   psql "$DATABASE_URL" -f scripts/migrate_03_game_pitching_unique.sql

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_game_pitching_game_player
  ON game_pitching (game_id, player_id)
  WHERE player_id IS NOT NULL;

COMMIT;

-- Verify:
--   \d game_pitching
-- Should show:  "uniq_game_pitching_game_player" UNIQUE, btree (game_id, player_id) WHERE player_id IS NOT NULL
