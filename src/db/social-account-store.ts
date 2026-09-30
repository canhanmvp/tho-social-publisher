import type { Pool } from 'pg';
import type { SocialAccount, SocialAccountStatus, SocialProvider } from '../domain/social-account.js';

interface SocialAccountRow {
  id: string;
  provider: SocialProvider;
  provider_account_id: string;
  account_name: string;
  account_type: string | null;
  status: SocialAccountStatus;
}

export interface SocialAccountStore {
  list(): Promise<SocialAccount[]>;
}

export class PostgresSocialAccountStore implements SocialAccountStore {
  public constructor(private readonly pool: Pool) {}

  public async list(): Promise<SocialAccount[]> {
    const result = await this.pool.query<SocialAccountRow>(
      `SELECT id, provider, provider_account_id, account_name, account_type, status
         FROM social_accounts
        ORDER BY provider, account_name`,
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
}
