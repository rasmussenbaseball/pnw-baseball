-- ─────────────────────────────────────────────────────────────────
-- Migration: support sub-event rows in game_events
-- ─────────────────────────────────────────────────────────────────
-- Sidearm and Presto PBP tables include rows that are NOT plate
-- appearances — standalone steals, wild pitches, passed balls, balks,
-- pickoffs, etc. The original parser skipped them; the new sub-event
-- parser emits one row per sub-event so derive_event_state.py can
-- account for runs, outs, and base-state changes that happen between
-- PAs.
--
-- Sub-event rows have:
--   batter_name        NULL   (no batter at the plate FOR THIS ROW)
--   batter_player_id   NULL
--   pitcher_name       set    (we still know the pitcher of record)
--   pitcher_player_id  set when resolvable
--   result_type        one of: stolen_base, caught_stealing, wild_pitch,
--                              passed_ball, balk, pickoff, runner_other
--   was_in_play        FALSE
--   balls_before/strikes_before = 0   (not meaningful for sub-events)
--   pitch_sequence     ''
--   pitches_thrown     0
--
-- Existing per-PA queries (pitch-level stats, batting splits, etc.)
-- already filter by result_type whitelists so sub-event rows are
-- invisible to them.
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────

-- Allow NULL batter for sub-event rows
ALTER TABLE game_events ALTER COLUMN batter_name DROP NOT NULL;

-- Sanity check
SELECT column_name, is_nullable
FROM information_schema.columns
WHERE table_name = 'game_events'
  AND column_name = 'batter_name';
