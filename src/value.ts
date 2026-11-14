import { ZeroClavePrivacyError } from './error.js';
import { boundaries } from './text.js';

export interface TextEntry {
  id: string;
  revision: string;
  text: string;
  offsets: number[];
}

interface ValueNode {
  render(replacements: ReadonlyMap<string, string>): unknown;
}

/** A single callback has bounded work, even when its value contains serialized JSON. */
export function prepareValue(data: unknown): { texts: TextEntry[]; render: ValueNode['render'] } {
  const texts: TextEntry[] = [];
  const ancestors = new Set<object>();
  let nodes = 0;
  let codepoints = 0;
  const revision = crypto.randomUUID();

  function visit(value: unknown, depth: number): ValueNode {
    if (++nodes > 10_000 || depth > 32) throw new ZeroClavePrivacyError('input_too_large');
    if (typeof value === 'string') {
      // Bound length before JSON.parse; nested JSON and keys also count toward memory use.
      if (value.length > 1_000_000) throw new ZeroClavePrivacyError('input_too_large');
      // Langfuse passes input/output as serialized JSON; metadata is usually decoded.
      let parsed: unknown;
      let isJson = false;
      try {
        parsed = JSON.parse(value);
        // Numeric/boolean JSON-looking strings may themselves be sensitive text.
        isJson = (parsed !== null && typeof parsed === 'object') || typeof parsed === 'string';
      } catch { /* Ordinary text. */ }
      if (isJson) {
        const child = visit(parsed, depth + 1);
        // Always serialize the inspected tree. Returning the original JSON could expose
        // uninspected values hidden by duplicate keys that JSON.parse discarded.
        return { render: (replacements) => JSON.stringify(child.render(replacements)) };
      }
      if (value.length === 0) return { render: () => value };
      const offsets = boundaries(value);
      codepoints += offsets.length - 1;
      if (codepoints > 100_000 || texts.length >= 2048) throw new ZeroClavePrivacyError('input_too_large');
      const id = `text-${texts.length}`;
      texts.push({ id, revision, text: value, offsets });
      return {
        render(replacements) {
          const masked = replacements.get(id);
          if (masked === undefined) throw new ZeroClavePrivacyError('invalid_response');
          return masked;
        },
      };
    }
    if (value === null || value === undefined || typeof value === 'boolean'
      || typeof value === 'number' && Number.isFinite(value)) {
      return { render: () => value };
    }
    if (typeof value !== 'object') throw new ZeroClavePrivacyError('unsupported_input');
    if (ancestors.has(value)) throw new ZeroClavePrivacyError('unsupported_input');
    const array = Array.isArray(value);
    if (array && value.length > 10_000) throw new ZeroClavePrivacyError('input_too_large');
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new ZeroClavePrivacyError('unsupported_input');
    }
    ancestors.add(value);
    const children: [string, ValueNode][] = [];
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      if (typeof key !== 'string' || !('value' in descriptor)) {
        throw new ZeroClavePrivacyError('unsupported_input');
      }
      if (key.length > 10_000) throw new ZeroClavePrivacyError('input_too_large');
      children.push([key, visit(descriptor.value, depth + 1)]);
    }
    ancestors.delete(value);
    return {
      render(replacements) {
        const output = array ? new Array((value as unknown[]).length) : {};
        for (const [key, child] of children) {
          // defineProperty handles literal __proto__ keys without changing the prototype.
          Object.defineProperty(output, key, {
            value: child.render(replacements), enumerable: true, writable: true, configurable: true,
          });
        }
        return output;
      },
    };
  }

  const root = visit(data, 0);
  return { texts, render: root.render };
}
