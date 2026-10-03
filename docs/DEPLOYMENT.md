# Production deployment

This guide targets a small self-hosted Linux VPS with Docker Compose and Caddy.

The production topology is:

```text
Internet
   |
 HTTPS
   v
 Caddy
   |
127.0.0.1:3000
   |
Tho Social Publisher
   |
private Docker network
   |
PostgreSQL
```

PostgreSQL is not published to the host network. The application port is bound to loopback only; Caddy is the public entry point.

## 1. DNS

Create an A/AAAA record for the MCP hostname and point it at the VPS.

Choose your own hostname, for example:

```text
social.example.com
```

The repository does not depend on a shared server. Run setup for your hostname to generate a client package, then use that package on all your trusted machines.

## 2. Clone and install

```bash
git clone https://github.com/canhanmvp/tho-social-publisher.git
cd tho-social-publisher
npm install
```

## 3. Prepare this installation

```bash
npm run setup -- --domain social.example.com
```

On first use, setup creates `.env.production` with file mode `0600` on POSIX systems; on Windows, restrict access using file permissions. It also writes a portable plugin and Codex configuration to `.local/client/`, without secrets. Setup generates independent random values for:

- MCP bearer token
- owner UI password
- PostgreSQL password
- token-encryption key

The values are written to the file and are not printed to stdout.

Do not commit `.env.production`. Running setup again preserves the entire existing file, including encryption keys and provider credentials. A different hostname is rejected until you deliberately update the existing configuration. `env:generate -- --force` remains an explicit credential-rotation operation; do not use it for routine setup or upgrades.

## 4. Add Threads developer credentials

Edit `.env.production` and set:

```env
THREADS_CLIENT_ID=
THREADS_CLIENT_SECRET=
```

The generated redirect URI will be:

```text
https://social.example.com/oauth/threads/callback
```

Register that exact redirect URI in the Meta Threads app.

## 5. Start the application

```bash
docker compose --env-file .env.production up -d --build
```

Check:

```bash
docker compose --env-file .env.production ps
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
```

Both health endpoints should succeed before exposing the service.

## 6. Configure Caddy

Install Caddy on the host, copy `deploy/Caddyfile.example`, and provide:

```bash
export DOMAIN=social.example.com
export APP_PORT=3000
```

Use the Caddy deployment mechanism appropriate for the host. Confirm HTTPS works:

```bash
curl https://social.example.com/health
```

Do not expose PostgreSQL or the Docker app port directly to the public internet.

## 7. Connect Threads

Open:

```text
https://social.example.com/connect
```

HTTP Basic credentials:

- username: `owner`
- password: `OWNER_ACCESS_PASSWORD` from `.env.production`

Choose **Connect / reconnect Threads**, then grant access in the provider OAuth screen.

## 8. Configure the plugin/MCP client

The bundled plugin reads the MCP bearer token from:

```text
THO_SOCIAL_PUBLISHER_MCP_TOKEN
```

Set that environment variable to the same value as server-side `MCP_AUTH_TOKEN`.

Never commit either value. Copy `.local/client/` to your other computers and follow [PLUGIN_SETUP.md](PLUGIN_SETUP.md). Each computer uses the same endpoint and token; provider credentials and PostgreSQL remain on the server. You do not need to authorize Threads again on each computer.

## Updating

```bash
git pull --ff-only
docker compose --env-file .env.production up -d --build
```

Migrations run before the application starts.

Before major updates, back up the PostgreSQL volume/database.
