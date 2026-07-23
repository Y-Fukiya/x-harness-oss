import {
  decryptCredential,
  encryptCredential,
  isEncryptedCredential,
} from './credential-crypto.js';
import { securityAuditStatement, type SecurityAuditInput } from './audit.js';

export interface DbLineConnection {
  id: string;
  name: string;
  worker_url: string;
  api_key: string;
  created_at: string;
}

export type PublicLineConnection = Omit<DbLineConnection, 'api_key'> & {
  has_api_key: boolean;
};

export interface ExternalMutationOperation {
  connection_id: string;
  operation_id: string;
  request_hash: string;
  method: string;
  path: string;
  status: 'pending' | 'completed' | 'outcome_unknown' | 'retry_authorized';
  response_status: number | null;
  response_content_type: string | null;
  response_body_encrypted: string | null;
  lease_expires_at: string;
  transition_nonce: string | null;
  created_at: string;
  updated_at: string;
}

export async function createLineConnection(
  db: D1Database,
  input: { name: string; workerUrl: string; apiKey: string },
  encryptionKey: string,
  audit: SecurityAuditInput,
): Promise<PublicLineConnection> {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const encryptedApiKey = await encryptCredential(
    input.apiKey,
    encryptionKey,
    'line_connections.api_key',
  );
  const insert = db.prepare(
    'INSERT INTO line_connections (id, name, worker_url, api_key, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(id, input.name, input.workerUrl, encryptedApiKey, createdAt);
  await db.batch([
    insert,
    securityAuditStatement(db, { ...audit, entityId: id }, createdAt),
  ]);
  return {
    id,
    name: input.name,
    worker_url: input.workerUrl,
    created_at: createdAt,
    has_api_key: true,
  };
}

export async function listLineConnections(db: D1Database): Promise<PublicLineConnection[]> {
  const result = await db.prepare(
    'SELECT id, name, worker_url, created_at, length(api_key) > 0 AS has_api_key FROM line_connections ORDER BY created_at DESC',
  ).all<Omit<PublicLineConnection, 'has_api_key'> & { has_api_key: number }>();
  return result.results.map((row) => ({ ...row, has_api_key: Boolean(row.has_api_key) }));
}

export async function getLineConnectionById(
  db: D1Database,
  id: string,
  encryptionKey: string,
): Promise<DbLineConnection | null> {
  const row = await db.prepare(
    'SELECT id, name, worker_url, api_key, created_at FROM line_connections WHERE id = ?',
  ).bind(id).first<DbLineConnection>();
  if (!row) return null;
  return {
    ...row,
    api_key: await decryptCredential(
      row.api_key,
      encryptionKey,
      'line_connections.api_key',
    ),
  };
}

export async function migrateLineConnectionApiKeys(
  db: D1Database,
  encryptionKey: string,
): Promise<number> {
  const rows = await db.prepare(
    'SELECT id, api_key FROM line_connections',
  ).all<{ id: string; api_key: string }>();
  const legacy = rows.results.filter((row) => !isEncryptedCredential(row.api_key));
  if (legacy.length === 0) return 0;
  const statements = (await Promise.all(legacy.map(async (row) => [
    db.prepare(
      'UPDATE line_connections SET api_key = ? WHERE id = ? AND api_key = ?',
    ).bind(
      await encryptCredential(row.api_key, encryptionKey, 'line_connections.api_key'),
      row.id,
      row.api_key,
    ),
    securityAuditStatement(db, {
      actor: 'system',
      action: 'credential_storage.migrated',
      entityType: 'external_connection',
      entityId: row.id,
      before: { storage: 'legacy_plaintext' },
      after: { storage: 'aes_gcm_v1' },
      correlationId: `credential-migration:${crypto.randomUUID()}`,
    }),
  ]))).flat();
  await db.batch(statements);
  return legacy.length;
}

export async function deleteLineConnection(
  db: D1Database,
  id: string,
  audit: SecurityAuditInput,
): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM line_connections WHERE id = ?').bind(id),
    securityAuditStatement(db, audit),
  ]);
}

export async function reserveExternalMutationOperation(
  db: D1Database,
  input: {
    connectionId: string;
    operationId: string;
    requestHash: string;
    method: string;
    path: string;
  },
  audit: SecurityAuditInput,
): Promise<{ reserved: true } | { reserved: false; operation: ExternalMutationOperation }> {
  const timestamp = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + 2 * 60_000).toISOString();
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO external_mutation_operations
          (connection_id, operation_id, request_hash, method, path, status,
           lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).bind(
        input.connectionId,
        input.operationId,
        input.requestHash,
        input.method,
        input.path,
        leaseExpiresAt,
        timestamp,
        timestamp,
      ),
      securityAuditStatement(db, audit, timestamp),
    ]);
    return { reserved: true };
  } catch (error) {
    const existing = await db.prepare(
       `SELECT * FROM external_mutation_operations
       WHERE connection_id = ? AND (operation_id = ? OR request_hash = ?)
       ORDER BY operation_id = ? DESC,
                status IN ('pending', 'outcome_unknown') DESC,
                updated_at DESC
       LIMIT 1`,
    ).bind(
      input.connectionId,
      input.operationId,
      input.requestHash,
      input.operationId,
    ).first<ExternalMutationOperation>();
    if (!existing) throw error;
    return { reserved: false, operation: existing };
  }
}

function conditionalOperationAuditStatement(
  db: D1Database,
  input: SecurityAuditInput,
  connectionId: string,
  operationId: string,
  transitionNonce: string,
  timestamp: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO cubelic_audit_logs
      (audit_id, actor, action, entity_type, entity_id, before_json, after_json,
       timestamp, correlation_id)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM external_mutation_operations
       WHERE connection_id = ? AND operation_id = ? AND transition_nonce = ?
     )`,
  ).bind(
    `aud_${crypto.randomUUID()}`,
    input.actor,
    input.action,
    input.entityType,
    input.entityId,
    JSON.stringify(input.before),
    JSON.stringify(input.after),
    timestamp,
    input.correlationId,
    connectionId,
    operationId,
    transitionNonce,
  );
}

export async function completeExternalMutationOperation(
  db: D1Database,
  input: {
    connectionId: string;
    operationId: string;
    responseStatus: number;
    responseContentType: string;
    responseBody: string;
    expectedStatus: 'pending' | 'outcome_unknown';
  },
  encryptionKey: string,
  audit: SecurityAuditInput,
): Promise<boolean> {
  const timestamp = new Date().toISOString();
  const transitionNonce = crypto.randomUUID();
  const encryptedResponse = await encryptCredential(
    input.responseBody,
    encryptionKey,
    'external_mutation_operations.response_body',
  );
  const results = await db.batch([
    db.prepare(
      `UPDATE external_mutation_operations
       SET status = 'completed', response_status = ?, response_content_type = ?,
           response_body_encrypted = ?, transition_nonce = ?, updated_at = ?
       WHERE connection_id = ? AND operation_id = ? AND status = ?`,
    ).bind(
      input.responseStatus,
      input.responseContentType,
      encryptedResponse,
      transitionNonce,
      timestamp,
      input.connectionId,
      input.operationId,
      input.expectedStatus,
    ),
    conditionalOperationAuditStatement(
      db,
      audit,
      input.connectionId,
      input.operationId,
      transitionNonce,
      timestamp,
    ),
  ]);
  return results[0]?.meta.changes === 1;
}

export async function markExternalMutationOutcomeUnknown(
  db: D1Database,
  input: { connectionId: string; operationId: string },
  audit: SecurityAuditInput,
): Promise<boolean> {
  const timestamp = new Date().toISOString();
  const transitionNonce = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(
      `UPDATE external_mutation_operations
       SET status = 'outcome_unknown', transition_nonce = ?, updated_at = ?
       WHERE connection_id = ? AND operation_id = ? AND status = 'pending'`,
    ).bind(transitionNonce, timestamp, input.connectionId, input.operationId),
    conditionalOperationAuditStatement(
      db,
      audit,
      input.connectionId,
      input.operationId,
      transitionNonce,
      timestamp,
    ),
  ]);
  return results[0]?.meta.changes === 1;
}

export async function replayExternalMutationResponse(
  operation: ExternalMutationOperation,
  encryptionKey: string,
): Promise<{ status: number; contentType: string; body: string } | null> {
  if (
    operation.status !== 'completed'
    || operation.response_status == null
    || !operation.response_content_type
    || !operation.response_body_encrypted
  ) return null;
  return {
    status: operation.response_status,
    contentType: operation.response_content_type,
    body: await decryptCredential(
      operation.response_body_encrypted,
      encryptionKey,
      'external_mutation_operations.response_body',
    ),
  };
}

export async function getExternalMutationOperation(
  db: D1Database,
  connectionId: string,
  operationId: string,
): Promise<ExternalMutationOperation | null> {
  return db.prepare(
    `SELECT * FROM external_mutation_operations
     WHERE connection_id = ? AND operation_id = ?`,
  ).bind(connectionId, operationId).first<ExternalMutationOperation>();
}

export async function authorizeExternalMutationRetry(
  db: D1Database,
  connectionId: string,
  operationId: string,
  audit: SecurityAuditInput,
): Promise<boolean> {
  const existing = await getExternalMutationOperation(db, connectionId, operationId);
  if (!existing || !['pending', 'outcome_unknown'].includes(existing.status)) return false;
  const timestamp = new Date().toISOString();
  if (existing.status === 'pending' && existing.lease_expires_at > timestamp) return false;
  const transitionNonce = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(
      `UPDATE external_mutation_operations
       SET status = 'retry_authorized', transition_nonce = ?, updated_at = ?
       WHERE connection_id = ? AND operation_id = ? AND status = ?
         AND (status = 'outcome_unknown' OR lease_expires_at <= ?)`,
    ).bind(
      transitionNonce,
      timestamp,
      connectionId,
      operationId,
      existing.status,
      timestamp,
    ),
    conditionalOperationAuditStatement(
      db,
      audit,
      connectionId,
      operationId,
      transitionNonce,
      timestamp,
    ),
    db.prepare(
      `DELETE FROM external_mutation_operations
       WHERE connection_id = ? AND operation_id = ?
         AND status = 'retry_authorized' AND transition_nonce = ?`,
    ).bind(connectionId, operationId, transitionNonce),
  ]);
  return results[0]?.meta.changes === 1;
}
