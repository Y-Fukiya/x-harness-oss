import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { Miniflare } from 'miniflare';
import {
  NamedHumanXInteractionAdapter,
  Phase1XPublishingAdapter,
  Phase3XPublishingAdapter,
  PublicationPolicyError,
  canonicalHumanXInteractionApproval,
  type HumanXInteractionApprovalRequest,
  type HumanXInteractionInput,
  type ScheduleInput,
  type XInteractionWatchReadAdapter,
  type XDraftInput,
} from '@x-harness/content-os';
import {
  createCubelicInertDraft,
  createCubelicEvent,
  createCubelicMedia,
  createCubelicContent,
  createCubelicDrafts,
  createCubelicPublicationJob,
  getCubelicEmergencyStop,
  getCubelicPublicationJob,
  setCubelicEmergencyStop,
  setCubelicOperationWindow,
  reserveCubelicDraftApproval,
  stageCubelicMediaObject,
} from '@x-harness/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cubelic } from './cubelic.js';
import type { Env } from '../index.js';
import { compileMigrationForD1Exec } from '../../../../packages/db/src/d1-test-utils.js';
import {
  PublicationDeliveryNotAttemptedError,
  isCubelicPublicationStopped,
  processDueCubelicPublications,
} from '../cubelic/adapter.js';
import { processInteractionWatches } from '../cubelic/interaction-watch.js';

const migrationPaths = [
  fileURLToPath(new URL('../../../../packages/db/migrations/008-staff-members.sql', import.meta.url)),
  fileURLToPath(new URL('../../../../packages/db/migrations/023-staff-key-hashes.sql', import.meta.url)),
  fileURLToPath(new URL('../../../../packages/db/migrations/018-cubelic-content-os.sql', import.meta.url)),
  fileURLToPath(new URL('../../../../packages/db/migrations/019-cubelic-fail-closed-boundaries.sql', import.meta.url)),
  fileURLToPath(new URL('../../../../packages/db/migrations/020-cubelic-phase3-publication.sql', import.meta.url)),
  fileURLToPath(new URL('../../../../packages/db/migrations/021-cubelic-publication-reconciliation.sql', import.meta.url)),
  fileURLToPath(new URL('../../../../packages/db/migrations/022-cubelic-operation-window-publication-lock.sql', import.meta.url)),
  fileURLToPath(new URL('../../../../packages/db/migrations/027-cubelic-media-delivery.sql', import.meta.url)),
  fileURLToPath(new URL('../../../../packages/db/migrations/028-cubelic-human-x-interactions.sql', import.meta.url)),
  fileURLToPath(new URL('../../../../packages/db/migrations/029-x-interaction-watch-queue.sql', import.meta.url)),
];

describe('CUBΣLIC Worker API integration', () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let app: Hono<Env>;
  let bindings: Env['Bindings'];
  let createDraft: ReturnType<typeof vi.fn>;
  let publishPost: ReturnType<typeof vi.fn>;
  let schedulePost: ReturnType<typeof vi.fn>;
  let executeInteraction: ReturnType<typeof vi.fn>;
  let interactionWatchReader: XInteractionWatchReadAdapter;
  let discoverOriginalPosts: ReturnType<typeof vi.fn>;
  let mediaBucket: R2Bucket;

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2024-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: 'cubelic-api-integration-test' },
      r2Buckets: { MEDIA: 'cubelic-media-integration-test' },
    });
    db = await miniflare.getD1Database('DB') as unknown as D1Database;
    mediaBucket = await miniflare.getR2Bucket('MEDIA') as unknown as R2Bucket;
    for (const migrationPath of migrationPaths) {
      await db.exec(compileMigrationForD1Exec(await readFile(migrationPath, 'utf8')));
    }
    await setCubelicEmergencyStop(db, false, 'integration-operator', {
      actor: 'human',
      action: 'system.emergency_resume',
      entityType: 'system',
      entityId: 'publishing',
      before: { stopped: true },
      after: { stopped: false },
      correlationId: 'corr_integration_resume',
    });
    bindings = {
      DB: db,
      API_KEY: 'integration-api-key-with-at-least-32-bytes',
      STAFF_KEY_PEPPER: 'integration-staff-key-pepper-with-at-least-32-bytes',
      CREDENTIAL_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
      CREDENTIAL_ENCRYPTION_KEY_VERSION: 'integration-v1',
      INTERACTION_FINGERPRINT_KEY: 'integration-fingerprint-key-with-at-least-32-bytes',
      INTERACTION_FINGERPRINT_KEY_VERSION: 'integration-v1',
      X_INTERACTION_WATCH_PRIVACY_REVIEW_APPROVED: 'true',
      X_INTERACTION_WATCH_PRIVACY_REVIEW_ID: 'privacy_review_integration_v1',
      X_INTERACTION_WATCH_REVIEWED_TARGET_USER_ID: '1900000000000000100',
      X_INTERACTION_WATCH_BEARER_TOKEN: 'integration-read-only-bearer-token-with-at-least-32-bytes',
      X_ACCESS_TOKEN: '',
      X_REFRESH_TOKEN: '',
      WORKER_URL: 'https://worker.example.test',
      CUBELIC_SAFE_MODE: 'true',
      GLOBAL_PUBLISHING_DISABLED: 'false',
      HUMAN_APPROVAL_KEY: 'integration-human-key-with-at-least-32-bytes',
      HERMES_ACCESS_TOKEN: 'integration-hermes-key',
      X_HARNESS_ACCOUNT_ID: 'x_account_row_integration',
      CUBELIC_MEDIA: mediaBucket,
    };
    app = new Hono<Env>();
    createDraft = vi.fn(async (input: XDraftInput) => createCubelicInertDraft(db, bindings.X_HARNESS_ACCOUNT_ID!, input));
    publishPost = vi.fn(async () => ({
      postId: '1999999999999999999',
      status: 'published' as const,
      publishedAt: '2026-07-23T01:05:00.000Z',
    }));
    schedulePost = vi.fn(async (input: ScheduleInput) => ({
      jobId: 'pub_scheduled',
      status: 'scheduled' as const,
      scheduledAt: input.scheduledAt,
    }));
    executeInteraction = vi.fn(async (input: HumanXInteractionInput) => ({
      status: 'completed' as const,
      ...(['reply', 'dm_reply'].includes(input.kind) ? { externalId: `external_${input.operationId}` } : {}),
    }));
    discoverOriginalPosts = vi.fn(async () => []);
    interactionWatchReader = {
      verifyTargetUsername: vi.fn(async () => ({
        targetUserId: '1900000000000000100' as never,
        verifiedUsername: 'approved_target',
      })),
      discoverOriginalPosts,
    };
    app.use('*', async (c, next) => {
      const requestActor = c.req.header('X-Test-Actor') === 'hermes' ? 'hermes' : 'human';
      if (requestActor === 'human') {
        c.set('staffRole', 'admin');
        if (c.req.header('X-Test-Global') !== 'true') {
          c.set('staffId', 'staff_integration_operator');
          c.set('staffName', 'Integration Operator');
        }
      }
      c.set('requestActor', requestActor);
      c.set('cubelicAdapterFactory', () => new Phase1XPublishingAdapter(createDraft));
      c.set('cubelicPhase3AdapterFactory', () => new Phase3XPublishingAdapter({
        enabled: bindings.CUBELIC_PHASE3_ENABLED === 'true',
        allowedSchedulePolicies: [
          { category: 'setlist_flash', templateId: 'setlist_flash_v1' },
          { category: 'event_notice', templateId: 'event_notice_manual_v1' },
        ],
        isEmergencyStopped: () => isCubelicPublicationStopped(db),
        checkRateLimit: async () => ({ allowed: true }),
        scheduleWriter: schedulePost,
        publishWriter: publishPost,
      }));
      c.set('cubelicHumanInteractionAdapterFactory', () => new NamedHumanXInteractionAdapter({
        enabled: bindings.CUBELIC_HUMAN_INTERACTIONS_ENABLED === 'true',
        operatorId: 'staff_integration_operator',
        isEmergencyStopped: () => isCubelicPublicationStopped(db),
        write: executeInteraction,
      }));
      c.set('interactionWatchReadAdapter', interactionWatchReader);
      c.set('cubelicMediaBodyWriter', async (input) => {
        const body = await new Response(input.body).arrayBuffer();
        return input.bucket.put(input.r2Key, body, {
          onlyIf: { etagDoesNotMatch: '*' },
          sha256: input.checksum,
          httpMetadata: { contentType: input.contentType },
          customMetadata: { assetId: input.assetId, sha256: input.sha256 },
        });
      });
      return next();
    });
    app.route('/', cubelic);
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  async function request(path: string, init?: RequestInit): Promise<Response> {
    return app.request(`https://worker.example.test${path}`, init, bindings);
  }

  async function openWindow(eventId: string): Promise<void> {
    await setCubelicOperationWindow(db, {
      eventId,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      actor: 'integration-operator',
    }, {
      actor: 'human',
      action: 'system.operation_window_opened',
      entityType: 'system',
      entityId: 'operation_window',
      before: {},
      after: { eventId },
      correlationId: `corr_window_${eventId}`,
    });
  }

  it('registers exactly one verified read-only interaction watch behind dedicated gates', async () => {
    const disabled = await request('/api/cubelic/interaction-watches', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
      },
      body: JSON.stringify({ targetUsername: 'approved_target' }),
    });
    expect(disabled.status).toBe(423);

    bindings.X_INTERACTION_WATCH_ENABLED = 'true';
    bindings.X_INTERACTION_WATCH_RELEASE_APPROVED = 'true';
    bindings.X_INTERACTION_WATCH_STAGING_SMOKE_VERIFIED = 'true';
    const create = () => request('/api/cubelic/interaction-watches', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
      },
      body: JSON.stringify({ targetUsername: 'approved_target' }),
    });

    bindings.X_INTERACTION_WATCH_REVIEWED_TARGET_USER_ID = '1900000000000000999';
    const mismatchedReview = await create();
    expect(mismatchedReview.status).toBe(422);
    await expect(mismatchedReview.json()).resolves.toMatchObject({
      code: 'interaction_watch_target_not_reviewed',
    });
    bindings.X_INTERACTION_WATCH_REVIEWED_TARGET_USER_ID = '1900000000000000100';

    const created = await create();
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      data: {
        watchId: expect.stringMatching(/^watch_/),
        targetUserId: '1900000000000000100',
        targetUsername: 'approved_target',
        status: 'active',
      },
    });
    expect((await create()).status).toBe(409);
    await expect((await request('/api/cubelic/interaction-watches')).json())
      .resolves.toMatchObject({
        data: [{
          targetUserId: '1900000000000000100',
          targetUsername: 'approved_target',
        }],
      });
    const audit = await db.prepare(
      `SELECT after_json FROM cubelic_audit_logs
       WHERE action = 'interaction_watch.created'`,
    ).first<{ after_json: string }>();
    expect(JSON.parse(audit?.after_json ?? '{}')).toMatchObject({
      targetIdentityVerified: true,
      privacyReviewedTargetMatched: true,
      privacyReviewId: 'privacy_review_integration_v1',
    });
  });

  it('queues each newly detected original post once without returning its body', async () => {
    bindings.ENVIRONMENT = 'staging';
    bindings.X_INTERACTION_WATCH_ENABLED = 'true';
    bindings.X_INTERACTION_WATCH_SMOKE_MODE = 'true';
    bindings.X_INTERACTION_WATCH_RELEASE_APPROVED = 'true';
    bindings.X_INTERACTION_WATCH_STAGING_SMOKE_VERIFIED = 'true';
    discoverOriginalPosts.mockResolvedValue([
      {
        postId: '1900000000000000201',
        authorId: '1900000000000000100',
        createdAt: '2026-07-24T02:00:00.000Z',
        referencedTypes: [],
        body: 'must not be returned or persisted',
      },
      {
        postId: '1900000000000000202',
        authorId: '1900000000000000100',
        createdAt: '2026-07-24T02:01:00.000Z',
        referencedTypes: ['replied_to'],
      },
      {
        postId: '1900000000000000203',
        authorId: '1900000000000000100',
        createdAt: '2026-07-24T02:02:00.000Z',
        referencedTypes: ['retweeted'],
      },
    ]);
    const created = await request('/api/cubelic/interaction-watches', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
      },
      body: JSON.stringify({ targetUsername: 'approved_target' }),
    });
    const watchId = (await created.json() as { data: { watchId: string } }).data.watchId;

    for (const discovered of [1, 0]) {
      const poll = await request(`/api/cubelic/interaction-watches/${watchId}/poll`, {
        method: 'POST',
        headers: {
          'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
        },
      });
      expect(poll.status).toBe(200);
      await expect(poll.json()).resolves.toMatchObject({ data: { discovered } });
    }

    const candidates = await request('/api/cubelic/interaction-candidates');
    expect(candidates.status).toBe(200);
    const serialized = JSON.stringify(await candidates.json());
    expect(serialized).toContain('1900000000000000201');
    expect(serialized).not.toContain('1900000000000000202');
    expect(serialized).not.toContain('1900000000000000203');
    expect(serialized).not.toContain('must not be returned or persisted');

    await expect((await request('/api/cubelic/interaction-watch-smoke-evidence')).json())
      .resolves.toEqual({
        success: true,
        data: {
          candidateCount: 1,
          bodyColumnPresent: false,
          xWriteAuditCount: 0,
        },
      });

    bindings.ENVIRONMENT = 'production';
    bindings.X_INTERACTION_WATCH_SMOKE_MODE = 'false';
    const rateLimited = await request(
      `/api/cubelic/interaction-watches/${watchId}/poll`,
      {
        method: 'POST',
        headers: {
          'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
        },
      },
    );
    expect(rateLimited.status).toBe(422);
    await expect(rateLimited.json()).resolves.toMatchObject({
      code: 'interaction_watch_rate_limited',
    });
  });

  it('lets Cron detect candidates through a read-only adapter and nothing else', async () => {
    bindings.X_INTERACTION_WATCH_ENABLED = 'true';
    bindings.X_INTERACTION_WATCH_RELEASE_APPROVED = 'true';
    bindings.X_INTERACTION_WATCH_STAGING_SMOKE_VERIFIED = 'true';
    discoverOriginalPosts.mockResolvedValue([{
      postId: '1900000000000000301',
      authorId: '1900000000000000100',
      createdAt: '2026-07-24T03:00:00.000Z',
      referencedTypes: [],
    }]);
    await request('/api/cubelic/interaction-watches', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
      },
      body: JSON.stringify({ targetUsername: 'approved_target' }),
    });

    await expect(processInteractionWatches(bindings, interactionWatchReader))
      .resolves.toEqual({ discovered: 1, watchesPolled: 1 });
    await expect(processInteractionWatches(bindings, interactionWatchReader))
      .resolves.toEqual({ discovered: 0, watchesPolled: 0 });
    await expect((await request('/api/cubelic/interaction-candidates')).json())
      .resolves.toMatchObject({
        data: [{ postId: '1900000000000000301', status: 'pending' }],
      });
  });

  async function interactionHeaders(
    path: string,
    body: Record<string, unknown>,
    extra: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const kind = path.endsWith('/dm-reply')
      ? 'dm_reply'
      : path.slice(path.lastIndexOf('/') + 1);
    const canonical = canonicalHumanXInteractionApproval({
      kind,
      ...body,
    } as HumanXInteractionApprovalRequest, 'staff_integration_operator');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    const requestFingerprint = Array.from(
      new Uint8Array(digest),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('integration-human-key-with-at-least-32-bytes'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const proof = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(
        `interaction-approval:v1:${requestFingerprint}:staff_integration_operator`,
      ),
    );
    return {
      'content-type': 'application/json',
      'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
      'X-Interaction-Approval-Proof': Array.from(
        new Uint8Array(proof),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join(''),
      ...extra,
    };
  }

  it('bootstraps one named operator with the global and human keys while stopped', async () => {
    const bootstrap = () => request('/api/cubelic/admin/operator-bootstrap', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
        'X-Test-Global': 'true',
      },
      body: JSON.stringify({ name: 'Y-Fukiya' }),
    });
    expect((await bootstrap()).status).toBe(423);

    bindings.GLOBAL_PUBLISHING_DISABLED = 'true';
    await setCubelicEmergencyStop(db, true, 'integration-operator', {
      actor: 'human',
      action: 'system.emergency_stop',
      entityType: 'system',
      entityId: 'publishing',
      before: { stopped: false },
      after: { stopped: true },
      correlationId: 'corr_bootstrap_stop',
    });
    const first = await bootstrap();
    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({
      data: {
        name: 'Y-Fukiya',
        role: 'admin',
        apiKey: expect.stringMatching(/^xh_staff_/),
      },
    });
    expect((await bootstrap()).status).toBe(409);
    await db.prepare("UPDATE staff_members SET is_active = 0 WHERE name = 'Y-Fukiya'").run();
    expect((await bootstrap()).status).toBe(409);
    await db.prepare("DELETE FROM staff_members WHERE name = 'Y-Fukiya'").run();
    expect((await bootstrap()).status).toBe(409);
    expect((await db.prepare(
      "SELECT COUNT(*) AS count FROM cubelic_audit_logs WHERE action = 'staff.operator_bootstrapped'",
    ).first<{ count: number }>())?.count).toBe(1);
  });

  it('executes only individually approved, idempotent named-human interactions', async () => {
    bindings.CUBELIC_HUMAN_INTERACTIONS_ENABLED = 'true';
    bindings.HUMAN_INTERACTIONS_RELEASE_APPROVED = 'true';
    bindings.STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED = 'true';
    bindings.CUBELIC_PHASE3_DELIVERY_MODE = 'staging_fake';
    bindings.WORKER_URL = 'https://x-harness-worker-staging.yoshihiro-fukiya.workers.dev';
    const approvedAt = new Date().toISOString();
    const cases = [
      ['/api/cubelic/interactions/reply', {
        operationId: 'op_reply_route',
        approvalId: 'approval_reply_route',
        approvedAt,
        targetPostId: '1900000000000000001',
        text: '確認済みの個別返信です。',
        inboundOrMentionAttested: true,
      }],
      ['/api/cubelic/interactions/dm-reply', {
        operationId: 'op_dm_route',
        approvalId: 'approval_dm_route',
        approvedAt,
        conversationId: 'dm_conversation_private_1',
        inboundMessageId: '1900000000000000002',
        text: 'お問い合わせへの個別返信です。',
        recipientInitiated: true,
      }],
      ['/api/cubelic/interactions/like', {
        operationId: 'op_like_route',
        approvalId: 'approval_like_route',
        approvedAt,
        targetPostId: '1900000000000000003',
      }],
      ['/api/cubelic/interactions/follow', {
        operationId: 'op_follow_route',
        approvalId: 'approval_follow_route',
        approvedAt,
        targetUserId: '1900000000000000004',
      }],
      ['/api/cubelic/interactions/unfollow', {
        operationId: 'op_unfollow_route',
        approvalId: 'approval_unfollow_route',
        approvedAt,
        targetUserId: '1900000000000000005',
      }],
    ] as const;

    for (const [path, body] of cases) {
      const response = await request(path, {
        method: 'POST',
        headers: await interactionHeaders(path, body),
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        success: true,
        data: { operationId: body.operationId, status: 'completed' },
      });
    }
    expect(executeInteraction).toHaveBeenCalledTimes(5);

    const replay = await request(cases[0][0], {
      method: 'POST',
      headers: await interactionHeaders(cases[0][0], cases[0][1]),
      body: JSON.stringify(cases[0][1]),
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      data: { operationId: 'op_reply_route', status: 'completed', idempotentReplay: true },
    });
    expect(executeInteraction).toHaveBeenCalledTimes(5);
    const conflictingBody = { ...cases[0][1], text: '異なる本文への差し替え' };
    const conflictingReplay = await request(cases[0][0], {
      method: 'POST',
      headers: await interactionHeaders(cases[0][0], conflictingBody),
      body: JSON.stringify(conflictingBody),
    });
    expect(conflictingReplay.status).toBe(409);
    await expect(conflictingReplay.json()).resolves.toMatchObject({
      code: 'interaction_idempotency_conflict',
    });
    expect(executeInteraction).toHaveBeenCalledTimes(5);
    const repeatedTargetBody = {
      ...cases[0][1],
      operationId: 'op_reply_route_second',
      approvalId: 'approval_reply_route_second',
    };
    const repeatedTarget = await request(cases[0][0], {
      method: 'POST',
      headers: await interactionHeaders(cases[0][0], repeatedTargetBody),
      body: JSON.stringify(repeatedTargetBody),
    });
    expect(repeatedTarget.status).toBe(409);
    expect(executeInteraction).toHaveBeenCalledTimes(5);

    const auditRows = await db.prepare(
      "SELECT before_json, after_json FROM cubelic_audit_logs WHERE action LIKE 'interaction.%'",
    ).all<{ before_json: string; after_json: string }>();
    const serializedAudits = JSON.stringify(auditRows.results);
    expect(serializedAudits).not.toContain('確認済みの個別返信です');
    expect(serializedAudits).not.toContain('お問い合わせへの個別返信です');
    expect(serializedAudits).not.toContain('dm_conversation_private_1');
    expect(serializedAudits).not.toContain('1900000000000000001');
    const plainTargetDigest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify({
        kind: 'reply',
        targetPostId: '1900000000000000001',
      })),
    );
    const plainTargetFingerprint = Array.from(
      new Uint8Array(plainTargetDigest),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    const persisted = await db.prepare(
      'SELECT request_fingerprint, interaction_fingerprint, approval_fingerprint FROM cubelic_human_x_interactions WHERE operation_id = ?',
    ).bind('op_reply_route').first<{
      request_fingerprint: string;
      interaction_fingerprint: string;
      approval_fingerprint: string;
    }>();
    expect(persisted?.interaction_fingerprint).not.toBe(plainTargetFingerprint);
  });

  it('fails closed for disabled, Hermes, unnamed, bulk, and stopped interaction attempts', async () => {
    const body = JSON.stringify({
      operationId: 'op_denied_route',
      approvalId: 'approval_denied_route',
      approvedAt: new Date().toISOString(),
      targetPostId: '1900000000000000001',
      text: '送信してはいけない本文',
      inboundOrMentionAttested: true,
    });
    const headers = {
      'content-type': 'application/json',
      'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
    };
    expect((await request('/api/cubelic/interactions/reply', { method: 'POST', headers, body })).status).toBe(423);

    bindings.CUBELIC_HUMAN_INTERACTIONS_ENABLED = 'true';
    bindings.HUMAN_INTERACTIONS_RELEASE_APPROVED = 'true';
    bindings.STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED = 'true';
    bindings.CUBELIC_PHASE3_DELIVERY_MODE = 'staging_fake';
    bindings.WORKER_URL = 'https://x-harness-worker-staging.yoshihiro-fukiya.workers.dev';
    expect((await request('/api/cubelic/interactions/reply', {
      method: 'POST',
      headers: { ...headers, 'X-Test-Actor': 'hermes' },
      body,
    })).status).toBe(403);
    expect((await request('/api/cubelic/interactions/reply', {
      method: 'POST',
      headers: { ...headers, 'X-Test-Global': 'true' },
      body,
    })).status).toBe(403);
    expect((await request('/api/cubelic/interactions/reply', {
      method: 'POST',
      headers,
      body,
    })).status).toBe(403);
    expect((await request('/api/cubelic/interactions/reply', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        operationId: 'op_bulk_route',
        approvalId: 'approval_bulk_route',
        approvedAt: new Date().toISOString(),
        targetPostId: '1900000000000000001',
        targets: ['1900000000000000001', '1900000000000000002'],
        text: '一括返信',
        inboundOrMentionAttested: true,
      }),
    })).status).toBe(422);
    expect((await db.prepare(
      'SELECT COUNT(*) AS count FROM cubelic_interaction_fingerprint_key_state',
    ).first<{ count: number }>())?.count).toBe(0);

    bindings.GLOBAL_PUBLISHING_DISABLED = 'true';
    expect((await request('/api/cubelic/interactions/reply', { method: 'POST', headers, body })).status).toBe(423);
    expect(executeInteraction).not.toHaveBeenCalled();
  });

  it('never retries an interaction whose external outcome is unknown', async () => {
    bindings.CUBELIC_HUMAN_INTERACTIONS_ENABLED = 'true';
    bindings.HUMAN_INTERACTIONS_RELEASE_APPROVED = 'true';
    bindings.STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED = 'true';
    bindings.CUBELIC_PHASE3_DELIVERY_MODE = 'staging_fake';
    bindings.WORKER_URL = 'https://x-harness-worker-staging.yoshihiro-fukiya.workers.dev';
    executeInteraction.mockRejectedValueOnce(new Error('simulated transport loss'));
    const unknownPath = '/api/cubelic/interactions/reply';
    const unknownBody = {
      operationId: 'op_unknown_route',
      approvalId: 'approval_unknown_route',
      approvedAt: new Date().toISOString(),
      targetPostId: '1900000000000000011',
      text: '結果不明時に再送しない本文',
      inboundOrMentionAttested: true,
    };
    const requestUnknown = async () => request(unknownPath, {
      method: 'POST',
      headers: await interactionHeaders(unknownPath, unknownBody),
      body: JSON.stringify(unknownBody),
    });

    expect((await requestUnknown()).status).toBe(409);
    const retry = await requestUnknown();
    expect(retry.status).toBe(409);
    await expect(retry.json()).resolves.toMatchObject({ code: 'interaction_outcome_unknown' });
    expect(executeInteraction).toHaveBeenCalledOnce();
    expect((await db.prepare(
      "SELECT COUNT(*) AS count FROM cubelic_audit_logs WHERE action = 'interaction.outcome_unknown' AND entity_id = ?",
    ).bind('op_unknown_route').first<{ count: number }>())?.count).toBe(1);
  });

  it('records a definitive adapter rejection as failed rather than outcome unknown', async () => {
    bindings.CUBELIC_HUMAN_INTERACTIONS_ENABLED = 'true';
    bindings.HUMAN_INTERACTIONS_RELEASE_APPROVED = 'true';
    bindings.STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED = 'true';
    bindings.CUBELIC_PHASE3_DELIVERY_MODE = 'staging_fake';
    bindings.WORKER_URL = 'https://x-harness-worker-staging.yoshihiro-fukiya.workers.dev';
    executeInteraction.mockRejectedValueOnce(new PublicationPolicyError(
      'interaction_delivery_rejected',
      'simulated definitive rejection',
    ));
    const path = '/api/cubelic/interactions/like';
    const body = {
      operationId: 'op_rejected_route',
      approvalId: 'approval_rejected_route',
      approvedAt: new Date().toISOString(),
      targetPostId: '1900000000000000012',
    };
    const send = async () => request(path, {
      method: 'POST',
      headers: await interactionHeaders(path, body),
      body: JSON.stringify(body),
    });

    expect((await send()).status).toBe(422);
    const retry = await send();
    expect(retry.status).toBe(409);
    await expect(retry.json()).resolves.toMatchObject({ code: 'interaction_previously_failed' });
    expect(executeInteraction).toHaveBeenCalledOnce();
    expect((await db.prepare(
      "SELECT COUNT(*) AS count FROM cubelic_audit_logs WHERE action = 'interaction.failed' AND entity_id = ?",
    ).bind(body.operationId).first<{ count: number }>())?.count).toBe(1);
    expect((await db.prepare(
      "SELECT COUNT(*) AS count FROM cubelic_audit_logs WHERE action = 'interaction.outcome_unknown' AND entity_id = ?",
    ).bind(body.operationId).first<{ count: number }>())?.count).toBe(0);
  });

  it('streams an approved media body to its immutable R2 key without granting Hermes approval authority', async () => {
    bindings.CUBELIC_PHASE3_ENABLED = 'true';
    bindings.CUBELIC_PHASE3_MEDIA_ENABLED = 'true';
    bindings.CUBELIC_PHASE3_MEDIA_SMOKE_MODE = 'true';
    bindings.STAGING_PHASE3_MEDIA_SMOKE_VERIFIED = 'false';
    bindings.MEDIA_RETENTION_POLICY_VERIFIED = 'false';
    bindings.ENVIRONMENT = 'staging';
    bindings.PHASE3_RELEASE_APPROVED = 'true';
    bindings.STAGING_PHASE3_SMOKE_VERIFIED = 'true';
    bindings.CUBELIC_PHASE3_DELIVERY_MODE = 'staging_fake';
    bindings.WORKER_URL = 'https://x-harness-worker-staging.yoshihiro-fukiya.workers.dev';

    const bytes = new TextEncoder().encode('safe-media-fixture');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const event = {
      event_id: 'evt_media_stage',
      title: 'MEDIA STAGE TEST',
      venue: 'TEST VENUE',
      starts_at: '2026-07-23T10:00:00.000Z',
      ends_at: '2026-07-23T11:00:00.000Z',
      state: 'digest_ready' as const,
      event_tags: [],
      filming_policy: {
        confirmed: true,
        scope: 'full_event' as const,
        evidence_type: 'staff_confirmation' as const,
        evidence_url: 'https://example.test/evidence/media-stage',
        confirmed_at: '2026-07-23T09:00:00.000Z',
        confirmed_by: 'human_operator',
      },
    };
    await createCubelicEvent(db, event, {
      actor: 'human', action: 'event.created', entityType: 'event', entityId: event.event_id,
      before: {}, after: {}, correlationId: 'corr_media_stage_event',
    });
    await createCubelicMedia(db, {
      asset_id: 'ast_media_stage',
      event_id: event.event_id,
      path: '/exports/media-stage.mp4',
      sha256,
      duration_seconds: 3,
      orientation: 'vertical',
      resolution: '1080x1920',
      audio_present: true,
      rights: {
        filming_policy_confirmed: true,
        publishing_allowed: true,
        evidence_url: 'https://example.test/evidence/media-stage',
        song_scope_confirmed: true,
      },
      privacy: {
        audience_visible: false,
        third_party_faces_detected: false,
        manual_review_completed: true,
        cropping_required: false,
        blurring_required: false,
      },
      quality: { video_ok: true, audio_ok: true, sync_ok: true, score: 90 },
      status: 'approved_for_draft',
    }, [], {
      actor: 'human', action: 'media.validated', entityType: 'media', entityId: 'ast_media_stage',
      before: {}, after: {}, correlationId: 'corr_media_stage_asset',
    });

    const uploadHeaders = {
      'content-type': 'video/mp4',
      'content-length': String(bytes.byteLength),
      'x-content-sha256': sha256,
      'X-Test-Actor': 'human',
      'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
    };
    const unnamed = await request('/api/cubelic/media/ast_media_stage/body', {
      method: 'PUT',
      headers: {
        ...uploadHeaders,
        'X-Test-Global': 'true',
      },
      body: bytes,
    });
    expect(unnamed.status).toBe(403);

    const response = await request('/api/cubelic/media/ast_media_stage/body', {
      method: 'PUT',
      headers: uploadHeaders,
      body: bytes,
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        assetId: 'ast_media_stage',
        r2Key: `media/${sha256}`,
        sha256,
        contentType: 'video/mp4',
        byteSize: bytes.byteLength,
        stagedBy: 'staff_integration_operator',
      },
    });
    const object = await mediaBucket.get(`media/${sha256}`);
    expect(object).not.toBeNull();
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes);

    await setCubelicEmergencyStop(db, true, 'Integration Operator', {
      actor: 'human',
      action: 'system.emergency_stop',
      entityType: 'system',
      entityId: 'global',
      before: { emergencyStop: false },
      after: { emergencyStop: true },
      correlationId: 'corr_media_quarantine_stop',
    });
    const quarantine = await request('/api/cubelic/media/ast_media_stage/quarantine', {
      method: 'POST',
      headers: {
        'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
      },
    });
    expect(quarantine.status).toBe(200);
    expect(await mediaBucket.head(`media/${sha256}`)).toBeNull();
    expect((await db.prepare(
      "SELECT COUNT(*) AS count FROM cubelic_audit_logs WHERE action = 'media.quarantined' AND entity_id = ?",
    ).bind('ast_media_stage').first<{ count: number }>())?.count).toBe(1);
  });

  it('passes approved staged media through the scheduled Cron delivery seam', async () => {
    bindings.CUBELIC_PHASE3_ENABLED = 'true';
    bindings.CUBELIC_PHASE3_MEDIA_ENABLED = 'true';
    bindings.STAGING_PHASE3_MEDIA_SMOKE_VERIFIED = 'true';
    bindings.MEDIA_RETENTION_POLICY_VERIFIED = 'true';
    bindings.PHASE3_RELEASE_APPROVED = 'true';
    bindings.STAGING_PHASE3_SMOKE_VERIFIED = 'true';
    bindings.CUBELIC_PHASE3_DELIVERY_MODE = 'staging_fake';
    bindings.WORKER_URL = 'https://x-harness-worker-staging.yoshihiro-fukiya.workers.dev';
    bindings.CUBELIC_PHASE3_SCHEDULE_POLICIES = 'live_digest:live_digest_media_v1';

    const mediaBytes = new Uint8Array([1, 2, 3]);
    const mediaChecksum = await crypto.subtle.digest('SHA-256', mediaBytes);
    const sha256 = Array.from(new Uint8Array(mediaChecksum), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const eventId = 'evt_media_cron';
    const assetId = 'ast_media_cron';
    const contentId = 'cnt_media_cron';
    const draftId = 'drf_media_cron';
    await createCubelicEvent(db, {
      event_id: eventId,
      title: 'MEDIA CRON TEST',
      venue: 'TEST VENUE',
      starts_at: '2026-07-23T10:00:00.000Z',
      ends_at: '2026-07-23T11:00:00.000Z',
      state: 'digest_ready',
      event_tags: [],
      filming_policy: {
        confirmed: true,
        scope: 'full_event',
        evidence_type: 'staff_confirmation',
        evidence_url: 'https://example.test/evidence/media-cron',
        confirmed_at: '2026-07-23T09:00:00.000Z',
        confirmed_by: 'human_operator',
      },
    }, {
      actor: 'human', action: 'event.created', entityType: 'event', entityId: eventId,
      before: {}, after: {}, correlationId: 'corr_media_cron_event',
    });
    await createCubelicMedia(db, {
      asset_id: assetId,
      event_id: eventId,
      path: '/exports/media-cron.jpg',
      sha256,
      duration_seconds: 1,
      orientation: 'square',
      resolution: '1080x1080',
      audio_present: false,
      rights: {
        filming_policy_confirmed: true,
        publishing_allowed: true,
        evidence_url: 'https://example.test/evidence/media-cron',
        song_scope_confirmed: true,
      },
      privacy: {
        audience_visible: false,
        third_party_faces_detected: false,
        manual_review_completed: true,
        cropping_required: false,
        blurring_required: false,
      },
      quality: { video_ok: true, audio_ok: true, sync_ok: true, score: 90 },
      status: 'approved_for_draft',
    }, [], {
      actor: 'human', action: 'media.validated', entityType: 'media', entityId: assetId,
      before: {}, after: {}, correlationId: 'corr_media_cron_asset',
    });
    await mediaBucket.put(`media/${sha256}`, mediaBytes, {
      sha256: mediaChecksum,
      httpMetadata: { contentType: 'image/jpeg' },
      customMetadata: { assetId, sha256 },
    });
    await stageCubelicMediaObject(db, {
      assetId,
      r2Key: `media/${sha256}`,
      sha256,
      contentType: 'image/jpeg',
      byteSize: 3,
      stagedBy: 'human_operator',
    }, {
      actor: 'human', action: 'media.object_staged', entityType: 'media', entityId: assetId,
      before: {}, after: {}, correlationId: 'corr_media_cron_object',
    });
    await createCubelicContent(db, {
      content_id: contentId,
      event_id: eventId,
      category: 'live_digest',
      target_stage: 'interested',
      content_lifecycle: { type: 'news', expires_at: null },
      status: 'draft_generated',
      source_type: 'media_asset',
      source_refs: [assetId],
      member_ids: [],
      song_ids: [],
      emotion_tags: ['informative'],
      destination: {
        type: 'live_report',
        base_url: 'https://example.test/media-cron',
        tracked_url: 'https://example.test/media-cron',
      },
      created_at: '2026-07-23T11:01:00.000Z',
      updated_at: '2026-07-23T11:01:00.000Z',
    }, {
      actor: 'human', action: 'content.created', entityType: 'content', entityId: contentId,
      before: {}, after: {}, correlationId: 'corr_media_cron_content',
    });
    await createCubelicDrafts(db, [{
      draft_id: draftId,
      content_id: contentId,
      account_id: 'tubelic_cube',
      text: '媒体付き予約投稿のテストです',
      media_asset_ids: [assetId],
      category: 'live_digest',
      template_id: 'live_digest_media_v1',
      template_version: '1.0.0',
      variant: 'a',
      target_stage: 'interested',
      emotion_tags: ['informative'],
      hashtags: [],
      destination_url: 'https://example.test/media-cron',
      utm: { source: 'x', medium: 'social', campaign: 'test', content: 'media' },
      quality_score: 80,
      quality_breakdown: {
        accuracy: 80, freshness: 80, rarity: 80, newcomer_clarity: 80,
        appeal: 80, route_clarity: 80, conversation_shareability: 80,
      },
      freshness_score: 80,
      rights_gate: 'passed',
      approval_status: 'pending_review',
      risks: [],
      human_review_required: [],
      idempotency_key: 'media-cron-key',
      scheduled_at: null,
      published_post_id: null,
      created_at: '2026-07-23T11:02:00.000Z',
      updated_at: '2026-07-23T11:02:00.000Z',
    }], [{
      actor: 'human', action: 'draft.created', entityType: 'draft', entityId: draftId,
      before: {}, after: {}, correlationId: 'corr_media_cron_draft',
    }]);
    await reserveCubelicDraftApproval(db, draftId, 'staff_integration_operator', {
      actor: 'human', action: 'draft.approval_reserved', entityType: 'draft', entityId: draftId,
      before: {}, after: {}, correlationId: 'corr_media_cron_approval',
    });
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    const job = await createCubelicPublicationJob(db, {
      draftId,
      operation: 'schedule',
      authorizationKind: 'preapproved_template',
      policyId: 'live_digest_media_v1',
      authorizedBy: 'staff_integration_operator',
      authorizedAt: new Date(Date.now() - 120_000).toISOString(),
      scheduledAt: dueAt,
      idempotencyKey: 'media-cron-job',
    }, {
      actor: 'human', action: 'publication.scheduled', entityType: 'publication_job', entityId: draftId,
      before: {}, after: {}, correlationId: 'corr_media_cron_job',
    });
    await processDueCubelicPublications(bindings, new Date());

    await expect(getCubelicPublicationJob(db, job.jobId)).resolves.toMatchObject({
      status: 'published',
      postId: expect.stringMatching(/^staging_fake_/),
    });
    expect((await db.prepare(
      "SELECT COUNT(*) AS count FROM cubelic_audit_logs WHERE action IN ('publication.media_upload_started','publication.media_uploaded') AND entity_id = ?",
    ).bind(job.jobId).first<{ count: number }>())?.count).toBe(2);
  });

  it('keeps every non-metrics write stopped while the environment emergency stop is active', async () => {
    bindings.GLOBAL_PUBLISHING_DISABLED = 'true';

    const resume = await request('/api/cubelic/admin/emergency-resume', {
      method: 'POST',
      headers: { 'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes' },
      body: '{}',
    });
    expect(resume.status).toBe(423);

    const response = await request('/api/cubelic/content', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(423);
    await expect((await request('/api/cubelic/admin/status')).json()).resolves.toMatchObject({
      data: {
        safeMode: true,
        environmentStop: true,
        emergencyStop: false,
        emergencyStopValid: true,
        publishingEnabled: false,
        schedulingEnabled: false,
      },
    });
  });

  it('opens an event window only with an explicit environment resume and rejects replacement', async () => {
    bindings.CUBELIC_PHASE3_ENABLED = 'true';
    bindings.PHASE3_RELEASE_APPROVED = 'true';
    bindings.STAGING_PHASE3_SMOKE_VERIFIED = 'true';
    bindings.CUBELIC_PHASE3_DELIVERY_MODE = 'staging_fake';
    bindings.WORKER_URL = 'https://x-harness-worker-staging.yoshihiro-fukiya.workers.dev';
    bindings.GLOBAL_PUBLISHING_DISABLED = undefined;
    const requestWindow = () => request('/api/cubelic/admin/operation-window', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes' },
      body: JSON.stringify({ eventId: 'evt_window_api', durationMinutes: 15 }),
    });
    expect((await requestWindow()).status).toBe(423);

    bindings.GLOBAL_PUBLISHING_DISABLED = 'false';
    const unscopedIngestion = await request('/api/cubelic/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(unscopedIngestion.status).toBe(423);
    await expect(unscopedIngestion.json()).resolves.toMatchObject({
      code: 'operation_window_inactive',
    });
    await setCubelicEmergencyStop(db, true, 'integration-operator', {
      actor: 'human',
      action: 'system.emergency_stop',
      entityType: 'system',
      entityId: 'operation_window',
      before: { stopped: false },
      after: { stopped: true },
      correlationId: 'corr_operation_window_stop',
    });
    expect((await requestWindow()).status).toBe(201);
    expect((await requestWindow()).status).toBe(409);
    await expect((await request('/api/cubelic/admin/status')).json()).resolves.toMatchObject({
      data: {
        operationWindow: { eventId: 'evt_window_api', active: true },
      },
    });
    await db.prepare(
      "UPDATE cubelic_system_flags SET value = ? WHERE key = 'operation_window_expires_at'",
    ).bind(new Date(Date.now() - 60_000).toISOString()).run();
    await processDueCubelicPublications(bindings, new Date());
    await expect((await request('/api/cubelic/admin/status')).json()).resolves.toMatchObject({
      data: {
        emergencyStop: true,
        emergencyStopValid: true,
        operationWindow: null,
        publishingEnabled: false,
        schedulingEnabled: false,
      },
    });
    expect((await db.prepare(
      "SELECT COUNT(*) AS count FROM cubelic_audit_logs WHERE action = 'system.operation_window_expired'",
    ).first<{ count: number }>())?.count).toBe(1);
  });

  it('creates, approves, and publishes a human-attested manual Phase 3 draft without an input bundle', async () => {
    bindings.CUBELIC_PHASE3_ENABLED = 'true';
    bindings.PHASE3_RELEASE_APPROVED = 'true';
    bindings.STAGING_PHASE3_SMOKE_VERIFIED = 'true';
    bindings.CUBELIC_PHASE3_SCHEDULE_POLICIES = 'event_notice:event_notice_manual_v1';
    bindings.CUBELIC_PHASE3_DELIVERY_MODE = 'staging_fake';
    bindings.WORKER_URL = 'https://x-harness-worker-staging.yoshihiro-fukiya.workers.dev';
    await expect((await request('/api/cubelic/admin/status')).json()).resolves.toMatchObject({
      data: {
        safeMode: true,
        phase3Enabled: true,
      },
    });
    const manual = await request('/api/cubelic/manual-drafts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
        'X-Correlation-Id': 'corr_reconciliation_not_published_api',
      },
      body: JSON.stringify({
        text: '人間が確認したライブ予定です https://example.test/events/1',
        category: 'event_notice',
        destinationUrl: 'https://example.test/events/1',
        rightsConfirmed: true,
        privacyReviewCompleted: true,
        linkValidated: true,
      }),
    });
    expect(manual.status).toBe(201);
    const manualBody = await manual.json() as { data: { draft_id: string } };

    const approval = await request(`/api/cubelic/drafts/${manualBody.data.draft_id}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
      },
      body: '{}',
    });
    expect(approval.status).toBe(200);
    await expect(approval.json()).resolves.toMatchObject({
      data: { publicationReady: true, draft: { approval_status: 'approved' } },
    });

    await openWindow('evt_content_ingestion');
    const blockedPublication = await request(`/api/cubelic/drafts/${manualBody.data.draft_id}/publish`, {
      method: 'POST',
      headers: { 'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes' },
      body: '{}',
    });
    expect(blockedPublication.status).toBe(423);
    const blockedSchedule = await request(`/api/cubelic/drafts/${manualBody.data.draft_id}/schedule`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Test-Actor': 'hermes',
      },
      body: JSON.stringify({
        scheduledAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        policyId: 'event_notice_manual_v1',
      }),
    });
    expect(blockedSchedule.status).toBe(423);
    expect(publishPost).not.toHaveBeenCalled();
    expect(schedulePost).not.toHaveBeenCalled();
    await expect((await request('/api/cubelic/admin/status')).json()).resolves.toMatchObject({
      data: {
        operationWindow: { active: true },
        publishingEnabled: false,
        schedulingEnabled: false,
      },
    });
    await db.prepare(
      "DELETE FROM cubelic_system_flags WHERE key IN ('operation_window_event_id', 'operation_window_expires_at')",
    ).run();

    const publication = await request(`/api/cubelic/drafts/${manualBody.data.draft_id}/publish`, {
      method: 'POST',
      headers: { 'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes' },
      body: '{}',
    });
    expect(publication.status).toBe(201);
    expect(publishPost).toHaveBeenCalledOnce();
    const scheduled = await request(`/api/cubelic/drafts/${manualBody.data.draft_id}/schedule`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Test-Actor': 'hermes',
      },
      body: JSON.stringify({
        scheduledAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        policyId: 'event_notice_manual_v1',
      }),
    });
    expect(scheduled.status).toBe(201);
    expect(schedulePost).toHaveBeenCalledOnce();
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    const dueJob = await createCubelicPublicationJob(db, {
      draftId: manualBody.data.draft_id,
      operation: 'schedule',
      authorizationKind: 'preapproved_template',
      policyId: 'event_notice_manual_v1',
      authorizedBy: 'staff_integration_operator',
      authorizedAt: new Date(Date.now() - 120_000).toISOString(),
      scheduledAt: dueAt,
      idempotencyKey: 'integration:cron:success',
    }, {
      actor: 'human',
      action: 'publication.scheduled',
      entityType: 'publication_job',
      entityId: manualBody.data.draft_id,
      before: {},
      after: { scheduledAt: dueAt },
      correlationId: 'corr_cron_success',
    });
    await openWindow('evt_cron_block');
    await processDueCubelicPublications(bindings, new Date());
    await expect(getCubelicPublicationJob(db, dueJob.jobId)).resolves.toMatchObject({
      status: 'scheduled',
    });
    await db.prepare(
      "DELETE FROM cubelic_system_flags WHERE key IN ('operation_window_event_id', 'operation_window_expires_at')",
    ).run();
    await processDueCubelicPublications(bindings, new Date());
    await processDueCubelicPublications(bindings, new Date());
    await expect(getCubelicPublicationJob(db, dueJob.jobId)).resolves.toMatchObject({
      status: 'published',
      postId: expect.stringMatching(/^staging_fake_/),
    });

    const revokedAt = new Date(Date.now() + 48 * 60 * 60_000);
    const revokedJob = await createCubelicPublicationJob(db, {
      draftId: manualBody.data.draft_id,
      operation: 'schedule',
      authorizationKind: 'preapproved_template',
      policyId: 'event_notice_manual_v1',
      authorizedBy: 'staff_integration_operator',
      authorizedAt: new Date().toISOString(),
      scheduledAt: revokedAt.toISOString(),
      idempotencyKey: 'integration:cron:revoked',
    }, {
      actor: 'human',
      action: 'publication.scheduled',
      entityType: 'publication_job',
      entityId: manualBody.data.draft_id,
      before: {},
      after: { scheduledAt: revokedAt.toISOString() },
      correlationId: 'corr_cron_revoked',
    });
    bindings.CUBELIC_PHASE3_SCHEDULE_POLICIES = '';
    await processDueCubelicPublications(bindings, revokedAt);
    await expect(getCubelicPublicationJob(db, revokedJob.jobId)).resolves.toMatchObject({
      status: 'scheduled',
    });
    bindings.CUBELIC_PHASE3_SCHEDULE_POLICIES = 'malformed-policy';
    await processDueCubelicPublications(bindings, revokedAt);
    await expect(getCubelicPublicationJob(db, revokedJob.jobId)).resolves.toMatchObject({
      status: 'scheduled',
    });
    bindings.CUBELIC_PHASE3_SCHEDULE_POLICIES = 'event_notice:event_notice_manual_v1';

    const prePostFailureAt = new Date(Date.now() + 4 * 60 * 60_000);
    const prePostFailureJob = await createCubelicPublicationJob(db, {
      draftId: manualBody.data.draft_id,
      operation: 'schedule',
      authorizationKind: 'preapproved_template',
      policyId: 'event_notice_manual_v1',
      authorizedBy: 'staff_integration_operator',
      authorizedAt: new Date().toISOString(),
      scheduledAt: prePostFailureAt.toISOString(),
      idempotencyKey: 'integration:cron:pre-post-failure',
    }, {
      actor: 'human',
      action: 'publication.scheduled',
      entityType: 'publication_job',
      entityId: manualBody.data.draft_id,
      before: {},
      after: { scheduledAt: prePostFailureAt.toISOString() },
      correlationId: 'corr_cron_pre_post_failure',
    });
    await processDueCubelicPublications(bindings, prePostFailureAt, async () => {
      throw new PublicationDeliveryNotAttemptedError('media_storage_inconsistent', new Error('missing R2 body'));
    });
    await expect(getCubelicPublicationJob(db, prePostFailureJob.jobId)).resolves.toMatchObject({
      status: 'failed',
      failureCode: 'media_storage_inconsistent',
    });

    const unknownAt = new Date(Date.now() + 5 * 60 * 60_000);
    const unknownJob = await createCubelicPublicationJob(db, {
      draftId: manualBody.data.draft_id,
      operation: 'schedule',
      authorizationKind: 'preapproved_template',
      policyId: 'event_notice_manual_v1',
      authorizedBy: 'staff_integration_operator',
      authorizedAt: new Date().toISOString(),
      scheduledAt: unknownAt.toISOString(),
      idempotencyKey: 'integration:cron:unknown',
    }, {
      actor: 'human',
      action: 'publication.scheduled',
      entityType: 'publication_job',
      entityId: manualBody.data.draft_id,
      before: {},
      after: { scheduledAt: unknownAt.toISOString() },
      correlationId: 'corr_cron_unknown',
    });
    const unknownDelivery = vi.fn(async () => {
      throw new Error('timeout after request dispatch');
    });
    await processDueCubelicPublications(bindings, unknownAt, unknownDelivery);
    await expect(getCubelicPublicationJob(db, unknownJob.jobId)).resolves.toMatchObject({
      status: 'publishing',
    });
    expect((await db.prepare(
      "SELECT COUNT(*) AS count FROM cubelic_audit_logs WHERE action = 'publication.outcome_unknown' AND entity_id = ?",
    ).bind(unknownJob.jobId).first<{ count: number }>())?.count).toBe(1);

    expect((await db.prepare(
      "SELECT COUNT(*) AS count FROM cubelic_audit_logs WHERE action IN ('manual_authority.created','draft.manual_created')",
    ).first<{ count: number }>())?.count).toBe(2);
  });

  it('reconciles a confirmed missing post into a failed job and a new retry identity while stopped', async () => {
    bindings.CUBELIC_PHASE3_ENABLED = 'true';
    bindings.PHASE3_RELEASE_APPROVED = 'true';
    bindings.STAGING_PHASE3_SMOKE_VERIFIED = 'true';
    bindings.CUBELIC_PHASE3_DELIVERY_MODE = 'staging_fake';
    bindings.WORKER_URL = 'https://x-harness-worker-staging.yoshihiro-fukiya.workers.dev';

    const manual = await request('/api/cubelic/manual-drafts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
      },
      body: JSON.stringify({
        text: '結果不明の照合テストです https://example.test/reconciliation',
        category: 'event_notice',
        destinationUrl: 'https://example.test/reconciliation',
        rightsConfirmed: true,
        privacyReviewCompleted: true,
        linkValidated: true,
      }),
    });
    const draftId = ((await manual.json()) as { data: { draft_id: string } }).data.draft_id;
    expect((await request(`/api/cubelic/drafts/${draftId}/approve`, {
      method: 'POST',
      headers: { 'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes' },
      body: '{}',
    })).status).toBe(200);
    const draft = await db.prepare(
      'SELECT idempotency_key FROM cubelic_draft_posts WHERE draft_id = ?',
    ).bind(draftId).first<{ idempotency_key: string }>();
    const unknown = await createCubelicPublicationJob(db, {
      draftId,
      operation: 'publish',
      authorizationKind: 'human_individual',
      authorizedBy: 'staff_integration_operator',
      authorizedAt: new Date().toISOString(),
      idempotencyKey: `${draft!.idempotency_key}:publish`,
    }, {
      actor: 'human',
      action: 'publication.started',
      entityType: 'publication_job',
      entityId: draftId,
      before: {},
      after: { draftId },
      correlationId: 'corr_reconciliation_unknown',
    });
    await setCubelicEmergencyStop(db, true, 'integration-operator', {
      actor: 'human',
      action: 'system.emergency_stop',
      entityType: 'system',
      entityId: 'publishing',
      before: { stopped: false },
      after: { stopped: true },
      correlationId: 'corr_reconciliation_stop',
    });

    const response = await request(`/api/cubelic/admin/publications/${unknown.jobId}/reconcile`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
        'X-Correlation-Id': 'corr_reconciliation_not_published_api',
      },
      body: JSON.stringify({
        outcome: 'not_published',
        evidence: {
          recentPostsChecked: 10,
          postIdMatchFound: false,
          fixedTextPrefixMatchFound: false,
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        jobId: unknown.jobId,
        outcome: 'not_published',
        status: 'failed',
        retryIdempotencyKey: expect.stringMatching(new RegExp(`^${draft!.idempotency_key}:retry:`)),
      },
    });
    await expect((await request('/api/cubelic/admin/status')).json()).resolves.toMatchObject({
      data: { emergencyStop: true, publishingEnabled: false, schedulingEnabled: false },
    });
    const audits = await db.prepare(
      'SELECT action, before_json, after_json FROM cubelic_audit_logs WHERE correlation_id = ? ORDER BY action',
    ).bind('corr_reconciliation_not_published_api').all<{
      action: string;
      before_json: string;
      after_json: string;
    }>();
    expect(audits.results.map(({ action }) => action)).toEqual([
      'draft.retry_idempotency_issued',
      'publication.reconciled_failed',
      'publication.reconciliation_completed',
      'publication.reconciliation_started',
      'system.reconciliation_stop_preserved',
    ]);
    expect(JSON.stringify(audits.results)).not.toContain('結果不明の照合テストです');
    expect(JSON.stringify(audits.results)).not.toContain('Integration Operator');
    await expect(db.prepare(
      'SELECT actor FROM cubelic_publication_reconciliations WHERE job_id = ?',
    ).bind(unknown.jobId).first()).resolves.toEqual({ actor: 'staff_integration_operator' });
  });

  it('reconciles a confirmed existing X post by completing the original job without another X write', async () => {
    bindings.CUBELIC_PHASE3_ENABLED = 'true';
    bindings.PHASE3_RELEASE_APPROVED = 'true';
    bindings.STAGING_PHASE3_SMOKE_VERIFIED = 'true';
    bindings.CUBELIC_PHASE3_DELIVERY_MODE = 'staging_fake';
    bindings.WORKER_URL = 'https://x-harness-worker-staging.yoshihiro-fukiya.workers.dev';

    const manual = await request('/api/cubelic/manual-drafts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
      },
      body: JSON.stringify({
        text: '投稿済み照合テストです https://example.test/reconciliation/published',
        category: 'event_notice',
        destinationUrl: 'https://example.test/reconciliation/published',
        rightsConfirmed: true,
        privacyReviewCompleted: true,
        linkValidated: true,
      }),
    });
    const draftId = ((await manual.json()) as { data: { draft_id: string } }).data.draft_id;
    expect((await request(`/api/cubelic/drafts/${draftId}/approve`, {
      method: 'POST',
      headers: { 'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes' },
      body: '{}',
    })).status).toBe(200);
    const draft = await db.prepare(
      'SELECT idempotency_key FROM cubelic_draft_posts WHERE draft_id = ?',
    ).bind(draftId).first<{ idempotency_key: string }>();
    const unknown = await createCubelicPublicationJob(db, {
      draftId,
      operation: 'publish',
      authorizationKind: 'human_individual',
      authorizedBy: 'staff_integration_operator',
      authorizedAt: new Date().toISOString(),
      idempotencyKey: `${draft!.idempotency_key}:publish`,
    }, {
      actor: 'human',
      action: 'publication.started',
      entityType: 'publication_job',
      entityId: draftId,
      before: {},
      after: { draftId },
      correlationId: 'corr_reconciliation_published_unknown',
    });
    await setCubelicEmergencyStop(db, true, 'integration-operator', {
      actor: 'human',
      action: 'system.emergency_stop',
      entityType: 'system',
      entityId: 'publishing',
      before: { stopped: false },
      after: { stopped: true },
      correlationId: 'corr_reconciliation_published_stop',
    });
    const future = await request(`/api/cubelic/admin/publications/${unknown.jobId}/reconcile`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
      },
      body: JSON.stringify({
        outcome: 'published',
        postId: '2080209283598487956',
        publishedAt: '2999-07-23T08:31:56.000Z',
      }),
    });
    expect(future.status).toBe(422);
    await expect(future.json()).resolves.toMatchObject({
      code: 'reconciliation_published_evidence_invalid',
    });
    for (const invalidPublishedAt of ['2026-02-31T00:00:00Z', '2026-07-23T24:00:00Z']) {
      const invalid = await request(`/api/cubelic/admin/publications/${unknown.jobId}/reconcile`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
        },
        body: JSON.stringify({
          outcome: 'published',
          postId: '2080209283598487956',
          publishedAt: invalidPublishedAt,
        }),
      });
      expect(invalid.status).toBe(422);
      await expect(invalid.json()).resolves.toMatchObject({
        code: 'reconciliation_published_evidence_invalid',
      });
    }
    const publishedAtInput = '2026-07-23T17:31:56+09:00';
    const publishedAt = '2026-07-23T08:31:56.000Z';
    const response = await request(`/api/cubelic/admin/publications/${unknown.jobId}/reconcile`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
        'X-Correlation-Id': 'corr_reconciliation_published_api',
      },
      body: JSON.stringify({
        outcome: 'published',
        postId: '2080209283598487956',
        publishedAt: publishedAtInput,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        jobId: unknown.jobId,
        outcome: 'published',
        status: 'published',
        postId: '2080209283598487956',
        publishedAt,
      },
    });
    expect(publishPost).not.toHaveBeenCalled();
    await expect((await request('/api/cubelic/admin/status')).json()).resolves.toMatchObject({
      data: { emergencyStop: true, publishingEnabled: false, schedulingEnabled: false },
    });
    const audits = await db.prepare(
      'SELECT action, before_json, after_json FROM cubelic_audit_logs WHERE correlation_id = ? ORDER BY action',
    ).bind('corr_reconciliation_published_api').all<{
      action: string;
      before_json: string;
      after_json: string;
    }>();
    expect(audits.results.map(({ action }) => action)).toEqual([
      'publication.reconciled_published',
      'publication.reconciliation_completed',
      'publication.reconciliation_started',
      'system.reconciliation_stop_preserved',
    ]);
    expect(JSON.stringify(audits.results)).not.toContain('投稿済み照合テストです');
  });

  it('fails reconciliation closed without a named human, approval proof, stop, or sufficient evidence', async () => {
    const path = '/api/cubelic/admin/publications/pub_unknown/reconcile';
    const validBody = JSON.stringify({
      outcome: 'not_published',
      evidence: {
        recentPostsChecked: 10,
        postIdMatchFound: false,
        fixedTextPrefixMatchFound: false,
      },
    });
    expect((await request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
      },
      body: validBody,
    })).status).toBe(423);

    await setCubelicEmergencyStop(db, true, 'integration-operator', {
      actor: 'human',
      action: 'system.emergency_stop',
      entityType: 'system',
      entityId: 'publishing',
      before: { stopped: false },
      after: { stopped: true },
      correlationId: 'corr_reconciliation_auth_stop',
    });
    expect((await request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validBody,
    })).status).toBe(403);
    bindings.HUMAN_APPROVAL_KEY = 'short-key';
    expect((await request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Human-Approval-Key': 'short-key',
      },
      body: validBody,
    })).status).toBe(503);
    bindings.HUMAN_APPROVAL_KEY = 'integration-human-key-with-at-least-32-bytes';
    expect((await request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
        'X-Test-Actor': 'hermes',
      },
      body: validBody,
    })).status).toBe(403);
    expect((await request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
        'X-Test-Global': 'true',
      },
      body: validBody,
    })).status).toBe(403);

    const insufficient = await request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
      },
      body: JSON.stringify({
        outcome: 'not_published',
        evidence: {
          recentPostsChecked: 9,
          postIdMatchFound: false,
          fixedTextPrefixMatchFound: false,
        },
      }),
    });
    expect(insufficient.status).toBe(422);
    await expect(insufficient.json()).resolves.toMatchObject({
      code: 'reconciliation_evidence_insufficient',
    });

    await db.prepare("DELETE FROM cubelic_system_flags WHERE key = 'emergency_stop'").run();
    const missingStop = await request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes',
      },
      body: validBody,
    });
    expect(missingStop.status).toBe(423);
    await expect(missingStop.json()).resolves.toMatchObject({
      code: 'reconciliation_emergency_stop_state_invalid',
    });
    await expect((await request('/api/cubelic/admin/status')).json()).resolves.toMatchObject({
      data: {
        emergencyStop: true,
        emergencyStopValid: false,
        publishingEnabled: false,
        schedulingEnabled: false,
      },
    });
  });

  it('rejects expired and cross-event operation-window writes', async () => {
    const event = {
      event_id: 'evt_window_allowed',
      title: 'WINDOW TEST',
      venue: 'TEST VENUE',
      starts_at: new Date(Date.now() - 90 * 60_000).toISOString(),
      ends_at: new Date(Date.now() - 15 * 60_000).toISOString(),
      state: 'ended',
      event_tags: [],
      filming_policy: { confirmed: false, scope: 'unknown', evidence_type: null, evidence_url: null, confirmed_at: null, confirmed_by: null },
    };
    await openWindow(event.event_id);
    const mismatch = await request('/api/cubelic/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...event, event_id: 'evt_window_other' }),
    });
    expect(mismatch.status).toBe(423);

    await setCubelicOperationWindow(db, {
      eventId: event.event_id,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      actor: 'integration-operator',
    }, {
      actor: 'human',
      action: 'system.operation_window_expired_fixture',
      entityType: 'system',
      entityId: 'operation_window',
      before: {},
      after: { eventId: event.event_id },
      correlationId: 'corr_window_expired',
    });
    expect((await request('/api/cubelic/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    })).status).toBe(423);
    expect(await getCubelicEmergencyStop(db)).toBe(true);
  });

  it('requires human proof for initial media review and atomically records blocked-media reasons', async () => {
    const now = Date.now();
    const event = {
      event_id: 'evt_media_review',
      title: 'MEDIA REVIEW TEST',
      venue: 'TEST VENUE',
      starts_at: new Date(now - 90 * 60_000).toISOString(),
      ends_at: new Date(now - 15 * 60_000).toISOString(),
      state: 'digest_ready',
      event_tags: [],
      filming_policy: {
        confirmed: true,
        scope: 'full_event',
        evidence_type: 'staff_confirmation',
        evidence_url: 'https://example.test/evidence/media',
        confirmed_at: new Date(now - 20 * 60_000).toISOString(),
        confirmed_by: 'human_operator',
      },
    };
    await openWindow(event.event_id);
    expect((await request('/api/cubelic/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes' },
      body: JSON.stringify(event),
    })).status).toBe(201);

    const media = {
      asset_id: 'ast_media_review',
      event_id: event.event_id,
      path: '/exports/media-review.mp4',
      sha256: 'c'.repeat(64),
      duration_seconds: 15,
      orientation: 'vertical',
      resolution: '1080x1920',
      audio_present: true,
      rights: { filming_policy_confirmed: true, publishing_allowed: true, evidence_url: 'https://example.test/evidence/media', song_scope_confirmed: true },
      privacy: { audience_visible: true, third_party_faces_detected: false, manual_review_completed: false, cropping_required: false, blurring_required: false },
      quality: { video_ok: true, audio_ok: true, sync_ok: true, score: 90 },
    };
    expect((await request('/api/cubelic/media/validate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(media),
    })).status).toBe(403);
    const blocked = await request('/api/cubelic/media/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes' },
      body: JSON.stringify(media),
    });
    expect(blocked.status).toBe(422);
    expect(await db.prepare("SELECT asset_id FROM cubelic_media_assets WHERE asset_id = 'ast_media_review' AND status = 'blocked'").first()).not.toBeNull();
    expect((await db.prepare("SELECT COUNT(*) AS count FROM cubelic_rejection_events WHERE reason = 'third_party_visible'").first<{ count: number }>())?.count).toBe(1);
  });

  it('runs setlist to inert handoff and then stops all non-metrics writes', async () => {
    const now = Date.now();
    const event = {
      event_id: 'evt_api_integration',
      title: 'CUBΣLIC API TEST',
      venue: 'TEST VENUE',
      starts_at: new Date(now - 90 * 60_000).toISOString(),
      ends_at: new Date(now - 15 * 60_000).toISOString(),
      state: 'ended',
      event_tags: [],
      filming_policy: { confirmed: false, scope: 'unknown', evidence_type: null, evidence_url: null, confirmed_at: null, confirmed_by: null },
    };
    await openWindow(event.event_id);
    expect((await request('/api/cubelic/events', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event),
    })).status).toBe(201);
    await openWindow('evt_hermes_rights_claim');
    const hermesRightsClaim = await request('/api/cubelic/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Test-Actor': 'hermes' },
      body: JSON.stringify({
        ...event,
        event_id: 'evt_hermes_rights_claim',
        filming_policy: {
          confirmed: true,
          scope: 'full_event',
          evidence_type: 'staff_confirmation',
          evidence_url: 'https://example.test/evidence/1',
          confirmed_at: new Date(now - 20 * 60_000).toISOString(),
          confirmed_by: 'human_operator',
        },
      }),
    });
    expect(hermesRightsClaim.status).toBe(403);
    expect(await db.prepare("SELECT event_id FROM cubelic_events WHERE event_id = 'evt_hermes_rights_claim'").first()).toBeNull();
    const humanRightsEvent = {
      ...event,
      event_id: 'evt_human_rights_claim',
      filming_policy: {
        confirmed: true,
        scope: 'full_event',
        evidence_type: 'staff_confirmation',
        evidence_url: 'https://example.test/evidence/2',
        confirmed_at: new Date(now - 20 * 60_000).toISOString(),
        confirmed_by: 'human_operator',
      },
    };
    await openWindow(humanRightsEvent.event_id);
    expect((await request('/api/cubelic/events', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(humanRightsEvent),
    })).status).toBe(403);
    expect((await request('/api/cubelic/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes' },
      body: JSON.stringify(humanRightsEvent),
    })).status).toBe(201);
    await openWindow(event.event_id);

    const referencedContent = {
      content_id: 'cnt_reference_check',
      event_id: event.event_id,
      category: 'song_focus',
      target_stage: 'interested',
      content_lifecycle: { type: 'hybrid', expires_at: null },
      status: 'validated',
      source_type: 'manual',
      source_refs: ['integration'],
      member_ids: [],
      song_ids: ['song_api_1'],
      emotion_tags: ['informative'],
      destination: { type: 'song_page', base_url: 'https://example.test/songs/song_api_1', tracked_url: '' },
    };
    const unknownContent = await request('/api/cubelic/content', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(referencedContent),
    });
    expect(unknownContent.status).toBe(422);
    await expect(unknownContent.json()).resolves.toMatchObject({ rejectReasons: ['song_unknown'] });
    expect((await db.prepare("SELECT COUNT(*) AS count FROM cubelic_rejection_events WHERE reason = 'song_unknown'").first<{ count: number }>())?.count).toBe(1);

    const setlist = {
      schema_version: 'cubelic.gas-setlist.v1',
      event_id: event.event_id,
      event_title: event.title,
      venue: event.venue,
      starts_at: event.starts_at,
      ends_at: event.ends_at,
      lp_url: 'https://example.test/setlists/evt_api_integration',
      confirmed_at: new Date(now - 10 * 60_000).toISOString(),
      confirmed_by: 'Integration Operator',
      songs: [{ position: 1, song_id: 'song_api_1', title: 'API Integration Song' }],
    };
    expect((await request('/api/cubelic/setlists/ingest', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(setlist),
    })).status).toBe(422);

    const masterResponse = await request('/api/cubelic/masters/songs/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes' },
      body: JSON.stringify({
        schema_version: 'cubelic.song-master.v1',
        generated_at: '2026-07-21T18:00:00+09:00',
        songs: [{ song_id: 'song_api_1', title: 'API Integration Song', aliases: [], active: true }],
      }),
    });
    expect(masterResponse.status).toBe(201);
    expect((await request('/api/cubelic/content', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(referencedContent),
    })).status).toBe(201);

    const setlistResponse = await request('/api/cubelic/setlists/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(setlist),
    });
    expect(setlistResponse.status).toBe(201);
    const setlistBody = await setlistResponse.json() as { data: { drafts: Array<{ draft_id: string }> } };
    expect(setlistBody.data.drafts).toHaveLength(3);
    const draftId = setlistBody.data.drafts[0].draft_id;

    expect((await request(`/api/cubelic/drafts/${draftId}/approve`, { method: 'POST', body: '{}' })).status).toBe(403);
    await db.prepare("UPDATE cubelic_songs SET active = 0 WHERE song_id = 'song_api_1'").run();
    expect((await request(`/api/cubelic/drafts/${draftId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes' },
      body: '{}',
    })).status).toBe(422);
    expect(createDraft).not.toHaveBeenCalled();
    await db.prepare("UPDATE cubelic_songs SET active = 1 WHERE song_id = 'song_api_1'").run();
    const approval = await request(`/api/cubelic/drafts/${draftId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes' },
      body: '{}',
    });
    expect(approval.status).toBe(200);
    const approvalBody = await approval.json() as { data: { xHarnessDraft: { status: string } } };
    expect(approvalBody.data.xHarnessDraft.status).toBe('inert_draft');
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect((await db.prepare('SELECT COUNT(*) AS count FROM cubelic_x_draft_inbox').first<{ count: number }>())?.count).toBe(1);
    expect(await getCubelicEmergencyStop(db)).toBe(true);

    await openWindow(event.event_id);
    expect((await request('/api/cubelic/admin/emergency-resume', {
      method: 'POST',
      headers: { 'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes' },
      body: '{}',
    })).status).toBe(200);

    const rejectedDraftId = setlistBody.data.drafts[1].draft_id;
    expect((await request(`/api/cubelic/drafts/${rejectedDraftId}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes' },
      body: JSON.stringify({ reason: 'manual_rejection' }),
    })).status).toBe(200);
    const rejectionSummary = await (await request('/api/cubelic/rejections/summary')).json() as { data: Array<{ reason: string; count: number }> };
    expect(rejectionSummary.data).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'manual_rejection', count: 1 })]));

    const postId = '1234567890123456789';
    expect((await request('/api/cubelic/metrics/post-mappings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes' },
      body: JSON.stringify({ draftId, postId, publishedAt: '2026-07-21T22:00:00+09:00' }),
    })).status).toBe(201);
    expect((await request('/api/cubelic/metrics/collect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postId, window: '2h' }),
    })).status).toBe(201);
    const summary = await (await request('/api/cubelic/metrics/summary')).json() as { data: Array<{ draftId: string; dimensions: { eventId: string } }> };
    expect(summary.data).toEqual([expect.objectContaining({ draftId, dimensions: expect.objectContaining({ eventId: event.event_id }) })]);

    const stop = await request('/api/cubelic/admin/emergency-stop', {
      method: 'POST', headers: { 'X-Human-Approval-Key': 'integration-human-key-with-at-least-32-bytes' }, body: '{}',
    });
    expect(stop.status).toBe(200);
    expect((await request('/api/cubelic/content', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).status).toBe(423);
  });
});
