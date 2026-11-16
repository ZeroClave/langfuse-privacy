// Read-back verification uses Tencent's official API 3.0 SDK for TC3 signing.
// It is an example/development dependency, not part of the privacy package.
const API_ENDPOINT = 'cls.tencentcloudapi.com';
const MAX_PAGES = 32;
const SAFE_CLOUD_CODES = new Set([
  'AuthFailure', 'AuthFailure.InvalidSecretId', 'AuthFailure.SecretIdNotFound',
  'AuthFailure.SignatureFailure', 'AuthFailure.SignatureExpire',
  'AuthFailure.TokenFailure', 'AuthFailure.TokenExpire',
  'UnauthorizedOperation', 'UnauthorizedOperation.ClsAccessDenied',
  'ResourceNotFound', 'ResourceNotFound.TopicNotExist',
  'InvalidParameter', 'InvalidParameterValue', 'MissingParameter',
  'InternalError', 'RequestLimitExceeded', 'LimitExceeded',
  'LimitExceeded.ConcurrentSearch', 'ResourceUnavailable',
]);
const RETRYABLE_CLOUD_CODES = new Set([
  'InternalError', 'RequestLimitExceeded', 'LimitExceeded',
  'LimitExceeded.ConcurrentSearch', 'ResourceUnavailable',
]);

export class ClsReadbackError extends Error {
  constructor(code, cloudCode) {
    super(`CLS read-back verification failed (${code}).`);
    this.name = 'ClsReadbackError';
    this.code = code;
    if (SAFE_CLOUD_CODES.has(cloudCode)) this.cloudCode = cloudCode;
    this.retryable = RETRYABLE_CLOUD_CODES.has(this.cloudCode);
  }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedKey(key) {
  return key.replaceAll('_', '').toLowerCase();
}

function idValue(value, name) {
  if (!record(value)) return undefined;
  const values = Object.entries(value)
    .filter(([key]) => normalizedKey(key) === name)
    .map(([, item]) => typeof item === 'string' ? item.toLowerCase() : undefined);
  return values.length > 0 && values[0] !== undefined && values.every((item) => item === values[0])
    ? values[0] : undefined;
}

function matches(value, traceId, spanId) {
  return idValue(value, 'traceid') === traceId && idValue(value, 'spanid') === spanId;
}

function parseRecord(value) {
  let parsed = value;
  try {
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    if (!record(parsed)) throw new Error();
    const result = { ...parsed };
    for (const key of Object.keys(result)) {
      if (!['attribute', 'attributes', 'resource'].includes(key.toLowerCase())) continue;
      if (typeof result[key] === 'string') result[key] = JSON.parse(result[key]);
      if (!record(result[key])) throw new Error();
    }
    return result;
  } catch {
    throw new ClsReadbackError('cls_readback_invalid_response');
  }
}

function queryOptions({ traceId, spanId, from, to }) {
  if (typeof traceId !== 'string' || !/^[a-f0-9]{32}$/iu.test(traceId)
    || typeof spanId !== 'string' || !/^[a-f0-9]{16}$/iu.test(spanId)
    || !Number.isSafeInteger(from) || from < 0
    || !Number.isSafeInteger(to) || to <= from) {
    throw new ClsReadbackError('cls_readback_invalid_options');
  }
  return { traceId: traceId.toLowerCase(), spanId: spanId.toLowerCase(), from, to };
}

function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new ClsReadbackError('cls_readback_aborted'));
    if (signal.aborted) {
      Promise.resolve(promise).catch(() => {});
      aborted();
      return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted));
  });
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      reject(new ClsReadbackError('cls_readback_aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/**
 * Return a narrowly scoped SearchLog reader. The optional client is for tests.
 * Credentials are only passed to Tencent's SDK; remote error bodies are discarded.
 */
export function createClsReader(config, { client } = {}) {
  if (!record(config) || !['region', 'topicId', 'secretId', 'secretKey']
    .every((key) => typeof config[key] === 'string' && config[key].trim().length > 0)
    || config.token !== undefined && typeof config.token !== 'string') {
    throw new ClsReadbackError('cls_readback_invalid_options');
  }
  const { region, topicId, secretId, secretKey, token } = config;
  let sdkClient;
  const getClient = () => {
    sdkClient ??= client ? Promise.resolve(client) : import('tencentcloud-sdk-nodejs-cls').then((module) => {
      const sdk = module.default ?? module;
      return new sdk.cls.v20201016.Client({
        credential: { secretId, secretKey, ...(token ? { token } : {}) },
        region,
        profile: {
          signMethod: 'TC3-HMAC-SHA256',
          httpProfile: { endpoint: API_ENDPOINT, protocol: 'https://', reqTimeout: 10 },
        },
      });
    });
    return sdkClient;
  };

  return async function search({ traceId, spanId, from, to, signal } = {}) {
    const query = queryOptions({ traceId, spanId, from, to });
    if (signal?.aborted) throw new ClsReadbackError('cls_readback_aborted');
    const params = {
      TopicId: topicId,
      From: query.from,
      To: query.to,
      QueryString: `traceID:"${query.traceId}" AND spanID:"${query.spanId}"`,
      QuerySyntax: 1,
      Limit: 100,
      Sort: 'asc',
      HighLight: false,
    };
    const found = [];
    const contexts = new Set();
    let context;
    for (let page = 0; page < MAX_PAGES; page++) {
      let response;
      try {
        const api = await abortable(getClient(), signal);
        if (signal?.aborted) throw new ClsReadbackError('cls_readback_aborted');
        response = await abortable(api.SearchLog({ ...params, ...(context ? { Context: context } : {}) }), signal);
      } catch (error) {
        if (error instanceof ClsReadbackError) throw error;
        throw new ClsReadbackError('cls_readback_failed', error?.code);
      }
      // SDK returns the unwrapped object; accepting Response also supports fixtures.
      const payload = record(response?.Response) ? response.Response : response;
      if (!record(payload) || payload.Error || payload.Analysis === true
        || payload.Results !== null && !Array.isArray(payload.Results)) {
        throw new ClsReadbackError('cls_readback_invalid_response');
      }
      for (const row of payload.Results ?? []) {
        if (!record(row) || typeof row.LogJson !== 'string') {
          throw new ClsReadbackError('cls_readback_invalid_response');
        }
        const parsed = parseRecord(row.LogJson);
        if (matches(parsed, query.traceId, query.spanId)) found.push(parsed);
      }
      if (payload.ListOver === true) return found;
      if (typeof payload.Context !== 'string' || payload.Context.length === 0
        || contexts.has(payload.Context)) {
        throw new ClsReadbackError('cls_readback_invalid_response');
      }
      context = payload.Context;
      contexts.add(context);
    }
    throw new ClsReadbackError('cls_readback_too_many_pages');
  };
}

/** Poll cloud SearchLog until the exact trace AND span are returned, or reject. */
export async function waitForClsRecord(config, {
  traceId, spanId, from, to, signal, search,
  timeoutMs = 60_000, pollIntervalMs = 1_000,
} = {}) {
  const query = queryOptions({ traceId, spanId, from, to });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 10_000
    || search !== undefined && typeof search !== 'function') {
    throw new ClsReadbackError('cls_readback_invalid_options');
  }
  const reader = search ?? createClsReader(config);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    for (;;) {
      if (combined.aborted) throw new ClsReadbackError('cls_readback_aborted');
      try {
        const results = await abortable(reader({ ...query, signal: combined }), combined);
        if (!Array.isArray(results)) throw new ClsReadbackError('cls_readback_invalid_response');
        const exact = results.filter((item) => matches(item, query.traceId, query.spanId));
        if (exact.length > 0) return exact.map(parseRecord);
      } catch (error) {
        if (!(error instanceof ClsReadbackError)) throw new ClsReadbackError('cls_readback_failed');
        if (!error.retryable) throw error;
      }
      await delay(pollIntervalMs, combined);
    }
  } catch (error) {
    if (deadline.signal.aborted && !signal?.aborted) throw new ClsReadbackError('cls_readback_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
