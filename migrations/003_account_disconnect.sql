ALTER TABLE oauth_accounts
  ALTER COLUMN access_token_encrypted DROP NOT NULL;

ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS disconnected_at timestamptz;
