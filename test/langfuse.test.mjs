import test from 'node:test';
import assert from 'node:assert/strict';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { createZeroClaveMask } from '../dist/index.js';

const EMAIL = 'alice@example.com';
const SDK_FAILURE_MASK = '<fully masked due to failed mask function>';
const INPUT = 'langfuse.observation.input';
const OUTPUT = 'langfuse.observation.output';
const METADATA = 'langfuse.observation.metadata.';

function findEmailEntities(text) {
  const entities = [];
  let offset = 0;
  for (;;) {
    const start = text.indexOf(EMAIL, offset);
    if (start === -1) return entities;
    const codePointStart = Array.from(text.slice(0, start)).length;
    entities.push({
      start: codePointStart,
      end: codePointStart + EMAIL.length,
      type: 'EMAIL',
    });
    offset = start + EMAIL.length;
  }
}

function detectionFetch({ status = 'complete', received = [] } = {}) {
  return async (_url, init) => {
    assert.equal(init.method, 'POST');
    const headers = new Headers(init.headers);
    const requestId = headers.get('x-request-id');
    assert.ok(requestId, 'detection requests must have a correlation ID');
    const { texts } = JSON.parse(init.body);
    assert.ok(Array.isArray(texts));
    assert.ok(texts.length > 0);
    received.push(...texts.map(({ text }) => text));
    return new Response(
      JSON.stringify({
        request_id: requestId,
        model_version: 'test',
        results: texts.map(({ id, revision, text }) => ({
          id,
          revision,
          status,
          entities: status === 'complete' ? findEmailEntities(text) : [],
        })),
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-request-id': requestId,
        },
      },
    );
  };
}

async function exportAttributes(mockFetch, attributes) {
  const exporter = new InMemorySpanExporter();
  const processor = new LangfuseSpanProcessor({
    exporter,
    exportMode: 'immediate',
    mediaUploadEnabled: false,
    shouldExportSpan: () => true,
    mask: createZeroClaveMask({ fetch: mockFetch, timeoutMs: 1000 }),
  });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  try {
    const span = provider.getTracer('zeroclave-privacy-test').startSpan('example');
    span.setAttributes(attributes);
    span.end();
    await provider.forceFlush();
    const exported = exporter.getFinishedSpans();
    assert.equal(exported.length, 1);
    // InMemorySpanExporter clears its storage on shutdown.
    return { ...exported[0].attributes };
  } finally {
    await provider.shutdown();
  }
}

test('real Langfuse processor masks JSON input/output and decoded metadata values', async () => {
  const received = [];
  const input = JSON.stringify({
    messages: [{ role: 'user', content: `😀请联系 ${EMAIL}` }],
  });
  const reply = ['Contact "' + EMAIL + '"', 'for help'].join(String.fromCharCode(10));
  const output = JSON.stringify({
    reply,
    usage: 17,
  });
  const metadataObject = {
    customer: EMAIL,
    nested: [{ message: `邮箱：${EMAIL}`, enabled: true }],
    count: 3,
  };
  const attributes = await exportAttributes(detectionFetch({ received }), {
    [INPUT]: input,
    [OUTPUT]: output,
    [`${METADATA}customer`]: JSON.stringify(EMAIL),
    [`${METADATA}details`]: JSON.stringify(metadataObject),
    [`${METADATA}count`]: JSON.stringify(17),
  });

  assert.ok(!JSON.stringify(attributes).includes(EMAIL));
  const maskedInput = JSON.parse(attributes[INPUT]);
  assert.equal(maskedInput.messages[0].role, 'user');
  assert.ok(maskedInput.messages[0].content.startsWith('😀请联系 '));
  assert.notEqual(maskedInput.messages[0].content, `😀请联系 ${EMAIL}`);

  const maskedOutput = JSON.parse(attributes[OUTPUT]);
  assert.equal(maskedOutput.usage, 17);
  assert.ok(maskedOutput.reply.startsWith('Contact "'));
  assert.ok(maskedOutput.reply.endsWith('"' + String.fromCharCode(10) + 'for help'));

  assert.equal(typeof JSON.parse(attributes[`${METADATA}customer`]), 'string');
  const maskedDetails = JSON.parse(attributes[`${METADATA}details`]);
  assert.equal(maskedDetails.count, 3);
  assert.equal(maskedDetails.nested[0].enabled, true);
  assert.ok(maskedDetails.nested[0].message.startsWith('邮箱：'));
  assert.equal(JSON.parse(attributes[`${METADATA}count`]), 17);

  assert.ok(received.includes(`😀请联系 ${EMAIL}`), 'JSON input is decoded before detection');
  assert.ok(received.includes(reply), 'JSON output is decoded before detection');
  assert.ok(!received.includes(input), 'the entire serialized input is not scanned as opaque text');
  assert.ok(!received.includes(output), 'the entire serialized output is not scanned as opaque text');
  assert.ok(received.includes(EMAIL), 'metadata strings reach the hook decoded');
  assert.ok(received.includes(`邮箱：${EMAIL}`), 'nested metadata values are scanned');
});

for (const [scenario, mockFetch] of [
  ['partial detection', detectionFetch({ status: 'partial' })],
  ['network failure', async () => { throw new Error('synthetic connection failure'); }],
]) {
  test(`real Langfuse processor fully masks fields after ${scenario}`, async () => {
    const attributes = await exportAttributes(mockFetch, {
      [INPUT]: JSON.stringify({ email: EMAIL }),
      [OUTPUT]: `Email ${EMAIL}`,
      [`${METADATA}customer`]: JSON.stringify(EMAIL),
    });

    assert.equal(attributes[INPUT], SDK_FAILURE_MASK);
    assert.equal(attributes[OUTPUT], SDK_FAILURE_MASK);
    assert.equal(JSON.parse(attributes[`${METADATA}customer`]), SDK_FAILURE_MASK);
    assert.ok(!JSON.stringify(attributes).includes(EMAIL));
  });
}
