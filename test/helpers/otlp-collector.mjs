import { createServer } from 'node:http';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import protobuf from 'protobufjs';

// Independent wire decoder: these field numbers are the OTLP Trace protobuf
// contract. Unknown fields are intentionally skipped by protobufjs. No exporter
// internals or in-memory spans are used to construct the stored records.
const schema = protobuf.parse(`
syntax = "proto3";
message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
message KeyValue { string key = 1; AnyValue value = 2; }
message Resource { repeated KeyValue attributes = 1; }
message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  bytes parent_span_id = 4;
  string name = 5;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
}
message ScopeSpans { repeated Span spans = 2; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
`).root.lookupType('ExportTraceServiceRequest');

function valueOf(value) {
  if (!value) return null;
  for (const key of ['stringValue', 'boolValue', 'doubleValue']) {
    if (Object.hasOwn(value, key)) return value[key];
  }
  if (Object.hasOwn(value, 'intValue')) return Number(value.intValue);
  if (Object.hasOwn(value, 'bytesValue')) return Buffer.from(value.bytesValue).toString('hex');
  if (Object.hasOwn(value, 'arrayValue')) return value.arrayValue.values.map(valueOf);
  if (Object.hasOwn(value, 'kvlistValue')) return attributesOf(value.kvlistValue.values);
  return null;
}

function attributesOf(values = []) {
  return Object.fromEntries(values.map(({ key, value }) => [key, valueOf(value)]));
}

export function decodeOtlpRecords(buffer) {
  const request = schema.decode(buffer);
  const records = [];
  for (const resource of request.resourceSpans ?? []) {
    for (const scope of resource.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        records.push({
          traceID: Buffer.from(span.traceId).toString('hex'),
          spanID: Buffer.from(span.spanId).toString('hex'),
          name: span.name,
          start: String(span.startTimeUnixNano),
          end: String(span.endTimeUnixNano),
          attribute: attributesOf(span.attributes),
          resource: attributesOf(resource.resource?.attributes),
        });
      }
    }
  }
  return records;
}

/** Local OTLP contract fixture, never a substitute for Tencent CLS read-back. */
export async function startOtlpCollector({ status = 200, persist = true } = {}) {
  const requests = [];
  const records = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error('fixture_request_too_large');
        chunks.push(chunk);
      }
      const wireBody = Buffer.concat(chunks);
      const body = request.headers['content-encoding'] === 'gzip' ? gunzipSync(wireBody) : wireBody;
      const decoded = decodeOtlpRecords(body);
      requests.push({ method: request.method, url: request.url, headers: { ...request.headers }, body, decoded, status });
      if (status === 200 && persist) records.push(...decoded);
      response.writeHead(status, { 'content-type': 'application/x-protobuf' });
      // An empty protobuf ExportTraceServiceResponse means full acceptance.
      response.end();
    } catch {
      response.writeHead(400, { 'content-type': 'application/x-protobuf' });
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/traces`,
    requests,
    records,
    async close() {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
