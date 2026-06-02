#!/usr/bin/env python3
"""
Reconcile Stripe subscriptions -> user_subscriptions.

A safety net + backfill: walks every Stripe subscription, resolves the
app user + (tier, interval) from the price map, and makes the DB row match.
This catches anything a webhook missed (a swallowed error, an out-of-order
event, a missing CHECK-constraint value, a webhook outage). Idempotent.

Run it after billing changes, on a periodic cron, or to fix a specific
"I paid but my account didn't update" support case.

    PYTHONPATH=backend python3 scripts/reconcile_stripe_subscriptions.py            # dry run
    PYTHONPATH=backend python3 scripts/reconcile_stripe_subscriptions.py --commit   # apply

Requires STRIPE_API_KEY in the environment (server .env), same as the app.
"""
import argparse
import os
import sys
from datetime import datetime, timezone

import stripe

from app.models.database import get_connection
from app.api.billing import _price_map, _tier_from_subscription, _user_id_from_customer

# Statuses that should grant the paid tier. Anything else (canceled, unpaid,
# incomplete, incomplete_expired) means no active access -> free.
ACTIVE_STATUSES = {"active", "trialing", "past_due"}


def _period_end_iso(sub):
    ts = sub.get("current_period_end")
    if not ts:
        items = (sub.get("items") or {}).get("data") or []
        ts = items[0].get("current_period_end") if items else None
    return datetime.fromtimestamp(int(ts), timezone.utc).isoformat() if ts else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="Apply changes (default: dry run)")
    args = ap.parse_args()

    key = os.getenv("STRIPE_API_KEY", "")
    if not key:
        print("STRIPE_API_KEY not set in environment.", file=sys.stderr)
        sys.exit(1)
    stripe.api_key = key

    changes, skipped, ok = [], 0, 0
    with get_connection() as conn:
        cur = conn.cursor()
        for sub in stripe.Subscription.list(status="all", limit=100).auto_paging_iter():
            sub_id = sub.get("id")
            customer_id = sub.get("customer")
            status = sub.get("status")
            ti = _tier_from_subscription(sub)
            if not ti:
                skipped += 1
                continue  # price not in our map (e.g. a legacy/test price)
            target_tier, interval = ti
            new_tier = target_tier if status in ACTIVE_STATUSES else "free"

            user_id = (sub.get("metadata") or {}).get("user_id") or _user_id_from_customer(customer_id)
            if not user_id:
                print(f"  ! no app user for sub={sub_id} customer={customer_id} ({status}) — skipped")
                skipped += 1
                continue

            cur.execute("SELECT tier, subscription_id FROM user_subscriptions WHERE user_id = %s", (user_id,))
            row = cur.fetchone()
            cur_tier = (row or {}).get("tier")
            cancel_at_end = bool(sub.get("cancel_at_period_end", False))

            if cur_tier == new_tier and (row or {}).get("subscription_id") == sub_id:
                ok += 1
                continue

            changes.append((user_id, cur_tier, new_tier, interval, sub_id, status))
            if args.commit:
                cur.execute(
                    """
                    INSERT INTO user_subscriptions
                      (user_id, customer_id, subscription_id, tier, interval, provider,
                       started_at, current_period_end, cancel_at_period_end, updated_at)
                    VALUES (%s, %s, %s, %s, %s, 'stripe', NOW(), %s, %s, NOW())
                    ON CONFLICT (user_id) DO UPDATE SET
                      customer_id          = EXCLUDED.customer_id,
                      subscription_id      = EXCLUDED.subscription_id,
                      tier                 = EXCLUDED.tier,
                      interval             = EXCLUDED.interval,
                      current_period_end   = EXCLUDED.current_period_end,
                      cancel_at_period_end = EXCLUDED.cancel_at_period_end,
                      updated_at           = NOW()
                    """,
                    (user_id, customer_id, sub_id, new_tier, interval,
                     _period_end_iso(sub), cancel_at_end),
                )
        if args.commit:
            conn.commit()

    print(f"\n=== reconcile: {len(changes)} change(s), {ok} already-correct, {skipped} skipped ===")
    for user_id, old, new, interval, sub_id, status in changes:
        print(f"  {user_id}  {old} -> {new}  ({interval}, {status}, {sub_id})")
    print("\nApplied." if args.commit else "\nDry run. Re-run with --commit to apply.")


if __name__ == "__main__":
    main()
