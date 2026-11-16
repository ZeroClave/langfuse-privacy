import { randomBytes } from 'node:crypto';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { createZeroClaveMask, DEFAULT_ZEROCLAVE_ENDPOINT } from '../../dist/index.js';

const REGION = /^[a-z]{2}-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const PROJECT = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/u;
const LOGSTORE = /^[a-z][a-z0-9_-]{1,61}[a-z0-9]$/u;
export const RUN_ID = /^[a-f0-9]{32}$/u;
const RETRYABLE = new Set([
  'InternalServerError', 'ServerBusy', 'RequestTimeout', 'ProjectQuotaExceed',
  'LogStoreReadQuotaExceed', 'LogStoreWriteQuotaExceed', 'TooManyRequests',
]);

export class SlsError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.name = 'SlsError';
    this.code = code;
    this.retryable = retryable;
  }
}

function integer(value, fallback, maximum) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new SlsError('sls_invalid_configuration');
  }
  return number;
}

/** Explicit credentials only. The cloud endpoint is derived, never supplied as a URL. */
export function slsConfig(env = process.env) {
  const required = ['SLS_REGION', 'SLS_PROJECT', 'SLS_LOGSTORE',
    'ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET'];
  if (required.some((key) => typeof env[key] !== 'string' || env[key].length === 0)) {
    throw new SlsError('sls_missing_configuration');
  }
  const config = {
    region: env.SLS_REGION, project: env.SLS_PROJECT, logstore: env.SLS_LOGSTORE,
    accessKeyId: env.ALIBABA_CLOUD_ACCESS_KEY_ID,
    accessKeySecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    maxConcurrentMasks: integer(env.SLS_MAX_CONCURRENT_MASKS, 4, 32),
    readbackTimeoutMs: integer(env.SLS_READBACK_TIMEOUT_MS, 60_000, 300_000),
    zeroClaveEndpoint: env.ZEROCLAVE_ENDPOINT || DEFAULT_ZEROCLAVE_ENDPOINT,
    zeroClaveTimeoutMs: integer(env.ZEROCLAVE_TIMEOUT_MS, 15_000, 60_000),
  };
  if (env.ALIBABA_CLOUD_SECURITY_TOKEN) config.securityToken = env.ALIBABA_CLOUD_SECURITY_TOKEN;
  validateSlsConfig(config);
  return config;
}

export function validateSlsConfig(config) {
  if (!config || typeof config !== 'object'
    || typeof config.region !== 'string' || config.region.length > 64 || !REGION.test(config.region)
    || typeof config.project !== 'string' || !PROJECT.test(config.project)
    || typeof config.logstore !== 'string' || !LOGSTORE.test(config.logstore)
    || typeof config.accessKeyId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(config.accessKeyId)
    || typeof config.accessKeySecret !== 'string' || !/^[\x21-\x7e]{1,512}$/u.test(config.accessKeySecret)
    || config.securityToken !== undefined && (typeof config.securityToken !== 'string'
      || !/^[\x21-\x7e]{1,8192}$/u.test(config.securityToken))) {
    throw new SlsError('sls_invalid_configuration');
  }
}

export function slsClientOptions(config) {
  config = { ...config };
  validateSlsConfig(config);
  return {
    endpoint: `https://${config.region}.log.aliyuncs.com`,
    use_https: true,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    ...(config.securityToken ? { securityToken: config.securityToken } : {}),
  };
}

/** Official SLS data SDK owns Protobuf encoding and permanent/STS request signing. */
export async function createSlsClient(config) {
  const options = slsClientOptions(config);
  // The SDK's debug namespaces can print signed headers, including an STS token.
  if (process.env.DEBUG?.trim()) throw new SlsError('sls_debug_logging_enabled');
  try {
    const module = await import('@alicloud/log');
    const Client = module.default ?? module;
    return new Client(options);
  } catch {
    throw new SlsError('sls_sdk_initialization_failed');
  }
}

/**
 * @alicloud/log returns only the body and does not reject every non-2xx response.
 * A standard Agent observes response metadata without replacing SDK signing or
 * HTTP transport. The HTTP branch is used only by explicitly injected test clients.
 * Test doubles may instead return { body, statusCode, headers }.
 */
export async function requestSls(client, invoke, { signal, timeoutMs = 10_000 } = {}) {
  if (signal?.aborted) throw new SlsError('sls_request_aborted');
  const BaseAgent = client.use_https === false ? HttpAgent : HttpsAgent;
  let metadata;
  let request;
  class ResponseAgent extends BaseAgent {
    addRequest(req, options) {
      request = req;
      req.once('response', (response) => {
        metadata = { statusCode: response.statusCode, headers: response.headers };
      });
      return super.addRequest(req, options);
    }
  }
  const agent = new ResponseAgent({ keepAlive: false, maxSockets: 1 });
  let timer;
  let onAbort;
  try {
    const interruption = new Promise((_, reject) => {
      onAbort = () => {
        request?.destroy();
        reject(new SlsError('sls_request_aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        request?.destroy();
        reject(new SlsError('sls_request_timeout', { retryable: true }));
      }, timeoutMs);
    });
    const result = await Promise.race([
      Promise.resolve().then(() => {
        if (signal?.aborted) throw new SlsError('sls_request_aborted');
        return invoke({ agent, timeout: timeoutMs });
      }), interruption,
    ]);
    // Explicit envelopes are a fixture seam; production uses Agent metadata.
    const envelope = !metadata && result && !Array.isArray(result) && typeof result === 'object'
      && Object.hasOwn(result, 'body') && Number.isSafeInteger(result.statusCode)
      ? result : undefined;
    const response = metadata ?? envelope;
    if (!response || !Number.isSafeInteger(response.statusCode)) {
      throw new SlsError('sls_invalid_response');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new SlsError('sls_request_failed', {
        retryable: response.statusCode === 429 || response.statusCode >= 500,
      });
    }
    return { body: envelope ? envelope.body : result, headers: response.headers ?? {} };
  } catch (error) {
    if (error instanceof SlsError) throw error;
    throw new SlsError('sls_request_failed', {
      retryable: metadata?.statusCode === 429 || metadata?.statusCode >= 500 || RETRYABLE.has(error?.code),
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    agent.destroy();
  }
}

/**
 * Mask the whole document before sending one log. Capacity exhaustion rejects
 * immediately; there is no raw-text waiting queue or original-data fallback.
 * JSON object keys are schema names and must never contain user-provided PII.
 */
export function createSlsWriter(config, { client, maskOptions = {} } = {}) {
  config = { ...config };
  validateSlsConfig(config);
  const limit = integer(config.maxConcurrentMasks, 4, 32);
  const mask = createZeroClaveMask({
    endpoint: config.zeroClaveEndpoint,
    timeoutMs: config.zeroClaveTimeoutMs,
    ...maskOptions, maxRetries: 0,
  });
  let pendingClient;
  const getClient = () => pendingClient ??= client ? Promise.resolve(client) : createSlsClient(config);
  let active = 0;
  return async function write(data, { runId = randomBytes(16).toString('hex'),
    timestamp = Math.floor(Date.now() / 1000) } = {}) {
    if (typeof runId !== 'string' || !RUN_ID.test(runId)
      || !Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff) {
      throw new SlsError('sls_invalid_write_options');
    }
    if (active >= limit) throw new SlsError('sls_mask_capacity_exceeded');
    active++;
    try {
      let masked;
      try { masked = await mask({ data }); }
      catch { throw new SlsError('sls_mask_failed'); }
      let payload;
      try { payload = JSON.stringify(masked); }
      catch { throw new SlsError('sls_invalid_payload'); }
      if (typeof payload !== 'string' || Buffer.byteLength(payload) > 1_000_000) {
        throw new SlsError('sls_invalid_payload');
      }
      const api = await getClient();
      const response = await requestSls(api, (options) => api.postLogStoreLogs(
        config.project, config.logstore, {
          logs: [{ timestamp, content: { runId, payload, schemaVersion: '1', service: 'zeroclave-sls-demo' } }],
          topic: 'zeroclave-privacy-demo', source: 'zeroclave-node-example',
        }, options,
      ));
      if (response.body !== '') throw new SlsError('sls_invalid_response');
      return { runId, timestamp, accepted: true };
    } catch (error) {
      if (error instanceof SlsError) throw error;
      throw new SlsError('sls_write_failed');
    } finally { active--; }
  };
}
