-- Enable Row Level Security on the 26 public tables that were exposed via
-- the Supabase PostgREST API (readable by anyone holding the anon key, which
-- ships in the frontend bundle). Flagged 2026-07-16 by the Supabase advisor.
--
-- SAFE: the backend connects as role `postgres` (rolbypassrls=true), so RLS
-- does not affect the API or scrapers. The frontend only uses supabase.auth
-- (no .from() table reads), so no legitimate PostgREST access is broken.
-- With RLS on and no policies, anon/authenticated PostgREST access is denied.
--
-- REVERSIBLE: to undo any table, run
--   ALTER TABLE public.<table> DISABLE ROW LEVEL SECURITY;

BEGIN;

ALTER TABLE public.coach_staff_seats          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commitment_audit           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incoming_transfers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.juco_recruit_batting       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.juco_recruit_pitching      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.juco_recruit_players       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.juco_recruit_teams         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.link_audit                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_comps              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pickem_picks               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_projections         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_returning_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rapsodo_pitches            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rapsodo_players            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rapsodo_sessions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruiting_board_members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruiting_board_players   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruiting_boards          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruits                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tm_pitches                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tm_sessions                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracking_workspace_shares  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trackman_pitches           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transfer_portal_members    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wcl_audit                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wcl_portal_members         ENABLE ROW LEVEL SECURITY;

COMMIT;

-- Verify nothing is left exposed:
--   SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--   WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=false ORDER BY 1;
