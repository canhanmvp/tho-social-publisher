import { access, chmod, readFile, writeFile } from 'node:fs/promises';
import { constants, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function validateDomain(raw: string): string {
  if (raw.includes('/') || raw.includes(':')) {
    throw new Error('Use a hostname only, for example: social.example.com');
  }

  const url = new URL(`https://${raw}`);

  if (url.hostname !== raw || !url.hostname.includes('.')) {
    throw new Error('Invalid public hostname.');
  }

  return url.hostname;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const domainValue = readArgument('--domain');
  if (!domainValue) {
    throw new Error(
      'Missing --domain. Example: npm run env:generate -- --domain social.example.com',
    );
  }

  const domain = validateDomain(domainValue);
  const force = process.argv.includes('--force');
  const outputPath = resolve(process.cwd(), '.env.production');

  if ((await fileExists(outputPath)) && !force) {
    throw new Error('.env.production already exists. Use --force only if you intend to rotate it.');
  }

  const template = await readFile(resolve(process.cwd(), '.env.example'), 'utf8');
  const postgresPassword = randomHex(24);

  const replacements = new Map<string, string>([
    ['NODE_ENV', 'production'],
    ['PUBLIC_BASE_URL', `https://${domain}`],
    ['MCP_ALLOWED_HOSTS', `${domain},localhost,127.0.0.1`],
    ['MCP_AUTH_TOKEN', randomHex(32)],
    ['OWNER_ACCESS_PASSWORD', randomBase64Url(24)],
    ['POSTGRES_PASSWORD', postgresPassword],
    ['TOKEN_ENCRYPTION_KEY', randomHex(32)],
    ['THREADS_REDIRECT_URI', `https://${domain}/oauth/threads/callback`],
  ]);

  const output = template
    .split('\n')
    .map((line) => {
      const separator = line.indexOf('=');
      if (separator <= 0 || line.startsWith('#')) {
        return line;
      }

      const key = line.slice(0, separator);
      const replacement = replacements.get(key);

      return replacement === undefined ? line : `${key}=${replacement}`;
    })
    .join('\n');

  await writeFile(outputPath, output, { encoding: 'utf8', mode: 0o600 });
  await chmod(outputPath, 0o600);

  console.log(`Created ${outputPath}`);
  console.log('Secrets were written to the file and were not printed to stdout.');
  console.log('Next: add THREADS_CLIENT_ID and THREADS_CLIENT_SECRET, then deploy.');
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Failed to generate the production environment.',
  );
  process.exitCode = 1;
});
