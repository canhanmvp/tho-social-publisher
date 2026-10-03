import { configureClient, readOption } from './setup-helpers.js';

async function main(): Promise<void> {
  const url = readOption(process.argv.slice(2), '--url');
  if (!url) {
    throw new Error(
      'Missing --url. Example: npm run client:configure -- --url https://social.example.com/mcp',
    );
  }
  const output = await configureClient(process.cwd(), url);
  console.log(`Client configuration written to ${output}`);
  console.log('Copy this folder to your other machines. It contains no server secrets.');
  console.log(
    'Set THO_SOCIAL_PUBLISHER_MCP_TOKEN privately on each machine; follow docs/PLUGIN_SETUP.md.',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Client configuration failed.');
  process.exitCode = 1;
});
