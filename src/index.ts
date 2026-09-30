import { serve } from '@hono/node-server';

import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { PostgresSocialAccountStore } from './db/social-account-store.js';
import { createApp } from './http/app.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const socialAccounts = new PostgresSocialAccountStore(pool);
const app = createApp({ config, pool, socialAccounts });

const server = serve(
  { fetch: app.fetch, hostname: config.HOST, port: config.PORT },
  (info) => {
    console.log(`[server] Tho Social Publisher listening on http://${info.address}:${info.port}${config.MCP_PATH}`);
  },
);

async function shutdown(signal: string): Promise<void> {
  console.log(`[server] received ${signal}; shutting down`);
  server.close(async (error) => {
    if (error) {
      console.error('[server] HTTP shutdown failed', { name: error.name, message: error.message });
      process.exitCode = 1;
    }
    await pool.end();
    process.exit();
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown(signal));
}
