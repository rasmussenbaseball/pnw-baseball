-- ─────────────────────────────────────────────────────────────────
-- Migration: PBP tracking columns on games table
-- ─────────────────────────────────────────────────────────────────
-- Adds two columns to track per-game play-by-play scrape state:
--
--   pbp_scraped_at      TIMESTAMPTZ  — set when we successfully extract
--                                      at least one PBP event for the
--                                      game. NULL means "never scraped".
--   pbp_attempt_count   INTEGER      — incremented on every attempt,
--                                      successful or not. Used by the
--                                      scraper to give up after N tries
--                                      so we don't hammer Oregon/OSU/WSU
--                                      forever (they don't publish PBP).
--
-- Idempotent: safe to run multiple times.
-- Run on Mac dev DB AND on prod (Supabase) DB.
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE games
    ADD COLUMN IF NOT EXISTS pbp_scraped_at    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS pbp_attempt_count INTEGER NOT NULL DEFAULT 0;

-- Helpful partial index — only the rows we'll repeatedly query for
-- (games that haven't been successfully scraped yet AND haven't given up).
CREATE INDEX IF NOT EXISTS games_needs_pbp_idx
    ON games (game_date)
    WHERE pbp_scraped_at IS NULL
      AND pbp_attempt_count < 3;

-- Sanity check: list the new columns
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'games'
  AND column_name IN ('pbp_scraped_at', 'pbp_attempt_count')
ORDER BY column_name;
