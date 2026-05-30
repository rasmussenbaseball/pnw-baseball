-- ─────────────────────────────────────────────────────────────────
-- Migration: summer_game_events — WCL / summer play-by-play
-- ─────────────────────────────────────────────────────────────────
-- One row per plate appearance (plus standalone sub-events like steals
-- and wild pitches), parsed from wclstats.com PBP by parse_wcl_pbp.py.
--
-- Mirrors the spring `game_events` table but references the summer_*
-- schema. Designed first to feed HITTER APPROACH SPLITS (first-pitch
-- swing %, 2-strike approach, swing/contact/whiff %) computed from
-- pitch_sequence + count columns, exactly like the spring
-- lineup_helper._fetch_pbp_stats_bulk pipeline.
--
-- batter_name / pitcher_name are NULLable here (unlike spring) because
-- standalone sub-events (stolen_base, wild_pitch, balk, runner_sub)
-- legitimately have no batter, and a pitcher may be unresolved before
-- the box-score starter seed lands.
--
-- Idempotent: safe to run multiple times. Re-scrapes do
--   DELETE FROM summer_game_events WHERE game_id = X;  then INSERT.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS summer_game_events (
    id                  BIGSERIAL PRIMARY KEY,

    -- ── Where in the game ──
    game_id             INTEGER     NOT NULL REFERENCES summer_games(id) ON DELETE CASCADE,
    inning              INTEGER     NOT NULL,
    half                TEXT        NOT NULL CHECK (half IN ('top', 'bottom')),
    sequence_idx        INTEGER     NOT NULL,   -- order within the half-inning

    -- ── Who was on the field ──
    batting_team_id     INTEGER              REFERENCES summer_teams(id),
    defending_team_id   INTEGER              REFERENCES summer_teams(id),

    batter_player_id    INTEGER              REFERENCES summer_players(id) ON DELETE SET NULL,
    batter_name         TEXT,
    pitcher_player_id   INTEGER              REFERENCES summer_players(id) ON DELETE SET NULL,
    pitcher_name        TEXT,

    -- ── Pitch / count detail (the hitter-approach inputs) ──
    balls_before        INTEGER     NOT NULL DEFAULT 0,    -- count BEFORE the PA-ending pitch
    strikes_before      INTEGER     NOT NULL DEFAULT 0,
    pitch_sequence      TEXT,                              -- StatCrew letters, e.g. "BKKFBS"
    pitches_thrown      INTEGER,
    was_in_play         BOOLEAN,

    -- ── Outcome ──
    result_type         TEXT        NOT NULL,
    result_text         TEXT,                              -- full narrative line (audit / re-parse)
    rbi                 INTEGER     NOT NULL DEFAULT 0,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT summer_game_events_uq_pa UNIQUE (game_id, inning, half, sequence_idx)
);

-- Per-game replay
CREATE INDEX IF NOT EXISTS summer_game_events_game_idx
    ON summer_game_events (game_id, inning, half, sequence_idx);

-- Batter splits / approach lookups
CREATE INDEX IF NOT EXISTS summer_game_events_batter_idx
    ON summer_game_events (batter_player_id)
    WHERE batter_player_id IS NOT NULL;

-- Pitcher lookups
CREATE INDEX IF NOT EXISTS summer_game_events_pitcher_idx
    ON summer_game_events (pitcher_player_id)
    WHERE pitcher_player_id IS NOT NULL;

-- PA-level batter-vs-pitcher
CREATE INDEX IF NOT EXISTS summer_game_events_h2h_idx
    ON summer_game_events (batter_player_id, pitcher_player_id)
    WHERE batter_player_id IS NOT NULL AND pitcher_player_id IS NOT NULL;

-- Sanity check
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'summer_game_events'
ORDER BY ordinal_position;
