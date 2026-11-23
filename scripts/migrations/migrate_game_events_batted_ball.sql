-- ─────────────────────────────────────────────────────────────────
-- Migration: batted-ball type + spray zone on game_events
-- ─────────────────────────────────────────────────────────────────
-- Phase E: parse batted-ball type (GB/FB/LD/PU) and field zone
-- (LEFT/CENTER/RIGHT) from the narrative we already store in
-- result_text. Combined with players.bats this gives us Pull / Center /
-- Oppo at API time, no extra column needed.
--
-- Both columns are nullable — populated only for in-play PAs (singles,
-- doubles, triples, HRs, ground/fly/line/pop outs, sac flies). For
-- non-contact PAs (K, BB, HBP) and sub-event rows, both stay NULL.
--
-- Idempotent: ADD COLUMN guarded by IF NOT EXISTS.
-- Run on Mac dev / prod (Supabase).
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE game_events
    ADD COLUMN IF NOT EXISTS bb_type    TEXT,
    ADD COLUMN IF NOT EXISTS field_zone TEXT,
    ADD COLUMN IF NOT EXISTS bb_derived_at TIMESTAMPTZ;

ALTER TABLE game_events
    DROP CONSTRAINT IF EXISTS game_events_bb_type_chk,
    ADD CONSTRAINT game_events_bb_type_chk
        CHECK (bb_type IS NULL OR bb_type IN ('GB','FB','LD','PU'));

ALTER TABLE game_events
    DROP CONSTRAINT IF EXISTS game_events_field_zone_chk,
    ADD CONSTRAINT game_events_field_zone_chk
        CHECK (field_zone IS NULL OR field_zone IN ('LEFT','CENTER','RIGHT'));

-- Indexes for player aggregation queries
CREATE INDEX IF NOT EXISTS game_events_bb_idx
    ON game_events (batter_player_id, bb_type)
    WHERE bb_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS game_events_spray_idx
    ON game_events (batter_player_id, field_zone)
    WHERE field_zone IS NOT NULL;

-- Pitcher-side aggregation (for opponent contact profile)
CREATE INDEX IF NOT EXISTS game_events_pitcher_bb_idx
    ON game_events (pitcher_player_id, bb_type)
    WHERE bb_type IS NOT NULL;

-- Backfill driver: find events that haven't been classified yet
CREATE INDEX IF NOT EXISTS game_events_unbb_derived_idx
    ON game_events (id)
    WHERE bb_derived_at IS NULL
      AND result_type IN ('single','double','triple','home_run',
                          'ground_out','fly_out','line_out','pop_out',
                          'sac_fly','sac_bunt','fielders_choice','error',
                          'double_play','triple_play');

-- Sanity check
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'game_events'
  AND column_name IN ('bb_type', 'field_zone', 'bb_derived_at')
ORDER BY ordinal_position;
