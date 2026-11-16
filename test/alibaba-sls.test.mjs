import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlsClient, createSlsWriter, slsClientOptions, slsConfig } from '../examples/alibaba-sls/sls.mjs';
import { syntheticData } from '../examples/alibaba-sls/run.mjs';
import { slsDetector, SYNTHETIC_CANARIES } from './helpers/sls-detector.mjs';

const ENV = {
  SLS_REGION: 'cn-hangzhou', SLS_PROJECT: 'zeroclave-test', SLS_LOGSTORE: 'privacy-demo',
  ALIBABA_CLOUD_ACCESS_KEY_ID: 'synthetic-access-id',
  ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'synthetic-access-secret',
};

test('SLS configuration builds regional HTTPS options and keeps optional STS separate from logs', () => {
  const permanent = slsConfig(ENV);
  assert.deepEqual(slsClientOptions(permanent), {
    endpoint: 'https://cn-hangzhou.log.aliyuncs.com', use_https: true,
    accessKeyId: ENV.ALIBABA_CLOUD_ACCESS_KEY_ID, accessKeySecret: ENV.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
  });
  assert.equal(permanent.maxConcurrentMasks, 4);
  const sts = slsConfig({ ...ENV, ALIBABA_CLOUD_SECURITY_TOKEN: 'synthetic-sts-token' });
  assert.equal(slsClientOptions(sts).securityToken, 'synthetic-sts-token');
});

test('SLS configuration rejects missing credentials, injected hosts and invalid budgets with fixed errors', () => {
  assert.throws(() => slsConfig({}), { code: 'sls_missing_configuration' });
  for (const change of [
    { SLS_REGION: 'https://evil.example' }, { SLS_REGION: 'cn-hangzhou.log.aliyuncs.com/evil' },
    { SLS_PROJECT: 'project@evil.example' }, { SLS_PROJECT: '../project' },
    { SLS_LOGSTORE: 'logs/../secret' }, { ALIBABA_CLOUD_ACCESS_KEY_ID: 'id\nsecret' },
    { ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'key\nsecret' }, { ALIBABA_CLOUD_SECURITY_TOKEN: ['bad'] },
    { SLS_MAX_CONCURRENT_MASKS: '0' }, { SLS_MAX_CONCURRENT_MASKS: '33' },
    { ZEROCLAVE_TIMEOUT_MS: '60001' }, { SLS_READBACK_TIMEOUT_MS: 'NaN' },
  ]) {
    assert.throws(() => slsConfig({ ...ENV, ...change }), (error) => {
      assert.equal(error.code, 'sls_invalid_configuration');
      assert.equal(error.message, 'sls_invalid_configuration');
      assert.ok(!JSON.stringify(error).includes('synthetic-access-secret'));
      return true;
    });
  }
});

test('SLS writer awaits complete masking, preserves caller data and passes only the processed JSON to SDK', async () => {
  const config = slsConfig({ ...ENV, ALIBABA_CLOUD_SECURITY_TOKEN: 'synthetic-sts-token' });
  const calls = [];
  const client = { async postLogStoreLogs(...args) {
    calls.push(args);
    return { body: '', statusCode: 200, headers: {} };
  } };
  const write = createSlsWriter(config, { client, maskOptions: { fetch: slsDetector({ credentials: config }) } });
  const input = syntheticData();
  const original = structuredClone(input);
  const receipt = await write(input, { runId: 'a'.repeat(32), timestamp: 1_700_000_000 });
  assert.deepEqual(input, original);
  assert.deepEqual(receipt, { runId: 'a'.repeat(32), timestamp: 1_700_000_000, accepted: true });
  assert.equal(calls.length, 1);
  const [project, logstore, group] = calls[0];
  assert.equal(project, config.project);
  assert.equal(logstore, config.logstore);
  assert.equal(group.logs[0].timestamp, 1_700_000_000);
  const content = group.logs[0].content;
  assert.equal(content.runId, receipt.runId);
  const stored = JSON.parse(content.payload);
  assert.equal(stored.input.messages[0].content,
    '😀虚构测试客户[REDACTED_NAME]，联系电话[REDACTED_PHONE]，邮箱[REDACTED_EMAIL]。请联系该客户。');
  assert.equal(stored.output.count, 1);
  assert.equal(stored.metadata.enabled, true);
  const encoded = JSON.stringify(group);
  for (const value of [...SYNTHETIC_CANARIES, config.accessKeyId, config.accessKeySecret, config.securityToken]) {
    assert.ok(!encoded.includes(value));
  }
});

test('SLS detector outage, incomplete results and malformed payload prevent any SDK write', async () => {
  const config = slsConfig(ENV);
  const fetchers = [
    async () => { throw new Error(`raw 张三 ${config.accessKeySecret}`); },
    slsDetector({ status: 'partial' }),
    async () => Response.json({ results: [] }),
  ];
  for (const fetch of fetchers) {
    let writes = 0;
    const write = createSlsWriter(config, { client: { postLogStoreLogs() { writes++; } }, maskOptions: { fetch } });
    await assert.rejects(write(syntheticData()), (error) => {
      assert.equal(error.code, 'sls_mask_failed');
      assert.equal(error.message, 'sls_mask_failed');
      assert.ok(!JSON.stringify(error).includes(config.accessKeySecret));
      return true;
    });
    assert.equal(writes, 0);
  }
});

test('SLS bounded writer rejects excess work without detection or writing, then recovers capacity', async () => {
  const config = { ...slsConfig(ENV), maxConcurrentMasks: 1 };
  let release;
  let entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let detections = 0;
  let writes = 0;
  const mock = slsDetector();
  const write = createSlsWriter(config, {
    client: { async postLogStoreLogs() { writes++; return { body: '', statusCode: 200, headers: {} }; } },
    maskOptions: { fetch: async (...args) => { detections++; entered(); await blocked; return mock(...args); } },
  });
  const first = write(syntheticData());
  await started;
  await assert.rejects(write(syntheticData()), { code: 'sls_mask_capacity_exceeded' });
  assert.equal(detections, 1);
  assert.equal(writes, 0);
  release();
  await first;
  await write(syntheticData());
  assert.equal(writes, 2);
});

test('SLS rejects unsafe write identifiers before detection and never exposes SDK exception contents', async () => {
  const config = slsConfig(ENV);
  let detections = 0;
  const write = createSlsWriter(config, {
    maskOptions: { fetch: slsDetector({ inspect: () => { detections++; } }) },
    client: { async postLogStoreLogs() {
      throw Object.assign(new Error(`raw alice@example.com ${config.accessKeySecret}`), { code: 'arbitrary-secret-code' });
    } },
  });
  await assert.rejects(write(syntheticData(), { runId: '" or *' }), { code: 'sls_invalid_write_options' });
  await assert.rejects(write(syntheticData(), { timestamp: -1 }), { code: 'sls_invalid_write_options' });
  assert.equal(detections, 0);
  await assert.rejects(write(syntheticData()), (error) => {
    assert.equal(error.code, 'sls_request_failed');
    assert.equal(error.message, 'sls_request_failed');
    assert.ok(!JSON.stringify(error).includes(config.accessKeySecret));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('SLS does not accept arbitrary SDK return objects or nonempty write bodies as acknowledgements', async () => {
  const config = slsConfig(ENV);
  for (const response of [ {}, { body: {}, statusCode: 200, headers: {} },
    { body: '', statusCode: 403, headers: {} } ]) {
    const write = createSlsWriter(config, {
      client: { postLogStoreLogs: async () => response }, maskOptions: { fetch: slsDetector() },
    });
    await assert.rejects(write(syntheticData()), (error) => {
      assert.ok(['sls_invalid_response', 'sls_request_failed'].includes(error.code));
      return true;
    });
  }
});

test('SLS production client refuses credential-bearing SDK debug output before initialization', async () => {
  const previous = process.env.DEBUG;
  try {
    process.env.DEBUG = '*';
    await assert.rejects(createSlsClient(slsConfig(ENV)), { code: 'sls_debug_logging_enabled' });
  } finally {
    if (previous === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = previous;
  }
});
