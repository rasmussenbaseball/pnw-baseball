-- Extend user_subscriptions for Stripe-backed billing.
--
-- Adds:
--   provider             — payment provider, 'stripe' for now
--   interval             — 'monthly' | 'yearly' (active subscription cadence)
--   customer_id          — Stripe customer ID (one per user, persists across
--                          subscriptions / re-subscribes)
--   subscription_id      — Stripe subscription ID (null when on free tier)
--   current_period_end   — when the active period ends; access continues
--                          through this date even after cancellation
--   cancel_at_period_end — true when user has canceled but is keeping
--                          access through `current_period_end`
--
-- Also tightens the tier CHECK constraint to the canonical 4-tier matrix
-- (we drop the temporary 'paid' value used in Phase 1). Anyone currently
-- on 'paid' is migrated to 'premium' first.

ALTER TABLE user_subscriptions
  ADD COLUMN IF NOT EXISTS provider             TEXT    DEFAULT 'stripe',
  ADD COLUMN IF NOT EXISTS interval             TEXT,
  ADD COLUMN IF NOT EXISTS customer_id          TEXT,
  ADD COLUMN IF NOT EXISTS subscription_id      TEXT,
  ADD COLUMN IF NOT EXISTS current_period_end   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_customer_id
  ON user_subscriptions (customer_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_subscription_id
  ON user_subscriptions (subscription_id);

-- Drop the old CHECK that only allowed ('free','paid'). We expand briefly
-- so the data migration UPDATE doesn't fail, then re-tighten.
ALTER TABLE user_subscriptions DROP CONSTRAINT IF EXISTS user_subscriptions_tier_check;

ALTER TABLE user_subscriptions
  ADD CONSTRAINT user_subscriptions_tier_check
  CHECK (tier IN ('free','paid','premium','coach'));

UPDATE user_subscriptions
   SET tier = 'premium'
 WHERE tier = 'paid';

ALTER TABLE user_subscriptions DROP CONSTRAINT user_subscriptions_tier_check;
ALTER TABLE user_subscriptions
  ADD CONSTRAINT user_subscriptions_tier_check
  CHECK (tier IN ('free','premium','coach'));
