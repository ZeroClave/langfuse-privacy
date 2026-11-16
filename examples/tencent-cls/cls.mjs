import { LangfuseSpanProcessor } from '@langfuse/otel';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { createZeroClaveMask, DEFAULT_ZEROCLAVE_ENDPOINT } from '../../dist/index.js';

const REGION = /^[a-z]{2}-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const TOPIC = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

function integer(value, fallback, maximum) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error('cls_invalid_configuration');
  }
  return number;
}

/** Read explicit CLS credentials only; never derive a credential-bearing URL from user input. */
export function clsConfig(env = process.env) {
  const required = ['CLS_DEFAULT_REGION', 'CLS_TOPIC_ID', 'TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY'];
  if (required.some((key) => typeof env[key] !== 'string' || !env[key])) {
    throw new Error('cls_missing_configuration');
  }
  const config = {
    region: env.CLS_DEFAULT_REGION,
    topicId: env.CLS_TOPIC_ID,
    secretId: env.TENCENTCLOUD_SECRET_ID,
    secretKey: env.TENCENTCLOUD_SECRET_KEY,
    maxConcurrentMasks: integer(env.CLS_MAX_CONCURRENT_MASKS, 4, 32),
    readbackTimeoutMs: integer(env.CLS_READBACK_TIMEOUT_MS, 60_000, 60_000),
    zeroClaveEndpoint: env.ZEROCLAVE_ENDPOINT || DEFAULT_ZEROCLAVE_ENDPOINT,
    zeroClaveTimeoutMs: integer(env.ZEROCLAVE_TIMEOUT_MS, 15_000, 60_000),
  };
  if (!REGION.test(config.region) || config.region.length > 64 || !TOPIC.test(config.topicId)
    || !/^[A-Za-z0-9_-]{1,256}$/u.test(config.secretId)
    || !/^[\x21-\x7e]{1,512}$/u.test(config.secretKey) || config.secretKey.includes(':')) {
    throw new Error('cls_invalid_configuration');
  }
  if (env.TENCENTCLOUD_TOKEN) {
    if (typeof env.TENCENTCLOUD_TOKEN !== 'string'
      || !/^[\x21-\x7e]{1,8192}$/u.test(env.TENCENTCLOUD_TOKEN) || env.TENCENTCLOUD_TOKEN.includes(':')) {
      throw new Error('cls_invalid_configuration');
    }
    config.token = env.TENCENTCLOUD_TOKEN;
  }
  return config;
}

/** Tencent's OTLP Basic format differs for permanent and STS credentials. */
export function clsExporterOptions(config) {
  const user = config.token ? `${config.secretId}#${config.token}` : config.secretId;
  return {
    url: `https://${config.region}.cls.tencentcs.com/v1/traces`,
    headers: {
      Authorization: `Basic ${Buffer.from(`${user}:${config.secretKey}`, 'utf8').toString('base64')}`,
      topic_id: config.topicId,
    },
    timeoutMillis: 10_000,
    concurrencyLimit: 2,
    compression: 'none',
  };
}

export function createClsExporter(config) {
  return new OTLPTraceExporter(clsExporterOptions(config));
}

/**
 * Example integration, not a general OTLP scrubber. Reuse one processor per app.
 * There is no waiting queue for detection: capacity exhaustion fully masks the
 * supported field through Langfuse's error handling instead of retaining raw text.
 */
export function createClsSpanProcessor(config, { maskOptions = {}, exporter } = {}) {
  const mask = createZeroClaveMask({
    endpoint: config.zeroClaveEndpoint,
    timeoutMs: config.zeroClaveTimeoutMs,
    maxRetries: 0,
    ...maskOptions,
  });
  const limit = integer(config.maxConcurrentMasks, 4, 32);
  let active = 0;
  return new LangfuseSpanProcessor({
    exporter: exporter ?? createClsExporter(config),
    exportMode: 'immediate',
    mediaUploadEnabled: false,
    shouldExportSpan: () => true,
    mask: async (params) => {
      if (active >= limit) throw new Error('cls_mask_capacity_exceeded');
      active++;
      try { return await mask(params); }
      finally { active--; }
    },
  });
}
