import { ZeroClavePrivacyError } from './error.js';
import { redact, type Entity } from './text.js';
import type { TextEntry } from './value.js';

const MAX_RESPONSE_BYTES = 1_048_576;
const RETRYABLE = new Set([429, 503, 504]);
const ENTITY_TYPE = /^[A-Z][A-Z0-9_]{0,63}$/u;

export interface DetectionContext {
  endpoint: string;
  fetch: typeof globalThis.fetch;
  maxRetries: number;
  signal: AbortSignal;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Enforce the deadline even when a supplied fetch implementation ignores its signal. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new ZeroClavePrivacyError('timeout'));
    if (signal.aborted) {
      promise.catch(() => {});
      aborted();
      return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new ZeroClavePrivacyError('invalid_response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new ZeroClavePrivacyError('invalid_response');
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(length);
    let cursor = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, cursor);
      cursor += chunk.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof ZeroClavePrivacyError) throw error;
    throw new ZeroClavePrivacyError('invalid_response');
  } finally {
    reader.releaseLock();
  }
}

function validateAndRedact(
  value: unknown, response: Response, texts: TextEntry[], requestId: string,
): Map<string, string> {
  const header = response.headers.get('x-request-id');
  if (!record(value) || value.request_id !== requestId || header !== null && header !== requestId
    || typeof value.model_version !== 'string' || value.model_version.length === 0
    || !Array.isArray(value.results) || value.results.length !== texts.length) {
    throw new ZeroClavePrivacyError('invalid_response');
  }
  const inputs = new Map(texts.map((text) => [text.id, text]));
  const output = new Map<string, string>();
  for (const result of value.results) {
    if (!record(result) || typeof result.id !== 'string') throw new ZeroClavePrivacyError('invalid_response');
    const input = inputs.get(result.id);
    if (!input || output.has(result.id) || result.revision !== input.revision
      || !Array.isArray(result.entities)) {
      throw new ZeroClavePrivacyError('invalid_response');
    }
    if (result.status === 'partial') throw new ZeroClavePrivacyError('incomplete_detection');
    if (result.status !== 'complete') throw new ZeroClavePrivacyError('invalid_response');
    const entities: Entity[] = result.entities.map((entity: unknown) => {
      if (!record(entity) || !Number.isSafeInteger(entity.start) || !Number.isSafeInteger(entity.end)
        || typeof entity.type !== 'string' || !ENTITY_TYPE.test(entity.type)) {
        throw new ZeroClavePrivacyError('invalid_response');
      }
      return { start: entity.start as number, end: entity.end as number, type: entity.type };
    });
    output.set(input.id, redact(input.text, input.offsets, entities));
  }
  return output;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(new ZeroClavePrivacyError('timeout'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const value = response?.headers.get('retry-after');
  if (value) {
    const seconds = Number(value);
    const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    if (Number.isFinite(milliseconds)) return Math.min(60_000, Math.max(0, milliseconds));
  }
  return Math.min(2000, 200 * 2 ** attempt) + Math.random() * 100;
}

async function detectBatch(texts: TextEntry[], context: DetectionContext): Promise<Map<string, string>> {
  const requestId = `lf-${crypto.randomUUID()}`;
  const body = JSON.stringify({ texts: texts.map(({ id, revision, text }) => ({ id, revision, text })) });
  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined;
    try {
      response = await abortable(context.fetch(context.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-id': requestId },
        body,
        signal: context.signal,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      }), context.signal);
    } catch {
      if (context.signal.aborted) throw new ZeroClavePrivacyError('timeout');
      if (attempt >= context.maxRetries) throw new ZeroClavePrivacyError('detection_failed');
      await delay(retryDelay(undefined, attempt), context.signal);
      continue;
    }
    if (response.status !== 200) {
      // Do not parse or log arbitrary server error messages, which might contain input.
      void response.body?.cancel().catch(() => {});
      if (RETRYABLE.has(response.status) && attempt < context.maxRetries) {
        await delay(retryDelay(response, attempt), context.signal);
        continue;
      }
      throw new ZeroClavePrivacyError('detection_failed');
    }
    const value = await readJson(response, context.signal);
    return validateAndRedact(value, response, texts, requestId);
  }
}

export async function detectAndRedact(texts: TextEntry[], context: DetectionContext): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  for (let index = 0; index < texts.length; index += 64) {
    if (context.signal.aborted) throw new ZeroClavePrivacyError('timeout');
    const batch = await detectBatch(texts.slice(index, index + 64), context);
    for (const [id, value] of batch) output.set(id, value);
  }
  return output;
}
