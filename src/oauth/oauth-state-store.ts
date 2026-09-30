import { createHash, randomBytes } from 'node:crypto';

import type { Pool } from 'pg';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class OAuthStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OAuthStateError';
  }
}

export function hashOAuthState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

export class OAuthStateStore {
  public constructor(
    private readonly pool: Pool,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  public async create(provider: string, redirectUri: string): Promise<string> {
    const rawState = randomBytes(32).toString('base64url');
    const stateHash = hashOAuthState(rawState);
    const expiresAt = new Date(Date.now() + this.ttlMs);

    await this.pool.query(
      `INSERT INTO oauth_states (provider, state_hash, redirect_uri, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [provider, stateHash, redirectUri, expiresAt],
    );

    return rawState;
  }

  public async consume(provider: string, rawState: string): Promise<{ redirectUri: string }> {
    const stateHash = hashOAuthState(rawState);

    const result = await this.pool.query<{ redirect_uri: string }>(
      `UPDATE oauth_states
          SET consumed_at = now()
        WHERE provider = $1
          AND state_hash = $2
          AND consumed_at IS NULL
          AND expires_at > now()
      RETURNING redirect_uri`,
      [provider, stateHash],
    );

    const row = result.rows[0];

    if (!row) {
      throw new OAuthStateError('OAuth state is invalid, expired, or already used.');
    }

    return { redirectUri: row.redirect_uri };
  }
}
