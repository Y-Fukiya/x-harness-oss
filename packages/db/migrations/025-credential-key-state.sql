CREATE TABLE IF NOT EXISTS credential_key_state (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  key_version TEXT NOT NULL,
  encrypted_canary TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
