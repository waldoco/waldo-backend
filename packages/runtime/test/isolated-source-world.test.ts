import { describe, expect, it } from 'vitest';
import { IsolatedSourceWorld, type WorldFixture } from '../scenarios/isolated-source-world';

const fixture = (): WorldFixture => ({
  clock: '2026-10-06T09:00:00+05:30',
  owners: [{ id: 'a' }, { id: 'b' }],
  sources: { mail: [
    { owner_id: 'a', id: 'same-id', body: 'alpha draft', version: 1 },
    { owner_id: 'b', id: 'same-id', body: 'beta private', version: 1 },
  ] },
  revisions: [{ at: '2026-10-06T10:00:00+05:30', owner_id: 'a', source: 'mail', id: 'same-id', patch: { body: 'alpha revised', version: 2 } }],
});

describe('isolated source and effect world', () => {
  it('isolates same IDs by owner and returns copies, never mutable backing rows', () => {
    const world = new IsolatedSourceWorld(fixture());
    const a = world.read('a', 'mail', 'same-id')!;
    (a as unknown as { body: string }).body = 'tampered';
    expect(world.read('a', 'mail', 'same-id')?.body).toBe('alpha draft');
    expect(world.read('b', 'mail', 'same-id')?.body).toBe('beta private');
    expect(world.read('a', 'mail', 'missing')).toBeNull();
    expect(() => world.list('stranger', 'mail')).toThrow(/unknown owner/);
  });
  it('applies source revisions at the clock boundary and resets on a fresh trial', () => {
    const world = new IsolatedSourceWorld(fixture());
    world.advance('2026-10-06T09:59:59+05:30');
    expect(world.read('a', 'mail', 'same-id')?.version).toBe(1);
    world.advance('2026-10-06T10:00:00+05:30');
    expect(world.read('a', 'mail', 'same-id')?.version).toBe(2);
    expect(world.read('b', 'mail', 'same-id')?.version).toBe(1);
    expect(new IsolatedSourceWorld(fixture()).read('a', 'mail', 'same-id')?.version).toBe(1);
    expect(() => world.advance('2026-10-06T09:00:00+05:30')).toThrow(/backward/);
  });
  it('intercepts effects, keys retries, rejects changed retries and separates outboxes', () => {
    const world = new IsolatedSourceWorld(fixture());
    const effect = { owner_id: 'a', kind: 'send', target: 'leena@example.test', payload: { body: 'hello' }, idempotency_key: 'op-1' };
    expect(world.intercept(effect)).toEqual(world.intercept(effect));
    expect(world.outbox('a')).toHaveLength(1);
    expect(world.outbox('b')).toEqual([]);
    expect(() => world.intercept({ ...effect, payload: { body: 'changed' } })).toThrow(/collision/);
    expect(() => world.intercept({ ...effect, owner_id: 'unknown' })).toThrow(/unknown owner/);
  });
});
