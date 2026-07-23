import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  authorizeExternalMutationRetry,
  completeExternalMutationOperation,
  createLineConnection,
  deleteLineConnection,
  getLineConnectionById,
  getExternalMutationOperation,
  listLineConnections,
  markExternalMutationOutcomeUnknown,
  replayExternalMutationResponse,
  reserveExternalMutationOperation,
} from '@x-harness/db';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/auth.js';

const lineConnections = new Hono<Env>();
const MAX_PROXY_BODY_BYTES = 100_000;
const MAX_PROXY_RESPONSE_BYTES = 1_000_000;
const ALLOWED_PROXY_OPERATIONS = new Set([
  'GET /api/forms',
  'GET /api/message-templates',
  'GET /api/traffic-pools',
  'POST /api/forms',
  'POST /api/tags',
  'POST /api/tracked-links',
]);

function auditActor(_c: Context<Env>): 'human' {
  return 'human';
}

function auditCorrelationId(c: Context<Env>): string {
  return c.req.header('X-Correlation-Id') ?? crypto.randomUUID();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

async function requestHash(method: string, path: string, body: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(`${method}\n${path}\n${canonicalJson(body)}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizeSafeExternalOrigin(
  rawUrl: string,
  configuredAllowedHosts: string | undefined,
): string | null {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    const allowedHosts = new Set(
      (configuredAllowedHosts ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
    );
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || (url.pathname !== '/' && url.pathname !== '')
      || url.search
      || url.hash
      || hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || hostname.startsWith('127.')
      || hostname.startsWith('10.')
      || hostname.startsWith('192.168.')
      || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(hostname)
      || hostname === '0.0.0.0'
      || hostname.includes(':')
      || !hostname.includes('.')
      || !allowedHosts.has(hostname)
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function limitedResponse(response: Response): Promise<Response> {
  if (response.status >= 300 && response.status < 400) {
    return Response.json({ success: false, error: 'External redirect rejected' }, { status: 502 });
  }
  const declaredLength = Number(response.headers.get('Content-Length') ?? '0');
  if (declaredLength > MAX_PROXY_RESPONSE_BYTES) {
    return Response.json({ success: false, error: 'External response too large' }, { status: 502 });
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_PROXY_RESPONSE_BYTES) {
    return Response.json({ success: false, error: 'External response too large' }, { status: 502 });
  }
  return new Response([204, 205].includes(response.status) ? null : bytes, {
    status: response.status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
    },
  });
}

lineConnections.get('/api/line-connections', async (c) => {
  return c.json({ success: true, data: await listLineConnections(c.env.DB) });
});

lineConnections.get('/api/line-connections/:id', async (c) => {
  const connection = (await listLineConnections(c.env.DB))
    .find((item) => item.id === c.req.param('id'));
  if (!connection) return c.json({ success: false, error: 'Not found' }, 404);
  return c.json({ success: true, data: connection });
});

lineConnections.post('/api/line-connections', async (c) => {
  const denied = requireRole(c, 'admin');
  if (denied) return denied;
  const body = await c.req.json<{ name?: string; workerUrl?: string; apiKey?: string }>();
  const workerUrl = normalizeSafeExternalOrigin(
    body.workerUrl ?? '',
    c.env.LINE_CONNECTION_ALLOWED_HOSTS,
  );
  if (!body.name?.trim() || !workerUrl || !body.apiKey) {
    return c.json({ success: false, error: 'A name, safe HTTPS origin, and API key are required' }, 400);
  }
  const created = await createLineConnection(c.env.DB, {
    name: body.name.trim(),
    workerUrl,
    apiKey: body.apiKey,
  }, c.env.CREDENTIAL_ENCRYPTION_KEY, {
    actor: auditActor(c),
    action: 'external_connection.created',
    entityType: 'external_connection',
    entityId: '',
    before: {},
    after: { name: body.name.trim(), workerUrl },
    correlationId: auditCorrelationId(c),
  });
  return c.json({ success: true, data: created }, 201);
});

lineConnections.delete('/api/line-connections/:id', async (c) => {
  const denied = requireRole(c, 'admin');
  if (denied) return denied;
  const existing = (await listLineConnections(c.env.DB))
    .find((item) => item.id === c.req.param('id'));
  if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
  await deleteLineConnection(c.env.DB, existing.id, {
    actor: auditActor(c),
    action: 'external_connection.deleted',
    entityType: 'external_connection',
    entityId: existing.id,
    before: { name: existing.name, workerUrl: existing.worker_url },
    after: {},
    correlationId: auditCorrelationId(c),
  });
  return c.json({ success: true });
});

lineConnections.post('/api/line-connections/:id/test', async (c) => {
  const denied = requireRole(c, 'admin');
  if (denied) return denied;
  const connection = await getLineConnectionById(
    c.env.DB,
    c.req.param('id'),
    c.env.CREDENTIAL_ENCRYPTION_KEY,
  );
  if (!connection) return c.json({ success: false, error: 'Not found' }, 404);
  if (!normalizeSafeExternalOrigin(connection.worker_url, c.env.LINE_CONNECTION_ALLOWED_HOSTS)) {
    return c.json({ success: false, error: 'External origin is no longer allowed' }, 403);
  }
  const response = await fetch(`${connection.worker_url}/api/friends?limit=1`, {
    headers: { Authorization: `Bearer ${connection.api_key}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  return c.json({
    success: response.ok,
    data: { status: response.status },
    ...(!response.ok ? { error: 'Connection test failed' } : {}),
  }, response.ok ? 200 : 502);
});

lineConnections.post('/api/line-connections/:id/proxy', async (c) => {
  const denied = requireRole(c, 'admin', 'editor');
  if (denied) return denied;
  const bodyText = await c.req.text();
  if (new TextEncoder().encode(bodyText).byteLength > MAX_PROXY_BODY_BYTES) {
    return c.json({ success: false, error: 'Request body too large' }, 413);
  }
  let input: { method?: string; path?: string; body?: unknown };
  try {
    input = JSON.parse(bodyText) as typeof input;
  } catch {
    return c.json({ success: false, error: 'Invalid JSON' }, 400);
  }
  const method = input.method?.toUpperCase() ?? 'GET';
  const path = input.path ?? '';
  if (!ALLOWED_PROXY_OPERATIONS.has(`${method} ${path}`)) {
    return c.json({ success: false, error: 'External operation is not allowed' }, 403);
  }
  const connection = await getLineConnectionById(
    c.env.DB,
    c.req.param('id'),
    c.env.CREDENTIAL_ENCRYPTION_KEY,
  );
  if (!connection) return c.json({ success: false, error: 'Not found' }, 404);
  if (!normalizeSafeExternalOrigin(connection.worker_url, c.env.LINE_CONNECTION_ALLOWED_HOSTS)) {
    return c.json({ success: false, error: 'External origin is no longer allowed' }, 403);
  }

  const operationId = c.req.header('X-Correlation-Id');
  let mutationHash: string | null = null;
  if (method !== 'GET') {
    if (!operationId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u.test(operationId)) {
      return c.json({ success: false, error: 'A stable operation id is required' }, 400);
    }
    mutationHash = await requestHash(method, path, input.body ?? {});
    const reservation = await reserveExternalMutationOperation(c.env.DB, {
      connectionId: connection.id,
      operationId,
      requestHash: mutationHash,
      method,
      path,
    }, {
      actor: auditActor(c),
      action: 'external_connection.proxy_mutation_intent',
      entityType: 'external_connection',
      entityId: connection.id,
      before: {},
      after: { method, path, requestHash: mutationHash, outcome: 'pending' },
      correlationId: operationId,
    });
    if (!reservation.reserved) {
      const existing = reservation.operation;
      if (
        existing.request_hash !== mutationHash
        || existing.method !== method
        || existing.path !== path
      ) {
        return c.json({ success: false, error: 'Operation id was reused with different input' }, 409);
      }
      const replay = await replayExternalMutationResponse(
        existing,
        c.env.CREDENTIAL_ENCRYPTION_KEY,
      );
      if (replay) {
        return new Response([204, 205].includes(replay.status) ? null : replay.body, {
          status: replay.status,
          headers: {
            'Cache-Control': 'no-store',
            'Content-Type': replay.contentType,
            'X-Idempotent-Replay': 'true',
          },
        });
      }
      return c.json({
        success: false,
        error: existing.status === 'pending'
          ? 'Operation is still pending'
          : 'Operation outcome is unknown; reconcile before retrying',
        data: { operationId: existing.operation_id, status: existing.status },
      }, 409);
    }
  }
  try {
    const response = await fetch(`${connection.worker_url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${connection.api_key}`,
        ...(method === 'POST' ? {
          'Content-Type': 'application/json',
          'Idempotency-Key': operationId!,
        } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(input.body ?? {}) } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    const proxied = await limitedResponse(response);
    if (method !== 'GET' && operationId) {
      const responseBody = await proxied.text();
      const contentType = proxied.headers.get('Content-Type') ?? 'application/json';
      const completed = await completeExternalMutationOperation(c.env.DB, {
        connectionId: connection.id,
        operationId,
        responseStatus: proxied.status,
        responseContentType: contentType,
        responseBody,
        expectedStatus: 'pending',
      }, c.env.CREDENTIAL_ENCRYPTION_KEY, {
        actor: auditActor(c),
        action: 'external_connection.proxy_mutation_outcome',
        entityType: 'external_connection',
        entityId: connection.id,
        before: { outcome: 'pending' },
        after: { method, path, requestHash: mutationHash, outcome: 'completed', status: proxied.status },
        correlationId: operationId,
      });
      if (!completed) throw new Error('External mutation state changed before completion');
      return new Response([204, 205].includes(proxied.status) ? null : responseBody, {
        status: proxied.status,
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': contentType,
        },
      });
    }
    return proxied;
  } catch {
    if (method === 'GET') {
      return c.json({ success: false, error: 'External read failed; it is safe to retry' }, 502);
    }
    if (method !== 'GET' && operationId) {
      try {
        await markExternalMutationOutcomeUnknown(c.env.DB, {
          connectionId: connection.id,
          operationId,
        }, {
          actor: auditActor(c),
          action: 'external_connection.proxy_mutation_outcome',
          entityType: 'external_connection',
          entityId: connection.id,
          before: { outcome: 'pending' },
          after: { method, path, requestHash: mutationHash, outcome: 'unknown' },
          correlationId: operationId,
        });
      } catch {
        // The durable intent remains pending and must be reconciled; never retry externally here.
      }
    }
    return c.json({
      success: false,
      error: 'External operation outcome is unknown; reconcile before retrying',
      ...(operationId ? { data: { operationId } } : {}),
    }, 502);
  }
});

lineConnections.post('/api/line-connections/:id/operations/:operationId/reconcile', async (c) => {
  const denied = requireRole(c, 'admin');
  if (denied) return denied;
  const connectionId = c.req.param('id');
  const operationId = c.req.param('operationId');
  const operation = await getExternalMutationOperation(c.env.DB, connectionId, operationId);
  if (!operation) return c.json({ success: false, error: 'Operation not found' }, 404);
  if (operation.status !== 'pending' && operation.status !== 'outcome_unknown') {
    return c.json({ success: false, error: 'Operation is already resolved' }, 409);
  }
  if (operation.status === 'pending' && operation.lease_expires_at > new Date().toISOString()) {
    return c.json({ success: false, error: 'Operation is still within its in-flight lease' }, 409);
  }
  const body = await c.req.json<{
    confirmation?: string;
    outcome?: 'completed' | 'not_completed';
    response?: { status?: number; contentType?: string; body?: string };
  }>();
  if (body.confirmation !== 'verified_external_state') {
    return c.json({ success: false, error: 'Explicit external-state verification is required' }, 400);
  }
  if (body.outcome === 'not_completed') {
    const authorized = await authorizeExternalMutationRetry(
      c.env.DB,
      connectionId,
      operationId,
      {
        actor: auditActor(c),
        action: 'external_connection.proxy_mutation_reconciled_not_completed',
        entityType: 'external_connection',
        entityId: connectionId,
        before: { operationId, status: operation.status },
        after: { retryAuthorized: true },
        correlationId: auditCorrelationId(c),
      },
    );
    if (!authorized) return c.json({ success: false, error: 'Operation changed during reconciliation' }, 409);
    return c.json({ success: true, data: { retryAuthorized: true } });
  }
  const responseStatus = body.response?.status;
  const responseBody = body.response?.body;
  const responseContentType = body.response?.contentType;
  const noBodyStatus = responseStatus === 204 || responseStatus === 205;
  if (
    body.outcome !== 'completed'
    || !Number.isInteger(responseStatus)
    || responseStatus! < 200
    || responseStatus! > 599
    || typeof responseBody !== 'string'
    || new TextEncoder().encode(responseBody).byteLength > MAX_PROXY_RESPONSE_BYTES
    || typeof responseContentType !== 'string'
    || !responseContentType.toLowerCase().startsWith('application/json')
  ) {
    return c.json({ success: false, error: 'A bounded JSON response is required for completed reconciliation' }, 400);
  }
  if (noBodyStatus) {
    if (responseBody !== '') {
      return c.json({ success: false, error: 'HTTP 204/205 reconciliation must have an empty body' }, 400);
    }
  } else {
    try {
      JSON.parse(responseBody);
    } catch {
      return c.json({ success: false, error: 'The reconciled response body must be valid JSON' }, 400);
    }
  }
  const completed = await completeExternalMutationOperation(c.env.DB, {
    connectionId,
    operationId,
    responseStatus: responseStatus!,
    responseContentType,
    responseBody,
    expectedStatus: operation.status,
  }, c.env.CREDENTIAL_ENCRYPTION_KEY, {
    actor: auditActor(c),
    action: 'external_connection.proxy_mutation_reconciled_completed',
    entityType: 'external_connection',
    entityId: connectionId,
    before: { operationId, status: operation.status },
    after: { status: 'completed', responseStatus },
    correlationId: auditCorrelationId(c),
  });
  if (!completed) return c.json({ success: false, error: 'Operation changed during reconciliation' }, 409);
  return c.json({ success: true, data: { completed: true } });
});

export { lineConnections };
