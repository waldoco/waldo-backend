import { describe, expect, it } from 'vitest';
import { buildMemoryDestination, isMemoryCursor, isMemoryItemId, parseMemoryDestination, type MemoryDestination } from './destinations';

const cases: MemoryDestination[] = [
  { kind: 'list', view: 'spots' },
  { kind: 'list', view: 'constellation', cursor: 'eyJ2IjoxLCJrIjoiaW50ZXJwcmV0YXRpb25zIiwiYWZ0ZXIiOjF9' },
  { kind: 'detail', view: 'spots', id: 'owner:claim:7', returnTo: { view: 'spots', cursor: 'page_two' } },
  { kind: 'detail', view: 'constellation', id: 'owner:node:9', returnTo: { view: 'spots', cursor: 'origin_page' } },
  { kind: 'explore', id: 'owner:node:9', cursor: 'graph_page', returnTo: { view: 'constellation', cursor: 'list_page' } },
  { kind: 'profile' },
];

describe('Memory destination contract', () => {
  it('exposes the same selector validation to the protected response decoder', () => {
    expect(isMemoryItemId('a'.repeat(256))).toBe(true);
    expect(isMemoryItemId('a'.repeat(257))).toBe(false);
    expect(isMemoryCursor('a'.repeat(512))).toBe(true);
    expect(isMemoryCursor('a'.repeat(513))).toBe(false);
    for (const selector of ['', undefined, 7, '\n', '\ud800']) {
      expect(isMemoryItemId(selector)).toBe(false);
      expect(isMemoryCursor(selector)).toBe(false);
    }
  });
  it.each(cases)('round trips exact typed destination %j', destination => {
    const link = buildMemoryDestination(destination);
    expect(link.startsWith('#/memory/')).toBe(true);
    expect(parseMemoryDestination(link)).toEqual({ kind: 'valid-memory', destination });
  });

  it('preserves existing Memory aliases and leaves other routes to their existing resolver', () => {
    for (const alias of ['memory', '/memory', '#memory', '#/memory', '#/memory/spots']) {
      expect(parseMemoryDestination(alias)).toEqual({ kind: 'valid-memory', destination: { kind: 'list', view: 'spots' } });
    }
    expect(parseMemoryDestination('#/memory?id=owner%3Aclaim%3A7')).toEqual({ kind: 'valid-memory', destination: { kind: 'detail', view: 'spots', id: 'owner:claim:7' } });
    for (const route of ['', '#/overview', '#/today', '#/files/workspace', '#main', '#/memories']) {
      expect(parseMemoryDestination(route)).toEqual({ kind: 'non-memory' });
    }
  });

  it('encodes delimiter and Unicode IDs without creating query parameters or HTML', () => {
    const destination: MemoryDestination = { kind: 'detail', view: 'spots', id: '雪 & ? # / + = % :7' };
    const link = buildMemoryDestination(destination);
    expect(link).not.toContain('雪');
    expect(link).not.toContain('&');
    expect(parseMemoryDestination(link)).toEqual({ kind: 'valid-memory', destination });
  });

  it.each([
    '#/memory/unknown', '#/memory/spots/', '#/memory/spots?id=',
    '#/memory/spots?id=a&id=b', '#/memory/spots?id=a&%69d=b',
    '#/memory/spots?cursor=a&cursor=b', '#/memory/spots?token=secret',
    '#/memory/spots?id=a&csrf=secret', '#/memory/spots?id=a&next=https://foreign.test',
    '#/memory/spots?id=a&cursor=b', '#/memory/spots?explore=1',
    '#/memory/spots?id=a&explore=1', '#/memory/constellation?explore=1',
    '#/memory/constellation?id=a&explore=0', '#/memory/constellation?id=a&explore=true',
    '#/memory/profile?id=a', '#/memory/profile?cursor=a',
    '#/memory/spots?returnView=spots', '#/memory/spots?id=a&returnCursor=a',
    '#/memory/spots?id=a&returnView=profile', '#/memory/spots?id=a&returnView=spots&returnCursor=',
    '#/memory/spots?id=%', '#/memory/spots?id=%C0%AF', '#/memory/spots?%zz=a',
    '#/memory/spots?id=\ud800', '#/memory/spots?cursor=\udfff',
    '#/memory/spots?id=a#second', '#/memory/spots?id=%00', '#/memory/spots?cursor=%0A',
    '#/memory/spots?id=' + 'a'.repeat(257), '#/memory/spots?cursor=' + 'a'.repeat(513),
    '#/memory/spots?id=a&returnView=spots&returnCursor=' + 'a'.repeat(513),
  ])('rejects invalid Memory destination %s', link => {
    expect(parseMemoryDestination(link)).toEqual({ kind: 'invalid-memory' });
  });

  it.each(['https://foreign.test/console/dashboard#/memory/spots', '//foreign.test/#/memory/spots', 'javascript:alert(1)#/memory/spots'])('rejects URL input rather than making a navigation URL: %s', url => {
    expect(parseMemoryDestination(url)).toEqual({ kind: 'invalid-memory' });
  });

  it('separates list-return context from selected detail and graph pagination', () => {
    const destination: MemoryDestination = { kind: 'explore', id: 'owner:node:9', cursor: 'graph_page', returnTo: { view: 'spots', cursor: 'list_page' } };
    const link = buildMemoryDestination(destination);
    expect(link).toContain('explore=1');
    expect(link).toContain('cursor=graph_page');
    expect(link).toContain('returnView=spots&returnCursor=list_page');
    expect(parseMemoryDestination(link)).toEqual({ kind: 'valid-memory', destination });
    expect(buildMemoryDestination({ kind: 'list', ...destination.returnTo! })).toBe('#/memory/spots?cursor=list_page');
  });

  it('does not decode, refresh or bind a well-formed cursor to another owner', () => {
    expect(parseMemoryDestination('#/memory/spots?cursor=old_position')).toEqual({ kind: 'valid-memory', destination: { kind: 'list', view: 'spots', cursor: 'old_position' } });
  });

  it('refuses invalid runtime builder inputs instead of returning a plausible link', () => {
    for (const destination of [
      { kind: 'detail', view: 'spots', id: '' },
      { kind: 'detail', view: 'spots', id: undefined },
      { kind: 'detail', view: 'spots', id: null },
      { kind: 'detail', view: 'spots', id: 7 },
      { kind: 'detail', view: 'spots', id: '\ud800' },
      { kind: 'list', view: 'spots?id=a' },
      { kind: 'list', view: 'profile' },
      { kind: 'detail', view: 'constellation?id=a&explore=1', id: 'b' },
      { kind: 'explore', id: undefined },
      { kind: 'detail', view: 'spots', id: 'a', cursor: 'b' },
      { kind: 'profile', id: 'a' },
      { kind: 'list', view: 'spots', returnTo: { view: 'spots' } },
      { kind: 'detail', view: 'spots', id: 'a', returnTo: { view: 'spots', next: 'foreign' } },
      { kind: 'list', view: 'spots', cursor: '\n' },
      { kind: 'list', view: 'spots', cursor: 7 },
      { kind: 'list', view: 'spots', cursor: '\udfff' },
      { kind: 'explore', id: 'a', cursor: null },
      { kind: 'detail', view: 'spots', id: 'a', returnTo: { view: 'spots', cursor: 7 } },
      { kind: 'detail', view: 'spots', id: 'a', returnTo: { view: 'profile' } },
      { kind: 'unknown' },
    ]) expect(() => buildMemoryDestination(destination as MemoryDestination)).toThrow(TypeError);
  });
});
