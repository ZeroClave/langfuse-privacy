import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import protobuf from 'protobufjs';

// Independent decoder for the public SLS LogGroup wire format. The official SDK
// encodes requests; neither its serializer nor an in-memory preview constructs
// these stored records.
const logGroup = protobuf.parse(`
syntax = "proto2";
message Content { required string key = 1; required string value = 2; }
message Log { required uint32 time = 1; repeated Content contents = 2; }
message LogTag { required string key = 1; required string value = 2; }
message LogGroup {
  repeated Log logs = 1;
  optional string topic = 3;
  optional string source = 4;
  repeated LogTag tags = 6;
}
`).root.lookupType('LogGroup');

export function decodeSlsRecords(body) {
  const group = logGroup.decode(body);
  return group.logs.map((log) => ({
    ...Object.fromEntries(log.contents.map(({ key, value }) => [key, value])),
    __time__: String(log.time),
    __topic__: group.topic ?? '',
    __source__: group.source ?? '',
  }));
}

function validSignature(request, url, body, credentials) {
  const headers = request.headers;
  const canonicalHeaders = Object.keys(headers)
    .filter((key) => key.startsWith('x-log-') || key.startsWith('x-acs-'))
    .sort().map((key) => `${key}:${String(headers[key]).trim()}\n`).join('');
  const query = [...url.searchParams.entries()].map(([key, value]) => `${key}=${value}`).sort().join('&');
  const resource = `${url.pathname}${query ? `?${query}` : ''}`;
  const signed = `${request.method}\n${headers['content-md5'] ?? ''}\n${headers['content-type'] ?? ''}\n`
    + `${headers.date}\n${canonicalHeaders}${resource}`;
  const signature = createHmac('sha1', credentials.accessKeySecret).update(signed).digest('base64');
  const expected = Buffer.from(`LOG ${credentials.accessKeyId}:${signature}`);
  const actual = Buffer.from(headers.authorization ?? '');
  if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) return false;
  if (credentials.securityToken !== headers['x-acs-security-token']) return false;
  if (body.length && (headers['content-md5'] !== createHash('md5').update(body).digest('hex').toUpperCase()
    || Number(headers['x-log-bodyrawsize']) !== body.length)) return false;
  return true;
}

/** Local protocol fixture, not an Alibaba service emulator or cloud proof. */
export async function startSlsCollector({
  credentials,
  logstore = 'privacy-demo',
  persist = true,
  writeStatus = 200,
  queryStatus = 200,
  queryError = {},
  progress = 'Complete',
  transformRows = (rows) => rows,
} = {}) {
  if (!credentials) throw new Error('fixture_missing_synthetic_credentials');
  const requests = [];
  const records = [];
  let queryCalls = 0;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error('fixture_request_too_large');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const url = new URL(request.url, 'http://localhost');
      const signed = validSignature(request, url, body, credentials);
      const entry = { method: request.method, path: url.pathname,
        query: Object.fromEntries(url.searchParams), body, signed, status: 0 };
      requests.push(entry);
      const send = (status, value, headers = {}) => {
        entry.status = status;
        response.writeHead(status, { 'content-type': 'application/json', 'x-log-requestid': 'local-fixture-only', ...headers });
        response.end(JSON.stringify(value));
      };
      if (!signed) return send(403, { errorCode: 'SignatureNotMatch', errorMessage: 'Synthetic signature rejected.' });
      if (request.method === 'POST' && url.pathname === `/logstores/${logstore}/shards/lb`) {
        if (request.headers['content-type'] !== 'application/x-protobuf') return send(415, {});
        const decoded = decodeSlsRecords(body);
        entry.decoded = decoded;
        if (writeStatus === 200 && persist) records.push(...decoded);
        // Deliberately allow a body with no SDK-recognized error. The adapter
        // must independently reject non-2xx statuses.
        if (writeStatus !== 200) return send(writeStatus, {});
        entry.status = 200;
        response.writeHead(200, { 'x-log-requestid': 'local-fixture-only' });
        return response.end();
      }
      if (request.method === 'GET' && url.pathname === `/logstores/${logstore}`) {
        if (url.searchParams.get('type') !== 'log') return send(400, {});
        const match = /^runId:"([a-f0-9]{32})"$/u.exec(url.searchParams.get('query') ?? '');
        if (!match) return send(400, {});
        const from = Number(url.searchParams.get('from'));
        const to = Number(url.searchParams.get('to'));
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const line = Number(url.searchParams.get('line') ?? 100);
        const selected = records.filter((row) => row.runId === match[1]
          && Number(row.__time__) >= from && Number(row.__time__) < to).slice(offset, offset + line);
        const status = typeof queryStatus === 'function' ? queryStatus(++queryCalls) : queryStatus;
        return send(status, status === 200 ? transformRows(selected) : queryError,
          { 'x-log-progress': progress });
      }
      send(404, {});
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
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

/**
 * Only synthetic credentials may be used. This explicit test adapter omits the
 * project DNS prefix to reach loopback; production always uses regional HTTPS.
 * Serialization, V1/STS signing, HTTP and response handling remain the SDK's.
 */
export async function createLocalSlsClient(config, receiver) {
  const { default: Client } = await import('@alicloud/log');
  const sdk = new Client({
    endpoint: receiver.url,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    ...(config.securityToken ? { securityToken: config.securityToken } : {}),
  });
  return {
    use_https: false,
    postLogStoreLogs(project, ...args) {
      if (project !== config.project) throw new Error('fixture_wrong_project');
      return sdk.postLogStoreLogs(undefined, ...args);
    },
    getLogs(project, ...args) {
      if (project !== config.project) throw new Error('fixture_wrong_project');
      return sdk.getLogs(undefined, ...args);
    },
  };
}
