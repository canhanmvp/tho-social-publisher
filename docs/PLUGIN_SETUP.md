# Client and multi-machine setup

Each owner runs their own Tho Social Publisher server. Any number of that owner's trusted computers can connect to the same server. They share connected accounts, publication history, and scheduled jobs.

## Configure your endpoint

The repository's root `mcp.json` targets `http://localhost:3000/mcp` for local development. On a different computer, localhost means that computer, not your server. No maintainer-owned server is required.

After deploying your server, generate client files:

```bash
npm run client:configure -- --url https://social.example.com/mcp
```

Server setup also generates these files automatically:

```bash
npm run setup -- --domain social.example.com
```

The generated directory is:

```text
.local/client/
  codex.toml
  README.md
  plugin/
    plugin.json
    mcp.json
    skills/social-publisher/SKILL.md
```

Copy `.local/client/` to your other trusted machines. Alternatively, clone the repository on a client, run `npm install` and `client:configure`; this command needs no server environment, database, or Threads credentials. Client generation does not edit the repository's root manifest or the host's settings.

The generated package uses the exact URL you supply and reads its bearer token from `THO_SOCIAL_PUBLISHER_MCP_TOKEN`. HTTPS is required for remote URLs; HTTP is accepted only for loopback development. URLs containing credentials, query strings, or fragments are rejected.

Generated client files contain no secrets. Do not copy `.env.production`, database backups, Meta secrets, or the token-encryption key to client machines.

## Connect Codex directly

Merge the generated `codex.toml` section into your user `~/.codex/config.toml` (on Windows, `%USERPROFILE%\.codex\config.toml`). Preserve other settings and replace an existing section with the same server name instead of adding it twice:

```toml
[mcp_servers.tho_social_publisher]
url = "https://social.example.com/mcp"
bearer_token_env_var = "THO_SOCIAL_PUBLISHER_MCP_TOKEN"
```

Set `THO_SOCIAL_PUBLISHER_MCP_TOKEN` privately on each machine to the server's `MCP_AUTH_TOKEN`. For the CLI, examples for the current shell are:

```bash
# Bash: enter the token privately at the prompt, not in a command.
read -r -s -p 'MCP token: ' THO_SOCIAL_PUBLISHER_MCP_TOKEN
export THO_SOCIAL_PUBLISHER_MCP_TOKEN
codex
```

```powershell
# PowerShell: enter the token at a masked prompt.
$publisherToken = Read-Host 'MCP token' -AsSecureString
$env:THO_SOCIAL_PUBLISHER_MCP_TOKEN = [System.Net.NetworkCredential]::new('', $publisherToken).Password
codex
```

These values last only for the current shell and processes started from it. For desktop or IDE clients, configure the variable in their launch environment and fully restart the client; setting a variable in an unrelated terminal does not update an already running app. Do not store a literal token in the generated config or Git.

Verify with `codex mcp list`, then ask the connected client to list social accounts. The MCP configuration fields follow [official OpenAI documentation](https://developers.openai.com/codex/mcp/).

## Use the portable plugin

Load the generated `.local/client/plugin/` folder using a plugin host that supports portable Agent Plugins and local packages. Host installation methods and availability differ; generating the folder does not install it automatically or publish it to a marketplace. The package format follows [official plugin documentation](https://developers.openai.com/plugins/build/plugins).

Supply the same bearer-token environment variable through the host's supported credential mechanism. Use either the plugin connection or the direct MCP configuration in a given client to avoid duplicate tool registrations.

For ChatGPT, use a supported custom MCP connection flow for your account/workspace and provide your HTTPS endpoint and supported authentication there. Local shell variables are not automatically available to a cloud client. This server implements bearer authentication; it does not implement MCP OAuth discovery or per-user login. If the client cannot supply a static bearer token, use a compatible client instead of removing server authentication.

## First connection and additional computers

1. On the server, configure your Threads developer app and register the exact callback URI.
2. Open `https://social.example.com/connect` and sign in as `owner` using `OWNER_ACCESS_PASSWORD` from the server environment.
3. Authorize your Threads account once.
4. On each computer, configure the same MCP URL and privately supply the MCP bearer token.
5. Call `list_social_accounts`; the connected account should appear on every machine.

Client computers do not need Docker, PostgreSQL, Threads app credentials, or provider tokens when using the copied config. Scheduling runs on the server even when clients close. Keep the server and database online.

All holders of the MCP token have access to the same owner instance and can publish, schedule, and disconnect its accounts. This supports your own trusted machines, not isolated unrelated users on one shared endpoint. Other owners deploy their own instance. Losing a trusted client requires rotating `MCP_AUTH_TOKEN` and updating the remaining clients; no per-device token revocation is implemented yet.

## Updates

Update and rebuild the server using [DEPLOYMENT.md](DEPLOYMENT.md). Keep its `.env.production` and database. Rerun `client:configure` when the endpoint or bundled skill changes, then replace the copied client package and restart the client. Changing plugin files does not update existing sessions automatically.
