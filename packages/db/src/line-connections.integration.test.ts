import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import {
  authorizeExternalMutationRetry,
  completeExternalMutationOperation,
  createLineConnection,
  getLineConnectionById,
  getExternalMutationOperation,
  listLineConnections,
  markExternalMutationOutcomeUnknown,
  replayExternalMutationResponse,
  reserveExternalMutationOperation,
  migrateLineConnectionApiKeys,
} from './line-connections.js';
import { compileMigrationForD1Exec } from './d1-test-utils.js';

describe('external connection credential storage', () => {
  let miniflare: Miniflare;
  let db: D1Database;
  const credentialKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2026-07-23',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: 'line-connection-integration-test' },
    });
    db = await miniflare.getD1Database('DB') as unknown as D1Database;
    await db.exec(compileMigrationForD1Exec(`
      CREATE TABLE line_connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        worker_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE cubelic_audit_logs (
        audit_id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        correlation_id TEXT NOT NULL
      );
      CREATE TABLE external_mutation_operations (
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
      CREATE UNIQUE INDEX idx_external_mutation_unresolved_request
        ON external_mutation_operations(connection_id, request_hash)
        WHERE status IN ('pending', 'outcome_unknown');
    `));
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  it('stores a new API key encrypted and omits it from list results', async () => {
    const created = await createLineConnection(db, {
      name: 'Production',
      workerUrl: 'https://line.example.test',
      apiKey: 'line-secret-key',
    }, credentialKey, {
      actor: 'human',
      action: 'external_connection.created',
      entityType: 'external_connection',
      entityId: 'new',
      before: {},
      after: {},
      correlationId: 'create-line',
    });
    const stored = await db.prepare(
      'SELECT api_key FROM line_connections WHERE id = ?',
    ).bind(created.id).first<{ api_key: string }>();

    expect(stored?.api_key).toMatch(/^enc:v1:/u);
    expect(stored?.api_key).not.toContain('line-secret-key');
    expect(JSON.stringify(await listLineConnections(db))).not.toContain('line-secret-key');
    await expect(getLineConnectionById(db, created.id, credentialKey)).resolves.toMatchObject({
      api_key: 'line-secret-key',
    });
  });

  it('migrates a legacy plaintext API key only in the explicit bulk migration', async () => {
    await db.prepare(
      'INSERT INTO line_connections (id, name, worker_url, api_key, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(
      'legacy',
      'Legacy',
      'https://line.example.test',
      'legacy-line-secret',
      '2026-07-23T00:00:00.000Z',
    ).run();

    await expect(getLineConnectionById(db, 'legacy', credentialKey)).resolves.toMatchObject({
      api_key: 'legacy-line-secret',
    });
    await expect(migrateLineConnectionApiKeys(db, credentialKey)).resolves.toBe(1);
    const stored = await db.prepare(
      'SELECT api_key FROM line_connections WHERE id = ?',
    ).bind('legacy').first<{ api_key: string }>();
    expect(stored?.api_key).toMatch(/^enc:v1:/u);
    expect(stored?.api_key).not.toContain('legacy-line-secret');
  });

  it('reserves one mutation, rejects conflicting reuse, and replays an encrypted result', async () => {
    const connection = await createLineConnection(db, {
      name: 'Idempotency',
      workerUrl: 'https://line.example.test',
      apiKey: 'line-secret-key',
    }, credentialKey, {
      actor: 'human',
      action: 'external_connection.created',
      entityType: 'external_connection',
      entityId: '',
      before: {},
      after: {},
      correlationId: 'create-idempotency-line',
    });
    const reserve = (requestHash: string) => reserveExternalMutationOperation(db, {
      connectionId: connection.id,
      operationId: 'operation-1234567890',
      requestHash,
      method: 'POST',
      path: '/api/tags',
    }, {
      actor: 'human',
      action: 'external_connection.proxy_mutation_intent',
      entityType: 'external_connection',
      entityId: connection.id,
      before: {},
      after: { requestHash },
      correlationId: 'operation-1234567890',
    });
    const attempts = await Promise.all([reserve('hash-a'), reserve('hash-a')]);
    expect(attempts.filter((attempt) => attempt.reserved)).toHaveLength(1);

    const conflict = await reserve('hash-b');
    expect(conflict.reserved).toBe(false);
    if (!conflict.reserved) expect(conflict.operation.request_hash).toBe('hash-a');
    const sameRequestAfterBrowserRestart = await reserveExternalMutationOperation(db, {
      connectionId: connection.id,
      operationId: 'operation-new-browser',
      requestHash: 'hash-a',
      method: 'POST',
      path: '/api/tags',
    }, {
      actor: 'human',
      action: 'external_connection.proxy_mutation_intent',
      entityType: 'external_connection',
      entityId: connection.id,
      before: {},
      after: { requestHash: 'hash-a' },
      correlationId: 'operation-new-browser',
    });
    expect(sameRequestAfterBrowserRestart.reserved).toBe(false);
    if (!sameRequestAfterBrowserRestart.reserved) {
      expect(sameRequestAfterBrowserRestart.operation.operation_id).toBe('operation-1234567890');
    }

    await completeExternalMutationOperation(db, {
      connectionId: connection.id,
      operationId: 'operation-1234567890',
      responseStatus: 201,
      responseContentType: 'application/json',
      responseBody: '{"success":true,"data":{"id":"tag_1"}}',
      expectedStatus: 'pending',
    }, credentialKey, {
      actor: 'human',
      action: 'external_connection.proxy_mutation_outcome',
      entityType: 'external_connection',
      entityId: connection.id,
      before: { outcome: 'pending' },
      after: { outcome: 'completed' },
      correlationId: 'operation-1234567890',
    });

    const replayReservation = await reserve('hash-a');
    expect(replayReservation.reserved).toBe(false);
    if (replayReservation.reserved) throw new Error('Expected an idempotent replay');
    await expect(
      replayExternalMutationResponse(replayReservation.operation, credentialKey),
    ).resolves.toEqual({
      status: 201,
      contentType: 'application/json',
      body: '{"success":true,"data":{"id":"tag_1"}}',
    });
    const stored = await db.prepare(
      `SELECT response_body_encrypted FROM external_mutation_operations
       WHERE connection_id = ? AND operation_id = ?`,
    ).bind(connection.id, 'operation-1234567890').first<{ response_body_encrypted: string }>();
    expect(stored?.response_body_encrypted).toMatch(/^enc:v1:/u);
    expect(stored?.response_body_encrypted).not.toContain('tag_1');

    await expect(authorizeExternalMutationRetry(
      db,
      connection.id,
      'operation-1234567890',
      {
        actor: 'human',
        action: 'external_connection.proxy_mutation_reconciled_not_completed',
        entityType: 'external_connection',
        entityId: connection.id,
        before: {},
        after: {},
        correlationId: 'late-reconcile',
      },
    )).resolves.toBe(false);
    await expect(db.prepare(
      `SELECT COUNT(*) AS count FROM cubelic_audit_logs
       WHERE correlation_id = 'late-reconcile'`,
    ).first<{ count: number }>()).resolves.toEqual({ count: 0 });

    const intentionalRepeat = await reserveExternalMutationOperation(db, {
      connectionId: connection.id,
      operationId: 'operation-intentional-repeat',
      requestHash: 'hash-a',
      method: 'POST',
      path: '/api/tags',
    }, {
      actor: 'human',
      action: 'external_connection.proxy_mutation_intent',
      entityType: 'external_connection',
      entityId: connection.id,
      before: {},
      after: {},
      correlationId: 'intentional-repeat',
    });
    expect(intentionalRepeat).toEqual({ reserved: true });
  });

  it('allows exactly one competing transition and audits only the winner', async () => {
    const connection = await createLineConnection(db, {
      name: 'Race',
      workerUrl: 'https://line.example.test',
      apiKey: 'line-secret-key',
    }, credentialKey, {
      actor: 'human',
      action: 'external_connection.created',
      entityType: 'external_connection',
      entityId: '',
      before: {},
      after: {},
      correlationId: 'create-race-line',
    });
    await reserveExternalMutationOperation(db, {
      connectionId: connection.id,
      operationId: 'operation-race-12345',
      requestHash: 'race-hash',
      method: 'POST',
      path: '/api/tags',
    }, {
      actor: 'human',
      action: 'external_connection.proxy_mutation_intent',
      entityType: 'external_connection',
      entityId: connection.id,
      before: {},
      after: {},
      correlationId: 'race-intent',
    });

    await expect(authorizeExternalMutationRetry(
      db,
      connection.id,
      'operation-race-12345',
      {
        actor: 'human',
        action: 'external_connection.proxy_mutation_reconciled_not_completed',
        entityType: 'external_connection',
        entityId: connection.id,
        before: {},
        after: {},
        correlationId: 'lease-active',
      },
    )).resolves.toBe(false);
    await expect(db.prepare(
      "SELECT COUNT(*) AS count FROM cubelic_audit_logs WHERE correlation_id = 'lease-active'",
    ).first<{ count: number }>()).resolves.toEqual({ count: 0 });

    const [completed, unknown] = await Promise.all([
      completeExternalMutationOperation(db, {
        connectionId: connection.id,
        operationId: 'operation-race-12345',
        responseStatus: 201,
        responseContentType: 'application/json',
        responseBody: '{"success":true}',
        expectedStatus: 'pending',
      }, credentialKey, {
        actor: 'human',
        action: 'external_connection.proxy_mutation_outcome',
        entityType: 'external_connection',
        entityId: connection.id,
        before: {},
        after: { outcome: 'completed' },
        correlationId: 'race-completed',
      }),
      markExternalMutationOutcomeUnknown(db, {
        connectionId: connection.id,
        operationId: 'operation-race-12345',
      }, {
        actor: 'human',
        action: 'external_connection.proxy_mutation_outcome',
        entityType: 'external_connection',
        entityId: connection.id,
        before: {},
        after: { outcome: 'unknown' },
        correlationId: 'race-unknown',
      }),
    ]);
    expect(Number(completed) + Number(unknown)).toBe(1);
    const raceAudits = await db.prepare(
      `SELECT correlation_id FROM cubelic_audit_logs
       WHERE correlation_id IN ('race-completed', 'race-unknown')`,
    ).all<{ correlation_id: string }>();
    expect(raceAudits.results).toHaveLength(1);

    await reserveExternalMutationOperation(db, {
      connectionId: connection.id,
      operationId: 'operation-retry-1234',
      requestHash: 'retry-hash',
      method: 'POST',
      path: '/api/tags',
    }, {
      actor: 'human',
      action: 'external_connection.proxy_mutation_intent',
      entityType: 'external_connection',
      entityId: connection.id,
      before: {},
      after: {},
      correlationId: 'retry-intent',
    });
    await markExternalMutationOutcomeUnknown(db, {
      connectionId: connection.id,
      operationId: 'operation-retry-1234',
    }, {
      actor: 'human',
      action: 'external_connection.proxy_mutation_outcome',
      entityType: 'external_connection',
      entityId: connection.id,
      before: {},
      after: { outcome: 'unknown' },
      correlationId: 'retry-unknown',
    });
    await expect(authorizeExternalMutationRetry(
      db,
      connection.id,
      'operation-retry-1234',
      {
        actor: 'human',
        action: 'external_connection.proxy_mutation_reconciled_not_completed',
        entityType: 'external_connection',
        entityId: connection.id,
        before: {},
        after: {},
        correlationId: 'retry-after-audit',
      },
    )).resolves.toBe(true);
    await expect(getExternalMutationOperation(
      db,
      connection.id,
      'operation-retry-1234',
    )).resolves.toBeNull();
    await expect(db.prepare(
      "SELECT COUNT(*) AS count FROM cubelic_audit_logs WHERE correlation_id = 'retry-after-audit'",
    ).first<{ count: number }>()).resolves.toEqual({ count: 1 });
  });
});
