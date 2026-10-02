# Publishing reliability

The reliability fixes follow this implementation plan:

1. Normalize blank optional environment settings without weakening production authentication.
2. Bound provider I/O and propagate queue cancellation through refresh, quota, image processing, and publishing.
3. Recover confirmed publications using their remote IDs; save scheduled state and history atomically.
4. Reserve duplicate fingerprints atomically across server instances before accepting work.
5. Cover these failure paths with mocked regression tests and document operational recovery.

## Retry behavior

Scheduled posts retry confirmed transient failures at most three times, using the existing exponential backoff. Once Threads returns a post ID, retries perform only database persistence; they do not publish again. Scheduled state and publication history are committed in one SQL statement.

A publication timeout, transport failure, malformed success response, or HTTP 5xx does not prove that Threads rejected the post. These outcomes fail with `ThreadsPublicationUncertainError` and require checking the actual account before resubmission. This is a conservative delivery policy, not a claim of exactly-once delivery across PostgreSQL and Threads.

After an interrupted attempt with no saved result, the scheduler does not claim the processing row again. At startup and every minute, it reconciles stale local records with terminal pg-boss jobs. Records with known remote IDs recover their publication history; interrupted records without an ID become failed with an explicit uncertainty message. Queue rows still marked active or retrying are left alone.

Provider requests have a 15-second deadline; an entire publication has a 120-second deadline, below the 180-second queue expiry. Worker cancellation stops pending requests and image polling. Database statements also have bounded execution time.

## Concurrent duplicate protection

Migration `005_publishing_reservations.sql` adds durable fingerprint reservations. A transaction-scoped PostgreSQL advisory lock serializes the duplicate check and reservation for a provider/fingerprint pair. Provider calls execute after the transaction commits, without holding the database lock.

Successful immediate publications and accepted scheduled posts release their reservations after history or the scheduled record is persisted. Confirmed failures release them as well. Uncertain immediate publications retain reservations, and uncertain failed scheduled publications remain duplicate conflicts. An explicit `allow_duplicate=true` still permits intentional reuse.

Reservations are considered only inside the configured duplicate window. Records older than the maximum supported 168-hour window are cleaned up during reservation creation. A crash before acceptance can conservatively block content even if no post was created. Check the provider account before using the intentional duplicate override; an uncertainty error is not permission to republish blindly.

## Deployment and verification

Apply migration 005 before starting the updated application. Docker deployment runs migrations automatically. Back up the database before updating. Existing publication history is preserved and used for recovery.

Blank optional settings in `.env.example` and Docker Compose now load as unset. A redirect URI alone does not enable Threads. Adding only one provider credential, or credentials without a redirect URI, still fails configuration validation. Production MCP and owner authentication remain mandatory.

The automated suite uses mocks and does not require production credentials. A separate local PGlite SQL smoke check verified migrations 001–005, atomic history/status persistence and rollback, exclusive processing claims, known-ID recovery, and reservation conflicts. Live Threads and PostgreSQL server deployment verification remains a separate integration check. Provider endpoints and scopes remain the ones documented in [Meta's official Threads API collection](https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api).
