import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { authMiddleware } from './auth.js';
import type { Env } from '../index.js';

const db = {
  prepare: () => ({
    bind: () => ({ first: async () => null }),
    first: async () => null,
  }),
  batch: async () => [],
} as unknown as D1Database;

const secureBindings = {
  DB: db,
  API_KEY: 'dashboard-api-key-with-at-least-32-bytes',
  CREDENTIAL_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
  CREDENTIAL_ENCRYPTION_KEY_VERSION: 'test-v1',
} as Env['Bindings'];

function app() {
  const value = new Hono<Env>();
  value.use('*', authMiddleware);
  value.post('/api/cubelic/drafts/:id/schedule', (c) => c.json({
    actor: c.get('requestActor'),
  }));
  value.put('/api/cubelic/media/:id/body', (c) => c.json({
    actor: c.get('requestActor'),
  }));
  value.post('/api/cubelic/interactions/reply', (c) => c.json({
    actor: c.get('requestActor'),
  }));
  return value;
}

describe('Phase 3 Hermes authentication boundary', () => {
  it('allows only the exact schedule route after every runtime release gate is active', async () => {
    const response = await app().request(
      'https://worker.test/api/cubelic/drafts/drf_1/schedule',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer hermes-secret-with-at-least-32-bytes' },
      },
      {
        ...secureBindings,
        HERMES_ACCESS_TOKEN: 'hermes-secret-with-at-least-32-bytes',
        CUBELIC_PHASE3_ENABLED: 'true',
        PHASE3_RELEASE_APPROVED: 'true',
        STAGING_PHASE3_SMOKE_VERIFIED: 'true',
      } as Env['Bindings'],
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ actor: 'hermes' });
  });

  it('rejects Hermes scheduling when a runtime release gate is absent', async () => {
    const response = await app().request(
      'https://worker.test/api/cubelic/drafts/drf_1/schedule',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer hermes-secret-with-at-least-32-bytes' },
      },
      {
        ...secureBindings,
        HERMES_ACCESS_TOKEN: 'hermes-secret-with-at-least-32-bytes',
        CUBELIC_PHASE3_ENABLED: 'true',
        PHASE3_RELEASE_APPROVED: 'true',
      } as Env['Bindings'],
    );
    expect(response.status).toBe(403);
  });

  it('fails closed when the Hermes bearer secret is too short', async () => {
    const response = await app().request(
      'https://worker.test/api/cubelic/drafts/drf_1/schedule',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer short-hermes' },
      },
      {
        ...secureBindings,
        HERMES_ACCESS_TOKEN: 'short-hermes',
        CUBELIC_PHASE3_ENABLED: 'true',
        PHASE3_RELEASE_APPROVED: 'true',
        STAGING_PHASE3_SMOKE_VERIFIED: 'true',
      } as Env['Bindings'],
    );
    expect(response.status).toBe(503);
  });

  it('never allows Hermes to stage raw media bytes', async () => {
    const request = (mediaEnabled: string) => app().request(
      'https://worker.test/api/cubelic/media/ast_1/body',
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer hermes-secret-with-at-least-32-bytes' },
      },
      {
        ...secureBindings,
        HERMES_ACCESS_TOKEN: 'hermes-secret-with-at-least-32-bytes',
        CUBELIC_PHASE3_ENABLED: 'true',
        CUBELIC_PHASE3_MEDIA_ENABLED: mediaEnabled,
        PHASE3_RELEASE_APPROVED: 'true',
        STAGING_PHASE3_SMOKE_VERIFIED: 'true',
      } as Env['Bindings'],
    );

    expect((await request('false')).status).toBe(403);
    expect((await request('true')).status).toBe(403);
  });

  it('never allows Hermes to execute named-human interaction routes', async () => {
    const response = await app().request(
      'https://worker.test/api/cubelic/interactions/reply',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer hermes-secret-with-at-least-32-bytes' },
      },
      {
        ...secureBindings,
        HERMES_ACCESS_TOKEN: 'hermes-secret-with-at-least-32-bytes',
        CUBELIC_HUMAN_INTERACTIONS_ENABLED: 'true',
        HUMAN_INTERACTIONS_RELEASE_APPROVED: 'true',
        STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED: 'true',
      } as Env['Bindings'],
    );
    expect(response.status).toBe(403);
  });
});
