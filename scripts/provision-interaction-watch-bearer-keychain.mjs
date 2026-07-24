import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const targetUsername = process.env.INTERACTION_WATCH_TARGET_USERNAME;
const wranglerScript = process.env.WRANGLER_SCRIPT;
const workerDirectory = process.env.WORKER_DIRECTORY;
const bearerService = process.env.INTERACTION_WATCH_BEARER_KEYCHAIN_SERVICE
  ?? 'X Harness Production Interaction Watch Bearer Token';
const targetIdService = process.env.INTERACTION_WATCH_TARGET_ID_KEYCHAIN_SERVICE
  ?? 'X Harness Production Interaction Watch Reviewed Target User ID';
const consumerKeyService = process.env.X_CONSUMER_KEY_KEYCHAIN_SERVICE
  ?? 'CUBELIC Production X Consumer Key';
const consumerSecretService = process.env.X_CONSUMER_SECRET_KEYCHAIN_SERVICE
  ?? 'CUBELIC Production X Consumer Secret';

if (!targetUsername || !/^[A-Za-z0-9_]{1,15}$/u.test(targetUsername)) {
  throw new Error('Set INTERACTION_WATCH_TARGET_USERNAME to one valid X username.');
}
if (!wranglerScript || !workerDirectory) {
  throw new Error('Set WRANGLER_SCRIPT and WORKER_DIRECTORY.');
}

function keychainSecret(service) {
  try {
    const value = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', service, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!value) throw new Error('empty secret');
    return value;
  } catch {
    throw new Error(`Required macOS Keychain item is unavailable: ${service}`);
  }
}

const consumerKey = encodeURIComponent(keychainSecret(consumerKeyService));
const consumerSecret = encodeURIComponent(keychainSecret(consumerSecretService));
const basicCredential = Buffer.from(
  `${consumerKey}:${consumerSecret}`,
  'utf8',
).toString('base64');
const tokenResponse = await fetch('https://api.x.com/oauth2/token', {
  method: 'POST',
  headers: {
    authorization: `Basic ${basicCredential}`,
    'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
  },
  body: 'grant_type=client_credentials',
  signal: AbortSignal.timeout(15_000),
});
const tokenBody = await tokenResponse.json().catch(() => null);
if (
  !tokenResponse.ok
  || tokenBody?.token_type?.toLowerCase() !== 'bearer'
  || typeof tokenBody?.access_token !== 'string'
  || tokenBody.access_token.length < 32
) {
  throw new Error(`X app-only token exchange failed with HTTP ${tokenResponse.status}.`);
}
const bearerToken = tokenBody.access_token;

const meResponse = await fetch(
  'https://api.x.com/2/users/me?user.fields=profile_image_url,public_metrics',
  {
    headers: { authorization: `Bearer ${bearerToken}` },
    signal: AbortSignal.timeout(15_000),
  },
);
const meBody = await meResponse.json().catch(() => null);
if (
  meResponse.status !== 403
  || meBody?.title !== 'Unsupported Authentication'
) {
  throw new Error(
    'The generated credential did not produce the exact application-only proof.',
  );
}

const userResponse = await fetch(
  `https://api.x.com/2/users/by/username/${encodeURIComponent(targetUsername)}`
    + '?user.fields=username',
  {
    headers: { authorization: `Bearer ${bearerToken}` },
    signal: AbortSignal.timeout(15_000),
  },
);
const userBody = await userResponse.json().catch(() => null);
if (
  !userResponse.ok
  || typeof userBody?.data?.id !== 'string'
  || !/^[1-9][0-9]{4,29}$/u.test(userBody.data.id)
  || userBody?.data?.username?.toLowerCase() !== targetUsername.toLowerCase()
) {
  throw new Error(`X target lookup failed with HTTP ${userResponse.status}.`);
}

function storeKeychainSecret(service, value) {
  const account = process.env.USER ?? 'codex-operator';
  const deleteResult = spawnSync(
    '/usr/bin/security',
    ['delete-generic-password', '-a', account, '-s', service],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (deleteResult.status !== 0 && deleteResult.status !== 44) {
    throw new Error(`Failed to replace protected Keychain item: ${service}`);
  }
  const result = spawnSync(
    '/usr/bin/swift',
    [fileURLToPath(new URL('./store-keychain-secret.swift', import.meta.url))],
    {
      input: JSON.stringify({
        service,
        account,
        secret: value,
      }),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  if (result.status !== 0) {
    throw new Error(`Failed to store protected Keychain item: ${service}`);
  }
}
storeKeychainSecret(bearerService, bearerToken);
storeKeychainSecret(targetIdService, userBody.data.id);

function provisionWorkerSecret(name, value) {
  const result = spawnSync(
    process.execPath,
    [
      wranglerScript,
      'secret',
      'put',
      name,
      '--env',
      'production',
    ],
    {
      cwd: workerDirectory,
      input: `${value}\n`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  if (result.status !== 0) {
    throw new Error(`Failed to provision production Worker secret: ${name}`);
  }
}
provisionWorkerSecret('X_INTERACTION_WATCH_BEARER_TOKEN', bearerToken);
provisionWorkerSecret(
  'X_INTERACTION_WATCH_REVIEWED_TARGET_USER_ID',
  userBody.data.id,
);

console.log(JSON.stringify({
  applicationOnlyVerified: true,
  keychainStored: true,
  workerSecretProvisioned: true,
  reviewedTargetBindingProvisioned: true,
  targetUsername: userBody.data.username,
}));
