import { afterEach, describe, expect, it, vi } from 'vitest';
import { XClient } from './client.js';

describe('XClient chunked media upload', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads and uploads bounded chunks before finalizing media', async () => {
    const commands: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body;
      if (!(form instanceof FormData)) throw new Error('Expected FormData');
      const command = String(form.get('command'));
      commands.push(command);
      if (command === 'INIT') {
        return Response.json({ data: { id: 'media_1' } });
      }
      if (command === 'FINALIZE') {
        return Response.json({ data: { id: 'media_1' } });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const reads: Array<{ offset: number; length: number }> = [];
    const client = new XClient('user-context-token');

    const mediaId = await client.uploadMediaChunks({
      mediaType: 'video/mp4',
      mediaCategory: 'tweet_video',
      totalBytes: source.byteLength,
      chunkSize: 4,
      readChunk: async (offset, length) => {
        reads.push({ offset, length });
        return source.slice(offset, offset + length).buffer;
      },
    });

    expect(mediaId).toBe('media_1');
    expect(reads).toEqual([
      { offset: 0, length: 4 },
      { offset: 4, length: 4 },
      { offset: 8, length: 2 },
    ]);
    expect(commands).toEqual(['INIT', 'APPEND', 'APPEND', 'APPEND', 'FINALIZE']);
  });
});
