import type { Pool, PoolClient } from 'pg';

import type { ThreadsProfile } from './threads-client.js';

export interface ThreadsCredentials {
  oauthAccountId: string;
  socialAccountId: string;
  accessTokenEncrypted: string;
  expiresAt: Date | null;
  tokenUpdatedAt: Date;
}

export interface SavedThreadsAccount {
  socialAccountId: string;
  username: string;
}

export interface PublishedMedia {
  type: 'image';
  url: string;
  altText?: string;
}

export class ThreadsAccountStore {
  public constructor(private readonly pool: Pool) {}

  public async upsertConnection(input: {
    profile: ThreadsProfile;
    encryptedAccessToken: string;
    expiresAt: Date;
    scopes: readonly string[];
  }): Promise<SavedThreadsAccount> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const oauthAccountId = await this.upsertOAuthAccount(client, input);
      const socialAccountId = await this.upsertSocialAccount(client, oauthAccountId, input.profile);

      await client.query('COMMIT');

      return {
        socialAccountId,
        username: input.profile.username,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async getCredentials(socialAccountId: string): Promise<ThreadsCredentials | null> {
    const result = await this.pool.query<{
      oauth_account_id: string;
      social_account_id: string;
      access_token_encrypted: string;
      expires_at: Date | null;
      token_updated_at: Date;
    }>(
      `SELECT oa.id AS oauth_account_id,
              sa.id AS social_account_id,
              oa.access_token_encrypted,
              oa.expires_at,
              oa.updated_at AS token_updated_at
         FROM social_accounts sa
         JOIN oauth_accounts oa ON oa.id = sa.oauth_account_id
        WHERE sa.id = $1
          AND sa.provider = 'threads'
          AND oa.provider = 'threads'
          AND sa.status = 'active'
          AND oa.status = 'active'
          AND oa.access_token_encrypted IS NOT NULL`,
      [socialAccountId],
    );

    const row = result.rows[0];

    return row
      ? {
          oauthAccountId: row.oauth_account_id,
          socialAccountId: row.social_account_id,
          accessTokenEncrypted: row.access_token_encrypted,
          expiresAt: row.expires_at,
          tokenUpdatedAt: row.token_updated_at,
        }
      : null;
  }

  public async updateToken(
    oauthAccountId: string,
    encryptedAccessToken: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE oauth_accounts
          SET access_token_encrypted = $2,
              expires_at = $3,
              status = 'active',
              disconnected_at = NULL,
              updated_at = now()
        WHERE id = $1
          AND provider = 'threads'`,
      [oauthAccountId, encryptedAccessToken, expiresAt],
    );
  }

  public async markReauthRequired(oauthAccountId: string): Promise<void> {
    await this.pool.query(
      `UPDATE oauth_accounts
          SET status = 'reauth_required',
              updated_at = now()
        WHERE id = $1
          AND provider = 'threads'`,
      [oauthAccountId],
    );

    await this.pool.query(
      `UPDATE social_accounts
          SET status = 'reauth_required',
              updated_at = now()
        WHERE oauth_account_id = $1
          AND provider = 'threads'`,
      [oauthAccountId],
    );
  }

  public async recordPublishedPost(input: {
    socialAccountId: string;
    providerPostId: string;
    text: string;
    contentFingerprint?: string;
    media?: PublishedMedia[];
    scheduledPostId?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO published_posts (
          social_account_id,
          scheduled_post_id,
          provider_post_id,
          body_text,
          media,
          content_fingerprint
        )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (provider_post_id, social_account_id) DO NOTHING`,
      [
        input.socialAccountId,
        input.scheduledPostId ?? null,
        input.providerPostId,
        input.text,
        JSON.stringify(input.media ?? []),
        input.contentFingerprint ?? null,
      ],
    );
  }

  private async upsertOAuthAccount(
    client: PoolClient,
    input: {
      profile: ThreadsProfile;
      encryptedAccessToken: string;
      expiresAt: Date;
      scopes: readonly string[];
    },
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO oauth_accounts (
          provider,
          provider_subject_id,
          account_name,
          access_token_encrypted,
          expires_at,
          scopes,
          status
        )
       VALUES ('threads', $1, $2, $3, $4, $5, 'active')
       ON CONFLICT (provider, provider_subject_id)
       DO UPDATE SET
          account_name = EXCLUDED.account_name,
          access_token_encrypted = EXCLUDED.access_token_encrypted,
          refresh_token_encrypted = NULL,
          expires_at = EXCLUDED.expires_at,
          scopes = EXCLUDED.scopes,
          status = 'active',
          disconnected_at = NULL,
          updated_at = now()
       RETURNING id`,
      [
        input.profile.id,
        input.profile.username,
        input.encryptedAccessToken,
        input.expiresAt,
        [...input.scopes],
      ],
    );

    const id = result.rows[0]?.id;

    if (!id) {
      throw new Error('Failed to persist Threads OAuth account.');
    }

    return id;
  }

  private async upsertSocialAccount(
    client: PoolClient,
    oauthAccountId: string,
    profile: ThreadsProfile,
  ): Promise<string> {
    const metadata = JSON.stringify({
      display_name: profile.name ?? null,
      profile_picture_url: profile.threads_profile_picture_url ?? null,
    });

    const result = await client.query<{ id: string }>(
      `INSERT INTO social_accounts (
          oauth_account_id,
          provider,
          provider_account_id,
          account_name,
          account_type,
          status,
          metadata
        )
       VALUES ($1, 'threads', $2, $3, 'threads_profile', 'active', $4::jsonb)
       ON CONFLICT (provider, provider_account_id)
       DO UPDATE SET
          oauth_account_id = EXCLUDED.oauth_account_id,
          account_name = EXCLUDED.account_name,
          account_type = EXCLUDED.account_type,
          status = 'active',
          metadata = EXCLUDED.metadata,
          updated_at = now()
       RETURNING id`,
      [oauthAccountId, profile.id, profile.username, metadata],
    );

    const id = result.rows[0]?.id;

    if (!id) {
      throw new Error('Failed to persist Threads social account.');
    }

    return id;
  }
}
