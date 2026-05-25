"""
Email preferences backend (Phase 1 of the newsletter pipeline).

Tracks who's opted into which mailing lists. The actual send pipeline
(Phase 2) — Resend integration, broadcast composer, unsubscribe page —
plugs into this same table.

Three opt-in flags:
  • subscribed_news    — Newsletter / regular content drops
  • subscribed_promos  — Promotional emails (paid-tier offers, etc.)
  • subscribed_updates — Site announcements (new features, etc.)

`prompted_at` is set the moment a user answers the popup (yes OR no) so
we never bug them again. `unsubscribe_token` is the per-user UUID used
later for one-click unsubscribe URLs.
"""

from __future__ import annotations

import uuid as _uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..models.database import get_connection
from .auth import get_current_user

router = APIRouter()


class PrefsPayload(BaseModel):
    subscribed_news: bool = False
    subscribed_promos: bool = False
    subscribed_updates: bool = False


@router.get("/email-preferences/me")
def get_my_prefs(user_id: str = Depends(get_current_user)):
    """Return this user's preferences row, or `null` if they've never
    answered the popup. The popup uses `null` as the signal to show
    itself; once any answer is recorded (even all-No), the popup is
    suppressed forever for that user."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT user_id, subscribed_news, subscribed_promos,
                   subscribed_updates, prompted_at, updated_at
            FROM email_preferences
            WHERE user_id = %s
            """,
            (user_id,),
        )
        row = cur.fetchone()
        if not row:
            return {"preferences": None}
        r = dict(row)
        r["user_id"] = str(r["user_id"])
        for k in ("prompted_at", "updated_at"):
            r[k] = r[k].isoformat() if r[k] else None
        return {"preferences": r}


@router.put("/email-preferences/me")
def upsert_my_prefs(
    body: PrefsPayload,
    user_id: str = Depends(get_current_user),
):
    """Create or update this user's preferences. Stamps prompted_at so
    the popup never reappears. Returns the saved row."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO email_preferences
              (user_id, subscribed_news, subscribed_promos, subscribed_updates,
               prompted_at, updated_at)
            VALUES (%s, %s, %s, %s, NOW(), NOW())
            ON CONFLICT (user_id) DO UPDATE SET
              subscribed_news    = EXCLUDED.subscribed_news,
              subscribed_promos  = EXCLUDED.subscribed_promos,
              subscribed_updates = EXCLUDED.subscribed_updates,
              prompted_at        = COALESCE(email_preferences.prompted_at, EXCLUDED.prompted_at),
              updated_at         = NOW()
            RETURNING user_id, subscribed_news, subscribed_promos,
                      subscribed_updates, prompted_at, updated_at
            """,
            (user_id, body.subscribed_news, body.subscribed_promos, body.subscribed_updates),
        )
        row = dict(cur.fetchone())
        conn.commit()
        row["user_id"] = str(row["user_id"])
        for k in ("prompted_at", "updated_at"):
            row[k] = row[k].isoformat() if row[k] else None
        return {"preferences": row}


# ─────────────────────────────────────────────────────────────────
# Unsubscribe-by-token (PUBLIC — token is the auth)
# ─────────────────────────────────────────────────────────────────
#
# Every broadcast email carries a personalized URL of the form
#   https://nwbaseballstats.com/unsubscribe?token=<uuid>
# pointing at the recipient's `email_preferences.unsubscribe_token`.
#
# These endpoints let the recipient flip lists off (or fully unsubscribe)
# WITHOUT logging in. The token IS the credential, so we never expose
# more than the three boolean flags + a redacted email. We also support
# RFC 8058 one-click unsubscribe (Gmail "Unsubscribe" button) via the
# PUT /one-click endpoint.

class UnsubPayload(BaseModel):
    subscribed_news: bool = False
    subscribed_promos: bool = False
    subscribed_updates: bool = False


def _is_uuid(s: str) -> bool:
    try:
        _uuid.UUID(str(s))
        return True
    except (ValueError, TypeError, AttributeError):
        return False


def _redact_email(email: str | None) -> str | None:
    if not email or "@" not in email:
        return None
    local, _, domain = email.partition("@")
    if len(local) <= 2:
        masked = local[:1] + "*"
    else:
        masked = local[0] + "*" * (len(local) - 2) + local[-1]
    return f"{masked}@{domain}"


@router.get("/email-preferences/by-token/{token}")
def get_prefs_by_token(token: str):
    """Public: look up a preferences row by its unsubscribe token.
    Returns the 3 booleans and a redacted email so the page can show
    "Managing preferences for n***e@gmail.com". Never returns user_id
    or the full email — token alone is a low-trust credential."""
    if not _is_uuid(token):
        raise HTTPException(status_code=400, detail="Invalid token")

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT ep.subscribed_news, ep.subscribed_promos, ep.subscribed_updates,
                   au.email
            FROM email_preferences ep
            LEFT JOIN auth.users au ON au.id = ep.user_id
            WHERE ep.unsubscribe_token = %s
            """,
            (token,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Token not found")
        return {
            "subscribed_news":    bool(row["subscribed_news"]),
            "subscribed_promos":  bool(row["subscribed_promos"]),
            "subscribed_updates": bool(row["subscribed_updates"]),
            "email_redacted":     _redact_email(row["email"]),
        }


@router.put("/email-preferences/by-token/{token}")
def update_prefs_by_token(token: str, body: UnsubPayload):
    """Public: update preferences by unsubscribe token. Use case is
    the /unsubscribe?token=... page where recipients toggle lists off
    without signing in."""
    if not _is_uuid(token):
        raise HTTPException(status_code=400, detail="Invalid token")

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE email_preferences
               SET subscribed_news    = %s,
                   subscribed_promos  = %s,
                   subscribed_updates = %s,
                   updated_at         = NOW()
             WHERE unsubscribe_token  = %s
             RETURNING subscribed_news, subscribed_promos, subscribed_updates
            """,
            (body.subscribed_news, body.subscribed_promos, body.subscribed_updates, token),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Token not found")
        conn.commit()
        return {
            "subscribed_news":    bool(row["subscribed_news"]),
            "subscribed_promos":  bool(row["subscribed_promos"]),
            "subscribed_updates": bool(row["subscribed_updates"]),
        }


@router.post("/email-preferences/by-token/{token}/one-click")
def one_click_unsubscribe(token: str):
    """Public: RFC 8058 one-click unsubscribe handler. This is the URL
    hit by Gmail/Apple Mail's native "Unsubscribe" button. We flip ALL
    flags to false (the spec doesn't allow finer control — it's pure
    "stop emailing me")."""
    if not _is_uuid(token):
        raise HTTPException(status_code=400, detail="Invalid token")

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE email_preferences
               SET subscribed_news = FALSE,
                   subscribed_promos = FALSE,
                   subscribed_updates = FALSE,
                   updated_at = NOW()
             WHERE unsubscribe_token = %s
             RETURNING 1
            """,
            (token,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Token not found")
        conn.commit()
        return {"unsubscribed": True}
