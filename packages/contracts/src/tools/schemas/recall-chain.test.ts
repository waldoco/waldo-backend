import { describe, expect, it } from 'vitest';
import { searchHistoryArgsSchema, searchHistoryChainArgsSchema } from './history';
import { searchEpisodesArgsSchema, searchEpisodesChainArgsSchema } from './reads';

// With the recall chain on, search_history reads one entry by its ref and search_episodes narrows to one surface. The
// schemas the model is shown while it is off stay the ones it had.
describe('search_history with the recall chain', () => {
  it.each([
    ['everything the base schema takes', { query: 'flight', kinds: ['run'], limit: 5 }],
    ['one run by its ref', { ref: 'background_runs:bg:abc123' }],
    ['one card by its ref', { ref: 'ledger:a1' }],
    ['an archived task by its ref', { ref: 'task_jobs:job-7' }],
  ])('accepts %s', (_name, args) => {
    expect(searchHistoryChainArgsSchema.safeParse(args).success).toBe(true);
  });

  it.each([
    ['a ref with a query', { ref: 'ledger:a1', query: 'dentist' }],
    ['a ref with kinds', { ref: 'ledger:a1', kinds: ['approval'] }],
    ['a ref with a cursor', { ref: 'ledger:a1', cursor: '1:ledger:a1' }],
    ['a ref with a window', { ref: 'ledger:a1', from: '2026-10-01T00:00:00Z' }],
    ['a ref from another store', { ref: 'claims:12' }],
    ['a ref with no id', { ref: 'ledger:' }],
    ['a window that ends before it starts', { from: '2026-11-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }],
  ])('rejects %s', (_name, args) => {
    expect(searchHistoryChainArgsSchema.safeParse(args).success).toBe(false);
  });

  it('leaves the base schema without a ref', () => {
    expect(searchHistoryArgsSchema.safeParse({ ref: 'ledger:a1' }).success).toBe(false);
  });
});

describe('search_episodes with the recall chain', () => {
  it.each([
    ['a query on one surface', { query: 'flight', surface: 'whatsapp' }],
    ['a query on Telegram', { query: 'flight', surface: 'telegram' }],
    ['a ref, as before', { ref: '12' }],
  ])('accepts %s', (_name, args) => {
    expect(searchEpisodesChainArgsSchema.safeParse(args).success).toBe(true);
  });

  it.each([
    ['a surface with a ref', { ref: '12', surface: 'app' }],
    ['a surface that is not a word', { query: 'flight', surface: 'whats%' }],
    ['a surface in capitals', { query: 'flight', surface: 'WhatsApp' }],
    ['both query and ref', { query: 'flight', ref: '12' }],
    ['neither query nor ref', { surface: 'app' }],
  ])('rejects %s', (_name, args) => {
    expect(searchEpisodesChainArgsSchema.safeParse(args).success).toBe(false);
  });

  it('leaves the base schema without a surface', () => {
    expect(searchEpisodesArgsSchema.safeParse({ query: 'flight', surface: 'whatsapp' }).success).toBe(false);
  });
});
