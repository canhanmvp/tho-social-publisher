import type { Buffer } from 'node:buffer';

import type { OAuthStateStore } from '../../oauth/oauth-state-store.js';
import { decryptSecret, encryptSecret } from '../../security/token-cipher.js';
import type {
  PublishedMedia,
  ThreadsAccountStore,
  ThreadsCredentials,
} from './threads-account-store.js';
import { ThreadsApiError, ThreadsClient } from './threads-client.js';

const REFRESH_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_REFRESH_AGE_MS = 24 * 60 * 60 * 1000;
const MEDIA_READY_TIMEOUT_MS = 60_000;
const MEDIA_POLL_INTERVAL_MS = 5_000;
const MAX_CAROUSEL_ITEMS = 20;

export interface ThreadsMedia {
  type: 'image' | 'video';
  url: string;
  altText?: string;
}

export interface ThreadsPublishInput {
  socialAccountId: string;
  text?: string;
  media?: ThreadsMedia[];
  contentFingerprint?: string;
  scheduledPostId?: string;
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    const media = input.media ?? [];

    if (!input.text?.trim() && media.length === 0) {
      throw new Error('A Threads post requires text or media.');
    }

    if (media.length > MAX_CAROUSEL_ITEMS) {
      throw new Error(`Threads accepts at most ${MAX_CAROUSEL_ITEMS} carousel items.`);
    }

    const { credentials, accessToken } = await this.getUsableAccessToken(input.socialAccountId);
    const quota = await this.client.getPublishingQuota(accessToken);

    if (quota.usage >= quota.total) {
      throw new ThreadsQuotaError(quota.usage, quota.total, quota.durationSeconds);
    }

    try {
      let published: { id: string };

      if (media.length === 0) {
        published = await this.client.publishText(accessToken, input.text!);
      } else if (media.length === 1) {
        published = await this.publishSingleMedia(accessToken, media[0]!, input.text);
      } else {
        published = await this.publishCarousel(accessToken, media, input.text);
      }

      const persistedMedia: PublishedMedia[] = media.map((item) => ({
        type: item.type,
        url: item.url,
        ...(item.altText ? { altText: item.altText } : {}),
      }));

      await this.accounts.recordPublishedPost({
        socialAccountId: input.socialAccountId,
        providerPostId: published.id,
        text: input.text ?? '',
        ...(input.contentFingerprint ? { contentFingerprint: input.contentFingerprint } : {}),
        ...(persistedMedia.length > 0 ? { media: persistedMedia } : {}),
        ...(input.scheduledPostId ? { scheduledPostId: input.scheduledPostId } : {}),
      });

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
        await this.accounts.markReauthRequired(credentials.oauthAccountId);
      }

      throw error;
    }
  }

  private async publishSingleMedia(
    accessToken: string,
    media: ThreadsMedia,
    text?: string,
  ): Promise<{ id: string }> {
    const container = await this.client.createMediaContainer(accessToken, {
      type: media.type,
      url: media.url,
      ...(text ? { text } : {}),
      ...(media.altText ? { altText: media.altText } : {}),
    });

    await this.waitUntilReady(accessToken, [container.id]);
    return this.client.publishContainer(accessToken, container.id);
  }

  private async publishCarousel(
    accessToken: string,
    media: ThreadsMedia[],
    text?: string,
  ): Promise<{ id: string }> {
    if (media.length < 2 || media.length > MAX_CAROUSEL_ITEMS) {
      throw new Error('Threads carousels require between 2 and 20 media items.');
    }

    const childIds: string[] = [];

    for (const item of media) {
      const child = await this.client.createMediaContainer(accessToken, {
        type: item.type,
        url: item.url,
        isCarouselItem: true,
        ...(item.altText ? { altText: item.altText } : {}),
      });
      childIds.push(child.id);
    }

    await this.waitUntilReady(accessToken, childIds);

    const carousel = await this.client.createCarouselContainer(accessToken, {
      children: childIds,
      ...(text ? { text } : {}),
    });

    await this.waitUntilReady(accessToken, [carousel.id]);
    return this.client.publishContainer(accessToken, carousel.id);
  }

  private async waitUntilReady(accessToken: string, containerIds: string[]): Promise<void> {
    const pending = new Set(containerIds);
    const deadline = Date.now() + MEDIA_READY_TIMEOUT_MS;

    while (pending.size > 0 && Date.now() < deadline) {
      for (const containerId of [...pending]) {
        const status = await this.client.getContainerStatus(accessToken, containerId);

        if (status.status === 'FINISHED' || status.status === 'PUBLISHED') {
          pending.delete(containerId);
          continue;
        }

        if (status.status === 'ERROR' || status.status === 'EXPIRED') {
          throw new Error(
            `Threads media container ${containerId} ${status.status.toLowerCase()}: ${status.error_message ?? 'no provider error message'}`,
          );
        }
      }

      if (pending.size > 0) {
        await delay(MEDIA_POLL_INTERVAL_MS);
      }
    }

    if (pending.size > 0) {
      throw new Error(
        `Threads media processing did not finish within 60 seconds for ${pending.size} container(s). Retry later rather than polling aggressively.`,
      );
    }
  }

  private async getUsableAccessToken(
    socialAccountId: string,
  ): Promise<{ credentials: ThreadsCredentials; accessToken: string }> {
    const credentials = await this.accounts.getCredentials(socialAccountId);

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
