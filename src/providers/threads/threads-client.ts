import * as z from 'zod/v4';

const THREADS_AUTH_URL = 'https://threads.net/oauth/authorize';
const THREADS_GRAPH_URL = 'https://graph.threads.net';

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

const publishResponseSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
});

export type ThreadsProfile = z.infer<typeof profileSchema>;

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
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const url = new URL('/refresh_access_token', THREADS_GRAPH_URL);

    url.searchParams.set('grant_type', 'th_refresh_token');
    url.searchParams.set('access_token', currentToken);

    const data = longTokenSchema.parse(await this.requestJson(url));

    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
    };
  }

  public async getProfile(accessToken: string): Promise<ThreadsProfile> {
    const url = new URL('/me', THREADS_GRAPH_URL);
    url.searchParams.set(
      'fields',
      'id,username,name,threads_profile_picture_url',
    );

    return profileSchema.parse(
      await this.requestJson(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }),
    );
  }

  public async publishText(
    accessToken: string,
    text: string,
    replyToId?: string,
  ): Promise<{ id: string }> {
    const url = new URL('/me/threads', THREADS_GRAPH_URL);

    url.searchParams.set('media_type', 'TEXT');
    url.searchParams.set('text', text);
    url.searchParams.set('auto_publish_text', 'true');

    if (replyToId) {
      url.searchParams.set('reply_to_id', replyToId);
    }

    const data = publishResponseSchema.parse(
      await this.requestJson(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }),
    );

    return { id: data.id };
  }

  private async requestJson(url: URL, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchFn(url, {
      ...init,
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
      throw new ThreadsApiError('Threads API returned an empty or invalid JSON response.', response.status);
    }

    return body;
  }
}
