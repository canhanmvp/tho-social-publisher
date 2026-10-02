import * as z from 'zod/v4';

const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;
const optionalNonEmptyString = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  MCP_PATH: z.string().regex(/^\//).default('/mcp'),
  MCP_ALLOWED_HOSTS: z.string().default('localhost,127.0.0.1'),
  MCP_ALLOWED_ORIGINS: z.string().default(''),
  MCP_AUTH_TOKEN: optionalNonEmptyString,
  OWNER_ACCESS_PASSWORD: optionalNonEmptyString,
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgresql://postgres:postgres@localhost:5432/tho_social_publisher'),
  TOKEN_ENCRYPTION_KEY: optionalNonEmptyString,
  THREADS_CLIENT_ID: optionalNonEmptyString,
  THREADS_CLIENT_SECRET: optionalNonEmptyString,
  THREADS_REDIRECT_URI: z.preprocess(emptyToUndefined, z.string().url().optional()),
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
  DUPLICATE_GUARD_HOURS: z.coerce.number().int().min(0).max(168).default(24),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppConfig = z.infer<typeof envSchema> & {
  allowedHosts: string[];
  allowedOrigins: string[];
};

export interface ThreadsRuntimeConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  return {
    ...parsed,
    allowedHosts: parseCsv(parsed.MCP_ALLOWED_HOSTS),
    allowedOrigins: parseCsv(parsed.MCP_ALLOWED_ORIGINS),
  };
}

export function getThreadsRuntimeConfig(config: AppConfig): ThreadsRuntimeConfig | undefined {
  const values = [
    config.THREADS_CLIENT_ID,
    config.THREADS_CLIENT_SECRET,
    config.THREADS_REDIRECT_URI,
  ];
  const configuredCount = values.filter(Boolean).length;

  // Templates may include a redirect URI before provider credentials are added.
  if (!config.THREADS_CLIENT_ID && !config.THREADS_CLIENT_SECRET) {
    return undefined;
  }

  if (configuredCount !== values.length) {
    throw new Error(
      'Threads OAuth is partially configured. Set THREADS_CLIENT_ID, THREADS_CLIENT_SECRET, and THREADS_REDIRECT_URI together.',
    );
  }

  return {
    clientId: config.THREADS_CLIENT_ID!,
    clientSecret: config.THREADS_CLIENT_SECRET!,
    redirectUri: config.THREADS_REDIRECT_URI!,
  };
}

export function assertSecurityConfig(config: AppConfig): void {
  if (config.NODE_ENV !== 'production') {
    return;
  }

  if (!config.MCP_AUTH_TOKEN || config.MCP_AUTH_TOKEN.length < 32) {
    throw new Error('MCP_AUTH_TOKEN must be set to at least 32 characters in production.');
  }

  if (!config.OWNER_ACCESS_PASSWORD || config.OWNER_ACCESS_PASSWORD.length < 16) {
    throw new Error('OWNER_ACCESS_PASSWORD must be set to at least 16 characters in production.');
  }
}
