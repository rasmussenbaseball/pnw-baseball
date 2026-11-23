-- recruiting_programs: hand-curated off-field program profiles for the recruiting
-- guide (coaching, academics, cost, facilities, location, recruiting contacts).
--
-- Admin-only feature. Read through the FastAPI backend, which connects as the
-- `postgres` role (rolbypassrls = true), so RLS never affects it. The frontend
-- makes ZERO direct Supabase data calls. Enabling RLS with NO public policy
-- therefore locks the table to the API only — consistent with
-- scripts/migrate_rls_security_lints.sql.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.recruiting_programs (
    team_id     integer PRIMARY KEY REFERENCES public.teams(id) ON DELETE CASCADE,
    school_name text,
    division    text,
    conference  text,
    profile     jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.recruiting_programs ENABLE ROW LEVEL SECURITY;
-- No policy on purpose: backend bypasses RLS, frontend has no direct access.

CREATE INDEX IF NOT EXISTS idx_recruiting_programs_division
    ON public.recruiting_programs (division);
