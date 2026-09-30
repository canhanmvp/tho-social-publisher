import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { SocialAccountStore } from '../db/social-account-store.js';
import type { ThreadsService } from '../providers/threads/threads-service.js';

export interface McpDependencies {
  socialAccounts: SocialAccountStore;
  threads?: ThreadsService;
}

function toolError(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

export function buildMcpServer(dependencies: McpDependencies): McpServer {
  const server = new McpServer(
    {
      name: 'tho-social-publisher',
      version: '0.1.0',
    },
    {
      instructions:
        'List connected accounts before publishing when the target account is ambiguous. Publishing is an external side effect. Never invent account IDs.',
    },
  );

  server.registerTool(
    'list_social_accounts',
    {
      description: 'List social accounts connected to this self-hosted Tho Social Publisher instance.',
    },
    async () => {
      const accounts = await dependencies.socialAccounts.list();

      return {
        content: [{ type: 'text', text: JSON.stringify({ accounts }, null, 2) }],
        structuredContent: { accounts },
      };
    },
  );

  server.registerTool(
    'connect_social_account',
    {
      description:
        'Create an OAuth authorization URL for a supported social provider. The human account owner must open the URL and grant access.',
      inputSchema: z.object({
        provider: z.literal('threads'),
      }),
    },
    async ({ provider }) => {
      if (provider !== 'threads' || !dependencies.threads) {
        return toolError('Threads OAuth is not configured on this server.');
      }

      const authorizationUrl = await dependencies.threads.createAuthorizationUrl();

      return {
        content: [
          {
            type: 'text',
            text: `Open this URL to grant Threads access: ${authorizationUrl}`,
          },
        ],
        structuredContent: {
          provider,
          authorization_url: authorizationUrl,
        },
      };
    },
  );

  server.registerTool(
    'publish_post',
    {
      description:
        'Publish a text post to one connected social account. Threads is the first implemented provider.',
      inputSchema: z.object({
        account_id: z.string().uuid(),
        text: z.string().min(1),
        reply_to_id: z.string().min(1).optional(),
      }),
      annotations: {
        title: 'Publish social post',
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ account_id, text, reply_to_id }) => {
      if (!dependencies.threads) {
        return toolError('Threads publishing is not configured on this server.');
      }

      try {
        const result = await dependencies.threads.publishText({
          socialAccountId: account_id,
          text,
          ...(reply_to_id ? { replyToId: reply_to_id } : {}),
        });

        return {
          content: [
            {
              type: 'text',
              text: `Published Threads post ${result.providerPostId}.`,
            },
          ],
          structuredContent: {
            provider: 'threads',
            account_id: result.socialAccountId,
            provider_post_id: result.providerPostId,
          },
        };
      } catch (error) {
        return toolError(error instanceof Error ? error.message : 'Threads publish failed.');
      }
    },
  );

  return server;
}
