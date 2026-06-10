#!/usr/bin/env python3
"""Create the user_profiles table.

One row per user_id, holding misc per-user state that doesn't fit
naturally in user_subscriptions (subscription/billing) or auth.users
(Supabase-managed). First field: affiliated_team_id — the team a
Coach or Dev user has tagged as "their team" for player-highlighting
and the portal default.

Run:
    PYTHONPATH=backend python3 scripts/create_user_profiles.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.models.database import get_connection  # noqa: E402


SQL = """
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id              UUID PRIMARY KEY,
    affiliated_team_id   INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_team
    ON user_profiles (affiliated_team_id);
"""


def main() -> int:
    with get_connection() as conn:
        cur = conn.cursor()
        for stmt in SQL.split(";"):
            s = stmt.strip()
            if s:
                cur.execute(s + ";")
        conn.commit()
    print("user_profiles table ready.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
