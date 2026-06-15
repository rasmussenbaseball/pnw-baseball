-- TrackMan per-pitch-type averages for SUMMER players (private, dev-tier only).
-- One row per (summer player, season, pitch type). Source: TrackMan "Pitcher
-- Session Report" PDFs (new platform), transcribed to JSON then ingested.
-- Averaged data only (no pitch-level). See scripts/trackman/ingest.py.

CREATE TABLE IF NOT EXISTS trackman_pitches (
    id                SERIAL PRIMARY KEY,
    summer_player_id  INTEGER NOT NULL REFERENCES summer_players(id) ON DELETE CASCADE,
    team_id           INTEGER REFERENCES summer_teams(id),
    season            INTEGER NOT NULL,
    pitch_type        TEXT    NOT NULL,
    pitch_count       INTEGER,
    usage_pct         NUMERIC(5,1),
    velo              NUMERIC(5,1),   -- mph
    spin              INTEGER,        -- rpm
    ivb               NUMERIC(5,1),   -- induced vertical break, in
    hb                NUMERIC(5,1),   -- horizontal break, in
    tilt              TEXT,           -- clock face, e.g. "1:45"
    extension         NUMERIC(4,2),   -- ft
    rel_height        NUMERIC(4,2),   -- ft
    rel_side          NUMERIC(4,2),   -- ft
    in_zone_pct       NUMERIC(5,1),
    whiff_pct         NUMERIC(5,1),
    chase_pct         NUMERIC(5,1),
    source_file       TEXT,
    created_at        TIMESTAMP DEFAULT now(),
    updated_at        TIMESTAMP DEFAULT now(),
    UNIQUE (summer_player_id, season, pitch_type)
);

CREATE INDEX IF NOT EXISTS idx_trackman_pitches_player ON trackman_pitches(summer_player_id);
CREATE INDEX IF NOT EXISTS idx_trackman_pitches_team_season ON trackman_pitches(team_id, season);
