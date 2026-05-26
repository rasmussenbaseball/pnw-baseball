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

from fastapi import APIRouter, Depends, Request

from ..models.database import get_connection
from .auth import get_current_user, _extract_token
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
                   subscription_id, customer_id
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
    for k in ("started_at", "ends_at", "current_period_end"):
        r[k] = r[k].isoformat() if r.get(k) else None
    r["has_stripe_customer"] = bool(r.get("customer_id"))
    r["comped"] = False
    # Don't leak the raw customer_id / subscription_id to the frontend.
    r.pop("customer_id", None)
    r.pop("subscription_id", None)
    return r
