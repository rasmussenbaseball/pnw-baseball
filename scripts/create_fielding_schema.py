#!/usr/bin/env python3
"""Create the fielding-stats schema: game_fielding + fielding_stats.

Mirrors the structure of game_batting/game_pitching → batting_stats /
pitching_stats:

  game_fielding   : one row per (game, player, position) — the source
                    of truth that's idempotent on rescrape.
  fielding_stats  : per-season aggregate per (player, team, season,
                    position) computed from game_fielding via the
                    aggregate_fielding.py roll-up.

Per-position is the whole point: a player who logged 22 games at SS
and 4 games at RF gets two fielding_stats rows so you can see his
.962 / 1.000 split rather than a blended .967.

Run on the server:

    cd /opt/pnw-baseball
    PYTHONPATH=backend python3 scripts/create_fielding_schema.py

Idempotent — uses CREATE TABLE IF NOT EXISTS.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.models.database import get_connection  # noqa: E402


SCHEMA_SQL = """
-- ─────────────────────────────────────────────────────────────
-- game_fielding: per-game, per-position fielding line
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS game_fielding (
    id              SERIAL PRIMARY KEY,
    game_id         INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    team_id         INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    player_id       INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    -- Normalized position code (P / C / 1B / 2B / 3B / SS / LF / CF /
    -- RF / OF / IF). DH / PH / PR rows are not stored because they
    -- have no defensive component.
    position        VARCHAR(4) NOT NULL,
    -- Defensive innings at this position in this game. Not always
    -- available from the source feed, so nullable.
    innings         NUMERIC(4,1),
    -- Did the player start at this position? Helps separate full-
    -- game starters from late-inning subs.
    games_started   SMALLINT NOT NULL DEFAULT 0,
    putouts         INTEGER NOT NULL DEFAULT 0,
    assists         INTEGER NOT NULL DEFAULT 0,
    errors          INTEGER NOT NULL DEFAULT 0,
    double_plays    INTEGER NOT NULL DEFAULT 0,
    triple_plays    INTEGER NOT NULL DEFAULT 0,
    -- Catcher-specific
    passed_balls           INTEGER NOT NULL DEFAULT 0,
    stolen_bases_against   INTEGER NOT NULL DEFAULT 0,
    caught_stealing_by     INTEGER NOT NULL DEFAULT 0,
    pickoffs               INTEGER NOT NULL DEFAULT 0,
    catchers_interference  INTEGER NOT NULL DEFAULT 0,

    created_at      TIMESTAMP NOT NULL DEFAULT now(),
    updated_at      TIMESTAMP NOT NULL DEFAULT now(),

    -- Idempotency: one fielding line per (game, player, position).
    -- A re-scrape UPSERTs onto this key.
    CONSTRAINT game_fielding_unique UNIQUE (game_id, player_id, position)
);

-- Fast lookups by player (player profile page) and by team/game
-- (team-game fielding rollup, error tracking).
CREATE INDEX IF NOT EXISTS idx_game_fielding_player
    ON game_fielding (player_id, position);
CREATE INDEX IF NOT EXISTS idx_game_fielding_team_game
    ON game_fielding (team_id, game_id);
CREATE INDEX IF NOT EXISTS idx_game_fielding_game
    ON game_fielding (game_id);


-- ─────────────────────────────────────────────────────────────
-- fielding_stats: per-season aggregate per (player, position)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fielding_stats (
    id              SERIAL PRIMARY KEY,
    player_id       INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    team_id         INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    season          INTEGER NOT NULL,
    position        VARCHAR(4) NOT NULL,

    games           INTEGER NOT NULL DEFAULT 0,
    games_started   INTEGER NOT NULL DEFAULT 0,
    -- Total innings at this position across the season. NULL when
    -- innings aren't available from any of the player's games at
    -- this position.
    innings                NUMERIC(7,1),
    putouts                INTEGER NOT NULL DEFAULT 0,
    assists                INTEGER NOT NULL DEFAULT 0,
    errors                 INTEGER NOT NULL DEFAULT 0,
    double_plays           INTEGER NOT NULL DEFAULT 0,
    triple_plays           INTEGER NOT NULL DEFAULT 0,
    passed_balls           INTEGER NOT NULL DEFAULT 0,
    stolen_bases_against   INTEGER NOT NULL DEFAULT 0,
    caught_stealing_by     INTEGER NOT NULL DEFAULT 0,
    pickoffs               INTEGER NOT NULL DEFAULT 0,
    catchers_interference  INTEGER NOT NULL DEFAULT 0,

    -- Derived. Stored so leaderboards don't have to recompute.
    -- total_chances = PO + A + E. fielding_pct = (PO + A) / TC.
    -- range_factor = (PO + A) / innings * 9. cs_pct = CS / (CS + SBA).
    total_chances      INTEGER GENERATED ALWAYS AS (putouts + assists + errors) STORED,
    fielding_pct       NUMERIC(5,4),
    range_factor       NUMERIC(6,2),
    cs_pct             NUMERIC(5,4),

    created_at      TIMESTAMP NOT NULL DEFAULT now(),
    updated_at      TIMESTAMP NOT NULL DEFAULT now(),

    CONSTRAINT fielding_stats_unique UNIQUE (player_id, season, position, team_id)
);

CREATE INDEX IF NOT EXISTS idx_fielding_stats_player_season
    ON fielding_stats (player_id, season);
CREATE INDEX IF NOT EXISTS idx_fielding_stats_team_season
    ON fielding_stats (team_id, season);
CREATE INDEX IF NOT EXISTS idx_fielding_stats_season_position
    ON fielding_stats (season, position);
"""


def main() -> int:
    with get_connection() as conn:
        cur = conn.cursor()
        # Run each statement separately so partial failures are easier
        # to spot. Postgres accepts the whole block too but per-stmt
        # echoing is friendlier.
        for stmt in SCHEMA_SQL.split(";"):
            s = stmt.strip()
            if not s:
                continue
            cur.execute(s + ";")
        conn.commit()
    print("game_fielding + fielding_stats tables ready.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
