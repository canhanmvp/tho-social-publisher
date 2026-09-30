import 'dotenv/config';

import { serve } from '@hono/node-server';

import { assertSecurityConfig, getThreadsRuntimeConfig, loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { PostgresSocialAccountStore } from './db/social-account-store.js';
import { createApp } from './http/app.js';
import { OAuthStateStore } from './oauth/oauth-state-store.js';
import { ThreadsAccountStore } from './providers/threads/threads-account-store.js';
import { ThreadsClient } from './providers/threads/threads-client.js';
import { ThreadsService } from './providers/threads/threads-service.js';
import { parseEncryptionKey } from './security/token-cipher.js';

const config = loadConfig();
assertSecurityConfig(config);

const pool = createPool(config.DATABASE_URL);
const socialAccounts = new PostgresSocialAccountStore(pool);
const threadsRuntime = getThreadsRuntimeConfig(config);

let threads: ThreadsService | undefined;

if (threadsRuntime) {
  if (!config.TOKEN_ENCRYPTION_KEY) {
    throw new Error('TOKEN_ENCRYPTION_KEY is required when Threads OAuth is configured.');
  }

  const encryptionKey = parseEncryptionKey(config.TOKEN_ENCRYPTION_KEY);
  const threadsClient = new ThreadsClient(threadsRuntime);
  const threadsAccounts = new ThreadsAccountStore(pool);
  const oauthStates = new OAuthStateStore(pool);

  threads = new ThreadsService(
    threadsClient,
    threadsAccounts,
    oauthStates,
    encryptionKey,
    threadsRuntime.redirectUri,
  );
}

const app = createApp({
  config,
  pool,
  socialAccounts,
  ...(threads ? { threads } : {}),
});

const server = serve(
  {
    fetch: app.fetch,
    hostname: config.HOST,
    port: config.PORT,
  },
  (info) => {
    console.log(
      `[server] Tho Social Publisher listening on http://${info.address}:${info.port}${config.MCP_PATH}`,
    );
  },
);

async function shutdown(signal: string): Promise<void> {
  console.log(`[server] received ${signal}; shutting down`);

  server.close(async (error) => {
    if (error) {
      console.error('[server] HTTP shutdown failed', {
        name: error.name,
        message: error.message,
      });
      process.exitCode = 1;
    }

    await pool.end();
    process.exit();
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
