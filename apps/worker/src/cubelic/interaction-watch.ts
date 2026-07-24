import type {
  InteractionWatchRegistration,
  InteractionCandidateId,
  XInteractionWatchReadAdapter,
  XOperatorId,
  XPostId,
  XUserId,
} from '@x-harness/content-os';
import {
  appendCubelicAudit,
  createInteractionCandidate,
  listInteractionWatches,
  markInteractionWatchPolled,
  updateInteractionWatchCursor,
  type InteractionWatchRecord,
} from '@x-harness/db';
import type { Env } from '../index.js';
import {
  buildInteractionWatchReadAdapter,
  isCubelicPublicationStopped,
} from './adapter.js';
import { isInteractionWatchEnabled } from './safety.js';

const AUTOMATIC_POLL_INTERVAL_MS = 15 * 60_000;

function postIdOrder(left: string, right: string): number {
  return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
}

export async function pollInteractionWatch(
  env: Env['Bindings'],
  watch: InteractionWatchRecord,
  reader: XInteractionWatchReadAdapter,
  correlationId: string,
): Promise<{ discovered: number }> {
  const registration: InteractionWatchRegistration = {
    watchId: watch.watchId as InteractionWatchRegistration['watchId'],
    targetUserId: watch.targetUserId as XUserId,
    verifiedUsername: watch.targetUsername,
    verifiedAt: watch.verifiedAt,
    registeredBy: watch.createdBy as XOperatorId,
  };
  const posts = await reader.discoverOriginalPosts({
    registration,
    sincePostId: watch.lastSeenPostId as XPostId | null,
  });
  const authoredPosts = posts
    .filter((post) => post.authorId === registration.targetUserId)
    .filter((post) => /^[1-9][0-9]{4,29}$/.test(post.postId))
    .filter((post) => !Number.isNaN(Date.parse(post.createdAt)))
    .sort((left, right) => postIdOrder(left.postId, right.postId));
  const originals = authoredPosts.filter(
    (post) => !post.referencedTypes.some(
      (type) => type === 'replied_to' || type === 'retweeted',
    ),
  );
  let discovered = 0;
  for (const post of originals) {
    const candidateId = `candidate_${crypto.randomUUID()}` as InteractionCandidateId;
    if (await createInteractionCandidate(env.DB, {
      candidateId,
      watchId: watch.watchId,
      postId: post.postId,
      authorId: post.authorId,
      postCreatedAt: new Date(post.createdAt).toISOString(),
    }, {
      actor: 'system',
      action: 'interaction_candidate.detected',
      entityType: 'interaction_candidate',
      entityId: candidateId,
      before: {},
      after: { status: 'pending', watchId: watch.watchId },
      correlationId,
    })) {
      discovered += 1;
    }
  }
  const newestPostId = authoredPosts.at(-1)?.postId;
  if (newestPostId && newestPostId !== watch.lastSeenPostId) {
    await updateInteractionWatchCursor(
      env.DB,
      watch.watchId,
      newestPostId,
      {
        actor: 'system',
        action: 'interaction_watch.cursor_advanced',
        entityType: 'interaction_watch',
        entityId: watch.watchId,
        before: { cursorPresent: watch.lastSeenPostId !== null },
        after: { cursorPresent: true },
        correlationId,
      },
    );
  }
  const polledAt = new Date().toISOString();
  await markInteractionWatchPolled(env.DB, watch.watchId, polledAt, {
    actor: 'system',
    action: 'interaction_watch.polled',
    entityType: 'interaction_watch',
    entityId: watch.watchId,
    before: { previouslyPolled: watch.lastPolledAt !== null },
    after: { polled: true, discovered },
    correlationId,
  });
  return { discovered };
}

export async function processInteractionWatches(
  env: Env['Bindings'],
  injectedReader?: XInteractionWatchReadAdapter,
): Promise<{ discovered: number; watchesPolled: number }> {
  if (
    !isInteractionWatchEnabled(env)
    || env.GLOBAL_PUBLISHING_DISABLED !== 'false'
    || await isCubelicPublicationStopped(env.DB)
  ) {
    return { discovered: 0, watchesPolled: 0 };
  }
  const reader = injectedReader ?? buildInteractionWatchReadAdapter(env);
  const watches = (await listInteractionWatches(env.DB))
    .filter((watch) => watch.status === 'active')
    .filter((watch) => (
      watch.lastPolledAt === null
      || Date.now() - Date.parse(watch.lastPolledAt) >= AUTOMATIC_POLL_INTERVAL_MS
    ));
  let discovered = 0;
  let watchesPolled = 0;
  for (const watch of watches) {
    const correlationId = `interaction-watch:${crypto.randomUUID()}`;
    try {
      const result = await pollInteractionWatch(
        env,
        watch,
        reader,
        correlationId,
      );
      discovered += result.discovered;
      watchesPolled += 1;
    } catch {
      await appendCubelicAudit(env.DB, {
        actor: 'system',
        action: 'interaction_watch.poll_failed',
        entityType: 'interaction_watch',
        entityId: watch.watchId,
        before: {},
        after: { retryAllowed: true },
        correlationId,
      });
    }
  }
  return { discovered, watchesPolled };
}
