-- Rapsodo pitch-profiling tool — multi-tenant coach workspace.
-- Each coach (Supabase user) privately owns their uploaded sessions and the
-- players in them. Players are keyed by Rapsodo's OWN Player ID scoped to the
-- owner; we never depend on matching our `players` roster (a player here may not
-- exist anywhere else in the site). See RAPSODO_TOOL_DESIGN.md.
--
-- Apply in the Supabase SQL editor (Dashboard -> SQL). Safe to re-run.

-- The coach's private roster: one row per (owner, Rapsodo player).
CREATE TABLE IF NOT EXISTS rapsodo_players (
    id                 SERIAL PRIMARY KEY,
    owner_user_id      UUID    NOT NULL,                 -- Supabase user UUID of the uploading coach
    rapsodo_player_id  TEXT    NOT NULL,                 -- Rapsodo's stable per-player id (e.g. "656225")
    player_name        TEXT,
    handedness         TEXT,                             -- inferred 'R' | 'L' (verify vs roster when linked)
    team_id            INTEGER REFERENCES teams(id) ON DELETE SET NULL,   -- optional org tag (future staff sharing)
    players_id         INTEGER REFERENCES players(id) ON DELETE SET NULL, -- optional enrichment link to our roster
    notes              TEXT,
    created_at         TIMESTAMP DEFAULT now(),
    updated_at         TIMESTAMP DEFAULT now(),
    UNIQUE (owner_user_id, rapsodo_player_id)
);
CREATE INDEX IF NOT EXISTS idx_rapsodo_players_owner ON rapsodo_players(owner_user_id);

-- One row per uploaded CSV (a bullpen session).
CREATE TABLE IF NOT EXISTS rapsodo_sessions (
    id                 SERIAL PRIMARY KEY,
    owner_user_id      UUID    NOT NULL,
    player_db_id       INTEGER NOT NULL REFERENCES rapsodo_players(id) ON DELETE CASCADE,
    rapsodo_player_id  TEXT    NOT NULL,
    session_date       DATE,
    device_serial      TEXT,
    device_generation  TEXT,
    intent_tags        TEXT,
    fastball_velo      NUMERIC(5,1),
    n_pitches          INTEGER,
    qc_ok              INTEGER DEFAULT 0,
    qc_low_confidence  INTEGER DEFAULT 0,
    qc_partial         INTEGER DEFAULT 0,
    qc_failed          INTEGER DEFAULT 0,
    source_file        TEXT,
    created_at         TIMESTAMP DEFAULT now(),
    UNIQUE (owner_user_id, rapsodo_player_id, source_file)   -- re-uploading a file replaces it
);
CREATE INDEX IF NOT EXISTS idx_rapsodo_sessions_owner ON rapsodo_sessions(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_rapsodo_sessions_player ON rapsodo_sessions(player_db_id);

-- Per-pitch grain (we re-cluster and trend, so no per-type aggregate).
-- Columns mirror app.stats.rapsodo_parse.normalize_pitch output.
CREATE TABLE IF NOT EXISTS rapsodo_pitches (
    id                 SERIAL PRIMARY KEY,
    session_id         INTEGER NOT NULL REFERENCES rapsodo_sessions(id) ON DELETE CASCADE,
    owner_user_id      UUID    NOT NULL,                 -- denormalized for fast owner-scoped reads
    player_db_id       INTEGER NOT NULL REFERENCES rapsodo_players(id) ON DELETE CASCADE,
    pitch_no           INTEGER,
    thrown_at          TIMESTAMP,
    raw_label          TEXT,                             -- Rapsodo's (unreliable) label, kept for audit
    pitch              TEXT,                             -- our re-classified label
    quality            TEXT,                             -- ok | low_confidence | partial | failed
    velo               NUMERIC(5,1),
    total_spin         INTEGER,
    active_spin        INTEGER,
    spin_eff           NUMERIC(5,2),
    spin_confidence    NUMERIC(4,2),
    gyro               NUMERIC(6,2),
    ivb                NUMERIC(5,1),
    hb_raw             NUMERIC(5,1),                     -- Rapsodo fixed frame (neg = breaks left)
    arm_hb             NUMERIC(5,1),                     -- normalized arm-side-positive
    movement_basis     TEXT,                             -- spin | trajectory | none
    tilt               TEXT,
    tilt_deg           NUMERIC(5,1),
    rel_height         NUMERIC(4,2),
    rel_side           NUMERIC(4,2),
    extension          NUMERIC(4,2),
    vaa                NUMERIC(5,2),
    haa                NUMERIC(5,2),
    bauer              NUMERIC(5,1),
    intent             TEXT,
    is_strike          TEXT,
    created_at         TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rapsodo_pitches_session ON rapsodo_pitches(session_id);
CREATE INDEX IF NOT EXISTS idx_rapsodo_pitches_player ON rapsodo_pitches(player_db_id);
CREATE INDEX IF NOT EXISTS idx_rapsodo_pitches_owner ON rapsodo_pitches(owner_user_id);
