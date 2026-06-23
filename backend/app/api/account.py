"""
"My Account" endpoints.

A small landing surface for user-account data that doesn't have a more
specific home — subscription tier, account metadata. Email preferences
live in api/email_prefs.py.

Phase 1: just the subscription tier (everyone is implicitly 'free' unless
they have an explicit row in `user_subscriptions`). Phase 2 will wire
a Stripe webhook in here that flips a user to 'paid' when they purchase.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..models.database import get_connection
from .auth import get_current_user, _extract_token, require_tier, comp_aware_tier
from ._tier_allowlist import email_for_token, resolve_comped_tier

router = APIRouter()


@router.get("/me/subscription")
def get_my_subscription(request: Request, user_id: str = Depends(get_current_user)):
    """Return this user's subscription tier and timing.

    Resolution order:
      1. If the email is on the developer allowlist → tier='dev'
         with comped=True. Bypasses every gate.
      2. If the email is on the comped-coach allowlist → tier='coach'
         with comped=True (lifetime Coach & Scout, no billing).
      3. Otherwise read from user_subscriptions. Falls back to
         tier='free' for users with no row.

    The comped paths return synthetic timing fields (no billing
    period, no Stripe customer) so the Account UI can render
    'Lifetime access' instead of 'Manage Subscription'.
    """
    # Try comped-allowlist resolution first — these short-circuit any
    # DB row the user might have.
    token = _extract_token(request)
    comped_email = email_for_token(token) if token else None
    comped_tier = resolve_comped_tier(comped_email)

    if comped_tier:
        return {
            "tier": comped_tier,
            "started_at": None,
            "ends_at": None,
            "external_ref": None,
            "interval": "lifetime",
            "current_period_end": None,
            "cancel_at_period_end": False,
            "has_stripe_customer": False,
            "comped": True,
            "comped_label": (
                "Developer · Free Forever"
                if comped_tier == "dev"
                else "Coach & Scout · Free Forever"
            ),
        }

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT tier, started_at, ends_at, external_ref,
                   interval, current_period_end, cancel_at_period_end,
                   subscription_id, customer_id, provider
            FROM user_subscriptions
            WHERE user_id = %s
            """,
            (user_id,),
        )
        row = cur.fetchone()

    if not row:
        return {
            "tier": "free",
            "started_at": None,
            "ends_at": None,
            "external_ref": None,
            "interval": None,
            "current_period_end": None,
            "cancel_at_period_end": False,
            "has_stripe_customer": False,
            "comped": False,
        }

    r = dict(row)
    # A comp grant auto-expires at ends_at; reflect that as the effective tier so
    # the UI matches what the API gate enforces.
    is_comp = r.get("provider") == "comp"
    eff_tier = comp_aware_tier(r.get("tier"), r.get("provider"), r.get("ends_at"))
    comp_active = is_comp and eff_tier != "free"
    r["tier"] = eff_tier
    for k in ("started_at", "ends_at", "current_period_end"):
        r[k] = r[k].isoformat() if r.get(k) else None
    r["has_stripe_customer"] = bool(r.get("customer_id"))
    r["comped"] = comp_active
    if comp_active:
        r["comped_label"] = f"Comp · {eff_tier.title()} (through {r['ends_at'][:10]})"
    # Don't leak the raw customer_id / subscription_id / provider to the frontend.
    r.pop("customer_id", None)
    r.pop("subscription_id", None)
    r.pop("provider", None)
    return r


# ─────────────────────────────────────────────────────────────
# Affiliated team — "your team" for Coach/Dev users.
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
    user_id: str = Depends(require_tier("coach")),
):
    """Set or clear the user's affiliated team.

    Requires Coach or Dev tier — free / premium users cannot opt in.
    Passing team_id=null is the explicit "No affiliation" choice and
    clears any prior selection.
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
