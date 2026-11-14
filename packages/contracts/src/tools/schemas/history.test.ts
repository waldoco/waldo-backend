import { describe, expect, it } from 'vitest';
import { searchHistoryArgsSchema } from './history';

describe('search_history', () => {
  it.each([
    ['no arguments', {}],
    ['a query', { query: 'flight check-in' }],
    ['some kinds', { kinds: ['run', 'approval'] }],
    ['a window', { from: '2026-10-01T00:00:00+05:30', to: '2026-11-01T00:00:00+05:30' }],
    ['a cursor from a previous page', { cursor: '1793000000000:background_runs:bg:abc123' }],
    ['the largest page', { limit: 20 }],
  ])('accepts %s', (_name, args) => {
    expect(searchHistoryArgsSchema.safeParse(args).success).toBe(true);
  });

  it('pages ten by default', () => {
    expect(searchHistoryArgsSchema.parse({}).limit).toBe(10);
  });

  it.each([
    ['an empty query', { query: '' }],
    ['a query over 200 characters', { query: 'x'.repeat(201) }],
    ['an unknown kind', { kinds: ['email'] }],
    ['no kinds', { kinds: [] }],
    ['a kind twice', { kinds: ['run', 'run'] }],
    ['a date without an offset', { from: '2026-10-01' }],
    ['a window that ends before it starts', { from: '2026-11-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }],
    ['a cursor that is not ours', { cursor: 'page-2' }],
    ['a page over 20', { limit: 21 }],
    ['a page of none', { limit: 0 }],
    ['a payload field', { payload: true }],
  ])('rejects %s', (_name, args) => {
    expect(searchHistoryArgsSchema.safeParse(args).success).toBe(false);
  });
});
