import * as z from 'zod/v4';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  MCP_PATH: z.string().regex(/^\//).default('/mcp'),
  MCP_ALLOWED_HOSTS: z.string().default('localhost,127.0.0.1'),
  MCP_ALLOWED_ORIGINS: z.string().default(''),
  DATABASE_URL: z.string().min(1).default('postgresql://postgres:postgres@localhost:5432/tho_social_publisher'),
  TOKEN_ENCRYPTION_KEY: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppConfig = z.infer<typeof envSchema> & {
  allowedHosts: string[];
  allowedOrigins: string[];
};

function parseCsv(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  return {
    ...parsed,
    allowedHosts: parseCsv(parsed.MCP_ALLOWED_HOSTS),
    allowedOrigins: parseCsv(parsed.MCP_ALLOWED_ORIGINS),
  };
}
