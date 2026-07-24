import { describe, expect, it } from 'vitest';
import {
  isCubelicSafeMode,
  isInteractionWatchEnabled,
  isNamedHumanInteractionEnabled,
  isPhase1RouteBlocked,
  isPhase3PublicationEnabled,
  isPublishingGloballyDisabled,
} from './safety.js';
import type { Env } from '../index.js';

function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    CUBELIC_SAFE_MODE: 'true',
    GLOBAL_PUBLISHING_DISABLED: 'false',
    ...overrides,
  } as Env['Bindings'];
}

describe('CUBΣLIC centralized Phase 1 route boundary', () => {
  it('fails safe when CUBELIC_SAFE_MODE is absent or true', () => {
    expect(isCubelicSafeMode(env({ CUBELIC_SAFE_MODE: undefined }))).toBe(true);
    expect(isPhase1RouteBlocked('POST', '/api/posts', env())).toBe(true);
    expect(isPhase1RouteBlocked('POST', '/api/dm/send', env())).toBe(true);
    expect(isPhase1RouteBlocked('GET', '/api/posts', env())).toBe(true);
    expect(isPhase1RouteBlocked('GET', '/api/users/search', env())).toBe(true);
    expect(isPhase1RouteBlocked('GET', '/api/engagement-gates/gate_1/verify', env())).toBe(true);
    expect(isPhase1RouteBlocked('POST', '/api/settings', env())).toBe(true);
    expect(isPhase1RouteBlocked('POST', '/api/cubelic/events', env())).toBe(false);
  });

  it('allows only the read-only bootstrap surface outside CUBΣLIC routes', () => {
    expect(isPhase1RouteBlocked('OPTIONS', '/api/posts', env())).toBe(false);
    expect(isPhase1RouteBlocked('GET', '/api/health', env())).toBe(false);
    expect(isPhase1RouteBlocked('GET', '/api/session', env())).toBe(false);
    expect(isPhase1RouteBlocked('POST', '/api/session/login', env())).toBe(false);
    expect(isPhase1RouteBlocked('DELETE', '/api/session', env())).toBe(false);
    expect(isPhase1RouteBlocked('GET', '/api/capabilities', env())).toBe(false);
    expect(isPhase1RouteBlocked('GET', '/api/x-accounts', env())).toBe(false);
    expect(isPhase1RouteBlocked('PUT', '/api/x-accounts/account_1', env())).toBe(true);
    expect(isPhase1RouteBlocked('GET', '/api/x-accounts/account_1/stats', env())).toBe(true);
    expect(isPhase1RouteBlocked('GET', '/setup', env())).toBe(true);
  });

  it('keeps the environment emergency stop effective when safe mode is disabled', () => {
    const stopped = env({ CUBELIC_SAFE_MODE: 'false', GLOBAL_PUBLISHING_DISABLED: 'true' });
    expect(isPublishingGloballyDisabled(stopped)).toBe(true);
    expect(isPublishingGloballyDisabled(env({ GLOBAL_PUBLISHING_DISABLED: undefined }))).toBe(true);
    expect(isPhase1RouteBlocked('POST', '/api/posts/schedule', stopped)).toBe(true);
  });

  it('cannot reopen legacy writes through environment variables in Phase 1', () => {
    const explicitlyEnabled = env({ CUBELIC_SAFE_MODE: 'false', GLOBAL_PUBLISHING_DISABLED: 'false' });
    expect(isCubelicSafeMode(explicitlyEnabled)).toBe(true);
    expect(isPhase1RouteBlocked('POST', '/api/posts', explicitlyEnabled)).toBe(true);
    expect(isPhase1RouteBlocked('POST', '/api/dm/send', explicitlyEnabled)).toBe(true);
  });

  it('enables only the reviewed Phase 3 adapter boundary with an exact flag', () => {
    expect(isPhase3PublicationEnabled(env())).toBe(false);
    expect(isPhase3PublicationEnabled(env({ CUBELIC_PHASE3_ENABLED: 'false' }))).toBe(false);
    expect(isPhase3PublicationEnabled(env({ CUBELIC_PHASE3_ENABLED: 'TRUE' }))).toBe(false);
    expect(isPhase3PublicationEnabled(env({ CUBELIC_PHASE3_ENABLED: 'true' }))).toBe(false);
    expect(isPhase3PublicationEnabled(env({
      CUBELIC_PHASE3_ENABLED: 'true',
      PHASE3_RELEASE_APPROVED: 'true',
      STAGING_PHASE3_SMOKE_VERIFIED: 'true',
    }))).toBe(false);
    expect(isPhase3PublicationEnabled(env({
      WORKER_URL: 'https://x-harness-worker-production.example.workers.dev',
      CUBELIC_PHASE3_ENABLED: 'true',
      CUBELIC_PHASE3_DELIVERY_MODE: 'staging_fake',
      PHASE3_RELEASE_APPROVED: 'true',
      STAGING_PHASE3_SMOKE_VERIFIED: 'true',
    }))).toBe(false);
    expect(isPhase3PublicationEnabled(env({
      WORKER_URL: 'https://x-harness-worker-staging.yoshihiro-fukiya.workers.dev',
      CUBELIC_PHASE3_ENABLED: 'true',
      CUBELIC_PHASE3_DELIVERY_MODE: 'staging_fake',
      PHASE3_RELEASE_APPROVED: 'true',
      STAGING_PHASE3_SMOKE_VERIFIED: 'true',
    }))).toBe(true);
    expect(isPhase3PublicationEnabled(env({
      WORKER_URL: 'https://x-harness-worker-staging.evil.example',
      CUBELIC_PHASE3_ENABLED: 'true',
      CUBELIC_PHASE3_DELIVERY_MODE: 'staging_fake',
      PHASE3_RELEASE_APPROVED: 'true',
      STAGING_PHASE3_SMOKE_VERIFIED: 'true',
    }))).toBe(false);
    expect(isPhase3PublicationEnabled(env({
      WORKER_URL: 'https://x-harness-worker-production.example.workers.dev',
      CUBELIC_PHASE3_ENABLED: 'true',
      CUBELIC_PHASE3_DELIVERY_MODE: 'x',
      PHASE3_RELEASE_APPROVED: 'true',
      STAGING_PHASE3_SMOKE_VERIFIED: 'true',
    }))).toBe(true);
    expect(isPhase1RouteBlocked(
      'POST',
      '/api/posts',
      env({ CUBELIC_PHASE3_ENABLED: 'true' }),
    )).toBe(true);
  });

  it('allows interaction smoke only on the dedicated staging fake runtime', () => {
    const staging = {
      ENVIRONMENT: 'staging',
      WORKER_URL: 'https://x-harness-worker-staging.yoshihiro-fukiya.workers.dev',
      CUBELIC_PHASE3_DELIVERY_MODE: 'staging_fake',
      CUBELIC_HUMAN_INTERACTIONS_ENABLED: 'true',
      CUBELIC_HUMAN_INTERACTIONS_SMOKE_MODE: 'true',
    } as const;
    expect(isNamedHumanInteractionEnabled(env(staging))).toBe(true);
    expect(isNamedHumanInteractionEnabled(env({
      ...staging,
      ENVIRONMENT: 'production',
    }))).toBe(false);
    expect(isNamedHumanInteractionEnabled(env({
      ...staging,
      CUBELIC_HUMAN_INTERACTIONS_SMOKE_MODE: 'false',
      HUMAN_INTERACTIONS_RELEASE_APPROVED: 'true',
      STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED: 'true',
    }))).toBe(true);
  });

  it('keeps read-only watches behind dedicated staging or release gates', () => {
    const privacyReview = {
      X_INTERACTION_WATCH_PRIVACY_REVIEW_APPROVED: 'true',
      X_INTERACTION_WATCH_PRIVACY_REVIEW_ID: 'privacy_review_test_v1',
      X_INTERACTION_WATCH_REVIEWED_TARGET_USER_ID: '1900000000000000100',
    } as const;
    expect(isInteractionWatchEnabled(env({
      X_INTERACTION_WATCH_ENABLED: 'true',
      ...privacyReview,
    }))).toBe(false);
    expect(isInteractionWatchEnabled(env({
      ENVIRONMENT: 'staging',
      X_INTERACTION_WATCH_ENABLED: 'true',
      X_INTERACTION_WATCH_SMOKE_MODE: 'true',
      ...privacyReview,
    }))).toBe(true);
    expect(isInteractionWatchEnabled(env({
      ENVIRONMENT: 'production',
      X_INTERACTION_WATCH_ENABLED: 'true',
      X_INTERACTION_WATCH_SMOKE_MODE: 'true',
      ...privacyReview,
    }))).toBe(false);
    expect(isInteractionWatchEnabled(env({
      X_INTERACTION_WATCH_ENABLED: 'true',
      X_INTERACTION_WATCH_RELEASE_APPROVED: 'true',
      X_INTERACTION_WATCH_STAGING_SMOKE_VERIFIED: 'true',
      X_INTERACTION_WATCH_BEARER_TOKEN: 'read-only-bearer-token-with-at-least-32-bytes',
      ...privacyReview,
    }))).toBe(true);
    expect(isInteractionWatchEnabled(env({
      CUBELIC_PHASE3_ENABLED: 'true',
      X_INTERACTION_WATCH_ENABLED: 'true',
      X_INTERACTION_WATCH_RELEASE_APPROVED: 'true',
      X_INTERACTION_WATCH_STAGING_SMOKE_VERIFIED: 'true',
      X_INTERACTION_WATCH_BEARER_TOKEN: 'read-only-bearer-token-with-at-least-32-bytes',
      ...privacyReview,
    }))).toBe(false);
  });
});
