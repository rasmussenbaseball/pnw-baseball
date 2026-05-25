"""
Email broadcasts — admin compose & send (Phase 2 of the newsletter
pipeline). Sends through Resend (HTTPS API — DigitalOcean blocks all
outbound SMTP, so SMTP-based providers can't reach us). Endpoints are
gated by the same email allowlist used for Articles (ARTICLE_AUTHOR_EMAILS
env var, default just nate.rasmussen26@gmail.com).

Flow:
  1. Author writes a subject + markdown body in the composer UI.
  2. POST /portal/broadcasts/preview returns the rendered HTML so the
     UI can show an "as users will see it" preview.
  3. POST /portal/broadcasts/test sends ONLY to the author's own email
     so they can sanity-check it in their inbox.
  4. POST /portal/broadcasts/send actually fans out to everyone opted
     into the chosen audience (news / promos / updates) and writes an
     `email_broadcasts` row recording who sent it, when, audience, and
     how many landed.

Recipient list is `email_preferences` rows where the chosen flag is
true, joined to `auth.users` for the actual address.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..models.database import get_connection
from ..services import email_sender
from .articles import _resolve_author

router = APIRouter()


# ─────────────────────────────────────────────────────────────────
# Schemas
# ─────────────────────────────────────────────────────────────────

AUDIENCES = ("news", "promos", "updates")


class BroadcastCompose(BaseModel):
    """Shared shape for preview / test / send."""
    subject: str = Field(..., min_length=1, max_length=200)
    body_md: str = Field(..., min_length=1)
    audience: str  # one of AUDIENCES
    reply_to: Optional[str] = None  # default = author's own email


def _validate_audience(audience: str) -> str:
    if audience not in AUDIENCES:
        raise HTTPException(status_code=400, detail=f"audience must be one of {AUDIENCES}")
    return audience


# ─────────────────────────────────────────────────────────────────
# Recipient lookup
# ─────────────────────────────────────────────────────────────────

def _audience_column(audience: str) -> str:
    return {
        "news":    "subscribed_news",
        "promos":  "subscribed_promos",
        "updates": "subscribed_updates",
    }[audience]


def _list_recipients(audience: str) -> List[email_sender.Recipient]:
    """Pull (email, token) for every user opted into the given audience.
    Joins to auth.users for the address. Skips rows with no auth user
    (orphans, deleted accounts) so we never send into a black hole."""
    col = _audience_column(audience)
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            f"""
            SELECT au.email, ep.unsubscribe_token::text AS token
            FROM email_preferences ep
            JOIN auth.users au ON au.id = ep.user_id
            WHERE ep.{col} = TRUE
              AND au.email IS NOT NULL
              AND au.email <> ''
            """
        )
        rows = cur.fetchall()
    return [email_sender.Recipient(email=r["email"], token=r["token"]) for r in rows]


def _author_recipient(author: dict) -> List[email_sender.Recipient]:
    """For the 'send test to me' button: send only to the author. We
    still need a token for the unsubscribe link, but the author may not
    have an email_preferences row yet. If they don't, we emit a dummy
    UUID so the unsubscribe link is non-functional rather than wrong."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT unsubscribe_token::text AS token FROM email_preferences WHERE user_id = %s",
            (author["user_id"],),
        )
        row = cur.fetchone()
        token = (row and row["token"]) or "00000000-0000-0000-0000-000000000000"
    return [email_sender.Recipient(email=author["email"], token=token)]


# ─────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────

@router.get("/portal/broadcasts/audience-counts")
def audience_counts(author: dict = Depends(_resolve_author)):
    """Show the author how many opted-in users each audience has, so
    they know the blast size before clicking Send."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT
              COUNT(*) FILTER (WHERE subscribed_news    = TRUE) AS news,
              COUNT(*) FILTER (WHERE subscribed_promos  = TRUE) AS promos,
              COUNT(*) FILTER (WHERE subscribed_updates = TRUE) AS updates,
              COUNT(*) AS total_prompted
            FROM email_preferences ep
            JOIN auth.users au ON au.id = ep.user_id
            WHERE au.email IS NOT NULL AND au.email <> ''
            """
        )
        row = cur.fetchone() or {}
        return {
            "news":           int(row.get("news") or 0),
            "promos":         int(row.get("promos") or 0),
            "updates":        int(row.get("updates") or 0),
            "total_prompted": int(row.get("total_prompted") or 0),
        }


@router.post("/portal/broadcasts/preview")
def preview_broadcast(body: BroadcastCompose, author: dict = Depends(_resolve_author)):
    """Return the rendered HTML preview WITHOUT sending anything. The
    composer page calls this to show the author exactly what recipients
    will see."""
    _validate_audience(body.audience)
    body_html = email_sender.md_to_html(body.body_md)
    fake_unsub = email_sender.unsubscribe_url("00000000-0000-0000-0000-000000000000")
    html = email_sender.build_html(body.subject, body_html, fake_unsub)
    return {"html": html, "subject": body.subject}


@router.post("/portal/broadcasts/test")
def send_test_broadcast(body: BroadcastCompose, author: dict = Depends(_resolve_author)):
    """Send the email ONLY to the author so they can verify it in their
    inbox. Doesn't write an audit row — that's reserved for real sends."""
    _validate_audience(body.audience)
    try:
        result = email_sender.send_broadcast(
            subject=body.subject,
            body_md=body.body_md,
            recipients=_author_recipient(author),
            reply_to=body.reply_to or author["email"],
        )
    except RuntimeError as e:
        # e.g. RESEND_API_KEY not set
        raise HTTPException(status_code=500, detail=str(e))
    return {"test_to": author["email"], **result}


@router.post("/portal/broadcasts/send")
def send_broadcast(body: BroadcastCompose, author: dict = Depends(_resolve_author)):
    """Actually send to everyone opted into the chosen audience. Writes
    an `email_broadcasts` row capturing audience, recipient count, and
    sent/failed counts for the audit trail."""
    audience = _validate_audience(body.audience)
    recipients = _list_recipients(audience)
    recipient_count = len(recipients)

    if recipient_count == 0:
        raise HTTPException(
            status_code=400,
            detail=f"No subscribers opted into audience '{audience}'",
        )

    # Insert audit row first in 'sending' state. If the send blows up
    # mid-flight we still have a record of the attempt.
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO email_broadcasts
              (author_id, author_email, audience, subject, body_md,
               recipient_count, status, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, 'sending', NOW())
            RETURNING id
            """,
            (
                author["user_id"], author["email"], audience,
                body.subject, body.body_md, recipient_count,
            ),
        )
        broadcast_id = cur.fetchone()["id"]
        conn.commit()

    # Send (this can take a while — we're synchronous because broadcasts
    # are infrequent and FastAPI workers can handle the wait).
    try:
        result = email_sender.send_broadcast(
            subject=body.subject,
            body_md=body.body_md,
            recipients=recipients,
            reply_to=body.reply_to or author["email"],
        )
    except RuntimeError as e:
        # API key missing — flip the audit row to failed and surface it.
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                "UPDATE email_broadcasts SET status='failed', sent_at=NOW() WHERE id=%s",
                (broadcast_id,),
            )
            conn.commit()
        raise HTTPException(status_code=500, detail=str(e))

    # Update audit row with the final tallies.
    final_status = "sent" if result["failed"] == 0 else "partial"
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE email_broadcasts
               SET sent_count   = %s,
                   failed_count = %s,
                   status       = %s,
                   sent_at      = NOW()
             WHERE id = %s
            """,
            (result["sent"], result["failed"], final_status, broadcast_id),
        )
        conn.commit()

    return {
        "id": broadcast_id,
        "audience": audience,
        "recipient_count": recipient_count,
        **result,
        "status": final_status,
    }


@router.get("/portal/broadcasts")
def list_broadcasts(limit: int = 25, author: dict = Depends(_resolve_author)):
    """Recent broadcasts (most recent first) for the audit view."""
    limit = max(1, min(int(limit), 100))
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, audience, subject, recipient_count, sent_count,
                   failed_count, status, author_email,
                   created_at, sent_at
            FROM email_broadcasts
            ORDER BY id DESC
            LIMIT %s
            """,
            (limit,),
        )
        rows = cur.fetchall()
    out = []
    for r in rows:
        d = dict(r)
        for k in ("created_at", "sent_at"):
            d[k] = d[k].isoformat() if d.get(k) else None
        out.append(d)
    return {"broadcasts": out}
