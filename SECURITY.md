# Security Policy

Tho Social Publisher handles highly sensitive OAuth credentials and publishing permissions. Security regressions should be treated as release blockers.

## Never commit secrets

Do not commit:

- OAuth client secrets
- access or refresh tokens
- authorization codes
- token-encryption keys
- database passwords
- service-account files
- production environment files
- database dumps containing account data

Use `.env.example` for variable names only.

## Token storage

Provider tokens must be encrypted at rest with authenticated encryption. Production encryption keys must live outside the repository and outside the database they protect.

Tokens and secrets must never appear in application logs.

## OAuth requirements

Provider integrations should implement, where applicable:

- state validation
- PKCE
- exact redirect URI validation
- least-privilege scopes
- token expiry tracking
- refresh
- revocation / disconnect
- replay-resistant callback handling

## Public repository assumptions

Treat every source file, test fixture, workflow log, issue, and pull request as public.

Use fake credentials in examples and tests.

## Reporting vulnerabilities

Please avoid publishing exploitable credential-handling vulnerabilities in a public issue.

Open a private GitHub security advisory for this repository when available, or contact the maintainer privately through the contact method listed on the maintainer's GitHub profile.

Include:

- affected component
- reproduction steps
- impact
- suggested mitigation, if known

Do not include real access tokens or account credentials in reports.
