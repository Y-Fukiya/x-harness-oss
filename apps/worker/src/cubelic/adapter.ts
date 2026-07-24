import {
  Phase1XPublishingAdapter,
  Phase3XPublishingAdapter,
  NamedHumanXInteractionAdapter,
  PublicationPolicyError,
  evaluateRights,
  type ContentCategory,
  type HumanXInteractionInput,
  type XInteractionWatchReadAdapter,
  type XPostId,
  type XUserId,
} from '@x-harness/content-os';
import {
  completeCubelicPublicationJob,
  appendCubelicAudit,
  claimCubelicPublicationJob,
  checkCubelicPublicationRate,
  createCubelicInertDraft,
  createCubelicPublicationJob,
  failCubelicPublicationJob,
  expireCubelicOperationWindowAndStop,
  getCubelicDraft,
  getCubelicEmergencyStop,
  getCubelicEvent,
  getCubelicMedia,
  getCubelicMediaObject,
  getCubelicOperationWindow,
  getCubelicPublicationJobByIdempotencyKey,
  getXAccountById,
  incrementApiUsage,
  listDueCubelicPublicationJobs,
} from '@x-harness/db';
import { XApiError, XClient } from '@x-harness/x-sdk';
import type { Env } from '../index.js';
import { MEDIA_SIZE_LIMITS } from './media-delivery.js';
import {
  isNamedHumanInteractionEnabled,
  isPhase3MediaDeliveryEnabled,
  isPhase3PublicationEnabled,
  isStagingFakeDelivery,
} from './safety.js';

export type CubelicXAdapterFactory = (
  db: D1Database,
  xHarnessAccountId: string,
) => Phase1XPublishingAdapter;

export const buildCubelicXAdapter: CubelicXAdapterFactory = (db, xHarnessAccountId) => {
  return new Phase1XPublishingAdapter((input) => createCubelicInertDraft(db, xHarnessAccountId, input));
};

export async function isCubelicPublicationStopped(db: D1Database, at = Date.now()): Promise<boolean> {
  const operationWindow = await getCubelicOperationWindow(db, at);
  if (operationWindow) {
    if (!operationWindow.active) await expireCubelicOperationWindowAndStop(db, at);
    return true;
  }
  return getCubelicEmergencyStop(db);
}

export type CubelicPhase3AdapterFactory = (
  env: Env['Bindings'],
  operatorId: string,
) => Phase3XPublishingAdapter;

export type CubelicHumanInteractionAdapterFactory = (
  env: Env['Bindings'],
  operatorId: string,
) => NamedHumanXInteractionAdapter;

function buildXClient(account: {
  consumer_key: string | null;
  consumer_secret: string | null;
  access_token: string;
  access_token_secret: string | null;
}): XClient {
  return account.consumer_key && account.consumer_secret && account.access_token_secret
    ? new XClient({
        type: 'oauth1',
        consumerKey: account.consumer_key,
        consumerSecret: account.consumer_secret,
        accessToken: account.access_token,
        accessTokenSecret: account.access_token_secret,
      })
    : new XClient(account.access_token);
}

async function configuredXClient(env: Env['Bindings']): Promise<{
  account: NonNullable<Awaited<ReturnType<typeof getXAccountById>>>;
  client: XClient;
}> {
  const accountId = env.X_HARNESS_ACCOUNT_ID;
  if (!accountId || accountId === 'SET_AFTER_ACCOUNT_SETUP') {
    throw new PublicationPolicyError(
      'x_harness_account_not_configured',
      'X Harness account mapping is not configured',
    );
  }
  const account = await getXAccountById(
    env.DB,
    accountId,
    env.CREDENTIAL_ENCRYPTION_KEY,
  );
  if (!account) {
    throw new PublicationPolicyError(
      'x_account_not_found',
      'Configured X account was not found',
    );
  }
  return { account, client: buildXClient(account) };
}

export function buildInteractionWatchReadAdapter(
  env: Env['Bindings'],
): XInteractionWatchReadAdapter {
  if (
    env.ENVIRONMENT === 'staging'
    && env.X_INTERACTION_WATCH_SMOKE_MODE === 'true'
  ) {
    return {
      async verifyTargetUsername(username) {
        if (username !== 'x_harness_watch_smoke') {
          throw new PublicationPolicyError(
            'interaction_watch_smoke_target_invalid',
            'Staging watch smoke accepts only its synthetic target',
          );
        }
        return {
          targetUserId: '9900000000000000100' as XUserId,
          verifiedUsername: username,
        };
      },
      async discoverOriginalPosts() {
        return [{
          postId: '9900000000000000101' as XPostId,
          authorId: '9900000000000000100' as XUserId,
          createdAt: '2026-07-24T00:00:00.000Z',
          referencedTypes: [],
        }];
      },
    };
  }
  return {
    async verifyTargetUsername(username) {
      const { account, client } = await configuredXClient(env);
      const user = await client.getUserByUsername(username);
      await incrementApiUsage(env.DB, account.id, 'get_user_by_username');
      if (user.username.toLowerCase() !== username.toLowerCase()) {
        throw new PublicationPolicyError(
          'interaction_watch_identity_mismatch',
          'X returned a different username than the requested watch target',
        );
      }
      return {
        targetUserId: user.id as XUserId,
        verifiedUsername: user.username,
      };
    },
    async discoverOriginalPosts({ registration, sincePostId }) {
      const { account, client } = await configuredXClient(env);
      const response = await client.getUserTweets(
        registration.targetUserId,
        10,
        undefined,
        sincePostId ?? undefined,
      );
      await incrementApiUsage(env.DB, account.id, 'get_user_tweets');
      return (response.data ?? [])
        .filter((post) => post.author_id === registration.targetUserId)
        .filter((post) => Boolean(post.created_at))
        .map((post) => ({
          postId: post.id as XPostId,
          authorId: post.author_id as XUserId,
          createdAt: post.created_at!,
          referencedTypes: (post.referenced_tweets ?? [])
            .map((reference) => reference.type)
            .filter((type): type is 'replied_to' | 'quoted' | 'retweeted' => (
              type === 'replied_to' || type === 'quoted' || type === 'retweeted'
            )),
        }));
    },
  };
}

export const buildCubelicHumanInteractionAdapter: CubelicHumanInteractionAdapterFactory = (env, operatorId) => {
  return new NamedHumanXInteractionAdapter({
    enabled: isNamedHumanInteractionEnabled(env),
    operatorId,
    isEmergencyStopped: () => isCubelicPublicationStopped(env.DB),
    write: async (input) => deliverHumanInteraction(env, input),
  });
};

async function deliverHumanInteraction(
  env: Env['Bindings'],
  input: HumanXInteractionInput,
): Promise<{ status: 'completed'; externalId?: string }> {
  if (isStagingFakeDelivery(env)) {
    return {
      status: 'completed',
      ...(['reply', 'dm_reply'].includes(input.kind)
        ? { externalId: `staging_fake_${input.operationId}` }
        : {}),
    };
  }
  const accountId = env.X_HARNESS_ACCOUNT_ID;
  if (!accountId || accountId === 'SET_AFTER_ACCOUNT_SETUP') {
    throw new PublicationPolicyError(
      'x_harness_account_not_configured',
      'X Harness account mapping is not configured',
    );
  }
  const account = await getXAccountById(env.DB, accountId, env.CREDENTIAL_ENCRYPTION_KEY);
  if (!account) throw new PublicationPolicyError('x_account_not_found', 'Configured X account was not found');
  const client = buildXClient(account);
  try {
    switch (input.kind) {
      case 'reply': {
        const tweet = await client.createTweet({
          text: input.text,
          reply: { in_reply_to_tweet_id: input.targetPostId },
        });
        await incrementApiUsage(env.DB, account.id, 'create_reply');
        return { status: 'completed', externalId: tweet.id };
      }
      case 'dm_reply': {
        const message = await client.sendDmToConversation(input.conversationId, input.text);
        await incrementApiUsage(env.DB, account.id, 'send_dm_reply');
        return { status: 'completed', externalId: message.dm_event_id };
      }
      case 'like':
        await client.likeTweet(account.x_user_id, input.targetPostId);
        await incrementApiUsage(env.DB, account.id, 'like_tweet');
        return { status: 'completed' };
      case 'follow':
        await client.follow(account.x_user_id, input.targetUserId);
        await incrementApiUsage(env.DB, account.id, 'follow_user');
        return { status: 'completed' };
      case 'unfollow':
        await client.unfollow(account.x_user_id, input.targetUserId);
        await incrementApiUsage(env.DB, account.id, 'unfollow_user');
        return { status: 'completed' };
    }
  } catch (error) {
    if (error instanceof XApiError && error.status >= 400 && error.status < 500) {
      throw new PublicationPolicyError(
        'interaction_delivery_rejected',
        'X definitively rejected the interaction request',
      );
    }
    throw error;
  }
}

function schedulePolicies(value: string | undefined): Array<{ category: ContentCategory; templateId: string }> {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    const [category, templateId, ...rest] = item.split(':');
    if (!category || !templateId || rest.length > 0) {
      throw new PublicationPolicyError('schedule_policy_invalid', 'Scheduling policy must be category:template_id');
    }
    return { category: category as ContentCategory, templateId };
  });
}

function isOperationWindowPublicationLockError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('operation window blocks publication');
}

export const buildCubelicPhase3XAdapter: CubelicPhase3AdapterFactory = (env, operatorId) => {
  const now = () => new Date();
  const accountId = env.X_HARNESS_ACCOUNT_ID;
  if (!accountId || accountId === 'SET_AFTER_ACCOUNT_SETUP') {
    throw new PublicationPolicyError('x_harness_account_not_configured', 'X Harness account mapping is not configured');
  }

  return new Phase3XPublishingAdapter({
    enabled: isPhase3PublicationEnabled(env),
    mediaDeliveryEnabled: isPhase3MediaDeliveryEnabled(env),
    allowedSchedulePolicies: schedulePolicies(env.CUBELIC_PHASE3_SCHEDULE_POLICIES),
    isEmergencyStopped: () => isCubelicPublicationStopped(env.DB),
    checkRateLimit: (input, operation) => checkCubelicPublicationRate(env.DB, {
      effectiveAt: operation === 'schedule' && 'scheduledAt' in input
        ? input.scheduledAt
        : now().toISOString(),
    }),
    scheduleWriter: async (input) => {
      await loadMediaDeliveryObjects(env, input.mediaAssetIds);
      let job: Awaited<ReturnType<typeof createCubelicPublicationJob>>;
      try {
        job = await createCubelicPublicationJob(env.DB, {
          draftId: input.draftId,
          operation: 'schedule',
          authorizationKind: input.authorization.kind,
          policyId: input.authorization.policyId,
          authorizedBy: input.approvedBy,
          authorizedAt: input.authorization.approvedAt,
          scheduledAt: input.scheduledAt,
          idempotencyKey: `${input.idempotencyKey}:schedule:${input.scheduledAt}`,
        }, {
          actor: 'human',
          action: 'publication.scheduled',
          entityType: 'publication_job',
          entityId: input.draftId,
          before: {},
          after: {
            draftId: input.draftId,
            category: input.category,
            templateId: input.templateId,
            scheduledAt: input.scheduledAt,
            policyId: input.authorization.policyId,
          },
          correlationId: `publication:${input.idempotencyKey}`,
        });
      } catch (error) {
        if (isOperationWindowPublicationLockError(error)) {
          throw new PublicationPolicyError('emergency_stop_active', 'Content ingestion operation window blocks X scheduling');
        }
        throw error;
      }
      return { jobId: job.jobId, status: 'scheduled', scheduledAt: input.scheduledAt };
    },
    publishWriter: async (input) => {
      await loadMediaDeliveryObjects(env, input.mediaAssetIds);
      const idempotencyKey = `${input.idempotencyKey}:publish`;
      const existing = await getCubelicPublicationJobByIdempotencyKey(env.DB, idempotencyKey);
      if (existing?.status === 'published' && existing.postId && existing.publishedAt) {
        return { postId: existing.postId, status: 'published', publishedAt: existing.publishedAt };
      }
      if (existing) {
        throw new PublicationPolicyError(
          'publication_outcome_unknown',
          'A previous publication attempt exists and requires human reconciliation',
        );
      }
      if (!isStagingFakeDelivery(env) && !(await getXAccountById(env.DB, accountId, env.CREDENTIAL_ENCRYPTION_KEY))) {
        throw new PublicationPolicyError('x_account_not_found', 'Configured X account was not found');
      }
      let job: Awaited<ReturnType<typeof createCubelicPublicationJob>>;
      try {
        job = await createCubelicPublicationJob(env.DB, {
          draftId: input.draftId,
          operation: 'publish',
          authorizationKind: 'human_individual',
          authorizedBy: operatorId,
          authorizedAt: input.authorization.kind === 'human_individual'
            ? input.authorization.authorizedAt
            : input.approvedAt,
          idempotencyKey,
        }, {
          actor: 'human',
          action: 'publication.started',
          entityType: 'publication_job',
          entityId: input.draftId,
          before: {},
          after: { draftId: input.draftId, category: input.category },
          correlationId: `publication:${input.idempotencyKey}`,
        });
      } catch (error) {
        if (isOperationWindowPublicationLockError(error)) {
          throw new PublicationPolicyError('emergency_stop_active', 'Content ingestion operation window blocks X publication');
        }
        throw error;
      }
      try {
        const tweet = await deliverPostForRuntime(env, accountId, input.text, input.mediaAssetIds, {
          jobId: job.jobId,
          actor: 'human',
          correlationId: `publication:${input.idempotencyKey}`,
        });
        const publishedAt = now().toISOString();
        await completeCubelicPublicationJob(env.DB, {
          jobId: job.jobId,
          postId: tweet.postId,
          publishedAt,
        }, {
          actor: 'human',
          action: 'publication.completed',
          entityType: 'publication_job',
          entityId: job.jobId,
          before: { status: 'publishing' },
          after: { status: 'published', postId: tweet.postId, publishedAt },
          correlationId: `publication:${input.idempotencyKey}`,
        });
        return { postId: tweet.postId, status: 'published', publishedAt };
      } catch (error) {
        if (error instanceof PublicationMediaOutcomeUnknownError) {
          await appendCubelicAudit(env.DB, {
            actor: 'human',
            action: 'publication.media_outcome_unknown',
            entityType: 'publication_job',
            entityId: job.jobId,
            before: { status: 'publishing' },
            after: {
              status: 'publishing',
              reconciliationRequired: true,
              ...(error.evidence ?? {}),
            },
            correlationId: `publication:${input.idempotencyKey}`,
          });
          throw new PublicationPolicyError(
            'media_upload_outcome_unknown',
            'X media upload outcome is unknown and requires reconciliation or expiry evidence',
          );
        }
        if (
          error instanceof PublicationDeliveryNotAttemptedError
          || error instanceof PublicationCreateRejectedError
        ) {
          await failCubelicPublicationJob(env.DB, {
            jobId: job.jobId,
            failureCode: error.failureCode,
          }, {
            actor: 'human',
            action: 'publication.failed',
            entityType: 'publication_job',
            entityId: job.jobId,
            before: { status: 'publishing' },
            after: { status: 'failed', failureCode: error.failureCode },
            correlationId: `publication:${input.idempotencyKey}`,
          });
          throw new PublicationPolicyError(error.failureCode, error.message);
        }
        await appendCubelicAudit(env.DB, {
          actor: 'human',
          action: 'publication.outcome_unknown',
          entityType: 'publication_job',
          entityId: job.jobId,
          before: { status: 'publishing' },
          after: { status: 'publishing', reconciliationRequired: true },
          correlationId: `publication:${input.idempotencyKey}`,
        });
        throw new PublicationPolicyError(
          'publication_outcome_unknown',
          'X publication outcome is unknown and requires human reconciliation',
        );
      }
    },
  });
};

export async function processDueCubelicPublications(
  env: Env['Bindings'],
  at = new Date(),
  deliverPost: (
    env: Env['Bindings'],
    accountId: string,
    text: string,
    mediaAssetIds: string[],
    context: { jobId: string; actor: 'system' | 'human'; correlationId: string },
  ) => Promise<{ postId: string }> = deliverPostForRuntime,
): Promise<void> {
  if (
    !isPhase3PublicationEnabled(env)
    || env.GLOBAL_PUBLISHING_DISABLED !== 'false'
    || await isCubelicPublicationStopped(env.DB, at.getTime())
  ) return;
  const accountId = env.X_HARNESS_ACCOUNT_ID;
  if (!accountId || accountId === 'SET_AFTER_ACCOUNT_SETUP') return;
  let allowedPolicies: Set<string>;
  try {
    const parsedPolicies = schedulePolicies(env.CUBELIC_PHASE3_SCHEDULE_POLICIES);
    if (parsedPolicies.length === 0) return;
    allowedPolicies = new Set(parsedPolicies.map(({ category, templateId }) => `${category}:${templateId}`));
  } catch {
    return;
  }
  const due = await listDueCubelicPublicationJobs(env.DB, at.toISOString());
  for (const job of due) {
    const correlationId = `publication:${job.idempotencyKey}`;
    const currentDraft = await getCubelicDraft(env.DB, job.draftId);
    if (
      !currentDraft
      || !job.policyId
      || job.policyId !== currentDraft.template_id
      || !allowedPolicies.has(`${currentDraft.category}:${currentDraft.template_id}`)
    ) continue;
    let claimed;
    try {
      claimed = await claimCubelicPublicationJob(env.DB, job.jobId, {
        actor: 'system',
        action: 'publication.claimed',
        entityType: 'publication_job',
        entityId: job.jobId,
        before: { status: 'scheduled' },
        after: { status: 'publishing' },
        correlationId,
      }, at.toISOString());
    } catch (error) {
      if (isOperationWindowPublicationLockError(error)) return;
      throw error;
    }
    if (!claimed) continue;
    let draft;
    try {
      if (await isCubelicPublicationStopped(env.DB)) {
        throw new PublicationPolicyError('emergency_stop_active', 'Emergency stop became active');
      }
      draft = await getCubelicDraft(env.DB, job.draftId);
      if (!draft || !['approved', 'handed_off'].includes(draft.approval_status)) {
        throw new PublicationPolicyError('human_approval_required', 'Approved draft is no longer available');
      }
      await loadMediaDeliveryObjects(env, draft.media_asset_ids);
    } catch (error) {
      if (!(await isCubelicPublicationStopped(env.DB))) {
        await failCubelicPublicationJob(env.DB, {
          jobId: job.jobId,
          failureCode: error instanceof PublicationPolicyError ? error.code : 'publication_validation_failed',
        }, {
          actor: 'system',
          action: 'publication.failed',
          entityType: 'publication_job',
          entityId: job.jobId,
          before: { status: 'publishing' },
          after: {
            status: 'failed',
            failureCode: error instanceof PublicationPolicyError ? error.code : 'publication_validation_failed',
          },
          correlationId,
        });
      }
      continue;
    }

    try {
      const delivered = await deliverPost(env, accountId, draft.text, draft.media_asset_ids, {
        jobId: job.jobId,
        actor: 'system',
        correlationId,
      });
      const publishedAt = new Date().toISOString();
      await completeCubelicPublicationJob(env.DB, {
        jobId: job.jobId,
        postId: delivered.postId,
        publishedAt,
      }, {
        actor: 'system',
        action: 'publication.completed',
        entityType: 'publication_job',
        entityId: job.jobId,
        before: { status: 'publishing' },
        after: { status: 'published', postId: delivered.postId, publishedAt },
        correlationId,
      });
    } catch (error) {
      if (error instanceof PublicationMediaOutcomeUnknownError) {
        await appendCubelicAudit(env.DB, {
          actor: 'system',
          action: 'publication.media_outcome_unknown',
          entityType: 'publication_job',
          entityId: job.jobId,
          before: { status: 'publishing' },
          after: {
            status: 'publishing',
            reconciliationRequired: true,
            ...(error.evidence ?? {}),
          },
          correlationId,
        });
        console.error('cubelic_scheduled_media_outcome_unknown', {
          job_id: job.jobId,
          error_code: 'media_upload_outcome_unknown',
        });
        continue;
      }
      if (
        error instanceof PublicationDeliveryNotAttemptedError
        || error instanceof PublicationCreateRejectedError
      ) {
        await failCubelicPublicationJob(env.DB, {
          jobId: job.jobId,
          failureCode: error.failureCode,
        }, {
          actor: 'system',
          action: 'publication.failed',
          entityType: 'publication_job',
          entityId: job.jobId,
          before: { status: 'publishing' },
          after: { status: 'failed', failureCode: error.failureCode },
          correlationId,
        });
        continue;
      }
      await appendCubelicAudit(env.DB, {
        actor: 'system',
        action: 'publication.outcome_unknown',
        entityType: 'publication_job',
        entityId: job.jobId,
        before: { status: 'publishing' },
        after: { status: 'publishing', reconciliationRequired: true },
        correlationId,
      });
      console.error('cubelic_scheduled_publication_outcome_unknown', {
        job_id: job.jobId,
        error_code: 'publication_outcome_unknown',
        error_type: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}

interface DeliveryMediaObject {
  assetId: string;
  r2Key: string;
  sha256: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'video/mp4';
  byteSize: number;
}

function sha256Hex(checksum: ArrayBuffer | undefined): string | null {
  return checksum
    ? Array.from(new Uint8Array(checksum), (byte) => byte.toString(16).padStart(2, '0')).join('')
    : null;
}

export class PublicationDeliveryNotAttemptedError extends Error {
  readonly failureCode: string;

  constructor(failureCode: string, cause: unknown) {
    super('Publication delivery failed before the X post request was attempted', { cause });
    this.name = 'PublicationDeliveryNotAttemptedError';
    this.failureCode = failureCode;
  }
}

export class PublicationCreateRejectedError extends Error {
  readonly failureCode = 'x_post_rejected';

  constructor(cause: XApiError) {
    super('X definitively rejected the create-post request', { cause });
    this.name = 'PublicationCreateRejectedError';
  }
}

export class PublicationMediaOutcomeUnknownError extends Error {
  constructor(
    cause: unknown,
    readonly evidence?: { assetId: string; mediaId: string },
  ) {
    super('X media upload outcome is unknown and requires reconciliation or expiry evidence', { cause });
    this.name = 'PublicationMediaOutcomeUnknownError';
  }
}

async function assertPublicationNotStopped(env: Env['Bindings']): Promise<void> {
  if (await isCubelicPublicationStopped(env.DB)) {
    throw new PublicationPolicyError('emergency_stop_active', 'Emergency stop became active before the next external mutation');
  }
}

async function loadMediaDeliveryObjects(
  env: Env['Bindings'],
  mediaAssetIds: string[],
): Promise<DeliveryMediaObject[]> {
  if (mediaAssetIds.length === 0) return [];
  if (!isPhase3MediaDeliveryEnabled(env)) {
    throw new PublicationPolicyError('media_delivery_disabled', 'Media delivery capability is disabled');
  }
  if (!env.CUBELIC_MEDIA) {
    throw new PublicationPolicyError('media_storage_not_configured', 'Media storage is not configured');
  }
  if (new Set(mediaAssetIds).size !== mediaAssetIds.length) {
    throw new PublicationPolicyError('media_set_invalid', 'Media asset ids must be unique');
  }
  const deliveryObjects: DeliveryMediaObject[] = [];
  for (const assetId of mediaAssetIds) {
    const [asset, mediaObject] = await Promise.all([
      getCubelicMedia(env.DB, assetId),
      getCubelicMediaObject(env.DB, assetId),
    ]);
    if (!asset || !mediaObject || asset.sha256 !== mediaObject.sha256 || asset.status !== 'approved_for_draft') {
      throw new PublicationPolicyError('media_not_staged', 'Every media asset must be validated and staged');
    }
    if (mediaObject.byteSize > MEDIA_SIZE_LIMITS[mediaObject.contentType]) {
      throw new PublicationPolicyError('media_size_invalid', 'Staged media exceeds the allowlisted limit for its type');
    }
    const event = await getCubelicEvent(env.DB, asset.event_id);
    if (!event || !evaluateRights(event, asset).passed) {
      throw new PublicationPolicyError('media_rights_not_approved', 'Media rights and privacy review must still pass');
    }
    const stored = await env.CUBELIC_MEDIA.head(mediaObject.r2Key);
    if (
      !stored
      || stored.size !== mediaObject.byteSize
      || sha256Hex(stored.checksums.sha256) !== mediaObject.sha256
      || stored.httpMetadata?.contentType !== mediaObject.contentType
      || stored.customMetadata?.assetId !== mediaObject.assetId
      || stored.customMetadata?.sha256 !== mediaObject.sha256
    ) {
      throw new PublicationPolicyError('media_storage_inconsistent', 'R2 media metadata does not match the staged record');
    }
    deliveryObjects.push(mediaObject);
  }
  const images = deliveryObjects.filter((item) => item.contentType.startsWith('image/') && item.contentType !== 'image/gif');
  const motion = deliveryObjects.filter((item) => item.contentType === 'image/gif' || item.contentType === 'video/mp4');
  if (motion.length > 1 || (motion.length === 1 && deliveryObjects.length !== 1) || images.length > 4) {
    throw new PublicationPolicyError('media_set_invalid', 'A post may contain up to four images or one GIF/video');
  }
  return deliveryObjects;
}

async function deliverPostForRuntime(
  env: Env['Bindings'],
  accountId: string,
  text: string,
  mediaAssetIds: string[],
  context: { jobId: string; actor: 'system' | 'human'; correlationId: string },
): Promise<{ postId: string }> {
  if (isStagingFakeDelivery(env)) {
    if (mediaAssetIds.length > 0) {
      try {
        return await deliverPostToStagingFake(env, mediaAssetIds, context);
      } catch (error) {
        throw new PublicationDeliveryNotAttemptedError(
          error instanceof PublicationPolicyError ? error.code : 'staging_media_validation_failed',
          error,
        );
      }
    }
    return { postId: `staging_fake_${crypto.randomUUID()}` };
  }
  return deliverPostToX(env, accountId, text, mediaAssetIds, context);
}

async function deliverPostToStagingFake(
  env: Env['Bindings'],
  mediaAssetIds: string[],
  context: { jobId: string; actor: 'system' | 'human'; correlationId: string },
): Promise<{ postId: string }> {
  const mediaObjects = await loadMediaDeliveryObjects(env, mediaAssetIds);
  for (const media of mediaObjects) {
    await assertPublicationNotStopped(env);
    await appendCubelicAudit(env.DB, {
      actor: context.actor,
      action: 'publication.media_upload_started',
      entityType: 'publication_job',
      entityId: context.jobId,
      before: {},
      after: { assetId: media.assetId, contentType: media.contentType, byteSize: media.byteSize, stagingFake: true },
      correlationId: context.correlationId,
    });
    if (!env.CUBELIC_MEDIA) {
      throw new PublicationPolicyError('media_storage_not_configured', 'Media storage is not configured');
    }
    const chunkSize = 4 * 1024 * 1024;
    for (let offset = 0; offset < media.byteSize; offset += chunkSize) {
      await assertPublicationNotStopped(env);
      const length = Math.min(chunkSize, media.byteSize - offset);
      const part = await env.CUBELIC_MEDIA.get(media.r2Key, { range: { offset, length } });
      if (!part || (await part.arrayBuffer()).byteLength !== length) {
        throw new PublicationPolicyError('media_storage_inconsistent', 'Staging fake media read did not match the immutable object');
      }
    }
    await appendCubelicAudit(env.DB, {
      actor: context.actor,
      action: 'publication.media_uploaded',
      entityType: 'publication_job',
      entityId: context.jobId,
      before: {},
      after: {
        assetId: media.assetId,
        contentType: media.contentType,
        byteSize: media.byteSize,
        xMediaId: `staging_fake_media_${crypto.randomUUID()}`,
        stagingFake: true,
      },
      correlationId: context.correlationId,
    });
  }
  await assertPublicationNotStopped(env);
  return { postId: `staging_fake_${crypto.randomUUID()}` };
}

async function deliverPostToX(
  env: Env['Bindings'],
  accountId: string,
  text: string,
  mediaAssetIds: string[],
  context: { jobId: string; actor: 'system' | 'human'; correlationId: string },
): Promise<{ postId: string }> {
  let account: NonNullable<Awaited<ReturnType<typeof getXAccountById>>>;
  let client: ReturnType<typeof buildXClient>;
  const mediaIds: string[] = [];
  let unpersistedMediaEvidence: { assetId: string; mediaId: string } | null = null;
  try {
    const loadedAccount = await getXAccountById(env.DB, accountId, env.CREDENTIAL_ENCRYPTION_KEY);
    if (!loadedAccount) throw new PublicationPolicyError('x_account_not_found', 'Configured X account was not found');
    account = loadedAccount;
    client = buildXClient(account);
    const deliveryObjects = await loadMediaDeliveryObjects(env, mediaAssetIds);
    for (const media of deliveryObjects) {
      await assertPublicationNotStopped(env);
      if (!env.CUBELIC_MEDIA) {
        throw new PublicationPolicyError('media_storage_not_configured', 'Media storage is not configured');
      }
      await appendCubelicAudit(env.DB, {
        actor: context.actor,
        action: 'publication.media_upload_started',
        entityType: 'publication_job',
        entityId: context.jobId,
        before: {},
        after: {
          assetId: media.assetId,
          contentType: media.contentType,
          byteSize: media.byteSize,
        },
        correlationId: context.correlationId,
      });
      let mediaId: string;
      if (media.contentType === 'image/jpeg' || media.contentType === 'image/png' || media.contentType === 'image/webp') {
        const stored = await env.CUBELIC_MEDIA.get(media.r2Key);
        if (!stored || stored.size !== media.byteSize) {
          throw new PublicationPolicyError('media_storage_inconsistent', 'R2 media body is unavailable');
        }
        try {
          mediaId = await client.uploadMedia(await stored.arrayBuffer(), media.contentType, 'tweet_image');
        } catch (error) {
          if (error instanceof XApiError && error.status >= 400 && error.status < 500) {
            throw new PublicationDeliveryNotAttemptedError('x_media_rejected', error);
          }
          throw new PublicationMediaOutcomeUnknownError(error);
        }
      } else {
        try {
          mediaId = await client.uploadMediaChunks({
            mediaType: media.contentType,
            mediaCategory: media.contentType === 'image/gif' ? 'tweet_gif' : 'tweet_video',
            totalBytes: media.byteSize,
            readChunk: async (offset, length) => {
              await assertPublicationNotStopped(env);
              const part = await env.CUBELIC_MEDIA!.get(media.r2Key, { range: { offset, length } });
              if (!part) throw new PublicationPolicyError('media_storage_inconsistent', 'R2 media chunk is unavailable');
              const bytes = await part.arrayBuffer();
              if (bytes.byteLength !== length) {
                throw new PublicationPolicyError('media_storage_inconsistent', 'R2 media chunk length differs');
              }
              return bytes;
            },
          });
        } catch (error) {
          if (error instanceof PublicationPolicyError) throw error;
          if (error instanceof XApiError && error.status >= 400 && error.status < 500) {
            throw new PublicationDeliveryNotAttemptedError('x_media_rejected', error);
          }
          throw new PublicationMediaOutcomeUnknownError(error);
        }
      }
      mediaIds.push(mediaId);
      unpersistedMediaEvidence = { assetId: media.assetId, mediaId };
      await appendCubelicAudit(env.DB, {
        actor: context.actor,
        action: 'publication.media_uploaded',
        entityType: 'publication_job',
        entityId: context.jobId,
        before: {},
        after: {
          assetId: media.assetId,
          contentType: media.contentType,
          byteSize: media.byteSize,
          xMediaId: mediaId,
        },
        correlationId: context.correlationId,
      });
      unpersistedMediaEvidence = null;
      await incrementApiUsage(env.DB, account.id, 'upload_media');
    }
  } catch (error) {
    if (unpersistedMediaEvidence) {
      throw new PublicationMediaOutcomeUnknownError(error, unpersistedMediaEvidence);
    }
    if (
      error instanceof PublicationDeliveryNotAttemptedError
      || error instanceof PublicationMediaOutcomeUnknownError
    ) throw error;
    throw new PublicationDeliveryNotAttemptedError(
      error instanceof PublicationPolicyError ? error.code : 'publication_delivery_failed',
      error,
    );
  }
  try {
    await assertPublicationNotStopped(env);
  } catch (error) {
    throw new PublicationDeliveryNotAttemptedError(
      error instanceof PublicationPolicyError ? error.code : 'emergency_stop_check_failed',
      error,
    );
  }
  let tweet: { id: string; text: string };
  try {
    tweet = await client.createTweet({
      text,
      ...(mediaIds.length > 0 ? { media: { media_ids: mediaIds } } : {}),
    });
  } catch (error) {
    if (error instanceof XApiError && error.status >= 400 && error.status < 500) {
      throw new PublicationCreateRejectedError(error);
    }
    throw error;
  }
  await incrementApiUsage(env.DB, account.id, 'create_tweet');
  return { postId: tweet.id };
}
