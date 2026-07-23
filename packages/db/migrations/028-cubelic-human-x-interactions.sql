CREATE TABLE IF NOT EXISTS cubelic_interaction_fingerprint_key_state (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  key_version TEXT NOT NULL,
  key_commitment TEXT NOT NULL CHECK (
    length(key_commitment) = 64
    AND key_commitment NOT GLOB '*[^0-9a-f]*'
  ),
  transition_nonce TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS cubelic_interaction_fingerprint_key_state_no_update
BEFORE UPDATE ON cubelic_interaction_fingerprint_key_state
BEGIN
  SELECT RAISE(ABORT, 'interaction fingerprint key rotation requires an explicit migration');
END;

CREATE TRIGGER IF NOT EXISTS cubelic_interaction_fingerprint_key_state_no_delete
BEFORE DELETE ON cubelic_interaction_fingerprint_key_state
BEGIN
  SELECT RAISE(ABORT, 'interaction fingerprint key state is append-preserved');
END;

CREATE TABLE IF NOT EXISTS cubelic_human_x_interactions (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('reply','dm_reply','like','follow','unfollow')),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  interaction_fingerprint TEXT NOT NULL UNIQUE CHECK (
    length(interaction_fingerprint) = 64
    AND interaction_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  approval_fingerprint TEXT NOT NULL UNIQUE CHECK (
    length(approval_fingerprint) = 64
    AND approval_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  operator_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('executing','completed','failed','outcome_unknown')),
  failure_code TEXT,
  transition_nonce TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cubelic_human_x_interactions_status
  ON cubelic_human_x_interactions(status, updated_at);

CREATE TRIGGER IF NOT EXISTS cubelic_human_x_interactions_emergency_stop_insert
BEFORE INSERT ON cubelic_human_x_interactions
WHEN COALESCE(
  (SELECT value = 'false' FROM cubelic_system_flags WHERE key = 'emergency_stop'),
  0
) = 0
BEGIN
  SELECT RAISE(ABORT, 'emergency stop active');
END;

CREATE TRIGGER IF NOT EXISTS cubelic_human_x_interactions_no_delete
BEFORE DELETE ON cubelic_human_x_interactions
BEGIN
  SELECT RAISE(ABORT, 'human X interaction records are append-preserved');
END;

CREATE TRIGGER IF NOT EXISTS cubelic_human_x_interactions_identity_immutable
BEFORE UPDATE ON cubelic_human_x_interactions
WHEN NEW.operation_id IS NOT OLD.operation_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.interaction_fingerprint IS NOT OLD.interaction_fingerprint
  OR NEW.approval_fingerprint IS NOT OLD.approval_fingerprint
  OR NEW.operator_id IS NOT OLD.operator_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'human X interaction identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS cubelic_human_x_interactions_terminal_transition
BEFORE UPDATE ON cubelic_human_x_interactions
WHEN OLD.status <> 'executing'
  OR NEW.status NOT IN ('completed','failed','outcome_unknown')
BEGIN
  SELECT RAISE(ABORT, 'invalid human X interaction transition');
END;
