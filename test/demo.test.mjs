import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createDemoServer } from '../demo/server.mjs';

const SECRET = 'alice@example.com';

async function withServer(fetcher, run) {
  const server = await createDemoServer({ fetch: fetcher });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeIdleConnections();
    await closed;
  }
}

function detector(status = 'complete') {
  return async (_url, init) => {
    const { texts } = JSON.parse(init.body);
    const requestId = new Headers(init.headers).get('x-request-id');
    return Response.json({
      request_id: requestId,
      model_version: 'synthetic',
      results: texts.map(({ id, revision, text }) => {
        const index = text.indexOf(SECRET);
        const start = Array.from(text.slice(0, index)).length;
        return { id, revision, status, entities: index < 0 ? [] : [{ start, end: start + SECRET.length, type: 'EMAIL' }] };
      }),
    });
  };
}

test('demo HTTP response contains only the masked SDK export and retains Unicode', async () => {
  await withServer(detector(), async (base) => {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/u);
    const response = await fetch(`${base}/api/demo`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `😀请联系${SECRET}` }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.maskedText, '😀请联系[REDACTED_EMAIL]');
    assert.ok(!JSON.stringify(body).includes(SECRET));
    assert.equal(body.stats.entities, 1);
    assert.equal(body.stats.requests, 1);
    assert.equal(body.stats.status, 'masked');
    assert.equal(JSON.parse(body.attributes['langfuse.observation.input']).messages[0].content, body.maskedText);
  });
});

test('demo rejects incomplete detection without returning raw input or server errors', async () => {
  await withServer(detector('partial'), async (base) => {
    const response = await fetch(`${base}/api/demo`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: SECRET }),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.ok(!JSON.stringify(body).includes(SECRET));
    assert.ok(!Object.hasOwn(body, 'maskedText'));
  });
});

test('demo rejects invalid and cross-origin requests before contacting the detector', async () => {
  await withServer(async () => { assert.fail('must not contact the detector'); }, async (base) => {
    const response = await fetch(`${base}/api/demo`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '' }),
    });
    assert.equal(response.status, 400);
    const crossOrigin = await fetch(`${base}/api/demo`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://other.example' },
      body: JSON.stringify({ text: SECRET }),
    });
    assert.equal(crossOrigin.status, 403);
  });
});
