import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const baseUrl = process.env.STAGING_WORKER_URL?.replace(/\/$/u, '');
const staffService = process.env.STAGING_STAFF_KEYCHAIN_SERVICE;
const approvalService = process.env.STAGING_HUMAN_APPROVAL_KEYCHAIN_SERVICE;
const operatorId = process.env.STAGING_OPERATOR_ID;

if (!baseUrl || !staffService || !approvalService || !operatorId) {
  console.error(
    'Set STAGING_WORKER_URL, STAGING_STAFF_KEYCHAIN_SERVICE, and '
    + 'STAGING_HUMAN_APPROVAL_KEYCHAIN_SERVICE, and STAGING_OPERATOR_ID.',
  );
  process.exit(2);
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(operatorId)) {
  console.error('STAGING_OPERATOR_ID must be one D1 staff UUID.');
  process.exit(2);
}
const parsedBaseUrl = new URL(baseUrl);
if (parsedBaseUrl.protocol !== 'https:' || parsedBaseUrl.hostname !== 'x-harness-worker-staging.yoshihiro-fukiya.workers.dev') {
  console.error('Interaction smoke is restricted to the dedicated HTTPS staging Worker.');
  process.exit(2);
}

function keychainSecret(service) {
  try {
    const value = execFileSync(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (value.length < 32) throw new Error('secret is too short');
    return value;
  } catch {
    throw new Error(`Required macOS Keychain item is unavailable: ${service}`);
  }
}

const staffKey = keychainSecret(staffService);
const humanApprovalKey = keychainSecret(approvalService);
const baseHeaders = {
  Authorization: `Bearer ${staffKey}`,
  'X-Human-Approval-Key': humanApprovalKey,
  'content-type': 'application/json',
};

async function json(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...baseHeaders, ...init.headers },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

function canonicalApproval(request, operatorId) {
  switch (request.kind) {
    case 'reply':
      return JSON.stringify({
        kind: request.kind,
        operationId: request.operationId,
        approvalId: request.approvalId,
        approvedAt: request.approvedAt,
        targetPostId: request.targetPostId,
        text: request.text,
        inboundOrMentionAttested: request.inboundOrMentionAttested,
        operatorId,
      });
    case 'dm_reply':
      return JSON.stringify({
        kind: request.kind,
        operationId: request.operationId,
        approvalId: request.approvalId,
        approvedAt: request.approvedAt,
        conversationId: request.conversationId,
        inboundMessageId: request.inboundMessageId,
        text: request.text,
        recipientInitiated: request.recipientInitiated,
        operatorId,
      });
    case 'like':
      return JSON.stringify({
        kind: request.kind,
        operationId: request.operationId,
        approvalId: request.approvalId,
        approvedAt: request.approvedAt,
        targetPostId: request.targetPostId,
        operatorId,
      });
    case 'follow':
    case 'unfollow':
      return JSON.stringify({
        kind: request.kind,
        operationId: request.operationId,
        approvalId: request.approvalId,
        approvedAt: request.approvedAt,
        targetUserId: request.targetUserId,
        operatorId,
      });
  }
}

function approvalProof(request, operatorId) {
  const digest = createHash('sha256')
    .update(canonicalApproval(request, operatorId))
    .digest('hex');
  return createHmac('sha256', humanApprovalKey)
    .update(`interaction-approval:v1:${digest}:${operatorId}`)
    .digest('hex');
}

function requestBody(request) {
  const { kind: _kind, ...body } = request;
  return body;
}

async function executeInteraction(path, request, operatorId) {
  const result = await json(path, {
    method: 'POST',
    headers: { 'X-Interaction-Approval-Proof': approvalProof(request, operatorId) },
    body: JSON.stringify(requestBody(request)),
  });
  if (result.response.status !== 201 || result.body?.data?.status !== 'completed') {
    throw new Error(`${path} failed with HTTP ${result.response.status}`);
  }
}

let resumed = false;
let failure;
try {
  const resume = await json('/api/cubelic/admin/emergency-resume', {
    method: 'POST',
    body: '{}',
  });
  if (!resume.response.ok || resume.body?.data?.stopped !== false) {
    throw new Error(`Staging emergency resume failed with HTTP ${resume.response.status}`);
  }
  resumed = true;

  const runId = Date.now().toString(36);
  const approvedAt = new Date().toISOString();
  const cases = [
    ['/api/cubelic/interactions/reply', {
      kind: 'reply',
      operationId: `smoke_reply_${runId}`,
      approvalId: `smoke_approval_reply_${runId}`,
      approvedAt,
      targetPostId: `91${Date.now().toString().slice(-16)}`,
      text: 'Staging fake reply smoke test.',
      inboundOrMentionAttested: true,
    }],
    ['/api/cubelic/interactions/dm-reply', {
      kind: 'dm_reply',
      operationId: `smoke_dm_${runId}`,
      approvalId: `smoke_approval_dm_${runId}`,
      approvedAt,
      conversationId: `staging_smoke_${runId}`,
      inboundMessageId: `92${Date.now().toString().slice(-16)}`,
      text: 'Staging fake DM reply smoke test.',
      recipientInitiated: true,
    }],
    ['/api/cubelic/interactions/like', {
      kind: 'like',
      operationId: `smoke_like_${runId}`,
      approvalId: `smoke_approval_like_${runId}`,
      approvedAt,
      targetPostId: `93${Date.now().toString().slice(-16)}`,
    }],
    ['/api/cubelic/interactions/follow', {
      kind: 'follow',
      operationId: `smoke_follow_${runId}`,
      approvalId: `smoke_approval_follow_${runId}`,
      approvedAt,
      targetUserId: `94${Date.now().toString().slice(-16)}`,
    }],
    ['/api/cubelic/interactions/unfollow', {
      kind: 'unfollow',
      operationId: `smoke_unfollow_${runId}`,
      approvalId: `smoke_approval_unfollow_${runId}`,
      approvedAt,
      targetUserId: `95${Date.now().toString().slice(-16)}`,
    }],
  ];
  for (const [path, request] of cases) {
    await executeInteraction(path, request, operatorId);
  }

  const [replyPath, replyRequest] = cases[0];
  const replay = await json(replyPath, {
    method: 'POST',
    headers: { 'X-Interaction-Approval-Proof': approvalProof(replyRequest, operatorId) },
    body: JSON.stringify(requestBody(replyRequest)),
  });
  if (
    !replay.response.ok
    || replay.body?.data?.status !== 'completed'
    || replay.body?.data?.idempotentReplay !== true
  ) {
    throw new Error('Completed interaction replay was not idempotent');
  }

  const bulk = await json('/api/cubelic/interactions/like', {
    method: 'POST',
    body: JSON.stringify({
      operationId: `smoke_bulk_${runId}`,
      approvalId: `smoke_approval_bulk_${runId}`,
      approvedAt,
      targetPostId: `96${Date.now().toString().slice(-16)}`,
      targets: ['970000000000000001', '970000000000000002'],
    }),
  });
  if (bulk.response.status !== 422) {
    throw new Error(`Bulk-shaped interaction returned ${bulk.response.status}, expected 422`);
  }
} catch (error) {
  failure = error;
} finally {
  if (resumed) {
    const stop = await json('/api/cubelic/admin/emergency-stop', {
      method: 'POST',
      body: '{}',
    }).catch(() => null);
    if (!stop?.response.ok || stop.body?.data?.stopped !== true) {
      failure = failure ?? new Error('Failed to restore the staging emergency stop');
    }
  }
}

if (failure) throw failure;

const stoppedAttempt = await json('/api/cubelic/interactions/like', {
  method: 'POST',
  body: JSON.stringify({
    operationId: 'smoke_stopped_probe',
    approvalId: 'smoke_stopped_probe_approval',
    approvedAt: new Date().toISOString(),
    targetPostId: '980000000000000001',
  }),
});
if (stoppedAttempt.response.status !== 423) {
  throw new Error(`Stopped interaction returned ${stoppedAttempt.response.status}, expected 423`);
}

console.log(
  'Staging interaction smoke passed: five fake operations, idempotent replay, '
  + 'bulk rejection, and restored emergency stop.',
);
