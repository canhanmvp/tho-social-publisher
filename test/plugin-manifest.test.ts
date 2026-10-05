import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('portable plugin package', () => {
  it('has matching plugin identity and a bearer-authenticated MCP server', async () => {
    const plugin = JSON.parse(await readFile('plugin.json', 'utf8')) as {
      name: string;
      version: string;
    };
    const mcp = JSON.parse(await readFile('mcp.json', 'utf8')) as {
      mcpServers: Record<
        string,
        {
          type: string;
          url: string;
          bearer_token_env_var?: string;
        }
      >;
    };

    expect(plugin.name).toBe('tho-social-publisher');
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);

    const server = mcp.mcpServers.tho_social_publisher;
    expect(server).toBeDefined();
    expect(server?.type).toBe('streamable-http');
    expect(server?.url).toBe('http://localhost:3000/mcp');
    expect(server?.bearer_token_env_var).toBe('THO_SOCIAL_PUBLISHER_MCP_TOKEN');
  });
});
