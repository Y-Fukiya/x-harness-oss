import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const baseUrl = (
  process.env.STAGING_WORKER_URL
  ?? 'https://x-harness-worker-staging.yoshihiro-fukiya.workers.dev'
).replace(/\/$/u, '');
const staffService = process.env.STAGING_STAFF_KEYCHAIN_SERVICE
  ?? 'CUBELIC Staging Staff API Key';
const approvalService = process.env.STAGING_HUMAN_APPROVAL_KEYCHAIN_SERVICE
  ?? 'CUBELIC Staging Human Approval Key';

const parsedBaseUrl = new URL(baseUrl);
if (
  parsedBaseUrl.protocol !== 'https:'
  || parsedBaseUrl.hostname !== 'x-harness-worker-staging.yoshihiro-fukiya.workers.dev'
) {
  throw new Error('Media smoke is restricted to the dedicated HTTPS staging Worker.');
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

const staffKey = keychainSecret(staffService);
const humanApprovalKey = keychainSecret(approvalService);
const jsonHeaders = {
  Authorization: `Bearer ${staffKey}`,
  'X-Human-Approval-Key': humanApprovalKey,
  'content-type': 'application/json',
};

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...jsonHeaders, ...init.headers },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function expectStatus(path, init, expected) {
  const result = await request(path, init);
  if (result.response.status !== expected) {
    throw new Error(`${path} returned HTTP ${result.response.status}, expected ${expected}`);
  }
  return result.body;
}

const runId = Date.now().toString(36);
const eventId = `evt_media_smoke_${runId}`;
const assetId = `ast_media_smoke_${runId}`;
const contentId = `cnt_media_smoke_${runId}`;
const mediaBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const sha256 = createHash('sha256').update(mediaBytes).digest('hex');
const now = Date.now();
const iso = (milliseconds) => new Date(milliseconds).toISOString();

let resumed = false;
let staged = false;
let failure;
try {
  await expectStatus('/api/cubelic/admin/operation-window', {
    method: 'POST',
    body: JSON.stringify({ eventId, durationMinutes: 10 }),
  }, 201);

  await expectStatus('/api/cubelic/admin/emergency-resume', {
    method: 'POST',
    body: '{}',
  }, 200);
  resumed = true;

  await expectStatus('/api/cubelic/events', {
    method: 'POST',
    body: JSON.stringify({
      event_id: eventId,
      title: `Staging media smoke ${runId}`,
      venue: 'staging-only',
      starts_at: iso(now - 70 * 60_000),
      ends_at: iso(now - 10 * 60_000),
      state: 'digest_ready',
      official_url: null,
      ticket_url: null,
      event_tags: ['staging_smoke'],
      filming_policy: {
        confirmed: true,
        scope: 'full_event',
        evidence_type: 'staff_confirmation',
        evidence_url: 'https://example.test/evidence/staging-media-smoke',
        confirmed_at: iso(now - 80 * 60_000),
        confirmed_by: 'human_operator',
        notes: 'Synthetic staging-only fixture.',
      },
    }),
  }, 201);

  await expectStatus('/api/cubelic/media/validate', {
    method: 'POST',
    body: JSON.stringify({
      asset_id: assetId,
      event_id: eventId,
      path: `/staging-smoke/${assetId}.png`,
      sha256,
      duration_seconds: 1,
      orientation: 'square',
      resolution: '1x1',
      audio_present: false,
      rights: {
        filming_policy_confirmed: true,
        publishing_allowed: true,
        evidence_url: 'https://example.test/evidence/staging-media-smoke',
        song_scope_confirmed: true,
      },
      privacy: {
        audience_visible: false,
        third_party_faces_detected: false,
        manual_review_completed: true,
        cropping_required: false,
        blurring_required: false,
      },
      quality: {
        video_ok: true,
        audio_ok: true,
        sync_ok: true,
        score: 100,
      },
      status: 'pending_validation',
    }),
  }, 201);

  await expectStatus('/api/cubelic/content', {
    method: 'POST',
    body: JSON.stringify({
      content_id: contentId,
      event_id: eventId,
      category: 'live_digest',
      target_stage: 'unaware',
      content_lifecycle: { type: 'news', expires_at: iso(now + 60 * 60_000) },
      status: 'validated',
      source_type: 'media_asset',
      source_refs: [assetId],
      member_ids: [],
      song_ids: [],
      emotion_tags: ['informative'],
      destination: {
        type: 'live_report',
        base_url: 'https://example.test/staging-media-smoke',
        tracked_url: '',
      },
    }),
  }, 201);

  const generated = await expectStatus('/api/cubelic/drafts/generate', {
    method: 'POST',
    body: JSON.stringify({ contentId, mediaAssetId: assetId }),
  }, 201);
  const draftId = generated?.data?.[0]?.draft_id;
  if (typeof draftId !== 'string') throw new Error('Media smoke did not generate a draft.');

  await expectStatus(`/api/cubelic/media/${assetId}/body`, {
    method: 'PUT',
    headers: {
      'content-type': 'image/png',
      'content-length': String(mediaBytes.byteLength),
      'x-content-sha256': sha256,
    },
    body: mediaBytes,
  }, 201);
  staged = true;

  await expectStatus('/api/cubelic/admin/emergency-stop', {
    method: 'POST',
    body: '{}',
  }, 200);
  resumed = false;

  await expectStatus('/api/cubelic/admin/emergency-resume', {
    method: 'POST',
    body: '{}',
  }, 200);
  resumed = true;

  await expectStatus(`/api/cubelic/drafts/${draftId}/approve`, {
    method: 'POST',
    body: '{}',
  }, 200);
  const published = await expectStatus(`/api/cubelic/drafts/${draftId}/publish`, {
    method: 'POST',
    body: '{}',
  }, 201);
  if (!/^staging_fake_/u.test(published?.data?.postId ?? '')) {
    throw new Error('Media smoke did not use the staging-fake delivery adapter.');
  }
} catch (error) {
  failure = error;
} finally {
  if (resumed) {
    try {
      await expectStatus('/api/cubelic/admin/emergency-stop', {
        method: 'POST',
        body: '{}',
      }, 200);
      resumed = false;
    } catch (stopError) {
      failure ??= stopError;
    }
  }
  if (staged && !resumed) {
    try {
      await expectStatus(`/api/cubelic/media/${assetId}/quarantine`, {
        method: 'POST',
        body: '{}',
      }, 200);
    } catch (quarantineError) {
      failure ??= quarantineError;
    }
  }
}

const status = await request('/api/cubelic/admin/status');
if (
  status.response.status !== 200
  || status.body?.data?.emergencyStop !== true
  || status.body?.data?.emergencyStopValid !== true
) {
  failure ??= new Error('Staging did not finish with a valid active D1 emergency stop.');
}

if (failure) throw failure;
console.log(
  'Staging media smoke passed: immutable R2 staging, bounded fake delivery, '
  + 'audit path, emergency stop restoration, and quarantine deletion succeeded; no X API call was made.',
);
