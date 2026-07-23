import { jstNow } from './utils.js';
import { securityAuditStatement, type SecurityAuditInput } from './audit.js';

export interface DbStaffMember {
  id: string;
  name: string;
  role: 'admin' | 'editor' | 'viewer';
  api_key: string;
  api_key_hash: string | null;
  is_active: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

const encoder = new TextEncoder();

export async function hashStaffApiKey(apiKey: string, pepper: string): Promise<string> {
  if (!apiKey || !pepper) throw new Error('Staff API-key hashing requires a key and pepper');
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(apiKey)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function staffKeyTombstone(): string {
  return `migrated_${crypto.randomUUID()}`;
}

export async function createStaffMember(
  db: D1Database,
  { name, role, apiKey }: { name: string; role: 'admin' | 'editor' | 'viewer'; apiKey: string },
  pepper: string,
  audit: SecurityAuditInput,
): Promise<DbStaffMember> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const apiKeyHash = await hashStaffApiKey(apiKey, pepper);
  const tombstone = staffKeyTombstone();
  await db.batch([
    db.prepare(
      'INSERT INTO staff_members (id, name, role, api_key, api_key_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, name, role, tombstone, apiKeyHash, now, now),
    securityAuditStatement(db, { ...audit, entityId: id }, now),
  ]);
  return {
    id,
    name,
    role,
    api_key: tombstone,
    api_key_hash: apiKeyHash,
    is_active: 1,
    last_login_at: null,
    created_at: now,
    updated_at: now,
  };
}

export async function getStaffMembers(db: D1Database): Promise<DbStaffMember[]> {
  const result = await db
    .prepare('SELECT * FROM staff_members ORDER BY created_at DESC')
    .all<DbStaffMember>();
  return result.results;
}

export async function getStaffMemberById(
  db: D1Database,
  id: string,
): Promise<DbStaffMember | null> {
  return db.prepare('SELECT * FROM staff_members WHERE id = ?').bind(id).first<DbStaffMember>();
}

export async function getStaffMemberByApiKey(
  db: D1Database,
  apiKey: string,
  pepper: string,
): Promise<DbStaffMember | null> {
  const apiKeyHash = await hashStaffApiKey(apiKey, pepper);
  const hashed = await db
    .prepare('SELECT * FROM staff_members WHERE api_key_hash = ? AND is_active = 1')
    .bind(apiKeyHash)
    .first<DbStaffMember>();
  if (hashed) return hashed;

  const legacy = await db
    .prepare('SELECT * FROM staff_members WHERE api_key = ? AND api_key_hash IS NULL AND is_active = 1')
    .bind(apiKey)
    .first<DbStaffMember>();
  if (!legacy) return null;
  const update = db.prepare(
    'UPDATE staff_members SET api_key = ?, api_key_hash = ?, updated_at = ? WHERE id = ? AND api_key_hash IS NULL',
  ).bind(staffKeyTombstone(), apiKeyHash, jstNow(), legacy.id);
  const audit = securityAuditStatement(db, {
    actor: 'system',
    action: 'credential_storage.migrated',
    entityType: 'staff',
    entityId: legacy.id,
    before: { storage: 'legacy_plaintext' },
    after: { storage: 'hmac_sha256' },
    correlationId: `credential-migration:${crypto.randomUUID()}`,
  });
  await db.batch([update, audit]);
  return { ...legacy, api_key: '', api_key_hash: apiKeyHash };
}

export async function migrateStaffApiKeys(db: D1Database, pepper: string): Promise<number> {
  const legacy = await db.prepare(
    'SELECT id, api_key FROM staff_members WHERE api_key_hash IS NULL',
  ).all<{ id: string; api_key: string }>();
  if (legacy.results.length === 0) return 0;
  const now = jstNow();
  const statements = (await Promise.all(legacy.results.map(async (staff) => [
    db.prepare(
      'UPDATE staff_members SET api_key = ?, api_key_hash = ?, updated_at = ? WHERE id = ? AND api_key_hash IS NULL',
    ).bind(staffKeyTombstone(), await hashStaffApiKey(staff.api_key, pepper), now, staff.id),
    securityAuditStatement(db, {
      actor: 'system',
      action: 'credential_storage.migrated',
      entityType: 'staff',
      entityId: staff.id,
      before: { storage: 'legacy_plaintext' },
      after: { storage: 'hmac_sha256' },
      correlationId: `credential-migration:${crypto.randomUUID()}`,
    }, now),
  ]))).flat();
  await db.batch(statements);
  return legacy.results.length;
}

export async function updateStaffMember(
  db: D1Database,
  id: string,
  updates: { name?: string; role?: 'admin' | 'editor' | 'viewer'; isActive?: boolean },
  audit: SecurityAuditInput,
): Promise<DbStaffMember | null> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.role !== undefined) {
    fields.push('role = ?');
    values.push(updates.role);
  }
  if (updates.isActive !== undefined) {
    fields.push('is_active = ?');
    values.push(updates.isActive ? 1 : 0);
  }

  if (fields.length === 0) {
    return getStaffMemberById(db, id);
  }

  const now = jstNow();
  fields.push('updated_at = ?');
  values.push(now);
  values.push(id);

  await db.batch([
    db.prepare(`UPDATE staff_members SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...values),
    securityAuditStatement(db, audit, now),
  ]);
  return getStaffMemberById(db, id);
}

export async function deleteStaffMember(
  db: D1Database,
  id: string,
  audit: SecurityAuditInput,
): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM staff_members WHERE id = ?').bind(id),
    securityAuditStatement(db, audit),
  ]);
}

export async function updateStaffLastLogin(db: D1Database, id: string): Promise<void> {
  const now = jstNow();
  await db
    .prepare('UPDATE staff_members SET last_login_at = ?, updated_at = ? WHERE id = ?')
    .bind(now, now, id)
    .run();
}
