export function langfuseConfig(value = {}) {
  const config = {
    baseUrl: value.baseUrl ?? process.env.LANGFUSE_BASE_URL,
    uiUrl: value.uiUrl ?? process.env.LANGFUSE_UI_URL ?? value.baseUrl ?? process.env.LANGFUSE_BASE_URL,
    publicKey: value.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: value.secretKey ?? process.env.LANGFUSE_SECRET_KEY,
    projectId: value.projectId ?? process.env.LANGFUSE_PROJECT_ID,
  };
  if (Object.values(config).some((item) => typeof item !== 'string' || !item)
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(config.projectId)) {
    throw new Error('Langfuse project configuration is required for the browser demo.');
  }
  for (const key of ['baseUrl', 'uiUrl']) {
    const url = new URL(config[key]);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid Langfuse URL.');
    }
    config[key] = url.toString().replace(/\/$/u, '');
  }
  return config;
}

function pause(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(new Error('Langfuse persistence confirmation cancelled.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

export async function waitForObservation(config, { traceId, spanId, startTime, signal }) {
  const url = new URL(`${config.baseUrl}/api/public/v2/observations`);
  url.searchParams.set('traceId', traceId);
  url.searchParams.set('fields', 'core,basic,io,metadata');
  url.searchParams.set('fromStartTime', new Date(startTime - 60_000).toISOString());
  url.searchParams.set('toStartTime', new Date(startTime + 300_000).toISOString());
  url.searchParams.set('limit', '10');
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  const authorization = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64')}`;
  while (!deadline.aborted) {
    try {
      const response = await fetch(url, {
        headers: { authorization },
        cache: 'no-store', redirect: 'error', signal: deadline,
      });
      if ([400, 401, 403].includes(response.status)) {
        await response.body?.cancel();
        throw new Error('langfuse_configuration_error');
      }
      if (response.ok) {
        const body = await response.json();
        const observation = body?.data?.find((item) => item.id === spanId && item.traceId === traceId);
        if (observation) return observation;
        const cursor = body?.meta?.cursor;
        if (typeof cursor === 'string' && cursor && cursor !== url.searchParams.get('cursor')) {
          url.searchParams.set('cursor', cursor);
          continue;
        }
      } else {
        await response.body?.cancel();
      }
    } catch (error) {
      if (error?.message === 'langfuse_configuration_error') throw error;
      if (deadline.aborted) break;
    }
    url.searchParams.delete('cursor');
    await pause(500, deadline);
  }
  throw new Error('Langfuse did not confirm persistence within the time limit.');
}

export function traceUrl(config, traceId) {
  return `${config.uiUrl}/project/${encodeURIComponent(config.projectId)}/traces/${traceId}`;
}
