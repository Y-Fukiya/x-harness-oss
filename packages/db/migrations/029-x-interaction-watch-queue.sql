CREATE TABLE IF NOT EXISTS x_interaction_watches (
  watch_id TEXT PRIMARY KEY,
  singleton_key INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton_key = 1),
  target_user_id TEXT NOT NULL UNIQUE CHECK (
    length(target_user_id) BETWEEN 5 AND 30
    AND target_user_id NOT GLOB '*[^0-9]*'
  ),
  target_username TEXT NOT NULL CHECK (
    length(target_username) BETWEEN 1 AND 15
    AND target_username NOT GLOB '*[^A-Za-z0-9_]*'
  ),
  verified_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
  last_seen_post_id TEXT CHECK (
    last_seen_post_id IS NULL
    OR (
      length(last_seen_post_id) BETWEEN 5 AND 30
      AND last_seen_post_id NOT GLOB '*[^0-9]*'
    )
  ),
  last_polled_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS x_interaction_watches_emergency_stop_insert
BEFORE INSERT ON x_interaction_watches
WHEN COALESCE(
  (SELECT value FROM cubelic_system_flags WHERE key = 'emergency_stop'),
  'true'
) <> 'false'
BEGIN
  SELECT RAISE(ABORT, 'emergency stop active');
END;

CREATE TRIGGER IF NOT EXISTS x_interaction_watches_emergency_stop_update
BEFORE UPDATE ON x_interaction_watches
WHEN COALESCE(
  (SELECT value FROM cubelic_system_flags WHERE key = 'emergency_stop'),
  'true'
) <> 'false'
BEGIN
  SELECT RAISE(ABORT, 'emergency stop active');
END;

CREATE TRIGGER IF NOT EXISTS x_interaction_watches_no_delete
BEFORE DELETE ON x_interaction_watches
BEGIN
  SELECT RAISE(ABORT, 'interaction watches are append-preserved');
END;

CREATE TRIGGER IF NOT EXISTS x_interaction_watches_identity_immutable
BEFORE UPDATE ON x_interaction_watches
WHEN NEW.watch_id IS NOT OLD.watch_id
  OR NEW.singleton_key IS NOT OLD.singleton_key
  OR NEW.target_user_id IS NOT OLD.target_user_id
  OR NEW.target_username IS NOT OLD.target_username
  OR NEW.verified_at IS NOT OLD.verified_at
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'interaction watch identity is immutable');
END;

CREATE TABLE IF NOT EXISTS x_interaction_candidates (
  candidate_id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL REFERENCES x_interaction_watches(watch_id),
  post_id TEXT NOT NULL UNIQUE CHECK (
    length(post_id) BETWEEN 5 AND 30
    AND post_id NOT GLOB '*[^0-9]*'
  ),
  author_id TEXT NOT NULL CHECK (
    length(author_id) BETWEEN 5 AND 30
    AND author_id NOT GLOB '*[^0-9]*'
  ),
  post_created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'pending'),
  detected_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_x_interaction_candidates_detected
  ON x_interaction_candidates(detected_at DESC);

CREATE TRIGGER IF NOT EXISTS x_interaction_candidates_emergency_stop_insert
BEFORE INSERT ON x_interaction_candidates
WHEN COALESCE(
  (SELECT value FROM cubelic_system_flags WHERE key = 'emergency_stop'),
  'true'
) <> 'false'
BEGIN
  SELECT RAISE(ABORT, 'emergency stop active');
END;

CREATE TRIGGER IF NOT EXISTS x_interaction_candidates_no_update
BEFORE UPDATE ON x_interaction_candidates
BEGIN
  SELECT RAISE(ABORT, 'interaction candidates are immutable');
END;

CREATE TRIGGER IF NOT EXISTS x_interaction_candidates_no_delete
BEFORE DELETE ON x_interaction_candidates
BEGIN
  SELECT RAISE(ABORT, 'interaction candidates are append-preserved');
END;
