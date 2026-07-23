import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import {
  createStaffMember,
  getStaffMemberByApiKey,
  migrateStaffApiKeys,
} from './staff.js';
import { compileMigrationForD1Exec } from './d1-test-utils.js';

describe('staff API-key storage', () => {
  let miniflare: Miniflare;
  let db: D1Database;
  const pepper = 'test-staff-key-pepper-with-at-least-32-bytes';

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2026-07-23',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: 'staff-key-integration-test' },
    });
    db = await miniflare.getD1Database('DB') as unknown as D1Database;
    await db.exec(compileMigrationForD1Exec(`
      CREATE TABLE staff_members (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        api_key TEXT NOT NULL UNIQUE,
        api_key_hash TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        last_login_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_staff_api_key_hash ON staff_members(api_key_hash);
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
    `));
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  it('stores a new staff key only as a keyed digest and still authenticates it', async () => {
    const plainApiKey = 'xh_new_operator_secret_value';

    const created = await createStaffMember(db, {
      name: 'Operator',
      role: 'editor',
      apiKey: plainApiKey,
    }, pepper, {
      actor: 'human',
      action: 'staff.created',
      entityType: 'staff',
      entityId: '',
      before: {},
      after: { role: 'editor' },
      correlationId: 'staff-create',
    });
    const stored = await db.prepare(
      'SELECT api_key, api_key_hash FROM staff_members WHERE id = ?',
    ).bind(created.id).first<{ api_key: string; api_key_hash: string }>();

    expect(stored?.api_key).not.toContain(plainApiKey);
    expect(stored?.api_key_hash).toMatch(/^[0-9a-f]{64}$/u);
    await expect(db.prepare(
      'SELECT COUNT(*) AS count FROM cubelic_audit_logs WHERE entity_id = ?',
    ).bind(created.id).first<{ count: number }>()).resolves.toEqual({ count: 1 });
    await expect(getStaffMemberByApiKey(db, plainApiKey, pepper)).resolves.toMatchObject({
      id: created.id,
      role: 'editor',
    });
    await expect(getStaffMemberByApiKey(db, 'xh_wrong_key', pepper)).resolves.toBeNull();
  });

  it('migrates every legacy plaintext key before authentication', async () => {
    const legacyKey = 'xh_legacy_operator_secret';
    await db.prepare(
      `INSERT INTO staff_members (
        id, name, role, api_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      'staff_legacy',
      'Legacy Operator',
      'admin',
      legacyKey,
      '2026-07-23T00:00:00.000Z',
      '2026-07-23T00:00:00.000Z',
    ).run();

    const migrated = await migrateStaffApiKeys(db, pepper);
    const stored = await db.prepare(
      'SELECT api_key, api_key_hash FROM staff_members WHERE id = ?',
    ).bind('staff_legacy').first<{ api_key: string; api_key_hash: string }>();

    expect(migrated).toBe(1);
    expect(stored?.api_key).not.toContain(legacyKey);
    expect(stored?.api_key_hash).toMatch(/^[0-9a-f]{64}$/u);
    await expect(db.prepare(
      "SELECT COUNT(*) AS count FROM cubelic_audit_logs WHERE entity_id = 'staff_legacy'",
    ).first<{ count: number }>()).resolves.toEqual({ count: 1 });
    await expect(getStaffMemberByApiKey(db, legacyKey, pepper)).resolves.toMatchObject({
      id: 'staff_legacy',
    });
  });
});
