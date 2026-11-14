import test from 'node:test';
import assert from 'node:assert/strict';
import { createZeroClaveMask, ZeroClavePrivacyError, DEFAULT_ZEROCLAVE_ENDPOINT } from '../dist/index.js';

const SECRET = 'alice@example.com';

function detector(mutate = () => {}, { entities = () => [] } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const texts = JSON.parse(init.body).texts;
    const requestId = new Headers(init.headers).get('x-request-id');
    calls.push({ url, init, texts });
    const body = {
      request_id: requestId,
      model_version: 'test',
      results: texts.map(({ id, revision, text }) => ({ id, revision, status: 'complete', entities: entities(text) })),
    };
    const headers = { 'x-request-id': requestId };
    mutate(body, headers, calls.length);
    return Response.json(body, { headers });
  };
  return { fetch, calls };
}

function emailEntities(text) {
  const index = text.indexOf(SECRET);
  if (index === -1) return [];
  const start = Array.from(text.slice(0, index)).length;
  return [{ start, end: start + SECRET.length, type: 'EMAIL' }];
}

test('redacts Unicode codepoint ranges without mutating nested data', async () => {
  const mock = detector(undefined, { entities: emailEntities });
  const mask = createZeroClaveMask({ fetch: mock.fetch });
  const input = { messages: [{ content: `😀你好 ${SECRET}`, role: 'user' }], count: 1, enabled: true, nil: null };
  const snapshot = structuredClone(input);
  assert.deepEqual(await mask({ data: input }), {
    ...input, messages: [{ content: '😀你好 [REDACTED_EMAIL]', role: 'user' }],
  });
  assert.deepEqual(input, snapshot);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].url, DEFAULT_ZEROCLAVE_ENDPOINT);
  assert.equal(mock.calls[0].init.redirect, 'error');
  assert.equal(mock.calls[0].init.credentials, 'omit');
  assert.equal(mock.calls[0].init.cache, 'no-store');
  assert.equal(new Headers(mock.calls[0].init.headers).get('authorization'), null);
});

test('preserves JSON structure, escaped characters and nested serialized tool arguments', async () => {
  const mock = detector(undefined, { entities: emailEntities });
  const mask = createZeroClaveMask({ fetch: mock.fetch });
  const input = JSON.stringify({
    text: `Say "${SECRET}"\n😀`,
    arguments: JSON.stringify({ email: SECRET }),
  });
  const output = JSON.parse(await mask({ data: input }));
  assert.equal(output.text, 'Say "[REDACTED_EMAIL]"\n😀');
  assert.equal(JSON.parse(output.arguments).email, '[REDACTED_EMAIL]');
  assert.ok(!mock.calls[0].texts.some(({ text }) => text === input));
});

test('keeps JSON semantics and scans JSON scalar-looking text', async () => {
  const mock = detector();
  const mask = createZeroClaveMask({ fetch: mock.fetch });
  const input = '  { "a" : "hello", "b": [1, true] }\n';
  assert.deepEqual(JSON.parse(await mask({ data: input })), JSON.parse(input));
  assert.equal(await mask({ data: '12345678901' }), '12345678901');
  assert.ok(mock.calls.some(({ texts }) => texts.some(({ text }) => text === '12345678901')));
});

test('does not export uninspected JSON values hidden by duplicate keys', async () => {
  const mock = detector();
  const input = `{"message":"${SECRET}","message":"hello"}`;
  const mask = createZeroClaveMask({ fetch: mock.fetch });
  const output = await mask({ data: input });
  assert.deepEqual(JSON.parse(output), { message: 'hello' });
  assert.ok(!output.includes(SECRET));
  const nested = await mask({ data: JSON.stringify({ arguments: input }) });
  assert.deepEqual(JSON.parse(JSON.parse(nested).arguments), { message: 'hello' });
  assert.ok(!nested.includes(SECRET));
});

test('merges overlaps, preserves adjacent predictions, and redacts unknown valid entity types', async () => {
  const mock = detector(undefined, { entities: () => [
    { start: 2, end: 7, type: 'FUTURE_TYPE' },
    { start: 0, end: 4, type: 'NAME' },
    { start: 7, end: 8, type: 'EMAIL' },
  ] });
  assert.equal(await createZeroClaveMask({ fetch: mock.fetch })({ data: 'abcdefgh!' }),
    '[REDACTED_PII][REDACTED_EMAIL]!');
});

test('empty strings and non-text primitive values need no detection request', async () => {
  const mock = detector();
  const mask = createZeroClaveMask({ fetch: mock.fetch });
  for (const value of ['', null, undefined, true, 12, [], { a: 1, b: '' }]) {
    assert.deepEqual(await mask({ data: value }), value);
  }
  assert.equal(mock.calls.length, 0);
});

test('batches more than 64 strings and associates reordered results by ID', async () => {
  const mock = detector((body) => body.results.reverse(), { entities: emailEntities });
  const input = Array.from({ length: 130 }, (_, i) => `${i} ${SECRET}`);
  const output = await createZeroClaveMask({ fetch: mock.fetch })({ data: input });
  assert.deepEqual(mock.calls.map(({ texts }) => texts.length), [64, 64, 2]);
  assert.deepEqual(output, input.map((_, i) => `${i} [REDACTED_EMAIL]`));
});

const invalidResults = [
  ['partial', (body) => { body.results[0].status = 'partial'; }, 'incomplete_detection'],
  ['missing result', (body) => { body.results.pop(); }],
  ['duplicate ID', (body) => { body.results[1].id = body.results[0].id; }],
  ['unexpected ID', (body) => { body.results[0].id = 'other'; }],
  ['stale revision', (body) => { body.results[0].revision = 'old'; }],
  ['missing revision', (body) => { delete body.results[0].revision; }],
  ['wrong request ID', (body) => { body.request_id = 'wrong'; }],
  ['wrong header ID', (_body, headers) => { headers['x-request-id'] = 'wrong'; }],
  ['unknown status', (body) => { body.results[0].status = 'unknown'; }],
  ['negative offset', (body) => { body.results[0].entities = [{ start: -1, end: 1, type: 'NAME' }]; }],
  ['out of range offset', (body) => { body.results[0].entities = [{ start: 0, end: 500, type: 'NAME' }]; }],
  ['empty range', (body) => { body.results[0].entities = [{ start: 1, end: 1, type: 'NAME' }]; }],
  ['fractional offset', (body) => { body.results[0].entities = [{ start: 0.5, end: 2, type: 'NAME' }]; }],
  ['invalid entity type', (body) => { body.results[0].entities = [{ start: 0, end: 2, type: SECRET }]; }],
];
for (const [name, mutate, code = 'invalid_response'] of invalidResults) {
  test(`rejects ${name} without exposing the original field`, async () => {
    const mock = detector(mutate);
    await assert.rejects(createZeroClaveMask({ fetch: mock.fetch })({ data: [SECRET, 'other'] }), (error) => {
      assert.ok(error instanceof ZeroClavePrivacyError);
      assert.equal(error.code, code);
      assert.ok(!String(error).includes(SECRET));
      return true;
    });
  });
}

test('a later failed batch rejects the entire callback', async () => {
  const mock = detector((body, _headers, attempt) => {
    if (attempt === 2) body.results[0].status = 'partial';
  });
  await assert.rejects(createZeroClaveMask({ fetch: mock.fetch })({ data: Array(65).fill(SECRET) }),
    { code: 'incomplete_detection' });
});

test('retries HTTP 429 with Retry-After and stops at the configured bound', async () => {
  const mock = detector();
  let calls = 0;
  const mask = createZeroClaveMask({ maxRetries: 1, fetch: async (...args) => {
    if (++calls === 1) return new Response('overloaded', { status: 429, headers: { 'retry-after': '0' } });
    return mock.fetch(...args);
  } });
  assert.equal(await mask({ data: 'hello' }), 'hello');
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(createZeroClaveMask({ maxRetries: 1, fetch: async () => {
    calls++;
    return new Response(SECRET, { status: 503, headers: { 'retry-after': '0' } });
  } })({ data: SECRET }), { code: 'detection_failed' });
  assert.equal(calls, 2);
});

test('HTTP failures and network errors have safe fixed messages', async () => {
  let calls = 0;
  await assert.rejects(createZeroClaveMask({ fetch: async () => {
    calls++;
    return new Response(SECRET, { status: 400 });
  } })({ data: SECRET }), { message: 'ZeroClave privacy masking failed (detection_failed).' });
  assert.equal(calls, 1);
  await assert.rejects(createZeroClaveMask({ maxRetries: 0, fetch: async () => { throw new Error(SECRET); } })({ data: SECRET }),
    { message: 'ZeroClave privacy masking failed (detection_failed).' });
});

test('deadline covers a fetch implementation that ignores its abort signal', async () => {
  await assert.rejects(createZeroClaveMask({ timeoutMs: 20, fetch: () => new Promise(() => {}) })({ data: SECRET }),
    { code: 'timeout' });
});

test('deadline covers stalled response bodies and Retry-After delays', async () => {
  const stalled = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } });
  await assert.rejects(createZeroClaveMask({ timeoutMs: 20, fetch: async () => new Response(stalled) })({ data: SECRET }),
    { code: 'timeout' });
  await assert.rejects(createZeroClaveMask({ timeoutMs: 20, fetch: async () =>
    new Response(null, { status: 429, headers: { 'retry-after': '120' } }) })({ data: SECRET }), { code: 'timeout' });
});

for (const [name, response] of [
  ['invalid JSON', () => new Response(SECRET)],
  ['oversized response', () => new Response('x'.repeat(1_048_577))],
  ['oversized declared length', () => new Response('{}', { headers: { 'content-length': '1048577' } })],
]) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(createZeroClaveMask({ fetch: async () => response() })({ data: SECRET }),
      { code: 'invalid_response' });
  });
}

test('rejects oversized text and malformed Unicode before any request', async () => {
  const mock = detector();
  const mask = createZeroClaveMask({ fetch: mock.fetch });
  await assert.rejects(mask({ data: 'a'.repeat(100_001) }), { code: 'input_too_large' });
  await assert.rejects(mask({ data: 'a\ud800b' }), { code: 'unsupported_input' });
  assert.equal(mock.calls.length, 0);
});

test('rejects cycles, accessors and unsupported objects without calling getters', async () => {
  const mock = detector();
  const mask = createZeroClaveMask({ fetch: mock.fetch });
  const cycle = {}; cycle.self = cycle;
  let called = false;
  const accessor = { get secret() { called = true; return SECRET; } };
  for (const value of [cycle, accessor, new Date(), new Map(), 1n, NaN, { [Symbol('private')]: SECRET }]) {
    await assert.rejects(mask({ data: value }), { code: 'unsupported_input' });
  }
  assert.equal(called, false);
  assert.equal(mock.calls.length, 0);
});

test('rejects sparse arrays with excessive length', async () => {
  const mock = detector();
  await assert.rejects(createZeroClaveMask({ fetch: mock.fetch })({ data: new Array(10_001) }),
    { code: 'input_too_large' });
  assert.equal(mock.calls.length, 0);
});

test('literal __proto__ keys remain data properties', async () => {
  const mock = detector(undefined, { entities: emailEntities });
  const input = JSON.parse(`{"__proto__":"${SECRET}","ok":"hello"}`);
  const output = await createZeroClaveMask({ fetch: mock.fetch })({ data: input });
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(output, '__proto__').value, '[REDACTED_EMAIL]');
});

test('validates endpoint and numeric options when the factory is created', () => {
  for (const options of [
    { endpoint: 'http://remote.example/v1/pii/detect' },
    { endpoint: 'https://user:password@example.com/' },
    { endpoint: 'https://example.com/?secret=x' },
    { endpoint: 'file:///tmp/test' },
    { timeoutMs: 0 }, { timeoutMs: Infinity }, { maxRetries: 4 },
  ]) assert.throws(() => createZeroClaveMask(options), { code: 'invalid_options' });
  assert.doesNotThrow(() => createZeroClaveMask({ endpoint: 'http://[::1]:8080/v1/pii/detect' }));
});
