# Contributing

Contributions are welcome.

## Ground rules

Provider integrations must use official, documented APIs. Pull requests that rely on browser automation, private endpoints, credential scraping, or bypasses for provider restrictions will not be accepted.

## Before working on a provider

Please verify the provider's current official documentation and document:

- supported account types
- required OAuth scopes
- token lifecycle
- publishing capabilities
- known quotas / rate-limit behavior
- app-review or production-access requirements

Do not copy stale values from blog posts or old SDK examples without verification.

## Development expectations

- TypeScript strict mode
- lint / format checks
- unit tests for core logic
- integration-style provider tests using mocks
- no production credentials in tests
- clear error messages for unsupported provider/account combinations
- documentation updated with behavior changes

## Pull requests

Keep PRs focused. Include:

1. what changed
2. why
3. how it was tested
4. provider documentation consulted
5. security / permission changes
6. screenshots or example MCP calls when useful

## Security-sensitive changes

Changes to OAuth, token storage, authorization, encryption, or logging require extra scrutiny. See [SECURITY.md](SECURITY.md).
