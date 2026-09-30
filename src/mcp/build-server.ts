import { McpServer } from '@modelcontextprotocol/server';
import type { SocialAccountStore } from '../db/social-account-store.js';

export interface McpDependencies {
  socialAccounts: SocialAccountStore;
}

export function buildMcpServer(dependencies: McpDependencies): McpServer {
  const server = new McpServer({ name: 'tho-social-publisher', version: '0.1.0' });

  server.registerTool(
    'list_social_accounts',
    {
      description: 'List social accounts connected to this self-hosted Tho Social Publisher instance.',
    },
    async () => {
      const accounts = await dependencies.socialAccounts.list();
      return {
        content: [{ type: 'text', text: JSON.stringify({ accounts }, null, 2) }],
      };
    },
  );

  return server;
}
