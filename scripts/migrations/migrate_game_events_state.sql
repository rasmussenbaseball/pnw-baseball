-- ─────────────────────────────────────────────────────────────────
-- Migration: enrich game_events with base state, outs, score, runners
-- ─────────────────────────────────────────────────────────────────
-- Adds the columns Phase A needs to power situational splits, leverage
-- index, and WPA. All columns are nullable so existing rows stay valid
-- until backfill runs. derive_event_state.py populates them in a
-- second pass after parse_pbp_events writes the per-PA rows.
--
-- Column conventions:
--   bases_*     '000' empty .. '111' loaded; index 0 = 1B, 1 = 2B, 2 = 3B
--   r1/r2/r3    runner identity ON THAT BASE (last name from narrative);
--               r1_player_id when we can resolve to game roster.
--   *_score_*   running team score going INTO the PA (does not include
--               runs that score during the PA itself — those land in
--               runs_on_play and roll forward to the next PA).
--
-- Idempotent: every ADD COLUMN guarded by IF NOT EXISTS.
-- Run on Mac dev / prod (Supabase) DB.
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE game_events
    ADD COLUMN IF NOT EXISTS outs_before        SMALLINT,
    ADD COLUMN IF NOT EXISTS outs_after         SMALLINT,
    ADD COLUMN IF NOT EXISTS bases_before       TEXT,
    ADD COLUMN IF NOT EXISTS bases_after        TEXT,
    ADD COLUMN IF NOT EXISTS runs_on_play       SMALLINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS bat_score_before   SMALLINT,
    ADD COLUMN IF NOT EXISTS fld_score_before   SMALLINT,
    ADD COLUMN IF NOT EXISTS r1_name            TEXT,
    ADD COLUMN IF NOT EXISTS r2_name            TEXT,
    ADD COLUMN IF NOT EXISTS r3_name            TEXT,
    ADD COLUMN IF NOT EXISTS r1_player_id       INTEGER REFERENCES players(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS r2_player_id       INTEGER REFERENCES players(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS r3_player_id       INTEGER REFERENCES players(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS state_derived_at   TIMESTAMPTZ;

-- Sanity-check constraints (deferred so existing NULL rows don't fail).
-- These fire only when a row gets non-NULL values — the derive script
-- always sets the full block atomically so this is safe.
ALTER TABLE game_events
    DROP CONSTRAINT IF EXISTS game_events_outs_before_chk,
    ADD CONSTRAINT game_events_outs_before_chk
        CHECK (outs_before IS NULL OR outs_before BETWEEN 0 AND 2);

ALTER TABLE game_events
    DROP CONSTRAINT IF EXISTS game_events_outs_after_chk,
    ADD CONSTRAINT game_events_outs_after_chk
        CHECK (outs_after IS NULL OR outs_after BETWEEN 0 AND 3);

ALTER TABLE game_events
    DROP CONSTRAINT IF EXISTS game_events_bases_before_chk,
    ADD CONSTRAINT game_events_bases_before_chk
        CHECK (bases_before IS NULL OR bases_before ~ '^[01]{3}$');

ALTER TABLE game_events
    DROP CONSTRAINT IF EXISTS game_events_bases_after_chk,
    ADD CONSTRAINT game_events_bases_after_chk
        CHECK (bases_after IS NULL OR bases_after ~ '^[01]{3}$');

-- ── Indexes ─────────────────────────────────────────────────────
-- Situational splits — RISP queries select on bases_before LIKE '_1_'
-- or '__1' so a btree on the column is enough; partial index on
-- non-empty states keeps it small.
CREATE INDEX IF NOT EXISTS game_events_state_idx
    ON game_events (bases_before, outs_before)
    WHERE bases_before IS NOT NULL;

-- Leverage / WPA queries: filter by inning + score margin
CREATE INDEX IF NOT EXISTS game_events_leverage_idx
    ON game_events (inning, bat_score_before, fld_score_before)
    WHERE bat_score_before IS NOT NULL;

-- Backfill driver: find games that haven't been state-derived yet
CREATE INDEX IF NOT EXISTS game_events_undrived_idx
    ON game_events (game_id)
    WHERE state_derived_at IS NULL;

-- Sanity check
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'game_events'
  AND column_name IN (
      'outs_before','outs_after','bases_before','bases_after',
      'runs_on_play','bat_score_before','fld_score_before',
      'r1_name','r2_name','r3_name',
      'r1_player_id','r2_player_id','r3_player_id',
      'state_derived_at'
  )
ORDER BY ordinal_position;
