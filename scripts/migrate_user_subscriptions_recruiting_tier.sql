-- Allow the 'recruiting' tier in user_subscriptions.
--
-- The Recruiting tier ($10/mo, $100/yr) was added to the app + Stripe price
-- map, but the user_subscriptions.tier CHECK constraint still only allowed
-- ('free','premium','coach'). So the billing webhook's write for a recruiting
-- subscriber threw a CheckViolation that the handler swallowed (returned 200),
-- leaving the customer charged but stuck on the free tier. Widen the
-- constraint to match the tiers the application can actually assign.
--
-- Apply:
--   PYTHONPATH=backend python3 -c "from app.models.database import get_connection; \
--     conn=get_connection().__enter__(); cur=conn.cursor(); \
--     cur.execute(open('scripts/migrate_user_subscriptions_recruiting_tier.sql').read()); conn.commit()"

ALTER TABLE user_subscriptions DROP CONSTRAINT IF EXISTS user_subscriptions_tier_check;
ALTER TABLE user_subscriptions ADD CONSTRAINT user_subscriptions_tier_check
  CHECK (tier IN ('free', 'premium', 'recruiting', 'coach'));
