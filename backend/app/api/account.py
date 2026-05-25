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

from fastapi import APIRouter, Depends

from ..models.database import get_connection
from .auth import get_current_user

router = APIRouter()


@router.get("/me/subscription")
def get_my_subscription(user_id: str = Depends(get_current_user)):
    """Return this user's subscription tier and timing. Falls back to
    'free' for users who don't have an explicit row, which is everyone
    in Phase 1. The fallback means we never have to backfill — new and
    existing users are all 'free' until proven otherwise."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT tier, started_at, ends_at, external_ref
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
        }

    r = dict(row)
    for k in ("started_at", "ends_at"):
        r[k] = r[k].isoformat() if r.get(k) else None
    return r
