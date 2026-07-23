import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { verifyOrInitializeCredentialKeyState } from './credential-key-state.js';
import { encryptCredential } from './credential-crypto.js';
import { compileMigrationForD1Exec } from './d1-test-utils.js';

describe('credential encryption key state', () => {
  let miniflare: Miniflare;
  let db: D1Database;
  const key = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';
  const wrongKey = 'YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmM';

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2026-07-23',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: 'credential-key-state-test' },
    });
    db = await miniflare.getD1Database('DB') as unknown as D1Database;
    await db.exec(compileMigrationForD1Exec(`
      CREATE TABLE credential_key_state (
        id TEXT PRIMARY KEY,
        key_version TEXT NOT NULL,
        encrypted_canary TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
      CREATE TABLE x_accounts (
        id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        consumer_key TEXT,
        consumer_secret TEXT,
        access_token_secret TEXT
      );
      CREATE TABLE line_connections (
        id TEXT PRIMARY KEY,
        api_key TEXT NOT NULL
      );
      CREATE TABLE engagement_gates (
        id TEXT PRIMARY KEY,
        line_harness_api_key TEXT
      );
      CREATE TABLE external_mutation_operations (
        connection_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        response_body_encrypted TEXT,
        PRIMARY KEY (connection_id, operation_id)
      );
    `));
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  it('initializes once, verifies the same key, and rejects unsafe rotation', async () => {
    await expect(verifyOrInitializeCredentialKeyState(db, key, 'key-v1')).resolves.toBe('initialized');
    await expect(verifyOrInitializeCredentialKeyState(db, key, 'key-v1')).resolves.toBe('verified');
    await expect(verifyOrInitializeCredentialKeyState(db, wrongKey, 'key-v1')).rejects.toThrow();
    await expect(verifyOrInitializeCredentialKeyState(db, key, 'key-v2')).rejects.toThrow(
      /explicit rotation is required/u,
    );
    await expect(db.prepare(
      "SELECT COUNT(*) AS count FROM cubelic_audit_logs WHERE action = 'credential_key.initialized'",
    ).first<{ count: number }>()).resolves.toEqual({ count: 1 });
  });

  it('refuses to initialize missing key state over existing ciphertext', async () => {
    const ciphertext = await encryptCredential('existing-secret', key, 'access_token');
    await db.prepare(
      'INSERT INTO x_accounts (id, access_token) VALUES (?, ?)',
    ).bind('existing', ciphertext).run();

    await expect(
      verifyOrInitializeCredentialKeyState(db, wrongKey, 'key-v1'),
    ).rejects.toThrow(/audited recovery is required/u);
    await expect(
      db.prepare('SELECT COUNT(*) AS count FROM credential_key_state').first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });
  });
});
