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

- [x] Verify current Threads OAuth, publishing, profile, and long-lived token contracts
- [x] OAuth authorization URL
- [x] OAuth callback/state validation
- [x] account discovery via authenticated profile
- [x] encrypted token storage
- [x] long-lived token exchange
- [x] long-lived token refresh client
- [x] text publishing with official API
- [x] text reply publishing through `reply_to_id`
- [x] MCP `connect_social_account`
- [x] MCP `publish_post` for Threads text
- [ ] live end-to-end verification with a real Meta Threads app
- [ ] image publishing
- [ ] scheduled publishing with pg-boss
- [ ] publishing quota / error handling
- [ ] disconnect / token revocation
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

- [ ] duplicate-content fingerprinting
- [ ] account-specific posting budgets
- [ ] bounded retries + dead-letter handling
- [ ] provider health state
- [ ] audit logs
- [ ] observability / metrics
- [ ] backup / restore documentation

## Phase 5 — Developer experience

- [ ] one-command local setup
- [ ] guided OAuth connection UI
- [ ] example Codex / ChatGPT MCP configuration
- [ ] release automation
- [ ] sample deployment recipes
- [ ] architecture diagram
