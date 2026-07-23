import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import {
  migrateAllXAccountCredentials,
  migrateEngagementGateApiKeys,
  migrateLineConnectionApiKeys,
  migrateStaffApiKeys,
  verifyOrInitializeCredentialKeyState,
} from '@x-harness/db';
import type { Env } from '../index.js';
import {
  createDashboardSession,
  DASHBOARD_SESSION_COOKIE,
  DASHBOARD_SESSION_MAX_AGE_SECONDS,
  isStrongRuntimeSecret,
} from '../security/session.js';

const session = new Hono<Env>();

session.post('/api/session/login', async (c) => {
  if (!isStrongRuntimeSecret(c.env.SESSION_SIGNING_KEY)) {
    return c.json({ success: false, error: 'Dashboard sessions are not configured' }, 503);
  }
  const role = c.get('staffRole');
  if (!role || c.get('requestActor') !== 'human') {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  if (!isStrongRuntimeSecret(c.env.STAFF_KEY_PEPPER)) {
    return c.json({ success: false, error: 'Staff authentication is not configured' }, 503);
  }
  await verifyOrInitializeCredentialKeyState(
    c.env.DB,
    c.env.CREDENTIAL_ENCRYPTION_KEY,
    c.env.CREDENTIAL_ENCRYPTION_KEY_VERSION,
  );
  await Promise.all([
    migrateStaffApiKeys(c.env.DB, c.env.STAFF_KEY_PEPPER),
    migrateAllXAccountCredentials(c.env.DB, c.env.CREDENTIAL_ENCRYPTION_KEY),
    migrateLineConnectionApiKeys(c.env.DB, c.env.CREDENTIAL_ENCRYPTION_KEY),
    migrateEngagementGateApiKeys(c.env.DB, c.env.CREDENTIAL_ENCRYPTION_KEY),
  ]);
  const token = await createDashboardSession({
    role,
    staffId: c.get('staffId'),
    staffName: c.get('staffName'),
  }, c.env.SESSION_SIGNING_KEY);
  setCookie(c, DASHBOARD_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: DASHBOARD_SESSION_MAX_AGE_SECONDS,
  });
  return c.json({
    success: true,
    data: {
      authenticated: true,
      role,
      name: c.get('staffName') ?? null,
      expiresIn: DASHBOARD_SESSION_MAX_AGE_SECONDS,
    },
  });
});

session.get('/api/session', (c) => {
  return c.json({
    success: true,
    data: {
      authenticated: true,
      role: c.get('staffRole'),
      name: c.get('staffName') ?? null,
    },
  });
});

session.delete('/api/session', (c) => {
  deleteCookie(c, DASHBOARD_SESSION_COOKIE, {
    secure: true,
    path: '/',
  });
  return c.json({ success: true, data: { authenticated: false } });
});

export { session };
