-- Summer fielding season aggregates (one row per player per season).
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS summer_fielding_stats (
    id SERIAL PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES summer_players(id) ON DELETE CASCADE,
    team_id   INTEGER NOT NULL REFERENCES summer_teams(id),
    season    INTEGER NOT NULL,
    -- Optional position filter (NULL = combined across all positions,
    -- like the WCL/NWAC summary page returns). Per-position breakouts
    -- can come later via box-score parsing.
    position  TEXT,
    games     INTEGER DEFAULT 0,
    total_chances INTEGER DEFAULT 0,
    putouts   INTEGER DEFAULT 0,
    assists   INTEGER DEFAULT 0,
    errors    INTEGER DEFAULT 0,
    passed_balls INTEGER DEFAULT 0,
    double_plays INTEGER DEFAULT 0,
    stolen_bases_against INTEGER DEFAULT 0,
    caught_stealing_by   INTEGER DEFAULT 0,
    catcher_interference INTEGER DEFAULT 0,
    fielding_pct REAL,
    cs_pct       REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_summer_fielding_row
    ON summer_fielding_stats(player_id, team_id, season, COALESCE(position, ''));
CREATE INDEX IF NOT EXISTS idx_summer_fielding_team_season
    ON summer_fielding_stats(team_id, season);
CREATE INDEX IF NOT EXISTS idx_summer_fielding_player
    ON summer_fielding_stats(player_id);
