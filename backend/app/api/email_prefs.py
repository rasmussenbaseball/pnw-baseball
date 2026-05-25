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
