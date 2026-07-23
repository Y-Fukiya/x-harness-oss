import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const errors = [];
const hermesRuntimeEnabled = process.env.HERMES_RUNTIME_ENABLED === 'true';
const productionContentIngestEnabled = process.env.PRODUCTION_CONTENT_INGEST_ENABLED === 'true';
const cloudflareAuthVerified = process.env.CLOUDFLARE_AUTH_VERIFIED === 'true';
const phase3Enabled = process.env.CUBELIC_PHASE3_ENABLED === 'true';
const phase3MediaEnabled = process.env.CUBELIC_PHASE3_MEDIA_ENABLED === 'true';
const humanInteractionsEnabled = process.env.CUBELIC_HUMAN_INTERACTIONS_ENABLED === 'true';
const requiredSecrets = [
  'API_KEY',
  'HUMAN_APPROVAL_KEY',
  'SESSION_SIGNING_KEY',
  'STAFF_KEY_PEPPER',
  'CREDENTIAL_ENCRYPTION_KEY',
];
if (hermesRuntimeEnabled) requiredSecrets.push('HERMES_ACCESS_TOKEN');
if (humanInteractionsEnabled) requiredSecrets.push('INTERACTION_FINGERPRINT_KEY');

for (const name of ['HERMES_RUNTIME_ENABLED', 'PRODUCTION_CONTENT_INGEST_ENABLED', 'PRODUCTION_INPUTS_VALIDATED', 'PRODUCTION_LP_MAPPING_VALIDATED', 'CLOUDFLARE_AUTH_VERIFIED', 'CUBELIC_PHASE3_ENABLED', 'CUBELIC_PHASE3_MEDIA_ENABLED', 'CUBELIC_PHASE3_MEDIA_SMOKE_MODE', 'CUBELIC_HUMAN_INTERACTIONS_ENABLED', 'CUBELIC_HUMAN_INTERACTIONS_SMOKE_MODE', 'PHASE3_RELEASE_APPROVED', 'STAGING_PHASE3_SMOKE_VERIFIED', 'STAGING_PHASE3_MEDIA_SMOKE_VERIFIED', 'MEDIA_RETENTION_POLICY_VERIFIED', 'HUMAN_INTERACTIONS_RELEASE_APPROVED', 'STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED']) {
  if (process.env[name] && !['true', 'false'].includes(process.env[name])) {
    errors.push(`${name} must be true or false when set`);
  }
}

for (const name of requiredSecrets) {
  if (!process.env[name]) errors.push(`missing secret environment variable: ${name}`);
  else if (process.env[name].length < 32) errors.push(`${name} is shorter than the 32-character production minimum`);
}
if (process.env.CREDENTIAL_ENCRYPTION_KEY) {
  try {
    if (
      !/^[A-Za-z0-9_-]+$/u.test(process.env.CREDENTIAL_ENCRYPTION_KEY)
      || Buffer.from(process.env.CREDENTIAL_ENCRYPTION_KEY, 'base64url').byteLength !== 32
    ) {
      errors.push('CREDENTIAL_ENCRYPTION_KEY must be a base64url-encoded 32-byte key');
    }
  } catch {
    errors.push('CREDENTIAL_ENCRYPTION_KEY must be a base64url-encoded 32-byte key');
  }
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u.test(process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION ?? '')) {
  errors.push('CREDENTIAL_ENCRYPTION_KEY_VERSION must be an explicit version identifier');
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u.test(process.env.INTERACTION_FINGERPRINT_KEY_VERSION ?? '')) {
  errors.push('INTERACTION_FINGERPRINT_KEY_VERSION must be an explicit version identifier');
}
if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_API_TOKEN.length < 32) {
  errors.push('CLOUDFLARE_API_TOKEN is shorter than the 32-character production minimum');
}
if (!process.env.CLOUDFLARE_API_TOKEN && !cloudflareAuthVerified) {
  errors.push('set a least-privilege CLOUDFLARE_API_TOKEN or set CLOUDFLARE_AUTH_VERIFIED=true after wrangler whoami succeeds');
}
const authorizationSecretNames = [
  'API_KEY',
  'HUMAN_APPROVAL_KEY',
  'SESSION_SIGNING_KEY',
  'STAFF_KEY_PEPPER',
  'CREDENTIAL_ENCRYPTION_KEY',
];
if (hermesRuntimeEnabled) authorizationSecretNames.push('HERMES_ACCESS_TOKEN');
if (humanInteractionsEnabled) authorizationSecretNames.push('INTERACTION_FINGERPRINT_KEY');
const authorizationSecrets = authorizationSecretNames.map((name) => process.env[name]).filter(Boolean);
if (new Set(authorizationSecrets).size !== authorizationSecrets.length) {
  errors.push(`${authorizationSecretNames.join(', ')} must be distinct`);
}
if (!process.env.X_HARNESS_ACCOUNT_ID || process.env.X_HARNESS_ACCOUNT_ID === 'SET_AFTER_ACCOUNT_SETUP') {
  errors.push('missing production X_HARNESS_ACCOUNT_ID mapping');
}
if (process.env.CUBELIC_SAFE_MODE !== 'true') errors.push('CUBELIC_SAFE_MODE must be explicitly true');
if (process.env.CUBELIC_PHASE3_DELIVERY_MODE !== 'x') {
  errors.push('CUBELIC_PHASE3_DELIVERY_MODE must be x for every production release');
}
if (phase3Enabled) {
  if (process.env.GLOBAL_PUBLISHING_DISABLED !== 'false') {
    errors.push('GLOBAL_PUBLISHING_DISABLED must be explicitly false for an approved Phase 3 release');
  }
  if (process.env.PHASE3_RELEASE_APPROVED !== 'true') {
    errors.push('PHASE3_RELEASE_APPROVED must be true for a Phase 3 publication release');
  }
  if (process.env.STAGING_PHASE3_SMOKE_VERIFIED !== 'true') {
    errors.push('STAGING_PHASE3_SMOKE_VERIFIED must be true after Phase 3 staging smoke succeeds');
  }
  const allowedCategories = new Set(['event_notice', 'event_reminder', 'youtube_notice']);
  const policies = (process.env.CUBELIC_PHASE3_SCHEDULE_POLICIES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (policies.length === 0 || policies.some((policy) => {
    const [category, templateId, ...rest] = policy.split(':');
    return rest.length > 0
      || !allowedCategories.has(category)
      || !/^[a-z0-9][a-z0-9_-]{2,80}$/.test(templateId ?? '');
  })) {
    errors.push('CUBELIC_PHASE3_SCHEDULE_POLICIES must contain reviewed category:template_id pairs');
  }
} else if (!humanInteractionsEnabled && process.env.GLOBAL_PUBLISHING_DISABLED !== 'true') {
  errors.push('GLOBAL_PUBLISHING_DISABLED must be explicitly true');
}
if (humanInteractionsEnabled && process.env.GLOBAL_PUBLISHING_DISABLED !== 'false') {
  errors.push('GLOBAL_PUBLISHING_DISABLED must be explicitly false for named-human interactions');
}
if (phase3MediaEnabled && !phase3Enabled) {
  errors.push('CUBELIC_PHASE3_MEDIA_ENABLED requires CUBELIC_PHASE3_ENABLED=true');
}
if (phase3MediaEnabled && process.env.STAGING_PHASE3_MEDIA_SMOKE_VERIFIED !== 'true') {
  errors.push('STAGING_PHASE3_MEDIA_SMOKE_VERIFIED must be true after a media staging and delivery smoke succeeds');
}
if (phase3MediaEnabled && process.env.MEDIA_RETENTION_POLICY_VERIFIED !== 'true') {
  errors.push('MEDIA_RETENTION_POLICY_VERIFIED must be true after the R2 retention and incident-quarantine policy is verified');
}
if (process.env.CUBELIC_PHASE3_MEDIA_SMOKE_MODE !== 'false') {
  errors.push('CUBELIC_PHASE3_MEDIA_SMOKE_MODE must be false for production');
}
if (humanInteractionsEnabled && process.env.HUMAN_INTERACTIONS_RELEASE_APPROVED !== 'true') {
  errors.push('HUMAN_INTERACTIONS_RELEASE_APPROVED must be true for a named-human interaction release');
}
if (humanInteractionsEnabled && process.env.STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED !== 'true') {
  errors.push('STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED must be true after named-human staging smoke succeeds');
}
if (!humanInteractionsEnabled && (
  process.env.HUMAN_INTERACTIONS_RELEASE_APPROVED !== 'false'
  || process.env.STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED !== 'false'
)) {
  errors.push('disabled named-human interactions must keep release and staging-smoke gates false');
}
if (process.env.CUBELIC_HUMAN_INTERACTIONS_SMOKE_MODE !== 'false') {
  errors.push('CUBELIC_HUMAN_INTERACTIONS_SMOKE_MODE must be false for production');
}
if (productionContentIngestEnabled && process.env.PRODUCTION_INPUTS_VALIDATED !== 'true') {
  errors.push('PRODUCTION_INPUTS_VALIDATED must be true before production content ingestion is enabled');
}
if (productionContentIngestEnabled && process.env.PRODUCTION_LP_MAPPING_VALIDATED !== 'true') {
  errors.push('PRODUCTION_LP_MAPPING_VALIDATED must be true before production content ingestion is enabled');
}
if (process.env.STAGING_SMOKE_VERIFIED !== 'true') errors.push('STAGING_SMOKE_VERIFIED must be true after smoke:staging succeeds');
const corsOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
if (corsOrigins.length === 0) errors.push('CORS_ALLOWED_ORIGINS must contain at least one production UI origin');
if (corsOrigins.some((origin) => origin === '*' || !origin.startsWith('https://') || /localhost|127\.0\.0\.1/.test(origin))) {
  errors.push('production CORS origins must be exact HTTPS origins without wildcard or localhost');
}
if (!corsOrigins.includes('https://ops.cubelic-fan.com')) {
  errors.push('CORS_ALLOWED_ORIGINS must include the approved production operator UI origin: https://ops.cubelic-fan.com');
}
if (corsOrigins.includes('https://cubelic-fan.com')) {
  errors.push('the public fan-site origin must not be authorized as the production operator UI');
}

const wrangler = await readFile(join(root, 'apps/worker/wrangler.toml'), 'utf8');
const productionVars = wrangler.match(/\[env\.production\.vars\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? '';
const productionVar = (name) => productionVars.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"$`, 'm'))?.[1];
if (/YOUR_D1_DATABASE_ID/.test(wrangler)) errors.push('wrangler.toml still contains the D1 database-id placeholder');
if (/your-subdomain\.workers\.dev/.test(wrangler)) errors.push('wrangler.toml still contains the Worker URL placeholder');
if (/X_HARNESS_ACCOUNT_ID\s*=\s*"SET_AFTER_ACCOUNT_SETUP"/.test(wrangler)) errors.push('wrangler.toml still contains the X account placeholder');
if (/CORS_ALLOWED_ORIGINS\s*=\s*"http:\/\/localhost/.test(wrangler)) errors.push('wrangler.toml still contains the local CORS origin');
if (!/CORS_ALLOWED_ORIGINS\s*=\s*"https:\/\/ops\.cubelic-fan\.com"/.test(wrangler)) {
  errors.push('wrangler.toml does not bind production CORS to the approved operator UI origin');
}
if (!/^CUBELIC_SAFE_MODE\s*=\s*"true"$/m.test(wrangler)) errors.push('wrangler.toml does not default CUBELIC_SAFE_MODE to true');
const expectedProductionVars = {
  CREDENTIAL_ENCRYPTION_KEY_VERSION: process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION,
  INTERACTION_FINGERPRINT_KEY_VERSION: process.env.INTERACTION_FINGERPRINT_KEY_VERSION,
  CUBELIC_PHASE3_ENABLED: phase3Enabled ? 'true' : 'false',
  CUBELIC_PHASE3_DELIVERY_MODE: 'x',
  CUBELIC_PHASE3_MEDIA_ENABLED: phase3MediaEnabled ? 'true' : 'false',
  CUBELIC_PHASE3_MEDIA_SMOKE_MODE: 'false',
  CUBELIC_PHASE3_SCHEDULE_POLICIES: phase3Enabled
    ? process.env.CUBELIC_PHASE3_SCHEDULE_POLICIES
    : '',
  CUBELIC_HUMAN_INTERACTIONS_ENABLED: humanInteractionsEnabled ? 'true' : 'false',
  PHASE3_RELEASE_APPROVED: phase3Enabled ? 'true' : 'false',
  STAGING_PHASE3_SMOKE_VERIFIED: phase3Enabled ? 'true' : 'false',
  STAGING_PHASE3_MEDIA_SMOKE_VERIFIED: phase3MediaEnabled ? 'true' : 'false',
  MEDIA_RETENTION_POLICY_VERIFIED: phase3MediaEnabled ? 'true' : 'false',
  HUMAN_INTERACTIONS_RELEASE_APPROVED: humanInteractionsEnabled ? 'true' : 'false',
  STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED: humanInteractionsEnabled ? 'true' : 'false',
  CUBELIC_HUMAN_INTERACTIONS_SMOKE_MODE: 'false',
  GLOBAL_PUBLISHING_DISABLED: phase3Enabled || humanInteractionsEnabled ? 'false' : 'true',
};
for (const [name, expected] of Object.entries(expectedProductionVars)) {
  if (productionVar(name) !== expected) {
    errors.push(`wrangler production ${name} does not match the requested release mode`);
  }
}

if (errors.length) {
  console.error(`Production preflight is blocked (${errors.length}):\n- ${errors.join('\n- ')}`);
  console.error('No secret values were printed. Resolve the named inputs, then rerun pnpm preflight:production.');
  process.exitCode = 1;
} else {
  console.log(phase3Enabled
    ? 'Production preflight passed for the approved Phase 3 publication capability. Run the Phase 3 staging checklist before deployment.'
    : 'Production preflight passed for the Phase 1 runtime. Run the staging checklist before any production deployment.');
}
