import test from 'node:test';
import assert from 'node:assert/strict';
import { ClsReadbackError, createClsReader, waitForClsRecord } from '../examples/tencent-cls/readback.mjs';

const traceId = 'a'.repeat(32);
const spanId = 'b'.repeat(16);
const query = { traceId, spanId, from: 1, to: 2 };
const config = { region: 'ap-guangzhou', topicId: 'test-topic', secretId: 'test-id', secretKey: 'test-key' };
const attributes = { 'langfuse.observation.input': JSON.stringify({ messages: [{ content: '[REDACTED_EMAIL]' }] }) };
const stored = { traceID: traceId, spanID: spanId, attribute: JSON.stringify(attributes), resource: '{}' };

test('CLS reader follows empty-page cursors, filters both IDs and decodes attribute JSON', async () => {
  const requests = [];
  const client = { async SearchLog(params) {
    requests.push(params);
    return requests.length === 1
      ? { Results: [], Context: 'page-2', ListOver: false }
      : { Results: [
        { LogJson: JSON.stringify({ ...stored, spanID: 'c'.repeat(16) }) },
        { LogJson: JSON.stringify(stored) },
      ], Context: '', ListOver: true };
  } };
  const result = await createClsReader(config, { client })(query);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].attribute, attributes);
  assert.deepEqual(result[0].resource, {});
  assert.equal(requests[0].QueryString, `traceID:"${traceId}" AND spanID:"${spanId}"`);
  assert.equal(requests[0].From, 1);
  assert.equal(requests[1].Context, 'page-2');
  assert.equal(requests[1].QuerySyntax, 1);
});

test('CLS reader accepts ID casing but never accepts a conflicting alias', async () => {
  const client = { async SearchLog() {
    return { ListOver: true, Results: [
      { LogJson: JSON.stringify({ TraceId: traceId.toUpperCase(), SpanId: spanId.toUpperCase(), attribute: {} }) },
      { LogJson: JSON.stringify({ ...stored, traceId: 'c'.repeat(32) }) },
    ] };
  } };
  assert.equal((await createClsReader(config, { client })(query)).length, 1);
});

test('CLS reader rejects missing results, malformed attributes and repeated pagination tokens', async () => {
  for (const payload of [
    { ListOver: true },
    { ListOver: true, Results: [{ LogJson: '{broken' }] },
    { ListOver: true, Results: [{ LogJson: JSON.stringify({ ...stored, attribute: '{broken' }) }] },
    { ListOver: false, Context: 'repeat', Results: [] },
  ]) {
    await assert.rejects(createClsReader(config, { client: { async SearchLog() { return payload; } } })(query),
      { code: 'cls_readback_invalid_response' });
  }
});

test('CLS reader strips arbitrary cloud errors and exposes only explicitly allowed error codes', async () => {
  for (const code of ['UnauthorizedOperation', 'unexpected-secret-value']) {
    await assert.rejects(createClsReader(config, { client: { async SearchLog() {
      throw Object.assign(new Error('untrusted server body containing test-key'), { code });
    } } })(query), (error) => {
      assert.equal(error.code, 'cls_readback_failed');
      assert.equal(error.cloudCode, code === 'UnauthorizedOperation' ? code : undefined);
      assert.ok(!JSON.stringify(error).includes('test-key'));
      assert.ok(!error.message.includes('untrusted'));
      return true;
    });
  }
});

test('CLS polling waits for the exact trace and span, not simply a successful query', async () => {
  let attempts = 0;
  const result = await waitForClsRecord(config, {
    ...query, pollIntervalMs: 1, timeoutMs: 1000,
    search: async () => ++attempts === 1 ? [{ ...stored, spanID: 'c'.repeat(16) }] : [stored],
  });
  assert.equal(attempts, 2);
  assert.equal(result[0].spanID, spanId);
  assert.deepEqual(result[0].attribute, attributes);
});

test('CLS polling retries throttling, but permission failures return immediately', async () => {
  let attempts = 0;
  const result = await waitForClsRecord(config, {
    ...query, pollIntervalMs: 1, timeoutMs: 1000,
    search: async () => {
      if (++attempts === 1) throw new ClsReadbackError('cls_readback_failed', 'RequestLimitExceeded');
      return [stored];
    },
  });
  assert.equal(result.length, 1);
  assert.equal(attempts, 2);
  await assert.rejects(waitForClsRecord(config, { ...query, search: async () => {
    throw new ClsReadbackError('cls_readback_failed', 'UnauthorizedOperation');
  } }), { code: 'cls_readback_failed', cloudCode: 'UnauthorizedOperation' });
});

test('CLS polling has a deadline even when a reader ignores its abort signal', async () => {
  await assert.rejects(waitForClsRecord(config, {
    ...query, timeoutMs: 15, search: () => new Promise(() => {}),
  }), { code: 'cls_readback_timeout' });
});

test('CLS read-back validates identifiers and respects caller cancellation', async () => {
  await assert.rejects(createClsReader(config, { client: { SearchLog: () => assert.fail() } })({ ...query, traceId: 'bad" query' }),
    { code: 'cls_readback_invalid_options' });
  const signal = AbortSignal.abort();
  await assert.rejects(waitForClsRecord(config, { ...query, signal, search: () => assert.fail() }),
    { code: 'cls_readback_aborted' });
});
