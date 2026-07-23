import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { getXAccountById, migrateAllXAccountCredentials, updateXAccount } from './x-accounts.js';
import { encryptCredential } from './credential-crypto.js';
import { compileMigrationForD1Exec } from './d1-test-utils.js';

describe('X account credential audit integration', () => {
  let miniflare: Miniflare;
  let db: D1Database;
  const credentialKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2024-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: 'x-account-audit-integration-test' },
    });
    db = await miniflare.getD1Database('DB') as unknown as D1Database;
    await db.exec(compileMigrationForD1Exec(`
      CREATE TABLE x_accounts (
        id TEXT PRIMARY KEY,
        x_user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        display_name TEXT,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        consumer_key TEXT,
        consumer_secret TEXT,
        access_token_secret TEXT,
        is_active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
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
      INSERT INTO x_accounts (
        id, x_user_id, username, access_token, is_active, created_at, updated_at
      ) VALUES (
        'account_1', '1556917966587166720', 'tubelic_cube', 'old_app_token', 1,
        '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z'
      );
    `));
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  it('updates OAuth credentials and appends a secret-free audit in one batch', async () => {
    await updateXAccount(db, 'account_1', {
      accessToken: 'user_token',
      consumerKey: 'consumer_key',
      consumerSecret: 'consumer_secret',
      accessTokenSecret: 'access_token_secret',
    }, {
      actor: 'human',
      action: 'x_account.credentials_updated',
      entityType: 'x_account',
      entityId: 'account_1',
      before: { authMode: 'bearer', active: true },
      after: { authMode: 'oauth1_user_context', active: true },
      correlationId: 'corr_credentials_1',
    }, credentialKey);

    await expect(getXAccountById(db, 'account_1', credentialKey)).resolves.toMatchObject({
      access_token: 'user_token',
      consumer_key: 'consumer_key',
      consumer_secret: 'consumer_secret',
      access_token_secret: 'access_token_secret',
    });
    const audit = await db.prepare(
      'SELECT action, before_json, after_json, correlation_id FROM cubelic_audit_logs',
    ).first<{
      action: string;
      before_json: string;
      after_json: string;
      correlation_id: string;
    }>();
    expect(audit).toEqual({
      action: 'x_account.credentials_updated',
      before_json: JSON.stringify({ authMode: 'bearer', active: true }),
      after_json: JSON.stringify({ authMode: 'oauth1_user_context', active: true }),
      correlation_id: 'corr_credentials_1',
    });
    expect(JSON.stringify(audit)).not.toContain('user_token');
    expect(JSON.stringify(audit)).not.toContain('consumer_secret');
    expect(JSON.stringify(audit)).not.toContain('access_token_secret');

    const stored = await db.prepare(
      'SELECT access_token, consumer_key, consumer_secret, access_token_secret FROM x_accounts WHERE id = ?',
    ).bind('account_1').first<Record<string, string>>();
    expect(stored?.access_token).toMatch(/^enc:v1:/u);
    expect(stored?.consumer_key).toMatch(/^enc:v1:/u);
    expect(stored?.consumer_secret).toMatch(/^enc:v1:/u);
    expect(stored?.access_token_secret).toMatch(/^enc:v1:/u);
    expect(Object.values(stored ?? {})).not.toContain('user_token');
    expect(Object.values(stored ?? {})).not.toContain('consumer_secret');
  });

  it('does not mutate legacy plaintext credentials during an ordinary read', async () => {
    await expect(getXAccountById(db, 'account_1', credentialKey)).resolves.toMatchObject({
      access_token: 'old_app_token',
    });

    const stored = await db.prepare(
      'SELECT access_token FROM x_accounts WHERE id = ?',
    ).bind('account_1').first<{ access_token: string }>();
    expect(stored?.access_token).toBe('old_app_token');
  });

  it('migrates inactive legacy credentials and appends a secret-free audit', async () => {
    await db.prepare(
      `INSERT INTO x_accounts (
        id, x_user_id, username, access_token, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      'inactive',
      '2000000000000000000',
      'inactive_account',
      'inactive_plaintext_token',
      0,
      '2026-07-23T00:00:00.000Z',
      '2026-07-23T00:00:00.000Z',
    ).run();

    await expect(migrateAllXAccountCredentials(db, credentialKey)).resolves.toBe(2);
    const stored = await db.prepare(
      'SELECT access_token FROM x_accounts WHERE id = ?',
    ).bind('inactive').first<{ access_token: string }>();
    const audit = await db.prepare(
      "SELECT before_json, after_json FROM cubelic_audit_logs WHERE entity_id = 'inactive'",
    ).first<{ before_json: string; after_json: string }>();
    expect(stored?.access_token).toMatch(/^enc:v1:/u);
    expect(JSON.stringify(audit)).not.toContain('inactive_plaintext_token');
  });

  it('preserves already encrypted fields when migrating a mixed legacy record', async () => {
    const encryptedAccessToken = await encryptCredential(
      'already_encrypted_token',
      credentialKey,
      'access_token',
    );
    await db.prepare(
      `UPDATE x_accounts
       SET access_token = ?, consumer_key = ?
       WHERE id = ?`,
    ).bind(encryptedAccessToken, 'legacy_consumer_key', 'account_1').run();

    await expect(migrateAllXAccountCredentials(db, credentialKey)).resolves.toBe(1);
    const stored = await db.prepare(
      'SELECT access_token, consumer_key FROM x_accounts WHERE id = ?',
    ).bind('account_1').first<{ access_token: string; consumer_key: string }>();
    expect(stored?.access_token).toBe(encryptedAccessToken);
    expect(stored?.consumer_key).toMatch(/^enc:v1:/u);
    await expect(getXAccountById(db, 'account_1', credentialKey)).resolves.toMatchObject({
      access_token: 'already_encrypted_token',
      consumer_key: 'legacy_consumer_key',
    });
  });
});
