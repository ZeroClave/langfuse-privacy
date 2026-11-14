import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { createDemoServer } from '../demo/server.mjs';

const SECRET = 'alice@example.com';

async function withServer(fetcher, run, { queryStatus = 200, paginated = false } = {}) {
  const stored = [];
  const received = [];
  const collector = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Basic ${Buffer.from('pk-test:sk-test').toString('base64')}`);
    if (request.method === 'POST') {
      assert.equal(request.url, '/api/public/otel/v1/traces');
      assert.equal(request.headers['x-langfuse-ingestion-version'], '4');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      let buffer = Buffer.concat(chunks);
      if (request.headers['content-encoding'] === 'gzip') buffer = gunzipSync(buffer);
      const text = buffer.toString();
      received.push(text);
      const body = JSON.parse(text);
      for (const resource of body.resourceSpans) for (const scope of resource.scopeSpans) for (const span of scope.spans) {
        const input = span.attributes.find(({ key }) => key === 'langfuse.observation.input').value.stringValue;
        stored.push({ id: span.spanId, traceId: span.traceId, name: span.name, type: 'SPAN', input });
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    } else {
      const url = new URL(request.url, 'http://localhost');
      assert.equal(url.pathname, '/api/public/v2/observations');
      assert.ok(url.searchParams.get('fields').includes('io'));
      response.writeHead(queryStatus, { 'content-type': 'application/json' });
      response.end(JSON.stringify(paginated && !url.searchParams.has('cursor')
        ? { data: [], meta: { cursor: 'second-page' } }
        : { data: stored.filter((item) => item.traceId === url.searchParams.get('traceId')) }));
    }
  });
  collector.listen(0, '127.0.0.1');
  await once(collector, 'listening');
  const collectorUrl = `http://127.0.0.1:${collector.address().port}`;
  const server = await createDemoServer({
    fetch: fetcher,
    langfuse: { baseUrl: collectorUrl, publicKey: 'pk-test', secretKey: 'sk-test', projectId: 'test-project' },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`, { received, stored });
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeIdleConnections();
    await closed;
    const collectorClosed = once(collector, 'close');
    collector.close();
    collector.closeIdleConnections();
    await collectorClosed;
  }
}

function detector(status = 'complete') {
  return async (_url, init) => {
    assert.equal(new Headers(init.headers).get('authorization'), null);
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

test('demo sends masked OTLP over HTTP and confirms its stored observation before success', async () => {
  await withServer(detector(), async (base, { received, stored }) => {
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
    assert.equal(body.langfuse.persisted, true);
    assert.equal(body.langfuse.observation.id, stored[0].id);
    assert.equal(body.langfuse.traceId, stored[0].traceId);
    assert.ok(body.langfuse.traceUrl.endsWith(`/project/test-project/traces/${stored[0].traceId}`));
    assert.equal(received.length, 1);
    assert.ok(!received[0].includes(SECRET), 'the actual HTTP exporter must never send the original secret');
    assert.equal(JSON.parse(body.attributes['langfuse.observation.input']).messages[0].content, body.maskedText);
  });
});

test('demo records only a full-field mask after incomplete detection and reports failure', async () => {
  await withServer(detector('partial'), async (base, { received }) => {
    const response = await fetch(`${base}/api/demo`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: SECRET }),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.ok(!JSON.stringify(body).includes(SECRET));
    assert.ok(!Object.hasOwn(body, 'maskedText'));
    assert.ok(!received.join('').includes(SECRET));
    assert.ok(received.join('').includes('fully masked due to failed mask function'));
  });
});

test('demo follows a cursor even when the first observation page is empty', async () => {
  await withServer(detector(), async (base) => {
    const response = await fetch(`${base}/api/demo`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: SECRET }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).langfuse.persisted, true);
  }, { paginated: true });
});

test('demo does not claim success when ingestion succeeds but read-back cannot confirm persistence', async () => {
  await withServer(detector(), async (base, { received }) => {
    const response = await fetch(`${base}/api/demo`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: SECRET }),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.ok(!Object.hasOwn(body, 'langfuse'));
    assert.equal(received.length, 1);
  }, { queryStatus: 403 });
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
