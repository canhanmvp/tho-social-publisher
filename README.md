# Tho Social Publisher

Open-source, self-hosted social publishing infrastructure for AI agents, Codex, ChatGPT, and other MCP clients.

Connect your own social accounts through OAuth, then publish or schedule content through a small, provider-agnostic MCP interface using official platform APIs.

> Status: early development. The project is being built in public and is not production-ready yet.

## Self-host once, connect from many machines

Anyone can run their own installation. Each owner brings their own Threads developer-app credentials and connects their accounts through OAuth. There is no required shared service or maintainer-owned endpoint.

One always-on server holds the database, provider credentials, publication history, and scheduled jobs. Connect all your trusted computers to that same server; they do not need their own database or Threads app. Scheduled posts run even when those computers are off.

On the server, with Node.js 22.12+, npm 11+, Docker Compose, and a hostname you control:

```bash
git clone https://github.com/canhanmvp/tho-social-publisher.git
cd tho-social-publisher
npm install
npm run setup -- --domain social.example.com
```

Setup creates `.env.production` and client files in `.local/client/`. Rerunning it preserves existing secrets. Add your Threads app credentials to `.env.production`, register its callback URI in Meta, configure DNS and HTTPS, then start:

```bash
docker compose --env-file .env.production up -d --build
```

Check `/health` and `/ready`, then open `https://social.example.com/connect` to authorize Threads. Follow [deployment](docs/DEPLOYMENT.md) for the complete steps.

For another computer, copy `.local/client/` or generate it using:

```bash
npm run client:configure -- --url https://social.example.com/mcp
```

Only the MCP URL and bearer token are needed on clients. Generated client files contain no secrets; supply the token privately on each machine. See [client and multi-machine setup](docs/PLUGIN_SETUP.md). The repository's root `mcp.json` defaults to localhost for development; use the generated client package for your remote server.

Currently implemented: Threads text, one image, and scheduled publishing. Installing the plugin alone does not deploy a server or configure a Meta app.

## Why this project exists

Most social schedulers put account count, posting volume, automation, or API access behind paid tiers. Tho Social Publisher takes a different approach:

- self-host the publishing backend
- bring your own provider developer credentials
- connect multiple accounts through OAuth
- expose a small MCP tool surface to AI agents
- keep scheduling and token refresh on the server, not inside the agent
- use official APIs only
- avoid vendor-specific limits imposed by third-party schedulers

The goal is not to bypass platform rules or rate limits. Provider policies, permissions, quotas, and anti-spam rules still apply.

## Design principles

- **Self-host first** — your server, database, credentials, and account data
- **Official APIs only** — no browser automation or undocumented endpoints
- **Provider-agnostic MCP** — agents should not need to understand every social API
- **OAuth by default** — users grant access directly to each provider
- **Secure token storage** — access and refresh tokens must never be committed or stored in plaintext
- **Server-side scheduling** — scheduled jobs run independently of Codex/ChatGPT
- **Multi-account capable** — no artificial application-level account cap
- **Anti-spam aware** — publishing safeguards should discourage duplicate blast behavior

## Planned providers

| Provider  | Priority | Planned capabilities                                        |
| --------- | -------- | ----------------------------------------------------------- |
| Threads   | P0       | OAuth, text, image, replies, scheduling                     |
| Instagram | P0       | Professional account publishing, image, carousel, Reels     |
| Facebook  | P0       | Page publishing                                             |
| LinkedIn  | P1       | Member / organization publishing where officially supported |
| TikTok    | P2       | Official Content Posting API where approved                 |
| X         | P3       | Official API support subject to current access requirements |

Capabilities are implemented only when supported by the provider's current official API and the connected account's permissions.

## High-level architecture

```text
Codex / ChatGPT / MCP client
            |
            v
     MCP over HTTPS
            |
            v
+---------------------------+
| Tho Social Publisher      |
|                           |
| OAuth connection hub      |
| MCP tool layer            |
| Provider adapters         |
| Scheduler / worker        |
| Policy & quota guards     |
+-------------+-------------+
              |
              v
         PostgreSQL
              |
      +-------+-------+
      |       |       |
   Threads    IG    Facebook ...
```

Scheduling belongs to the backend. An agent creates a scheduled job and can disconnect; the worker publishes at the requested time.

## Planned MCP tools

The public tool surface should remain intentionally small:

```text
list_social_accounts
connect_social_account
disconnect_social_account

publish_post
schedule_post
list_scheduled_posts
cancel_scheduled_post

get_post_status
get_recent_posts
```

Provider-specific complexity stays behind adapters.

## Security model

This repository is public. Assume every committed file can be read by anyone.

Never commit:

- OAuth client secrets
- access tokens or refresh tokens
- encryption keys
- database credentials
- production `.env` files
- provider service credentials
- database dumps
- private logs containing credentials

Each self-hosted installation should use its **own provider developer-app credentials**.

See [SECURITY.md](SECURITY.md) for the security policy.

## Proposed stack

- TypeScript
- Node.js
- Hono or Fastify
- Model Context Protocol TypeScript SDK
- PostgreSQL
- pg-boss for jobs / scheduled publishing
- Docker Compose
- Caddy or another HTTPS reverse proxy

Redis is intentionally not required for the initial architecture.

## Development order

The first milestone is intentionally narrow:

```text
Threads OAuth
    -> account discovery
    -> publish
    -> scheduled publish
    -> token refresh
    -> quota / error handling
```

Only after that path works end-to-end should additional providers be added.

See [ROADMAP.md](ROADMAP.md).

## Local configuration

A safe starter template is provided in [`.env.example`](.env.example).

```bash
cp .env.example .env
```

Do not reuse production secrets in local development.

Blank optional settings are treated as unset. Threads remains disabled until its app credentials are provided; production still requires MCP and owner authentication.

See [publishing reliability](docs/PUBLISHING_RELIABILITY.md) for retry behavior, duplicate reservations, and recovery after uncertain publication outcomes.

## Contributing

Issues and pull requests are welcome. Provider integrations must use official, documented APIs.

Before adding or changing a provider integration:

1. verify the provider's current official documentation
2. document required scopes and account eligibility
3. add tests for OAuth, token refresh, publishing, and error handling
4. never add workarounds intended to bypass provider restrictions

See [CONTRIBUTING.md](CONTRIBUTING.md).

## AI-agent development

If you use Codex or another coding agent on this repository, read [AGENTS.md](AGENTS.md) first. It defines architecture boundaries, security requirements, and implementation order.

## License

MIT — use it, fork it, modify it, or build on it.

See [LICENSE](LICENSE).

## Disclaimer

This project is independent and is not affiliated with, endorsed by, or sponsored by Meta, TikTok, LinkedIn, X, OpenAI, or any other platform provider.

Users are responsible for complying with the terms, API policies, rate limits, content rules, and developer requirements of every connected platform.
