#!/usr/bin/env python3
"""
Grant (or revoke) a comped subscription tier — free trials/giveaways.

A comp is just a user_subscriptions row with provider='comp' and an ends_at.
The API + frontend honor it via comp_aware_tier() in auth.py, which treats a
comp as expired once ends_at passes — so comps SELF-EXPIRE, no cron needed.
Real Stripe subscriptions are untouched (they're webhook-driven).

Usage:
    # give a 1-month recruiting comp
    PYTHONPATH=backend python3 scripts/grant_comp.py user@example.com recruiting --months 1

    # 3 months of premium
    PYTHONPATH=backend python3 scripts/grant_comp.py user@example.com premium --months 3

    # revoke now (back to free)
    PYTHONPATH=backend python3 scripts/grant_comp.py user@example.com --revoke

    # show current status
    PYTHONPATH=backend python3 scripts/grant_comp.py user@example.com --show
"""
import sys
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
from app.models.database import get_connection

TIERS = ("free", "premium", "recruiting", "coach")


def find_user(cur, email):
    cur.execute("SELECT id, email FROM auth.users WHERE lower(email) = lower(%s)", (email,))
    return cur.fetchone()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("email")
    ap.add_argument("tier", nargs="?", choices=TIERS, help="tier to grant (omit with --revoke/--show)")
    ap.add_argument("--months", type=int, default=1, help="comp length in months (default 1)")
    ap.add_argument("--revoke", action="store_true", help="set the user back to free now")
    ap.add_argument("--show", action="store_true", help="just print current subscription")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()
        u = find_user(cur, args.email)
        if not u:
            print(f"No account found for {args.email}. They must sign up first.")
            return
        uid = u["id"]

        if args.show:
            cur.execute("SELECT tier, provider, started_at::date, ends_at::date, external_ref FROM user_subscriptions WHERE user_id = %s", (uid,))
            row = cur.fetchone()
            print(f"{args.email}: {dict(row) if row else 'no subscription row (free)'}")
            return

        if args.revoke:
            cur.execute(
                "UPDATE user_subscriptions SET tier='free', provider='comp', ends_at=now(), "
                "cancel_at_period_end=TRUE, external_ref='comp revoked', updated_at=now() WHERE user_id=%s",
                (uid,),
            )
            conn.commit()
            print(f"Revoked {args.email} → free." if cur.rowcount else f"{args.email} had no row (already free).")
            return

        if not args.tier:
            print("Specify a tier to grant (e.g. recruiting), or use --revoke / --show.")
            return

        note = f"comp: {args.months}-month {args.tier} (grant_comp.py)"
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
            (uid, args.tier, args.months, args.months, note),
        )
        conn.commit()
        cur.execute("SELECT tier, ends_at::date FROM user_subscriptions WHERE user_id=%s", (uid,))
        r = cur.fetchone()
        print(f"Granted {args.email}: {r['tier']} through {r['ends_at']} ({args.months} month{'s' if args.months != 1 else ''}).")


if __name__ == "__main__":
    main()
