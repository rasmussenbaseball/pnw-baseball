-- ─────────────────────────────────────────────────────────────────
-- Migration: fine-grained field zone for the spray chart
-- ─────────────────────────────────────────────────────────────────
-- Phase F: 8 zones (vs Phase E's 3) so we can render a Statcast-style
-- fan chart. NULL when location can't be parsed (same fallback as
-- field_zone).
--
-- Zones:
--   Outfield arc (5):   LF, LC, CF, RC, RF
--   Infield wedges (3): IF_LEFT (3B/SS),
--                       IF_MID  (P/2B/C/up the middle),
--                       IF_RIGHT (1B)
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE game_events
    ADD COLUMN IF NOT EXISTS field_zone_fine TEXT;

ALTER TABLE game_events
    DROP CONSTRAINT IF EXISTS game_events_field_zone_fine_chk,
    ADD CONSTRAINT game_events_field_zone_fine_chk
        CHECK (field_zone_fine IS NULL OR field_zone_fine IN
               ('LF','LC','CF','RC','RF',
                'IF_3B','IF_SS','IF_MID','IF_1B','IF_C'));

-- Spray-chart aggregation index (per batter, per zone)
CREATE INDEX IF NOT EXISTS game_events_spray_fine_idx
    ON game_events (batter_player_id, field_zone_fine)
    WHERE field_zone_fine IS NOT NULL;

-- Same for pitcher (opponent contact)
CREATE INDEX IF NOT EXISTS game_events_pitcher_spray_fine_idx
    ON game_events (pitcher_player_id, field_zone_fine)
    WHERE field_zone_fine IS NOT NULL;

SELECT column_name FROM information_schema.columns
WHERE table_name = 'game_events' AND column_name = 'field_zone_fine';
