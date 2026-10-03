import { readOption, setupServer } from './setup-helpers.js';

async function main(): Promise<void> {
  const domain = readOption(process.argv.slice(2), '--domain');
  if (!domain) {
    throw new Error('Missing --domain. Example: npm run setup -- --domain social.example.com');
  }
  const result = await setupServer(process.cwd(), domain);
  console.log(
    result.created ? 'Created .env.production.' : 'Reusing .env.production; all secrets preserved.',
  );
  console.log('Secrets are never printed or copied into client files.');
  console.log(`Client configuration: ${result.clientDirectory}`);
  console.log(`MCP URL: ${result.url}`);
  console.log('Next steps:');
  console.log('1. Set THREADS_CLIENT_ID and THREADS_CLIENT_SECRET in .env.production.');
  console.log('2. Register THREADS_REDIRECT_URI from that file in your Meta Threads app.');
  console.log('3. Point DNS at your server; configure HTTPS using deploy/Caddyfile.example.');
  console.log('4. Run: docker compose --env-file .env.production up -d --build');
  console.log('5. Check /health and /ready, then open /connect to authorize Threads.');
  console.log('6. Follow docs/PLUGIN_SETUP.md to connect each of your client machines.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Setup failed.');
  process.exitCode = 1;
});
