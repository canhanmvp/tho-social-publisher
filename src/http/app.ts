import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Pool } from 'pg';

import type { AppConfig } from '../config.js';
import type { PublishedPostStore } from '../db/published-post-store.js';
import { checkDatabase } from '../db/pool.js';
import type { SocialAccountStore } from '../db/social-account-store.js';
import type { PublishingGuard } from '../guardrails/publishing-guard.js';
import { buildMcpServer } from '../mcp/build-server.js';
import type { ThreadsService } from '../providers/threads/threads-service.js';
import type { SocialScheduler } from '../scheduler/social-scheduler.js';
import { isBearerAuthorized, isOwnerAuthorized } from './auth.js';

interface AppDependencies {
  config: AppConfig;
  pool: Pool;
  socialAccounts: SocialAccountStore;
  publishedPosts: PublishedPostStore;
  publishingGuard: PublishingGuard;
  threads?: ThreadsService;
  scheduler?: SocialScheduler;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderConnectPage(
  accounts: Awaited<ReturnType<SocialAccountStore['list']>>,
  threadsConfigured: boolean,
  connectedProvider?: string,
): string {
  const threadsAccounts = accounts.filter((account) => account.provider === 'threads');

  const accountList =
    threadsAccounts.length > 0
      ? threadsAccounts
          .map(
            (account) =>
              `<li><strong>@${escapeHtml(account.accountName)}</strong><span>${escapeHtml(account.status)}</span></li>`,
          )
          .join('')
      : '<li><strong>No Threads account connected</strong><span>—</span></li>';

  const notice =
    connectedProvider === 'threads'
      ? '<div class="notice">Threads account connected successfully.</div>'
      : '';

  const threadsAction = threadsConfigured
    ? '<a class="button" href="/oauth/threads/start">Connect / reconnect Threads</a>'
    : '<span class="muted">Set Threads OAuth environment variables to enable connection.</span>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Tho Social Publisher</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 760px; margin: 64px auto; padding: 0 24px; background: #0b0d10; color: #f4f4f5; }
    h1 { margin-bottom: 8px; }
    p, .muted { color: #a1a1aa; line-height: 1.6; }
    .card { margin-top: 28px; padding: 20px; border: 1px solid #27272a; border-radius: 14px; }
    ul { list-style: none; padding: 0; margin: 16px 0 20px; display: grid; gap: 8px; }
    li { display: flex; justify-content: space-between; gap: 16px; }
    li span { color: #71717a; }
    .button { display: inline-block; text-decoration: none; background: #fafafa; color: #09090b; padding: 10px 14px; border-radius: 9px; font-weight: 650; }
    .notice { margin-top: 20px; padding: 12px 14px; border: 1px solid #3f3f46; border-radius: 10px; }
    code { color: #d4d4d8; }
  </style>
</head>
<body>
  <h1>Tho Social Publisher</h1>
  <p>Self-hosted social publishing MCP using official platform OAuth and APIs.</p>
  ${notice}
  <section class="card">
    <h2>Threads</h2>
    <ul>${accountList}</ul>
    ${threadsAction}
  </section>
  <p>MCP endpoint: <code>/mcp</code></p>
</body>
</html>`;
}

export function createApp({
  config,
  pool,
  socialAccounts,
  publishedPosts,
  publishingGuard,
  threads,
  scheduler,
}: AppDependencies) {
  const app = createMcpHonoApp({
    host: config.HOST,
    allowedHosts: config.allowedHosts,
    ...(config.allowedOrigins.length > 0 ? { allowedOrigins: config.allowedOrigins } : {}),
  });

  const mcpHandler = createMcpHandler(() =>
    buildMcpServer({
      socialAccounts,
      publishedPosts,
      publishingGuard,
      ...(threads ? { threads } : {}),
      ...(scheduler ? { scheduler } : {}),
    }),
  );

  app.get('/', (context) =>
    context.json({
      name: 'tho-social-publisher',
      version: '0.1.0',
      mcp: config.MCP_PATH,
      connect: '/connect',
      providers: { threads: Boolean(threads) },
      scheduling: Boolean(scheduler),
      guardrails: {
        duplicate_guard_hours: config.DUPLICATE_GUARD_HOURS,
      },
    }),
  );

  app.get('/health', (context) => context.json({ status: 'ok' }));

  app.get('/ready', async (context) => {
    try {
      await checkDatabase(pool);
      return context.json({ status: 'ready' });
    } catch {
      return context.json({ status: 'not_ready' }, 503);
    }
  });

  app.get('/connect', async (context) => {
    if (!config.OWNER_ACCESS_PASSWORD) {
      return context.json({ error: 'owner_access_not_configured' }, 503);
    }

    if (!isOwnerAuthorized(context.req.header('Authorization'), config.OWNER_ACCESS_PASSWORD)) {
      context.header('WWW-Authenticate', 'Basic realm="Tho Social Publisher"');
      return context.text('Owner authentication required.', 401);
    }

    const accounts = await socialAccounts.list(true);

    return context.html(renderConnectPage(accounts, Boolean(threads), context.req.query('connected')));
  });

  app.get('/oauth/threads/start', async (context) => {
    if (!config.OWNER_ACCESS_PASSWORD) {
      return context.json({ error: 'owner_access_not_configured' }, 503);
    }

    if (!isOwnerAuthorized(context.req.header('Authorization'), config.OWNER_ACCESS_PASSWORD)) {
      context.header('WWW-Authenticate', 'Basic realm="Tho Social Publisher"');
      return context.text('Owner authentication required.', 401);
    }

    if (!threads) {
      return context.json({ error: 'threads_not_configured' }, 503);
    }

    const authorizationUrl = await threads.createAuthorizationUrl();
    return context.redirect(authorizationUrl);
  });

  app.get('/oauth/threads/callback', async (context) => {
    if (!threads) {
      return context.json({ error: 'threads_not_configured' }, 503);
    }

    const providerError = context.req.query('error');
    if (providerError) {
      return context.json({ error: 'threads_authorization_denied', provider_error: providerError }, 400);
    }

    const code = context.req.query('code');
    const state = context.req.query('state');

    if (!code || !state) {
      return context.json({ error: 'missing_oauth_code_or_state' }, 400);
    }

    try {
      await threads.completeAuthorization(code, state);
      return context.redirect('/connect?connected=threads');
    } catch (error) {
      console.error('[threads-oauth] callback failed', {
        name: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      return context.json({ error: 'threads_oauth_failed' }, 400);
    }
  });

  app.all(config.MCP_PATH, (context) => {
    if (!config.MCP_AUTH_TOKEN) {
      return context.json({ error: 'mcp_auth_not_configured' }, 503);
    }

    if (!isBearerAuthorized(context.req.header('Authorization'), config.MCP_AUTH_TOKEN)) {
      return context.json({ error: 'unauthorized' }, 401);
    }

    return mcpHandler.fetch(context.req.raw);
  });

  app.notFound((context) => context.json({ error: 'not_found' }, 404));

  app.onError((error, context) => {
    console.error('[http] request failed', { name: error.name, message: error.message });
    return context.json({ error: 'internal_server_error' }, 500);
  });

  return app;
}
