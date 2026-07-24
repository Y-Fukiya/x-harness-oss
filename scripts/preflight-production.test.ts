import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const productionEnvironment = {
  API_KEY: 'a'.repeat(32),
  HUMAN_APPROVAL_KEY: 'b'.repeat(32),
  SESSION_SIGNING_KEY: 'c'.repeat(32),
  STAFF_KEY_PEPPER: 'd'.repeat(32),
  CREDENTIAL_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
  CREDENTIAL_ENCRYPTION_KEY_VERSION: '2026-07-23-v1',
  INTERACTION_FINGERPRINT_KEY: 'f'.repeat(32),
  INTERACTION_FINGERPRINT_KEY_VERSION: '2026-07-24-v1',
  CLOUDFLARE_AUTH_VERIFIED: 'true',
  X_HARNESS_ACCOUNT_ID: '89f9bfc0-428c-480b-9cb3-9ba1698c30da',
  CUBELIC_SAFE_MODE: 'true',
  CUBELIC_PHASE3_DELIVERY_MODE: 'x',
  CUBELIC_PHASE3_MEDIA_ENABLED: 'false',
  CUBELIC_PHASE3_MEDIA_SMOKE_MODE: 'false',
  CUBELIC_PHASE3_ENABLED: 'false',
  CUBELIC_HUMAN_INTERACTIONS_ENABLED: 'false',
  CUBELIC_HUMAN_INTERACTIONS_SMOKE_MODE: 'false',
  X_INTERACTION_WATCH_ENABLED: 'true',
  X_INTERACTION_WATCH_SMOKE_MODE: 'false',
  X_INTERACTION_WATCH_RELEASE_APPROVED: 'true',
  X_INTERACTION_WATCH_STAGING_SMOKE_VERIFIED: 'true',
  X_INTERACTION_WATCH_PRIVACY_REVIEW_APPROVED: 'true',
  X_INTERACTION_WATCH_PRIVACY_REVIEW_ID: 'privacy_review_watch_20260724_v2',
  X_INTERACTION_WATCH_REVIEWED_TARGET_USER_ID: '1900000000000000100',
  X_INTERACTION_WATCH_BEARER_TOKEN: 'w'.repeat(32),
  CUBELIC_PHASE3_SCHEDULE_POLICIES: '',
  PHASE3_RELEASE_APPROVED: 'false',
  STAGING_PHASE3_SMOKE_VERIFIED: 'false',
  STAGING_PHASE3_MEDIA_SMOKE_VERIFIED: 'false',
  MEDIA_RETENTION_POLICY_VERIFIED: 'false',
  HUMAN_INTERACTIONS_RELEASE_APPROVED: 'false',
  STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED: 'false',
  GLOBAL_PUBLISHING_DISABLED: 'false',
  STAGING_SMOKE_VERIFIED: 'true',
  CORS_ALLOWED_ORIGINS: 'https://ops.cubelic-fan.com',
};

function preflight(overrides: Record<string, string> = {}) {
  return spawnSync(process.execPath, [join(root, 'scripts/preflight-production.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      ...productionEnvironment,
      ...overrides,
    },
  });
}

describe('production preflight phase boundaries', () => {
  it('rejects a release shell that does not match the deployed watch mode', () => {
    const result = preflight({
      CUBELIC_PHASE3_ENABLED: 'false',
      CUBELIC_PHASE3_SCHEDULE_POLICIES: '',
      PHASE3_RELEASE_APPROVED: 'false',
      STAGING_PHASE3_SMOKE_VERIFIED: 'false',
      X_INTERACTION_WATCH_ENABLED: 'false',
      X_INTERACTION_WATCH_RELEASE_APPROVED: 'false',
      X_INTERACTION_WATCH_STAGING_SMOKE_VERIFIED: 'false',
      X_INTERACTION_WATCH_PRIVACY_REVIEW_APPROVED: 'false',
      X_INTERACTION_WATCH_PRIVACY_REVIEW_ID: '',
      X_INTERACTION_WATCH_REVIEWED_TARGET_USER_ID: '',
      X_INTERACTION_WATCH_BEARER_TOKEN: '',
      GLOBAL_PUBLISHING_DISABLED: 'true',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('wrangler production X_INTERACTION_WATCH_ENABLED does not match');
  });

  it('requires a distinct Hermes token only when Hermes runtime is enabled', () => {
    const missing = preflight({ HERMES_RUNTIME_ENABLED: 'true' });
    const reused = preflight({ HERMES_RUNTIME_ENABLED: 'true', HERMES_ACCESS_TOKEN: productionEnvironment.API_KEY });

    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('missing secret environment variable: HERMES_ACCESS_TOKEN');
    expect(reused.status).toBe(1);
    expect(reused.stderr).toContain('must be distinct');
  });

  it('requires strong and distinct dashboard credential-protection keys', () => {
    const missing = preflight({ SESSION_SIGNING_KEY: '' });
    const short = preflight({ STAFF_KEY_PEPPER: 'short' });
    const reused = preflight({ SESSION_SIGNING_KEY: productionEnvironment.API_KEY });
    const invalidEncryptionKey = preflight({ CREDENTIAL_ENCRYPTION_KEY: 'e'.repeat(32) });

    expect(missing.stderr).toContain('missing secret environment variable: SESSION_SIGNING_KEY');
    expect(short.stderr).toContain('STAFF_KEY_PEPPER is shorter');
    expect(reused.stderr).toContain('must be distinct');
    expect(invalidEncryptionKey.stderr).toContain(
      'CREDENTIAL_ENCRYPTION_KEY must be a base64url-encoded 32-byte key',
    );
  });

  it('requires the credential key version to match the deployed production config', () => {
    const result = preflight({ CREDENTIAL_ENCRYPTION_KEY_VERSION: '2026-07-23-v2' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'wrangler production CREDENTIAL_ENCRYPTION_KEY_VERSION does not match',
    );
  });

  it('requires the interaction fingerprint key version to match the deployed production config', () => {
    const result = preflight({ INTERACTION_FINGERPRINT_KEY_VERSION: '2026-07-24-v2' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'wrangler production INTERACTION_FINGERPRINT_KEY_VERSION does not match',
    );
  });

  it('requires real input validation only when production content ingestion is enabled', () => {
    const missing = preflight({ PRODUCTION_CONTENT_INGEST_ENABLED: 'true' });
    const inputsOnly = preflight({
      PRODUCTION_CONTENT_INGEST_ENABLED: 'true',
      PRODUCTION_INPUTS_VALIDATED: 'true',
    });
    const validated = preflight({
      PRODUCTION_CONTENT_INGEST_ENABLED: 'true',
      PRODUCTION_INPUTS_VALIDATED: 'true',
      PRODUCTION_LP_MAPPING_VALIDATED: 'true',
    });

    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('PRODUCTION_INPUTS_VALIDATED must be true');
    expect(inputsOnly.status).toBe(1);
    expect(inputsOnly.stderr).toContain('PRODUCTION_LP_MAPPING_VALIDATED must be true');
    expect(validated.status).toBe(0);
  });

  it('requires the release shell to match the production environment stop', () => {
    const result = preflight({ GLOBAL_PUBLISHING_DISABLED: 'true' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GLOBAL_PUBLISHING_DISABLED must be explicitly false');
  });

  it('requires media delivery to match the separately reviewed production flag', () => {
    const result = preflight({ CUBELIC_PHASE3_MEDIA_ENABLED: 'true' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'STAGING_PHASE3_MEDIA_SMOKE_VERIFIED must be true',
    );
    expect(result.stderr).toContain(
      'MEDIA_RETENTION_POLICY_VERIFIED must be true',
    );
    expect(result.stderr).toContain(
      'wrangler production CUBELIC_PHASE3_MEDIA_ENABLED does not match',
    );
  });

  it('keeps named-human interactions disabled until their separate release review and smoke', () => {
    const missingGates = preflight({
      CUBELIC_HUMAN_INTERACTIONS_ENABLED: 'true',
      INTERACTION_FINGERPRINT_KEY: '',
    });
    expect(missingGates.status).toBe(1);
    expect(missingGates.stderr).toContain('HUMAN_INTERACTIONS_RELEASE_APPROVED must be true');
    expect(missingGates.stderr).toContain('STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED must be true');
    expect(missingGates.stderr).toContain(
      'wrangler production CUBELIC_HUMAN_INTERACTIONS_ENABLED does not match',
    );
    expect(missingGates.stderr).toContain(
      'missing secret environment variable: INTERACTION_FINGERPRINT_KEY',
    );
  });

  it('requires a separate read-only credential, privacy review, and isolated release for interaction watches', () => {
    const missingGates = preflight({
      CUBELIC_PHASE3_ENABLED: 'false',
      CUBELIC_PHASE3_SCHEDULE_POLICIES: '',
      PHASE3_RELEASE_APPROVED: 'false',
      STAGING_PHASE3_SMOKE_VERIFIED: 'false',
      X_INTERACTION_WATCH_ENABLED: 'true',
      X_INTERACTION_WATCH_SMOKE_MODE: 'false',
      X_INTERACTION_WATCH_RELEASE_APPROVED: 'false',
      X_INTERACTION_WATCH_STAGING_SMOKE_VERIFIED: 'false',
      X_INTERACTION_WATCH_PRIVACY_REVIEW_APPROVED: 'false',
      X_INTERACTION_WATCH_PRIVACY_REVIEW_ID: '',
      X_INTERACTION_WATCH_REVIEWED_TARGET_USER_ID: '',
      X_INTERACTION_WATCH_BEARER_TOKEN: '',
      GLOBAL_PUBLISHING_DISABLED: 'false',
    });

    expect(missingGates.status).toBe(1);
    expect(missingGates.stderr).toContain(
      'missing secret environment variable: X_INTERACTION_WATCH_BEARER_TOKEN',
    );
    expect(missingGates.stderr).toContain('X_INTERACTION_WATCH_RELEASE_APPROVED must be true');
    expect(missingGates.stderr).toContain('X_INTERACTION_WATCH_PRIVACY_REVIEW_ID must contain');

    const mixedWithWrites = preflight({
      CUBELIC_PHASE3_ENABLED: 'true',
      X_INTERACTION_WATCH_ENABLED: 'true',
      X_INTERACTION_WATCH_SMOKE_MODE: 'false',
      X_INTERACTION_WATCH_RELEASE_APPROVED: 'true',
      X_INTERACTION_WATCH_STAGING_SMOKE_VERIFIED: 'true',
      X_INTERACTION_WATCH_PRIVACY_REVIEW_APPROVED: 'true',
      X_INTERACTION_WATCH_PRIVACY_REVIEW_ID: 'privacy-review:2026-07-24',
      X_INTERACTION_WATCH_REVIEWED_TARGET_USER_ID: '1900000000000000100',
      X_INTERACTION_WATCH_BEARER_TOKEN: 'w'.repeat(32),
    });
    expect(mixedWithWrites.status).toBe(1);
    expect(mixedWithWrites.stderr).toContain(
      'X interaction watches must be isolated from every X-write release',
    );
  });

  it('rejects switching from the deployed watch mode to Phase 3 without a reviewed config change', () => {
    const missingApproval = preflight({
      CUBELIC_PHASE3_ENABLED: 'true',
      GLOBAL_PUBLISHING_DISABLED: 'false',
      PHASE3_RELEASE_APPROVED: 'false',
    });
    expect(missingApproval.status).toBe(1);
    expect(missingApproval.stderr).toContain('PHASE3_RELEASE_APPROVED must be true');

    const approved = preflight({
      CUBELIC_PHASE3_ENABLED: 'true',
      CUBELIC_PHASE3_DELIVERY_MODE: 'x',
      GLOBAL_PUBLISHING_DISABLED: 'false',
      PHASE3_RELEASE_APPROVED: 'true',
      STAGING_PHASE3_SMOKE_VERIFIED: 'true',
      CUBELIC_PHASE3_SCHEDULE_POLICIES: 'event_notice:event_notice_manual_v1',
    });
    expect(approved.status).toBe(1);
    expect(approved.stderr).toContain(
      'wrangler production CUBELIC_PHASE3_ENABLED does not match',
    );

    const mismatchedDeployment = preflight({
      CUBELIC_PHASE3_ENABLED: 'true',
      CUBELIC_PHASE3_DELIVERY_MODE: 'x',
      GLOBAL_PUBLISHING_DISABLED: 'false',
      PHASE3_RELEASE_APPROVED: 'true',
      STAGING_PHASE3_SMOKE_VERIFIED: 'true',
      CUBELIC_PHASE3_SCHEDULE_POLICIES: 'youtube_notice:youtube_notice_manual_v1',
    });
    expect(mismatchedDeployment.status).toBe(1);
    expect(mismatchedDeployment.stderr).toContain(
      'wrangler production CUBELIC_PHASE3_SCHEDULE_POLICIES does not match',
    );

    const fakeProduction = preflight({
      CUBELIC_PHASE3_ENABLED: 'true',
      CUBELIC_PHASE3_DELIVERY_MODE: 'staging_fake',
      GLOBAL_PUBLISHING_DISABLED: 'false',
      PHASE3_RELEASE_APPROVED: 'true',
      STAGING_PHASE3_SMOKE_VERIFIED: 'true',
      CUBELIC_PHASE3_SCHEDULE_POLICIES: 'event_notice:event_notice_v1',
    });
    expect(fakeProduction.status).toBe(1);
    expect(fakeProduction.stderr).toContain('CUBELIC_PHASE3_DELIVERY_MODE must be x');
  });

  it('rejects the staging fake delivery mode in every production phase', () => {
    const result = preflight({ CUBELIC_PHASE3_DELIVERY_MODE: 'staging_fake' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CUBELIC_PHASE3_DELIVERY_MODE must be x');
  });

  it('requires either verified Wrangler auth or a least-privilege API token', () => {
    const missing = preflight({ CLOUDFLARE_AUTH_VERIFIED: 'false' });
    const token = preflight({
      CLOUDFLARE_AUTH_VERIFIED: 'false',
      CLOUDFLARE_API_TOKEN: 'c'.repeat(32),
    });

    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('set a least-privilege CLOUDFLARE_API_TOKEN or set CLOUDFLARE_AUTH_VERIFIED=true');
    expect(token.status).toBe(0);
  });
});
