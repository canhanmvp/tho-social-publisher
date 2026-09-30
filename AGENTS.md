# AGENTS.md

Instructions for Codex and other coding agents working on this repository.

## Mission

Build a reliable, self-hosted social publishing MCP that lets the owner connect social accounts through official OAuth flows and publish or schedule posts through a small provider-agnostic tool surface.

This is an open-source infrastructure project, not a multi-tenant SaaS.

## Non-goals

Do not add:

- billing
- subscriptions
- multi-tenant SaaS onboarding
- browser automation to imitate posting
- undocumented/private provider endpoints
- mechanisms intended to bypass provider rate limits, app review, permissions, or anti-spam controls
- provider credentials committed to the repository

## Architecture boundaries

Preferred stack:

- TypeScript
- Node.js
- Hono or Fastify
- official MCP TypeScript SDK
- PostgreSQL
- pg-boss
- Docker Compose

Do not add Redis unless a concrete technical requirement justifies it.

Keep provider-specific behavior behind adapters. MCP tools must remain high level.

## MCP tool surface

Target tools:

- list_social_accounts
- connect_social_account
- disconnect_social_account
- publish_post
- schedule_post
- list_scheduled_posts
- cancel_scheduled_post
- get_post_status
- get_recent_posts

Do not expose every raw provider endpoint as its own MCP tool.

## Provider implementation order

1. Threads
2. Instagram
3. Facebook
4. LinkedIn
5. TikTok
6. X

Do not start Instagram/Facebook implementation until Threads works end-to-end:

OAuth -> account discovery -> publish -> scheduled publish -> token refresh -> error/quota handling.

## Official documentation rule

Before implementing any provider API behavior, verify the CURRENT official provider documentation.

Never guess:

- endpoint names
- OAuth scopes
- token lifetimes
- account eligibility
- upload constraints
- publishing quotas
- app-review requirements

If official documentation conflicts with existing code, stop and document the discrepancy before changing behavior.

## Security requirements

- OAuth state validation is mandatory.
- Use PKCE where the provider supports it.
- Encrypt provider tokens at rest using authenticated encryption.
- Never log access tokens, refresh tokens, client secrets, authorization codes, or encryption keys.
- Validate redirect URIs exactly.
- Use least-privilege scopes.
- Implement refresh and revocation paths where supported.
- Add per-account isolation even in single-owner mode.
- Treat every environment variable as potentially sensitive.
- Repository content must remain safe to publish publicly.

## Scheduling

Codex/ChatGPT must never wait until posting time.

schedule_post persists a job. A backend worker executes it independently.

Expected states:

- scheduled
- processing
- published
- failed
- cancelled

Use bounded retries with exponential backoff and preserve provider error metadata without storing secrets.

## Anti-spam / safety behavior

The project should support multiple connected accounts but must not optimize for coordinated spam.

Implement guardrails for:

- duplicate-content detection
- per-account posting budgets
- provider quota checks
- exponential backoff
- disabling repeated failing jobs
- audit logging

Cross-posting one brand campaign across different networks is distinct from blasting near-identical content across many accounts on the same network.

## Testing

Before a provider is considered implemented, add tests for:

- OAuth state handling
- callback validation
- token encryption/decryption
- token refresh
- publishing success/failure
- retries
- scheduler execution
- provider error normalization

Use mocks for automated tests. Never depend on production credentials in CI.

## Development workflow

For substantial work:

1. assess current repository state
2. verify official provider docs
3. update or create a short implementation plan
4. implement the smallest end-to-end slice
5. test
6. update docs and roadmap
7. summarize security or policy implications

Prefer small, reviewable commits.
