CREATE TABLE IF NOT EXISTS external_mutation_operations (
  connection_id TEXT NOT NULL REFERENCES line_connections(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'outcome_unknown', 'retry_authorized')),
  response_status INTEGER,
  response_content_type TEXT,
  response_body_encrypted TEXT,
  lease_expires_at TEXT NOT NULL,
  transition_nonce TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_external_mutation_operations_status
  ON external_mutation_operations(status, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_external_mutation_unresolved_request
  ON external_mutation_operations(connection_id, request_hash)
  WHERE status IN ('pending', 'outcome_unknown');
