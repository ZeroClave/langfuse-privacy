import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { BasicTracerProvider, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { createZeroClaveMask, DEFAULT_ZEROCLAVE_ENDPOINT } from '../dist/index.js';

// This manual test sends only these synthetic fixtures to the real detector.
// The Langfuse exporter stays in memory; no Langfuse account or keys are needed.
const endpoint = process.env.ZEROCLAVE_ENDPOINT ?? DEFAULT_ZEROCLAVE_ENDPOINT;
const timeoutMs = Number(process.env.ZEROCLAVE_TIMEOUT_MS ?? 10_000);
const input = {
  messages: [{ role: 'user', content: '😀虚构测试客户张三，联系电话13800138000，邮箱alice@example.com。请联系该客户。' }],
};
const output = { reply: '已记录虚构客户张三，邮箱alice@example.com。', count: 1 };
const metadata = { customer: '虚构客户张三的邮箱是alice@example.com。', enabled: true };
const INPUT = 'langfuse.observation.input';
const OUTPUT = 'langfuse.observation.output';
const METADATA = 'langfuse.observation.metadata.details';
const FAILURE_MASK = '<fully masked due to failed mask function>';
const directory = new URL('../.local/', import.meta.url);
const reportUrl = new URL('live-test-report.json', directory);
const report = {
  testedAt: new Date().toISOString(),
  passed: false,
  checks: {},
  requests: [],
};

async function observedFetch(url, init) {
  const startedAt = performance.now();
  const request = { httpStatus: null, durationMs: 0 };
  report.requests.push(request);
  try {
    const response = await fetch(url, init);
    request.httpStatus = response.status;
    // Observe protocol diagnostics without logging the original text or response body.
    const body = await response.clone().json().catch(() => null);
    if (body && typeof body === 'object') {
      request.requestId = body.request_id;
      request.modelVersion = body.model_version;
      if (Array.isArray(body.results)) {
        request.statuses = body.results.map((result) => result.status);
        request.entityCount = body.results.reduce((total, result) => total + (result.entities?.length ?? 0), 0);
      }
    }
    return response;
  } catch (error) {
    const code = error?.cause?.code;
    request.transportCode = typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : 'FETCH_FAILED';
    throw error;
  } finally {
    request.durationMs = Math.round(performance.now() - startedAt);
  }
}

function verifyText(value, expected, label) {
  assert.ok(!value.includes(FAILURE_MASK), `${label}: detection failed; full-field masking is not a successful live test`);
  assert.ok(value.includes('[REDACTED_'), `${label}: no entities were masked`);
  for (const canary of expected) {
    assert.ok(!value.includes(canary), `${label}: synthetic canary remains (${canary}); review detector recall`);
  }
}

let provider;
try {
  const mask = createZeroClaveMask({ endpoint, timeoutMs, maxRetries: 0, fetch: observedFetch });
  const exporter = new InMemorySpanExporter();
  const processor = new LangfuseSpanProcessor({
    exporter,
    exportMode: 'immediate',
    mediaUploadEnabled: false,
    shouldExportSpan: () => true,
    mask,
  });
  provider = new BasicTracerProvider({ spanProcessors: [processor] });

  console.log('Testing: synthetic fixtures → real ZeroClave detector → Langfuse SDK → in-memory exporter');
  console.log(`Endpoint: ${new URL(endpoint).origin} (timeout ${timeoutMs} ms per hook; no retries)`);
  const span = provider.getTracer('zeroclave-live-test').startSpan('synthetic-privacy-test');
  span.setAttributes({
    [INPUT]: JSON.stringify(input),
    [OUTPUT]: JSON.stringify(output),
    [METADATA]: JSON.stringify(metadata),
  });
  span.end();
  await provider.forceFlush();

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1, 'the actual Langfuse processor must export exactly one span');
  const attributes = spans[0].attributes;
  for (const key of [INPUT, OUTPUT, METADATA]) {
    assert.equal(typeof attributes[key], 'string', `missing field: ${key}`);
    assert.ok(!attributes[key].includes(FAILURE_MASK), `${key}: detection failed; inspect request diagnostics`);
  }
  assert.ok(report.requests.length > 0, 'the test must contact the actual detector');
  assert.ok(report.requests.every((request) => request.httpStatus === 200
    && request.statuses?.length > 0 && request.statuses.every((status) => status === 'complete')),
  'all real detection requests must complete successfully');
  report.checks.serviceAndSdk = true;

  const maskedInput = JSON.parse(attributes[INPUT]);
  const maskedOutput = JSON.parse(attributes[OUTPUT]);
  const maskedMetadata = JSON.parse(attributes[METADATA]);
  assert.equal(maskedInput.messages[0].role, 'user');
  assert.ok(maskedInput.messages[0].content.startsWith('😀'));
  assert.equal(maskedOutput.count, 1);
  assert.equal(maskedMetadata.enabled, true);
  report.checks.jsonAndUnicode = true;

  verifyText(maskedInput.messages[0].content, ['张三', '13800138000', 'alice@example.com'], 'input');
  verifyText(maskedOutput.reply, ['张三', 'alice@example.com'], 'output');
  verifyText(maskedMetadata.customer, ['张三', 'alice@example.com'], 'metadata');
  report.checks.syntheticCanaries = true;
  report.masked = { input: maskedInput, output: maskedOutput, metadata: maskedMetadata };
  report.passed = true;
  console.log('PASS: real service, complete detection, JSON/emoji preservation, and synthetic canaries.');
  console.log(JSON.stringify(report.masked, null, 2));
} catch (error) {
  report.failure = error instanceof Error ? error.message : 'Live test failed.';
  console.error(`FAIL: ${report.failure}`);
  process.exitCode = 1;
} finally {
  await provider?.shutdown();
  await mkdir(directory, { recursive: true });
  await writeFile(reportUrl, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`Report: ${fileURLToPath(reportUrl)}`);
  console.log(JSON.stringify(report.requests, null, 2));
}
