import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parse } from 'dotenv';

import { assertSecurityConfig, getThreadsRuntimeConfig, loadConfig } from '../src/config.js';
import { parseEncryptionKey } from '../src/security/token-cipher.js';

export const clientTokenVariable = 'THO_SOCIAL_PUBLISHER_MCP_TOKEN';

export function validateDomain(raw: string): string {
  if (
    raw.length > 253 ||
    !raw.includes('.') ||
    !raw.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
    /^\d+\.\d+\.\d+\.\d+$/.test(raw)
  ) {
    throw new Error('Use a DNS hostname only, for example: social.example.com');
  }
  return raw.toLowerCase();
}

export function validateMcpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Use a full MCP URL, for example: https://social.example.com/mcp');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    !/^https?:\/\//.test(raw) ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    raw.includes('?') ||
    raw.includes('#') ||
    /[\s\\]/.test(raw) ||
    url.pathname === '/'
  ) {
    throw new Error(
      'MCP URL must use HTTPS (HTTP only on loopback), with a path and no credentials, query, or fragment.',
    );
  }
  return url.href;
}

export function productionEnvironment(template: string, domain: string): string {
  const hostname = validateDomain(domain);
  const postgresPassword = randomBytes(24).toString('hex');
  const replacements = new Map<string, string>([
    ['NODE_ENV', 'production'],
    ['PUBLIC_BASE_URL', `https://${hostname}`],
    ['MCP_ALLOWED_HOSTS', `${hostname},localhost,127.0.0.1`],
    ['MCP_AUTH_TOKEN', randomBytes(32).toString('hex')],
    ['OWNER_ACCESS_PASSWORD', randomBytes(24).toString('base64url')],
    ['POSTGRES_PASSWORD', postgresPassword],
    [
      'DATABASE_URL',
      `postgresql://postgres:${postgresPassword}@localhost:5432/tho_social_publisher`,
    ],
    ['TOKEN_ENCRYPTION_KEY', randomBytes(32).toString('hex')],
    ['THREADS_REDIRECT_URI', `https://${hostname}/oauth/threads/callback`],
  ]);
  return template
    .split('\n')
    .map((line) => {
      const separator = line.indexOf('=');
      if (separator <= 0 || line.startsWith('#')) return line;
      const replacement = replacements.get(line.slice(0, separator));
      return replacement === undefined ? line : `${line.slice(0, separator)}=${replacement}`;
    })
    .join('\n');
}

export async function generateProductionEnvironment(
  root: string,
  domain: string,
  force = false,
): Promise<void> {
  const template = await readFile(resolve(root, '.env.example'), 'utf8');
  await writeFile(resolve(root, '.env.production'), productionEnvironment(template, domain), {
    encoding: 'utf8',
    mode: 0o600,
    flag: force ? 'w' : 'wx',
  });
  await chmod(resolve(root, '.env.production'), 0o600);
}

export async function configureClient(root: string, rawUrl: string): Promise<string> {
  const url = validateMcpUrl(rawUrl);
  // Copy only public plugin inputs, never the server's environment or database.
  const [manifest, skill] = await Promise.all([
    readFile(resolve(root, 'plugin.json'), 'utf8'),
    readFile(resolve(root, 'skills/social-publisher/SKILL.md'), 'utf8'),
  ]);
  const output = resolve(root, '.local/client');
  const pluginDirectory = resolve(output, 'plugin');
  await mkdir(resolve(pluginDirectory, 'skills/social-publisher'), { recursive: true });
  await Promise.all([
    writeFile(resolve(pluginDirectory, 'plugin.json'), manifest),
    writeFile(resolve(pluginDirectory, 'skills/social-publisher/SKILL.md'), skill),
    writeFile(
      resolve(pluginDirectory, 'mcp.json'),
      JSON.stringify(
        {
          $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
          mcpServers: {
            tho_social_publisher: {
              type: 'streamable-http',
              url,
              bearer_token_env_var: clientTokenVariable,
            },
          },
        },
        null,
        2,
      ) + '\n',
    ),
    writeFile(
      resolve(output, 'codex.toml'),
      `[mcp_servers.tho_social_publisher]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "${clientTokenVariable}"\n`,
    ),
    writeFile(
      resolve(output, 'README.md'),
      `# Connect a client machine\n\nMCP URL: ${url}\n\n` +
        `Merge codex.toml into your user ~/.codex/config.toml, or load the plugin folder in a host supporting portable Agent Plugins. Avoid enabling both connections in the same client.\n\n` +
        `Set ${clientTokenVariable} privately on each trusted machine to the server's MCP_AUTH_TOKEN. Restart the client after setting it. No token is included in this folder.\n\n` +
        `Clients do not need PostgreSQL, Threads developer credentials, or the token-encryption key. They share the server's accounts, history, and scheduled jobs. The server must stay running.\n`,
    ),
  ]);
  return output;
}

export async function setupServer(root: string, rawDomain: string) {
  const domain = validateDomain(rawDomain);
  let created = false;
  try {
    await generateProductionEnvironment(root, domain);
    created = true;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  let config;
  try {
    config = loadConfig(parse(await readFile(resolve(root, '.env.production'), 'utf8')));
    assertSecurityConfig(config);
    getThreadsRuntimeConfig(config);
    if (config.NODE_ENV !== 'production' || !config.TOKEN_ENCRYPTION_KEY) throw new Error();
    parseEncryptionKey(config.TOKEN_ENCRYPTION_KEY);
  } catch {
    throw new Error(
      'Existing .env.production is not a valid production configuration. Review it locally; setup will not replace its secrets.',
    );
  }
  if (config.PUBLIC_BASE_URL !== `https://${domain}`) {
    throw new Error(
      'Existing .env.production uses a different PUBLIC_BASE_URL. Use its hostname or update the configuration deliberately; secrets were preserved.',
    );
  }
  if (!config.allowedHosts.includes(domain)) {
    throw new Error(
      'Add the public hostname to MCP_ALLOWED_HOSTS in .env.production; secrets were preserved.',
    );
  }
  const url = validateMcpUrl(new URL(config.MCP_PATH, config.PUBLIC_BASE_URL).href);
  if (new URL(url).origin !== config.PUBLIC_BASE_URL) {
    throw new Error('MCP_PATH must stay on the configured server origin.');
  }
  if (new URL(url).pathname !== config.MCP_PATH) {
    throw new Error(
      'MCP_PATH must be an absolute path without URL normalization, query, or fragment.',
    );
  }
  const clientDirectory = await configureClient(root, url);
  return { created, url, clientDirectory };
}

export function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}.`);
  return value;
}
