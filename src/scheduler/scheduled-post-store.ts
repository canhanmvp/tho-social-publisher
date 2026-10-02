import type { Pool } from 'pg';

export interface ScheduledImage {
  type: 'image';
  url: string;
  altText?: string;
}

export interface ScheduledPost {
  id: string;
  socialAccountId: string;
  text: string;
  media: ScheduledImage[];
  contentFingerprint: string | null;
  scheduledAt: Date;
  status: 'scheduled' | 'processing' | 'published' | 'failed' | 'cancelled';
  attempts: number;
  pgbossJobId: string | null;
  providerPostId: string | null;
  lastError: unknown;
}

interface ScheduledPostRow {
  id: string;
  social_account_id: string;
  body_text: string;
  media: ScheduledImage[];
  content_fingerprint: string | null;
  scheduled_at: Date;
  status: ScheduledPost['status'];
  attempts: number;
  pgboss_job_id: string | null;
  provider_post_id: string | null;
  last_error: unknown;
}

function mapRow(row: ScheduledPostRow): ScheduledPost {
  return {
    id: row.id,
    socialAccountId: row.social_account_id,
    text: row.body_text,
    media: row.media,
    contentFingerprint: row.content_fingerprint,
    scheduledAt: row.scheduled_at,
    status: row.status,
    attempts: row.attempts,
    pgbossJobId: row.pgboss_job_id,
    providerPostId: row.provider_post_id,
    lastError: row.last_error,
  };
}

const RETURNING_COLUMNS = `id,
  social_account_id,
  body_text,
  media,
  content_fingerprint,
  scheduled_at,
  status,
  attempts,
  pgboss_job_id,
  provider_post_id,
  last_error`;

export class ScheduledPostStore {
  public constructor(private readonly pool: Pool) {}

  public async create(input: {
    socialAccountId: string;
    text: string;
    media: ScheduledImage[];
    contentFingerprint: string;
    scheduledAt: Date;
  }): Promise<ScheduledPost> {
    const result = await this.pool.query<ScheduledPostRow>(
      `INSERT INTO scheduled_posts (
          social_account_id,
          body_text,
          media,
          content_fingerprint,
          scheduled_at,
          status
        )
       VALUES ($1, $2, $3::jsonb, $4, $5, 'scheduled')
       RETURNING ${RETURNING_COLUMNS}`,
      [
        input.socialAccountId,
        input.text,
        JSON.stringify(input.media),
        input.contentFingerprint,
        input.scheduledAt,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Failed to create scheduled post.');
    }

    return mapRow(row);
  }

  public async attachJob(postId: string, jobId: string): Promise<void> {
    await this.pool.query(
      `UPDATE scheduled_posts
          SET pgboss_job_id = $2,
              updated_at = now()
        WHERE id = $1`,
      [postId, jobId],
    );
  }

  public async get(postId: string): Promise<ScheduledPost | null> {
    const result = await this.pool.query<ScheduledPostRow>(
      `SELECT ${RETURNING_COLUMNS}
         FROM scheduled_posts
        WHERE id = $1`,
      [postId],
    );

    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  public async list(limit = 100): Promise<ScheduledPost[]> {
    const result = await this.pool.query<ScheduledPostRow>(
      `SELECT ${RETURNING_COLUMNS}
         FROM scheduled_posts
        ORDER BY scheduled_at ASC
        LIMIT $1`,
      [limit],
    );

    return result.rows.map(mapRow);
  }

  public async markProcessing(postId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE scheduled_posts
          SET status = 'processing',
              attempts = attempts + 1,
              updated_at = now()
        WHERE id = $1
          AND status = 'scheduled'`,
      [postId],
    );

    return (result.rowCount ?? 0) > 0;
  }

  public async markPublished(postId: string, providerPostId: string): Promise<void> {
    await this.pool.query(
      `WITH publication AS (
        UPDATE scheduled_posts
          SET status = 'published',
              provider_post_id = $2,
              published_at = COALESCE(published_at, now()),
              last_error = NULL,
              updated_at = now()
        WHERE id = $1
          AND (provider_post_id IS NULL OR provider_post_id = $2)
        RETURNING id, social_account_id, body_text, media, content_fingerprint, published_at
       )
       INSERT INTO published_posts (
         scheduled_post_id, social_account_id, provider_post_id,
         body_text, media, content_fingerprint, published_at
       )
       SELECT id, social_account_id, $2, body_text, media, content_fingerprint, published_at
         FROM publication
       ON CONFLICT (provider_post_id, social_account_id) DO NOTHING`,
      [postId, providerPostId],
    );
  }

  public async markAttemptFailed(
    postId: string,
    error: { name: string; message: string },
    finalFailure: boolean,
    providerPostId?: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE scheduled_posts
          SET status = $2,
              last_error = $3::jsonb,
              provider_post_id = COALESCE(provider_post_id, $4),
              updated_at = now()
        WHERE id = $1
          AND status IN ('scheduled', 'processing')`,
      [
        postId,
        finalFailure ? 'failed' : 'scheduled',
        JSON.stringify(error),
        providerPostId ?? null,
      ],
    );
  }

  public async markQueueFailure(postId: string, message: string): Promise<void> {
    await this.markAttemptFailed(postId, { name: 'QueueError', message }, true);
  }

  public async markInterrupted(postId: string): Promise<void> {
    await this.pool.query(
      `UPDATE scheduled_posts SET status = 'failed', last_error = $2::jsonb, updated_at = now()
        WHERE id = $1 AND status = 'processing'`,
      [
        postId,
        JSON.stringify({
          name: 'ThreadsPublicationUncertainError',
          message:
            'A publishing attempt was interrupted. Check the account before publishing this content again.',
        }),
      ],
    );
  }

  public async findPublishedId(postId: string): Promise<string | null> {
    const result = await this.pool.query<{ provider_post_id: string }>(
      `SELECT provider_post_id FROM published_posts
        WHERE scheduled_post_id = $1
        ORDER BY published_at ASC LIMIT 1`,
      [postId],
    );
    return result.rows[0]?.provider_post_id ?? null;
  }

  public async listStaleUnfinished(): Promise<ScheduledPost[]> {
    const result = await this.pool.query<ScheduledPostRow>(
      `SELECT ${RETURNING_COLUMNS} FROM scheduled_posts
        WHERE (status IN ('scheduled', 'processing')
               OR (status = 'failed' AND provider_post_id IS NOT NULL))
          AND scheduled_at <= now()
          AND updated_at < now() - interval '3 minutes'
        ORDER BY updated_at ASC LIMIT 100`,
    );
    return result.rows.map(mapRow);
  }

  public async cancel(postId: string): Promise<ScheduledPost | null> {
    const result = await this.pool.query<ScheduledPostRow>(
      `UPDATE scheduled_posts
          SET status = 'cancelled',
              updated_at = now()
        WHERE id = $1
          AND status = 'scheduled'
          AND provider_post_id IS NULL
      RETURNING ${RETURNING_COLUMNS}`,
      [postId],
    );

    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }
}
