DROP TRIGGER IF EXISTS x_interaction_candidates_emergency_stop_insert;
DROP TRIGGER IF EXISTS x_interaction_candidates_no_update;
DROP TRIGGER IF EXISTS x_interaction_candidates_no_delete;
DROP TRIGGER IF EXISTS x_interaction_watches_emergency_stop_insert;
DROP TRIGGER IF EXISTS x_interaction_watches_emergency_stop_update;
DROP TRIGGER IF EXISTS x_interaction_watches_no_delete;
DROP TRIGGER IF EXISTS x_interaction_watches_identity_immutable;

CREATE TABLE x_interaction_watches_v2 (
  watch_id TEXT PRIMARY KEY,
  target_user_id TEXT NOT NULL UNIQUE CHECK (
    length(target_user_id) BETWEEN 5 AND 30
    AND target_user_id NOT GLOB '*[^0-9]*'
  ),
  target_username TEXT NOT NULL CHECK (
    length(target_username) BETWEEN 1 AND 15
    AND target_username NOT GLOB '*[^A-Za-z0-9_]*'
  ),
  verified_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  retired_at TEXT,
  last_seen_post_id TEXT CHECK (
    last_seen_post_id IS NULL
    OR (
      length(last_seen_post_id) BETWEEN 5 AND 30
      AND last_seen_post_id NOT GLOB '*[^0-9]*'
    )
  ),
  last_polled_at TEXT,
  poll_day_utc TEXT,
  poll_count INTEGER NOT NULL DEFAULT 0 CHECK (poll_count BETWEEN 0 AND 96),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'active' AND retired_at IS NULL)
    OR (status = 'retired' AND retired_at IS NOT NULL)
  )
);

CREATE TABLE x_interaction_candidates_v2 (
  candidate_id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL REFERENCES x_interaction_watches_v2(watch_id),
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

INSERT INTO x_interaction_watches_v2 (
  watch_id, target_user_id, target_username, verified_at, status, retired_at,
  last_seen_post_id, last_polled_at, poll_day_utc, poll_count,
  created_by, created_at, updated_at
)
SELECT
  watch_id, target_user_id, target_username, verified_at,
  CASE status WHEN 'active' THEN 'active' ELSE 'retired' END,
  CASE status WHEN 'active' THEN NULL ELSE updated_at END,
  last_seen_post_id, last_polled_at, poll_day_utc, poll_count,
  created_by, created_at, updated_at
FROM x_interaction_watches;

INSERT INTO x_interaction_candidates_v2 (
  candidate_id, watch_id, post_id, author_id, post_created_at, status, detected_at
)
SELECT
  candidate_id, watch_id, post_id, author_id, post_created_at, status, detected_at
FROM x_interaction_candidates;

DROP TABLE x_interaction_candidates;
DROP TABLE x_interaction_watches;
ALTER TABLE x_interaction_watches_v2 RENAME TO x_interaction_watches;
ALTER TABLE x_interaction_candidates_v2 RENAME TO x_interaction_candidates;

CREATE UNIQUE INDEX idx_x_interaction_watches_one_active
  ON x_interaction_watches(status)
  WHERE status = 'active';

CREATE INDEX idx_x_interaction_candidates_detected
  ON x_interaction_candidates(detected_at DESC);

CREATE TRIGGER x_interaction_watches_emergency_stop_insert
BEFORE INSERT ON x_interaction_watches
WHEN COALESCE(
  (SELECT value FROM cubelic_system_flags WHERE key = 'emergency_stop'),
  'invalid'
) <> 'false'
AND NOT (
  (SELECT value FROM cubelic_system_flags WHERE key = 'emergency_stop') = 'true'
  AND NEW.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM x_interaction_watches WHERE status = 'active'
  )
  AND EXISTS (
    SELECT 1 FROM x_interaction_watches WHERE status = 'retired'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'emergency stop active');
END;

CREATE TRIGGER x_interaction_watches_emergency_stop_update
BEFORE UPDATE ON x_interaction_watches
WHEN COALESCE(
  (SELECT value FROM cubelic_system_flags WHERE key = 'emergency_stop'),
  'invalid'
) <> 'false'
AND NOT (
  (SELECT value FROM cubelic_system_flags WHERE key = 'emergency_stop') = 'true'
  AND OLD.status = 'active'
  AND NEW.status = 'retired'
)
BEGIN
  SELECT RAISE(ABORT, 'emergency stop active');
END;

CREATE TRIGGER x_interaction_watches_no_delete
BEFORE DELETE ON x_interaction_watches
BEGIN
  SELECT RAISE(ABORT, 'interaction watches are append-preserved');
END;

CREATE TRIGGER x_interaction_watches_identity_immutable
BEFORE UPDATE ON x_interaction_watches
WHEN NEW.watch_id IS NOT OLD.watch_id
  OR NEW.target_user_id IS NOT OLD.target_user_id
  OR NEW.target_username IS NOT OLD.target_username
  OR NEW.verified_at IS NOT OLD.verified_at
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'interaction watch identity is immutable');
END;

CREATE TRIGGER x_interaction_watches_retired_immutable
BEFORE UPDATE ON x_interaction_watches
WHEN OLD.status = 'retired'
BEGIN
  SELECT RAISE(ABORT, 'retired interaction watches are immutable');
END;

CREATE TRIGGER x_interaction_watches_transition_guard
BEFORE UPDATE ON x_interaction_watches
WHEN NEW.status IS NOT OLD.status
AND NOT (OLD.status = 'active' AND NEW.status = 'retired')
BEGIN
  SELECT RAISE(ABORT, 'invalid interaction watch status transition');
END;

CREATE TRIGGER x_interaction_candidates_emergency_stop_insert
BEFORE INSERT ON x_interaction_candidates
WHEN COALESCE(
  (SELECT value FROM cubelic_system_flags WHERE key = 'emergency_stop'),
  'true'
) <> 'false'
BEGIN
  SELECT RAISE(ABORT, 'emergency stop active');
END;

CREATE TRIGGER x_interaction_candidates_no_update
BEFORE UPDATE ON x_interaction_candidates
BEGIN
  SELECT RAISE(ABORT, 'interaction candidates are immutable');
END;

CREATE TRIGGER x_interaction_candidates_no_delete
BEFORE DELETE ON x_interaction_candidates
BEGIN
  SELECT RAISE(ABORT, 'interaction candidates are append-preserved');
END;
