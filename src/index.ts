import { detectAndRedact } from './client.js';
import { ZeroClavePrivacyError } from './error.js';
import { prepareValue } from './value.js';

export { ZeroClavePrivacyError } from './error.js';
export type { ZeroClavePrivacyErrorCode } from './error.js';

export const DEFAULT_ZEROCLAVE_ENDPOINT = 'https://zeroclave.com/v1/pii/detect';

export interface ZeroClaveMaskOptions {
  /** Full detection URL. HTTPS is required except for loopback development URLs. */
  endpoint?: string;
  /** Total budget for one mask callback, including all batches and retries. Default: 10,000 ms. */
  timeoutMs?: number;
  /** Retries per batch for network errors and HTTP 429/503/504. Default: 1; maximum: 3. */
  maxRetries?: number;
  /** Optional fetch implementation, useful for tests or application transport configuration. */
  fetch?: typeof globalThis.fetch;
}

/** Structurally compatible with @langfuse/otel's MaskFunction; no runtime SDK dependency. */
export type ZeroClaveMaskFunction = (params: { data: unknown }) => Promise<unknown>;

function endpointUrl(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (endpoint.length > 2048 || url.username || url.password || url.search || url.hash
      || url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
      throw new Error();
    }
    return url.toString();
  } catch {
    throw new ZeroClavePrivacyError('invalid_options');
  }
}

/** Create an async Langfuse mask hook. Detection failures always throw; raw input is never a fallback. */
export function createZeroClaveMask(options: ZeroClaveMaskOptions = {}): ZeroClaveMaskFunction {
  const endpoint = endpointUrl(options.endpoint ?? DEFAULT_ZEROCLAVE_ENDPOINT);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxRetries = options.maxRetries ?? 1;
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || !Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 3 || typeof fetcher !== 'function') {
    throw new ZeroClavePrivacyError('invalid_options');
  }
  return async ({ data }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const prepared = prepareValue(data);
      const replacements = await detectAndRedact(prepared.texts, {
        endpoint, fetch: fetcher, maxRetries, signal: controller.signal,
      });
      return prepared.render(replacements);
    } catch (error) {
      if (error instanceof ZeroClavePrivacyError) throw error;
      // Do not include arbitrary fetch/getter/proxy exception messages in Langfuse logs.
      throw new ZeroClavePrivacyError('unsupported_input');
    } finally {
      clearTimeout(timer);
    }
  };
}
