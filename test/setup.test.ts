import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { parse } from 'dotenv';
import { afterEach, describe, expect, it } from 'vitest';

import {
  configureClient,
  generateProductionEnvironment,
  setupServer,
  validateDomain,
  validateMcpUrl,
} from '../scripts/setup-helpers.js';

const run = promisify(execFile);
const repository = process.cwd();
const fixtures: string[] = [];

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'tho-setup-test-'));
  fixtures.push(root);
  await mkdir(resolve(root, 'skills/social-publisher'), { recursive: true });
  for (const file of [
    '.env.example',
    'plugin.json',
    'mcp.json',
    'skills/social-publisher/SKILL.md',
  ]) {
    await writeFile(resolve(root, file), await readFile(resolve(repository, file)));
  }
  return root;
}

async function clientContents(directory: string): Promise<string[]> {
  const contents: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    contents.push(
      ...(entry.isDirectory() ? await clientContents(path) : [await readFile(path, 'utf8')]),
    );
  }
  return contents;
}

function cli(root: string, script: string, args: string[]) {
  return run(
    process.execPath,
    [
      '--import',
      pathToFileURL(resolve(repository, 'node_modules/tsx/dist/loader.mjs')).href,
      resolve(repository, 'scripts', script),
      ...args,
    ],
    { cwd: root },
  );
}

afterEach(async () => {
  for (const root of fixtures.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('tho-setup-test-')) {
      throw new Error('Refusing cleanup outside setup test fixture directory.');
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe('self-hosted setup', () => {
  it('creates production secrets once, with matching database password and hostname', async () => {
    const root = await fixture();
    const result = await setupServer(root, 'SOCIAL.example.com');
    const env = parse(await readFile(resolve(root, '.env.production'), 'utf8'));
    expect(result.created).toBe(true);
    expect(result.url).toBe('https://social.example.com/mcp');
    expect(env.NODE_ENV).toBe('production');
    expect(env.MCP_AUTH_TOKEN).toHaveLength(64);
    expect(env.TOKEN_ENCRYPTION_KEY).toHaveLength(64);
    expect(env.OWNER_ACCESS_PASSWORD?.length).toBeGreaterThanOrEqual(16);
    expect(new URL(env.DATABASE_URL!).password).toBe(env.POSTGRES_PASSWORD);
    expect(env.THREADS_REDIRECT_URI).toBe('https://social.example.com/oauth/threads/callback');
    expect(env.THREADS_CLIENT_ID).toBe('');
    expect(env.THREADS_CLIENT_SECRET).toBe('');
  });

  it('keeps existing secrets and provider credentials byte-for-byte on rerun', async () => {
    const root = await fixture();
    await setupServer(root, 'social.example.com');
    const path = resolve(root, '.env.production');
    const original = (await readFile(path, 'utf8'))
      .replace('THREADS_CLIENT_ID=', 'THREADS_CLIENT_ID=test-app')
      .replace('THREADS_CLIENT_SECRET=', 'THREADS_CLIENT_SECRET=test-secret');
    await writeFile(path, original);
    expect((await setupServer(root, 'social.example.com')).created).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('refuses a different hostname without replacing existing configuration', async () => {
    const root = await fixture();
    await setupServer(root, 'social.example.com');
    const path = resolve(root, '.env.production');
    const original = await readFile(path, 'utf8');
    await expect(setupServer(root, 'other.example.com')).rejects.toThrow(
      'different PUBLIC_BASE_URL',
    );
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('fails safely on invalid production configuration without exposing its values', async () => {
    const root = await fixture();
    const value = 'NODE_ENV=production\nPORT=PRIVATE-INVALID-VALUE\n';
    await writeFile(resolve(root, '.env.production'), value);
    await expect(setupServer(root, 'social.example.com')).rejects.toThrow('Review it locally');
    expect(await readFile(resolve(root, '.env.production'), 'utf8')).toBe(value);
  });

  it('honors a custom MCP path on the same server', async () => {
    const root = await fixture();
    await setupServer(root, 'social.example.com');
    const path = resolve(root, '.env.production');
    await writeFile(
      path,
      (await readFile(path, 'utf8')).replace('MCP_PATH=/mcp', 'MCP_PATH=/agent'),
    );
    expect((await setupServer(root, 'social.example.com')).url).toBe(
      'https://social.example.com/agent',
    );
  });

  it('rejects incomplete provider configuration and paths changed by URL normalization', async () => {
    const root = await fixture();
    await setupServer(root, 'social.example.com');
    const path = resolve(root, '.env.production');
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('THREADS_CLIENT_ID=', 'THREADS_CLIENT_ID=test-app'));
    await expect(setupServer(root, 'social.example.com')).rejects.toThrow('Review it locally');
    await writeFile(path, original.replace('MCP_PATH=/mcp', 'MCP_PATH=/other/../mcp'));
    await expect(setupServer(root, 'social.example.com')).rejects.toThrow('URL normalization');
  });

  it('rejects a path escaping to another origin and a missing allowed host', async () => {
    const root = await fixture();
    await setupServer(root, 'social.example.com');
    const path = resolve(root, '.env.production');
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('MCP_PATH=/mcp', 'MCP_PATH=//other.example.com/mcp'));
    await expect(setupServer(root, 'social.example.com')).rejects.toThrow('server origin');
    await writeFile(
      path,
      original.replace('MCP_ALLOWED_HOSTS=social.example.com,', 'MCP_ALLOWED_HOSTS='),
    );
    await expect(setupServer(root, 'social.example.com')).rejects.toThrow('MCP_ALLOWED_HOSTS');
  });

  it('does not overwrite with the standalone env generator unless force is explicit', async () => {
    const root = await fixture();
    await generateProductionEnvironment(root, 'social.example.com');
    const original = await readFile(resolve(root, '.env.production'), 'utf8');
    await expect(generateProductionEnvironment(root, 'social.example.com')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(resolve(root, '.env.production'), 'utf8')).toBe(original);
    await generateProductionEnvironment(root, 'social.example.com', true);
    expect(await readFile(resolve(root, '.env.production'), 'utf8')).not.toBe(original);
  });

  it('generates a portable bundle for another machine without any server secrets', async () => {
    const root = await fixture();
    const sourceMcp = await readFile(resolve(root, 'mcp.json'), 'utf8');
    const result = await setupServer(root, 'social.example.com');
    const env = parse(await readFile(resolve(root, '.env.production'), 'utf8'));
    const contents = (await clientContents(result.clientDirectory)).join('\n');
    for (const key of [
      'MCP_AUTH_TOKEN',
      'OWNER_ACCESS_PASSWORD',
      'POSTGRES_PASSWORD',
      'TOKEN_ENCRYPTION_KEY',
    ]) {
      expect(contents).not.toContain(env[key]);
    }
    expect(await readFile(resolve(root, 'mcp.json'), 'utf8')).toBe(sourceMcp);
    const mcp = JSON.parse(
      await readFile(resolve(result.clientDirectory, 'plugin/mcp.json'), 'utf8'),
    );
    expect(mcp.mcpServers.tho_social_publisher.url).toBe(result.url);
    expect(mcp.mcpServers.tho_social_publisher.bearer_token_env_var).toBe(
      'THO_SOCIAL_PUBLISHER_MCP_TOKEN',
    );
    expect(await readFile(resolve(result.clientDirectory, 'codex.toml'), 'utf8')).toContain(
      `url = "${result.url}"`,
    );
    expect(
      await readFile(
        resolve(result.clientDirectory, 'plugin/skills/social-publisher/SKILL.md'),
        'utf8',
      ),
    ).toBe(await readFile(resolve(root, 'skills/social-publisher/SKILL.md'), 'utf8'));
  });

  it('configures a client independently of server env or Threads credentials', async () => {
    const root = await fixture();
    const output = await configureClient(root, 'https://own.example.com:8443/tools/mcp');
    expect(await readFile(resolve(output, 'codex.toml'), 'utf8')).toContain(
      'https://own.example.com:8443/tools/mcp',
    );
    await expect(readFile(resolve(root, '.env.production'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('runs both CLIs and does not print generated secrets', async () => {
    const root = await fixture();
    const first = await cli(root, 'setup.ts', ['--domain', 'social.example.com']);
    const env = parse(await readFile(resolve(root, '.env.production'), 'utf8'));
    const second = await cli(root, 'setup.ts', ['--domain', 'social.example.com']);
    const client = await cli(root, 'configure-client.ts', [
      '--url',
      'https://social.example.com/mcp',
    ]);
    expect(first.stdout).toContain('Created .env.production.');
    expect(second.stdout).toContain('all secrets preserved');
    expect(client.stdout).toContain('Client configuration written');
    for (const key of [
      'MCP_AUTH_TOKEN',
      'OWNER_ACCESS_PASSWORD',
      'POSTGRES_PASSWORD',
      'TOKEN_ENCRYPTION_KEY',
    ]) {
      expect(first.stdout + first.stderr + second.stdout + client.stdout).not.toContain(env[key]);
    }
  });

  it('reports missing CLI arguments without creating a configuration', async () => {
    const root = await fixture();
    await expect(cli(root, 'setup.ts', ['--domain'])).rejects.toMatchObject({
      stderr: expect.stringContaining('Missing value'),
    });
    await expect(cli(root, 'configure-client.ts', [])).rejects.toMatchObject({
      stderr: expect.stringContaining('Missing --url'),
    });
    await expect(readFile(resolve(root, '.env.production'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('setup endpoint validation', () => {
  it.each([
    'localhost',
    'https://social.example.com',
    'a.example.com/path',
    'user@a.example.com',
    '-bad.example.com',
    'bad_.example.com',
    'a..example.com',
    '127.0.0.1',
    'a.example.com\nSECRET',
  ])('rejects invalid domain %j', (value) => {
    expect(() => validateDomain(value)).toThrow();
  });
  it.each([
    'https://own.example.com/mcp',
    'http://localhost:3000/mcp',
    'http://127.0.0.1:3000/mcp',
    'http://[::1]:3000/mcp',
  ])('accepts secure endpoint or local development URL %j', (value) => {
    expect(validateMcpUrl(value)).toBe(value);
  });
  it.each([
    'http://own.example.com/mcp',
    'https://owner:secret@own.example.com/mcp',
    'https://own.example.com/mcp?token=secret',
    'https://own.example.com/mcp#secret',
    'https://own.example.com/',
    'ftp://own.example.com/mcp',
    'invalid',
    'https://own.example.com/mcp\nsecret',
  ])('rejects unsafe endpoint %j without including it in the error', (value) => {
    expect(() => validateMcpUrl(value)).toThrow();
    try {
      validateMcpUrl(value);
    } catch (error) {
      expect((error as Error).message).not.toContain(value);
    }
  });
});
