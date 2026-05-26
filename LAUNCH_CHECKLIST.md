# Paid-Tier Launch Checklist

What to do, in order, to actually start charging real money + gating
premium content. Until step 4 runs, the site is in "soft mode" — every
piece of paywall code is deployed, but nothing is actually behind a paywall.

## Pre-flight (in test/sandbox mode)

Already done as of 2026-05-25:

- [x] Stripe sandbox account created
- [x] Products + 4 prices created (Premium $5/mo + $50/yr, Coach $25/mo + $250/yr)
- [x] Webhook created in sandbox pointing at production URL
- [x] `STRIPE_API_KEY`, 4 `STRIPE_PRICE_*` vars, and `STRIPE_WEBHOOK_SECRET`
      set in production `.env` (test keys)
- [x] End-to-end test subscription completed (test card `4242 4242 4242 4242`)
- [x] DB schema extended (`user_subscriptions` has Stripe columns + tier
      constraint includes `premium` / `coach`)
- [x] Premium frontend routes wrapped in `<RequireTier minTier="premium">`
- [x] `require_tier()` FastAPI dependency available for backend gating
      (apply to specific endpoints as needed)

## Step 1 — Switch Stripe to Live mode

1. Log into Stripe dashboard, top-right toggle from **Sandbox** to **Live**
2. Stripe walks through activation: legal entity (Sole Prop is fine),
   SSN for 1099 reporting, bank account for payouts
3. Wait for approval (usually instant for sole prop; can take a day)

## Step 2 — Recreate products + prices in Live mode

Sandbox products do NOT carry over. From the live dashboard:

1. Products → Add product → "NW Baseball Stats Premium"
   - Add Price: `$5.00 / month recurring`
   - Add Price: `$50.00 / year recurring`
2. Products → Add product → "NW Baseball Stats Coach & Scout"
   - Add Price: `$25.00 / month recurring`
   - Add Price: `$250.00 / year recurring`
3. Copy all 4 live price IDs (start with `price_1...`, different from sandbox)

## Step 3 — Recreate webhook in Live mode

1. Live dashboard → Developers → Webhooks → Add endpoint
2. URL: `https://nwbaseballstats.com/api/v1/billing/webhook`
3. Same 5 events as sandbox: `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`
4. Copy the live signing secret (`whsec_...`, different from sandbox)

## Step 4 — Flip the production server to live mode

SSH to the server and update `.env`:

```bash
ssh pnw
cd /opt/pnw-baseball

# Swap test keys for live ones
sed -i 's/^STRIPE_API_KEY=.*/STRIPE_API_KEY=sk_live_.../' .env
sed -i 's/^STRIPE_WEBHOOK_SECRET=.*/STRIPE_WEBHOOK_SECRET=whsec_.../' .env
sed -i 's/^STRIPE_PRICE_PREMIUM_MONTHLY=.*/STRIPE_PRICE_PREMIUM_MONTHLY=price_.../' .env
sed -i 's/^STRIPE_PRICE_PREMIUM_YEARLY=.*/STRIPE_PRICE_PREMIUM_YEARLY=price_.../' .env
sed -i 's/^STRIPE_PRICE_COACH_MONTHLY=.*/STRIPE_PRICE_COACH_MONTHLY=price_.../' .env
sed -i 's/^STRIPE_PRICE_COACH_YEARLY=.*/STRIPE_PRICE_COACH_YEARLY=price_.../' .env

# Flip the paywall gating ON (backend)
echo 'TIER_GATING_ENABLED=true' >> .env

sudo systemctl restart nwbb
```

## Step 5 — Rebuild the frontend with hard-mode gating

The frontend reads `VITE_TIER_GATING_ENABLED` at BUILD time, not runtime.
Two ways to set it:

### Option A — Vercel (preferred — the public site)
1. Vercel dashboard → project → Settings → Environment Variables
2. Add `VITE_TIER_GATING_ENABLED` = `true` (Production scope)
3. Redeploy (Vercel → Deployments → latest → Redeploy)

### Option B — Server-built frontend (the `/opt/pnw-baseball/frontend/dist`)
```bash
ssh pnw
cd /opt/pnw-baseball/frontend
VITE_TIER_GATING_ENABLED=true npm run build
sudo systemctl restart nwbb
```

Do both if both serve traffic. Vercel is the canonical public site.

## Step 6 — Real-money smoke test (yours)

1. Open `https://nwbaseballstats.com/pricing` in a private window
2. Sign in as your own account
3. Click "Start 7-day free trial" on Premium monthly
4. Use a REAL card (yours)
5. Confirm:
   - Redirected back to `/account?upgraded=true`
   - Subscription section shows Premium badge
   - Stripe live dashboard shows the new customer + subscription
6. Refund yourself via the Customer Portal or live dashboard

## Step 7 — Announce

- [ ] Soft launch — quietly, see if anyone signs up
- [ ] Newsletter blast announcing tiers (use the broadcast composer)
- [ ] Social posts
- [ ] Article on `/news` explaining what's new

## Rollback (if something is broken after launch)

To go back to soft mode without removing the Stripe code:

```bash
ssh pnw
cd /opt/pnw-baseball
sed -i 's/^TIER_GATING_ENABLED=.*/TIER_GATING_ENABLED=false/' .env
sudo systemctl restart nwbb
```

Then on Vercel set `VITE_TIER_GATING_ENABLED=false` and redeploy.
Frontend hard gates revert to soft mode; backend stops 402'ing.
Subscriptions Stripe is already collecting will continue (you can't
un-bill someone), but premium content will be accessible to all signed-in
users again.

## Future work (post-launch)

- Apply `Depends(require_tier("premium"))` to specific backend endpoints
  that serve premium-only data (recruiting/draft/park-factors/etc.)
  Currently only the frontend routes are gated; the underlying API is
  still open. Frontend gating is sufficient for "honor system" launch;
  full backend enforcement is needed for serious paywall integrity.
- Article-level paywall: add `requires_tier` column on `articles`, edit-
  time picker, runtime gate in `NewsArticle.jsx`.
- Welcome email on subscription start (via `send_notification`)
- Cancellation confirmation email
- Payment-failed email
- Admin-managed coupon codes for college program discounts (Stripe
  coupons are already enabled on Checkout via `allow_promotion_codes`)

## Env vars at-a-glance

| Var | Used by | Notes |
|---|---|---|
| `STRIPE_API_KEY` | Backend | `sk_test_...` or `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Backend | `whsec_...` from webhook config |
| `STRIPE_PRICE_PREMIUM_MONTHLY` | Backend | Sandbox vs live = different IDs |
| `STRIPE_PRICE_PREMIUM_YEARLY` | Backend | " |
| `STRIPE_PRICE_COACH_MONTHLY` | Backend | " |
| `STRIPE_PRICE_COACH_YEARLY` | Backend | " |
| `TIER_GATING_ENABLED` | Backend | `true` to enforce premium API gates |
| `VITE_TIER_GATING_ENABLED` | Frontend (build-time) | `true` to enforce premium route gates |
| `SITE_URL` | Backend | Defaults to `https://nwbaseballstats.com` |
