# OAuth setup

Tho Social Publisher is self-hosted. Each installation uses its own provider developer-app credentials.

## Threads

The implementation follows Meta's current Threads OAuth and publishing flow:

1. browser authorization at `https://threads.net/oauth/authorize`
2. exchange the returned code with `POST https://graph.threads.net/oauth/access_token`
3. exchange the short-lived token for a long-lived token using `GET https://graph.threads.net/access_token?grant_type=th_exchange_token`
4. read the authenticated profile from `GET https://graph.threads.net/me`
5. publish text using `POST https://graph.threads.net/me/threads` with `auto_publish_text=true`
6. create IMAGE or VIDEO media containers through `POST /me/threads`
7. publish single media through `POST /me/threads_publish` after the container is ready
8. build carousels by creating 2-20 image/video child containers with `is_carousel_item=true`, creating a CAROUSEL parent with the ordered child IDs, then publishing the parent
9. inspect the live publishing budget using `GET /me/threads_publishing_limit?fields=quota_usage,config`
10. refresh unexpired long-lived tokens with `GET https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token`

The initial publishing scopes are intentionally minimal:

- `threads_basic`
- `threads_content_publish`

Reply-management scopes are deliberately not requested by the initial implementation.

### Media behavior

Media URLs must be public HTTPS URLs because Threads fetches the media from the supplied URL.

The MCP `media` array accepts:

```json
[
  {
    "type": "image",
    "url": "https://cdn.example.com/image.jpg",
    "alt_text": "optional alt text"
  }
]
```

or video:

```json
[
  {
    "type": "video",
    "url": "https://cdn.example.com/video.mp4",
    "alt_text": "optional alt text"
  }
]
```

Two through twenty media items become a carousel and preserve the supplied order.

### Human setup in Meta

Create or select a Meta developer app with the Threads use case, then obtain the Threads App ID and Threads App Secret from the Threads app settings.

Register the exact redirect URI used by this server. For local development the example is:

```text
http://localhost:3000/oauth/threads/callback
```

For production it should be HTTPS, for example:

```text
https://social.example.com/oauth/threads/callback
```

The configured redirect URI must be identical in Meta and in `THREADS_REDIRECT_URI`.

During development, add the Threads account that will authorize the app as an allowed tester/app user when Meta requires it for non-public app access.

### Environment

```env
THREADS_CLIENT_ID=
THREADS_CLIENT_SECRET=
THREADS_REDIRECT_URI=https://social.example.com/oauth/threads/callback
TOKEN_ENCRYPTION_KEY=
OWNER_ACCESS_PASSWORD=
MCP_AUTH_TOKEN=
JOB_CONCURRENCY=2
```

Generate independent random values for `TOKEN_ENCRYPTION_KEY`, `OWNER_ACCESS_PASSWORD`, and `MCP_AUTH_TOKEN`. Never reuse the Meta app secret as an application security key.

### Connect

Open:

```text
https://social.example.com/connect
```

HTTP Basic credentials:

- username: `owner`
- password: the value of `OWNER_ACCESS_PASSWORD`

Then choose **Connect / reconnect Threads** and approve the Threads authorization screen.

Alternatively, an authenticated MCP client can call `connect_social_account` with provider `threads` and present the returned authorization URL to the human owner.

## Security notes

- Raw OAuth `state` values are not stored; only SHA-256 hashes are persisted.
- OAuth states are single-use and expire after ten minutes.
- Access tokens are encrypted with AES-256-GCM before database persistence.
- Provider tokens are never returned by MCP tools.
- The MCP endpoint requires a separate bearer token.
- The account connection UI requires separate owner Basic authentication.
- Media URLs are passed to the provider; the MCP schema accepts HTTPS URLs only.
