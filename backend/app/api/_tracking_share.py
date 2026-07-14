"""Tracking-workspace sharing for the TrackMan Suite + Rapsodo Lab.

Both tools are private per-coach workspaces keyed by owner_user_id. This
module lets a coach share their workspace with staff emails so the whole
staff sees ONE data pool: a member whose email is on a share list, and who
has no uploads of their own, transparently acts AS the sharing owner —
their reads, uploads, and overrides all resolve to the shared workspace.
No per-query changes and no double counting; only the owner id that every
endpoint already scopes by gets remapped at the gate.

Rules:
  - Coach tier required as usual (staff-seat members qualify).
  - A member with their OWN uploads keeps their own workspace (we never
    silently merge two coaches' data).
  - Managed from the TrackMan Suite Overview tab; one list covers both
    tools. Max 6 staff emails per owner.
"""
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..models.database import get_connection
from ._tier_allowlist import email_for_token
from .auth import _extract_token, require_tier

router = APIRouter(tags=["tracking-share"])

_gate = require_tier("coach")
MAX_SHARE_EMAILS = 6

# email -> (effective_owner_or_None, expires_at). Keeps the per-request cost
# of workspace resolution to ~zero on repeat calls.
_CACHE: dict = {}
_CACHE_TTL = 60


def _ensure_table(cur):
    cur.execute(
        """CREATE TABLE IF NOT EXISTS tracking_workspace_shares (
             id SERIAL PRIMARY KEY,
             owner_user_id UUID NOT NULL,
             member_email  TEXT NOT NULL,
             created_at    TIMESTAMPTZ DEFAULT NOW(),
             UNIQUE (owner_user_id, member_email)
           )"""
    )


def invalidate_share_cache():
    _CACHE.clear()


def resolve_workspace(request: Request, owner: str) -> str:
    """Effective workspace owner for this caller. Fail-open to their own id."""
    try:
        email = (email_for_token(_extract_token(request)) or "").strip().lower()
        if not email:
            return owner
        hit = _CACHE.get(email)
        now = time.time()
        if hit and hit[1] > now:
            return hit[0] or owner
        eff = None
        with get_connection() as conn:
            cur = conn.cursor()
            try:
                cur.execute(
                    """SELECT owner_user_id FROM tracking_workspace_shares
                       WHERE member_email = %s ORDER BY created_at DESC""",
                    (email,),
                )
                owners = [str(r["owner_user_id"]) for r in cur.fetchall()]
            except Exception:
                conn.rollback()
                owners = []
            if owners and owners[0] != owner:
                # Only adopt the shared workspace when the member has no
                # uploads of their own (never merge two coaches' data).
                has_own = False
                for table in ("tm_sessions", "rapsodo_sessions"):
                    try:
                        cur.execute(f"SELECT 1 FROM {table} WHERE owner_user_id = %s LIMIT 1", (owner,))
                        if cur.fetchone():
                            has_own = True
                            break
                    except Exception:
                        conn.rollback()
                if not has_own:
                    eff = owners[0]
        _CACHE[email] = (eff, now + _CACHE_TTL)
        return eff or owner
    except Exception:
        return owner


# ── Management endpoints (owner side) ────────────────────────────

class ShareAdd(BaseModel):
    email: str


@router.get("/portal/tracking-share")
def list_shares(request: Request, owner: str = Depends(_gate)):
    email = (email_for_token(_extract_token(request)) or "").strip().lower()
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_table(cur)
        cur.execute(
            "SELECT id, member_email, created_at::date AS added FROM tracking_workspace_shares "
            "WHERE owner_user_id = %s ORDER BY created_at",
            (owner,),
        )
        members = [{"id": r["id"], "email": r["member_email"],
                    "added": r["added"].isoformat() if r["added"] else None}
                   for r in cur.fetchall()]
        # Is the CALLER a member of someone else's workspace right now?
        cur.execute(
            "SELECT owner_user_id FROM tracking_workspace_shares WHERE member_email = %s "
            "ORDER BY created_at DESC LIMIT 1",
            (email,),
        )
        row = cur.fetchone()
        conn.commit()
    viewing_shared = bool(row) and resolve_workspace(request, owner) != owner
    return {"members": members, "max": MAX_SHARE_EMAILS, "viewing_shared": viewing_shared}


@router.post("/portal/tracking-share")
def add_share(body: ShareAdd, request: Request, owner: str = Depends(_gate)):
    email = (body.email or "").strip().lower()
    self_email = (email_for_token(_extract_token(request)) or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="A valid email is required.")
    if email == self_email:
        raise HTTPException(status_code=400, detail="That's your own email.")
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_table(cur)
        cur.execute("SELECT COUNT(*) AS n FROM tracking_workspace_shares WHERE owner_user_id = %s", (owner,))
        if (cur.fetchone()["n"] or 0) >= MAX_SHARE_EMAILS:
            raise HTTPException(status_code=400, detail=f"Share list is limited to {MAX_SHARE_EMAILS} emails.")
        cur.execute(
            """INSERT INTO tracking_workspace_shares (owner_user_id, member_email)
               VALUES (%s, %s) ON CONFLICT (owner_user_id, member_email) DO NOTHING""",
            (owner, email),
        )
        conn.commit()
    invalidate_share_cache()
    return {"status": "ok", "email": email}


@router.delete("/portal/tracking-share/{share_id}")
def remove_share(share_id: int, owner: str = Depends(_gate)):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM tracking_workspace_shares WHERE id = %s AND owner_user_id = %s",
                    (share_id, owner))
        if not cur.rowcount:
            raise HTTPException(status_code=404, detail="Share not found.")
        conn.commit()
    invalidate_share_cache()
    return {"status": "ok"}
