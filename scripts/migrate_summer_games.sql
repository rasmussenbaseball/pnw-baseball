-- ============================================================
-- PNW Baseball Analytics — Summer per-game tables (WCL / PIL / ...)
--
-- Mirrors the spring schema (games / game_batting / game_pitching)
-- but in a separate namespace so a summer HR doesn't accidentally
-- bleed into college-season queries. Idempotent — safe to re-run.
--
-- Apply with:
--   PYTHONPATH=backend python3 scripts/migrate_summer_games.py
-- ============================================================

-- ----------------------------------------------------------------
-- summer_games — one row per scheduled / completed WCL game
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS summer_games (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES summer_leagues(id),
    season INTEGER NOT NULL,                   -- 2026
    game_date DATE,                             -- 2026-05-28
    status TEXT,                                -- 'scheduled' | 'final' | 'in_progress' | 'postponed'

    away_team_id INTEGER REFERENCES summer_teams(id),
    home_team_id INTEGER REFERENCES summer_teams(id),
    -- Free-form names fall back when we haven't resolved the team
    -- row yet (Pointstreak vs Presto sometimes disagree on naming).
    away_team_name TEXT,
    home_team_name TEXT,

    away_score INTEGER,
    home_score INTEGER,
    away_hits INTEGER,
    home_hits INTEGER,
    away_errors INTEGER,
    home_errors INTEGER,

    -- Inning-by-inning line scores (JSON arrays so we don't blow up
    -- on extra innings)
    away_line_score JSONB,
    home_line_score JSONB,
    innings INTEGER,                            -- final inning count (9, 7DH, 11, etc.)

    -- Provenance
    source_url TEXT UNIQUE,                     -- wclstats.com box-score URL (idempotency key)
    boxscore_code TEXT,                         -- e.g. "20260528_e3rm" — extracted from source_url

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_summer_games_league_season  ON summer_games(league_id, season);
CREATE INDEX IF NOT EXISTS idx_summer_games_date           ON summer_games(game_date DESC);
CREATE INDEX IF NOT EXISTS idx_summer_games_home_team      ON summer_games(home_team_id);
CREATE INDEX IF NOT EXISTS idx_summer_games_away_team      ON summer_games(away_team_id);
CREATE INDEX IF NOT EXISTS idx_summer_games_status         ON summer_games(status);


-- ----------------------------------------------------------------
-- summer_game_batting — one row per player per game
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS summer_game_batting (
    id SERIAL PRIMARY KEY,
    game_id INTEGER NOT NULL REFERENCES summer_games(id) ON DELETE CASCADE,
    team_id INTEGER REFERENCES summer_teams(id),
    player_id INTEGER REFERENCES summer_players(id),
    -- Name fallback for players we couldn't resolve to the players
    -- table on the first pass; resolver will patch player_id later.
    player_name TEXT,

    is_home BOOLEAN NOT NULL,
    position TEXT,                              -- "rf", "ss", "1b/3b", etc.
    batting_order INTEGER,                      -- 1-9 (NULL = pinch/sub if we can't infer)

    ab INTEGER DEFAULT 0,
    r  INTEGER DEFAULT 0,
    h  INTEGER DEFAULT 0,
    rbi INTEGER DEFAULT 0,
    bb INTEGER DEFAULT 0,
    so INTEGER DEFAULT 0,
    lob INTEGER DEFAULT 0,
    "2b" INTEGER DEFAULT 0,
    "3b" INTEGER DEFAULT 0,
    hr INTEGER DEFAULT 0,
    sb INTEGER DEFAULT 0,
    cs INTEGER DEFAULT 0,
    sf INTEGER DEFAULT 0,
    sh INTEGER DEFAULT 0,
    hbp INTEGER DEFAULT 0,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Idempotency on re-scrape: a single (game, player_name, is_home)
-- shouldn't be duplicated. player_id may still be NULL at insert
-- time, so we key the unique on name + side.
CREATE UNIQUE INDEX IF NOT EXISTS uq_summer_game_batting_row
    ON summer_game_batting(game_id, is_home, player_name);
CREATE INDEX IF NOT EXISTS idx_summer_game_batting_player  ON summer_game_batting(player_id);
CREATE INDEX IF NOT EXISTS idx_summer_game_batting_team    ON summer_game_batting(team_id);


-- ----------------------------------------------------------------
-- summer_game_pitching — one row per pitcher per game
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS summer_game_pitching (
    id SERIAL PRIMARY KEY,
    game_id INTEGER NOT NULL REFERENCES summer_games(id) ON DELETE CASCADE,
    team_id INTEGER REFERENCES summer_teams(id),
    player_id INTEGER REFERENCES summer_players(id),
    player_name TEXT,

    is_home BOOLEAN NOT NULL,
    is_starter BOOLEAN DEFAULT FALSE,
    pitch_order INTEGER,                        -- 1 = starter, 2 = first reliever, etc.

    ip REAL DEFAULT 0,                          -- 5.2 = 5 IP + 2 outs
    h  INTEGER DEFAULT 0,
    r  INTEGER DEFAULT 0,
    er INTEGER DEFAULT 0,
    bb INTEGER DEFAULT 0,
    so INTEGER DEFAULT 0,
    hr INTEGER DEFAULT 0,
    bf INTEGER DEFAULT 0,
    wp INTEGER DEFAULT 0,
    hbp INTEGER DEFAULT 0,
    pitches INTEGER DEFAULT 0,
    strikes INTEGER DEFAULT 0,
    decision TEXT,                              -- 'W' | 'L' | 'SV' | 'BS' | 'H' | NULL

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_summer_game_pitching_row
    ON summer_game_pitching(game_id, is_home, player_name);
CREATE INDEX IF NOT EXISTS idx_summer_game_pitching_player ON summer_game_pitching(player_id);
CREATE INDEX IF NOT EXISTS idx_summer_game_pitching_team   ON summer_game_pitching(team_id);
