import type { Pool, PoolClient } from 'pg';

import type { SocialAccount, SocialAccountStatus, SocialProvider } from '../domain/social-account.js';

interface SocialAccountRow {
  id: string;
  provider: SocialProvider;
  provider_account_id: string;
  account_name: string;
  account_type: string | null;
  status: SocialAccountStatus;
}

interface DisconnectRow {
  id: string;
  oauth_account_id: string;
  provider: SocialProvider;
  account_name: string;
}

export interface DisconnectResult {
  accountId: string;
  provider: SocialProvider;
  accountName: string;
  cancelledScheduledPosts: number;
  credentialPurged: boolean;
  remainingActiveAccountsOnCredential: number;
}

export interface SocialAccountStore {
  list(includeInactive?: boolean): Promise<SocialAccount[]>;
  disconnect(accountId: string): Promise<DisconnectResult | null>;
}

export class PostgresSocialAccountStore implements SocialAccountStore {
  public constructor(private readonly pool: Pool) {}

  public async list(includeInactive = false): Promise<SocialAccount[]> {
    const result = await this.pool.query<SocialAccountRow>(
      `SELECT id, provider, provider_account_id, account_name, account_type, status
         FROM social_accounts
        WHERE ($1::boolean = true OR status = 'active')
        ORDER BY provider, account_name`,
      [includeInactive],
    );

    return result.rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      providerAccountId: row.provider_account_id,
      accountName: row.account_name,
      accountType: row.account_type,
      status: row.status,
    }));
  }

  public async disconnect(accountId: string): Promise<DisconnectResult | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const targetResult = await client.query<DisconnectRow>(
        `SELECT id, oauth_account_id, provider, account_name
           FROM social_accounts
          WHERE id = $1
          FOR UPDATE`,
        [accountId],
      );
      const target = targetResult.rows[0];

      if (!target) {
        await client.query('ROLLBACK');
        return null;
      }

      const cancelled = await client.query(
        `UPDATE scheduled_posts
            SET status = 'cancelled',
                updated_at = now()
          WHERE social_account_id = $1
            AND status = 'scheduled'`,
        [accountId],
      );

      await client.query(
        `UPDATE social_accounts
            SET status = 'disabled',
                updated_at = now()
          WHERE id = $1`,
        [accountId],
      );

      const remainingResult = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM social_accounts
          WHERE oauth_account_id = $1
            AND id <> $2
            AND status = 'active'`,
        [target.oauth_account_id, accountId],
      );
      const remainingActiveAccounts = Number.parseInt(remainingResult.rows[0]?.count ?? '0', 10);
      const credentialPurged = remainingActiveAccounts === 0;

      if (credentialPurged) {
        await this.purgeCredential(client, target.oauth_account_id);
      }

      await client.query('COMMIT');

      return {
        accountId: target.id,
        provider: target.provider,
        accountName: target.account_name,
        cancelledScheduledPosts: cancelled.rowCount ?? 0,
        credentialPurged,
        remainingActiveAccountsOnCredential: remainingActiveAccounts,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async purgeCredential(client: PoolClient, oauthAccountId: string): Promise<void> {
    await client.query(
      `UPDATE oauth_accounts
          SET access_token_encrypted = NULL,
              refresh_token_encrypted = NULL,
              expires_at = NULL,
              status = 'revoked',
              disconnected_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [oauthAccountId],
    );
  }
}
