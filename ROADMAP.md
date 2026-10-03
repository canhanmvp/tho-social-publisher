# Roadmap

This roadmap is intentionally capability-driven rather than date-driven.

## Phase 0 — Repository foundation

- [x] Public MIT-licensed repository
- [x] OSS project brief
- [x] Security policy
- [x] Contributor guidance
- [x] Agent development instructions
- [x] Environment template
- [x] TypeScript workspace
- [x] Docker Compose
- [x] PostgreSQL migrations
- [x] MCP server skeleton
- [x] Connection UI skeleton
- [x] CI: lint, typecheck, tests, secret scanning
- [x] MCP bearer authentication
- [x] owner authentication for the connection UI

## Phase 1 — Threads end-to-end

- [x] Verify current Threads OAuth, publishing, profile, media-status, and quota contracts
- [x] OAuth authorization URL
- [x] OAuth callback/state validation
- [x] account discovery via authenticated profile
- [x] encrypted token storage
- [x] long-lived token exchange
- [x] long-lived token refresh client
- [x] text publishing with official API
- [x] single-image publishing
- [x] dynamic publishing quota check
- [x] MCP `connect_social_account`
- [x] MCP `disconnect_social_account` (local credential purge)
- [x] MCP `publish_post`
- [x] scheduled publishing with pg-boss
- [x] MCP `schedule_post`
- [x] MCP `list_scheduled_posts`
- [x] MCP `get_post_status`
- [x] MCP `get_recent_posts`
- [x] MCP `cancel_scheduled_post`
- [x] bounded retry with exponential backoff
- [x] exact duplicate-content fingerprinting across accounts on the same provider
- [x] explicit duplicate override for intentional reuse
- [ ] provider-side authorization revocation (only after an official Threads revocation contract is verified)
- [ ] live end-to-end verification with a real Meta Threads app
- [ ] video publishing
- [ ] carousel publishing
- [ ] provider integration tests against a disposable test account

Exit criterion: OAuth -> publish -> schedule -> refresh works reliably without manual token handling.

## Phase 2 — Meta expansion

### Instagram

- [ ] eligible account discovery
- [ ] image publishing
- [ ] carousel publishing
- [ ] Reels publishing where officially supported
- [ ] runtime quota checks

### Facebook

- [ ] Page discovery
- [ ] Page publishing
- [ ] media publishing where officially supported

## Phase 3 — Additional providers

### LinkedIn

- [ ] OAuth
- [ ] supported member publishing
- [ ] organization publishing where approved

### TikTok

- [ ] OAuth
- [ ] official Content Posting API
- [ ] production/app-review documentation

### X

- [ ] OAuth
- [ ] publishing adapter subject to current official API access

## Phase 4 — Reliability

- [x] exact duplicate-content fingerprinting
- [x] atomic duplicate reservations across concurrent requests
- [x] recover confirmed scheduled publications without republishing
- [x] provider request deadlines and worker cancellation
- [x] reconcile interrupted and terminal queue jobs with local status
- [ ] semantic-similarity warnings
- [ ] account-specific posting budgets
- [ ] dead-letter operations
- [ ] provider health state
- [ ] audit logs
- [ ] observability / metrics
- [ ] backup / restore documentation

## Phase 5 — Developer experience

- [x] portable Agent Plugins manifest
- [x] bundled social-publisher skill
- [x] remote MCP bearer-token configuration
- [x] production environment generator
- [x] repeatable self-hosted setup preserving existing secrets
- [x] client configuration generator for owner-selected MCP URLs
- [x] multi-machine setup instructions
- [x] VPS + Caddy deployment guide
- [x] direct Codex MCP configuration guide
- [ ] one-command deployment
- [ ] guided OAuth connection UI
- [ ] release automation
- [ ] architecture diagram
