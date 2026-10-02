-- A reservation bridges the gap between duplicate checking and accepting a
-- publication. Keep uncertain outcomes until their duplicate window elapses.
CREATE TABLE publishing_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  social_account_id uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  content_fingerprint text NOT NULL,
  target_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX publishing_reservations_fingerprint_time_idx
  ON publishing_reservations(provider, content_fingerprint, target_at);
