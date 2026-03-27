-- ============================================================
-- PNW Baseball Analytics — Postgres Schema
-- Run this in the Supabase SQL Editor to create all tables
-- ============================================================

-- ============================================================
-- CONFERENCES & TEAMS
-- ============================================================

CREATE TABLE IF NOT EXISTS divisions (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    level TEXT NOT NULL,
    governing_body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conferences (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    abbreviation TEXT,
    division_id INTEGER NOT NULL REFERENCES divisions(id),
    stats_url TEXT,
    stats_format TEXT,
    UNIQUE(name, division_id)
);

CREATE TABLE IF NOT EXISTS teams (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    school_name TEXT NOT NULL,
    short_name TEXT,
    mascot TEXT,
    city TEXT,
    state TEXT NOT NULL,
    conference_id INTEGER NOT NULL REFERENCES conferences(id),
    stats_url TEXT,
    roster_url TEXT,
    logo_url TEXT,
    is_active INTEGER DEFAULT 1,
    UNIQUE(school_name, conference_id)
);

CREATE TABLE IF NOT EXISTS team_conference_history (
    id SERIAL PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    conference_id INTEGER NOT NULL REFERENCES conferences(id),
    season INTEGER NOT NULL,
    UNIQUE(team_id, season)
);

-- ============================================================
-- PLAYERS
-- ============================================================

CREATE TABLE IF NOT EXISTS players (
    id SERIAL PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    jersey_number TEXT,
    position TEXT,
    bats TEXT,
    throws TEXT,
    height TEXT,
    weight INTEGER,
    year_in_school TEXT,
    eligibility_year INTEGER,
    hometown TEXT,
    high_school TEXT,
    previous_school TEXT,
    is_committed INTEGER DEFAULT 0,
    committed_to TEXT,
    graduation_year INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS player_links (
    id SERIAL PRIMARY KEY,
    canonical_id INTEGER NOT NULL REFERENCES players(id),
    linked_id INTEGER NOT NULL REFERENCES players(id),
    match_type TEXT DEFAULT 'auto',
    confidence REAL DEFAULT 1.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(linked_id)
);

CREATE TABLE IF NOT EXISTS player_seasons (
    id SERIAL PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    season INTEGER NOT NULL,
    year_in_school TEXT,
    jersey_number TEXT,
    position TEXT,
    is_primary_team INTEGER DEFAULT 1,
    UNIQUE(player_id, team_id, season)
);

-- ============================================================
-- BATTING STATS
-- ============================================================

CREATE TABLE IF NOT EXISTS batting_stats (
    id SERIAL PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    season INTEGER NOT NULL,

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
    reached_on_error INTEGER DEFAULT 0,

    batting_avg REAL,
    on_base_pct REAL,
    slugging_pct REAL,
    ops REAL,

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

-- ============================================================
-- PITCHING STATS
-- ============================================================

CREATE TABLE IF NOT EXISTS pitching_stats (
    id SERIAL PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    season INTEGER NOT NULL,

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
    balks INTEGER DEFAULT 0,
    batters_faced INTEGER DEFAULT 0,
    intentional_walks INTEGER DEFAULT 0,
    holds INTEGER DEFAULT 0,
    quality_starts INTEGER DEFAULT 0,

    era REAL,
    whip REAL,
    k_per_9 REAL,
    bb_per_9 REAL,
    h_per_9 REAL,
    hr_per_9 REAL,
    k_bb_ratio REAL,

    fip REAL,
    xfip REAL,
    siera REAL,
    kwera REAL,
    k_pct REAL,
    bb_pct REAL,
    babip_against REAL,
    lob_pct REAL,
    hr_fb_ratio REAL,
    fip_plus REAL,
    era_minus REAL,
    pitching_war REAL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(player_id, team_id, season)
);

-- ============================================================
-- FIELDING STATS
-- ============================================================

CREATE TABLE IF NOT EXISTS fielding_stats (
    id SERIAL PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    season INTEGER NOT NULL,
    position TEXT NOT NULL,

    games INTEGER DEFAULT 0,
    games_started INTEGER DEFAULT 0,
    innings REAL DEFAULT 0,
    putouts INTEGER DEFAULT 0,
    assists INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    double_plays INTEGER DEFAULT 0,
    passed_balls INTEGER DEFAULT 0,
    stolen_bases_allowed INTEGER DEFAULT 0,
    caught_stealing_by INTEGER DEFAULT 0,

    fielding_pct REAL,
    range_factor REAL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(player_id, team_id, season, position)
);

-- ============================================================
-- TEAM STATS
-- ============================================================

CREATE TABLE IF NOT EXISTS team_season_stats (
    id SERIAL PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    season INTEGER NOT NULL,

    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    ties INTEGER DEFAULT 0,
    conference_wins INTEGER DEFAULT 0,
    conference_losses INTEGER DEFAULT 0,
    run_differential INTEGER DEFAULT 0,
    runs_scored INTEGER DEFAULT 0,
    runs_allowed INTEGER DEFAULT 0,

    team_batting_avg REAL,
    team_era REAL,
    team_fielding_pct REAL,
    team_ops REAL,
    team_whip REAL,

    pythagorean_win_pct REAL,

    UNIQUE(team_id, season)
);

-- ============================================================
-- LEAGUE AVERAGES
-- ============================================================

CREATE TABLE IF NOT EXISTS league_averages (
    id SERIAL PRIMARY KEY,
    division_id INTEGER NOT NULL REFERENCES divisions(id),
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

    UNIQUE(division_id, season)
);

-- ============================================================
-- NATIONAL RATINGS
-- ============================================================

CREATE TABLE IF NOT EXISTS national_ratings (
    id SERIAL PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    season INTEGER NOT NULL,
    source TEXT NOT NULL,

    national_rank INTEGER,
    total_teams INTEGER,
    rating REAL,
    sos REAL,
    sos_rank INTEGER,

    tsr REAL,
    rqi REAL,
    power_rating REAL,
    sor REAL,
    wab REAL,

    source_team_name TEXT,

    scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(team_id, season, source)
);

CREATE TABLE IF NOT EXISTS composite_rankings (
    id SERIAL PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id),
    season INTEGER NOT NULL,

    composite_rank REAL,
    composite_percentile REAL,
    composite_sos REAL,
    composite_sos_rank REAL,
    num_sources INTEGER DEFAULT 0,

    pear_rank INTEGER,
    massey_rank INTEGER,
    cbr_rank INTEGER,
    rpi_rank INTEGER,

    pear_sos REAL,
    massey_sos REAL,
    cbr_sos REAL,

    national_percentile REAL,
    cross_division_score REAL,

    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(team_id, season)
);

-- ============================================================
-- SCRAPING METADATA
-- ============================================================

CREATE TABLE IF NOT EXISTS scrape_log (
    id SERIAL PRIMARY KEY,
    source_url TEXT NOT NULL,
    source_type TEXT,
    team_id INTEGER REFERENCES teams(id),
    conference_id INTEGER REFERENCES conferences(id),
    season INTEGER,
    status TEXT NOT NULL,
    records_found INTEGER DEFAULT 0,
    records_inserted INTEGER DEFAULT 0,
    records_updated INTEGER DEFAULT 0,
    error_message TEXT,
    scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- USER FAVORITES
-- ============================================================

CREATE TABLE IF NOT EXISTS user_favorites (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    favorite_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, favorite_type, target_id)
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);
CREATE INDEX IF NOT EXISTS idx_players_name ON players(last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_batting_season ON batting_stats(season);
CREATE INDEX IF NOT EXISTS idx_batting_player ON batting_stats(player_id);
CREATE INDEX IF NOT EXISTS idx_batting_team_season ON batting_stats(team_id, season);
CREATE INDEX IF NOT EXISTS idx_pitching_season ON pitching_stats(season);
CREATE INDEX IF NOT EXISTS idx_pitching_player ON pitching_stats(player_id);
CREATE INDEX IF NOT EXISTS idx_pitching_team_season ON pitching_stats(team_id, season);
CREATE INDEX IF NOT EXISTS idx_fielding_player ON fielding_stats(player_id);
CREATE INDEX IF NOT EXISTS idx_team_season ON team_season_stats(team_id, season);
CREATE INDEX IF NOT EXISTS idx_player_seasons ON player_seasons(player_id, season);
CREATE INDEX IF NOT EXISTS idx_national_ratings_team ON national_ratings(team_id, season);
CREATE INDEX IF NOT EXISTS idx_national_ratings_source ON national_ratings(source, season);
CREATE INDEX IF NOT EXISTS idx_composite_rankings_team ON composite_rankings(team_id, season);
