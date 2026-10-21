const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function scalarString(value: string): void {
  // Lone UTF-16 surrogates cannot have a unique valid UTF-8 wire representation.
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('invalid_shape');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('invalid_shape');
  }
}
const compareScalars = (left: string, right: string): number => {
  const a = [...left].map((char) => char.codePointAt(0)!), b = [...right].map((char) => char.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
};
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') { scalarString(value); return JSON.stringify(value); }
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error('invalid_shape');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort(compareScalars).map((key) => `${canonicalJson(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  throw new Error('invalid_shape');
}
export function parseStrictJson(bytes: Uint8Array, requireCanonical = false): unknown {
  const source = utf8.decode(bytes);
  let position = 0;
  const reject = (): never => { throw new Error('invalid_shape'); };
  const space = () => { while (/[ \t\r\n]/.test(source[position] ?? '') && position < source.length) position++; };
  const string = (): string => {
    const start = position++;
    while (position < source.length) {
      const char = source[position++]!;
      if (char === '\\') { position++; continue; }
      if (char === '"') {
        const value: unknown = JSON.parse(source.slice(start, position));
        if (typeof value !== 'string') return reject();
        scalarString(value); return value;
      }
    }
    return reject();
  };
  const value = (depth: number): unknown => {
    // Bounded input must also have bounded nesting to prevent parser stack exhaustion.
    if (depth > JSON_DEPTH_MAX) return reject();
    space(); const char = source[position];
    if (char === '"') return string();
    if (char === '{') {
      position++; const object: Record<string, unknown> = Object.create(null); space();
      if (source[position] === '}') { position++; return object; }
      while (position < source.length) {
        space(); if (source[position] !== '"') return reject();
        const key = string(); if (Object.hasOwn(object, key)) return reject();
        space(); if (source[position++] !== ':') return reject();
        object[key] = value(depth + 1); space(); const delimiter = source[position++];
        if (delimiter === '}') return object;
        if (delimiter !== ',') return reject();
      }
      return reject();
    }
    if (char === '[') {
      position++; const array: unknown[] = []; space();
      if (source[position] === ']') { position++; return array; }
      while (position < source.length) { array.push(value(depth + 1)); space(); const delimiter = source[position++]; if (delimiter === ']') return array; if (delimiter !== ',') return reject(); }
      return reject();
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) if (source.startsWith(token, position)) { position += token.length; return result; }
    const match = /^-?(0|[1-9][0-9]*)/.exec(source.slice(position));
    if (!match) return reject();
    position += match[0].length; const number = Number(match[0]);
    if (!Number.isSafeInteger(number) || Object.is(number, -0)) return reject();
    return number;
  };
  const result = value(0); space();
  if (position !== source.length || (requireCanonical && canonicalJson(result) !== source)) return reject();
  return result;
}
import { JSON_DEPTH_MAX } from './contract';
