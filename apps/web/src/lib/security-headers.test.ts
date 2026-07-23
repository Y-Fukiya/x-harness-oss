import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const headersFile = fileURLToPath(new URL('../../public/_headers', import.meta.url));
const cspGenerator = fileURLToPath(new URL('../../../../scripts/generate-web-csp.mjs', import.meta.url));

describe('dashboard security headers', () => {
  it('ships restrictive browser security policy headers', async () => {
    const source = await readFile(headersFile, 'utf8');

    expect(source).toContain("Content-Security-Policy: default-src 'self'");
    expect(source).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(source).toContain("object-src 'none'");
    expect(source).toContain("frame-ancestors 'none'");
    expect(source).toContain('Strict-Transport-Security: max-age=63072000; includeSubDomains; preload');
    expect(source).toContain('X-Content-Type-Options: nosniff');
    expect(source).toContain('Referrer-Policy: no-referrer');
    expect(source).toContain('Permissions-Policy:');
    expect(Math.max(...source.split(/\r?\n/u).map((line) => line.length))).toBeLessThanOrEqual(2_000);
  });

  it('externalizes generated inline scripts instead of growing a CSP hash allowlist', async () => {
    const source = await readFile(cspGenerator, 'utf8');

    expect(source).toContain('/_next/static/inline/');
    expect(source).not.toContain("'sha256-");
  });
});
