import type { Context, Next } from 'hono';
import type { Env } from '../index.js';

export async function authRateLimitMiddleware(
  c: Context<Env>,
  next: Next,
): Promise<Response | void> {
  const path = new URL(c.req.url).pathname;
  const isPublicCapabilityRequest = path.startsWith('/api/tokens/')
    || /^\/api\/engagement-gates\/[^/]+\/verify$/u.test(path);
  if (
    isPublicCapabilityRequest
    && c.env.ENVIRONMENT === 'production'
    && !c.env.PUBLIC_ACTION_RATE_LIMITER
  ) {
    return c.json({ success: false, error: 'Request protection is not configured' }, 503);
  }
  if (isPublicCapabilityRequest && c.env.PUBLIC_ACTION_RATE_LIMITER) {
    const source = c.req.header('CF-Connecting-IP') ?? 'unknown-source';
    const { success } = await c.env.PUBLIC_ACTION_RATE_LIMITER.limit({
      key: `public-capability:${source}`,
    });
    if (!success) {
      c.header('Retry-After', '60');
      return c.json({ success: false, error: 'Too many requests' }, 429);
    }
  }
  const isCredentialAttempt = path === '/api/session/login'
    || Boolean(c.req.header('Authorization'));
  if (
    isCredentialAttempt
    && c.env.ENVIRONMENT === 'production'
    && !c.env.AUTH_RATE_LIMITER
  ) {
    return c.json({ success: false, error: 'Authentication protection is not configured' }, 503);
  }
  if (!isCredentialAttempt || !c.env.AUTH_RATE_LIMITER) return next();

  const source = c.req.header('CF-Connecting-IP') ?? 'unknown-source';
  const { success } = await c.env.AUTH_RATE_LIMITER.limit({
    key: `dashboard-auth:${source}`,
  });
  if (!success) {
    c.header('Retry-After', '60');
    return c.json({ success: false, error: 'Too many authentication attempts' }, 429);
  }
  return next();
}
