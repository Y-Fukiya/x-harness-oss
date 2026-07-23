import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dashboard browser authentication', () => {
  it('sends the management key only to the login exchange and uses cookies afterward', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { authenticated: true, role: 'admin', name: null, expiresIn: 900 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { authenticated: true, role: 'admin', name: null },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.login('one-time-management-key');
    await api.session();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/\/api\/session\/login$/u),
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.objectContaining({
          Authorization: 'Bearer one-time-management-key',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/\/api\/session$/u),
      expect.objectContaining({
        credentials: 'include',
        headers: expect.not.objectContaining({ Authorization: expect.anything() }),
      }),
    );
  });

  it('does not load external connection API keys into browser code', async () => {
    const campaignSource = await readFile(
      fileURLToPath(new URL('../app/campaign/page.tsx', import.meta.url)),
      'utf8',
    );
    const settingsSource = await readFile(
      fileURLToPath(new URL('../app/settings/page.tsx', import.meta.url)),
      'utf8',
    );

    expect(campaignSource).not.toContain('lineApiKey');
    expect(settingsSource).not.toContain('full.data.api_key');
    expect(`${campaignSource}\n${settingsSource}`).not.toMatch(
      /Authorization:\s*`Bearer \$\{[^}]*line/iu,
    );
  });
});
