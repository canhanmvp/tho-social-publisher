import type { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';

import type { OAuthStateStore } from '../../oauth/oauth-state-store.js';
import { decryptSecret, encryptSecret } from '../../security/token-cipher.js';
import type {
  PublishedMedia,
  ThreadsAccountStore,
  ThreadsCredentials,
} from './threads-account-store.js';
import { ThreadsApiError, ThreadsClient } from './threads-client.js';
import { ThreadsPublicationUncertainError } from './publication-error.js';

const REFRESH_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_REFRESH_AGE_MS = 24 * 60 * 60 * 1000;
const IMAGE_READY_TIMEOUT_MS = 35_000;
const IMAGE_POLL_INTERVAL_MS = 5_000;
const PUBLISH_TIMEOUT_MS = 120_000;

export interface ThreadsPublishInput {
  socialAccountId: string;
  text?: string;
  image?: {
    url: string;
    altText?: string;
  };
  contentFingerprint?: string;
  scheduledPostId?: string;
  signal?: AbortSignal;
}

export interface ThreadsPublishResult {
  providerPostId: string;
  socialAccountId: string;
  quota: {
    usageBeforePublish: number;
    total: number;
    durationSeconds: number;
  };
}

export class ThreadsQuotaError extends Error {
  public constructor(
    public readonly usage: number,
    public readonly total: number,
    public readonly durationSeconds: number,
  ) {
    super(`Threads publishing quota exhausted (${usage}/${total}).`);
    this.name = 'ThreadsQuotaError';
  }
}

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

  public async publish(input: ThreadsPublishInput): Promise<ThreadsPublishResult> {
    if (!input.text?.trim() && !input.image) {
      throw new Error('A Threads post requires text or an image.');
    }

    const timeout = AbortSignal.timeout(PUBLISH_TIMEOUT_MS);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let credentials: ThreadsCredentials | undefined;
    try {
      signal.throwIfAborted();
      const connection = await this.getUsableAccessToken(input.socialAccountId, signal);
      credentials = connection.credentials;
      const accessToken = connection.accessToken;
      const quota = await this.client.getPublishingQuota(accessToken, signal);

      if (quota.usage >= quota.total) {
        throw new ThreadsQuotaError(quota.usage, quota.total, quota.durationSeconds);
      }
      signal.throwIfAborted();

      const published = input.image
        ? await this.publishImage(accessToken, input, signal)
        : await this.client.publishText(accessToken, input.text!, signal);

      const media: PublishedMedia[] | undefined = input.image
        ? [
            {
              type: 'image',
              url: input.image.url,
              ...(input.image.altText ? { altText: input.image.altText } : {}),
            },
          ]
        : undefined;

      // The scheduler saves history and its published state atomically. An
      // immediate post must preserve an uncertain outcome if that write fails.
      if (!input.scheduledPostId) {
        try {
          await this.accounts.recordPublishedPost({
            socialAccountId: input.socialAccountId,
            providerPostId: published.id,
            text: input.text ?? '',
            ...(input.contentFingerprint ? { contentFingerprint: input.contentFingerprint } : {}),
            ...(media ? { media } : {}),
          });
        } catch {
          throw new ThreadsPublicationUncertainError(published.id);
        }
      }

      return {
        providerPostId: published.id,
        socialAccountId: input.socialAccountId,
        quota: {
          usageBeforePublish: quota.usage,
          total: quota.total,
          durationSeconds: quota.durationSeconds,
        },
      };
    } catch (error) {
      if (error instanceof ThreadsApiError && (error.status === 401 || error.status === 403)) {
        if (credentials) {
          await this.accounts.markReauthRequired(credentials.oauthAccountId);
        }
      }

      throw error;
    }
  }

  private async publishImage(
    accessToken: string,
    input: ThreadsPublishInput,
    signal: AbortSignal,
  ): Promise<{ id: string }> {
    if (!input.image) {
      throw new Error('Image payload is missing.');
    }

    const container = await this.client.createImageContainer(
      accessToken,
      {
        imageUrl: input.image.url,
        ...(input.text ? { text: input.text } : {}),
        ...(input.image.altText ? { altText: input.image.altText } : {}),
      },
      signal,
    );

    const deadline = Date.now() + IMAGE_READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const status = await this.client.getContainerStatus(accessToken, container.id, signal);

      if (status.status === 'FINISHED') {
        return this.client.publishContainer(accessToken, container.id, signal);
      }

      if (status.status === 'PUBLISHED') {
        return { id: status.id };
      }

      if (status.status === 'ERROR' || status.status === 'EXPIRED') {
        throw new Error(
          `Threads image container ${status.status.toLowerCase()}: ${status.error_message ?? 'no provider error message'}`,
        );
      }

      await delay(IMAGE_POLL_INTERVAL_MS, undefined, { signal });
    }

    throw new Error(
      'Threads image container was not ready within 35 seconds. Retry later instead of polling aggressively.',
    );
  }

  private async getUsableAccessToken(
    socialAccountId: string,
    signal: AbortSignal,
  ): Promise<{ credentials: ThreadsCredentials; accessToken: string }> {
    const credentials = await this.accounts.getCredentials(socialAccountId);
    signal.throwIfAborted();

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
        const refreshed = await this.client.refreshLongLivedToken(accessToken, signal);
        const expiresAt = new Date(Date.now() + refreshed.expiresIn * 1000);
        const encrypted = encryptSecret(refreshed.accessToken, this.encryptionKey);

        await this.accounts.updateToken(credentials.oauthAccountId, encrypted, expiresAt);
        accessToken = refreshed.accessToken;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ThreadsApiError && (error.status === 401 || error.status === 403)) {
          await this.accounts.markReauthRequired(credentials.oauthAccountId);
          throw error;
        }
        if (
          credentials.expiresAt &&
          credentials.expiresAt.getTime() <= Date.now() + 24 * 60 * 60 * 1000
        ) {
          throw error;
        }
      }
    }

    return { credentials, accessToken };
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
