import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { BasicTracerProvider, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { createZeroClaveMask, DEFAULT_ZEROCLAVE_ENDPOINT } from '../dist/index.js';

const INPUT = 'langfuse.observation.input';
const FAILURE_MASK = '<fully masked due to failed mask function>';
const MAX_BODY_BYTES = 65_536;

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readText(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error('invalid_input');
    chunks.push(chunk);
  }
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!value || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 10_000) {
    throw new Error('invalid_input');
  }
  return value.text;
}

export async function createDemoServer({
  endpoint = DEFAULT_ZEROCLAVE_ENDPOINT,
  timeoutMs = 15_000,
  fetch: fetcher = globalThis.fetch,
} = {}) {
  const page = await readFile(new URL('./index.html', import.meta.url));
  // Validate configuration at startup rather than making every request fail later.
  createZeroClaveMask({ endpoint, timeoutMs, maxRetries: 0, fetch: fetcher });
  let active = 0;

  return createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const path = request.url?.split('?')[0];
    if (request.method === 'GET' && path === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page);
      return;
    }
    if (request.method === 'GET' && path === '/healthz') {
      json(response, 200, { ok: true, service: 'zeroclave-langfuse-demo' });
      return;
    }
    if (request.method !== 'POST' || path !== '/api/demo') {
      json(response, 404, { ok: false, error: '未找到这个页面。' });
      return;
    }
    const origin = request.headers.origin;
    try {
      if (origin && new URL(origin).host !== request.headers.host) throw new Error();
    } catch {
      json(response, 403, { ok: false, error: '请从演示页面发起请求。' });
      return;
    }
    if (!/^application\/json(?:\s*;|$)/iu.test(request.headers['content-type'] ?? '')) {
      json(response, 415, { ok: false, error: '请求需要使用 JSON 格式。' });
      return;
    }
    if (active >= 2) {
      json(response, 429, { ok: false, error: '演示正在处理其他请求，请稍后重试。' });
      return;
    }
    active++;
    const startedAt = performance.now();
    const disconnect = new AbortController();
    response.on('close', () => {
      if (!response.writableEnded) disconnect.abort();
    });
    let provider;
    try {
      let text;
      try {
        text = await readText(request);
      } catch {
        json(response, 400, { ok: false, error: '请输入 1–10,000 个字符的文本。' });
        return;
      }
      const stats = { durationMs: 0, requests: 0, entities: 0, modelVersion: '', status: 'no_findings' };
      const observedFetch = async (url, init) => {
        stats.requests++;
        const result = await fetcher(url, {
          ...init,
          signal: AbortSignal.any([init.signal, disconnect.signal].filter(Boolean)),
        });
        const details = await result.clone().json().catch(() => null);
        if (details && typeof details === 'object') {
          if (typeof details.model_version === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/u.test(details.model_version)) {
            stats.modelVersion = details.model_version;
          }
          if (Array.isArray(details.results)) {
            stats.entities += details.results.reduce((total, item) => total + (Array.isArray(item?.entities) ? item.entities.length : 0), 0);
          }
        }
        return result;
      };
      const mask = createZeroClaveMask({ endpoint, timeoutMs, maxRetries: 0, fetch: observedFetch });
      const exporter = new InMemorySpanExporter();
      provider = new BasicTracerProvider({ spanProcessors: [new LangfuseSpanProcessor({
        exporter,
        exportMode: 'immediate',
        mediaUploadEnabled: false,
        shouldExportSpan: () => true,
        mask,
      })] });
      const span = provider.getTracer('zeroclave-demo').startSpan('privacy-demo');
      span.setAttribute(INPUT, JSON.stringify({ messages: [{ role: 'user', content: text }] }));
      span.end();
      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      if (spans.length !== 1 || typeof spans[0].attributes[INPUT] !== 'string'
        || spans[0].attributes[INPUT] === FAILURE_MASK) throw new Error('detection_failed');
      const attributes = { ...spans[0].attributes };
      const masked = JSON.parse(attributes[INPUT]);
      const maskedText = masked?.messages?.[0]?.content;
      if (typeof maskedText !== 'string') throw new Error('invalid_output');
      stats.durationMs = Math.round(performance.now() - startedAt);
      stats.status = stats.entities > 0 ? 'masked' : 'no_findings';
      json(response, 200, { ok: true, maskedText, attributes, stats });
    } catch {
      if (!response.destroyed && !response.headersSent) {
        json(response, 503, { ok: false, error: '检测未能完整完成，本次结果已屏蔽，请稍后重试。' });
      }
    } finally {
      await provider?.shutdown().catch(() => {});
      active--;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 3017);
  const server = await createDemoServer({
    endpoint: process.env.ZEROCLAVE_ENDPOINT ?? DEFAULT_ZEROCLAVE_ENDPOINT,
    timeoutMs: Number(process.env.ZEROCLAVE_TIMEOUT_MS ?? 15_000),
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.listen(port, host, () => console.log(`ZeroClave Langfuse demo listening on ${host}:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 20_000).unref();
  });
}
