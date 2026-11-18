import { describe, expect, it } from 'vitest';
import { watchingChangeV1Schema, watchingCloseV1Schema, watchingListV1Schema, watchingMoveV1Schema } from './watching';

const item = { id: 'loop:12', title: 'Check how today\'s run went', why: 'The 18:00 run slipped twice this week.', due_at: '2026-11-17T19:30:00.000Z', source: 'planning', from_outside: false } as const;

describe('the watching list', () => {
  it('valid: a list in due order, and an empty one', () => {
    expect(watchingListV1Schema.safeParse({ items: [item, { ...item, id: 'loop:13', source: 'mail', from_outside: true }] }).success).toBe(true);
    expect(watchingListV1Schema.safeParse({ items: [] }).success).toBe(true);
  });
  it('invalid: an extra field (no health number rides along), a repeated item, an empty title, another kind of id', () => {
    expect(watchingListV1Schema.safeParse({ items: [{ ...item, value: 42 }] }).success).toBe(false);
    expect(watchingListV1Schema.safeParse({ items: [item, item] }).success).toBe(false);
    expect(watchingListV1Schema.safeParse({ items: [{ ...item, title: ' ' }] }).success).toBe(false);
    expect(watchingListV1Schema.safeParse({ items: [{ ...item, id: 'o123' }] }).success).toBe(false);
    expect(watchingListV1Schema.safeParse({ items: [{ ...item, due_at: '2026-11-17T19:30' }] }).success).toBe(false);
  });
});

describe('closing and moving one', () => {
  it('valid requests and answers', () => {
    expect(watchingCloseV1Schema.safeParse({ request_id: 'req_fixture_1', id: 'loop:12' }).success).toBe(true);
    expect(watchingMoveV1Schema.safeParse({ request_id: 'req_fixture_1', id: 'loop:12', due_at: '2026-11-19T08:00:00.000Z' }).success).toBe(true);
    expect(watchingChangeV1Schema.safeParse({ request_id: 'req_fixture_1', id: 'loop:12', state: 'moved', due_at: '2026-11-19T08:00:00Z' }).success).toBe(true);
  });
  it('invalid: a short request id, a move with no instant, an answer of another state', () => {
    expect(watchingCloseV1Schema.safeParse({ request_id: 'short', id: 'loop:12' }).success).toBe(false);
    expect(watchingMoveV1Schema.safeParse({ request_id: 'req_fixture_1', id: 'loop:12' }).success).toBe(false);
    expect(watchingChangeV1Schema.safeParse({ request_id: 'req_fixture_1', id: 'loop:12', state: 'done' }).success).toBe(false);
  });
});
