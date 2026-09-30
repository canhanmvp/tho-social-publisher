---
name: social-publisher
description: Publish, schedule, inspect, and manage the user's connected social accounts through Tho Social Publisher.
---

Use the `tho_social_publisher` MCP server for social publishing work.

## Operating rules

1. When the target account is not unambiguous, call `list_social_accounts` before any write action. Never invent an account ID.
2. Treat `publish_post`, `schedule_post`, `cancel_scheduled_post`, and `disconnect_social_account` as external side effects.
3. Preserve the user's requested wording and media unless they explicitly ask you to rewrite or adapt it.
4. Do not blast identical content across multiple accounts on the same provider. Keep `allow_duplicate=false` unless the user explicitly requests intentional duplicate reuse after seeing the duplicate warning.
5. Cross-platform reuse is allowed, but adapt content when the user asks for platform-specific copy.
6. Use `schedule_post` for future publication. Do not wait or sleep until the scheduled time; the server-side worker owns execution.
7. Use `get_post_status` when checking a scheduled publication and `get_recent_posts` for local publication history.
8. If a provider reports quota, authentication, permission, or policy errors, surface the provider error clearly and do not try to bypass it.
9. Do not request, reveal, log, or place OAuth access tokens, refresh tokens, provider client secrets, or the MCP bearer token in content.
10. Threads is currently the first implemented publishing provider. Do not pretend unsupported providers can publish.

## Recommended sequence

For an immediate post:

`list_social_accounts -> publish_post`

For a scheduled post:

`list_social_accounts -> schedule_post -> get_post_status`

For connecting an account:

`connect_social_account -> present the authorization URL to the human owner -> wait for the human to grant access`

The human must complete provider OAuth themselves. Never ask them to paste provider access tokens into chat.
