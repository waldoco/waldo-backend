import { describe, expect, it } from 'vitest';
import { canonicalJson, parseStrictJson } from '../src/devices/canonical-json';
describe('device canonical JSON', () => {
  it('orders Unicode scalars without normalization and uses shortest escapes', () => {
    const input = { '\u{10000}': 'plane', '\ue000': 'private', 'é': 'café', text: '<>&/\n\t"\\', 'e\u0301': 'combining' };
    expect(canonicalJson(input)).toBe('{"é":"combining","text":"<>&/\\n\\t\\"\\\\","é":"café","":"private","𐀀":"plane"}');
  });
  it.each(['{"a":1,"a":2}', '{"nested":{"x":1,"x":2}}', '{"a":"\\ud800"}', '{"a":1.5}', '{"a":1e1}', '{"a":01}', '{"a":9007199254740993}', '{"a":-0}'])('rejects ambiguous input %s', (raw) => {
    expect(() => parseStrictJson(new TextEncoder().encode(raw))).toThrow();
  });
  it('rejects invalid UTF-8 and noncanonical frame bytes', () => {
    expect(() => parseStrictJson(new Uint8Array([0xc0, 0xaf]))).toThrow();
    expect(() => parseStrictJson(new TextEncoder().encode('{ "b":2,"a":1}'), true)).toThrow();
    expect(parseStrictJson(new TextEncoder().encode('{"a":1,"b":2}'), true)).toEqual({ a: 1, b: 2 });
    expect(() => parseStrictJson(new TextEncoder().encode('\ufeff{"a":1}'), true)).toThrow();
  });
});
