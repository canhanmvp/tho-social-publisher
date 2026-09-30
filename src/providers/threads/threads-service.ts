import type { Buffer } from 'node:buffer';

import type { OAuthStateStore } from '../../oauth/oauth-state-store.js';
import { decryptSecret, encryptSecret } from '../../security/token-cipher.js';
import type { ThreadsAccountStore } from './threads-account-store.js';
import { ThreadsApiError, ThreadsClient } from './threads-client.js';

const REFRESH_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_REFRESH_AGE_MS = 24 * 60 * 60 * 1000;

export class ThreadsService {
  public constructor(
    private readonly client: ThreadsClient,
    private readonly accounts: ThreadsAccountStore,
    private readonly oauthStates: OAuthStateStore,
    private readonly encryptionKey: Buffer,
    private readonly redirectUri: string,
  ) {}

  public async createAuthorizationUrl(): Promise<string> {
    const state = await this.oauthStates.create('threads', this.redirectUri);
    return this.client.buildAuthorizationUrl(state);
  }

  public async completeAuthorization(
    code: string,
    state: string,
  ): Promise<{ socialAccountId: string; username: string }> {
    const oauthState = await this.oauthStates.consume('threads', state);

    if (oauthState.redirectUri !== this.redirectUri) {
      throw new Error('Threads OAuth redirect URI did not match the stored authorization request.');
    }

    const shortLived = await this.client.exchangeCode(code);
    const longLived = await this.client.exchangeLongLivedToken(shortLived.accessToken);
    const profile = await this.client.getProfile(longLived.accessToken);

    if (profile.id !== shortLived.userId) {
      throw new Error('Threads OAuth user ID did not match the authenticated profile.');
    }

    const expiresAt = new Date(Date.now() + longLived.expiresIn * 1000);
    const encryptedAccessToken = encryptSecret(longLived.accessToken, this.encryptionKey);

    return this.accounts.upsertConnection({
      profile,
      encryptedAccessToken,
      expiresAt,
      scopes: ThreadsClient.publishingScopes,
    });
  }

  public async publishText(input: {
    socialAccountId: string;
    text: string;
    replyToId?: string;
  }): Promise<{ providerPostId: string; socialAccountId: string }> {
    const credentials = await this.accounts.getCredentials(input.socialAccountId);

    if (!credentials) {
      throw new Error('No active Threads connection exists for this social account.');
    }

    if (credentials.expiresAt && credentials.expiresAt.getTime() <= Date.now()) {
      await this.accounts.markReauthRequired(credentials.oauthAccountId);
      throw new Error('The Threads access token has expired. Reconnect the account.');
    }

    let accessToken = decryptSecret(credentials.accessTokenEncrypted, this.encryptionKey);

    if (this.shouldRefresh(credentials.expiresAt, credentials.tokenUpdatedAt)) {
      try {
        const refreshed = await this.client.refreshLongLivedToken(accessToken);
        const expiresAt = new Date(Date.now() + refreshed.expiresIn * 1000);
        const encrypted = encryptSecret(refreshed.accessToken, this.encryptionKey);

        await this.accounts.updateToken(credentials.oauthAccountId, encrypted, expiresAt);
        accessToken = refreshed.accessToken;
      } catch (error) {
        if (credentials.expiresAt && credentials.expiresAt.getTime() <= Date.now() + 24 * 60 * 60 * 1000) {
          throw error;
        }
      }
    }

    try {
      const published = await this.client.publishText(accessToken, input.text, input.replyToId);

      await this.accounts.recordPublishedText({
        socialAccountId: input.socialAccountId,
        providerPostId: published.id,
        text: input.text,
      });

      return {
        providerPostId: published.id,
        socialAccountId: input.socialAccountId,
      };
    } catch (error) {
      if (error instanceof ThreadsApiError && (error.status === 401 || error.status === 403)) {
        await this.accounts.markReauthRequired(credentials.oauthAccountId);
      }

      throw error;
    }
  }

  private shouldRefresh(expiresAt: Date | null, tokenUpdatedAt: Date): boolean {
    if (!expiresAt) {
      return false;
    }

    const now = Date.now();
    const remaining = expiresAt.getTime() - now;
    const age = now - tokenUpdatedAt.getTime();

    return remaining <= REFRESH_THRESHOLD_MS && age >= MIN_REFRESH_AGE_MS;
  }
}
