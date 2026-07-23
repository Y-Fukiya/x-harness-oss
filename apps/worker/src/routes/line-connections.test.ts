import { describe, expect, it } from 'vitest';
import { normalizeSafeExternalOrigin } from './line-connections.js';

describe('external connection origin validation', () => {
  it('accepts only a bare public HTTPS origin', () => {
    const allowed = 'worker.example.com';
    expect(normalizeSafeExternalOrigin('https://worker.example.com/', allowed)).toBe(
      'https://worker.example.com',
    );
    expect(normalizeSafeExternalOrigin('https://other.example.com', allowed)).toBeNull();
    expect(normalizeSafeExternalOrigin('https://worker.example.com', undefined)).toBeNull();
    expect(normalizeSafeExternalOrigin('http://worker.example.com', allowed)).toBeNull();
    expect(normalizeSafeExternalOrigin('https://localhost', 'localhost')).toBeNull();
    expect(normalizeSafeExternalOrigin('https://127.0.0.1', '127.0.0.1')).toBeNull();
    expect(normalizeSafeExternalOrigin('https://10.1.2.3', '10.1.2.3')).toBeNull();
    expect(normalizeSafeExternalOrigin('https://192.168.1.1', '192.168.1.1')).toBeNull();
    expect(normalizeSafeExternalOrigin('https://172.16.1.1', '172.16.1.1')).toBeNull();
    expect(normalizeSafeExternalOrigin('https://worker.example.com/admin', allowed)).toBeNull();
    expect(normalizeSafeExternalOrigin('https://user:pass@worker.example.com', allowed)).toBeNull();
  });
});
