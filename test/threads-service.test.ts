import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OAuthStateStore } from '../src/oauth/oauth-state-store.js';
import type {
  ThreadsAccountStore,
  ThreadsCredentials,
} from '../src/providers/threads/threads-account-store.js';
import { ThreadsApiError, type ThreadsClient } from '../src/providers/threads/threads-client.js';
import { ThreadsPublicationUncertainError } from '../src/providers/threads/publication-error.js';
import { ThreadsService } from '../src/providers/threads/threads-service.js';
import { decryptSecret, encryptSecret } from '../src/security/token-cipher.js';

const key = Buffer.alloc(32, 1);
const redirectUri = 'https://social.example.com/oauth/threads/callback';

function setup() {
  const credentials: ThreadsCredentials = {
    oauthAccountId: 'oauth-id',
    socialAccountId: 'account-id',
    accessTokenEncrypted: encryptSecret('mock-token', key),
    expiresAt: new Date(Date.now() + 30 * 86400000),
    tokenUpdatedAt: new Date(),
  };
  const accounts = {
    getCredentials: vi.fn().mockResolvedValue(credentials),
    recordPublishedPost: vi.fn().mockResolvedValue(undefined),
    markReauthRequired: vi.fn().mockResolvedValue(undefined),
    updateToken: vi.fn().mockResolvedValue(undefined),
    upsertConnection: vi
      .fn()
      .mockResolvedValue({ socialAccountId: 'account-id', username: 'owner' }),
  };
  const client = {
    getPublishingQuota: vi.fn().mockResolvedValue({ usage: 0, total: 250, durationSeconds: 86400 }),
    publishText: vi.fn().mockResolvedValue({ id: 'post-id' }),
    createImageContainer: vi.fn().mockResolvedValue({ id: 'container-id' }),
    getContainerStatus: vi.fn().mockResolvedValue({ id: 'container-id', status: 'FINISHED' }),
    publishContainer: vi.fn().mockResolvedValue({ id: 'image-post-id' }),
    refreshLongLivedToken: vi
      .fn()
      .mockResolvedValue({ accessToken: 'new-token', expiresIn: 5184000 }),
    exchangeCode: vi.fn().mockResolvedValue({ accessToken: 'short-token', userId: 'subject-id' }),
    exchangeLongLivedToken: vi
      .fn()
      .mockResolvedValue({ accessToken: 'long-token', expiresIn: 5184000 }),
    getProfile: vi.fn().mockResolvedValue({ id: 'subject-id', username: 'owner' }),
  };
  const states = { consume: vi.fn().mockResolvedValue({ redirectUri }) };
  const service = new ThreadsService(
    client as unknown as ThreadsClient,
    accounts as unknown as ThreadsAccountStore,
    states as unknown as OAuthStateStore,
    key,
    redirectUri,
  );
  return { service, client, accounts, credentials, states };
}

beforeEach(() => vi.restoreAllMocks());

describe('ThreadsService', () => {
  it.each([401, 403])(
    'marks quota authentication failures (%i) as requiring reauthorization',
    async (status) => {
      const { service, client, accounts } = setup();
      client.getPublishingQuota.mockRejectedValue(new ThreadsApiError('Invalid token', status));
      await expect(
        service.publish({ socialAccountId: 'account-id', text: 'hello' }),
      ).rejects.toThrow('Invalid token');
      expect(accounts.markReauthRequired).toHaveBeenCalledWith('oauth-id');
      expect(client.publishText).not.toHaveBeenCalled();
    },
  );

  it('refreshes an eligible token and uses the refreshed credential for quota and publishing', async () => {
    const { service, client, accounts, credentials } = setup();
    credentials.expiresAt = new Date(Date.now() + 7 * 86400000);
    credentials.tokenUpdatedAt = new Date(Date.now() - 2 * 86400000);
    await service.publish({ socialAccountId: 'account-id', text: 'hello' });
    expect(client.getPublishingQuota).toHaveBeenCalledWith('new-token', expect.any(AbortSignal));
    const encrypted = accounts.updateToken.mock.calls[0]?.[1] as string;
    expect(decryptSecret(encrypted, key)).toBe('new-token');
  });

  it('does not ignore authentication failure during token refresh', async () => {
    const { service, client, accounts, credentials } = setup();
    credentials.expiresAt = new Date(Date.now() + 7 * 86400000);
    credentials.tokenUpdatedAt = new Date(Date.now() - 2 * 86400000);
    client.refreshLongLivedToken.mockRejectedValue(new ThreadsApiError('Revoked', 401));
    await expect(service.publish({ socialAccountId: 'account-id', text: 'hello' })).rejects.toThrow(
      'Revoked',
    );
    expect(accounts.markReauthRequired).toHaveBeenCalledWith('oauth-id');
    expect(client.getPublishingQuota).not.toHaveBeenCalled();
  });

  it('preserves the remote ID when immediate publication history cannot be written', async () => {
    const { service, accounts, client } = setup();
    accounts.recordPublishedPost.mockRejectedValue(new Error('Database unavailable'));
    await expect(
      service.publish({ socialAccountId: 'account-id', text: 'hello' }),
    ).rejects.toMatchObject({
      name: 'ThreadsPublicationUncertainError',
      providerPostId: 'post-id',
    });
    expect(client.publishText).toHaveBeenCalledTimes(1);
  });

  it('leaves scheduled history persistence to the scheduler', async () => {
    const { service, accounts } = setup();
    await expect(
      service.publish({
        socialAccountId: 'account-id',
        text: 'hello',
        scheduledPostId: 'scheduled-id',
      }),
    ).resolves.toMatchObject({ providerPostId: 'post-id' });
    expect(accounts.recordPublishedPost).not.toHaveBeenCalled();
  });

  it('does not send requests for an already cancelled job', async () => {
    const { service, client, accounts } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.publish({ socialAccountId: 'account-id', text: 'hello', signal: controller.signal }),
    ).rejects.toThrow();
    expect(accounts.getCredentials).not.toHaveBeenCalled();
    expect(client.publishText).not.toHaveBeenCalled();
  });

  it('does not start publication when cancellation arrives during the quota lookup', async () => {
    const { service, client } = setup();
    const controller = new AbortController();
    client.getPublishingQuota.mockImplementation(() => {
      controller.abort();
      return Promise.resolve({ usage: 0, total: 250, durationSeconds: 86400 });
    });
    await expect(
      service.publish({ socialAccountId: 'account-id', text: 'hello', signal: controller.signal }),
    ).rejects.toThrow();
    expect(client.publishText).not.toHaveBeenCalled();
  });

  it('cancels an in-flight image status request and never publishes the container', async () => {
    const { service, client } = setup();
    const controller = new AbortController();
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    client.getContainerStatus.mockImplementation((_token, _id, signal: AbortSignal) => {
      notifyStarted();
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    });
    const result = service.publish({
      socialAccountId: 'account-id',
      image: { url: 'https://example.com/image.png' },
      signal: controller.signal,
    });
    const assertion = expect(result).rejects.toThrow();
    await started;
    controller.abort();
    await assertion;
    expect(client.publishContainer).not.toHaveBeenCalled();
  });

  it('persists image metadata after successful publication', async () => {
    const { service, accounts } = setup();
    await service.publish({
      socialAccountId: 'account-id',
      image: { url: 'https://example.com/image.png', altText: 'demo' },
    });
    expect(accounts.recordPublishedPost).toHaveBeenCalledWith(
      expect.objectContaining({
        providerPostId: 'image-post-id',
        media: [{ type: 'image', url: 'https://example.com/image.png', altText: 'demo' }],
      }),
    );
  });

  it('rejects callback redirect mismatches before exchanging credentials', async () => {
    const { service, states, client } = setup();
    states.consume.mockResolvedValue({ redirectUri: 'https://unexpected.example/callback' });
    await expect(service.completeAuthorization('code', 'state')).rejects.toThrow('redirect URI');
    expect(client.exchangeCode).not.toHaveBeenCalled();
  });

  it('never exchanges a code when OAuth state validation fails', async () => {
    const { service, states, client } = setup();
    states.consume.mockRejectedValue(new Error('Invalid state'));
    await expect(service.completeAuthorization('code', 'state')).rejects.toThrow('Invalid state');
    expect(client.exchangeCode).not.toHaveBeenCalled();
  });

  it('stores encrypted credentials after a valid callback', async () => {
    const { service, accounts } = setup();
    await service.completeAuthorization('code', 'state');
    const input = accounts.upsertConnection.mock.calls[0]?.[0] as { encryptedAccessToken: string };
    expect(decryptSecret(input.encryptedAccessToken, key)).toBe('long-token');
  });

  it('preserves uncertain provider outcomes without another publishing attempt', async () => {
    const { service, client } = setup();
    client.publishText.mockRejectedValue(new ThreadsPublicationUncertainError());
    await expect(
      service.publish({ socialAccountId: 'account-id', text: 'hello' }),
    ).rejects.toBeInstanceOf(ThreadsPublicationUncertainError);
    expect(client.publishText).toHaveBeenCalledTimes(1);
  });
});
