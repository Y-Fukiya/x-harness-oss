import { describe, expect, it, vi } from 'vitest';
import {
  NamedHumanXInteractionAdapter,
  Phase1XPublishingAdapter,
  Phase3XPublishingAdapter,
} from './adapter.js';

describe('Phase1XPublishingAdapter', () => {
  it('creates only an inert draft', async () => {
    const writer = vi.fn(async () => ({ inboxId: 'inbox_1', status: 'inert_draft' as const, idempotentReplay: false }));
    const adapter = new Phase1XPublishingAdapter(writer);
    const result = await adapter.createDraft({
      draftId: 'drf_1', accountId: 'acc_1', text: 'draft', mediaAssetIds: [], idempotencyKey: 'key', approvedBy: 'human', approvedAt: new Date().toISOString(),
    });
    expect(result.status).toBe('inert_draft');
    expect(writer).toHaveBeenCalledOnce();
  });

  it('disables schedule, publish and delete', async () => {
    const adapter = new Phase1XPublishingAdapter(async () => ({ inboxId: 'x', status: 'inert_draft', idempotentReplay: false }));
    await expect(adapter.schedulePost()).rejects.toMatchObject({ code: 'phase1_operation_disabled' });
    await expect(adapter.publishPost()).rejects.toMatchObject({ code: 'phase1_operation_disabled' });
    await expect(adapter.deletePost()).rejects.toMatchObject({ code: 'phase1_operation_disabled' });
  });

  it('preserves unavailable metrics as null', async () => {
    const adapter = new Phase1XPublishingAdapter(async () => ({ inboxId: 'x', status: 'inert_draft', idempotentReplay: false }));
    expect(await adapter.getMetrics('post_1')).toMatchObject({ impressions: null, ticket_clicks: null });
  });
});

const approvedPublication = {
  draftId: 'drf_1',
  accountId: 'acc_1',
  text: '人間が確認した投稿',
  mediaAssetIds: [],
  category: 'event_notice' as const,
  templateId: 'event-notice-v1',
  approvalStatus: 'approved' as const,
  approvedBy: 'operator_1',
  approvedAt: '2026-07-23T01:00:00.000Z',
  rightsGate: 'not_applicable' as const,
  privacyReviewCompleted: true as const,
  linkValidated: true as const,
  idempotencyKey: 'publication-key',
};

describe('Phase3XPublishingAdapter', () => {
  it('publishes immediately only with individual human authorization', async () => {
    const publishWriter = vi.fn(async () => ({
      postId: 'post_1',
      status: 'published' as const,
      publishedAt: '2026-07-23T01:05:00.000Z',
    }));
    const adapter = new Phase3XPublishingAdapter({
      enabled: true,
      isEmergencyStopped: async () => false,
      checkRateLimit: async () => ({ allowed: true as const }),
      scheduleWriter: vi.fn(),
      publishWriter,
    });

    const result = await adapter.publishPost({
      ...approvedPublication,
      authorization: {
        kind: 'human_individual',
        operatorId: 'operator_1',
        authorizedAt: '2026-07-23T01:04:00.000Z',
      },
    });

    expect(result.status).toBe('published');
    expect(publishWriter).toHaveBeenCalledOnce();
  });

  it('keeps media delivery disabled unless its separate capability is enabled', async () => {
    const publishWriter = vi.fn();
    const adapter = new Phase3XPublishingAdapter({
      enabled: true,
      isEmergencyStopped: async () => false,
      checkRateLimit: async () => ({ allowed: true as const }),
      scheduleWriter: vi.fn(),
      publishWriter,
    });

    await expect(adapter.publishPost({
      ...approvedPublication,
      mediaAssetIds: ['asset_1'],
      authorization: {
        kind: 'human_individual',
        operatorId: 'operator_1',
        authorizedAt: '2026-07-23T01:04:00.000Z',
      },
    })).rejects.toMatchObject({ code: 'media_delivery_disabled' });
    expect(publishWriter).not.toHaveBeenCalled();
  });

  it('passes reviewed media to the publication writer when media delivery is enabled', async () => {
    const publishWriter = vi.fn(async () => ({
      postId: 'post_media_1',
      status: 'published' as const,
      publishedAt: '2026-07-23T01:05:00.000Z',
    }));
    const adapter = new Phase3XPublishingAdapter({
      enabled: true,
      mediaDeliveryEnabled: true,
      isEmergencyStopped: async () => false,
      checkRateLimit: async () => ({ allowed: true as const }),
      scheduleWriter: vi.fn(),
      publishWriter,
    });

    await expect(adapter.publishPost({
      ...approvedPublication,
      mediaAssetIds: ['asset_1'],
      authorization: {
        kind: 'human_individual',
        operatorId: 'operator_1',
        authorizedAt: '2026-07-23T01:04:00.000Z',
      },
    })).resolves.toMatchObject({ postId: 'post_media_1' });
    expect(publishWriter).toHaveBeenCalledOnce();
  });

  it('schedules only an allowlisted pre-approved template', async () => {
    const scheduleWriter = vi.fn(async () => ({
      jobId: 'job_1',
      status: 'scheduled' as const,
      scheduledAt: '2026-07-24T01:00:00.000Z',
    }));
    const adapter = new Phase3XPublishingAdapter({
      enabled: true,
      allowedSchedulePolicies: [{ category: 'event_notice', templateId: 'event-notice-v1' }],
      isEmergencyStopped: async () => false,
      checkRateLimit: async () => ({ allowed: true as const }),
      scheduleWriter,
      publishWriter: vi.fn(),
      now: () => new Date('2026-07-23T01:00:00.000Z'),
    });

    const result = await adapter.schedulePost({
      ...approvedPublication,
      scheduledAt: '2026-07-24T01:00:00.000Z',
      authorization: {
        kind: 'preapproved_template',
        policyId: 'event-notice-v1',
        approvedBy: 'operator_1',
        approvedAt: '2026-07-23T00:00:00.000Z',
      },
    });

    expect(result.status).toBe('scheduled');
    expect(scheduleWriter).toHaveBeenCalledOnce();
  });

  it.each([
    ['capability disabled', { enabled: false }, 'phase3_operation_disabled'],
    ['emergency stop active', { isEmergencyStopped: async () => true }, 'emergency_stop_active'],
    ['rate limit denied', { checkRateLimit: async () => ({ allowed: false as const, reason: 'daily_limit' }) }, 'publication_rate_limited'],
  ])('fails closed when %s', async (_name, override, code) => {
    const adapter = new Phase3XPublishingAdapter({
      enabled: true,
      isEmergencyStopped: async () => false,
      checkRateLimit: async () => ({ allowed: true as const }),
      scheduleWriter: vi.fn(),
      publishWriter: vi.fn(async () => ({
        postId: 'post_1',
        status: 'published' as const,
        publishedAt: '2026-07-23T01:05:00.000Z',
      })),
      ...override,
    });

    await expect(adapter.publishPost({
      ...approvedPublication,
      authorization: {
        kind: 'human_individual',
        operatorId: 'operator_1',
        authorizedAt: '2026-07-23T01:04:00.000Z',
      },
    })).rejects.toMatchObject({ code });
  });

  it('rejects automation on the immediate-publication seam', async () => {
    const adapter = new Phase3XPublishingAdapter({
      enabled: true,
      isEmergencyStopped: async () => false,
      checkRateLimit: async () => ({ allowed: true as const }),
      scheduleWriter: vi.fn(),
      publishWriter: vi.fn(),
    });

    await expect(adapter.publishPost({
      ...approvedPublication,
      authorization: {
        kind: 'preapproved_template',
        policyId: 'event-notice-v1',
        approvedBy: 'operator_1',
        approvedAt: '2026-07-23T00:00:00.000Z',
      },
    })).rejects.toMatchObject({ code: 'human_publication_required' });
  });
});

describe('NamedHumanXInteractionAdapter', () => {
  const reply = {
    kind: 'reply' as const,
    operationId: 'op_reply_1',
    approvalId: 'approval_reply_1',
    approvedAt: '2026-07-24T10:00:00.000Z',
    targetPostId: '1900000000000000001',
    text: '個別に確認した返信です。',
    inboundOrMentionAttested: true as const,
    authorization: {
      kind: 'human_individual' as const,
      approvalId: 'approval_reply_1',
      operatorId: 'staff_1',
      approvedBy: 'staff_1',
      approvedAt: '2026-07-24T10:00:00.000Z',
    },
  };

  it('executes one individually approved operation through the injected writer', async () => {
    const write = vi.fn(async () => ({ status: 'completed' as const, externalId: '1900000000000000002' }));
    const adapter = new NamedHumanXInteractionAdapter({
      enabled: true,
      operatorId: 'staff_1',
      isEmergencyStopped: async () => false,
      write,
    });

    await expect(adapter.execute(reply)).resolves.toEqual({
      status: 'completed',
      externalId: '1900000000000000002',
    });
    expect(write).toHaveBeenCalledOnce();
  });

  it.each([
    ['disabled', { enabled: false }, 'human_interactions_disabled'],
    ['emergency stopped', { isEmergencyStopped: async () => true }, 'emergency_stop_active'],
  ])('rejects execution while %s', async (_label, override, code) => {
    const adapter = new NamedHumanXInteractionAdapter({
      enabled: true,
      operatorId: 'staff_1',
      isEmergencyStopped: async () => false,
      write: async () => ({ status: 'completed' }),
      ...override,
    });
    await expect(adapter.execute(reply)).rejects.toMatchObject({ code });
  });

  it('rejects mismatched or non-individual authority before the writer', async () => {
    const write = vi.fn(async () => ({ status: 'completed' as const }));
    const adapter = new NamedHumanXInteractionAdapter({
      enabled: true,
      operatorId: 'staff_1',
      isEmergencyStopped: async () => false,
      write,
    });

    await expect(adapter.execute({
      ...reply,
      authorization: { ...reply.authorization, approvedBy: 'staff_2' },
    })).rejects.toMatchObject({ code: 'interaction_operator_mismatch' });
    await expect(adapter.execute({
      ...reply,
      authorization: { ...reply.authorization, kind: 'automated' as never },
    })).rejects.toMatchObject({ code: 'individual_human_approval_required' });
    expect(write).not.toHaveBeenCalled();
  });
});
