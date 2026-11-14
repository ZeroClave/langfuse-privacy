import { ZeroClavePrivacyError } from './error.js';

export interface Entity {
  start: number;
  end: number;
  type: string;
}

/** Map service codepoint offsets to JavaScript UTF-16 offsets without normalization. */
export function boundaries(text: string): number[] {
  const result = [0];
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new ZeroClavePrivacyError('unsupported_input');
      }
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new ZeroClavePrivacyError('unsupported_input');
    }
    result.push(index + 1);
  }
  return result;
}

/** Merge intersecting spans so nested/overlapping predictions cannot expose suffixes. */
export function redact(text: string, offsets: number[], entities: Entity[]): string {
  const ranges = entities.map((entity) => {
    const start = offsets[entity.start];
    const end = offsets[entity.end];
    if (start === undefined || end === undefined || entity.start < 0 || entity.end <= entity.start) {
      throw new ZeroClavePrivacyError('invalid_response');
    }
    return { start, end, type: entity.type };
  }).sort((a, b) => a.start - b.start || b.end - a.end);

  const merged: typeof ranges = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end);
      if (previous.type !== range.type) previous.type = 'PII';
    } else {
      merged.push({ ...range });
    }
  }
  let output = '';
  let cursor = 0;
  for (const range of merged) {
    output += text.slice(cursor, range.start) + `[REDACTED_${range.type}]`;
    cursor = range.end;
  }
  return output + text.slice(cursor);
}
