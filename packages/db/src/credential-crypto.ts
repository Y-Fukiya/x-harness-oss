const ENCRYPTED_PREFIX = 'enc:v1:';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

async function importEncryptionKey(encodedKey: string): Promise<CryptoKey> {
  const raw = fromBase64Url(encodedKey);
  if (raw.byteLength !== 32) {
    throw new Error('Credential encryption key must decode to exactly 32 bytes');
  }
  return crypto.subtle.importKey('raw', toArrayBuffer(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export function isEncryptedCredential(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

export async function encryptCredential(value: string, encodedKey: string, field: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv: toArrayBuffer(iv),
    additionalData: encoder.encode(`x-harness:${field}:v1`),
  }, await importEncryptionKey(encodedKey), encoder.encode(value));
  return `${ENCRYPTED_PREFIX}${toBase64Url(iv)}:${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptCredential(value: string, encodedKey: string, field: string): Promise<string> {
  if (!isEncryptedCredential(value)) return value;
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('Unsupported encrypted credential format');
  }
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: toArrayBuffer(fromBase64Url(parts[2])),
    additionalData: encoder.encode(`x-harness:${field}:v1`),
  }, await importEncryptionKey(encodedKey), toArrayBuffer(fromBase64Url(parts[3])));
  return decoder.decode(plaintext);
}
