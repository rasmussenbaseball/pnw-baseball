-- Resolve Supabase database-linter security findings (applied 2026-06-02).
--
-- Context: the Supabase linter flagged 8 public tables with RLS disabled, three
-- overly-permissive "always true" RLS policies, and pg_trgm installed in the
-- public schema. The app is safe to lock down because:
--   * the FastAPI backend connects as `postgres` (rolbypassrls = true), so RLS
--     never applies to it, and
--   * the frontend makes ZERO direct Supabase data calls (auth-only) — all data
--     flows through the FastAPI API.
-- So enabling RLS only closes the public anon-key PostgREST hole; it does not
-- affect the app. This mirrors the 41 public tables that already had RLS on.
--
-- This file is a RECORD of what was applied directly to prod; it is idempotent
-- (safe to re-run) thanks to the DROP POLICY IF EXISTS guards.

-- ── 1. The 7 public stats tables: enable RLS + public-read (matches players/teams/games)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'summer_game_batting','summer_games','game_fielding','fielding_stats',
    'summer_game_pitching','summer_game_events','summer_fielding_stats'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON public.%I', t);
    EXECUTE format('CREATE POLICY "Public read" ON public.%I FOR SELECT TO public USING (true)', t);
  END LOOP;
END $$;

-- ── 2. user_profiles (per-user PII): RLS + self-scoped only (no public read)
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_profiles_self" ON public.user_profiles;
CREATE POLICY "user_profiles_self" ON public.user_profiles FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ── 3. user_favorites: replace "Anyone can insert/delete" (cross-user hole) with self-scoped.
--      user_id is TEXT (Supabase uid string), so cast auth.uid() to text.
DROP POLICY IF EXISTS "Anyone can insert"       ON public.user_favorites;
DROP POLICY IF EXISTS "Anyone can delete"       ON public.user_favorites;
DROP POLICY IF EXISTS "favorites_self_insert"   ON public.user_favorites;
DROP POLICY IF EXISTS "favorites_self_delete"   ON public.user_favorites;
CREATE POLICY "favorites_self_insert" ON public.user_favorites FOR INSERT TO authenticated WITH CHECK (auth.uid()::text = user_id);
CREATE POLICY "favorites_self_delete" ON public.user_favorites FOR DELETE TO authenticated USING (auth.uid()::text = user_id);

-- ── 4. feature_requests: drop the unrestricted INSERT and the "Public read"
--      (the latter exposed every submitter's email to the anon key). The app
--      submits via FastAPI, so backend access is unaffected.
DROP POLICY IF EXISTS "Anyone can submit" ON public.feature_requests;
DROP POLICY IF EXISTS "Public read"       ON public.feature_requests;

-- ── 5. Move pg_trgm out of the public schema (Supabase convention). Existing
--      trigram indexes keep working (opclass is OID-resolved); only new DDL that
--      references pg_trgm functions unqualified would need `extensions` in path.
ALTER EXTENSION pg_trgm SET SCHEMA extensions;

-- NOTE: the remaining linter WARN (auth_leaked_password_protection) is a dashboard
-- setting, not SQL: Authentication -> Sign In / Providers -> Password security ->
-- enable "Leaked password protection".
