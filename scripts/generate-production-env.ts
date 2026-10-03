import { generateProductionEnvironment, readOption } from './setup-helpers.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const domain = readOption(args, '--domain');
  if (!domain) {
    throw new Error(
      'Missing --domain. Example: npm run env:generate -- --domain social.example.com',
    );
  }
  try {
    await generateProductionEnvironment(process.cwd(), domain, args.includes('--force'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        '.env.production already exists. Use --force only if you intend to rotate it.',
      );
    }
    throw error;
  }
  console.log('Created .env.production. Secrets were written to the file, not stdout.');
  console.log('Next: add THREADS_CLIENT_ID and THREADS_CLIENT_SECRET, then deploy.');
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Failed to generate the production environment.',
  );
  process.exitCode = 1;
});
