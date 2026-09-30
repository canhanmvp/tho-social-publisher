import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Pool } from 'pg';

import type { AppConfig } from '../config.js';
import { checkDatabase } from '../db/pool.js';
import type { SocialAccountStore } from '../db/social-account-store.js';
import { buildMcpServer } from '../mcp/build-server.js';

interface AppDependencies {
  config: AppConfig;
  pool: Pool;
  socialAccounts: SocialAccountStore;
}

const CONNECT_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Tho Social Publisher</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 760px; margin: 64px auto; padding: 0 24px; background: #0b0d10; color: #f4f4f5; }
    h1 { margin-bottom: 8px; }
    p { color: #a1a1aa; line-height: 1.6; }
    .grid { display: grid; gap: 12px; margin-top: 32px; }
    .provider { display: flex; align-items: center; justify-content: space-between; padding: 16px; border: 1px solid #27272a; border-radius: 12px; }
    .provider span:last-child { color: #71717a; font-size: 14px; }
    code { color: #d4d4d8; }
  </style>
</head>
<body>
  <h1>Tho Social Publisher</h1>
  <p>Self-hosted social publishing MCP. Provider OAuth flows are added incrementally and use official platform APIs only.</p>
  <div class="grid">
    <div class="provider"><strong>Threads</strong><span>Next: Phase 1</span></div>
    <div class="provider"><strong>Instagram</strong><span>Planned</span></div>
    <div class="provider"><strong>Facebook</strong><span>Planned</span></div>
    <div class="provider"><strong>LinkedIn</strong><span>Planned</span></div>
    <div class="provider"><strong>TikTok</strong><span>Planned</span></div>
    <div class="provider"><strong>X</strong><span>Planned</span></div>
  </div>
  <p>MCP endpoint: <code>/mcp</code></p>
</body>
</html>`;

export function createApp({ config, pool, socialAccounts }: AppDependencies) {
  const app = createMcpHonoApp({
    host: config.HOST,
    allowedHosts: config.allowedHosts,
    ...(config.allowedOrigins.length > 0 ? { allowedOrigins: config.allowedOrigins } : {}),
  });

  const mcpHandler = createMcpHandler(() => buildMcpServer({ socialAccounts }));

  app.get('/', (context) => context.json({
    name: 'tho-social-publisher',
    version: '0.1.0',
    mcp: config.MCP_PATH,
    connect: '/connect',
  }));

  app.get('/health', (context) => context.json({ status: 'ok' }));

  app.get('/ready', async (context) => {
    try {
      await checkDatabase(pool);
      return context.json({ status: 'ready' });
    } catch {
      return context.json({ status: 'not_ready' }, 503);
    }
  });

  app.get('/connect', (context) => context.html(CONNECT_PAGE));
  app.all(config.MCP_PATH, (context) => mcpHandler.fetch(context.req.raw));
  app.notFound((context) => context.json({ error: 'not_found' }, 404));

  app.onError((error, context) => {
    console.error('[http] request failed', { name: error.name, message: error.message });
    return context.json({ error: 'internal_server_error' }, 500);
  });

  return app;
}
