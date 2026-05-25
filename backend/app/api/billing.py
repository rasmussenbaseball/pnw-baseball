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
  STRIPE_PRICE_PREMIUM_MONTHLY — Price ID for Premium $5/mo
  STRIPE_PRICE_PREMIUM_YEARLY  — Price ID for Premium $50/yr
  STRIPE_PRICE_COACH_MONTHLY   — Price ID for Coach $25/mo
  STRIPE_PRICE_COACH_YEARLY    — Price ID for Coach $250/yr
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
        os.getenv("STRIPE_PRICE_PREMIUM_MONTHLY"): ("premium", "monthly"),
        os.getenv("STRIPE_PRICE_PREMIUM_YEARLY"):  ("premium", "yearly"),
        os.getenv("STRIPE_PRICE_COACH_MONTHLY"):   ("coach",   "monthly"),
        os.getenv("STRIPE_PRICE_COACH_YEARLY"):    ("coach",   "yearly"),
    }
    return {k: v for k, v in raw.items() if k}


def _lookup_price(tier: str, interval: str) -> Optional[str]:
    for price_id, (t, i) in _price_map().items():
        if t == tier and i == interval:
            return price_id
    return None


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


# ─────────────────────────────────────────────────────────────────
# Schemas
# ─────────────────────────────────────────────────────────────────

class CheckoutRequest(BaseModel):
    tier:     str = Field(..., pattern="^(premium|coach)$")
    interval: str = Field(..., pattern="^(monthly|yearly)$")


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

    # 7-day free trial only on Premium monthly (per spec, 2026-05-25).
    # Coach pays up front; Premium yearly users already get the "2 months
    # free" discount so we skip the trial there.
    if body.tier == "premium" and body.interval == "monthly":
        params["subscription_data"]["trial_period_days"] = 7

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
        # Return 200 so Stripe doesn't pound the webhook on transient DB
        # errors; the same event can be re-driven from the dashboard.
        return {"received": True, "error": "handler_failed"}

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
    """A subscription was created or modified. Sync our DB row."""
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

    # If status indicates the subscription is no longer providing access,
    # downgrade to free.
    if status in ("canceled", "unpaid", "incomplete_expired"):
        new_tier = "free"
    else:
        new_tier = target_tier  # active, trialing, past_due → still has access

    with get_connection() as conn:
        cur = conn.cursor()
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
    subscription.deleted if retries exhaust. We do log for visibility."""
    sub_id = invoice.get("subscription")
    customer_id = invoice.get("customer")
    log.warning("payment_failed: sub=%s customer=%s amount_due=%s",
                sub_id, customer_id, invoice.get("amount_due"))
    # TODO (next phase): send an email to the customer via send_notification


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
