import { describe, expect, it, vi } from 'vitest';
import { runScheduledRuntime, type Env } from './index.js';

function dependencies() {
  return {
    processWatches: vi.fn(async () => ({ discovered: 0, watchesPolled: 0 })),
    processPublications: vi.fn(async () => ({ claimed: 0, processed: 0 })),
    verifyCredentialState: vi.fn(async () => undefined),
    appendAudit: vi.fn(async () => undefined),
  };
}

describe('scheduled runtime fail-closed mode selection', () => {
  it('runs neither watch nor X-write processing for a conflicting release', async () => {
    const deps = dependencies();
    const env = {
      DB: {} as D1Database,
      CREDENTIAL_ENCRYPTION_KEY: 'unused-in-conflict',
      CREDENTIAL_ENCRYPTION_KEY_VERSION: 'unused-in-conflict',
      CUBELIC_PHASE3_ENABLED: 'true',
      CUBELIC_PHASE3_DELIVERY_MODE: 'x',
      PHASE3_RELEASE_APPROVED: 'true',
      STAGING_PHASE3_SMOKE_VERIFIED: 'true',
      CUBELIC_HUMAN_INTERACTIONS_ENABLED: 'true',
      HUMAN_INTERACTIONS_RELEASE_APPROVED: 'true',
      STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED: 'true',
      X_INTERACTION_WATCH_ENABLED: 'true',
    } as Env['Bindings'];

    await runScheduledRuntime(env, deps);

    expect(deps.processWatches).not.toHaveBeenCalled();
    expect(deps.processPublications).not.toHaveBeenCalled();
    expect(deps.verifyCredentialState).not.toHaveBeenCalled();
    expect(deps.appendAudit).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({
        action: 'interaction_watch.configuration_rejected',
        after: { failClosed: true },
      }),
    );
  });
});
