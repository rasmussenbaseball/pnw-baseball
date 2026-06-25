-- Rapsodo schema migration v4 (2026-06-25): guided arsenal.
--  arsenal_types: comma-separated pitch types the coach says this pitcher throws
--  (e.g. "4-seam (ride),sinker / 2-seam,slider,changeup"). When set, the
--  classifier only buckets pitches into THOSE types (snapping outliers to the
--  nearest declared type). NULL = unconstrained auto-classification.
-- Idempotent. Apply on the server / Supabase.

ALTER TABLE rapsodo_players ADD COLUMN IF NOT EXISTS arsenal_types TEXT;
