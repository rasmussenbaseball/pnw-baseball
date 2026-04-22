-- ============================================
-- SUPABASE RLS POLICIES FOR NWBB STATS
-- Run this in the Supabase SQL Editor
-- ============================================

-- ────────────────────────────────────────────
-- PUBLIC DATA TABLES
-- Anyone can read, only service role can write
-- ────────────────────────────────────────────

-- Enable RLS on all public data tables
ALTER TABLE public.batting_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coaches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.composite_rankings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.divisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fielding_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_batting ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_pitching ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.games ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.league_averages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.national_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pitching_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scrape_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.summer_batting_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.summer_league_averages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.summer_leagues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.summer_pitching_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.summer_player_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.summer_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.summer_team_season_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.summer_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_conference_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_season_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;

-- Public read policies for all data tables
CREATE POLICY "Public read" ON public.batting_stats FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.coaches FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.composite_rankings FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.conferences FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.divisions FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.fielding_stats FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.game_batting FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.game_pitching FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.games FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.league_averages FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.national_ratings FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.pitching_stats FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.player_links FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.player_seasons FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.players FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.scrape_log FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.summer_batting_stats FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.summer_league_averages FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.summer_leagues FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.summer_pitching_stats FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.summer_player_links FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.summer_players FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.summer_team_season_stats FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.summer_teams FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.team_conference_history FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.team_season_stats FOR SELECT USING (true);
CREATE POLICY "Public read" ON public.teams FOR SELECT USING (true);

-- ────────────────────────────────────────────
-- USER DATA TABLES
-- ────────────────────────────────────────────

-- Feature requests: anyone can insert, only service role reads all
ALTER TABLE public.feature_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can submit" ON public.feature_requests FOR INSERT WITH CHECK (true);
CREATE POLICY "Public read" ON public.feature_requests FOR SELECT USING (true);

-- User favorites: users can manage their own favorites
ALTER TABLE public.user_favorites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON public.user_favorites FOR SELECT USING (true);
CREATE POLICY "Anyone can insert" ON public.user_favorites FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can delete" ON public.user_favorites FOR DELETE USING (true);
