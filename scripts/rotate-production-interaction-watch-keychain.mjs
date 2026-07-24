import { execFileSync } from 'node:child_process';
import { rotateProductionInteractionWatch } from './rotate-production-interaction-watch.mjs';

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

const environment = {
  ...process.env,
  PRODUCTION_WORKER_URL: process.env.PRODUCTION_WORKER_URL
    ?? 'https://api.cubelic-fan.com',
  PRODUCTION_API_KEY: keychainSecret(
    process.env.PRODUCTION_STAFF_KEYCHAIN_SERVICE
      ?? 'X Harness Production Staff API Key',
  ),
  PRODUCTION_HUMAN_APPROVAL_KEY: keychainSecret(
    process.env.PRODUCTION_HUMAN_APPROVAL_KEYCHAIN_SERVICE
      ?? 'X Harness Production Human Approval Key',
  ),
};

rotateProductionInteractionWatch({ environment })
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : 'Watch rotation failed.');
    process.exitCode = 1;
  });
