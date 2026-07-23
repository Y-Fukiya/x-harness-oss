import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  getStaffMemberByApiKey,
  getStaffMemberById,
  updateStaffLastLogin,
  verifyOrInitializeCredentialKeyState,
} from '@x-harness/db';
import type { Env } from '../index.js';
import {
  DASHBOARD_SESSION_COOKIE,
  isAllowedDashboardOrigin,
  isStrongRuntimeSecret,
  secretsEqual,
  verifyDashboardSession,
} from '../security/session.js';

export async function authMiddleware(c: Context<Env>, next: Next): Promise<Response | void> {
  const path = new URL(c.req.url).pathname;
  if (path !== '/api/health') {
    try {
      await verifyOrInitializeCredentialKeyState(
        c.env.DB,
        c.env.CREDENTIAL_ENCRYPTION_KEY,
        c.env.CREDENTIAL_ENCRYPTION_KEY_VERSION,
      );
    } catch {
      return c.json({ success: false, error: 'Credential protection is not configured' }, 503);
    }
  }
  if (path === '/api/health') return next();
  if (path === '/webhook/xaa' || path === '/setup' || path.startsWith('/api/tokens/') || path.startsWith('/api/growth/img/') || path.match(/^\/api\/engagement-gates\/[^/]+\/verify$/)) {
    return next();
  }
  if (!isStrongRuntimeSecret(c.env.API_KEY)) {
    return c.json({ success: false, error: 'Dashboard authentication is not configured' }, 503);
  }

  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : null;

  if (!token) {
    const sessionToken = getCookie(c, DASHBOARD_SESSION_COOKIE);
    if (!sessionToken || !isStrongRuntimeSecret(c.env.SESSION_SIGNING_KEY)) {
      return c.json({ success: false, error: 'Unauthorized' }, 401);
    }
    const session = await verifyDashboardSession(sessionToken, c.env.SESSION_SIGNING_KEY);
    if (!session) return c.json({ success: false, error: 'Unauthorized' }, 401);
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)
      && !isAllowedDashboardOrigin(c.req.header('Origin'), c.env.CORS_ALLOWED_ORIGINS)
    ) {
      return c.json({ success: false, error: 'Forbidden: invalid request origin' }, 403);
    }
    if (session.staffId) {
      const currentStaff = await getStaffMemberById(c.env.DB, session.staffId);
      if (!currentStaff || currentStaff.is_active !== 1) {
        return c.json({ success: false, error: 'Unauthorized' }, 401);
      }
      c.set('staffRole', currentStaff.role);
      c.set('staffId', currentStaff.id);
      c.set('staffName', currentStaff.name);
    } else {
      c.set('staffRole', session.role);
    }
    c.set('requestActor', 'human');
    if (
      c.get('staffRole') === 'viewer'
      && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(c.req.method)
      && !path.startsWith('/api/staff')
    ) {
      return c.json({ success: false, error: 'Forbidden: viewer role cannot perform mutating operations' }, 403);
    }
    return next();
  }

  if (path.startsWith('/api/cubelic/') && c.env.HERMES_ACCESS_TOKEN) {
    if (!isStrongRuntimeSecret(c.env.HERMES_ACCESS_TOKEN)) {
      return c.json({ success: false, error: 'Hermes authentication is not configured' }, 503);
    }
    const hermesCredential = await secretsEqual(c.env.HERMES_ACCESS_TOKEN, token);
    const hermesAllowed = hermesCredential && (c.req.method === 'GET'
      || (c.req.method === 'POST' && [
        '/api/cubelic/events',
        '/api/cubelic/content',
        '/api/cubelic/media/validate',
        '/api/cubelic/rights/validate',
        '/api/cubelic/setlists/ingest',
        '/api/cubelic/drafts/generate',
        '/api/cubelic/metrics/collect',
      ].includes(path))
      || (
        c.env.CUBELIC_PHASE3_ENABLED === 'true'
        && c.env.PHASE3_RELEASE_APPROVED === 'true'
        && c.env.STAGING_PHASE3_SMOKE_VERIFIED === 'true'
        && c.req.method === 'POST'
        && /^\/api\/cubelic\/drafts\/[^/]+\/schedule$/.test(path)
      ));
    if (hermesCredential) {
      if (!hermesAllowed) return c.json({ success: false, error: 'Forbidden for Hermes credential' }, 403);
      c.set('requestActor', 'hermes');
      return next();
    }
  }

  // Check env API_KEY first — always grants admin role
  if (await secretsEqual(c.env.API_KEY, token)) {
    c.set('staffRole', 'admin');
    c.set('requestActor', 'human');
    return next();
  }

  // Fall back to per-staff API key lookup
  if (!isStrongRuntimeSecret(c.env.STAFF_KEY_PEPPER)) {
    return c.json({ success: false, error: 'Staff authentication is not configured' }, 503);
  }
  const staff = await getStaffMemberByApiKey(c.env.DB, token, c.env.STAFF_KEY_PEPPER);
  if (!staff) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  c.set('staffRole', staff.role);
  c.set('staffId', staff.id);
  c.set('staffName', staff.name);
  c.set('requestActor', 'human');

  // Block viewer role from mutating routes outside /api/staff
  if (staff.role === 'viewer') {
    const method = c.req.method;
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) && !path.startsWith('/api/staff')) {
      return c.json({ success: false, error: 'Forbidden: viewer role cannot perform mutating operations' }, 403);
    }
  }

  // Fire-and-forget: update last_login_at without blocking the response
  c.executionCtx.waitUntil(updateStaffLastLogin(c.env.DB, staff.id));

  return next();
}

/**
 * Check if the current request's staff role satisfies one of the allowed roles.
 * Returns a 403 Response if not authorized, or null if allowed.
 */
export function requireRole(
  c: Context<Env>,
  ...roles: Array<'admin' | 'editor' | 'viewer'>
): Response | null {
  const staffRole = c.get('staffRole');
  if (!staffRole || !roles.includes(staffRole)) {
    return c.json({ success: false, error: 'Forbidden' }, 403) as Response;
  }
  return null;
}
