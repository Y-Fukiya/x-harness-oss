import { jstNow } from './utils.js';
import {
  decryptCredential,
  encryptCredential,
  isEncryptedCredential,
} from './credential-crypto.js';
import { securityAuditStatement, type SecurityAuditInput } from './audit.js';

export interface DbXAccount {
  id: string;
  x_user_id: string;
  username: string;
  display_name: string | null;
  access_token: string;
  refresh_token: string | null;
  consumer_key: string | null;
  consumer_secret: string | null;
  access_token_secret: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface XAccountAuditInput {
  actor: 'human' | 'hermes' | 'system' | 'codex';
  action: string;
  entityType: string;
  entityId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  correlationId: string;
}

const credentialFields = [
  'access_token',
  'refresh_token',
  'consumer_key',
  'consumer_secret',
  'access_token_secret',
] as const;

type CredentialField = typeof credentialFields[number];

async function encryptedCredential(
  value: string | null | undefined,
  encryptionKey: string,
  field: CredentialField,
): Promise<string | null> {
  return value == null ? null : encryptCredential(value, encryptionKey, field);
}

async function decodeAccount(
  _db: D1Database,
  account: DbXAccount,
  encryptionKey: string,
): Promise<DbXAccount> {
  const decrypted = await Promise.all(credentialFields.map(async (field) => {
    const value = account[field];
    return value == null ? null : decryptCredential(value, encryptionKey, field);
  }));
  return {
    ...account,
    access_token: decrypted[0]!,
    refresh_token: decrypted[1],
    consumer_key: decrypted[2],
    consumer_secret: decrypted[3],
    access_token_secret: decrypted[4],
  };
}

export async function createXAccount(
  db: D1Database,
  input: {
    xUserId: string;
    username: string;
    accessToken: string;
    refreshToken?: string;
    displayName?: string;
    consumerKey?: string;
    consumerSecret?: string;
    accessTokenSecret?: string;
  },
  encryptionKey: string,
  audit: SecurityAuditInput,
): Promise<DbXAccount> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const encrypted = await Promise.all([
    encryptedCredential(input.accessToken, encryptionKey, 'access_token'),
    encryptedCredential(input.refreshToken, encryptionKey, 'refresh_token'),
    encryptedCredential(input.consumerKey, encryptionKey, 'consumer_key'),
    encryptedCredential(input.consumerSecret, encryptionKey, 'consumer_secret'),
    encryptedCredential(input.accessTokenSecret, encryptionKey, 'access_token_secret'),
  ]);
  const insert = db.prepare(
    `INSERT INTO x_accounts (id, x_user_id, username, display_name, access_token, refresh_token, consumer_key, consumer_secret, access_token_secret, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
      id,
      input.xUserId,
      input.username,
      input.displayName ?? null,
      ...encrypted,
      now,
      now,
    );
  await db.batch([
    insert,
    securityAuditStatement(db, { ...audit, entityId: id }, now),
  ]);
  return {
    id,
    x_user_id: input.xUserId,
    username: input.username,
    display_name: input.displayName ?? null,
    access_token: input.accessToken,
    refresh_token: input.refreshToken ?? null,
    consumer_key: input.consumerKey ?? null,
    consumer_secret: input.consumerSecret ?? null,
    access_token_secret: input.accessTokenSecret ?? null,
    is_active: 1,
    created_at: now,
    updated_at: now,
  };
}

export async function getXAccounts(db: D1Database, encryptionKey: string): Promise<DbXAccount[]> {
  const result = await db.prepare('SELECT * FROM x_accounts WHERE is_active = 1 ORDER BY created_at').all<DbXAccount>();
  return Promise.all(result.results.map((account) => decodeAccount(db, account, encryptionKey)));
}

export async function migrateAllXAccountCredentials(
  db: D1Database,
  encryptionKey: string,
): Promise<number> {
  const result = await db.prepare('SELECT * FROM x_accounts ORDER BY created_at').all<DbXAccount>();
  const legacy = result.results.filter((account) => credentialFields.some((field) => {
    const value = account[field];
    return typeof value === 'string' && !isEncryptedCredential(value);
  }));
  for (const account of legacy) {
    const encrypted = await Promise.all(credentialFields.map((field) => {
      const value = account[field];
      return value == null || isEncryptedCredential(value)
        ? value
        : encryptCredential(value, encryptionKey, field);
    }));
    const timestamp = jstNow();
    await db.batch([
      db.prepare(
        `UPDATE x_accounts SET
          access_token = ?, refresh_token = ?, consumer_key = ?,
          consumer_secret = ?, access_token_secret = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(...encrypted, timestamp, account.id),
      securityAuditStatement(db, {
        actor: 'system',
        action: 'credential_storage.migrated',
        entityType: 'x_account',
        entityId: account.id,
        before: { storage: 'legacy_plaintext' },
        after: { storage: 'aes_gcm_v1' },
        correlationId: `credential-migration:${crypto.randomUUID()}`,
      }, timestamp),
    ]);
  }
  return legacy.length;
}

export async function getXAccountById(db: D1Database, id: string, encryptionKey: string): Promise<DbXAccount | null> {
  const account = await db.prepare('SELECT * FROM x_accounts WHERE id = ?').bind(id).first<DbXAccount>();
  return account ? decodeAccount(db, account, encryptionKey) : null;
}

export async function updateXAccount(
  db: D1Database,
  id: string,
  updates: {
    accessToken?: string;
    refreshToken?: string;
    consumerKey?: string;
    consumerSecret?: string;
    accessTokenSecret?: string;
    isActive?: boolean;
  },
  audit: XAccountAuditInput,
  encryptionKey: string,
): Promise<void> {
  const now = jstNow();
  const existing = await getXAccountById(db, id, encryptionKey);
  if (!existing) return;
  const encrypted = await Promise.all([
    encryptedCredential(updates.accessToken ?? existing.access_token, encryptionKey, 'access_token'),
    encryptedCredential(updates.refreshToken ?? existing.refresh_token, encryptionKey, 'refresh_token'),
    encryptedCredential(updates.consumerKey ?? existing.consumer_key, encryptionKey, 'consumer_key'),
    encryptedCredential(updates.consumerSecret ?? existing.consumer_secret, encryptionKey, 'consumer_secret'),
    encryptedCredential(updates.accessTokenSecret ?? existing.access_token_secret, encryptionKey, 'access_token_secret'),
  ]);
  const update = db.prepare(
      `UPDATE x_accounts SET access_token = ?, refresh_token = ?, consumer_key = ?, consumer_secret = ?, access_token_secret = ?, is_active = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(
      ...encrypted,
      updates.isActive !== undefined ? (updates.isActive ? 1 : 0) : existing.is_active,
      now,
      id,
    );
  const appendAudit = db.prepare(
    `INSERT INTO cubelic_audit_logs
      (audit_id, actor, action, entity_type, entity_id, before_json, after_json, timestamp, correlation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    `aud_${crypto.randomUUID()}`,
    audit.actor,
    audit.action,
    audit.entityType,
    audit.entityId,
    JSON.stringify(audit.before),
    JSON.stringify(audit.after),
    now,
    audit.correlationId,
  );
  await db.batch([update, appendAudit]);
}
