CREATE TABLE IF NOT EXISTS cubelic_media_objects (
  asset_id TEXT PRIMARY KEY REFERENCES cubelic_media_assets(asset_id),
  r2_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 GLOB '[0-9a-f]*'),
  content_type TEXT NOT NULL CHECK (
    content_type IN ('image/jpeg','image/png','image/webp','image/gif','video/mp4')
  ),
  byte_size INTEGER NOT NULL CHECK (
    byte_size > 0 AND (
      (content_type IN ('image/jpeg','image/png','image/webp') AND byte_size <= 5242880)
      OR (content_type = 'image/gif' AND byte_size <= 15728640)
      OR (content_type = 'video/mp4' AND byte_size <= 95000000)
    )
  ),
  staged_by TEXT NOT NULL,
  staged_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS cubelic_media_objects_emergency_stop_insert
BEFORE INSERT ON cubelic_media_objects
WHEN COALESCE(
  (SELECT value = 'false' FROM cubelic_system_flags WHERE key = 'emergency_stop'),
  0
) = 0
BEGIN
  SELECT RAISE(ABORT, 'emergency stop active');
END;

CREATE TRIGGER IF NOT EXISTS cubelic_media_objects_immutable_update
BEFORE UPDATE ON cubelic_media_objects
BEGIN
  SELECT RAISE(ABORT, 'staged media object is immutable');
END;

CREATE TRIGGER IF NOT EXISTS cubelic_media_objects_immutable_delete
BEFORE DELETE ON cubelic_media_objects
BEGIN
  SELECT RAISE(ABORT, 'staged media object is immutable');
END;
