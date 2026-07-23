-- Replace reusable plaintext staff credentials with keyed digests.
-- The legacy api_key column remains as a non-secret tombstone for compatibility.

ALTER TABLE staff_members ADD COLUMN api_key_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_api_key_hash
ON staff_members(api_key_hash)
WHERE api_key_hash IS NOT NULL;
