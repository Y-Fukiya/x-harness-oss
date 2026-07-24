import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function keychainSecret(service) {
  try {
    const value = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', service, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!value) throw new Error('empty secret');
    return value;
  } catch {
    throw new Error(`Required macOS Keychain item is unavailable: ${service}`);
  }
}

function restrictedKeychainSecret(service) {
  try {
    const value = execFileSync(
      '/usr/bin/swift',
      [fileURLToPath(new URL('./store-keychain-secret.swift', import.meta.url))],
      {
        input: JSON.stringify({
          action: 'read',
          service,
          account: process.env.USER ?? 'codex-operator',
        }),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    ).trim();
    if (!value) throw new Error('empty secret');
    return value;
  } catch {
    throw new Error(`Required protected Keychain item is unavailable: ${service}`);
  }
}

Object.assign(process.env, {
  API_KEY: keychainSecret(
    process.env.PRODUCTION_API_KEY_KEYCHAIN_SERVICE
      ?? 'CUBELIC Production API Key',
  ),
  HUMAN_APPROVAL_KEY: keychainSecret(
    process.env.PRODUCTION_HUMAN_APPROVAL_KEYCHAIN_SERVICE
      ?? 'CUBELIC Production Human Approval Key',
  ),
  SESSION_SIGNING_KEY: keychainSecret(
    process.env.PRODUCTION_SESSION_SIGNING_KEYCHAIN_SERVICE
      ?? 'X Harness Production Session Signing Key',
  ),
  STAFF_KEY_PEPPER: keychainSecret(
    process.env.PRODUCTION_STAFF_KEY_PEPPER_KEYCHAIN_SERVICE
      ?? 'X Harness Production Staff Key Pepper',
  ),
  CREDENTIAL_ENCRYPTION_KEY: keychainSecret(
    process.env.PRODUCTION_CREDENTIAL_ENCRYPTION_KEYCHAIN_SERVICE
      ?? 'X Harness Production Credential Encryption Key',
  ),
  X_INTERACTION_WATCH_BEARER_TOKEN: restrictedKeychainSecret(
    process.env.INTERACTION_WATCH_BEARER_KEYCHAIN_SERVICE
      ?? 'X Harness Production Interaction Watch Bearer Token',
  ),
  X_INTERACTION_WATCH_REVIEWED_TARGET_USER_ID: restrictedKeychainSecret(
    process.env.INTERACTION_WATCH_TARGET_ID_KEYCHAIN_SERVICE
      ?? 'X Harness Production Interaction Watch Reviewed Target User ID',
  ),
  CREDENTIAL_ENCRYPTION_KEY_VERSION: '2026-07-23-v1',
  INTERACTION_FINGERPRINT_KEY_VERSION: '2026-07-24-v1',
  CLOUDFLARE_AUTH_VERIFIED: 'true',
  X_HARNESS_ACCOUNT_ID: '89f9bfc0-428c-480b-9cb3-9ba1698c30da',
  CUBELIC_SAFE_MODE: 'true',
  CUBELIC_PHASE3_DELIVERY_MODE: 'x',
  CUBELIC_PHASE3_MEDIA_ENABLED: 'false',
  CUBELIC_PHASE3_MEDIA_SMOKE_MODE: 'false',
  CUBELIC_PHASE3_ENABLED: 'false',
  CUBELIC_PHASE3_SCHEDULE_POLICIES: '',
  CUBELIC_HUMAN_INTERACTIONS_ENABLED: 'false',
  CUBELIC_HUMAN_INTERACTIONS_SMOKE_MODE: 'false',
  PHASE3_RELEASE_APPROVED: 'false',
  STAGING_PHASE3_SMOKE_VERIFIED: 'false',
  STAGING_PHASE3_MEDIA_SMOKE_VERIFIED: 'false',
  MEDIA_RETENTION_POLICY_VERIFIED: 'false',
  HUMAN_INTERACTIONS_RELEASE_APPROVED: 'false',
  STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED: 'false',
  X_INTERACTION_WATCH_ENABLED: 'true',
  X_INTERACTION_WATCH_SMOKE_MODE: 'false',
  X_INTERACTION_WATCH_RELEASE_APPROVED: 'true',
  X_INTERACTION_WATCH_STAGING_SMOKE_VERIFIED: 'true',
  X_INTERACTION_WATCH_PRIVACY_REVIEW_APPROVED: 'true',
  X_INTERACTION_WATCH_PRIVACY_REVIEW_ID: 'privacy_review_watch_20260724_v1',
  GLOBAL_PUBLISHING_DISABLED: 'false',
  HERMES_RUNTIME_ENABLED: 'false',
  PRODUCTION_CONTENT_INGEST_ENABLED: 'false',
  STAGING_SMOKE_VERIFIED: 'true',
  CORS_ALLOWED_ORIGINS: 'https://ops.cubelic-fan.com',
});

await import('./preflight-production.mjs');
