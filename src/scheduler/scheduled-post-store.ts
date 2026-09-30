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
    scheduledAt: row.scheduled_at,
    status: row.status,
    attempts: row.attempts,
    pgbossJobId: row.pgboss_job_id,
    providerPostId: row.provider_post_id,
    lastError: row.last_error,
  };
}

export class ScheduledPostStore {
  public constructor(private readonly pool: Pool) {}

  public async create(input: {
    socialAccountId: string;
    text: string;
    media: ScheduledImage[];
    scheduledAt: Date;
  }): Promise<ScheduledPost> {
    const result = await this.pool.query<ScheduledPostRow>(
      `INSERT INTO scheduled_posts (
          social_account_id,
          body_text,
          media,
          scheduled_at,
          status
        )
       VALUES ($1, $2, $3::jsonb, $4, 'scheduled')
       RETURNING id,
                 social_account_id,
                 body_text,
                 media,
                 scheduled_at,
                 status,
                 attempts,
                 pgboss_job_id,
                 provider_post_id,
                 last_error`,
      [input.socialAccountId, input.text, JSON.stringify(input.media), input.scheduledAt],
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
      `SELECT id,
              social_account_id,
              body_text,
              media,
              scheduled_at,
              status,
              attempts,
              pgboss_job_id,
              provider_post_id,
              last_error
         FROM scheduled_posts
        WHERE id = $1`,
      [postId],
    );

    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  public async list(limit = 100): Promise<ScheduledPost[]> {
    const result = await this.pool.query<ScheduledPostRow>(
      `SELECT id,
              social_account_id,
              body_text,
              media,
              scheduled_at,
              status,
              attempts,
              pgboss_job_id,
              provider_post_id,
              last_error
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
          AND status IN ('scheduled', 'processing')`,
      [postId],
    );

    return (result.rowCount ?? 0) > 0;
  }

  public async markPublished(postId: string, providerPostId: string): Promise<void> {
    await this.pool.query(
      `UPDATE scheduled_posts
          SET status = 'published',
              provider_post_id = $2,
              published_at = now(),
              last_error = NULL,
              updated_at = now()
        WHERE id = $1`,
      [postId, providerPostId],
    );
  }

  public async markAttemptFailed(
    postId: string,
    error: { name: string; message: string },
    finalFailure: boolean,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE scheduled_posts
          SET status = $2,
              last_error = $3::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [postId, finalFailure ? 'failed' : 'scheduled', JSON.stringify(error)],
    );
  }

  public async markQueueFailure(postId: string, message: string): Promise<void> {
    await this.markAttemptFailed(
      postId,
      { name: 'QueueError', message },
      true,
    );
  }

  public async cancel(postId: string): Promise<ScheduledPost | null> {
    const result = await this.pool.query<ScheduledPostRow>(
      `UPDATE scheduled_posts
          SET status = 'cancelled',
              updated_at = now()
        WHERE id = $1
          AND status = 'scheduled'
      RETURNING id,
                social_account_id,
                body_text,
                media,
                scheduled_at,
                status,
                attempts,
                pgboss_job_id,
                provider_post_id,
                last_error`,
      [postId],
    );

    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }
}
