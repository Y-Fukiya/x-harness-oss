import { execFileSync } from 'node:child_process';

function keychainSecret(service) {
  try {
    return execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error(`Required macOS Keychain item is unavailable: ${service}`);
  }
}

process.env.PRODUCTION_WORKER_URL ??= 'https://api.cubelic-fan.com';
process.env.PRODUCTION_API_KEY = keychainSecret(
  process.env.PRODUCTION_STAFF_KEYCHAIN_SERVICE
    ?? 'X Harness Production Staff API Key',
);
await import('./verify-production-safety.mjs');
