CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE oauth_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_subject_id text NOT NULL,
  account_name text NOT NULL,
  access_token_encrypted text NOT NULL,
  refresh_token_encrypted text,
  expires_at timestamptz,
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reauth_required', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject_id)
);

CREATE TABLE social_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oauth_account_id uuid NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  account_name text NOT NULL,
  account_type text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reauth_required', 'disabled')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_account_id)
);

CREATE INDEX social_accounts_oauth_account_id_idx ON social_accounts(oauth_account_id);

CREATE TABLE oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  state_hash text NOT NULL UNIQUE,
  code_verifier_encrypted text,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX oauth_states_expiry_idx ON oauth_states(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE scheduled_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  social_account_id uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  body_text text NOT NULL DEFAULT '',
  media jsonb NOT NULL DEFAULT '[]'::jsonb,
  link text,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'processing', 'published', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  content_fingerprint text,
  provider_post_id text,
  last_error jsonb,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX scheduled_posts_due_idx ON scheduled_posts(status, scheduled_at);
CREATE INDEX scheduled_posts_account_idx ON scheduled_posts(social_account_id, created_at DESC);

CREATE TABLE published_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  social_account_id uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  scheduled_post_id uuid REFERENCES scheduled_posts(id) ON DELETE SET NULL,
  provider_post_id text NOT NULL,
  body_text text NOT NULL DEFAULT '',
  media jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_response jsonb,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_post_id, social_account_id)
);

CREATE INDEX published_posts_account_idx ON published_posts(social_account_id, published_at DESC);
