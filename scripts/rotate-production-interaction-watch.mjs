function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function assertTargetUsername(value) {
  if (!/^[A-Za-z0-9_]{1,15}$/u.test(value)) {
    throw new Error('INTERACTION_WATCH_TARGET_USERNAME must be one valid X username.');
  }
}

export async function rotateProductionInteractionWatch({
  environment = process.env,
  fetchImpl = fetch,
}) {
  const workerOrigin = required(environment, 'PRODUCTION_WORKER_URL').replace(/\/$/u, '');
  if (new URL(workerOrigin).protocol !== 'https:') {
    throw new Error('PRODUCTION_WORKER_URL must use HTTPS.');
  }
  const apiKey = required(environment, 'PRODUCTION_API_KEY');
  const approvalKey = required(environment, 'PRODUCTION_HUMAN_APPROVAL_KEY');
  const targetUsername = required(environment, 'INTERACTION_WATCH_TARGET_USERNAME');
  assertTargetUsername(targetUsername);

  const request = async (path, init = {}) => {
    const response = await fetchImpl(`${workerOrigin}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        ...init.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
    return {
      response,
      body: await response.json().catch(() => null),
    };
  };

  const initial = await request('/api/cubelic/admin/status');
  if (
    !initial.response.ok
    || initial.body?.data?.emergencyStop !== true
    || initial.body?.data?.emergencyStopValid !== true
    || initial.body?.data?.publishingEnabled !== false
    || initial.body?.data?.schedulingEnabled !== false
  ) {
    throw new Error('Production is not in a valid stopped, X-write-disabled state.');
  }

  const existing = await request('/api/cubelic/interaction-watches');
  if (!existing.response.ok || existing.body?.data?.length !== 1) {
    throw new Error('Exactly one existing production watch is required for rotation.');
  }
  if (
    existing.body.data[0]?.targetUsername?.toLowerCase()
    === targetUsername.toLowerCase()
  ) {
    return { rotated: false, alreadyActive: true, targetUsername };
  }

  const rotated = await request('/api/cubelic/admin/interaction-watch-target', {
    method: 'POST',
    headers: { 'X-Human-Approval-Key': approvalKey },
    body: JSON.stringify({ targetUsername }),
  });
  if (
    !rotated.response.ok
    || rotated.body?.data?.stopped !== true
    || rotated.body?.data?.activeWatch?.targetUsername?.toLowerCase()
      !== targetUsername.toLowerCase()
  ) {
    throw new Error(`Watch target rotation failed with HTTP ${rotated.response.status}.`);
  }

  const [current, finalStatus] = await Promise.all([
    request('/api/cubelic/interaction-watches'),
    request('/api/cubelic/admin/status'),
  ]);
  if (
    !current.response.ok
    || current.body?.data?.length !== 1
    || current.body.data[0]?.targetUsername?.toLowerCase()
      !== targetUsername.toLowerCase()
    || !finalStatus.response.ok
    || finalStatus.body?.data?.emergencyStop !== true
    || finalStatus.body?.data?.emergencyStopValid !== true
  ) {
    throw new Error('Rotated watch could not be verified while production remained stopped.');
  }

  return { rotated: true, alreadyActive: false, targetUsername };
}
