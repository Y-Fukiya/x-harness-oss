import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildInteractionWatchReadAdapter } from './adapter.js';
import type { Env } from '../index.js';

function env(): Env['Bindings'] {
  const statement = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn(async () => ({ success: true })),
  };
  return {
    DB: {
      prepare: vi.fn(() => statement),
    } as unknown as D1Database,
    X_HARNESS_ACCOUNT_ID: 'watch-usage-account',
    X_INTERACTION_WATCH_BEARER_TOKEN: 'application-only-token-with-at-least-32-bytes',
  } as Env['Bindings'];
}

describe('interaction-watch application-only credential boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts a valid application-only credential that X rejects for users/me', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ title: 'Unsupported Authentication' }),
        { status: 403 },
      ))
      .mockResolvedValueOnce(Response.json({
        data: {
          id: '1900000000000000100',
          name: 'Approved target',
          username: 'approved_target',
        },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      buildInteractionWatchReadAdapter(env()).verifyTargetUsername('approved_target'),
    ).resolves.toEqual({
      targetUserId: '1900000000000000100',
      verifiedUsername: 'approved_target',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.x.com/2/users/me?user.fields=profile_image_url,public_metrics',
    );
  });

  it('rejects a credential that authenticates as X User Context', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      data: {
        id: '1900000000000000999',
        name: 'Credential owner',
        username: 'credential_owner',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      buildInteractionWatchReadAdapter(env()).verifyTargetUsername('approved_target'),
    ).rejects.toMatchObject({
      code: 'interaction_watch_user_context_forbidden',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when application-only status cannot be determined', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ title: 'Unauthorized' }),
      { status: 401 },
    )));

    await expect(
      buildInteractionWatchReadAdapter(env()).verifyTargetUsername('approved_target'),
    ).rejects.toMatchObject({
      code: 'interaction_watch_credential_unverified',
    });
  });

  it('rejects a non-application-only 403 response as indeterminate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ title: 'Forbidden', detail: 'Missing scope' }),
      { status: 403 },
    )));

    await expect(
      buildInteractionWatchReadAdapter(env()).verifyTargetUsername('approved_target'),
    ).rejects.toMatchObject({
      code: 'interaction_watch_credential_unverified',
    });
  });
});
