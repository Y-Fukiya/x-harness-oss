# Credential encryption key rotation

The runtime binds each credential-encryption key to an explicit version and an
encrypted canary. A key or version mismatch fails closed before any plaintext
credential migration runs.

Do not change `CREDENTIAL_ENCRYPTION_KEY` or
`CREDENTIAL_ENCRYPTION_KEY_VERSION` in place. Rotation is a separate
maintenance release:

1. Activate every publishing stop, disable Cron delivery, and deny operator
   traffic at the edge.
2. Create and verify a restorable D1 backup. Record only the backup identifier
   and row counts.
3. Prepare a reviewed dual-key migration build. It must verify the current
   canary with the old key, decrypt every encrypted field in `x_accounts`,
   `line_connections`, and `engagement_gates`, re-encrypt every value with the
   new key, update the canary and key version, and append audit rows in the same
   D1 batch. It must never log plaintext or either key.
4. Run the migration once during the maintenance window. Verify encrypted
   prefixes, row counts, the new canary, and audit counts without printing
   credential values.
5. Deploy the Worker with only the new key and version, then remove the old and
   temporary next-key secrets.
6. Run the authenticated smoke test and keep publishing stopped until it
   passes. Restore the D1 backup if any count, canary, or decrypt check fails.

The current runtime intentionally rejects a version change; it does not perform
an online implicit rotation. This prevents a valid-length but incorrect key
from silently re-encrypting legacy plaintext.
