-- Rapsodo schema migration v3 (2026-06-25):
--  * manual_pitch: a coach's click-to-reclassify override. The auto classifier
--    writes `pitch`; when manual_pitch is set it wins and is never overwritten by
--    the refresh job (so manual fixes save forever).
--  * mode: per-session use-case tag — 'pnw' (PNW college) vs 'facility'
--    (facility / personal). Lets us later scope calibration + roster linkage.
-- Idempotent. Apply on the server / Supabase.

ALTER TABLE rapsodo_pitches   ADD COLUMN IF NOT EXISTS manual_pitch TEXT;
ALTER TABLE rapsodo_sessions  ADD COLUMN IF NOT EXISTS mode         TEXT DEFAULT 'pnw';
ALTER TABLE rapsodo_players   ADD COLUMN IF NOT EXISTS mode         TEXT DEFAULT 'pnw';
