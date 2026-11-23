-- ─────────────────────────────────────────────────────────────────
-- Migration: add IF_2B to the fine field-zone taxonomy (2026-07)
-- ─────────────────────────────────────────────────────────────────
-- The classifier now splits the old IF_MID ("2B + pitcher + up the middle")
-- into IF_2B (second baseman / 3-4 hole) and IF_MID (pitcher / dead center),
-- giving a true 5-lane infield (3B, SS, MID, 2B, 1B) that matches how 6-4-3
-- Charts divides the field — much more actionable for defensive shifts.
--
-- Widen the CHECK constraint to allow IF_2B before re-deriving.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE game_events
    DROP CONSTRAINT IF EXISTS game_events_field_zone_fine_chk,
    ADD CONSTRAINT game_events_field_zone_fine_chk
        CHECK (field_zone_fine IS NULL OR field_zone_fine IN
               ('LF','LC','CF','RC','RF',
                'IF_3B','IF_SS','IF_MID','IF_2B','IF_1B','IF_C'));

-- Same for the summer parallel table, which shares the classifier.
ALTER TABLE summer_game_events
    DROP CONSTRAINT IF EXISTS summer_game_events_field_zone_fine_chk,
    ADD CONSTRAINT summer_game_events_field_zone_fine_chk
        CHECK (field_zone_fine IS NULL OR field_zone_fine IN
               ('LF','LC','CF','RC','RF',
                'IF_3B','IF_SS','IF_MID','IF_2B','IF_1B','IF_C'));
