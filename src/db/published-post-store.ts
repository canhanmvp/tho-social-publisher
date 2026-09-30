import type { Pool } from 'pg';

import type { SocialProvider } from '../domain/social-account.js';

export interface PublishedPost {
  id: string;
  provider: SocialProvider;
  socialAccountId: string;
  accountName: string;
  providerPostId: string;
  text: string;
  media: unknown[];
  scheduledPostId: string | null;
  publishedAt: Date;
}

interface PublishedPostRow {
  id: string;
  provider: SocialProvider;
  social_account_id: string;
  account_name: string;
  provider_post_id: string;
  body_text: string;
  media: unknown[];
  scheduled_post_id: string | null;
  published_at: Date;
}

function mapRow(row: PublishedPostRow): PublishedPost {
  return {
    id: row.id,
    provider: row.provider,
    socialAccountId: row.social_account_id,
    accountName: row.account_name,
    providerPostId: row.provider_post_id,
    text: row.body_text,
    media: row.media,
    scheduledPostId: row.scheduled_post_id,
    publishedAt: row.published_at,
  };
}

export class PublishedPostStore {
  public constructor(private readonly pool: Pool) {}

  public async listRecent(input: {
    limit: number;
    accountId?: string;
    provider?: SocialProvider;
  }): Promise<PublishedPost[]> {
    const result = await this.pool.query<PublishedPostRow>(
      `SELECT pp.id,
              sa.provider,
              pp.social_account_id,
              sa.account_name,
              pp.provider_post_id,
              pp.body_text,
              pp.media,
              pp.scheduled_post_id,
              pp.published_at
         FROM published_posts pp
         JOIN social_accounts sa ON sa.id = pp.social_account_id
        WHERE ($2::uuid IS NULL OR pp.social_account_id = $2)
          AND ($3::text IS NULL OR sa.provider = $3)
        ORDER BY pp.published_at DESC
        LIMIT $1`,
      [input.limit, input.accountId ?? null, input.provider ?? null],
    );

    return result.rows.map(mapRow);
  }
}
