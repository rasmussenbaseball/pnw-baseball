-- Article paywall: each article carries the minimum tier needed to
-- read its body. Default 'free' keeps every existing article fully
-- open to signed-in users; the author can flip individual articles
-- to 'premium' or 'coach' from the editor.
--
-- Anonymous users always see article metadata (title, subtitle, hero
-- image, excerpt) — the body is what gets paywalled.
--
-- Free (anonymous OR signed-in free): can read 'free' and (limited)
--   'premium' articles' previews
-- Premium subscribers: read everything except 'coach'-only articles
-- Coach subscribers: read everything

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS requires_tier TEXT NOT NULL DEFAULT 'free';

ALTER TABLE articles DROP CONSTRAINT IF EXISTS articles_requires_tier_check;
ALTER TABLE articles
  ADD CONSTRAINT articles_requires_tier_check
  CHECK (requires_tier IN ('free','premium','coach'));

CREATE INDEX IF NOT EXISTS idx_articles_requires_tier
  ON articles (requires_tier);
