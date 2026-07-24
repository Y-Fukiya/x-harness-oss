import { describe, expect, it, vi } from 'vitest';
import { runProductionInteractionWatchActivation } from './activate-production-interaction-watch.mjs';

describe('production interaction-watch activation', () => {
  it('resumes and registers one read-only watch without calling an X-write route', async () => {
    const responses = [
      { data: {
        emergencyStop: true,
        emergencyStopValid: true,
        interactionWatchEnabled: false,
        publishingEnabled: false,
        schedulingEnabled: false,
      } },
      { data: [] },
      { data: { stopped: false, interactionWatch: true } },
      { data: { watchId: 'watch_reviewed', targetUsername: 'approved_target' } },
      { data: { discovered: 2 } },
      { data: {
        emergencyStop: false,
        emergencyStopValid: true,
        interactionWatchEnabled: true,
        publishingEnabled: false,
        schedulingEnabled: false,
      } },
    ];
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      paths.push(new URL(input.toString()).pathname);
      return Response.json(responses.shift(), { status: 200 });
    });

    await expect(runProductionInteractionWatchActivation({
      environment: {
        PRODUCTION_WORKER_URL: 'https://api.example.test',
        PRODUCTION_API_KEY: 'a'.repeat(32),
        PRODUCTION_HUMAN_APPROVAL_KEY: 'b'.repeat(32),
        INTERACTION_WATCH_TARGET_USERNAME: 'approved_target',
      },
      fetchImpl,
    })).resolves.toEqual({
      activated: true,
      candidateCount: 2,
      targetUsername: 'approved_target',
    });
    expect(paths).toEqual([
      '/api/cubelic/admin/status',
      '/api/cubelic/interaction-watches',
      '/api/cubelic/admin/emergency-resume',
      '/api/cubelic/interaction-watches',
      '/api/cubelic/interaction-watches/watch_reviewed/poll',
      '/api/cubelic/admin/status',
    ]);
    expect(paths.some((path) => (
      /\/(publish|schedule|like|repost|reply|dm|follow)/u.test(path)
    ))).toBe(false);
  });
});
