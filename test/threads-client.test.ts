import { describe, expect, it, vi } from 'vitest';

import { ThreadsClient } from '../src/providers/threads/threads-client.js';
import { ThreadsPublicationUncertainError } from '../src/providers/threads/publication-error.js';

const config = {
  clientId: '123456',
  clientSecret: 'top-secret',
  redirectUri: 'https://social.example.com/oauth/threads/callback',
};

describe('ThreadsClient', () => {
  it('builds the official Threads authorization URL with minimal publishing scopes', () => {
    const client = new ThreadsClient(config);
    const url = new URL(client.buildAuthorizationUrl('csrf-state'));

    expect(url.origin + url.pathname).toBe('https://threads.net/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('123456');
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('scope')).toBe('threads_basic,threads_content_publish');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('csrf-state');
  });

  it('exchanges an OAuth code and preserves the exact redirect URI', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'short-token', user_id: '42' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new ThreadsClient(config, fetchFn);

    await expect(client.exchangeCode('oauth-code')).resolves.toEqual({
      accessToken: 'short-token',
      userId: '42',
    });

    const [requestUrl, init] = fetchFn.mock.calls[0]!;
    const url = new URL(String(requestUrl));

    expect(init?.method).toBe('POST');
    expect(url.origin + url.pathname).toBe('https://graph.threads.net/oauth/access_token');
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('client_secret')).toBe(config.clientSecret);
  });

  it('exchanges a short-lived token for a long-lived token', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'long-token',
          token_type: 'bearer',
          expires_in: 5_183_944,
        }),
        { status: 200 },
      ),
    );
    const client = new ThreadsClient(config, fetchFn);

    await expect(client.exchangeLongLivedToken('short-token')).resolves.toEqual({
      accessToken: 'long-token',
      expiresIn: 5_183_944,
    });
  });

  it('fetches the authenticated Threads profile with bearer auth', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: '42', username: 'mvp', name: 'MVP' }), { status: 200 }),
      );
    const client = new ThreadsClient(config, fetchFn);

    await expect(client.getProfile('long-token')).resolves.toMatchObject({
      id: '42',
      username: 'mvp',
    });

    const [, init] = fetchFn.mock.calls[0]!;
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer long-token');
  });

  it('publishes text with auto_publish_text', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'post-123' }), { status: 200 }));
    const client = new ThreadsClient(config, fetchFn);

    await expect(client.publishText('token', 'hello Threads')).resolves.toEqual({
      id: 'post-123',
    });

    const [requestUrl, init] = fetchFn.mock.calls[0]!;
    const url = new URL(String(requestUrl));

    expect(init?.method).toBe('POST');
    expect(url.origin + url.pathname).toBe('https://graph.threads.net/me/threads');
    expect(url.searchParams.get('media_type')).toBe('TEXT');
    expect(url.searchParams.get('auto_publish_text')).toBe('true');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token');
  });

  it('creates an image container and publishes it separately', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'container-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'post-2' }), { status: 200 }));
    const client = new ThreadsClient(config, fetchFn);

    await expect(
      client.createImageContainer('token', {
        imageUrl: 'https://cdn.example.com/image.png',
        text: 'caption',
        altText: 'demo',
      }),
    ).resolves.toEqual({ id: 'container-1' });

    await expect(client.publishContainer('token', 'container-1')).resolves.toEqual({
      id: 'post-2',
    });

    const createUrl = new URL(String(fetchFn.mock.calls[0]![0]));
    const publishUrl = new URL(String(fetchFn.mock.calls[1]![0]));

    expect(createUrl.searchParams.get('media_type')).toBe('IMAGE');
    expect(createUrl.searchParams.get('image_url')).toBe('https://cdn.example.com/image.png');
    expect(publishUrl.pathname).toBe('/me/threads_publish');
    expect(publishUrl.searchParams.get('creation_id')).toBe('container-1');
  });

  it('reads the dynamic publishing quota instead of hardcoding a limit', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              quota_usage: 3,
              config: {
                quota_total: 250,
                quota_duration: 86400,
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const client = new ThreadsClient(config, fetchFn);

    await expect(client.getPublishingQuota('token')).resolves.toEqual({
      usage: 3,
      total: 250,
      durationSeconds: 86400,
    });

    const url = new URL(String(fetchFn.mock.calls[0]![0]));
    expect(url.pathname).toBe('/me/threads_publishing_limit');
    expect(url.searchParams.get('fields')).toBe('quota_usage,config');
  });

  it('surfaces provider errors without exposing request credentials', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: 'Invalid OAuth access token.', code: 190 } }),
        {
          status: 401,
        },
      ),
    );
    const client = new ThreadsClient(config, fetchFn);

    await expect(client.getProfile('secret-token')).rejects.toMatchObject({
      status: 401,
      providerCode: 190,
    });

    await expect(client.getProfile('secret-token')).rejects.not.toThrow('secret-token');
  });

  it('passes a deadline signal to every provider request', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ id: '42', username: 'owner' })));
    await new ThreadsClient(config, fetchFn).getProfile('token');
    expect(fetchFn.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts an in-flight publishing request when the worker is cancelled', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init!.signal!;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const result = new ThreadsClient(config, fetchFn).publishText(
      'token',
      'hello',
      controller.signal,
    );
    const assertion = expect(result).rejects.toBeInstanceOf(ThreadsPublicationUncertainError);
    controller.abort();
    await assertion;
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('does not send a publishing request after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      new ThreadsClient(config, fetchFn).publishText('token', 'hello', controller.signal),
    ).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('enforces the provider deadline on a hanging request', async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    try {
      const fetchFn = vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
              once: true,
            });
          }),
      );
      const result = new ThreadsClient(config, fetchFn).publishText('token', 'hello');
      const assertion = expect(result).rejects.toBeInstanceOf(ThreadsPublicationUncertainError);
      expect(timeout).toHaveBeenCalledWith(15_000);
      deadline.abort(new DOMException('Deadline exceeded', 'TimeoutError'));
      await assertion;
    } finally {
      timeout.mockRestore();
    }
  });

  it.each([
    new Response('invalid json', { status: 200 }),
    new Response(JSON.stringify({ error: { message: 'Unavailable' } }), { status: 503 }),
  ])('treats ambiguous publishing responses as unsafe to retry', async (response) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(
      new ThreadsClient(config, fetchFn).publishText('token', 'hello'),
    ).rejects.toBeInstanceOf(ThreadsPublicationUncertainError);
  });

  it('keeps a confirmed 429 rejection retryable', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Rate limited', code: 4 } }), {
        status: 429,
      }),
    );
    await expect(
      new ThreadsClient(config, fetchFn).publishText('token', 'hello'),
    ).rejects.toMatchObject({ name: 'ThreadsApiError', status: 429 });
  });
});
