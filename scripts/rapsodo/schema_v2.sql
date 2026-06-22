-- Rapsodo schema migration v2 (2026-06-22): add location + release/approach
-- angle columns (for location maps and future Stuff+/Location+) and a warmup
-- QC counter. Idempotent — safe to re-run. Apply on the server / Supabase.

ALTER TABLE rapsodo_pitches  ADD COLUMN IF NOT EXISTS rel_angle    NUMERIC(5,2);
ALTER TABLE rapsodo_pitches  ADD COLUMN IF NOT EXISTS horiz_angle  NUMERIC(5,2);
ALTER TABLE rapsodo_pitches  ADD COLUMN IF NOT EXISTS sz_side      NUMERIC(6,2);
ALTER TABLE rapsodo_pitches  ADD COLUMN IF NOT EXISTS sz_height    NUMERIC(6,2);

ALTER TABLE rapsodo_sessions ADD COLUMN IF NOT EXISTS qc_warmup    INTEGER DEFAULT 0;
