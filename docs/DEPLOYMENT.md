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

The owner deployment used by the bundled plugin is:

```text
social.thodigitals.com
```

Forks should replace that hostname in `mcp.json` with their own production MCP URL.

## 2. Clone and install

```bash
git clone https://github.com/canhanmvp/tho-social-publisher.git
cd tho-social-publisher
npm install
```

## 3. Generate production secrets

```bash
npm run env:generate -- --domain social.thodigitals.com
```

This creates `.env.production` with file mode `0600`. The script generates independent random values for:

- MCP bearer token
- owner UI password
- PostgreSQL password
- token-encryption key

The values are written to the file and are not printed to stdout.

Do not commit `.env.production`.

## 4. Add Threads developer credentials

Edit `.env.production` and set:

```env
THREADS_CLIENT_ID=
THREADS_CLIENT_SECRET=
```

The generated redirect URI will be:

```text
https://social.thodigitals.com/oauth/threads/callback
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
export DOMAIN=social.thodigitals.com
export APP_PORT=3000
```

Use the Caddy deployment mechanism appropriate for the host. Confirm HTTPS works:

```bash
curl https://social.thodigitals.com/health
```

Do not expose PostgreSQL or the Docker app port directly to the public internet.

## 7. Connect Threads

Open:

```text
https://social.thodigitals.com/connect
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

Never commit either value.

## Updating

```bash
git pull --ff-only
docker compose --env-file .env.production up -d --build
```

Migrations run before the application starts.

Before major updates, back up the PostgreSQL volume/database.
