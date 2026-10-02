import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { describe, expect, it } from 'vitest';

import { assertSecurityConfig, getThreadsRuntimeConfig, loadConfig } from '../src/config.js';

describe('environment configuration', () => {
  it('loads the checked-in environment template with Threads disabled', async () => {
    const config = loadConfig(parse(await readFile('.env.example', 'utf8')));
    expect(config.MCP_AUTH_TOKEN).toBeUndefined();
    expect(config.TOKEN_ENCRYPTION_KEY).toBeUndefined();
    expect(getThreadsRuntimeConfig(config)).toBeUndefined();
  });

  it('accepts blank optional Docker variables but keeps production authentication mandatory', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      MCP_AUTH_TOKEN: '',
      OWNER_ACCESS_PASSWORD: ' ',
      TOKEN_ENCRYPTION_KEY: '',
      THREADS_CLIENT_ID: '',
      THREADS_CLIENT_SECRET: '',
      THREADS_REDIRECT_URI: '',
    });
    expect(getThreadsRuntimeConfig(config)).toBeUndefined();
    expect(() => assertSecurityConfig(config)).toThrow('MCP_AUTH_TOKEN');
  });

  it.each([
    { THREADS_CLIENT_ID: 'app' },
    { THREADS_CLIENT_SECRET: 'secret' },
    { THREADS_CLIENT_ID: 'app', THREADS_CLIENT_SECRET: 'secret' },
  ])('rejects partial provider credentials: %j', (env) => {
    expect(() => getThreadsRuntimeConfig(loadConfig(env))).toThrow('partially configured');
  });
});
