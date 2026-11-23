-- ─────────────────────────────────────────────────────────────────
-- Migration: game_events table for Phase 1 PBP analytics
-- ─────────────────────────────────────────────────────────────────
-- One row per plate appearance, parsed from Sidearm play-by-play.
-- Enables advanced stats:
--   - First-pitch swing %, first-pitch strike %
--   - 2-strike approach (BA, K%, BB% in 2-strike counts)
--   - Count-state OPS / slash lines
--   - Whiff % (per pitcher) and contact % (per batter)
--   - Strike % / called-strike % / pitch counts per pitcher
--   - L/R splits (via JOIN players.bats / players.throws)
--   - True PA-level batter-vs-pitcher historical matchups
--
-- NOT in scope for Phase 1:
--   - spray_zone (batted-ball direction) — Phase 1.5
--   - runners_advanced (baserunner state machine) — Phase 1.6
--
-- Idempotent: safe to run multiple times.
-- Run on Mac dev / prod (Supabase) DB.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS game_events (
    id                  BIGSERIAL PRIMARY KEY,

    -- ── Where in the game ──
    game_id             INTEGER     NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    inning              INTEGER     NOT NULL,
    half                TEXT        NOT NULL CHECK (half IN ('top', 'bottom')),
    sequence_idx        INTEGER     NOT NULL,   -- order of this PA within the half-inning

    -- ── Who was on the field ──
    batting_team_id     INTEGER     NOT NULL REFERENCES teams(id),
    defending_team_id   INTEGER     NOT NULL REFERENCES teams(id),

    -- player_id is nullable because OOC opponents aren't in our roster
    batter_player_id    INTEGER              REFERENCES players(id) ON DELETE SET NULL,
    batter_name         TEXT        NOT NULL,
    pitcher_player_id   INTEGER              REFERENCES players(id) ON DELETE SET NULL,
    pitcher_name        TEXT        NOT NULL,

    -- ── Pitch / count detail ──
    balls_before        INTEGER     NOT NULL DEFAULT 0,    -- count BEFORE the PA-ending pitch
    strikes_before      INTEGER     NOT NULL DEFAULT 0,
    pitch_sequence      TEXT,                              -- e.g. "BBKBFFFB" (B/K/S/F/H letters)
    pitches_thrown      INTEGER,                           -- precomputed for fast aggregation
    was_in_play         BOOLEAN,                           -- TRUE for hits/outs in play, FALSE for K/BB/HBP

    -- ── Outcome ──
    -- result_type kept as plain TEXT (not enum) so we can add new categories
    -- without a migration. Expected values from parser:
    --   home_run, triple, double, single, walk, intentional_walk, hbp,
    --   strikeout_swinging, strikeout_looking,
    --   ground_out, fly_out, line_out, pop_out,
    --   sac_fly, sac_bunt, fielders_choice, error, double_play, other
    result_type         TEXT        NOT NULL,
    result_text         TEXT        NOT NULL,    -- full narrative line (debugging + future re-parse)
    rbi                 INTEGER     NOT NULL DEFAULT 0,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One PA per (game, inning, half, sequence_idx) — lets re-scrapes
    -- DELETE FROM game_events WHERE game_id = X then INSERT cleanly.
    CONSTRAINT game_events_uq_pa UNIQUE (game_id, inning, half, sequence_idx)
);

-- ── Indexes ──
-- Per-game replay (rendering the play log of a single game)
CREATE INDEX IF NOT EXISTS game_events_game_idx
    ON game_events (game_id, inning, half, sequence_idx);

-- Batter lookups (career line, splits, count tendencies for one batter)
CREATE INDEX IF NOT EXISTS game_events_batter_idx
    ON game_events (batter_player_id)
    WHERE batter_player_id IS NOT NULL;

-- Pitcher lookups (career line, whiff%, splits, etc.)
CREATE INDEX IF NOT EXISTS game_events_pitcher_idx
    ON game_events (pitcher_player_id)
    WHERE pitcher_player_id IS NOT NULL;

-- True PA-level batter-vs-pitcher H2H — the new scouting tool
CREATE INDEX IF NOT EXISTS game_events_h2h_idx
    ON game_events (batter_player_id, pitcher_player_id)
    WHERE batter_player_id IS NOT NULL AND pitcher_player_id IS NOT NULL;

-- Sanity check: list new structure
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'game_events'
ORDER BY ordinal_position;
