import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clsConfig, createClsExporter, createClsSpanProcessor } from './cls.mjs';
import { waitForClsRecord } from './readback.mjs';

export const FIELDS = {
  input: 'langfuse.observation.input',
  output: 'langfuse.observation.output',
  metadata: 'langfuse.observation.metadata.details',
};
export const CANARIES = ['张三', '13800138000', 'alice@example.com'];
const FAILURE_MASK = '<fully masked due to failed mask function>';
const REPORT = new URL('../../.local/cls-live-test-report.json', import.meta.url);

function object(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); }
    catch { throw new Error('cls_invalid_stored_fields'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('cls_invalid_stored_fields');
  return value;
}

function attribute(attributes, key) {
  if (Object.hasOwn(attributes, key)) return attributes[key];
  return key.split('.').reduce((value, part) => value && typeof value === 'object' ? value[part] : undefined, attributes);
}

/** Validate what the receiver stored, never a local preview of masked attributes. */
export function verifyClsRecord(record, { traceId, spanId }) {
  if ((record.traceID ?? record.traceId) !== traceId || (record.spanID ?? record.spanId) !== spanId) {
    throw new Error('cls_record_mismatch');
  }
  const serialized = JSON.stringify(record);
  if (CANARIES.some((text) => serialized.includes(text))) throw new Error('cls_canary_remaining');
  if (serialized.includes(FAILURE_MASK)) throw new Error('cls_detection_incomplete');
  const attributes = object(record.attribute ?? record.attributes);
  const input = object(attribute(attributes, FIELDS.input));
  const output = object(attribute(attributes, FIELDS.output));
  const metadataValue = attribute(attributes, FIELDS.metadata)
    ?? object(attribute(attributes, 'langfuse.observation.metadata')).details;
  const metadata = object(metadataValue);
  // Nested JSON can encode a canary as Unicode escapes. Scan decoded values too.
  const decoded = JSON.stringify({ input, output, metadata });
  if (CANARIES.some((text) => decoded.includes(text))) throw new Error('cls_canary_remaining');
  if (decoded.includes(FAILURE_MASK)) throw new Error('cls_detection_incomplete');
  if (input.messages?.[0]?.role !== 'user' || !input.messages?.[0]?.content?.startsWith('😀')
    || !input.messages[0].content.includes('请联系该客户') || output.count !== 1 || metadata.enabled !== true) {
    throw new Error('cls_structure_not_preserved');
  }
  for (const text of [input.messages[0].content, output.reply, metadata.customer]) {
    if (typeof text !== 'string' || !/\[REDACTED_[A-Z][A-Z0-9_]*\]/u.test(text)) {
      throw new Error('cls_mask_not_observed');
    }
  }
  return { input, output, metadata };
}

export async function runClsExample(config, { maskOptions, exporter, search, readbackTimeoutMs = config.readbackTimeoutMs } = {}) {
  const transport = exporter ?? createClsExporter(config);
  const exports = { succeeded: 0, failed: 0 };
  const trackedExporter = {
    export(spans, callback) {
      transport.export(spans, (result) => {
        if (result.code === 0) exports.succeeded++;
        else exports.failed++;
        callback(result);
      });
    },
    shutdown: () => transport.shutdown(),
    ...(transport.forceFlush ? { forceFlush: () => transport.forceFlush() } : {}),
  };
  const processor = createClsSpanProcessor(config, { maskOptions, exporter: trackedExporter });
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'zeroclave-cls-demo' }),
    spanProcessors: [processor],
  });
  const startedAt = Date.now();
  let failed = false;
  try {
    const span = provider.getTracer('zeroclave-cls-example').startSpan('synthetic-privacy-test');
    const { traceId, spanId } = span.spanContext();
    span.setAttributes({
      'langfuse.observation.type': 'span',
      [FIELDS.input]: JSON.stringify({
        messages: [{ role: 'user', content: '😀虚构测试客户张三，联系电话13800138000，邮箱alice@example.com。请联系该客户。' }],
      }),
      [FIELDS.output]: JSON.stringify({ reply: '已记录虚构客户张三，邮箱alice@example.com。', count: 1 }),
      [FIELDS.metadata]: JSON.stringify({ customer: '虚构客户张三的邮箱是alice@example.com。', enabled: true }),
    });
    span.end();
    try { await provider.forceFlush(); }
    catch { throw new Error('cls_export_failed'); }
    if (exports.failed || exports.succeeded !== 1) throw new Error('cls_export_failed');
    const records = await waitForClsRecord(config, {
      traceId, spanId, from: startedAt - 60_000, to: Date.now() + 60_000,
      timeoutMs: readbackTimeoutMs, ...(search ? { search } : {}),
    });
    const stored = records.map((record) => verifyClsRecord(record, { traceId, spanId }));
    if (!stored.length) throw new Error('cls_record_not_found');
    return {
      testedAt: new Date().toISOString(), passed: true,
      mode: exporter || search ? 'local-collector' : 'cls-cloud',
      persisted: true, cloudPersisted: !exporter && !search,
      traceId, spanId, region: config.region, topicId: config.topicId,
      checks: { exportAcknowledged: true, matchingStoredRecord: true, syntheticCanariesRemoved: true,
        completeMasking: true, jsonAndUnicodePreserved: true },
      stored: stored[0],
    };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await provider.shutdown(); }
    catch { if (!failed) throw new Error('cls_export_failed'); }
  }
}

export async function writeClsReport(report, url = REPORT) {
  await mkdir(new URL('./', url), { recursive: true });
  await writeFile(url, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report;
  try {
    try { process.loadEnvFile(fileURLToPath(new URL('../../.env.cls', import.meta.url))); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('cls_env_file_failed'); }
    console.log('Synthetic fixtures → ZeroClave → OTLP/protobuf → CLS → SearchLog read-back');
    report = await runClsExample(clsConfig());
    console.log(`PASS: CLS returned the matching masked trace ${report.traceId}, span ${report.spanId}.`);
    console.log(JSON.stringify(report.stored, null, 2));
  } catch (error) {
    const code = [error?.code, error?.message].find((value) => typeof value === 'string' && /^cls_[a-z_]+$/u.test(value))
      ?? 'cls_example_failed';
    report = { testedAt: new Date().toISOString(), passed: false, persisted: false, cloudPersisted: false,
      mode: 'cls-cloud', failure: code };
    console.error(`FAIL: ${code}. See docs/tencent-cls.md; no cloud success is claimed.`);
    process.exitCode = 1;
  }
  await writeClsReport(report);
  console.log(`Report: ${fileURLToPath(REPORT)}`);
}
