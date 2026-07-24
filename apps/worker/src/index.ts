import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authMiddleware } from './middleware/auth.js';
import { authRateLimitMiddleware } from './middleware/auth-rate-limit.js';
import { health } from './routes/health.js';
import { session } from './routes/session.js';
import { engagementGates } from './routes/engagement-gates.js';
import { followers } from './routes/followers.js';
import { tags } from './routes/tags.js';
import { posts } from './routes/posts.js';
import { users } from './routes/users.js';
import { xAccounts } from './routes/x-accounts.js';
import { stepSequences } from './routes/step-sequences.js';
import { verify } from './routes/verify.js';
import { staff } from './routes/staff.js';
import { dm } from './routes/dm.js';
import { usage } from './routes/usage.js';
import { xaa } from './routes/xaa.js';
import { campaigns } from './routes/campaigns.js';
import { setup } from './routes/setup.js';
import { capabilities } from './routes/capabilities.js';
import { articles } from './routes/articles.js';
import { growth } from './routes/growth.js';
import { growthSources } from './routes/growth-sources.js';
import { growthArticles } from './routes/growth-articles.js';
import { cubelic } from './routes/cubelic.js';
import { cubelicPhase1RouteGuard } from './cubelic/safety.js';
import { resolveCorsOrigin } from './cubelic/cors.js';
import type {
  CubelicHumanInteractionAdapterFactory,
  CubelicPhase3AdapterFactory,
  CubelicXAdapterFactory,
} from './cubelic/adapter.js';
import type { XInteractionWatchReadAdapter } from '@x-harness/content-os';
import type { MediaBodyWriter } from './cubelic/media-delivery.js';
import { processDueCubelicPublications } from './cubelic/adapter.js';
import { processInteractionWatches } from './cubelic/interaction-watch.js';
import { lineConnections } from './routes/line-connections.js';
import { verifyOrInitializeCredentialKeyState } from '@x-harness/db';

export type Env = {
  Bindings: {
    DB: D1Database;
    API_KEY: string;
    SESSION_SIGNING_KEY?: string;
    CREDENTIAL_ENCRYPTION_KEY: string;
    CREDENTIAL_ENCRYPTION_KEY_VERSION: string;
    INTERACTION_FINGERPRINT_KEY?: string;
    INTERACTION_FINGERPRINT_KEY_VERSION?: string;
    STAFF_KEY_PEPPER?: string;
    AUTH_RATE_LIMITER?: RateLimit;
    PUBLIC_ACTION_RATE_LIMITER?: RateLimit;
    ENVIRONMENT?: string;
    X_ACCESS_TOKEN: string;
    X_REFRESH_TOKEN: string;
    WORKER_URL: string;
    LINE_HARNESS_URL?: string;
    LINE_HARNESS_API_KEY?: string;
    LINE_CONNECTION_ALLOWED_HOSTS?: string;
    USER_SEARCH_DAILY_LIMIT?: string;
    VERIFY_LOOKUP_DAILY_LIMIT?: string;
    GROWTH_IMAGES?: R2Bucket;
    CUBELIC_MEDIA?: R2Bucket;
    CUBELIC_SAFE_MODE?: string;
    CUBELIC_PHASE3_ENABLED?: string;
    CUBELIC_PHASE3_DELIVERY_MODE?: string;
    CUBELIC_PHASE3_MEDIA_ENABLED?: string;
    CUBELIC_PHASE3_MEDIA_SMOKE_MODE?: string;
    CUBELIC_PHASE3_SCHEDULE_POLICIES?: string;
    CUBELIC_HUMAN_INTERACTIONS_ENABLED?: string;
    CUBELIC_HUMAN_INTERACTIONS_SMOKE_MODE?: string;
    PHASE3_RELEASE_APPROVED?: string;
    STAGING_PHASE3_SMOKE_VERIFIED?: string;
    STAGING_PHASE3_MEDIA_SMOKE_VERIFIED?: string;
    MEDIA_RETENTION_POLICY_VERIFIED?: string;
    HUMAN_INTERACTIONS_RELEASE_APPROVED?: string;
    STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED?: string;
    X_INTERACTION_WATCH_ENABLED?: string;
    X_INTERACTION_WATCH_SMOKE_MODE?: string;
    X_INTERACTION_WATCH_RELEASE_APPROVED?: string;
    X_INTERACTION_WATCH_STAGING_SMOKE_VERIFIED?: string;
    X_INTERACTION_WATCH_PRIVACY_REVIEW_APPROVED?: string;
    X_INTERACTION_WATCH_PRIVACY_REVIEW_ID?: string;
    X_INTERACTION_WATCH_BEARER_TOKEN?: string;
    GLOBAL_PUBLISHING_DISABLED?: string;
    HUMAN_APPROVAL_KEY?: string;
    HERMES_ACCESS_TOKEN?: string;
    X_HARNESS_ACCOUNT_ID?: string;
    CORS_ALLOWED_ORIGINS?: string;
  };
  Variables: {
    staffRole?: 'admin' | 'editor' | 'viewer';
    staffId?: string;
    staffName?: string;
    requestActor?: 'human' | 'hermes';
    cubelicAdapterFactory?: CubelicXAdapterFactory;
    cubelicPhase3AdapterFactory?: CubelicPhase3AdapterFactory;
    cubelicHumanInteractionAdapterFactory?: CubelicHumanInteractionAdapterFactory;
    cubelicMediaBodyWriter?: MediaBodyWriter;
    interactionWatchReadAdapter?: XInteractionWatchReadAdapter;
    correlationId?: string;
  };
};

const app = new Hono<Env>();

app.use('*', cors({
  origin: (origin, c) => resolveCorsOrigin(origin, (c.env as Env['Bindings']).CORS_ALLOWED_ORIGINS),
  allowHeaders: [
    'Authorization',
    'Content-Type',
    'X-Correlation-Id',
    'X-Human-Approval-Key',
    'X-Interaction-Approval-Proof',
  ],
  allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
  maxAge: 600,
}));
app.use('*', cubelicPhase1RouteGuard);
app.use('*', authRateLimitMiddleware);
app.use('*', authMiddleware);

app.route('/', health);
app.route('/', session);
app.route('/', verify);
app.route('/', engagementGates);
app.route('/', followers);
app.route('/', tags);
app.route('/', posts);
app.route('/', users);
app.route('/', xAccounts);
app.route('/', stepSequences);
app.route('/', staff);
app.route('/', dm);
app.route('/', usage);
app.route('/', xaa);
app.route('/', campaigns);
app.route('/', setup);
app.route('/', capabilities);
app.route('/', articles);
app.route('/', growth);
app.route('/', growthSources);
app.route('/', growthArticles);
app.route('/', cubelic);
app.route('/', lineConnections);

// Settings API (key-value store)
app.get('/api/settings', async (c) => {
  const rows = await c.env.DB.prepare('SELECT key, value, updated_at FROM settings').all<{ key: string; value: string; updated_at: string }>();
  const settings: Record<string, string> = {};
  for (const r of rows.results) settings[r.key] = r.value;
  return c.json({ success: true, data: settings });
});

app.put('/api/settings', async (c) => {
  const body = await c.req.json<Record<string, string>>();
  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(body)) {
    await c.env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?')
      .bind(key, value, now, value, now).run();
  }
  return c.json({ success: true });
});

app.notFound((c) => c.json({ success: false, error: 'Not found' }, 404));

async function scheduled(
  _event: ScheduledEvent,
  env: Env['Bindings'],
  _ctx: ExecutionContext,
): Promise<void> {
  await verifyOrInitializeCredentialKeyState(
    env.DB,
    env.CREDENTIAL_ENCRYPTION_KEY,
    env.CREDENTIAL_ENCRYPTION_KEY_VERSION,
  );
  await processDueCubelicPublications(env);
  await processInteractionWatches(env);
}

export default {
  fetch: app.fetch,
  scheduled,
};
