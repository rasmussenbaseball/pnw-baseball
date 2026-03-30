-- ============================================================
-- PNW Baseball Analytics — Summer Ball Stats Schema
-- Run this in the Supabase SQL Editor to add summer league tables
-- ============================================================

-- ============================================================
-- SUMMER_LEAGUES — WCL, PIL, etc.
-- ============================================================

CREATE TABLE IF NOT EXISTS summer_leagues (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,                     -- "West Coast League"
    abbreviation TEXT NOT NULL UNIQUE,      -- "WCL"
    pointstreak_league_id INTEGER,          -- 145 for WCL, 259 for PIL
    website_url TEXT,
    logo_url TEXT,
    is_active BOOLEAN DEFAULT TRUE
);

-- Seed the two main leagues
INSERT INTO summer_leagues (name, abbreviation, pointstreak_league_id, website_url)
VALUES
    ('West Coast League', 'WCL', 145, 'https://westcoastleague.com'),
    ('Pacific International League', 'PIL', 259, 'https://www.pacificinternationalleague.com')
ON CONFLICT (abbreviation) DO NOTHING;


-- ============================================================
-- SUMMER_TEAMS — teams within each summer league
-- ============================================================

CREATE TABLE IF NOT EXISTS summer_teams (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,                     -- "Portland Pickles"
    short_name TEXT,                        -- "Pickles"
    city TEXT,
    state TEXT DEFAULT 'OR',
    league_id INTEGER NOT NULL REFERENCES summer_leagues(id),
    pointstreak_team_id INTEGER,            -- Pointstreak's team ID for scraping
    logo_url TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    UNIQUE(name, league_id)
);


-- ============================================================
-- SUMMER_PLAYERS — player records in summer leagues
-- Links back to spring players via summer_player_links
-- ============================================================

CREATE TABLE IF NOT EXISTS summer_players (
    id SERIAL PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    team_id INTEGER NOT NULL REFERENCES summer_teams(id),
    jersey_number TEXT,
    position TEXT,
    bats TEXT,
    throws TEXT,
    college TEXT,                            -- college they play for during spring
    year_in_school TEXT,                     -- Fr, So, Jr, Sr
    hometown TEXT,
    pointstreak_player_id INTEGER,           -- Pointstreak's player ID
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- SUMMER_PLAYER_LINKS — maps summer player to spring player
-- ============================================================

CREATE TABLE IF NOT EXISTS summer_player_links (
    id SERIAL PRIMARY KEY,
    summer_player_id INTEGER NOT NULL REFERENCES summer_players(id) ON DELETE CASCADE,
    spring_player_id INTEGER NOT NULL REFERENCES players(id),
    confidence TEXT DEFAULT 'auto',          -- 'auto' or 'manual'
    UNIQUE(summer_player_id)
);

CREATE INDEX IF NOT EXISTS idx_summer_player_links_spring ON summer_player_links(spring_player_id);
CREATE INDEX IF NOT EXISTS idx_summer_player_links_summer ON summer_player_links(summer_player_id);


-- ============================================================
-- SUMMER_BATTING_STATS — one row per player per team per season
-- ============================================================

CREATE TABLE IF NOT EXISTS summer_batting_stats (
    id SERIAL PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES summer_players(id),
    team_id INTEGER NOT NULL REFERENCES summer_teams(id),
    season INTEGER NOT NULL,                 -- 2025, 2024, etc.

    -- Counting stats (scraped from Pointstreak)
    games INTEGER DEFAULT 0,
    games_started INTEGER DEFAULT 0,
    plate_appearances INTEGER DEFAULT 0,
    at_bats INTEGER DEFAULT 0,
    runs INTEGER DEFAULT 0,
    hits INTEGER DEFAULT 0,
    doubles INTEGER DEFAULT 0,
    triples INTEGER DEFAULT 0,
    home_runs INTEGER DEFAULT 0,
    rbi INTEGER DEFAULT 0,
    walks INTEGER DEFAULT 0,
    strikeouts INTEGER DEFAULT 0,
    hit_by_pitch INTEGER DEFAULT 0,
    sacrifice_flies INTEGER DEFAULT 0,
    sacrifice_bunts INTEGER DEFAULT 0,
    stolen_bases INTEGER DEFAULT 0,
    caught_stealing INTEGER DEFAULT 0,
    grounded_into_dp INTEGER DEFAULT 0,
    intentional_walks INTEGER DEFAULT 0,

    -- Rate stats (computed)
    batting_avg REAL,
    on_base_pct REAL,
    slugging_pct REAL,
    ops REAL,

    -- Advanced stats (computed using league run environment)
    woba REAL,
    wraa REAL,
    wrc REAL,
    wrc_plus REAL,
    iso REAL,
    babip REAL,
    bb_pct REAL,
    k_pct REAL,
    offensive_war REAL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(player_id, team_id, season)
);

CREATE INDEX IF NOT EXISTS idx_summer_batting_player ON summer_batting_stats(player_id);
CREATE INDEX IF NOT EXISTS idx_summer_batting_team ON summer_batting_stats(team_id);
CREATE INDEX IF NOT EXISTS idx_summer_batting_season ON summer_batting_stats(season);


-- ============================================================
-- SUMMER_PITCHING_STATS — one row per player per team per season
-- ============================================================

CREATE TABLE IF NOT EXISTS summer_pitching_stats (
    id SERIAL PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES summer_players(id),
    team_id INTEGER NOT NULL REFERENCES summer_teams(id),
    season INTEGER NOT NULL,

    -- Counting stats (scraped from Pointstreak)
    games INTEGER DEFAULT 0,
    games_started INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    saves INTEGER DEFAULT 0,
    complete_games INTEGER DEFAULT 0,
    shutouts INTEGER DEFAULT 0,
    innings_pitched REAL DEFAULT 0,
    hits_allowed INTEGER DEFAULT 0,
    runs_allowed INTEGER DEFAULT 0,
    earned_runs INTEGER DEFAULT 0,
    walks INTEGER DEFAULT 0,
    strikeouts INTEGER DEFAULT 0,
    home_runs_allowed INTEGER DEFAULT 0,
    hit_batters INTEGER DEFAULT 0,
    wild_pitches INTEGER DEFAULT 0,
    batters_faced INTEGER DEFAULT 0,

    -- Rate stats (computed)
    era REAL,
    whip REAL,

    -- Advanced stats (computed using league run environment)
    k_per_9 REAL,
    bb_per_9 REAL,
    h_per_9 REAL,
    hr_per_9 REAL,
    k_bb_ratio REAL,
    fip REAL,
    babip_against REAL,
    k_pct REAL,
    bb_pct REAL,
    pitching_war REAL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(player_id, team_id, season)
);

CREATE INDEX IF NOT EXISTS idx_summer_pitching_player ON summer_pitching_stats(player_id);
CREATE INDEX IF NOT EXISTS idx_summer_pitching_team ON summer_pitching_stats(team_id);
CREATE INDEX IF NOT EXISTS idx_summer_pitching_season ON summer_pitching_stats(season);


-- ============================================================
-- SUMMER_LEAGUE_AVERAGES — for computing wRC+, FIP constants, etc.
-- ============================================================

CREATE TABLE IF NOT EXISTS summer_league_averages (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES summer_leagues(id),
    season INTEGER NOT NULL,

    avg_batting_avg REAL,
    avg_obp REAL,
    avg_slg REAL,
    avg_ops REAL,
    avg_woba REAL,
    avg_runs_per_game REAL,
    avg_hr_per_fb REAL,
    woba_scale REAL,
    runs_per_pa REAL,
    runs_per_win REAL,
    avg_era REAL,
    avg_fip REAL,
    avg_k_per_9 REAL,
    avg_bb_per_9 REAL,
    avg_hr_per_9 REAL,
    fip_constant REAL,

    UNIQUE(league_id, season)
);


-- ============================================================
-- SUMMER_TEAM_SEASON_STATS — team-level aggregates per season
-- ============================================================

CREATE TABLE IF NOT EXISTS summer_team_season_stats (
    id SERIAL PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES summer_teams(id),
    season INTEGER NOT NULL,
    games INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    runs_scored INTEGER DEFAULT 0,
    runs_allowed INTEGER DEFAULT 0,

    UNIQUE(team_id, season)
);
