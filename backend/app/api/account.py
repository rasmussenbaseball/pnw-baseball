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
from .auth import (
    get_current_user, _extract_token, require_tier, comp_aware_tier,
    staff_seat_grant, _ensure_staff_seats_table, MAX_STAFF_SEATS,
    _owner_can_share,
)
from ._tier_allowlist import email_for_token, resolve_comped_tier
from ._tracking_share import _ensure_table as _ts_ensure_table, invalidate_share_cache

router = APIRouter()


# ─────────────────────────────────────────────────────────────
# Pending comps — comps granted BEFORE the person has an account.
# grant_comp.py queues {email, tier, months} in pending_comps when
# no auth.users row exists yet; the first time that email signs in
# and the frontend loads /me/subscription, the comp is applied as a
# normal provider='comp' user_subscriptions row (started THAT day,
# so they get the full comp length) and the queue row is marked
# applied. Never clobbers an existing active subscription.
# ─────────────────────────────────────────────────────────────

def _ensure_pending_comps_table(cur):
    cur.execute(
        """CREATE TABLE IF NOT EXISTS pending_comps (
             id SERIAL PRIMARY KEY,
             email      TEXT NOT NULL UNIQUE,
             tier       TEXT NOT NULL,
             months     INTEGER NOT NULL DEFAULT 1,
             note       TEXT,
             created_at TIMESTAMPTZ DEFAULT NOW(),
             applied_at TIMESTAMPTZ
           )"""
    )


def _apply_pending_comp(cur, user_id: str, email: Optional[str]) -> bool:
    """Apply a queued comp for this email, if any. Returns True if applied.
    Caller commits. Fail-safe: any error means 'no comp applied'."""
    if not email:
        return False
    try:
        cur.execute(
            "SELECT id, tier, months, note FROM pending_comps "
            "WHERE lower(email) = lower(%s) AND applied_at IS NULL",
            (email,),
        )
        p = cur.fetchone()
        if not p:
            return False
        # Don't downgrade someone who already has an active (non-free) sub.
        cur.execute(
            "SELECT tier, provider, ends_at FROM user_subscriptions WHERE user_id = %s",
            (user_id,),
        )
        row = cur.fetchone()
        if row and comp_aware_tier(row.get("tier"), row.get("provider"), row.get("ends_at")) != "free":
            # Leave the queue row unapplied — it can apply later if their sub lapses,
            # or Nate can clean it up via grant_comp.py --revoke.
            return False
        note = p["note"] or f"comp: {p['months']}-month {p['tier']} (pending_comps auto-apply)"
        cur.execute(
            """
            INSERT INTO user_subscriptions
                (user_id, tier, started_at, ends_at, current_period_end, provider, interval,
                 cancel_at_period_end, external_ref, created_at, updated_at)
            VALUES (%s, %s, now(), now() + (%s || ' months')::interval, now() + (%s || ' months')::interval,
                    'comp', 'month', TRUE, %s, now(), now())
            ON CONFLICT (user_id) DO UPDATE SET
                tier=excluded.tier, started_at=now(),
                ends_at=excluded.ends_at, current_period_end=excluded.current_period_end,
                provider='comp', interval='month', cancel_at_period_end=TRUE,
                external_ref=excluded.external_ref, updated_at=now()
            """,
            (user_id, p["tier"], p["months"], p["months"], note),
        )
        cur.execute("UPDATE pending_comps SET applied_at = now() WHERE id = %s", (p["id"],))
        return True
    except Exception:
        try:
            cur.connection.rollback()
        except Exception:
            pass
        return False


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
        # Queued comp for this email (granted before they had an account)?
        # First sign-in applies it, so the row below picks it up immediately.
        if _apply_pending_comp(cur, user_id, comped_email):
            conn.commit()
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
        # No subscription of their own — do they occupy a STAFF SEAT shared
        # by a Coach & Scout subscriber? If so they inherit the coach tier.
        seat_owner = staff_seat_grant(comped_email)
        if seat_owner:
            return {
                "tier": "coach",
                "started_at": None,
                "ends_at": None,
                "external_ref": None,
                "interval": None,
                "current_period_end": None,
                "cancel_at_period_end": False,
                "has_stripe_customer": False,
                "comped": True,
                "comped_label": f"Coach & Scout · Staff seat (shared by {seat_owner})",
                "staff_seat": True,
                "staff_seat_owner": seat_owner,
            }
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
    # A staff seat lifts an own-subscription tier BELOW coach up to coach
    # (their own billing info stays as-is so Manage Subscription still works).
    if eff_tier not in ("coach", "dev"):
        seat_owner = staff_seat_grant(comped_email)
        if seat_owner:
            r["tier"] = "coach"
            r["staff_seat"] = True
            r["staff_seat_owner"] = seat_owner
            r["comped_label"] = f"Coach & Scout · Staff seat (shared by {seat_owner})"
    # Don't leak the raw customer_id / subscription_id / provider to the frontend.
    r.pop("customer_id", None)
    r.pop("subscription_id", None)
    r.pop("provider", None)
    return r


# ─────────────────────────────────────────────────────────────
# Staff seats — Coach & Scout subscription sharing.
# A coach-tier subscriber can share their subscription with up to
# MAX_STAFF_SEATS other emails ("the rest of the coaching staff").
# Seat members inherit the coach tier via staff_seat_grant() in
# auth.py; these endpoints let the OWNER manage who has a seat.
# ─────────────────────────────────────────────────────────────

class SeatAdd(BaseModel):
    email: str


def _seat_owner_ctx(request: Request, user_id: str) -> dict:
    """Resolve {user_id, email, can_manage} for the seat endpoints.

    can_manage uses auth._owner_can_share: only a PAYING (non-comp) active
    Coach & Scout subscription (or a developer account) may share seats.
    Comped coaches and seat members themselves cannot."""
    email = (email_for_token(_extract_token(request)) or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Could not resolve your account email.")
    with get_connection() as conn:
        cur = conn.cursor()
        try:
            can_manage = bool(_owner_can_share(cur, user_id, email))
        except Exception:
            conn.rollback()
            can_manage = False
    return {"user_id": user_id, "email": email, "can_manage": can_manage}


@router.get("/me/staff-seats")
def list_staff_seats(request: Request, user_id: str = Depends(get_current_user)):
    ctx = _seat_owner_ctx(request, user_id)
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_staff_seats_table(cur)
        cur.execute(
            "SELECT id, member_email, created_at FROM coach_staff_seats "
            "WHERE owner_user_id = %s ORDER BY created_at",
            (user_id,),
        )
        seats = [
            {"id": r["id"], "email": r["member_email"],
             "created_at": r["created_at"].isoformat() if r["created_at"] else None}
            for r in cur.fetchall()
        ]
        conn.commit()
    return {"seats": seats, "max_seats": MAX_STAFF_SEATS, "can_manage": ctx["can_manage"]}


@router.post("/me/staff-seats")
def add_staff_seat(body: SeatAdd, request: Request, user_id: str = Depends(get_current_user)):
    ctx = _seat_owner_ctx(request, user_id)
    if not ctx["can_manage"]:
        raise HTTPException(status_code=402, detail="Sharing seats requires an active paid Coach & Scout subscription.")
    new_email = (body.email or "").strip().lower()
    if not new_email or "@" not in new_email:
        raise HTTPException(status_code=400, detail="A valid email is required.")
    if new_email == ctx["email"]:
        raise HTTPException(status_code=400, detail="That's your own account email.")
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_staff_seats_table(cur)
        cur.execute("SELECT COUNT(*) AS n FROM coach_staff_seats WHERE owner_user_id = %s", (user_id,))
        if (cur.fetchone()["n"] or 0) >= MAX_STAFF_SEATS:
            raise HTTPException(status_code=400, detail=f"You can share with up to {MAX_STAFF_SEATS} staff members.")
        cur.execute(
            """INSERT INTO coach_staff_seats (owner_user_id, owner_email, member_email)
               VALUES (%s, %s, %s) ON CONFLICT (owner_user_id, member_email) DO NOTHING""",
            (user_id, ctx["email"], new_email),
        )
        # A seat also shares the TrackMan + Rapsodo workspaces (unified
        # staff list — see _tracking_share.py).
        _ts_ensure_table(cur)
        cur.execute(
            """INSERT INTO tracking_workspace_shares (owner_user_id, member_email)
               VALUES (%s, %s) ON CONFLICT (owner_user_id, member_email) DO NOTHING""",
            (user_id, new_email),
        )
        conn.commit()
    invalidate_share_cache()
    return {"status": "ok", "email": new_email}


@router.delete("/me/staff-seats/{seat_id}")
def remove_staff_seat(seat_id: int, request: Request, user_id: str = Depends(get_current_user)):
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_staff_seats_table(cur)
        cur.execute(
            "DELETE FROM coach_staff_seats WHERE id = %s AND owner_user_id = %s RETURNING member_email",
            (seat_id, user_id),
        )
        row = cur.fetchone()
        if row:
            _ts_ensure_table(cur)
            cur.execute(
                "DELETE FROM tracking_workspace_shares WHERE owner_user_id = %s AND member_email = %s",
                (user_id, (row["member_email"] or "").strip().lower()),
            )
        conn.commit()
    invalidate_share_cache()
    return {"status": "ok"}


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
