"""Staff workspace sharing for the TrackMan Suite, Rapsodo Lab and Camp Report.

These tools are private per-coach workspaces keyed by owner_user_id. A
staff member whose email is on the coach's staff list, and who has no
uploads of their own, transparently acts AS the coach's workspace: reads,
uploads, and overrides all resolve to the shared pool. No per-query
changes and no double counting; only the owner id that every endpoint
already scopes by gets remapped at the gate.

`tracking_workspace_shares` is the staff list. (`coach_staff_seats`, the
old subscription-sharing table from the paid-tier era, is still READ by
resolve_workspace so lists built before September 2026 keep working, but
nothing writes to it any more.) The /portal/my-staff endpoints manage the
list; the StaffManager widget (portal home + TrackMan Overview) is the UI.

Rules:
  - Signed-in account required (workspaces are per-user data).
  - A member who already uploaded their own CSVs gets those FOLDED into
    the staff pool (merge_member_data, deduped) — unless they run a
    staff of their own, in which case they keep their own program.
"""
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..models.database import get_connection
from ._tier_allowlist import email_for_token
from .auth import _extract_token, get_current_user

router = APIRouter(tags=["tracking-share"])

_gate = get_current_user   # sign-in only: workspaces are per-user data
MAX_SHARE_EMAILS = 8   # staff list cap

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
    # accepted_at (Oct 2026): a staff add is an INVITATION until the invited
    # coach accepts it. Before this, typing any email into My Staff re-owned
    # that account's TrackMan/Rapsodo/Camp uploads into the caller's
    # workspace with no consent. NULL = pending; nothing resolves or merges
    # until it is set.
    cur.execute("""SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tracking_workspace_shares' AND column_name = 'accepted_at'""")
    if not cur.fetchone():
        cur.execute("ALTER TABLE tracking_workspace_shares ADD COLUMN accepted_at TIMESTAMPTZ")
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
                       WHERE member_email = %s AND accepted_at IS NOT NULL
                       ORDER BY created_at DESC""",
                    (email,),
                )
                owners += [str(r["owner_user_id"]) for r in cur.fetchall()]
            except Exception:
                conn.rollback()
            if owners and owners[0] != owner:
                has_own = False
                for table in ("tm_sessions", "rapsodo_sessions", "camps"):
                    try:
                        cur.execute(f"SELECT 1 FROM {table} WHERE owner_user_id = %s LIMIT 1", (owner,))
                        if cur.fetchone():
                            has_own = True
                            break
                    except Exception:
                        conn.rollback()
                # A member who runs their OWN staff is a head coach — never
                # fold their program into someone else's workspace.
                is_head_coach = False
                try:
                    cur.execute(
                        """SELECT 1 FROM tracking_workspace_shares WHERE owner_user_id = %s
                           UNION SELECT 1 FROM coach_staff_seats WHERE owner_user_id = %s LIMIT 1""",
                        (owner, owner))
                    is_head_coach = bool(cur.fetchone())
                except Exception:
                    conn.rollback()
                if not has_own:
                    eff = owners[0]
                elif not is_head_coach:
                    # Member brought their own uploads: fold them into the
                    # staff pool (per Nate 2026-08-18), then adopt it.
                    try:
                        merge_member_data(cur, owner, owners[0])
                        conn.commit()
                        eff = owners[0]
                    except Exception:
                        conn.rollback()   # fail-safe: keep their own view
        _CACHE[email] = (eff, now + _CACHE_TTL)
        return eff or owner
    except Exception:
        return owner


def _user_id_for_email(cur, email: str):
    try:
        cur.execute("SELECT id FROM auth.users WHERE LOWER(email) = %s LIMIT 1", (email,))
        row = cur.fetchone()
        return str(row["id"]) if row else None
    except Exception:
        return None


def merge_member_data(cur, member: str, target: str) -> None:
    """Fold a staff member's own uploads INTO the shared workspace so the
    whole staff sees one combined pool (per Nate 2026-08-18: a coach who
    already uploaded their own CSVs gets merged, not kept separate).
    Dedupes on the same keys uploads do, so overlapping files never
    double-count. One-way and idempotent."""
    if not member or member == target:
        return
    # ── TrackMan ──
    # 1. drop member pitches that already exist in the target pool
    cur.execute("""DELETE FROM tm_pitches WHERE owner_user_id = %s AND pitch_uid IN
                   (SELECT pitch_uid FROM tm_pitches WHERE owner_user_id = %s)""",
                (member, target))
    # 2. sessions whose game already exists at target: repoint pitches, merge filenames, drop session
    cur.execute("""SELECT m.id AS mid, t.id AS tid, m.filenames AS mf
                   FROM tm_sessions m JOIN tm_sessions t
                     ON t.owner_user_id = %s AND t.game_id = m.game_id
                   WHERE m.owner_user_id = %s""", (target, member))
    for r in cur.fetchall():
        cur.execute("UPDATE tm_pitches SET owner_user_id = %s, session_id = %s "
                    "WHERE owner_user_id = %s AND session_id = %s",
                    (target, r["tid"], member, r["mid"]))
        cur.execute("""UPDATE tm_sessions SET filenames =
                         (SELECT ARRAY(SELECT DISTINCT unnest(filenames || %s))) WHERE id = %s""",
                    (r["mf"] or [], r["tid"]))
        cur.execute("DELETE FROM tm_sessions WHERE id = %s", (r["mid"],))
    # 3. everything else moves wholesale
    cur.execute("UPDATE tm_pitches SET owner_user_id = %s WHERE owner_user_id = %s", (target, member))
    cur.execute("UPDATE tm_sessions SET owner_user_id = %s WHERE owner_user_id = %s", (target, member))
    # 4. refresh counts on target sessions
    cur.execute("""UPDATE tm_sessions s SET
                     pitch_count = (SELECT COUNT(*) FROM tm_pitches p WHERE p.session_id = s.id),
                     bbe_count   = (SELECT COUNT(*) FROM tm_pitches p
                                    WHERE p.session_id = s.id AND p.exit_speed IS NOT NULL
                                      AND (p.pitch_call = 'InPlay' OR (p.pitch_call IS NULL AND
                                           (p.direction IS NULL OR ABS(p.direction) <= 45))))
                   WHERE s.owner_user_id = %s""", (target,))

    # ── Rapsodo ──
    # players colliding on rapsodo_player_id: fold sessions/pitches into the target's row
    cur.execute("""SELECT m.id AS mid, t.id AS tid
                   FROM rapsodo_players m JOIN rapsodo_players t
                     ON t.owner_user_id = %s AND t.rapsodo_player_id = m.rapsodo_player_id
                   WHERE m.owner_user_id = %s""", (target, member))
    for r in cur.fetchall():
        # duplicate files for the same device player: drop the member's copy
        cur.execute("""SELECT id FROM rapsodo_sessions ms
                       WHERE ms.owner_user_id = %s AND ms.player_db_id = %s
                         AND (ms.rapsodo_player_id, ms.source_file) IN
                             (SELECT rapsodo_player_id, source_file FROM rapsodo_sessions
                              WHERE owner_user_id = %s)""", (member, r["mid"], target))
        dup_ids = [x["id"] for x in cur.fetchall()]
        if dup_ids:
            cur.execute("DELETE FROM rapsodo_pitches WHERE session_id = ANY(%s)", (dup_ids,))
            cur.execute("DELETE FROM rapsodo_sessions WHERE id = ANY(%s)", (dup_ids,))
        cur.execute("UPDATE rapsodo_sessions SET owner_user_id = %s, player_db_id = %s "
                    "WHERE owner_user_id = %s AND player_db_id = %s",
                    (target, r["tid"], member, r["mid"]))
        cur.execute("UPDATE rapsodo_pitches SET owner_user_id = %s, player_db_id = %s "
                    "WHERE owner_user_id = %s AND player_db_id = %s",
                    (target, r["tid"], member, r["mid"]))
        cur.execute("DELETE FROM rapsodo_players WHERE id = %s", (r["mid"],))
    for t in ("rapsodo_sessions", "rapsodo_pitches", "rapsodo_players"):
        cur.execute(f"UPDATE {t} SET owner_user_id = %s WHERE owner_user_id = %s", (target, member))

    # ── Camp Report (camp-scoped uniques — a plain re-own is safe) ──
    for t in ("camps", "camp_players", "camp_rows", "camp_uploads"):
        cur.execute(f"UPDATE {t} SET owner_user_id = %s WHERE owner_user_id = %s", (target, member))


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
                           WHERE owner_user_id = %s AND member_email = %s AND accepted_at IS NOT NULL""",
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


# ── "My Staff" ───────────────────────────────────────────────────
# GET/POST/DELETE /portal/my-staff — the StaffManager widget's API.
# One list: every email on it shares the owner's TrackMan, Rapsodo and
# Camp Report workspaces. Legacy coach_staff_seats rows are folded into
# the view (and migrated into tracking_workspace_shares on first read)
# so staff lists from before September 2026 carry over.

def _caller_email(request: Request) -> str:
    return (email_for_token(_extract_token(request)) or "").strip().lower()


def _legacy_seat_emails(cur, owner: str) -> list:
    try:
        cur.execute(
            "SELECT LOWER(member_email) AS email FROM coach_staff_seats WHERE owner_user_id = %s",
            (owner,))
        return [r["email"] for r in cur.fetchall()]
    except Exception:
        cur.connection.rollback()
        return []


@router.get("/portal/my-staff")
def my_staff(request: Request, owner: str = Depends(_gate)):
    members: dict = {}
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_table(cur)
        # Migrate any legacy seat rows into the share table so the list
        # has one source of truth going forward.
        for e in _legacy_seat_emails(cur, owner):
            cur.execute(
                """INSERT INTO tracking_workspace_shares (owner_user_id, member_email, accepted_at)
                   VALUES (%s, %s, NOW()) ON CONFLICT (owner_user_id, member_email) DO NOTHING""",
                (owner, e))
        cur.execute(
            "SELECT member_email AS email, can_upload, created_at::date AS added, accepted_at "
            "FROM tracking_workspace_shares "
            "WHERE owner_user_id = %s ORDER BY created_at", (owner,))
        for r in cur.fetchall():
            members[r["email"]] = {"email": r["email"], "data": True,
                                   "can_upload": r["can_upload"] is not False,
                                   "pending": r.get("accepted_at") is None,
                                   "added": r["added"].isoformat() if r["added"] else None}
        # Is the caller viewing a workspace someone shared with THEM?
        viewing = resolve_workspace(request, owner) != owner
        conn.commit()
    return {
        "members": sorted(members.values(), key=lambda m: m["added"] or ""),
        "max": MAX_SHARE_EMAILS,
        "viewing_shared": viewing,
    }


@router.post("/portal/my-staff")
def my_staff_add(body: ShareAdd, request: Request, owner: str = Depends(_gate)):
    self_email = _caller_email(request)
    email = (body.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="A valid email is required.")
    if email == self_email:
        raise HTTPException(status_code=400, detail="That's your own account email.")
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_table(cur)
        cur.execute("SELECT COUNT(*) AS n FROM tracking_workspace_shares WHERE owner_user_id = %s", (owner,))
        if (cur.fetchone()["n"] or 0) >= MAX_SHARE_EMAILS:
            raise HTTPException(status_code=400,
                                detail=f"Your staff list is limited to {MAX_SHARE_EMAILS} coaches.")
        # An INVITATION: the row stays pending (accepted_at NULL) until the
        # invited coach accepts it from their own portal. Nothing about their
        # account changes before that (no workspace redirect, no data merge).
        cur.execute(
            """INSERT INTO tracking_workspace_shares (owner_user_id, member_email)
               VALUES (%s, %s) ON CONFLICT (owner_user_id, member_email) DO NOTHING""",
            (owner, email))
        conn.commit()
    invalidate_share_cache()
    return {"status": "invited", "email": email, "pending": True}


# ── Invitations (member side) ─────────────────────────────────────

def _email_for_user_id(cur, user_id: str):
    try:
        cur.execute("SELECT email FROM auth.users WHERE id = %s::uuid LIMIT 1", (user_id,))
        row = cur.fetchone()
        return (row["email"] or "").lower() if row else None
    except Exception:
        return None


@router.get("/portal/my-invites")
def my_invites(request: Request, owner: str = Depends(_gate)):
    """Pending staff invitations addressed to the signed-in coach."""
    email = _caller_email(request)
    if not email:
        return {"invites": []}
    out = []
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_table(cur)
        cur.execute(
            """SELECT id, owner_user_id, created_at::date AS invited
               FROM tracking_workspace_shares
               WHERE member_email = %s AND accepted_at IS NULL ORDER BY created_at DESC""",
            (email,))
        for r in cur.fetchall():
            out.append({"id": r["id"], "owner_email": _email_for_user_id(cur, str(r["owner_user_id"])),
                        "invited": r["invited"].isoformat() if r["invited"] else None})
    return {"invites": out}


@router.post("/portal/my-invites/{share_id}/accept")
def my_invite_accept(share_id: int, request: Request, owner: str = Depends(_gate)):
    """Join the inviting coach's staff. The member's OWN uploads are folded into
    that workspace only now, with their consent (per Nate 2026-08-18 the staff
    sees one pool), and never when the member runs a staff of their own."""
    email = _caller_email(request)
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_table(cur)
        cur.execute("SELECT owner_user_id FROM tracking_workspace_shares WHERE id = %s AND member_email = %s",
                    (share_id, email))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Invitation not found.")
        target = str(row["owner_user_id"])
        cur.execute("UPDATE tracking_workspace_shares SET accepted_at = NOW() WHERE id = %s", (share_id,))
        merged = False
        if target != owner:
            try:
                cur.execute(
                    """SELECT 1 FROM tracking_workspace_shares WHERE owner_user_id = %s AND accepted_at IS NOT NULL
                       UNION SELECT 1 FROM coach_staff_seats WHERE owner_user_id = %s LIMIT 1""",
                    (owner, owner))
                if not cur.fetchone():
                    merge_member_data(cur, owner, target)
                    merged = True
            except Exception:
                conn.rollback()
                cur = conn.cursor()
                cur.execute("UPDATE tracking_workspace_shares SET accepted_at = NOW() WHERE id = %s", (share_id,))
        conn.commit()
    invalidate_share_cache()
    return {"status": "accepted", "merged": merged}


@router.post("/portal/my-invites/{share_id}/decline")
def my_invite_decline(share_id: int, request: Request, owner: str = Depends(_gate)):
    email = _caller_email(request)
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_table(cur)
        cur.execute("DELETE FROM tracking_workspace_shares WHERE id = %s AND member_email = %s AND accepted_at IS NULL",
                    (share_id, email))
        deleted = cur.rowcount
        conn.commit()
    invalidate_share_cache()
    return {"status": "declined", "deleted": deleted}


class SharePatch(BaseModel):
    can_upload: bool


@router.patch("/portal/my-staff/{member_email}")
def my_staff_patch(member_email: str, body: SharePatch, owner: str = Depends(_gate)):
    """Owner toggles whether a staff member may upload/delete data."""
    email = (member_email or "").strip().lower()
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_table(cur)
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
