-- ============================================================
-- PNW Baseball Analytics — Games & Box Scores Schema
-- Run this in the Supabase SQL Editor to add game-level tables
-- ============================================================

-- ============================================================
-- GAMES — one row per game played
-- ============================================================

CREATE TABLE IF NOT EXISTS games (
    id SERIAL PRIMARY KEY,
    season INTEGER NOT NULL,
    game_date DATE,
    game_time TEXT,                    -- e.g. "2:00 PM"

    -- Teams
    home_team_id INTEGER REFERENCES teams(id),
    away_team_id INTEGER REFERENCES teams(id),

    -- If opponent is non-PNW and not in our DB, store name
    home_team_name TEXT,
    away_team_name TEXT,

    -- Score
    home_score INTEGER,
    away_score INTEGER,

    -- Game metadata
    innings INTEGER DEFAULT 9,        -- for extra-inning or shortened games
    is_conference_game BOOLEAN DEFAULT FALSE,
    is_postseason BOOLEAN DEFAULT FALSE,
    is_neutral_site BOOLEAN DEFAULT FALSE,
    game_number INTEGER DEFAULT 1,    -- 1, 2 for doubleheaders
    location TEXT,                     -- venue/park name
    attendance INTEGER,

    -- Line score (JSON array of inning-by-inning runs)
    home_line_score JSONB,            -- e.g. [0,1,0,3,0,0,2,0,1]
    away_line_score JSONB,

    -- Team totals from box score
    home_hits INTEGER,
    home_errors INTEGER,
    home_lob INTEGER,
    away_hits INTEGER,
    away_errors INTEGER,
    away_lob INTEGER,

    -- Computed metrics
    game_score REAL,                  -- custom quality-of-game metric

    -- Source tracking
    source_url TEXT,
    source_game_id TEXT,              -- external ID from PrestoSports/Sidearm

    -- Status
    status TEXT DEFAULT 'final',      -- final, cancelled, postponed, in_progress

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(source_url)
);

-- ============================================================
-- GAME BATTING LINES — one row per player per game (batting)
-- ============================================================

CREATE TABLE IF NOT EXISTS game_batting (
    id SERIAL PRIMARY KEY,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    team_id INTEGER REFERENCES teams(id),
    player_id INTEGER REFERENCES players(id),

    -- If player not in our DB
    player_name TEXT,

    -- Batting order & position
    batting_order INTEGER,            -- 1-9 lineup slot
    position TEXT,                    -- defensive position played

    -- Box score stats
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
    left_on_base INTEGER DEFAULT 0,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(game_id, team_id, player_name, batting_order)
);

-- ============================================================
-- GAME PITCHING LINES — one row per pitcher per game
-- ============================================================

CREATE TABLE IF NOT EXISTS game_pitching (
    id SERIAL PRIMARY KEY,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    team_id INTEGER REFERENCES teams(id),
    player_id INTEGER REFERENCES players(id),

    -- If player not in our DB
    player_name TEXT,

    -- Pitching role
    pitch_order INTEGER,              -- order of appearance (1 = starter)
    is_starter BOOLEAN DEFAULT FALSE,

    -- Decision
    decision TEXT,                    -- W, L, S, H, or NULL

    -- Box score stats
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
    pitches_thrown INTEGER DEFAULT 0,  -- if available
    strikes INTEGER DEFAULT 0,        -- if available

    -- Computed per-game metrics
    game_score REAL,                  -- Bill James Game Score
    is_quality_start BOOLEAN DEFAULT FALSE,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(game_id, team_id, player_name)
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_games_season ON games(season);
CREATE INDEX IF NOT EXISTS idx_games_date ON games(game_date);
CREATE INDEX IF NOT EXISTS idx_games_home_team ON games(home_team_id, season);
CREATE INDEX IF NOT EXISTS idx_games_away_team ON games(away_team_id, season);
CREATE INDEX IF NOT EXISTS idx_games_source ON games(source_game_id);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);

CREATE INDEX IF NOT EXISTS idx_game_batting_game ON game_batting(game_id);
CREATE INDEX IF NOT EXISTS idx_game_batting_player ON game_batting(player_id);
CREATE INDEX IF NOT EXISTS idx_game_batting_team ON game_batting(team_id);

CREATE INDEX IF NOT EXISTS idx_game_pitching_game ON game_pitching(game_id);
CREATE INDEX IF NOT EXISTS idx_game_pitching_player ON game_pitching(player_id);
CREATE INDEX IF NOT EXISTS idx_game_pitching_team ON game_pitching(team_id);
