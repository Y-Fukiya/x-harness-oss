import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index.js';

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  markUnknown: vi.fn(),
  reserve: vi.fn(),
}));

vi.mock('@x-harness/db', () => ({
  authorizeExternalMutationRetry: vi.fn(),
  completeExternalMutationOperation: mocks.complete,
  createLineConnection: vi.fn(),
  deleteLineConnection: vi.fn(),
  getExternalMutationOperation: vi.fn(),
  getLineConnectionById: vi.fn(async () => ({
    id: 'connection_1',
    name: 'External',
    worker_url: 'https://external.example.test',
    api_key: 'external-secret',
    created_at: '2026-07-23T00:00:00.000Z',
  })),
  listLineConnections: vi.fn(async () => []),
  markExternalMutationOutcomeUnknown: mocks.markUnknown,
  replayExternalMutationResponse: vi.fn(),
  reserveExternalMutationOperation: mocks.reserve,
}));

import { lineConnections } from './line-connections.js';

function app(role: 'admin' | 'editor' = 'admin'): Hono<Env> {
  const value = new Hono<Env>();
  value.use('*', async (c, next) => {
    c.set('staffRole', role);
    c.set('requestActor', 'human');
    return next();
  });
  value.route('/', lineConnections);
  return value;
}

const bindings = {
  DB: {} as D1Database,
  CREDENTIAL_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
  LINE_CONNECTION_ALLOWED_HOSTS: 'external.example.test',
} as Env['Bindings'];

async function mutate(): Promise<Response> {
  return app().request('/api/line-connections/connection_1/proxy', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-Id': 'operation-1234567890',
    },
    body: JSON.stringify({
      method: 'POST',
      path: '/api/tags',
      body: { name: 'tag' },
    }),
  }, bindings);
}

describe('external mutation uncertain outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mocks.reserve.mockResolvedValue({ reserved: true });
    mocks.complete.mockResolvedValue(true);
    mocks.markUnknown.mockResolvedValue(true);
  });

  it('marks the operation unknown when the external response body cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.error(new Error('response stream failed'));
      },
    }), { status: 201 })));

    const response = await mutate();

    expect(response.status).toBe(502);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.markUnknown).toHaveBeenCalledOnce();
  });

  it('marks the operation unknown when completion persistence fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { success: true, data: { id: 'tag_1' } },
      { status: 201 },
    )));
    mocks.complete.mockRejectedValueOnce(new Error('D1 completion failed'));

    const response = await mutate();

    expect(response.status).toBe(502);
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.markUnknown).toHaveBeenCalledOnce();
  });

  it('stores and returns a successful no-content mutation without a body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));

    const response = await mutate();

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ responseStatus: 204, responseBody: '' }),
      expect.anything(),
      expect.anything(),
    );
    expect(mocks.markUnknown).not.toHaveBeenCalled();
  });

  it('forbids an editor from reconciling an uncertain mutation', async () => {
    const response = await app('editor').request(
      '/api/line-connections/connection_1/operations/operation-1234567890/reconcile',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmation: 'verified_external_state',
          outcome: 'not_completed',
        }),
      },
      bindings,
    );

    expect(response.status).toBe(403);
  });
});
