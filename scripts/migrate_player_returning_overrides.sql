-- Manual returning/departing overrides for the Team Profile V2 "Returning
-- Production" / "Team Identity" computations. Default returning status is
-- derived from class year; this table lets an editor force a player's status
-- (e.g. a senior granted another year, or an underclassman in the portal).
CREATE TABLE IF NOT EXISTS player_returning_overrides (
    player_id   INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
    season      INTEGER NOT NULL,          -- the season the override applies FROM
    status      TEXT    NOT NULL CHECK (status IN ('returning', 'departing')),
    note        TEXT,
    set_by      TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pro_season ON player_returning_overrides (season);
