import test from 'node:test';
import assert from 'node:assert/strict';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { clsConfig, clsExporterOptions, createClsSpanProcessor } from '../examples/tencent-cls/cls.mjs';
import { startOtlpCollector } from './helpers/otlp-collector.mjs';

const EMAIL = 'synthetic.customer@example.com';
const INPUT = 'langfuse.observation.input';
const OUTPUT = 'langfuse.observation.output';
const METADATA = 'langfuse.observation.metadata.details';
const FAILURE_MASK = '<fully masked due to failed mask function>';
const ENV = {
  CLS_DEFAULT_REGION: 'ap-guangzhou',
  CLS_TOPIC_ID: '11111111-2222-4333-8444-555555555555',
  TENCENTCLOUD_SECRET_ID: 'AKID_SYNTHETIC_TEST_ONLY',
  TENCENTCLOUD_SECRET_KEY: 'syntheticKeyNotARealCredential',
};

function detector({ status = 'complete' } = {}) {
  return async (_url, init) => {
    const { texts } = JSON.parse(init.body);
    const requestId = new Headers(init.headers).get('x-request-id');
    return Response.json({
      request_id: requestId,
      model_version: 'test-only',
      results: texts.map(({ id, revision, text }) => {
        const offset = text.indexOf(EMAIL);
        const start = Array.from(text.slice(0, offset)).length;
        return {
          id, revision, status,
          entities: offset < 0 || status !== 'complete' ? []
            : [{ start, end: start + EMAIL.length, type: 'EMAIL' }],
        };
      }),
    });
  };
}

function attributes() {
  return {
    [INPUT]: JSON.stringify({ messages: [{ role: 'user', content: `😀请联系${EMAIL}` }] }),
    [OUTPUT]: JSON.stringify({ reply: `Contact ${EMAIL}`, count: 7 }),
    [METADATA]: JSON.stringify({ customer: EMAIL, enabled: true }),
  };
}

async function withPipeline(run, { env = ENV, fetcher = detector(), status = 200, maskTimeoutMs = 1000, config: overrides = {} } = {}) {
  const config = { ...clsConfig(env), ...overrides };
  const collector = await startOtlpCollector({ status });
  const exportResults = [];
  const target = new OTLPTraceExporter({ ...clsExporterOptions(config), url: collector.url, compression: 'none' });
  const exporter = {
    export(spans, callback) {
      target.export(spans, (result) => {
        exportResults.push(result.code);
        callback(result);
      });
    },
    shutdown: () => target.shutdown(),
  };
  const processor = createClsSpanProcessor(config, {
    exporter,
    maskOptions: { fetch: fetcher, timeoutMs: maskTimeoutMs, maxRetries: 0 },
  });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  try {
    await run({ config, collector, exportResults, provider });
  } finally {
    await provider.shutdown().catch(() => {});
    await collector.close();
  }
}

for (const token of [undefined, 'syntheticTemporaryToken']) {
  test(`CLS OTLP protobuf contains masked JSON only with ${token ? 'STS' : 'long-lived'} authentication`, async () => {
    const env = { ...ENV, ...(token ? { TENCENTCLOUD_TOKEN: token } : {}) };
    await withPipeline(async ({ collector, provider, exportResults }) => {
      const span = provider.getTracer('cls-contract-test').startSpan('synthetic-privacy-test');
      const context = span.spanContext();
      span.setAttributes(attributes());
      span.end();
      await provider.forceFlush();

      assert.deepEqual(exportResults, [0]);
      assert.equal(collector.requests.length, 1);
      const request = collector.requests[0];
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/traces');
      assert.equal(request.headers['content-type'], 'application/x-protobuf');
      assert.equal(request.headers.topic_id, ENV.CLS_TOPIC_ID);
      const user = token ? `${ENV.TENCENTCLOUD_SECRET_ID}#${token}` : ENV.TENCENTCLOUD_SECRET_ID;
      assert.equal(request.headers.authorization, `Basic ${Buffer.from(`${user}:${ENV.TENCENTCLOUD_SECRET_KEY}`).toString('base64')}`);
      assert.ok(!request.body.includes(Buffer.from(EMAIL)), 'the actual protobuf payload must not contain the original canary');

      assert.equal(collector.records.length, 1);
      const record = collector.records[0];
      assert.equal(record.traceID, context.traceId);
      assert.equal(record.spanID, context.spanId);
      const input = JSON.parse(record.attribute[INPUT]);
      const output = JSON.parse(record.attribute[OUTPUT]);
      const metadata = JSON.parse(record.attribute[METADATA]);
      assert.equal(input.messages[0].content, '😀请联系[REDACTED_EMAIL]');
      assert.equal(input.messages[0].role, 'user');
      assert.deepEqual(output, { reply: 'Contact [REDACTED_EMAIL]', count: 7 });
      assert.deepEqual(metadata, { customer: '[REDACTED_EMAIL]', enabled: true });
      assert.ok(!JSON.stringify(record).includes(EMAIL));
    }, { env });
  });
}

for (const [scenario, fetcher] of [
  ['partial detection', detector({ status: 'partial' })],
  ['transport exception', async () => { throw new Error(`Do not expose ${EMAIL}`); }],
  ['detection timeout', () => new Promise(() => {})],
]) {
  test(`CLS protobuf fails closed after ${scenario}`, async () => {
    await withPipeline(async ({ provider, collector }) => {
      const span = provider.getTracer('cls-contract-test').startSpan('synthetic-failure-test');
      span.setAttributes(attributes());
      span.end();
      await provider.forceFlush();
      assert.equal(collector.records.length, 1);
      const stored = collector.records[0].attribute;
      assert.equal(stored[INPUT], FAILURE_MASK);
      assert.equal(stored[OUTPUT], FAILURE_MASK);
      assert.equal(JSON.parse(stored[METADATA]), FAILURE_MASK);
      assert.ok(collector.requests.every((request) => !request.body.includes(Buffer.from(EMAIL))));
    }, { fetcher, maskTimeoutMs: 25 });
  });
}

for (const status of [401, 403]) {
  test(`CLS HTTP ${status} is not successful collection`, async () => {
    await withPipeline(async ({ provider, collector, exportResults }) => {
      const span = provider.getTracer('cls-contract-test').startSpan('synthetic-rejected-test');
      span.setAttributes(attributes());
      span.end();
      await provider.forceFlush().catch(() => {});
      assert.ok(exportResults.length > 0);
      assert.ok(exportResults.every((code) => code !== 0));
      assert.equal(collector.records.length, 0);
      assert.ok(collector.requests.every((request) => !request.body.includes(Buffer.from(EMAIL))));
    }, { status });
  });
}

test('CLS masking capacity is bounded and excess fields are fully masked', async () => {
  let release;
  let started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const detect = detector();
  await withPipeline(async ({ provider, collector }) => {
    const tracer = provider.getTracer('cls-contract-test');
    const first = tracer.startSpan('first');
    first.setAttribute(INPUT, JSON.stringify({ email: EMAIL }));
    first.end();
    await firstStarted;
    const second = tracer.startSpan('second');
    second.setAttribute(INPUT, JSON.stringify({ email: EMAIL }));
    second.end();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'overflow must not start another detection request');
    release();
    await provider.forceFlush();
    assert.equal(calls, 1);
    const byName = Object.fromEntries(collector.records.map((record) => [record.name, record]));
    assert.deepEqual(JSON.parse(byName.first.attribute[INPUT]), { email: '[REDACTED_EMAIL]' });
    assert.equal(byName.second.attribute[INPUT], FAILURE_MASK);
    assert.ok(collector.requests.every((request) => !request.body.includes(Buffer.from(EMAIL))));
  }, {
    config: { maxConcurrentMasks: 1 },
    fetcher: async (...args) => { calls++; started(); await gate; return detect(...args); },
  });
});

test('CLS example requires configuration and rejects region/header injection', () => {
  assert.throws(() => clsConfig({}));
  for (const patch of [
    { CLS_DEFAULT_REGION: 'ap-guangzhou.attacker.example' },
    { CLS_DEFAULT_REGION: 'ap-guangzhou/../../' },
    { CLS_TOPIC_ID: 'topic\r\nAuthorization: injected' },
    { TENCENTCLOUD_SECRET_ID: 'key\r\ninjected' },
  ]) assert.throws(() => clsConfig({ ...ENV, ...patch }));
  assert.equal(clsExporterOptions(clsConfig(ENV)).url, 'https://ap-guangzhou.cls.tencentcs.com/v1/traces');
});

test('CLS adapter does not claim to mask arbitrary span attributes', async () => {
  await withPipeline(async ({ provider, collector }) => {
    const span = provider.getTracer('cls-contract-test').startSpan('scope-boundary');
    span.setAttribute(INPUT, JSON.stringify({ email: EMAIL }));
    span.setAttribute('business.uncovered', EMAIL);
    span.end();
    await provider.forceFlush();
    const record = collector.records[0];
    assert.deepEqual(JSON.parse(record.attribute[INPUT]), { email: '[REDACTED_EMAIL]' });
    assert.equal(record.attribute['business.uncovered'], EMAIL, 'outside-hook data requires a separate policy');
  });
});

test('read-back verification requires actual fields, matching IDs, and complete masking', async () => {
  const { verifyClsRecord } = await import('../examples/tencent-cls/run.mjs');
  const ids = { traceId: '1'.repeat(32), spanId: '2'.repeat(16) };
  const record = {
    traceID: ids.traceId,
    spanID: ids.spanId,
    attribute: {
      [INPUT]: JSON.stringify({ messages: [{ role: 'user', content: '😀请联系该客户 [REDACTED_NAME]' }] }),
      [OUTPUT]: JSON.stringify({ reply: '[REDACTED_NAME]', count: 1 }),
      [METADATA]: JSON.stringify({ customer: '[REDACTED_NAME]', enabled: true }),
    },
  };
  assert.equal(verifyClsRecord(record, ids).output.count, 1);
  assert.throws(() => verifyClsRecord({ ...record, spanID: '3'.repeat(16) }, ids));
  assert.throws(() => verifyClsRecord({ ...record, attribute: {} }, ids));
  assert.throws(() => verifyClsRecord({ ...record, attribute: { ...record.attribute, [INPUT]: FAILURE_MASK } }, ids));

  // SearchLog may contain a JSON string inside attribute JSON. A raw text scan
  // cannot see this escaped name; verification must inspect decoded values too.
  const escaped = '{"messages":[{"role":"user","content":"😀请联系该客户 [REDACTED_EMAIL] \\u5f20\\u4e09"}]}';
  assert.ok(!escaped.includes('张三'));
  assert.throws(() => verifyClsRecord({ ...record, attribute: { ...record.attribute, [INPUT]: escaped } }, ids));
});
