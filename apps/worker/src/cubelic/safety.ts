import type { Context, Next } from 'hono';
import type { Env } from '../index.js';

const PHASE_1_EXACT_ROUTES = new Set([
  'GET /api/health',
  'GET /api/session',
  'POST /api/session/login',
  'DELETE /api/session',
  'GET /api/capabilities',
  'GET /api/x-accounts',
]);

export function isCubelicSafeMode(env: Env['Bindings']): boolean {
  // Phase 1 is compile-time draft-only. An environment variable must not
  // reopen legacy publishing, scheduling, engagement, or DM write paths.
  void env;
  return true;
}

export function isPublishingGloballyDisabled(env: Env['Bindings']): boolean {
  return env.GLOBAL_PUBLISHING_DISABLED !== 'false';
}

export function isStagingFakeDelivery(env: Env['Bindings']): boolean {
  if (env.CUBELIC_PHASE3_DELIVERY_MODE !== 'staging_fake' || !env.WORKER_URL) return false;
  try {
    return new URL(env.WORKER_URL).hostname === 'x-harness-worker-staging.yoshihiro-fukiya.workers.dev';
  } catch {
    return false;
  }
}

export function isPhase3DeliveryConfigured(env: Env['Bindings']): boolean {
  return env.CUBELIC_PHASE3_DELIVERY_MODE === 'x' || isStagingFakeDelivery(env);
}

export function isPhase3PublicationEnabled(env: Env['Bindings']): boolean {
  return env.CUBELIC_PHASE3_ENABLED === 'true'
    && env.X_INTERACTION_WATCH_ENABLED !== 'true'
    && isPhase3DeliveryConfigured(env)
    && env.PHASE3_RELEASE_APPROVED === 'true'
    && env.STAGING_PHASE3_SMOKE_VERIFIED === 'true';
}

export function isPhase3MediaDeliveryEnabled(env: Env['Bindings']): boolean {
  const stagingSmokeMode = env.ENVIRONMENT === 'staging'
    && isStagingFakeDelivery(env)
    && env.CUBELIC_PHASE3_MEDIA_SMOKE_MODE === 'true';
  const verifiedRelease = env.STAGING_PHASE3_MEDIA_SMOKE_VERIFIED === 'true'
    && env.MEDIA_RETENTION_POLICY_VERIFIED === 'true';
  return isPhase3PublicationEnabled(env)
    && env.CUBELIC_PHASE3_MEDIA_ENABLED === 'true'
    && (stagingSmokeMode || verifiedRelease)
    && Boolean(env.CUBELIC_MEDIA);
}

export function isNamedHumanInteractionEnabled(env: Env['Bindings']): boolean {
  const stagingSmokeMode = env.ENVIRONMENT === 'staging'
    && isStagingFakeDelivery(env)
    && env.CUBELIC_HUMAN_INTERACTIONS_SMOKE_MODE === 'true';
  const verifiedRelease = env.HUMAN_INTERACTIONS_RELEASE_APPROVED === 'true'
    && env.STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED === 'true';
  return env.CUBELIC_HUMAN_INTERACTIONS_ENABLED === 'true'
    && env.X_INTERACTION_WATCH_ENABLED !== 'true'
    && isPhase3DeliveryConfigured(env)
    && (stagingSmokeMode || verifiedRelease);
}

export function isInteractionWatchEnabled(env: Env['Bindings']): boolean {
  const stagingSmokeMode = env.ENVIRONMENT === 'staging'
    && env.X_INTERACTION_WATCH_SMOKE_MODE === 'true';
  const verifiedRelease = env.X_INTERACTION_WATCH_RELEASE_APPROVED === 'true'
    && env.X_INTERACTION_WATCH_STAGING_SMOKE_VERIFIED === 'true';
  const privacyReviewed = env.X_INTERACTION_WATCH_PRIVACY_REVIEW_APPROVED === 'true'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(
      env.X_INTERACTION_WATCH_PRIVACY_REVIEW_ID ?? '',
    )
    && /^[1-9][0-9]{4,29}$/.test(
      env.X_INTERACTION_WATCH_REVIEWED_TARGET_USER_ID ?? '',
    );
  const readCredentialReady = stagingSmokeMode
    || (env.X_INTERACTION_WATCH_BEARER_TOKEN?.length ?? 0) >= 32;
  return env.X_INTERACTION_WATCH_ENABLED === 'true'
    && env.CUBELIC_PHASE3_ENABLED !== 'true'
    && env.CUBELIC_HUMAN_INTERACTIONS_ENABLED !== 'true'
    && privacyReviewed
    && readCredentialReady
    && (stagingSmokeMode || verifiedRelease);
}

export function isInteractionWatchTargetApproved(
  env: Env['Bindings'],
  targetUserId: string,
): boolean {
  return /^[1-9][0-9]{4,29}$/.test(targetUserId)
    && env.X_INTERACTION_WATCH_REVIEWED_TARGET_USER_ID === targetUserId;
}

export function isPhase1RouteBlocked(method: string, path: string, env: Env['Bindings']): boolean {
  void env;
  if (method === 'OPTIONS') return false;
  if (path.startsWith('/api/cubelic/')) return false;
  if (PHASE_1_EXACT_ROUTES.has(`${method} ${path}`)) return false;
  return true;
}

export async function cubelicPhase1RouteGuard(c: Context<Env>, next: Next): Promise<Response | void> {
  const path = new URL(c.req.url).pathname;
  if (!isPhase1RouteBlocked(c.req.method, path, c.env)) return next();
  return c.json({
    success: false,
    error: 'CUBΣLIC Phase 1 blocks legacy X and administration routes',
    code: isPublishingGloballyDisabled(c.env) ? 'global_publishing_disabled' : 'cubelic_safe_mode',
  }, 423);
}
