ALTER TABLE published_posts
  ADD COLUMN IF NOT EXISTS content_fingerprint text;

CREATE INDEX IF NOT EXISTS published_posts_fingerprint_time_idx
  ON published_posts(content_fingerprint, published_at DESC)
  WHERE content_fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS scheduled_posts_fingerprint_time_idx
  ON scheduled_posts(content_fingerprint, scheduled_at)
  WHERE content_fingerprint IS NOT NULL;
