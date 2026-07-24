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

export async function runProductionInteractionWatchActivation({
  environment = process.env,
  fetchImpl = fetch,
}) {
  const workerOrigin = required(environment, 'PRODUCTION_WORKER_URL').replace(/\/$/u, '');
  const parsedOrigin = new URL(workerOrigin);
  if (parsedOrigin.protocol !== 'https:') {
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
    const body = await response.json().catch(() => null);
    return { response, body };
  };
  const mutation = (path, body = {}) => request(path, {
    method: 'POST',
    headers: { 'X-Human-Approval-Key': approvalKey },
    body: JSON.stringify(body),
  });

  const initial = await request('/api/cubelic/admin/status');
  if (!initial.response.ok) {
    throw new Error(`Production status failed with HTTP ${initial.response.status}.`);
  }
  const initialStatus = initial.body?.data;
  if (
    initialStatus?.emergencyStop !== true
    || initialStatus?.emergencyStopValid !== true
    || initialStatus?.interactionWatchEnabled !== false
    || initialStatus?.publishingEnabled !== false
    || initialStatus?.schedulingEnabled !== false
  ) {
    throw new Error('Production is not in the expected stopped, read-only watch mode.');
  }

  const existing = await request('/api/cubelic/interaction-watches');
  if (!existing.response.ok || !Array.isArray(existing.body?.data)) {
    throw new Error(`Watch list failed with HTTP ${existing.response.status}.`);
  }
  if (
    existing.body.data.length > 1
    || (
      existing.body.data.length === 1
      && existing.body.data[0]?.targetUsername?.toLowerCase()
        !== targetUsername.toLowerCase()
    )
  ) {
    throw new Error('The existing production watch does not match the reviewed target.');
  }

  let resumed = false;
  try {
    const resume = await mutation('/api/cubelic/admin/emergency-resume');
    if (
      !resume.response.ok
      || resume.body?.data?.stopped !== false
      || resume.body?.data?.interactionWatch !== true
    ) {
      throw new Error(`Read-only watch resume failed with HTTP ${resume.response.status}.`);
    }
    resumed = true;

    let watch = existing.body.data[0];
    if (!watch) {
      const created = await mutation('/api/cubelic/interaction-watches', {
        targetUsername,
      });
      if (!created.response.ok) {
        throw new Error(`Watch registration failed with HTTP ${created.response.status}.`);
      }
      watch = created.body?.data;
    }
    if (
      typeof watch?.watchId !== 'string'
      || watch?.targetUsername?.toLowerCase() !== targetUsername.toLowerCase()
    ) {
      throw new Error('The registered watch did not match the reviewed target.');
    }

    const poll = await mutation(
      `/api/cubelic/interaction-watches/${encodeURIComponent(watch.watchId)}/poll`,
    );
    const rateLimited = poll.response.status === 422
      && poll.body?.code === 'interaction_watch_rate_limited';
    if (!poll.response.ok && !rateLimited) {
      throw new Error(`Initial read-only poll failed with HTTP ${poll.response.status}.`);
    }

    const final = await request('/api/cubelic/admin/status');
    const finalStatus = final.body?.data;
    if (
      !final.response.ok
      || finalStatus?.emergencyStop !== false
      || finalStatus?.emergencyStopValid !== true
      || finalStatus?.interactionWatchEnabled !== true
      || finalStatus?.publishingEnabled !== false
      || finalStatus?.schedulingEnabled !== false
    ) {
      throw new Error('Production did not remain in the expected read-only watch mode.');
    }

    return {
      activated: true,
      candidateCount: rateLimited ? 0 : (poll.body?.data?.discovered ?? 0),
      targetUsername,
    };
  } catch (error) {
    if (resumed) {
      await mutation('/api/cubelic/admin/emergency-stop').catch(() => null);
    }
    throw error;
  }
}
