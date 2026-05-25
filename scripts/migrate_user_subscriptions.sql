-- Per-user subscription tier.
--
-- Phase 1: only 'free' exists; everyone with an account is implicitly
-- free even if they don't have a row in this table. The /me/subscription
-- endpoint falls back to 'free' for the no-row case so we never have to
-- backfill rows for existing users.
--
-- Phase 2 (later): when paid tiers ship, a webhook from the payment
-- provider (Stripe / LemonSqueezy / whichever we pick) will upsert a
-- row here with tier='paid' (or finer levels if we tier the paid plan).
--
-- Columns:
--   user_id        — supabase auth user (PK, FK-like)
--   tier           — current tier: 'free' | 'paid' | (future tiers)
--   started_at     — when the current tier began
--   ends_at        — null = active; set on cancellation w/ remaining time
--   external_ref   — Stripe customer / subscription id (Phase 2)
--   created_at / updated_at

CREATE TABLE IF NOT EXISTS user_subscriptions (
  user_id      UUID PRIMARY KEY,
  tier         TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free','paid')),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at      TIMESTAMPTZ,
  external_ref TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Lock down via RLS so PostgREST / anon clients can never read it. The
-- FastAPI backend connects as postgres (bypasses RLS) so its endpoints
-- continue to work. Self-read policy lets a user read their own row if
-- we ever expose it via PostgREST.
ALTER TABLE user_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_subscriptions_self_read" ON user_subscriptions;
CREATE POLICY "user_subscriptions_self_read"
  ON user_subscriptions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
