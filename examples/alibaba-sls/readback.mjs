import { createSlsClient, requestSls, RUN_ID, SlsError, validateSlsConfig } from './sls.mjs';

const PAGE_SIZE = 100;
const MAX_PAGES = 32;

function queryOptions({ runId, from, to }) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)
    || !Number.isSafeInteger(from) || from < 0
    || !Number.isSafeInteger(to) || to <= from
    || !Number.isFinite(new Date(from).getTime()) || !Number.isFinite(new Date(to).getTime())) {
    throw new SlsError('sls_readback_invalid_options');
  }
  return { runId, from, to };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createSlsReader(config, { client } = {}) {
  config = { ...config };
  validateSlsConfig(config);
  let pendingClient;
  const getClient = () => pendingClient ??= client ? Promise.resolve(client) : createSlsClient(config);
  return async function search({ runId, from, to, signal } = {}) {
    const query = queryOptions({ runId, from, to });
    if (signal?.aborted) throw new SlsError('sls_readback_aborted');
    let api;
    try { api = await getClient(); }
    catch (error) {
      if (error instanceof SlsError) throw error;
      throw new SlsError('sls_readback_failed');
    }
    const found = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const { body, headers } = await requestSls(api, (options) => api.getLogs(
        config.project, config.logstore, new Date(query.from), new Date(query.to), {
          query: `runId:"${query.runId}"`, line: PAGE_SIZE, offset: page * PAGE_SIZE,
          reverse: false,
        }, options,
      ), { signal });
      if (!Array.isArray(body) || body.length > PAGE_SIZE) throw new SlsError('sls_readback_invalid_response');
      // Never accept an exact row from a partial query: restart the search later.
      if (headers['x-log-progress'] === 'Incomplete') {
        throw new SlsError('sls_readback_incomplete', { retryable: true });
      }
      if (headers['x-log-progress'] !== 'Complete') throw new SlsError('sls_readback_invalid_response');
      for (const row of body) {
        if (!isRecord(row)) throw new SlsError('sls_readback_invalid_response');
        if (row.runId === query.runId) found.push(row);
      }
      if (body.length < PAGE_SIZE) return found;
    }
    throw new SlsError('sls_readback_too_many_pages');
  };
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new SlsError('sls_readback_aborted'));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted();
  });
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      reject(new SlsError('sls_readback_aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** Query until this run's record is indexed; no record means no persistence claim. */
export async function waitForSlsRecord(config, {
  runId, from, to, signal, search,
  timeoutMs = config.readbackTimeoutMs ?? 60_000, pollIntervalMs = 1_000,
} = {}) {
  const query = queryOptions({ runId, from, to });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 10_000
    || search !== undefined && typeof search !== 'function') {
    throw new SlsError('sls_readback_invalid_options');
  }
  const reader = search ?? createSlsReader(config);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    for (;;) {
      if (combined.aborted) throw new SlsError('sls_readback_aborted');
      try {
        const records = await abortable(reader({ ...query, signal: combined }), combined);
        if (!Array.isArray(records) || records.some((record) => !isRecord(record))) {
          throw new SlsError('sls_readback_invalid_response');
        }
        const exact = records.filter((record) => record.runId === query.runId);
        if (exact.length > 0) return exact;
      } catch (error) {
        if (!(error instanceof SlsError)) throw new SlsError('sls_readback_failed');
        if (!error.retryable) throw error;
      }
      await delay(pollIntervalMs, combined);
    }
  } catch (error) {
    if (deadline.signal.aborted && !signal?.aborted) throw new SlsError('sls_readback_timeout');
    throw error;
  } finally { clearTimeout(timer); }
}
