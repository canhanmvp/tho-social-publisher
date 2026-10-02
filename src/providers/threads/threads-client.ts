import * as z from 'zod/v4';

import { ThreadsPublicationUncertainError } from './publication-error.js';

const THREADS_AUTH_URL = 'https://threads.net/oauth/authorize';
const THREADS_GRAPH_URL = 'https://graph.threads.net';
const REQUEST_TIMEOUT_MS = 15_000;

const shortTokenSchema = z.object({
  access_token: z.string().min(1),
  user_id: z.union([z.string(), z.number()]).transform(String),
});

const longTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.coerce.number().positive(),
});

const profileSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  username: z.string().min(1),
  name: z.string().optional(),
  threads_profile_picture_url: z.string().url().optional(),
});

const idResponseSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
});

const containerStatusSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  status: z.enum(['EXPIRED', 'ERROR', 'FINISHED', 'IN_PROGRESS', 'PUBLISHED']),
  error_message: z.string().optional(),
});

const publishingQuotaSchema = z.object({
  data: z
    .array(
      z.object({
        quota_usage: z.coerce.number().nonnegative(),
        config: z.object({
          quota_total: z.coerce.number().positive(),
          quota_duration: z.coerce.number().positive(),
        }),
      }),
    )
    .min(1),
});

export type ThreadsProfile = z.infer<typeof profileSchema>;
export type ThreadsContainerStatus = z.infer<typeof containerStatusSchema>;

export interface ThreadsPublishingQuota {
  usage: number;
  total: number;
  durationSeconds: number;
}

export interface ThreadsClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class ThreadsApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly providerCode?: string | number,
  ) {
    super(message);
    this.name = 'ThreadsApiError';
  }
}

type FetchLike = typeof fetch;

function extractProviderError(body: unknown): { message?: string; code?: string | number } {
  if (!body || typeof body !== 'object' || !('error' in body)) {
    return {};
  }

  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object') {
    return {};
  }

  const candidate = error as { message?: unknown; code?: unknown };

  return {
    ...(typeof candidate.message === 'string' ? { message: candidate.message } : {}),
    ...(typeof candidate.code === 'string' || typeof candidate.code === 'number'
      ? { code: candidate.code }
      : {}),
  };
}

export class ThreadsClient {
  public static readonly publishingScopes = ['threads_basic', 'threads_content_publish'] as const;

  public constructor(
    private readonly config: ThreadsClientConfig,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  public buildAuthorizationUrl(state: string): string {
    const url = new URL(THREADS_AUTH_URL);

    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', ThreadsClient.publishingScopes.join(','));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);

    return url.toString();
  }

  public async exchangeCode(code: string): Promise<{ accessToken: string; userId: string }> {
    const url = new URL('/oauth/access_token', THREADS_GRAPH_URL);

    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('client_secret', this.config.clientSecret);
    url.searchParams.set('code', code);
    url.searchParams.set('grant_type', 'authorization_code');
    url.searchParams.set('redirect_uri', this.config.redirectUri);

    const data = shortTokenSchema.parse(await this.requestJson(url, { method: 'POST' }));

    return {
      accessToken: data.access_token,
      userId: data.user_id,
    };
  }

  public async exchangeLongLivedToken(
    shortLivedToken: string,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const url = new URL('/access_token', THREADS_GRAPH_URL);

    url.searchParams.set('grant_type', 'th_exchange_token');
    url.searchParams.set('client_secret', this.config.clientSecret);
    url.searchParams.set('access_token', shortLivedToken);

    const data = longTokenSchema.parse(await this.requestJson(url));

    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
    };
  }

  public async refreshLongLivedToken(
    currentToken: string,
    signal?: AbortSignal,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const url = new URL('/refresh_access_token', THREADS_GRAPH_URL);

    url.searchParams.set('grant_type', 'th_refresh_token');
    url.searchParams.set('access_token', currentToken);

    const data = longTokenSchema.parse(await this.requestJson(url, signal ? { signal } : {}));

    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
    };
  }

  public async getProfile(accessToken: string): Promise<ThreadsProfile> {
    const url = new URL('/me', THREADS_GRAPH_URL);
    url.searchParams.set('fields', 'id,username,name,threads_profile_picture_url');

    return profileSchema.parse(
      await this.requestJson(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }),
    );
  }

  public async getPublishingQuota(
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<ThreadsPublishingQuota> {
    const url = new URL('/me/threads_publishing_limit', THREADS_GRAPH_URL);
    url.searchParams.set('fields', 'quota_usage,config');

    const data = publishingQuotaSchema.parse(
      await this.requestJson(url, {
        ...(signal ? { signal } : {}),
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }),
    );
    const quota = data.data[0]!;

    return {
      usage: quota.quota_usage,
      total: quota.config.quota_total,
      durationSeconds: quota.config.quota_duration,
    };
  }

  public async publishText(
    accessToken: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<{ id: string }> {
    const url = new URL('/me/threads', THREADS_GRAPH_URL);

    url.searchParams.set('media_type', 'TEXT');
    url.searchParams.set('text', text);
    url.searchParams.set('auto_publish_text', 'true');

    const data = await this.requestPublication(url, {
      method: 'POST',
      ...(signal ? { signal } : {}),
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return { id: data.id };
  }

  public async createImageContainer(
    accessToken: string,
    input: { imageUrl: string; text?: string; altText?: string },
    signal?: AbortSignal,
  ): Promise<{ id: string }> {
    const url = new URL('/me/threads', THREADS_GRAPH_URL);

    url.searchParams.set('media_type', 'IMAGE');
    url.searchParams.set('image_url', input.imageUrl);

    if (input.text) {
      url.searchParams.set('text', input.text);
    }

    if (input.altText) {
      url.searchParams.set('alt_text', input.altText);
    }

    const data = idResponseSchema.parse(
      await this.requestJson(url, {
        method: 'POST',
        ...(signal ? { signal } : {}),
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }),
    );

    return { id: data.id };
  }

  public async getContainerStatus(
    accessToken: string,
    containerId: string,
    signal?: AbortSignal,
  ): Promise<ThreadsContainerStatus> {
    const url = new URL(`/${encodeURIComponent(containerId)}`, THREADS_GRAPH_URL);
    url.searchParams.set('fields', 'id,status,error_message');

    return containerStatusSchema.parse(
      await this.requestJson(url, {
        ...(signal ? { signal } : {}),
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }),
    );
  }

  public async publishContainer(
    accessToken: string,
    containerId: string,
    signal?: AbortSignal,
  ): Promise<{ id: string }> {
    const url = new URL('/me/threads_publish', THREADS_GRAPH_URL);
    url.searchParams.set('creation_id', containerId);

    const data = await this.requestPublication(url, {
      method: 'POST',
      ...(signal ? { signal } : {}),
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return { id: data.id };
  }

  private async requestJson(url: URL, init: RequestInit = {}): Promise<unknown> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    signal.throwIfAborted();
    const response = await this.fetchFn(url, {
      ...init,
      signal,
      headers: {
        Accept: 'application/json',
        ...init.headers,
      },
    });

    const raw = await response.text();
    let body: unknown = undefined;

    if (raw) {
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        body = undefined;
      }
    }

    if (!response.ok) {
      const providerError = extractProviderError(body);
      const suffix = providerError.message ? `: ${providerError.message}` : '';

      throw new ThreadsApiError(
        `Threads API request failed with HTTP ${response.status}${suffix}`,
        response.status,
        providerError.code,
      );
    }

    if (body === undefined) {
      throw new ThreadsApiError(
        'Threads API returned an empty or invalid JSON response.',
        response.status,
      );
    }

    return body;
  }

  private async requestPublication(url: URL, init: RequestInit): Promise<{ id: string }> {
    // An already cancelled request has not been sent and cannot have published.
    init.signal?.throwIfAborted();
    try {
      return idResponseSchema.parse(await this.requestJson(url, init));
    } catch (error) {
      if (
        error instanceof ThreadsApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      ) {
        throw error;
      }
      // A timeout, transport failure, 5xx, or malformed success response cannot
      // prove that the provider rejected a publication. Never blindly retry it.
      throw new ThreadsPublicationUncertainError();
    }
  }
}
