import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { authMiddleware } from '../middleware/auth.js';
import { authRateLimitMiddleware } from '../middleware/auth-rate-limit.js';
import { cubelicPhase1RouteGuard } from '../cubelic/safety.js';
import type { Env } from '../index.js';
import { createDashboardSession } from '../security/session.js';
import { session } from './session.js';

const dbWithoutStaffKeys = {
  prepare: () => ({
    bind: () => ({
      first: async () => null,
      all: async () => ({ results: [] }),
    }),
    first: async () => null,
    all: async () => ({ results: [] }),
  }),
  batch: async () => [],
} as unknown as D1Database;

function createApp(): Hono<Env> {
  const app = new Hono<Env>();
  app.use('*', authRateLimitMiddleware);
  app.use('*', authMiddleware);
  app.route('/', session);
  app.post('/api/test-mutation', (c) => c.json({ success: true }));
  return app;
}

function createGuardedApp(): Hono<Env> {
  const app = new Hono<Env>();
  app.use('*', cubelicPhase1RouteGuard);
  app.use('*', authRateLimitMiddleware);
  app.use('*', authMiddleware);
  app.route('/', session);
  return app;
}

const bindings = {
  DB: dbWithoutStaffKeys,
  API_KEY: 'dashboard-admin-key-with-at-least-32-bytes',
  SESSION_SIGNING_KEY: 'test-session-signing-key-with-at-least-32-bytes',
  STAFF_KEY_PEPPER: 'test-staff-key-pepper-with-at-least-32-bytes',
  CREDENTIAL_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
  CREDENTIAL_ENCRYPTION_KEY_VERSION: 'test-v1',
  CORS_ALLOWED_ORIGINS: 'https://dashboard.example.test',
  X_ACCESS_TOKEN: '',
  X_REFRESH_TOKEN: '',
  WORKER_URL: 'https://worker.example.test',
} as Env['Bindings'];

describe('GET /api/session', () => {
  it('rejects a missing dashboard API key', async () => {
    const response = await createApp().request('/api/session', undefined, bindings);

    expect(response.status).toBe(401);
  });

  it('keeps follower and live-user search behind dashboard authentication', async () => {
    const app = createApp();
    app.get('/api/users/search', (c) => c.json({ success: true }));
    app.get('/api/followers/search', (c) => c.json({ success: true }));

    const [users, followers] = await Promise.all([
      app.request('/api/users/search?q=ab', undefined, bindings),
      app.request('/api/followers/search?q=ab', undefined, bindings),
    ]);

    expect(users.status).toBe(401);
    expect(followers.status).toBe(401);
  });

  it('rejects an invalid dashboard API key', async () => {
    const response = await createApp().request('/api/session', {
      headers: { Authorization: 'Bearer not-the-dashboard-key' },
    }, bindings);

    expect(response.status).toBe(401);
  });

  it('fails closed when the primary dashboard key is too short', async () => {
    const response = await createApp().request('/api/session', {
      headers: { Authorization: 'Bearer short-key' },
    }, { ...bindings, API_KEY: 'short-key' });

    expect(response.status).toBe(503);
  });

  it('returns the authenticated dashboard session for the configured key', async () => {
    const response = await createApp().request('/api/session', {
      headers: { Authorization: 'Bearer dashboard-admin-key-with-at-least-32-bytes' },
    }, bindings);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { authenticated: true, role: 'admin', name: null },
    });
  });
});

describe('dashboard cookie session', () => {
  it('allows login and logout through the production route guard', async () => {
    const login = await createGuardedApp().request('/api/session/login', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-admin-key-with-at-least-32-bytes',
        Origin: 'https://dashboard.example.test',
      },
    }, bindings);
    const cookie = login.headers.get('Set-Cookie')?.split(';', 1)[0];
    expect(login.status).toBe(200);
    expect(cookie).toBeTruthy();

    const logout = await createGuardedApp().request('/api/session', {
      method: 'DELETE',
      headers: {
        Cookie: cookie!,
        Origin: 'https://dashboard.example.test',
      },
    }, bindings);
    expect(logout.status).toBe(200);
  });

  it('exchanges the management key for a short-lived HttpOnly cookie without returning the key', async () => {
    const response = await createApp().request('/api/session/login', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-admin-key-with-at-least-32-bytes',
        Origin: 'https://dashboard.example.test',
      },
    }, bindings);

    expect(response.status).toBe(200);
    const cookie = response.headers.get('Set-Cookie');
    expect(cookie).toContain('__Host-xh_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Max-Age=900');
    expect(await response.text()).not.toContain('dashboard-admin-key-with-at-least-32-bytes');
  });

  it('authenticates a later request from the signed cookie without a bearer key', async () => {
    const login = await createApp().request('/api/session/login', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-admin-key-with-at-least-32-bytes',
        Origin: 'https://dashboard.example.test',
      },
    }, bindings);
    const cookie = login.headers.get('Set-Cookie')?.split(';', 1)[0];
    expect(cookie).toBeTruthy();

    const response = await createApp().request('/api/session', {
      headers: { Cookie: cookie! },
    }, bindings);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { authenticated: true, role: 'admin' },
    });
  });

  it('rejects cookie-authenticated mutations without an allowed Origin', async () => {
    const login = await createApp().request('/api/session/login', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-admin-key-with-at-least-32-bytes',
        Origin: 'https://dashboard.example.test',
      },
    }, bindings);
    const cookie = login.headers.get('Set-Cookie')?.split(';', 1)[0];

    const missingOrigin = await createApp().request('/api/test-mutation', {
      method: 'POST',
      headers: { Cookie: cookie! },
    }, bindings);
    const untrustedOrigin = await createApp().request('/api/test-mutation', {
      method: 'POST',
      headers: {
        Cookie: cookie!,
        Origin: 'https://untrusted.example.test',
      },
    }, bindings);

    expect(missingOrigin.status).toBe(403);
    expect(untrustedOrigin.status).toBe(403);
  });

  it('allows cookie-authenticated mutations from the configured dashboard Origin', async () => {
    const login = await createApp().request('/api/session/login', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-admin-key-with-at-least-32-bytes',
        Origin: 'https://dashboard.example.test',
      },
    }, bindings);
    const cookie = login.headers.get('Set-Cookie')?.split(';', 1)[0];

    const response = await createApp().request('/api/test-mutation', {
      method: 'POST',
      headers: {
        Cookie: cookie!,
        Origin: 'https://dashboard.example.test',
      },
    }, bindings);

    expect(response.status).toBe(200);
  });

  it('applies the current database role to an existing staff cookie', async () => {
    const token = await createDashboardSession({
      role: 'editor',
      staffId: 'staff-demoted',
      staffName: 'Old Name',
    }, bindings.SESSION_SIGNING_KEY!);
    const viewerDb = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => sql.includes('FROM staff_members')
            ? {
                id: 'staff-demoted',
                name: 'Current Name',
                role: 'viewer',
                is_active: 1,
              }
            : null,
        }),
        first: async () => null,
      }),
      batch: async () => [],
    } as unknown as D1Database;

    const response = await createApp().request('/api/test-mutation', {
      method: 'POST',
      headers: {
        Cookie: `__Host-xh_session=${token}`,
        Origin: 'https://dashboard.example.test',
      },
    }, { ...bindings, DB: viewerDb });

    expect(response.status).toBe(403);
  });

  it('clears the cookie on logout', async () => {
    const login = await createApp().request('/api/session/login', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-admin-key-with-at-least-32-bytes',
        Origin: 'https://dashboard.example.test',
      },
    }, bindings);
    const cookie = login.headers.get('Set-Cookie')?.split(';', 1)[0];

    const response = await createApp().request('/api/session', {
      method: 'DELETE',
      headers: {
        Cookie: cookie!,
        Origin: 'https://dashboard.example.test',
      },
    }, bindings);

    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('rejects authentication attempts when the platform rate limiter is exhausted', async () => {
    const response = await createApp().request('/api/session/login', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dashboard-admin-key-with-at-least-32-bytes',
        'CF-Connecting-IP': '192.0.2.1',
        Origin: 'https://dashboard.example.test',
      },
    }, {
      ...bindings,
      AUTH_RATE_LIMITER: {
        limit: async () => ({ success: false }),
      } as RateLimit,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
  });

  it('rate limits unauthenticated capability endpoints', async () => {
    const app = createApp();
    app.get('/api/tokens/:token/resolve', (c) => c.json({ success: true }));
    const response = await app.request('/api/tokens/capability/resolve', {
      headers: { 'CF-Connecting-IP': '192.0.2.2' },
    }, {
      ...bindings,
      PUBLIC_ACTION_RATE_LIMITER: {
        limit: async () => ({ success: false }),
      } as RateLimit,
    });

    expect(response.status).toBe(429);
  });

  it('fails closed when production rate-limit bindings are missing', async () => {
    const login = await createApp().request('/api/session/login', {
      method: 'POST',
      headers: { Authorization: 'Bearer dashboard-admin-key-with-at-least-32-bytes' },
    }, { ...bindings, ENVIRONMENT: 'production' });
    const capability = await createApp().request('/api/tokens/capability/resolve', {
      headers: { 'CF-Connecting-IP': '192.0.2.3' },
    }, { ...bindings, ENVIRONMENT: 'production' });

    expect(login.status).toBe(503);
    expect(capability.status).toBe(503);
  });
});
