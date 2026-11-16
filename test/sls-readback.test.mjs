import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlsReader, waitForSlsRecord } from '../examples/alibaba-sls/readback.mjs';
import { SlsError } from '../examples/alibaba-sls/sls.mjs';

const runId = 'a'.repeat(32);
const otherRunId = 'b'.repeat(32);
const query = { runId, from: 1_700_000_000_123, to: 1_700_000_120_987 };
const config = {
  region: 'cn-hangzhou', project: 'test-project', logstore: 'test-logstore',
  accessKeyId: 'test-ak', accessKeySecret: 'test-secret', readbackTimeoutMs: 1000,
};
const stored = { runId, payload: '{"message":"[REDACTED_EMAIL]"}', schemaVersion: '1', service: 'zeroclave-sls-demo' };
const response = (body, progress = 'Complete', statusCode = 200) => ({
  body, statusCode, headers: { 'x-log-progress': progress },
});

test('SLS reader paginates exact run IDs and gives the SDK Date objects and search pagination', async () => {
  const calls = [];
  const client = { async getLogs(...args) {
    calls.push(args);
    return calls.length === 1
      ? response(Array.from({ length: 100 }, (_, index) => ({ ...stored, runId: otherRunId, ordinal: String(index) })))
      : response([
        { ...stored, runId: `${runId}0` },
        { ...stored, runId: runId.toUpperCase() },
        stored,
      ]);
  } };
  assert.deepEqual(await createSlsReader(config, { client })(query), [stored]);
  assert.equal(calls.length, 2);
  for (const [project, logstore, from, to, search, options] of calls) {
    assert.equal(project, config.project);
    assert.equal(logstore, config.logstore);
    assert.ok(from instanceof Date);
    assert.ok(to instanceof Date);
    assert.equal(from.getTime(), query.from);
    assert.equal(to.getTime(), query.to);
    assert.equal(search.query, `runId:"${runId}"`);
    assert.equal(search.line, 100);
    assert.equal(search.reverse, false);
    assert.ok(options.agent);
    assert.ok(options.timeout > 0);
  }
  assert.deepEqual(calls.map((call) => call[4].offset), [0, 100]);
});

test('SLS reader retains all exact duplicates across pages for verification', async () => {
  let calls = 0;
  const duplicate = { ...stored, payload: '{"message":"second stored value"}' };
  const client = { async getLogs() {
    return ++calls === 1
      ? response([stored, ...Array.from({ length: 99 }, () => ({ ...stored, runId: otherRunId }))])
      : response([duplicate]);
  } };
  assert.deepEqual(await createSlsReader(config, { client })(query), [stored, duplicate]);
});

test('SLS polling discards partial query results and restarts pagination from zero', async () => {
  const offsets = [];
  let call = 0;
  const earlier = { ...stored, payload: '{"message":"unconfirmed earlier page"}' };
  const client = { async getLogs(project, logstore, from, to, search) {
    offsets.push(search.offset);
    if (++call === 1) return response([earlier, ...Array.from({ length: 99 }, () => ({ runId: otherRunId }))]);
    if (call === 2) return response([stored], 'Incomplete');
    return response([stored]);
  } };
  const result = await waitForSlsRecord(config, {
    ...query, pollIntervalMs: 1, timeoutMs: 1000,
    search: createSlsReader(config, { client }),
  });
  assert.deepEqual(offsets, [0, 100, 0]);
  assert.deepEqual(result, [stored]);
});

test('SLS reader rejects unconfirmed query status, malformed rows, and non-SDK response shapes', async () => {
  for (const invalid of [
    response([stored], null),
    { body: [stored], statusCode: 200, headers: {} },
    response([stored], 'complete'),
    response({ data: [stored] }),
    response([null]),
    response(['raw log']),
    response(Array.from({ length: 101 }, () => stored)),
  ]) {
    await assert.rejects(createSlsReader(config, { client: { getLogs: async () => invalid } })(query),
      { code: 'sls_readback_invalid_response' });
  }
  await assert.rejects(createSlsReader(config, { client: { getLogs: async () => [stored] } })(query),
    { code: 'sls_invalid_response' });
});

test('SLS reader bounds repeated full pages instead of silently claiming complete results', async () => {
  let calls = 0;
  await assert.rejects(createSlsReader(config, { client: { async getLogs() {
    calls++;
    return response(Array.from({ length: 100 }, () => stored));
  } } })(query), { code: 'sls_readback_too_many_pages' });
  assert.ok(calls > 1 && calls <= 32);
});

test('SLS read-back discards SDK error bodies and exposes only fixed codes and retryability', async () => {
  const secret = 'fake-access-key-secret-and-unmasked@example.com';
  for (const [cloudCode, retryable] of [['Unauthorized', false], ['ServerBusy', true], [secret, false]]) {
    await assert.rejects(createSlsReader(config, { client: { async getLogs() {
      throw Object.assign(new Error(`upstream body: ${secret}`), { code: cloudCode, request: secret });
    } } })(query), (error) => {
      assert.ok(error instanceof SlsError);
      assert.equal(error.code, 'sls_request_failed');
      assert.equal(error.message, 'sls_request_failed');
      assert.equal(error.retryable, retryable);
      assert.equal(error.cause, undefined);
      assert.equal(error.cloudCode, undefined);
      assert.ok(!JSON.stringify(error).includes(secret));
      assert.ok(!error.stack.includes(secret));
      return true;
    });
  }
});

test('SLS polling retries failed HTTP requests without accepting their body as persisted evidence', async () => {
  for (const status of [429, 500, 503]) {
    let calls = 0;
    const client = { async getLogs() {
      return response([stored], 'Complete', ++calls === 1 ? status : 200);
    } };
    assert.deepEqual(await waitForSlsRecord(config, {
      ...query, pollIntervalMs: 1, timeoutMs: 1000, search: createSlsReader(config, { client }),
    }), [stored]);
    assert.equal(calls, 2);
  }
  let deniedCalls = 0;
  await assert.rejects(waitForSlsRecord(config, {
    ...query, pollIntervalMs: 1, timeoutMs: 1000,
    search: createSlsReader(config, { client: { async getLogs() {
      deniedCalls++;
      return response([stored], 'Complete', 403);
    } } }),
  }), { code: 'sls_request_failed', retryable: false });
  assert.equal(deniedCalls, 1);
});

test('SLS polling waits for this run after empty or stale successful queries', async () => {
  let attempts = 0;
  const result = await waitForSlsRecord(config, {
    ...query, pollIntervalMs: 1, timeoutMs: 1000,
    search: async () => {
      attempts++;
      return attempts === 1 ? [] : attempts === 2 ? [{ ...stored, runId: otherRunId }] : [stored];
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(result, [stored]);
});

test('SLS polling enforces its deadline even when an injected reader or SDK ignores cancellation', { timeout: 2000 }, async () => {
  for (const search of [
    () => new Promise(() => {}),
    createSlsReader(config, { client: { getLogs: () => new Promise(() => {}) } }),
    async () => [],
  ]) {
    await assert.rejects(waitForSlsRecord(config, {
      ...query, timeoutMs: 25, pollIntervalMs: 1, search,
    }), { code: 'sls_readback_timeout' });
  }
});

test('SLS read-back checks IDs and ranges before invoking the SDK', async () => {
  const reader = createSlsReader(config, { client: { getLogs: () => assert.fail('SDK must not be invoked') } });
  for (const invalid of [
    { runId: 'bad" OR *' }, { runId: runId.toUpperCase() }, { runId: `${runId}0` },
    { from: -1 }, { from: 1.5 }, { to: query.from }, { to: Number.MAX_SAFE_INTEGER },
  ]) {
    await assert.rejects(reader({ ...query, ...invalid }), { code: 'sls_readback_invalid_options' });
  }
  await assert.rejects(reader({ ...query, signal: AbortSignal.abort() }), { code: 'sls_readback_aborted' });
});

test('SLS polling respects caller cancellation of a noncooperative reader', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = waitForSlsRecord(config, {
    ...query, timeoutMs: 1000, signal: controller.signal,
    search: () => { entered(); return new Promise(() => {}); },
  });
  await started;
  controller.abort();
  await assert.rejects(pending, { code: 'sls_readback_aborted' });
  await assert.rejects(waitForSlsRecord(config, {
    ...query, signal: AbortSignal.abort(), search: () => assert.fail('reader must not be invoked'),
  }), { code: 'sls_readback_aborted' });
});

test('SLS polling sanitizes injected reader errors and rejects malformed results', async () => {
  await assert.rejects(waitForSlsRecord(config, { ...query, search: async () => {
    throw new Error('unmasked@example.com fake-secret');
  } }), { code: 'sls_readback_failed', message: 'sls_readback_failed' });
  for (const result of [null, {}, [null], ['raw log']]) {
    await assert.rejects(waitForSlsRecord(config, { ...query, search: async () => result }),
      { code: 'sls_readback_invalid_response' });
  }
});
