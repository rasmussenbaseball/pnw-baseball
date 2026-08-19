"""Staff workspace sharing for the TrackMan Suite + Rapsodo Lab.

Both tools are private per-coach workspaces keyed by owner_user_id. A
staff member whose email is on the coach's staff list, and who has no
uploads of their own, transparently acts AS the coach's workspace: reads,
uploads, and overrides all resolve to the shared pool. No per-query
changes and no double counting; only the owner id that every endpoint
already scopes by gets remapped at the gate.

UNIFIED with Coach & Scout staff seats (July 2026): `coach_staff_seats`
(the subscription-sharing list in account.py/auth.py) is the primary
staff list — a seat grants the coach-tier membership AND both data
workspaces. `tracking_workspace_shares` remains as the data-only layer
for owners who can't grant seats (comped coaches; see _owner_can_share).
The /portal/my-staff endpoints manage both as one list; the StaffManager
widget (portal home + TrackMan Overview) is the UI.

Rules:
  - Coach tier required as usual (staff-seat members qualify).
  - A member with their OWN uploads keeps their own workspace (we never
    silently merge two coaches' data).
"""
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..models.database import get_connection
from ._tier_allowlist import email_for_token
from .auth import _extract_token, require_tier

router = APIRouter(tags=["tracking-share"])

_gate = require_tier("coach")
MAX_SHARE_EMAILS = 8   # data-sharing cap (membership seats stay at auth.MAX_STAFF_SEATS)

# email -> (effective_owner_or_None, expires_at). Keeps the per-request cost
# of workspace resolution to ~zero on repeat calls.
_CACHE: dict = {}
_CACHE_TTL = 60


_TABLE_READY = False


def _ensure_table(cur):
    global _TABLE_READY
    if _TABLE_READY:
        return
    cur.execute(
        """CREATE TABLE IF NOT EXISTS tracking_workspace_shares (
             id SERIAL PRIMARY KEY,
             owner_user_id UUID NOT NULL,
             member_email  TEXT NOT NULL,
             created_at    TIMESTAMPTZ DEFAULT NOW(),
             UNIQUE (owner_user_id, member_email)
           )"""
    )
    # NOTE: no unconditional ALTER here — ADD COLUMN takes an ACCESS
    # EXCLUSIVE lock even when the column exists, and running it per
    # request self-deadlocked against resolve_workspace's second
    # connection (2026-08-18). Check the catalog first; the ALTER only
    # ever runs once per database.
    cur.execute("""SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tracking_workspace_shares' AND column_name = 'can_upload'""")
    if not cur.fetchone():
        cur.execute("ALTER TABLE tracking_workspace_shares ADD COLUMN can_upload BOOLEAN DEFAULT TRUE")
    _TABLE_READY = True


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
            owners = []
            # Staff seats first (the membership relationship), then any
            # data-only shares — one seat covers membership + workspaces.
            try:
                cur.execute(
                    """SELECT owner_user_id FROM coach_staff_seats
                       WHERE LOWER(member_email) = %s ORDER BY created_at DESC""",
                    (email,),
                )
                owners += [str(r["owner_user_id"]) for r in cur.fetchall()]
            except Exception:
                conn.rollback()
            try:
                cur.execute(
                    """SELECT owner_user_id FROM tracking_workspace_shares
                       WHERE member_email = %s ORDER BY created_at DESC""",
                    (email,),
                )
                owners += [str(r["owner_user_id"]) for r in cur.fetchall()]
            except Exception:
                conn.rollback()
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


def ensure_can_upload(request: Request, resolved_owner: str) -> None:
    """403 when the caller is a staff MEMBER of this workspace whose share
    has uploads switched off. The owner (no share row for their email under
    their own workspace) and unknown callers pass — fail-open like
    resolve_workspace; the tier gate already ran."""
    try:
        email = (email_for_token(_extract_token(request)) or "").strip().lower()
        if not email:
            return
        key = ("up", resolved_owner, email)
        now = time.time()
        hit = _CACHE.get(key)
        if hit and hit[1] > now:
            allowed = hit[0]
        else:
            allowed = True
            with get_connection() as conn:
                cur = conn.cursor()
                try:
                    cur.execute(
                        """SELECT can_upload FROM tracking_workspace_shares
                           WHERE owner_user_id = %s AND member_email = %s""",
                        (resolved_owner, email))
                    row = cur.fetchone()
                    if row is not None and row.get("can_upload") is False:
                        allowed = False
                except Exception:
                    conn.rollback()
            _CACHE[key] = (allowed, now + _CACHE_TTL)
        if not allowed:
            raise HTTPException(
                status_code=403,
                detail="The workspace owner hasn't enabled uploads for your account. "
                       "Ask them to switch on uploads for you in My Staff.")
    except HTTPException:
        raise
    except Exception:
        return


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


# ── Unified "My Staff" (seats + data sharing as ONE list) ────────
# GET/POST/DELETE /portal/my-staff — the StaffManager widget's API.
# POST adds a membership seat when the owner can grant them (paying
# Coach & Scout sub or dev; auth._owner_can_share) and always shares
# the TrackMan + Rapsodo workspaces. DELETE removes both.

def _my_staff_ctx(request: Request, owner: str) -> dict:
    from .auth import _owner_can_share
    email = (email_for_token(_extract_token(request)) or "").strip().lower()
    can_seats = False
    if email:
        with get_connection() as conn:
            cur = conn.cursor()
            try:
                can_seats = bool(_owner_can_share(cur, owner, email))
            except Exception:
                conn.rollback()
    return {"email": email, "can_seats": can_seats}


@router.get("/portal/my-staff")
def my_staff(request: Request, owner: str = Depends(_gate)):
    from .auth import MAX_STAFF_SEATS, _ensure_staff_seats_table
    ctx = _my_staff_ctx(request, owner)
    members: dict = {}
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_staff_seats_table(cur)
        _ensure_table(cur)
        cur.execute(
            "SELECT LOWER(member_email) AS email, created_at::date AS added FROM coach_staff_seats "
            "WHERE owner_user_id = %s ORDER BY created_at", (owner,))
        for r in cur.fetchall():
            members[r["email"]] = {"email": r["email"], "seat": True, "data": True,
                                   "can_upload": True,
                                   "added": r["added"].isoformat() if r["added"] else None}
        cur.execute(
            "SELECT member_email AS email, can_upload, created_at::date AS added "
            "FROM tracking_workspace_shares "
            "WHERE owner_user_id = %s ORDER BY created_at", (owner,))
        for r in cur.fetchall():
            m = members.setdefault(r["email"], {"email": r["email"], "seat": False, "data": True,
                                                "added": r["added"].isoformat() if r["added"] else None})
            m["data"] = True
            m["can_upload"] = r["can_upload"] is not False
        # Is the caller viewing a workspace someone shared with THEM?
        viewing = resolve_workspace(request, owner) != owner
        conn.commit()
    return {
        "members": sorted(members.values(), key=lambda m: m["added"] or ""),
        "max": MAX_SHARE_EMAILS,
        "seats_max": MAX_STAFF_SEATS,
        "can_seats": ctx["can_seats"],
        "viewing_shared": viewing,
    }


@router.post("/portal/my-staff")
def my_staff_add(body: ShareAdd, request: Request, owner: str = Depends(_gate)):
    from .auth import MAX_STAFF_SEATS, _ensure_staff_seats_table
    ctx = _my_staff_ctx(request, owner)
    email = (body.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="A valid email is required.")
    if email == ctx["email"]:
        raise HTTPException(status_code=400, detail="That's your own account email.")
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_staff_seats_table(cur)
        _ensure_table(cur)
        cur.execute(
            """SELECT COUNT(DISTINCT e) AS n FROM (
                 SELECT LOWER(member_email) AS e FROM coach_staff_seats WHERE owner_user_id = %s
                 UNION SELECT member_email FROM tracking_workspace_shares WHERE owner_user_id = %s
               ) u""", (owner, owner))
        if (cur.fetchone()["n"] or 0) >= MAX_SHARE_EMAILS:
            raise HTTPException(status_code=400,
                                detail=f"Your staff list is limited to {MAX_SHARE_EMAILS} coaches.")
        cur.execute("SELECT COUNT(*) AS n FROM coach_staff_seats WHERE owner_user_id = %s", (owner,))
        seats_used = cur.fetchone()["n"] or 0
        seat = False
        if ctx["can_seats"] and seats_used < MAX_STAFF_SEATS:
            cur.execute(
                """INSERT INTO coach_staff_seats (owner_user_id, owner_email, member_email)
                   VALUES (%s, %s, %s) ON CONFLICT (owner_user_id, member_email) DO NOTHING""",
                (owner, ctx["email"], email))
            seat = True
        cur.execute(
            """INSERT INTO tracking_workspace_shares (owner_user_id, member_email)
               VALUES (%s, %s) ON CONFLICT (owner_user_id, member_email) DO NOTHING""",
            (owner, email))
        conn.commit()
    invalidate_share_cache()
    return {"status": "ok", "email": email, "seat": seat}


class SharePatch(BaseModel):
    can_upload: bool


@router.patch("/portal/my-staff/{member_email}")
def my_staff_patch(member_email: str, body: SharePatch, owner: str = Depends(_gate)):
    """Owner toggles whether a staff member may upload/delete data."""
    email = (member_email or "").strip().lower()
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_table(cur)
        # Seat-only members (no share row yet) get one so the flag has a home.
        cur.execute(
            """INSERT INTO tracking_workspace_shares (owner_user_id, member_email)
               SELECT %s, %s WHERE EXISTS (
                 SELECT 1 FROM coach_staff_seats
                 WHERE owner_user_id = %s AND LOWER(member_email) = %s)
               ON CONFLICT (owner_user_id, member_email) DO NOTHING""",
            (owner, email, owner, email))
        cur.execute(
            "UPDATE tracking_workspace_shares SET can_upload = %s "
            "WHERE owner_user_id = %s AND member_email = %s",
            (body.can_upload, owner, email))
        if not cur.rowcount:
            raise HTTPException(status_code=404, detail="Not on your staff list.")
        conn.commit()
    invalidate_share_cache()
    return {"status": "ok", "can_upload": body.can_upload}


@router.delete("/portal/my-staff/{member_email}")
def my_staff_remove(member_email: str, owner: str = Depends(_gate)):
    email = (member_email or "").strip().lower()
    with get_connection() as conn:
        cur = conn.cursor()
        removed = 0
        try:
            cur.execute("DELETE FROM coach_staff_seats WHERE owner_user_id = %s AND LOWER(member_email) = %s",
                        (owner, email))
            removed += cur.rowcount
        except Exception:
            conn.rollback()
        cur.execute("DELETE FROM tracking_workspace_shares WHERE owner_user_id = %s AND member_email = %s",
                    (owner, email))
        removed += cur.rowcount
        if not removed:
            raise HTTPException(status_code=404, detail="Not on your staff list.")
        conn.commit()
    invalidate_share_cache()
    return {"status": "ok"}
