import { describe, expect, it, vi } from 'vitest';

import { ThreadsApiError, ThreadsClient } from '../src/providers/threads/threads-client.js';

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

    const [requestUrl] = fetchFn.mock.calls[0]!;
    const url = new URL(String(requestUrl));

    expect(url.origin + url.pathname).toBe('https://graph.threads.net/access_token');
    expect(url.searchParams.get('grant_type')).toBe('th_exchange_token');
    expect(url.searchParams.get('access_token')).toBe('short-token');
  });

  it('fetches the authenticated Threads profile with bearer auth', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
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

  it('publishes text with auto_publish_text and optional reply_to_id', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'post-123' }), { status: 200 }),
    );
    const client = new ThreadsClient(config, fetchFn);

    await expect(client.publishText('token', 'hello Threads', 'parent-9')).resolves.toEqual({
      id: 'post-123',
    });

    const [requestUrl, init] = fetchFn.mock.calls[0]!;
    const url = new URL(String(requestUrl));

    expect(init?.method).toBe('POST');
    expect(url.origin + url.pathname).toBe('https://graph.threads.net/me/threads');
    expect(url.searchParams.get('media_type')).toBe('TEXT');
    expect(url.searchParams.get('auto_publish_text')).toBe('true');
    expect(url.searchParams.get('reply_to_id')).toBe('parent-9');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token');
  });

  it('surfaces provider errors without exposing request credentials', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid OAuth access token.', code: 190 } }), {
        status: 401,
      }),
    );
    const client = new ThreadsClient(config, fetchFn);

    await expect(client.getProfile('secret-token')).rejects.toMatchObject<Partial<ThreadsApiError>>({
      status: 401,
      providerCode: 190,
    });

    await expect(client.getProfile('secret-token')).rejects.not.toThrow('secret-token');
  });
});
