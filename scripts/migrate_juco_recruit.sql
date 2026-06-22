-- ============================================================
-- JUCO Recruit tracker: out-of-region junior-college data
--
-- PURPOSE
--   Nate wants California (CCCAA) and Scenic West (NJCAA Region 18)
--   junior-college players available ONLY inside the JUCO tracker,
--   for recruiting. This data must never appear on leaderboards,
--   search, team pages, recruiting classes, etc.
--
-- WHY SEPARATE TABLES (not the shared players/batting_stats)
--   The shared leaderboard/search queries JOIN divisions WITHOUT a
--   default level filter, so anything written to players/batting_stats
--   leaks into them. These juco_recruit_* tables are read by ONE
--   endpoint (the JUCO tracker) and nothing else, so the data is
--   invisible everywhere else by construction. Mirrors the existing
--   summer_* parallel-table pattern.
--
--   Stats here are PrestoSports season TOTALS only (traditional +
--   rate stats). No PBP / WAR / wRC+ — those sources don't exist for
--   these conferences.
--
-- Idempotent: safe to run more than once.
-- ============================================================

-- ── Teams ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS juco_recruit_teams (
    id              SERIAL PRIMARY KEY,
    school_name     TEXT NOT NULL,
    short_name      TEXT NOT NULL,
    mascot          TEXT,
    city            TEXT,
    state           TEXT,
    -- Denormalized so we never touch the shared conferences table.
    conference_name TEXT NOT NULL,            -- e.g. 'Scenic West', 'Big 8'
    conference_abbr TEXT,                      -- e.g. 'SWAC'
    governing_body  TEXT NOT NULL,             -- 'NJCAA' or 'CCCAA'
    region          TEXT,                      -- e.g. 'Region 18', 'NorCal', 'SoCal'
    logo_url        TEXT,
    stats_url       TEXT,                      -- PrestoSports team/league stats source ({season} placeholder)
    stats_id        TEXT,                      -- Presto team slug/id for scraping
    stats_format    TEXT,                      -- scraper dispatch key: 'presto_njcaa' | 'presto_cccaa'
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE (school_name, conference_name)
);

CREATE INDEX IF NOT EXISTS idx_jr_teams_conf ON juco_recruit_teams(conference_name);
CREATE INDEX IF NOT EXISTS idx_jr_teams_gov  ON juco_recruit_teams(governing_body);

-- ── Players (bio, season-agnostic) ──────────────────────────
CREATE TABLE IF NOT EXISTS juco_recruit_players (
    id              SERIAL PRIMARY KEY,
    team_id         INTEGER NOT NULL REFERENCES juco_recruit_teams(id) ON DELETE CASCADE,
    first_name      TEXT NOT NULL,
    last_name       TEXT NOT NULL,
    jersey_number   TEXT,
    position        TEXT,
    bats            TEXT,
    throws          TEXT,
    height          TEXT,
    weight          TEXT,
    year_in_school  TEXT,                      -- 'Fr' / 'So'
    hometown        TEXT,
    high_school     TEXT,
    previous_school TEXT,
    is_committed    BOOLEAN DEFAULT FALSE,
    committed_to    TEXT,
    commitment_date DATE,
    roster_year     INTEGER,
    source_id       TEXT,                      -- Presto player slug/id (for re-scrape matching)
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jr_players_team ON juco_recruit_players(team_id);
CREATE INDEX IF NOT EXISTS idx_jr_players_name ON juco_recruit_players(last_name, first_name);

-- ── Batting season totals ───────────────────────────────────
CREATE TABLE IF NOT EXISTS juco_recruit_batting (
    id                SERIAL PRIMARY KEY,
    player_id         INTEGER NOT NULL REFERENCES juco_recruit_players(id) ON DELETE CASCADE,
    team_id           INTEGER NOT NULL REFERENCES juco_recruit_teams(id) ON DELETE CASCADE,
    season            INTEGER NOT NULL,
    games             INTEGER,
    games_started     INTEGER,
    plate_appearances INTEGER,
    at_bats           INTEGER,
    runs              INTEGER,
    hits              INTEGER,
    doubles           INTEGER,
    triples           INTEGER,
    home_runs         INTEGER,
    rbi               INTEGER,
    total_bases       INTEGER,
    walks             INTEGER,
    strikeouts        INTEGER,
    hit_by_pitch      INTEGER,
    sacrifice_flies   INTEGER,
    sacrifice_bunts   INTEGER,
    stolen_bases      INTEGER,
    caught_stealing   INTEGER,
    -- Rate stats (as published by Presto; endpoint can also recompute)
    batting_avg       NUMERIC,
    on_base_pct       NUMERIC,
    slugging_pct      NUMERIC,
    ops               NUMERIC,
    created_at        TIMESTAMPTZ DEFAULT now(),
    updated_at        TIMESTAMPTZ DEFAULT now(),
    UNIQUE (player_id, season)
);

CREATE INDEX IF NOT EXISTS idx_jr_batting_season ON juco_recruit_batting(season);

-- ── Pitching season totals ──────────────────────────────────
CREATE TABLE IF NOT EXISTS juco_recruit_pitching (
    id                 SERIAL PRIMARY KEY,
    player_id          INTEGER NOT NULL REFERENCES juco_recruit_players(id) ON DELETE CASCADE,
    team_id            INTEGER NOT NULL REFERENCES juco_recruit_teams(id) ON DELETE CASCADE,
    season             INTEGER NOT NULL,
    games              INTEGER,
    games_started      INTEGER,
    wins               INTEGER,
    losses             INTEGER,
    saves              INTEGER,
    complete_games     INTEGER,
    shutouts           INTEGER,
    innings_pitched    NUMERIC,                -- baseball notation (6.2 = 6 2/3); convert before math
    hits_allowed       INTEGER,
    runs_allowed       INTEGER,
    earned_runs        INTEGER,
    walks              INTEGER,
    strikeouts         INTEGER,
    home_runs_allowed  INTEGER,
    hit_batters        INTEGER,
    wild_pitches       INTEGER,
    balks              INTEGER,
    batters_faced      INTEGER,
    -- Rate stats (as published by Presto; endpoint can also recompute)
    era                NUMERIC,
    whip               NUMERIC,
    k_per_9            NUMERIC,
    bb_per_9           NUMERIC,
    created_at         TIMESTAMPTZ DEFAULT now(),
    updated_at         TIMESTAMPTZ DEFAULT now(),
    UNIQUE (player_id, season)
);

CREATE INDEX IF NOT EXISTS idx_jr_pitching_season ON juco_recruit_pitching(season);

-- ============================================================
-- Seed: Scenic West Athletic Conference (NJCAA Region 18) — PILOT
--   Baseball-playing members only (Community Christian has no baseball).
--   stats_id / stats_url filled in by the scraper once Presto slugs
--   are confirmed.
-- ============================================================
INSERT INTO juco_recruit_teams (school_name, short_name, mascot, city, state, conference_name, conference_abbr, governing_body, region)
VALUES
  ('College of Southern Idaho',        'Southern Idaho',   'Golden Eagles', 'Twin Falls',  'ID', 'Scenic West', 'SWAC', 'NJCAA', 'Region 18'),
  ('Salt Lake Community College',      'Salt Lake CC',     'Bruins',        'Salt Lake City','UT','Scenic West', 'SWAC', 'NJCAA', 'Region 18'),
  ('Snow College',                     'Snow',             'Badgers',       'Ephraim',     'UT', 'Scenic West', 'SWAC', 'NJCAA', 'Region 18'),
  ('Utah State University Eastern',    'USU Eastern',      'Eagles',        'Price',       'UT', 'Scenic West', 'SWAC', 'NJCAA', 'Region 18'),
  ('Colorado Northwestern CC',         'CNCC',             'Spartans',      'Rangely',     'CO', 'Scenic West', 'SWAC', 'NJCAA', 'Region 18'),
  ('College of Southern Nevada',       'Southern Nevada',  'Coyotes',       'Las Vegas',   'NV', 'Scenic West', 'SWAC', 'NJCAA', 'Region 18'),
  ('Truckee Meadows CC',               'Truckee Meadows',  'Lizards',       'Reno',        'NV', 'Scenic West', 'SWAC', 'NJCAA', 'Region 18')
ON CONFLICT (school_name, conference_name) DO NOTHING;
