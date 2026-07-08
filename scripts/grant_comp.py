#!/usr/bin/env python3
"""
Grant (or revoke) a comped subscription tier — free trials/giveaways.

A comp is just a user_subscriptions row with provider='comp' and an ends_at.
The API + frontend honor it via comp_aware_tier() in auth.py, which treats a
comp as expired once ends_at passes — so comps SELF-EXPIRE, no cron needed.
Real Stripe subscriptions are untouched (they're webhook-driven).

NO ACCOUNT YET? The grant is QUEUED in pending_comps instead of failing.
The comp auto-applies (full length, starting that day) the first time the
email signs in — /me/subscription in account.py checks the queue.

Usage:
    # give a 1-month recruiting comp (queues automatically if no account yet)
    PYTHONPATH=backend python3 scripts/grant_comp.py user@example.com recruiting --months 1

    # 3 months of premium
    PYTHONPATH=backend python3 scripts/grant_comp.py user@example.com premium --months 3

    # revoke now (back to free; also clears any queued comp)
    PYTHONPATH=backend python3 scripts/grant_comp.py user@example.com --revoke

    # show current status (subscription + queued comp)
    PYTHONPATH=backend python3 scripts/grant_comp.py user@example.com --show

    # list every queued comp that hasn't applied yet
    PYTHONPATH=backend python3 scripts/grant_comp.py --pending
"""
import sys
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
from app.models.database import get_connection
from app.api.account import _ensure_pending_comps_table

TIERS = ("free", "premium", "recruiting", "coach")


def find_user(cur, email):
    cur.execute("SELECT id, email FROM auth.users WHERE lower(email) = lower(%s)", (email,))
    return cur.fetchone()


def pending_row(cur, email):
    _ensure_pending_comps_table(cur)
    cur.execute(
        "SELECT tier, months, created_at::date AS created, applied_at::date AS applied "
        "FROM pending_comps WHERE lower(email) = lower(%s)",
        (email,),
    )
    return cur.fetchone()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("email", nargs="?", help="account email (omit with --pending)")
    ap.add_argument("tier", nargs="?", choices=TIERS, help="tier to grant (omit with --revoke/--show)")
    ap.add_argument("--months", type=int, default=1, help="comp length in months (default 1)")
    ap.add_argument("--revoke", action="store_true", help="set the user back to free now")
    ap.add_argument("--show", action="store_true", help="just print current subscription")
    ap.add_argument("--pending", action="store_true", help="list all queued comps that haven't applied yet")
    args = ap.parse_args()

    with get_connection() as conn:
        cur = conn.cursor()

        if args.pending:
            _ensure_pending_comps_table(cur)
            cur.execute(
                "SELECT email, tier, months, created_at::date AS created FROM pending_comps "
                "WHERE applied_at IS NULL ORDER BY created_at"
            )
            rows = cur.fetchall()
            conn.commit()
            if not rows:
                print("No pending comps.")
            for r in rows:
                print(f"  {r['email']}: {r['months']}-month {r['tier']} (queued {r['created']})")
            return

        if not args.email:
            print("An email is required (or use --pending to list queued comps).")
            return

        u = find_user(cur, args.email)

        if not u:
            # No account yet — queue the comp; it auto-applies on first sign-in.
            if args.show:
                p = pending_row(cur, args.email)
                conn.commit()
                print(f"{args.email}: no account yet. " +
                      (f"Queued comp: {p['months']}-month {p['tier']} (since {p['created']})." if p and not p["applied"]
                       else "No queued comp."))
                return
            if args.revoke:
                _ensure_pending_comps_table(cur)
                cur.execute("DELETE FROM pending_comps WHERE lower(email) = lower(%s)", (args.email,))
                conn.commit()
                print(f"Cleared queued comp for {args.email}." if cur.rowcount
                      else f"No account and no queued comp for {args.email}.")
                return
            if not args.tier:
                print(f"No account found for {args.email}. Specify a tier to QUEUE a comp for when they sign up.")
                return
            _ensure_pending_comps_table(cur)
            note = f"comp: {args.months}-month {args.tier} (grant_comp.py, queued)"
            cur.execute(
                """INSERT INTO pending_comps (email, tier, months, note)
                   VALUES (lower(%s), %s, %s, %s)
                   ON CONFLICT (email) DO UPDATE SET
                       tier=excluded.tier, months=excluded.months, note=excluded.note,
                       created_at=now(), applied_at=NULL""",
                (args.email, args.tier, args.months, note),
            )
            conn.commit()
            print(f"QUEUED for {args.email}: {args.months}-month {args.tier}. "
                  f"No account yet — the comp applies automatically (full length) the first time they sign in.")
            return

        uid = u["id"]

        if args.show:
            cur.execute("SELECT tier, provider, started_at::date, ends_at::date, external_ref FROM user_subscriptions WHERE user_id = %s", (uid,))
            row = cur.fetchone()
            p = pending_row(cur, args.email)
            conn.commit()
            print(f"{args.email}: {dict(row) if row else 'no subscription row (free)'}")
            if p and not p["applied"]:
                print(f"  + queued comp waiting: {p['months']}-month {p['tier']} (applies on next sign-in)")
            return

        if args.revoke:
            cur.execute(
                "UPDATE user_subscriptions SET tier='free', provider='comp', ends_at=now(), "
                "cancel_at_period_end=TRUE, external_ref='comp revoked', updated_at=now() WHERE user_id=%s",
                (uid,),
            )
            revoked = cur.rowcount
            _ensure_pending_comps_table(cur)
            cur.execute("DELETE FROM pending_comps WHERE lower(email) = lower(%s) AND applied_at IS NULL", (args.email,))
            conn.commit()
            print(f"Revoked {args.email} → free." if revoked else f"{args.email} had no row (already free).")
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
