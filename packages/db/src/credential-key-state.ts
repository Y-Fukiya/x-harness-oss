import { decryptCredential, encryptCredential } from './credential-crypto.js';
import { securityAuditStatement } from './audit.js';

const CANARY = 'credential-key-canary-v1';
const CANARY_FIELD = 'credential_key_state.canary';

export async function verifyOrInitializeCredentialKeyState(
  db: D1Database,
  encryptionKey: string,
  keyVersion: string,
): Promise<'verified' | 'initialized'> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u.test(keyVersion)) {
    throw new Error('Credential encryption key version is invalid');
  }
  const state = await db.prepare(
    'SELECT key_version, encrypted_canary FROM credential_key_state WHERE id = ?',
  ).bind('primary').first<{ key_version: string; encrypted_canary: string }>();
  if (!state) {
    const encryptedCredential = await db.prepare(
      `SELECT 1 AS present FROM x_accounts
       WHERE access_token LIKE 'enc:v1:%'
          OR refresh_token LIKE 'enc:v1:%'
          OR consumer_key LIKE 'enc:v1:%'
          OR consumer_secret LIKE 'enc:v1:%'
          OR access_token_secret LIKE 'enc:v1:%'
       UNION ALL
       SELECT 1 AS present FROM line_connections
       WHERE api_key LIKE 'enc:v1:%'
       UNION ALL
       SELECT 1 AS present FROM engagement_gates
       WHERE line_harness_api_key LIKE 'enc:v1:%'
       UNION ALL
       SELECT 1 AS present FROM external_mutation_operations
       WHERE response_body_encrypted LIKE 'enc:v1:%'
       LIMIT 1`,
    ).first<{ present: number }>();
    if (encryptedCredential) {
      throw new Error(
        'Credential key state is missing while encrypted credentials exist; audited recovery is required',
      );
    }
    const timestamp = new Date().toISOString();
    const encryptedCanary = await encryptCredential(CANARY, encryptionKey, CANARY_FIELD);
    await db.batch([
      db.prepare(
        'INSERT INTO credential_key_state (id, key_version, encrypted_canary, updated_at) VALUES (?, ?, ?, ?)',
      ).bind('primary', keyVersion, encryptedCanary, timestamp),
      securityAuditStatement(db, {
        actor: 'system',
        action: 'credential_key.initialized',
        entityType: 'credential_key',
        entityId: 'primary',
        before: {},
        after: { keyVersion },
        correlationId: `credential-key:${crypto.randomUUID()}`,
      }, timestamp),
    ]);
    return 'initialized';
  }
  if (state.key_version !== keyVersion) {
    throw new Error('Credential encryption key version mismatch; explicit rotation is required');
  }
  const decrypted = await decryptCredential(state.encrypted_canary, encryptionKey, CANARY_FIELD);
  if (decrypted !== CANARY) {
    throw new Error('Credential encryption key verification failed');
  }
  return 'verified';
}
