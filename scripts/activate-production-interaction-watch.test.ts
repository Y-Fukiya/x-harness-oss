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

  it('reports an incident when activation failure cannot restore the emergency stop', async () => {
    const responses = [
      { status: 200, body: { data: {
        emergencyStop: true,
        emergencyStopValid: true,
        interactionWatchEnabled: false,
        publishingEnabled: false,
        schedulingEnabled: false,
      } } },
      { status: 200, body: { data: [] } },
      { status: 200, body: { data: { stopped: false, interactionWatch: true } } },
      { status: 201, body: {
        data: { watchId: 'watch_reviewed', targetUsername: 'approved_target' },
      } },
      { status: 500, body: { code: 'poll_failed' } },
      { status: 500, body: { code: 'stop_failed' } },
      { status: 200, body: { data: {
        emergencyStop: false,
        emergencyStopValid: true,
      } } },
    ];
    const fetchImpl = vi.fn(async () => {
      const next = responses.shift();
      return Response.json(next?.body, { status: next?.status });
    });

    await expect(runProductionInteractionWatchActivation({
      environment: {
        PRODUCTION_WORKER_URL: 'https://api.example.test',
        PRODUCTION_API_KEY: 'a'.repeat(32),
        PRODUCTION_HUMAN_APPROVAL_KEY: 'b'.repeat(32),
        INTERACTION_WATCH_TARGET_USERNAME: 'approved_target',
      },
      fetchImpl,
    })).rejects.toThrow(
      'Activation failed and emergency-stop rollback could not be verified.',
    );
  });

  it('forces a verified stop when the resume response is unavailable', async () => {
    const paths: string[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      paths.push(new URL(input.toString()).pathname);
      call += 1;
      if (call === 1) {
        return Response.json({ data: {
          emergencyStop: true,
          emergencyStopValid: true,
          interactionWatchEnabled: false,
          publishingEnabled: false,
          schedulingEnabled: false,
        } });
      }
      if (call === 2) return Response.json({ data: [] });
      if (call === 3) throw new Error('resume response unavailable');
      if (call === 4) return Response.json({ data: { stopped: true } });
      return Response.json({ data: {
        emergencyStop: true,
        emergencyStopValid: true,
      } });
    });

    await expect(runProductionInteractionWatchActivation({
      environment: {
        PRODUCTION_WORKER_URL: 'https://api.example.test',
        PRODUCTION_API_KEY: 'a'.repeat(32),
        PRODUCTION_HUMAN_APPROVAL_KEY: 'b'.repeat(32),
        INTERACTION_WATCH_TARGET_USERNAME: 'approved_target',
      },
      fetchImpl,
    })).rejects.toThrow('resume response unavailable');
    expect(paths).toEqual([
      '/api/cubelic/admin/status',
      '/api/cubelic/interaction-watches',
      '/api/cubelic/admin/emergency-resume',
      '/api/cubelic/admin/emergency-stop',
      '/api/cubelic/admin/status',
    ]);
  });
});
