# Codex / ChatGPT plugin setup

Tho Social Publisher includes a portable Agent Plugins package:

```text
plugin.json
mcp.json
skills/social-publisher/SKILL.md
```

The portable format is designed to be usable by plugin hosts including Codex and ChatGPT.

## Production server

The bundled `mcp.json` targets:

```text
https://social.thodigitals.com/mcp
```

Self-hosted forks should change this URL to their own HTTPS MCP endpoint.

The MCP connection uses a bearer token supplied through the environment variable:

```text
THO_SOCIAL_PUBLISHER_MCP_TOKEN
```

Set it to the same secret used as `MCP_AUTH_TOKEN` on the server.

The secret is intentionally not stored in the plugin manifest.

## Direct Codex MCP configuration

You can use the MCP server without installing the plugin package.

Export the token before starting Codex:

```bash
export THO_SOCIAL_PUBLISHER_MCP_TOKEN="<same value as MCP_AUTH_TOKEN>"
```

Add the remote server to `~/.codex/config.toml`:

```toml
[mcp_servers.tho_social_publisher]
url = "https://social.thodigitals.com/mcp"
bearer_token_env_var = "THO_SOCIAL_PUBLISHER_MCP_TOKEN"
```

Then verify:

```bash
codex mcp list
```

Codex CLI and the IDE extension share MCP configuration.

## Skill behavior

The bundled skill tells the agent to:

- resolve real account IDs before write actions
- use server-side scheduling instead of waiting/sleeping
- avoid identical same-provider multi-account blasts
- keep duplicate override disabled unless the user explicitly requests it
- surface provider quota/auth/policy errors rather than bypassing them
- never ask the user to paste provider access tokens into chat

## ChatGPT developer mode

For development/testing, register the deployed HTTPS `/mcp` endpoint in ChatGPT developer mode and provide the connection authentication there.

Use a new chat after changing plugin files or MCP metadata so the client reloads the tool definitions.
