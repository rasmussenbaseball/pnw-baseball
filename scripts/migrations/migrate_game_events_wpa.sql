-- ─────────────────────────────────────────────────────────────────
-- Migration: per-event Win Probability Added (Phase D.5).
-- Adds wp_before, wp_after, wpa_batter, wpa_pitcher to game_events.
-- All nullable; populated by compute_wpa.py (and later by scrape_pbp).
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE game_events
    ADD COLUMN IF NOT EXISTS wp_before        DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS wp_after         DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS wpa_batter       DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS wpa_pitcher      DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS wpa_derived_at   TIMESTAMPTZ;

-- Player aggregation queries: sum wpa_batter / wpa_pitcher per player.
-- Partial indexes — only events that have been computed.
CREATE INDEX IF NOT EXISTS game_events_wpa_batter_idx
    ON game_events (batter_player_id)
    WHERE wpa_batter IS NOT NULL AND batter_player_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS game_events_wpa_pitcher_idx
    ON game_events (pitcher_player_id)
    WHERE wpa_pitcher IS NOT NULL AND pitcher_player_id IS NOT NULL;

-- Backfill driver: find games not yet WPA-derived
CREATE INDEX IF NOT EXISTS game_events_wpa_undrived_idx
    ON game_events (game_id)
    WHERE wpa_derived_at IS NULL;

-- Sanity check
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'game_events'
  AND column_name IN ('wp_before','wp_after','wpa_batter','wpa_pitcher','wpa_derived_at')
ORDER BY ordinal_position;
