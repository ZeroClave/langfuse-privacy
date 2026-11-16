import test from 'node:test';
import assert from 'node:assert/strict';
import { slsConfig } from '../examples/alibaba-sls/sls.mjs';
import { CANARIES, runSlsExample, verifySlsRecord } from '../examples/alibaba-sls/run.mjs';
import { createLocalSlsClient, startSlsCollector } from './helpers/sls-local-collector.mjs';
import { slsDetector } from './helpers/sls-detector.mjs';

const ENV = {
  SLS_REGION: 'cn-hangzhou', SLS_PROJECT: 'zeroclave-test', SLS_LOGSTORE: 'privacy-demo',
  ALIBABA_CLOUD_ACCESS_KEY_ID: 'synthetic-access-id', ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'synthetic-access-secret',
};

async function pipeline(run, { sts = false, detectionStatus = 'complete', ...receiverOptions } = {}) {
  const config = slsConfig({ ...ENV, ...(sts ? { ALIBABA_CLOUD_SECURITY_TOKEN: 'synthetic-sts-token' } : {}) });
  const receiver = await startSlsCollector({ ...receiverOptions, credentials: config, logstore: config.logstore });
  try {
    const client = await createLocalSlsClient(config, receiver);
    await run({ receiver, config, client,
      execute: () => runSlsExample(config, {
        client, maskOptions: { fetch: slsDetector({ status: detectionStatus, credentials: config }) },
        readbackTimeoutMs: 40,
      }),
    });
  } finally { await receiver.close(); }
}

test('SLS retries a real SDK-thrown unknown 429 cloud error based on observed HTTP status', async () => {
  await pipeline(async ({ receiver, config, client }) => {
    const report = await runSlsExample(config, {
      client, maskOptions: { fetch: slsDetector() }, readbackTimeoutMs: 2_000,
    });
    assert.equal(report.passed, true);
    assert.deepEqual(receiver.requests.filter((request) => request.method === 'GET').map((request) => request.status),
      [429, 200]);
  }, { queryStatus: (attempt) => attempt === 1 ? 429 : 200,
    queryError: { errorCode: 'UnlistedTemporaryCode', errorMessage: 'synthetic-secret-only' } });
});

test('SLS actual query JSON cannot masquerade as the injected client response envelope', async () => {
  await pipeline(async ({ execute }) => {
    await assert.rejects(execute(), { code: 'sls_readback_invalid_response' });
  }, { transformRows: (rows) => ({ body: rows, statusCode: 200, headers: { 'x-log-progress': 'Complete' } }) });
});

for (const sts of [false, true]) {
  test(`SLS official SDK ${sts ? 'STS' : 'permanent'} signed protobuf is decoded, stored and queried through actual HTTP`, async () => {
    await pipeline(async ({ receiver, execute }) => {
      const report = await execute();
      assert.equal(report.passed, true);
      assert.equal(report.persisted, true);
      assert.equal(report.cloudPersisted, false);
      assert.equal(report.mode, 'local-collector');
      assert.equal(receiver.records.length, 1);
      assert.equal(receiver.records[0].runId, report.runId);
      assert.ok(receiver.requests.every((request) => request.signed));
      assert.deepEqual(receiver.requests.map((request) => request.method), ['POST', 'GET']);
      assert.equal(receiver.requests[0].path, '/logstores/privacy-demo/shards/lb');
      assert.ok(receiver.requests[0].body.length > 0);
      assert.equal(receiver.requests[1].query.query, `runId:"${report.runId}"`);
      assert.equal(report.stored.input.messages[0].content,
        '😀虚构测试客户[REDACTED_NAME]，联系电话[REDACTED_PHONE]，邮箱[REDACTED_EMAIL]。请联系该客户。');
      assert.equal(report.stored.output.count, 1);
      assert.equal(report.stored.metadata.enabled, true);
      assert.ok(!CANARIES.some((canary) => JSON.stringify(receiver.records).includes(canary)));
    }, { sts });
  });
}

test('SLS write acknowledgement without persisted read-back never passes', async () => {
  await pipeline(async ({ receiver, execute }) => {
    await assert.rejects(execute(), { code: 'sls_readback_timeout' });
    assert.equal(receiver.requests[0].status, 200);
    assert.equal(receiver.records.length, 0);
  }, { persist: false });
});

test('SLS actual HTTP rejection with an unstructured error body stops before querying', async () => {
  await pipeline(async ({ receiver, execute }) => {
    await assert.rejects(execute(), { code: 'sls_request_failed' });
    assert.deepEqual(receiver.requests.map((request) => request.method), ['POST']);
    assert.equal(receiver.records.length, 0);
  }, { writeStatus: 403 });
});

test('SLS incomplete query containing an exact row is not persistence evidence', async () => {
  await pipeline(async ({ receiver, execute }) => {
    await assert.rejects(execute(), { code: 'sls_readback_timeout' });
    assert.equal(receiver.records.length, 1);
  }, { progress: 'Incomplete' });
});

test('SLS incomplete detection prevents any HTTP collection instead of storing failure masks', async () => {
  await pipeline(async ({ receiver, execute }) => {
    await assert.rejects(execute(), { code: 'sls_mask_failed' });
    assert.equal(receiver.requests.length, 0);
    assert.equal(receiver.records.length, 0);
  }, { detectionStatus: 'partial' });
});

test('SLS runner verifies cloud-shaped returned payload, rejecting escaped sensitive values', async () => {
  await pipeline(async ({ receiver, execute }) => {
    await assert.rejects(execute(), { code: 'sls_canary_remaining' });
    assert.ok(!CANARIES.some((canary) => JSON.stringify(receiver.records).includes(canary)),
      'The actual uploaded body is safe; only corrupt query output should make this fail.');
  }, { transformRows: (rows) => rows.map((row) => {
    const data = JSON.parse(row.payload);
    data.output.reply = '已记录\\u5f20\\u4e09';
    return { ...row, payload: JSON.stringify(data) };
  }) });
});

test('SLS record verification requires this run, intact Unicode/structure, placeholders and no full-field mask', async () => {
  await pipeline(async ({ receiver, execute }) => {
    const report = await execute();
    const original = receiver.records[0];
    const check = (row) => verifySlsRecord(row, { runId: report.runId });
    assert.throws(() => check({ ...original, runId: 'f'.repeat(32) }), { code: 'sls_record_mismatch' });
    for (const [modify, code] of [
      [(data) => { data.output.count = '1'; }, 'sls_structure_not_preserved'],
      [(data) => { data.metadata.enabled = 'true'; }, 'sls_structure_not_preserved'],
      [(data) => { data.input.messages[0].content = 'context removed'; }, 'sls_structure_not_preserved'],
      [(data) => { data.output.reply = 'no replacement'; }, 'sls_mask_not_observed'],
      [(data) => { data.output.reply = '<fully masked due to failed mask function>'; }, 'sls_detection_incomplete'],
    ]) {
      const data = JSON.parse(original.payload);
      modify(data);
      assert.throws(() => check({ ...original, payload: JSON.stringify(data) }), { code });
    }
  });
});
