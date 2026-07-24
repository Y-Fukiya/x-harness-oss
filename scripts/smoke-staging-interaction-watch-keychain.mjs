import { execFileSync } from 'node:child_process';

const baseUrl = process.env.STAGING_WORKER_URL?.replace(/\/$/u, '');
const staffService = process.env.STAGING_STAFF_KEYCHAIN_SERVICE;
const approvalService = process.env.STAGING_HUMAN_APPROVAL_KEYCHAIN_SERVICE;

if (!baseUrl || !staffService || !approvalService) {
  throw new Error(
    'Set STAGING_WORKER_URL, STAGING_STAFF_KEYCHAIN_SERVICE, and '
    + 'STAGING_HUMAN_APPROVAL_KEYCHAIN_SERVICE.',
  );
}
const parsedBaseUrl = new URL(baseUrl);
if (
  parsedBaseUrl.protocol !== 'https:'
  || parsedBaseUrl.hostname !== 'x-harness-worker-staging.yoshihiro-fukiya.workers.dev'
) {
  throw new Error('Watch smoke is restricted to the dedicated HTTPS staging Worker.');
}

function keychainSecret(service) {
  try {
    const value = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', service, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (value.length < 32) throw new Error('secret is too short');
    return value;
  } catch {
    throw new Error(`Required macOS Keychain item is unavailable: ${service}`);
  }
}

const headers = {
  Authorization: `Bearer ${keychainSecret(staffService)}`,
  'X-Human-Approval-Key': keychainSecret(approvalService),
  'content-type': 'application/json',
};

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

let resumed = false;
let failure;
try {
  const resume = await request('/api/cubelic/admin/emergency-resume', {
    method: 'POST',
    body: '{}',
  });
  if (!resume.response.ok || resume.body?.data?.stopped !== false) {
    throw new Error(`Staging emergency resume failed with HTTP ${resume.response.status}`);
  }
  resumed = true;

  const existing = await request('/api/cubelic/interaction-watches');
  if (!existing.response.ok || !Array.isArray(existing.body?.data)) {
    throw new Error(`Watch list failed with HTTP ${existing.response.status}`);
  }
  if (existing.body.data.length !== 0) {
    throw new Error('Watch smoke requires a fresh dedicated staging D1 database.');
  }
  const created = await request('/api/cubelic/interaction-watches', {
    method: 'POST',
    body: JSON.stringify({ targetUsername: 'x_harness_watch_smoke' }),
  });
  if (created.response.status !== 201) {
    throw new Error(`Watch registration failed with HTTP ${created.response.status}`);
  }
  const watch = created.body?.data;
  if (
    watch?.targetUsername !== 'x_harness_watch_smoke'
    || watch?.targetUserId !== '9900000000000000100'
  ) {
    throw new Error('Staging D1 already contains a non-smoke singleton watch.');
  }

  const firstPoll = await request(
    `/api/cubelic/interaction-watches/${encodeURIComponent(watch.watchId)}/poll`,
    { method: 'POST', body: '{}' },
  );
  if (!firstPoll.response.ok || firstPoll.body?.data?.discovered !== 1) {
    throw new Error(`First watch poll failed with HTTP ${firstPoll.response.status}`);
  }
  const secondPoll = await request(
    `/api/cubelic/interaction-watches/${encodeURIComponent(watch.watchId)}/poll`,
    { method: 'POST', body: '{}' },
  );
  if (!secondPoll.response.ok || secondPoll.body?.data?.discovered !== 0) {
    throw new Error('Second watch poll was not idempotent.');
  }

  const candidates = await request('/api/cubelic/interaction-candidates');
  const candidate = candidates.body?.data?.[0];
  const candidateKeys = candidate ? Object.keys(candidate).sort() : [];
  const expectedKeys = [
    'authorId',
    'candidateId',
    'detectedAt',
    'postCreatedAt',
    'postId',
    'status',
    'watchId',
  ];
  if (
    !candidates.response.ok
    || candidates.body?.data?.length !== 1
    || candidate?.postId !== '9900000000000000101'
    || JSON.stringify(candidateKeys) !== JSON.stringify(expectedKeys)
  ) {
    throw new Error('Expected exactly one synthetic ID-only candidate.');
  }
  const evidence = await request('/api/cubelic/interaction-watch-smoke-evidence');
  if (
    !evidence.response.ok
    || evidence.body?.data?.candidateCount !== 1
    || evidence.body?.data?.bodyColumnPresent !== false
    || evidence.body?.data?.xWriteAuditCount !== 0
  ) {
    throw new Error('Staging smoke evidence did not prove the read-only boundary.');
  }
} catch (error) {
  failure = error;
} finally {
  if (resumed) {
    const stop = await request('/api/cubelic/admin/emergency-stop', {
      method: 'POST',
      body: '{}',
    }).catch(() => null);
    if (!stop?.response.ok || stop.body?.data?.stopped !== true) {
      failure = failure ?? new Error('Failed to restore the staging emergency stop.');
    }
  }
}

if (failure) throw failure;

console.log('Read-only interaction-watch staging smoke passed; emergency stop restored.');
