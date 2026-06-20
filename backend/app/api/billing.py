"""
Stripe billing endpoints.

Flow:
  1. Frontend POSTs /billing/checkout with {tier, interval}.
  2. Backend creates a Stripe Checkout Session and returns its URL.
  3. Frontend window.location's to that URL — Stripe collects payment.
  4. After payment, Stripe redirects user to /account?upgraded=true AND
     fires webhook events to /billing/webhook.
  5. Webhook handler updates the user_subscriptions row with their new
     tier + period info. Frontend re-fetches /me/subscription to show
     the upgraded UI.

Customer self-service:
  6. /billing/portal opens a Stripe-hosted Customer Portal session
     where the user can cancel, change plan, update card, or download
     invoices. We don't render any of that UI ourselves.

Env vars required:
  STRIPE_API_KEY               — Secret key (sk_test_... or sk_live_...)
  STRIPE_WEBHOOK_SECRET        — From the Stripe webhook config (whsec_...)
  STRIPE_PRICE_PREMIUM_MONTHLY    — Price ID for Premium $5/mo
  STRIPE_PRICE_PREMIUM_YEARLY     — Price ID for Premium $50/yr
  STRIPE_PRICE_RECRUITING_MONTHLY — Price ID for Recruiting $10/mo
  STRIPE_PRICE_RECRUITING_YEARLY  — Price ID for Recruiting $100/yr
  STRIPE_PRICE_COACH_MONTHLY      — Price ID for Coach $25/mo
  STRIPE_PRICE_COACH_YEARLY       — Price ID for Coach $250/yr
  SITE_URL                     — Defaults to https://nwbaseballstats.com

SECURITY NOTE: Like every payment integration, server-side enforcement
matters more than frontend gating. The tier shown by /me/subscription
is set by THIS file in response to webhook events. As we apply <RequireTier>
to routes in the future, the corresponding API endpoints must read the
DB tier too — never trust a tier value coming from the client.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Optional

import httpx
import stripe
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..models.database import get_connection
from ..services.email_sender import send_notification
from .auth import get_current_user, _extract_token, _get_supabase_url

router = APIRouter()
log = logging.getLogger("nwbb.billing")


# ─────────────────────────────────────────────────────────────────
# Config + price map
# ─────────────────────────────────────────────────────────────────

def _site_url() -> str:
    return os.getenv("SITE_URL", "https://nwbaseballstats.com").rstrip("/")


def _set_stripe_key():
    """Apply the Stripe API key to the SDK module. Raises 500 if missing."""
    key = os.getenv("STRIPE_API_KEY", "")
    if not key:
        raise HTTPException(status_code=500, detail="Stripe not configured on the server.")
    stripe.api_key = key


def _price_map() -> dict[str, tuple[str, str]]:
    """price_id → (tier, interval)."""
    raw = {
        os.getenv("STRIPE_PRICE_PREMIUM_MONTHLY"):    ("premium",    "monthly"),
        os.getenv("STRIPE_PRICE_PREMIUM_YEARLY"):     ("premium",    "yearly"),
        os.getenv("STRIPE_PRICE_RECRUITING_MONTHLY"): ("recruiting", "monthly"),
        os.getenv("STRIPE_PRICE_RECRUITING_YEARLY"):  ("recruiting", "yearly"),
        os.getenv("STRIPE_PRICE_COACH_MONTHLY"):      ("coach",      "monthly"),
        os.getenv("STRIPE_PRICE_COACH_YEARLY"):       ("coach",      "yearly"),
    }
    return {k: v for k, v in raw.items() if k}


def _lookup_price(tier: str, interval: str) -> Optional[str]:
    for price_id, (t, i) in _price_map().items():
        if t == tier and i == interval:
            return price_id
    return None


# Every (tier, interval) the site offers for sale. Single source of truth:
# the checkout schema, price map, DB tier constraint, and config self-check
# all derive from this so a new tier can't be half-wired again.
SELLABLE = [
    ("premium", "monthly"), ("premium", "yearly"),
    ("recruiting", "monthly"), ("recruiting", "yearly"),
    ("coach", "monthly"), ("coach", "yearly"),
]
PAID_TIERS = sorted({t for t, _ in SELLABLE})          # premium, recruiting, coach
ALL_TIERS = ["free"] + PAID_TIERS


def verify_billing_config() -> list[str]:
    """Return a list of billing-config problems (empty list = healthy).

    Catches the class of bug where a tier is added to the app but not
    everywhere it needs to be:
      - a sellable (tier, interval) with no Stripe price env var, and
      - the DB tier CHECK constraint not allowing a tier the app can assign
        (which silently rejected a paid 'recruiting' subscriber once).
    Run at startup and logged CRITICAL, so drift surfaces at deploy time
    rather than at a customer's first purchase."""
    issues: list[str] = []
    have = set(_price_map().values())
    for ti in SELLABLE:
        if ti not in have:
            issues.append(f"no Stripe price configured for {ti[0]}/{ti[1]} (STRIPE_PRICE_* env missing)")

    producible = {"free"} | {t for (t, _i) in _price_map().values()}
    try:
        import re as _re
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint "
                "WHERE conname = 'user_subscriptions_tier_check'"
            )
            row = cur.fetchone()
        if row and row.get("d"):
            allowed = set(_re.findall(r"'([a-z_]+)'", row["d"]))
            missing = producible - allowed
            if missing:
                issues.append(
                    f"user_subscriptions tier CHECK constraint is missing {sorted(missing)} "
                    f"— upgrades to those tiers will be REJECTED by the DB"
                )
    except Exception as e:  # pragma: no cover - diagnostics only
        issues.append(f"could not read user_subscriptions tier constraint: {e}")
    return issues


def _pick_primary_subscription(subs: list) -> Optional[dict]:
    """Choose the most relevant subscription for a customer: prefer active,
    then trialing, then past_due, newest first."""
    if not subs:
        return None
    rank = {"active": 0, "trialing": 1, "past_due": 2}
    return sorted(subs, key=lambda s: (rank.get(s.get("status"), 9), -(s.get("created") or 0)))[0]


# ─────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────

def _user_email(token: str) -> Optional[str]:
    """Look up the user's email from Supabase Auth using their bearer token.
    Returns None on any error so we just fall back to no pre-fill."""
    supabase_url = _get_supabase_url()
    try:
        resp = httpx.get(
            f"{supabase_url}/auth/v1/user",
            headers={
                "Authorization": f"Bearer {token}",
                "apikey": os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
            },
            timeout=5.0,
        )
    except httpx.RequestError:
        return None
    if resp.status_code != 200:
        return None
    return (resp.json() or {}).get("email")


def _get_customer_id(user_id: str) -> Optional[str]:
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT customer_id FROM user_subscriptions WHERE user_id = %s",
            (user_id,),
        )
        row = cur.fetchone()
    return row.get("customer_id") if row else None


def _user_id_from_customer(customer_id: str) -> Optional[str]:
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT user_id FROM user_subscriptions WHERE customer_id = %s LIMIT 1",
            (customer_id,),
        )
        row = cur.fetchone()
    return str(row["user_id"]) if row else None


def _email_for_user(user_id: str) -> Optional[str]:
    """Look up a user's email from auth.users by their user_id. We use
    the postgres connection (not a Supabase auth API call) since this
    runs from background webhook handlers without a bearer token."""
    if not user_id:
        return None
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT email FROM auth.users WHERE id = %s", (user_id,))
            row = cur.fetchone()
        return (row or {}).get("email")
    except Exception:
        log.exception("could not fetch email for user %s", user_id)
        return None


# ─── Email templates (transactional) ────────────────────────────
#
# Plain-text + inline-styled HTML. Sent via the same Resend pipeline
# used for broadcasts but without the unsubscribe footer / broadcast
# signature shell (it's transactional, not marketing).

def _tier_display(tier: str) -> str:
    return {"premium": "Premium", "recruiting": "Recruiting", "coach": "Coach & Scout"}.get(tier, tier.title())


def _send_welcome_email(user_id: str, tier: str, is_trial: bool):
    email = _email_for_user(user_id)
    if not email:
        return
    tier_name = _tier_display(tier)
    subject = (
        f"Your NW Baseball Stats {tier_name} trial is on"
        if is_trial else
        f"Welcome to NW Baseball Stats {tier_name}"
    )
    site = _site_url()
    body_text = (
        f"Thanks for subscribing to NW Baseball Stats {tier_name}.\n\n"
        + ("Your 7-day free trial is active — you have full access right now. "
           "You'll only be charged if you stay subscribed past day 7.\n\n"
           if is_trial else
           "Your subscription is active and you have full access right now.\n\n")
        + "Start here:\n"
        + f"  Homepage: {site}\n"
        + f"  Your account: {site}/account\n"
        + (f"  Coach portal: {site}/portal\n" if tier == "coach" else "")
        + "\n"
        + "Reply to this email if you have any questions.\n\n"
        + "— Nate · NW Baseball Stats\n"
    )
    body_html = f"""<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2937;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:24px 0;">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="560" style="background:#fff;border-radius:12px;max-width:560px;">
        <tr><td style="padding:24px 28px;">
          <div style="font-size:11px;font-weight:800;letter-spacing:0.1em;color:#0f766e;text-transform:uppercase;">NW Baseball Stats</div>
          <h1 style="font-size:22px;margin:8px 0 6px;color:#111;">{subject}</h1>
          <p style="margin:6px 0 12px;font-size:14px;line-height:1.5;color:#374151;">
            {'Your 7-day free trial is active — you have full access right now. You will only be charged if you stay subscribed past day 7.' if is_trial else 'Your subscription is active and you have full access right now.'}
          </p>
          <p style="margin:16px 0 6px;font-weight:700;font-size:13px;color:#111;">Jump in:</p>
          <p style="margin:0;font-size:14px;line-height:1.7;">
            • <a href="{site}" style="color:#0f766e;font-weight:600;text-decoration:none;">Homepage</a><br>
            • <a href="{site}/account" style="color:#0f766e;font-weight:600;text-decoration:none;">Your account</a><br>
            {f'• <a href="{site}/portal" style="color:#0f766e;font-weight:600;text-decoration:none;">Coach &amp; Scout portal</a>' if tier == 'coach' else ''}
          </p>
          <p style="margin:18px 0 0;font-size:12px;color:#6b7280;">
            Reply to this email if you have any questions.<br>— Nate · NW Baseball Stats
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""
    try:
        send_notification(
            to_email=email, subject=subject,
            body_text=body_text, body_html=body_html,
        )
    except Exception:
        log.exception("welcome email failed for %s", email)


def _send_cancel_email(user_id: str, tier: str, period_end_iso: Optional[str]):
    email = _email_for_user(user_id)
    if not email:
        return
    tier_name = _tier_display(tier)
    when = ""
    if period_end_iso:
        try:
            when = " on " + datetime.fromisoformat(period_end_iso.replace("Z", "+00:00")).strftime("%b %d, %Y")
        except Exception:
            pass
    subject = f"Your NW Baseball Stats {tier_name} subscription will end{when}"
    site = _site_url()
    body_text = (
        f"Your {tier_name} subscription is set to cancel{when}.\n\n"
        f"You'll keep full access until then. If you change your mind, you can resume "
        f"any time from your account page:\n"
        f"  {site}/account\n\n"
        f"Reply to this email if there's anything I can help with — feedback is the only "
        f"way I know what to fix or build next.\n\n"
        f"— Nate · NW Baseball Stats\n"
    )
    body_html = f"""<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2937;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:24px 0;">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="560" style="background:#fff;border-radius:12px;max-width:560px;">
        <tr><td style="padding:24px 28px;">
          <div style="font-size:11px;font-weight:800;letter-spacing:0.1em;color:#0f766e;text-transform:uppercase;">NW Baseball Stats</div>
          <h1 style="font-size:20px;margin:8px 0 6px;color:#111;">Subscription canceled</h1>
          <p style="margin:6px 0 12px;font-size:14px;line-height:1.5;color:#374151;">
            Your <strong>{tier_name}</strong> subscription is set to cancel{when}. You will keep full access until then.
          </p>
          <p style="margin:12px 0;font-size:14px;line-height:1.5;color:#374151;">
            Change your mind? You can resume from your account page anytime:
          </p>
          <p style="margin:6px 0 14px;">
            <a href="{site}/account" style="display:inline-block;padding:8px 16px;background:#0f766e;color:#fff;font-weight:700;font-size:13px;border-radius:6px;text-decoration:none;">Manage subscription</a>
          </p>
          <p style="margin:18px 0 0;font-size:12px;color:#6b7280;">
            Reply with feedback if you have any — it's the most direct way I learn what to fix.<br>— Nate · NW Baseball Stats
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""
    try:
        send_notification(
            to_email=email, subject=subject,
            body_text=body_text, body_html=body_html,
        )
    except Exception:
        log.exception("cancel email failed for %s", email)


def _send_payment_failed_email(user_id: str):
    email = _email_for_user(user_id)
    if not email:
        return
    subject = "Action needed: payment problem on your NW Baseball Stats subscription"
    site = _site_url()
    body_text = (
        f"Stripe couldn't bill the card on file for your NW Baseball Stats subscription.\n\n"
        f"This is usually because the card expired, was replaced, or hit a daily limit. "
        f"Stripe will retry automatically over the next several days, but updating your "
        f"card now will fix it instantly:\n\n"
        f"  {site}/account → Manage subscription\n\n"
        f"If retries fail, your subscription will eventually be canceled and you'll lose "
        f"access. No charge is in dispute — Stripe just needs a card it can charge.\n\n"
        f"Reply if you need help.\n\n"
        f"— Nate · NW Baseball Stats\n"
    )
    body_html = f"""<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2937;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:24px 0;">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="560" style="background:#fff;border-radius:12px;max-width:560px;">
        <tr><td style="padding:24px 28px;">
          <div style="font-size:11px;font-weight:800;letter-spacing:0.1em;color:#b45309;text-transform:uppercase;">Payment problem</div>
          <h1 style="font-size:20px;margin:8px 0 6px;color:#111;">We couldn't bill your card</h1>
          <p style="margin:6px 0 12px;font-size:14px;line-height:1.5;color:#374151;">
            Stripe couldn't bill the card on file for your subscription. Usually that means the card expired,
            was replaced, or hit a daily limit. Stripe will retry, but updating your card now fixes it instantly.
          </p>
          <p style="margin:14px 0;">
            <a href="{site}/account" style="display:inline-block;padding:8px 16px;background:#0f766e;color:#fff;font-weight:700;font-size:13px;border-radius:6px;text-decoration:none;">Update payment method</a>
          </p>
          <p style="margin:14px 0 0;font-size:12px;color:#6b7280;">
            If retries fail, your subscription will eventually be canceled. Reply if you need help.<br>— Nate · NW Baseball Stats
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""
    try:
        send_notification(
            to_email=email, subject=subject,
            body_text=body_text, body_html=body_html,
        )
    except Exception:
        log.exception("payment-failed email failed for %s", email)


# ─────────────────────────────────────────────────────────────────
# Schemas
# ─────────────────────────────────────────────────────────────────

class CheckoutRequest(BaseModel):
    tier:     str = Field(..., pattern="^(premium|recruiting|coach)$")
    interval: str = Field(..., pattern="^(monthly|yearly)$")


class SyncRequest(BaseModel):
    # The checkout session id from the success_url (optional). When present
    # we resolve the just-purchased subscription precisely; otherwise we fall
    # back to the user's Stripe customer.
    session_id: Optional[str] = None


# ─────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────

@router.post("/billing/checkout")
def create_checkout_session(
    body: CheckoutRequest,
    request: Request,
    user_id: str = Depends(get_current_user),
):
    """Create a Stripe Checkout Session for the requested tier+interval
    and return its URL. The frontend window.location's to that URL."""
    _set_stripe_key()
    price_id = _lookup_price(body.tier, body.interval)
    if not price_id:
        raise HTTPException(
            status_code=400,
            detail=f"No Stripe price configured for {body.tier}/{body.interval}",
        )

    customer_id = _get_customer_id(user_id)
    token = _extract_token(request) or ""
    user_email = _user_email(token) if not customer_id else None

    site = _site_url()
    params = {
        "mode": "subscription",
        "line_items": [{"price": price_id, "quantity": 1}],
        "success_url": f"{site}/account?upgraded=true&session_id={{CHECKOUT_SESSION_ID}}",
        "cancel_url":  f"{site}/pricing?canceled=true",
        # client_reference_id echoes back on the checkout.session.completed
        # event so we can match the Stripe customer to our user.
        "client_reference_id": user_id,
        # Promotional codes (coupons) — needed for the college-program
        # manual discount path.
        "allow_promotion_codes": True,
        "metadata": {
            "user_id":  user_id,
            "tier":     body.tier,
            "interval": body.interval,
        },
        # The subscription itself also carries metadata so subsequent
        # webhook events (without a session reference) can resolve the
        # user_id.
        "subscription_data": {
            "metadata": {
                "user_id":  user_id,
                "tier":     body.tier,
                "interval": body.interval,
            },
        },
    }

    # Free trials were retired 2026-06-20 — new checkouts bill immediately on
    # every tier/interval. Subscriptions already in a Stripe trial keep it until
    # it ends (we don't touch existing subs here).

    # Use existing customer if we have one (returning subscriber upgrading);
    # otherwise let Stripe create a new customer and pre-fill their email.
    if customer_id:
        params["customer"] = customer_id
    elif user_email:
        params["customer_email"] = user_email

    try:
        session = stripe.checkout.Session.create(**params)
    except stripe.error.StripeError as e:
        log.exception("Stripe checkout error")
        raise HTTPException(status_code=502, detail=f"Stripe error: {e.user_message or str(e)}")

    return {"url": session.url, "session_id": session.id}


@router.post("/billing/sync")
def sync_my_subscription(body: SyncRequest, user_id: str = Depends(get_current_user)):
    """Authoritatively pull THIS user's subscription from Stripe and apply it
    to the DB right now — so the tier is correct the instant they return from
    Checkout, without waiting on the async webhook. Uses the same write path
    as the webhook, so it's idempotent (whichever runs first wins; the welcome
    email fires once via the prior-tier check).

    Security: only ever applies the authenticated caller's own subscription —
    a session is honored only when its client_reference_id/metadata is this
    user, and the customer fallback is the user's own stored customer_id."""
    _set_stripe_key()
    sub = None

    if body.session_id:
        try:
            sess = stripe.checkout.Session.retrieve(body.session_id, expand=["subscription"])
        except stripe.error.StripeError:
            sess = None
        if sess and (sess.get("client_reference_id") == user_id
                     or (sess.get("metadata") or {}).get("user_id") == user_id):
            # Also performs the customer-link step in case checkout.completed
            # hasn't arrived yet.
            try:
                _handle_checkout_completed(sess)
            except Exception:
                log.exception("billing/sync: checkout link failed for %s", user_id)
            sub = sess.get("subscription")

    if sub is None:
        customer_id = _get_customer_id(user_id)
        if customer_id:
            try:
                subs = list(stripe.Subscription.list(customer=customer_id, status="all", limit=20).auto_paging_iter())
                sub = _pick_primary_subscription(subs)
            except stripe.error.StripeError:
                log.exception("billing/sync: subscription list failed for %s", user_id)

    if sub is not None:
        try:
            _handle_subscription_change(sub)
        except Exception:
            log.exception("billing/sync: apply failed for user %s", user_id)
            raise HTTPException(status_code=500, detail="Could not sync subscription.")

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT tier, interval, current_period_end, cancel_at_period_end "
            "FROM user_subscriptions WHERE user_id = %s",
            (user_id,),
        )
        row = cur.fetchone() or {}
    return {
        "tier": row.get("tier") or "free",
        "interval": row.get("interval"),
        "current_period_end": row.get("current_period_end"),
        "cancel_at_period_end": bool(row.get("cancel_at_period_end") or False),
        "synced": sub is not None,
    }


@router.post("/billing/portal")
def create_portal_session(user_id: str = Depends(get_current_user)):
    """Open the Stripe Customer Portal for the current user. Used by
    the "Manage subscription" button in /account."""
    _set_stripe_key()
    customer_id = _get_customer_id(user_id)
    if not customer_id:
        raise HTTPException(
            status_code=400,
            detail="No active Stripe customer yet — subscribe first to manage billing.",
        )
    try:
        session = stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url=f"{_site_url()}/account",
        )
    except stripe.error.StripeError as e:
        log.exception("Stripe portal error")
        raise HTTPException(status_code=502, detail=f"Stripe error: {e.user_message or str(e)}")
    return {"url": session.url}


@router.post("/billing/webhook")
async def stripe_webhook(request: Request):
    """Receive Stripe webhook events. Verifies the signature against the
    secret published in STRIPE_WEBHOOK_SECRET, then dispatches to a small
    handler per event type. Returns 200 quickly — heavy lifting in the
    handlers should be kept small and idempotent."""
    webhook_secret = os.getenv("STRIPE_WEBHOOK_SECRET", "")
    if not webhook_secret:
        raise HTTPException(status_code=500, detail="Webhook secret not configured.")

    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    try:
        event = stripe.Webhook.construct_event(payload, sig_header, webhook_secret)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid payload")
    except stripe.error.SignatureVerificationError:
        raise HTTPException(status_code=400, detail="Invalid signature")

    et = event["type"]
    obj = event["data"]["object"]

    try:
        if et == "checkout.session.completed":
            _handle_checkout_completed(obj)
        elif et in ("customer.subscription.created", "customer.subscription.updated"):
            _handle_subscription_change(obj)
        elif et == "customer.subscription.deleted":
            _handle_subscription_deleted(obj)
        elif et == "invoice.payment_failed":
            _handle_payment_failed(obj)
        # Other events: 200 OK, ignored (Stripe retries on 4xx/5xx)
    except Exception:
        log.exception("Webhook handler error on event %s", et)
        # Return 500 so Stripe RETRIES (exponential backoff, up to ~3 days)
        # and the failure stays visible in the Stripe dashboard. This used to
        # return 200, which silently swallowed a permanent failure — e.g. a
        # paid 'recruiting' subscription whose DB write was rejected by a
        # stale CHECK constraint — so the customer was charged but never
        # upgraded and nobody noticed.
        raise HTTPException(status_code=500, detail="webhook_handler_failed")

    return {"received": True}


# ─────────────────────────────────────────────────────────────────
# Webhook handlers
# ─────────────────────────────────────────────────────────────────

def _ts_to_iso(ts: Optional[int]) -> Optional[str]:
    if not ts:
        return None
    return datetime.fromtimestamp(int(ts), timezone.utc).isoformat()


def _handle_checkout_completed(session):
    """When checkout completes successfully, link the Stripe customer to
    the user row. The follow-up customer.subscription.created event will
    flip the tier."""
    user_id = (session.get("client_reference_id")
               or (session.get("metadata") or {}).get("user_id"))
    customer_id = session.get("customer")
    if not user_id or not customer_id:
        log.warning("checkout.session.completed missing user_id or customer_id: %s", session.get("id"))
        return

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO user_subscriptions
              (user_id, customer_id, tier, provider, started_at, updated_at)
            VALUES (%s, %s, 'free', 'stripe', NOW(), NOW())
            ON CONFLICT (user_id) DO UPDATE SET
              customer_id = EXCLUDED.customer_id,
              provider    = 'stripe',
              updated_at  = NOW()
            """,
            (user_id, customer_id),
        )
        conn.commit()


def _tier_from_subscription(sub) -> Optional[tuple[str, str]]:
    """Inspect the subscription items to figure out which (tier, interval)
    this subscription represents."""
    items = (sub.get("items") or {}).get("data") or []
    if not items:
        return None
    price_id = items[0].get("price", {}).get("id")
    return _price_map().get(price_id)


def _handle_subscription_change(sub):
    """A subscription was created or modified. Sync our DB row and fire
    a welcome / cancel email when state transitions warrant it."""
    customer_id = sub.get("customer")
    sub_id      = sub.get("id")
    status      = sub.get("status")  # active|trialing|past_due|canceled|unpaid|incomplete|incomplete_expired
    cancel_at_period_end = bool(sub.get("cancel_at_period_end", False))
    period_end_iso = _ts_to_iso(sub.get("current_period_end"))

    # Resolve user_id. Prefer subscription.metadata, fall back to lookup
    # via customer_id (set by the checkout.completed handler).
    user_id = (sub.get("metadata") or {}).get("user_id") or _user_id_from_customer(customer_id)
    if not user_id:
        log.warning("subscription event without resolvable user_id: sub=%s customer=%s", sub_id, customer_id)
        return

    ti = _tier_from_subscription(sub)
    if not ti:
        log.warning("subscription event with unknown price: sub=%s", sub_id)
        return
    target_tier, target_interval = ti

    if status in ("canceled", "unpaid", "incomplete_expired"):
        new_tier = "free"
    else:
        new_tier = target_tier

    # Read prior state BEFORE the upsert so we can detect transitions
    # (e.g., free → premium, premium → premium-but-canceling).
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """SELECT tier, cancel_at_period_end FROM user_subscriptions
               WHERE user_id = %s""",
            (user_id,),
        )
        prior = cur.fetchone() or {}
        prior_tier = prior.get("tier") or "free"
        prior_cancel = bool(prior.get("cancel_at_period_end") or False)

        cur.execute(
            """
            INSERT INTO user_subscriptions
              (user_id, customer_id, subscription_id, tier, interval,
               provider, started_at, current_period_end, cancel_at_period_end,
               updated_at)
            VALUES
              (%s, %s, %s, %s, %s,
               'stripe', NOW(), %s, %s,
               NOW())
            ON CONFLICT (user_id) DO UPDATE SET
              customer_id          = EXCLUDED.customer_id,
              subscription_id      = EXCLUDED.subscription_id,
              tier                 = EXCLUDED.tier,
              interval             = EXCLUDED.interval,
              current_period_end   = EXCLUDED.current_period_end,
              cancel_at_period_end = EXCLUDED.cancel_at_period_end,
              updated_at           = NOW()
            """,
            (
                user_id, customer_id, sub_id, new_tier, target_interval,
                period_end_iso, cancel_at_period_end,
            ),
        )
        conn.commit()

    # ── Side effects: transactional emails ──
    # Welcome — fire when tier transitions free → premium/coach. We send
    # once on the very first paying activation. Stripe sends both
    # subscription.created AND subscription.updated for the initial
    # event in some cases; the prior-tier check prevents duplicates.
    is_trial = status == "trialing"
    # Any first paid activation (free -> any non-free tier). Tier-agnostic so
    # a newly added tier can never be silently skipped here.
    if prior_tier == "free" and new_tier != "free":
        _send_welcome_email(user_id, new_tier, is_trial)

    # Cancellation — fire when cancel_at_period_end FLIPS from false→true.
    if not prior_cancel and cancel_at_period_end:
        _send_cancel_email(user_id, new_tier, period_end_iso)


def _handle_subscription_deleted(sub):
    """Subscription fully ended (past the cancel_at_period_end date, or
    deleted directly). Downgrade the user to free."""
    sub_id = sub.get("id")
    customer_id = sub.get("customer")
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE user_subscriptions
               SET tier                 = 'free',
                   subscription_id      = NULL,
                   interval             = NULL,
                   current_period_end   = NULL,
                   cancel_at_period_end = FALSE,
                   updated_at           = NOW()
             WHERE subscription_id = %s OR customer_id = %s
            """,
            (sub_id, customer_id),
        )
        conn.commit()


def _handle_payment_failed(invoice):
    """A subscription's payment failed. Stripe will retry automatically
    (Smart Retries). We don't change access here — Stripe will fire a
    subscription.updated with status='past_due' for that, and eventually
    subscription.deleted if retries exhaust.

    We DO email the customer so they can update their card before
    retries are exhausted."""
    sub_id = invoice.get("subscription")
    customer_id = invoice.get("customer")
    log.warning("payment_failed: sub=%s customer=%s amount_due=%s",
                sub_id, customer_id, invoice.get("amount_due"))
    user_id = _user_id_from_customer(customer_id) if customer_id else None
    if user_id:
        _send_payment_failed_email(user_id)


# ─────────────────────────────────────────────────────────────────
# Read-only helpers used by /account UI
# ─────────────────────────────────────────────────────────────────

@router.get("/billing/products")
def get_products():
    """Return the configured price IDs and amounts for display on
    /pricing. Lets the frontend show real prices without hard-coding
    them in two places."""
    _set_stripe_key()
    try:
        out = {}
        for price_id, (tier, interval) in _price_map().items():
            price = stripe.Price.retrieve(price_id)
            out[f"{tier}_{interval}"] = {
                "id":       price.id,
                "amount":   (price.unit_amount or 0) / 100,
                "currency": price.currency,
                "interval": interval,
                "tier":     tier,
            }
        return out
    except stripe.error.StripeError as e:
        raise HTTPException(status_code=502, detail=str(e))
