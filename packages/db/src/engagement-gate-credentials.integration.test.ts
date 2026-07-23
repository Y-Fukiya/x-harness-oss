import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { migrateEngagementGateApiKeys } from './engagement-gates.js';
import { compileMigrationForD1Exec } from './d1-test-utils.js';

describe('engagement gate external credentials', () => {
  let miniflare: Miniflare;
  let db: D1Database;
  const credentialKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2026-07-23',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: 'engagement-gate-credential-test' },
    });
    db = await miniflare.getD1Database('DB') as unknown as D1Database;
    await db.exec(compileMigrationForD1Exec(`
      CREATE TABLE engagement_gates (
        id TEXT PRIMARY KEY,
        line_harness_api_key TEXT
      );
      INSERT INTO engagement_gates (id, line_harness_api_key)
      VALUES ('legacy', 'legacy-external-key');
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

  it('encrypts every legacy external API key in place', async () => {
    await expect(migrateEngagementGateApiKeys(db, credentialKey)).resolves.toBe(1);
    const stored = await db.prepare(
      'SELECT line_harness_api_key FROM engagement_gates WHERE id = ?',
    ).bind('legacy').first<{ line_harness_api_key: string }>();
    expect(stored?.line_harness_api_key).toMatch(/^enc:v1:/u);
    expect(stored?.line_harness_api_key).not.toContain('legacy-external-key');
    await expect(db.prepare(
      "SELECT COUNT(*) AS count FROM cubelic_audit_logs WHERE entity_id = 'legacy'",
    ).first<{ count: number }>()).resolves.toEqual({ count: 1 });
  });
});
