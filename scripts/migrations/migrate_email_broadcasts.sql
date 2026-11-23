-- Audit log of every email broadcast we send. One row per send-attempt.
--
-- author_id        — supabase auth user that hit Send
-- author_email     — denormalized for quick history viewing
-- audience         — which mailing-list flag was used: news | promos | updates
-- subject / body_md — exactly what was sent
-- recipient_count  — how many addresses were in the queue
-- sent_count       — how many Resend actually accepted
-- failed_count     — recipient_count - sent_count (0 on a clean send)
-- status           — sending | sent | partial | failed
-- created_at       — when the send started
-- sent_at          — when the send finished

CREATE TABLE IF NOT EXISTS email_broadcasts (
  id              SERIAL PRIMARY KEY,
  author_id       UUID NOT NULL,
  author_email    TEXT NOT NULL,
  audience        TEXT NOT NULL CHECK (audience IN ('news','promos','updates')),
  subject         TEXT NOT NULL,
  body_md         TEXT NOT NULL,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  sent_count      INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'sending',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  sent_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_email_broadcasts_created_at
  ON email_broadcasts (created_at DESC);

-- Lock down via RLS. The FastAPI backend connects as the postgres role
-- (bypasses RLS) so its endpoints continue to work, but no anon/authed
-- PostgREST request can read this table.
ALTER TABLE email_broadcasts ENABLE ROW LEVEL SECURITY;
