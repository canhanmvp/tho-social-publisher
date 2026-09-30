ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS pgboss_job_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS scheduled_posts_pgboss_job_id_idx
  ON scheduled_posts(pgboss_job_id)
  WHERE pgboss_job_id IS NOT NULL;
