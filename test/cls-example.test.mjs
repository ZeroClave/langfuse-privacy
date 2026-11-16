import test from 'node:test';
import assert from 'node:assert/strict';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { clsConfig, clsExporterOptions } from '../examples/tencent-cls/cls.mjs';
import { createClsReader } from '../examples/tencent-cls/readback.mjs';
import { CANARIES, runClsExample } from '../examples/tencent-cls/run.mjs';
import { startOtlpCollector } from './helpers/otlp-collector.mjs';

const config = clsConfig({
  CLS_DEFAULT_REGION: 'ap-guangzhou',
  CLS_TOPIC_ID: '11111111-2222-4333-8444-555555555555',
  TENCENTCLOUD_SECRET_ID: 'synthetic-id',
  TENCENTCLOUD_SECRET_KEY: 'synthetic-key',
});

function detector(status = 'complete') {
  return async (_url, init) => {
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), null, 'CLS authorization must not reach ZeroClave');
    assert.ok(!init.body.includes(config.secretId));
    assert.ok(!init.body.includes(config.secretKey));
    const requestId = headers.get('x-request-id');
    const { texts } = JSON.parse(init.body);
    return Response.json({
      request_id: requestId, model_version: 'synthetic-only',
      results: texts.map(({ id, revision, text }) => {
        const entities = [];
        for (const [index, canary] of CANARIES.entries()) {
          let cursor = 0;
          for (;;) {
            const found = text.indexOf(canary, cursor);
            if (found < 0) break;
            const start = Array.from(text.slice(0, found)).length;
            entities.push({ start, end: start + Array.from(canary).length, type: ['NAME', 'PHONE', 'EMAIL'][index] });
            cursor = found + canary.length;
          }
        }
        return { id, revision, status, entities: status === 'complete' ? entities : [] };
      }),
    });
  };
}

async function pipeline(run, { persist = true, status = 200, detectionStatus = 'complete' } = {}) {
  const receiver = await startOtlpCollector({ persist, status });
  const exporter = new OTLPTraceExporter({ ...clsExporterOptions(config), url: receiver.url });
  let searches = 0;
  const reader = createClsReader(config, { client: {
    async SearchLog(params) {
      searches++;
      assert.equal(params.TopicId, config.topicId);
      const records = receiver.records.map((row) => ({ ...row, attribute: JSON.stringify(row.attribute) }));
      return { Results: records.map((row) => ({ LogJson: JSON.stringify(row) })), ListOver: true };
    },
  } });
  try {
    await run({
      receiver,
      get searches() { return searches; },
      execute: () => runClsExample(config, { exporter, search: reader,
        maskOptions: { fetch: detector(detectionStatus), maxRetries: 0 }, readbackTimeoutMs: 30 }),
    });
  } finally {
    await receiver.close();
  }
}

test('CLS example verifies decoded receiver records through SearchLog-shaped responses, not local span previews', async () => {
  await pipeline(async (context) => {
    const report = await context.execute();
    assert.equal(report.passed, true);
    assert.equal(report.persisted, true);
    assert.equal(report.cloudPersisted, false, 'a local collector must not claim Tencent cloud persistence');
    assert.equal(report.mode, 'local-collector');
    assert.ok(context.searches > 0);
    assert.equal(context.receiver.records[0].traceID, report.traceId);
    assert.equal(report.stored.input.messages[0].content,
      '😀虚构测试客户[REDACTED_NAME]，联系电话[REDACTED_PHONE]，邮箱[REDACTED_EMAIL]。请联系该客户。');
    assert.deepEqual(report.stored.output, { reply: '已记录虚构客户[REDACTED_NAME]，邮箱[REDACTED_EMAIL]。', count: 1 });
    assert.equal(report.stored.metadata.enabled, true);
  });
});

test('CLS example rejects HTTP acceptance without a persisted matching record', async () => {
  await pipeline(async (context) => {
    await assert.rejects(context.execute(), { code: 'cls_readback_timeout' });
    assert.equal(context.receiver.requests[0].status, 200);
    assert.equal(context.receiver.records.length, 0);
  }, { persist: false });
});

test('CLS example rejects an export failure before attempting to claim persistence', async () => {
  await pipeline(async (context) => {
    await assert.rejects(context.execute(), { message: 'cls_export_failed' });
    assert.equal(context.searches, 0);
  }, { status: 403 });
});

test('CLS example does not treat safely stored full-field masks as successful detection', async () => {
  await pipeline(async (context) => {
    await assert.rejects(context.execute(), { message: 'cls_detection_incomplete' });
    assert.ok(!CANARIES.some((canary) => JSON.stringify(context.receiver.records).includes(canary)));
  }, { detectionStatus: 'partial' });
});
