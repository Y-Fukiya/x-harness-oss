export const DASHBOARD_SESSION_COOKIE = '__Host-xh_session';
export const DASHBOARD_SESSION_MAX_AGE_SECONDS = 15 * 60;

export interface DashboardSession {
  version: 1;
  expiresAt: number;
  role: 'admin' | 'editor' | 'viewer';
  staffId?: string;
  staffName?: string;
  nonce: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function isStrongRuntimeSecret(value: string | undefined): value is string {
  return typeof value === 'string' && encoder.encode(value).byteLength >= 32;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function hmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usage,
  );
}

export async function secretsEqual(expected: string, candidate: string): Promise<boolean> {
  if (!expected || !candidate) return false;
  const message = encoder.encode('x-harness-secret-comparison-v1');
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(expected, ['sign']), message);
  return crypto.subtle.verify('HMAC', await hmacKey(candidate, ['verify']), signature, message);
}

export async function createDashboardSession(
  input: Omit<DashboardSession, 'version' | 'expiresAt' | 'nonce'>,
  signingKey: string,
  now = Date.now(),
): Promise<string> {
  const session: DashboardSession = {
    version: 1,
    expiresAt: Math.floor(now / 1000) + DASHBOARD_SESSION_MAX_AGE_SECONDS,
    role: input.role,
    staffId: input.staffId,
    staffName: input.staffName,
    nonce: crypto.randomUUID(),
  };
  const payload = toBase64Url(encoder.encode(JSON.stringify(session)));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(signingKey, ['sign']),
    encoder.encode(payload),
  );
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifyDashboardSession(
  token: string,
  signingKey: string,
  now = Date.now(),
): Promise<DashboardSession | null> {
  try {
    const [payload, encodedSignature, remainder] = token.split('.');
    if (!payload || !encodedSignature || remainder) return null;
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(signingKey, ['verify']),
      toArrayBuffer(fromBase64Url(encodedSignature)),
      encoder.encode(payload),
    );
    if (!valid) return null;
    const parsed = JSON.parse(decoder.decode(fromBase64Url(payload))) as Partial<DashboardSession>;
    if (
      parsed.version !== 1
      || typeof parsed.expiresAt !== 'number'
      || parsed.expiresAt <= Math.floor(now / 1000)
      || !['admin', 'editor', 'viewer'].includes(parsed.role ?? '')
      || typeof parsed.nonce !== 'string'
    ) return null;
    return parsed as DashboardSession;
  } catch {
    return null;
  }
}

export function isAllowedDashboardOrigin(origin: string | undefined, configuredOrigins: string | undefined): boolean {
  if (!origin || !configuredOrigins) return false;
  const allowed = configuredOrigins.split(',').map((value) => value.trim()).filter(Boolean);
  return !allowed.includes('*') && allowed.includes(origin);
}
