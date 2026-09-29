"""
"My Account" endpoints.

Account metadata that doesn't have a more specific home. Email preferences
live in api/email_prefs.py. There are no paid tiers (September 2026): the
only access distinction on the site is the developer allowlist, which
/me/access reports so the frontend can show internal tools.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..models.database import get_connection
from .auth import get_current_user, _extract_token
from ._tier_allowlist import email_for_token, is_developer_email

router = APIRouter()


@router.get("/me/access")
def get_my_access(request: Request, user_id: str = Depends(get_current_user)):
    """Whether the signed-in user is on the developer allowlist."""
    email = email_for_token(_extract_token(request))
    return {"developer": is_developer_email(email)}


# ─────────────────────────────────────────────────────────────
# Affiliated team — "your team" for signed-in users.
# Powers the player-highlight feature and the Portal's default
# team selection.
# ─────────────────────────────────────────────────────────────

class AffiliationUpdate(BaseModel):
    # Null = "No affiliation" (the explicit opt-out).
    team_id: Optional[int] = None


def _hydrate_team(cur, team_id: Optional[int]) -> Optional[dict]:
    """Look up the team row for a given team_id. Returns None when
    team_id is None OR the team doesn't exist."""
    if not team_id:
        return None
    cur.execute(
        """
        SELECT t.id, t.short_name, t.school_name, t.logo_url,
               d.level AS division_level, c.abbreviation AS conference_abbrev
        FROM teams t
        LEFT JOIN conferences c ON c.id = t.conference_id
        LEFT JOIN divisions d ON d.id = c.division_id
        WHERE t.id = %s
        """,
        (team_id,),
    )
    row = cur.fetchone()
    return dict(row) if row else None


@router.get("/me/affiliated-team")
def get_affiliated_team(user_id: str = Depends(get_current_user)):
    """Return the user's affiliated team (or null when they haven't
    set one yet)."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT affiliated_team_id FROM user_profiles WHERE user_id = %s",
            (user_id,),
        )
        row = cur.fetchone()
        team_id = row["affiliated_team_id"] if row else None
        team = _hydrate_team(cur, team_id)
    return {"team_id": team_id, "team": team}


@router.put("/me/affiliated-team")
def set_affiliated_team(
    payload: AffiliationUpdate,
    user_id: str = Depends(get_current_user),
):
    """Set or clear the user's affiliated team. Any signed-in user may
    set one. Passing team_id=null is the explicit "No affiliation"
    choice and clears any prior selection.
    """
    team_id = payload.team_id
    if team_id is not None:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT 1 FROM teams WHERE id = %s", (team_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="team not found")

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO user_profiles (user_id, affiliated_team_id)
            VALUES (%s, %s)
            ON CONFLICT (user_id) DO UPDATE SET
                affiliated_team_id = EXCLUDED.affiliated_team_id,
                updated_at = now()
            """,
            (user_id, team_id),
        )
        conn.commit()
        cur.execute(
            "SELECT affiliated_team_id FROM user_profiles WHERE user_id = %s",
            (user_id,),
        )
        row = cur.fetchone()
        team = _hydrate_team(cur, row["affiliated_team_id"] if row else None)
    return {"team_id": team_id, "team": team}
