import { describe, expect, it, vi } from 'vitest';
import { rotateProductionInteractionWatch } from './rotate-production-interaction-watch.mjs';

const environment = {
  PRODUCTION_WORKER_URL: 'https://api.example.test',
  PRODUCTION_API_KEY: 'production-api-key-with-at-least-32-bytes',
  PRODUCTION_HUMAN_APPROVAL_KEY: 'human-approval-key-with-at-least-32-bytes',
  INTERACTION_WATCH_TARGET_USERNAME: 'replacement_x',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('production interaction-watch rotation', () => {
  it('rotates one target while keeping production stopped', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: {
          emergencyStop: true,
          emergencyStopValid: true,
          publishingEnabled: false,
          schedulingEnabled: false,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: [{ watchId: 'watch_old', targetUsername: 'old_target' }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          stopped: true,
          activeWatch: {
            watchId: 'watch_new',
            targetUsername: 'replacement_x',
          },
        },
      }, 201))
      .mockResolvedValueOnce(jsonResponse({
        data: [{ watchId: 'watch_new', targetUsername: 'replacement_x' }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: { emergencyStop: true, emergencyStopValid: true },
      }));

    await expect(rotateProductionInteractionWatch({
      environment,
      fetchImpl,
    })).resolves.toEqual({
      rotated: true,
      alreadyActive: false,
      targetUsername: 'replacement_x',
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'https://api.example.test/api/cubelic/admin/interaction-watch-target',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Human-Approval-Key':
            'human-approval-key-with-at-least-32-bytes',
        }),
      }),
    );
  });

  it('refuses rotation unless the valid D1 stop is active', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({
      data: {
        emergencyStop: false,
        emergencyStopValid: true,
        publishingEnabled: false,
        schedulingEnabled: false,
      },
    }));
    await expect(rotateProductionInteractionWatch({
      environment,
      fetchImpl,
    })).rejects.toThrow('valid stopped');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
