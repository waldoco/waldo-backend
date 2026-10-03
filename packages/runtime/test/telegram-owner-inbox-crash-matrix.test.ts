import { describe, expect, it, vi } from 'vitest';
import { TelegramOwnerInbox, OWNER_INBOX_KEY } from '../src/channels/telegram-owner-inbox';
const fixture = () => {
  const data = new Map<string, unknown>(); let now = 1000; let fail = false;
  const txn = { get: async <T>(k: string) => structuredClone(data.get(k)) as T, put: async (k: string | Record<string, unknown>, v?: unknown) => { if (typeof k === 'string') data.set(k, structuredClone(v)); else for (const [key,value] of Object.entries(k)) data.set(key, structuredClone(value)); } } as DurableObjectTransaction;
  let queue = Promise.resolve();
  const storage = { get: txn.get, transaction: <T>(work: (t: DurableObjectTransaction) => Promise<T>) => { const run = queue.then(async () => { const before = new Map(data); try { return await work(txn); } catch (e) { data.clear(); for (const [k,v] of before) data.set(k,v); throw e; } }); queue = run.then(() => undefined, () => undefined); return run; } } as DurableObjectStorage;
  const persist = vi.fn(async (t: DurableObjectTransaction, rows: unknown, due: number | null) => { await t.put(OWNER_INBOX_KEY, rows); if (fail) throw new Error('alarm commit failed'); await t.put('due', due); });
  const inbox = new TelegramOwnerInbox(storage, persist, () => now);
  const binding = { bot: '7', subject: '42', doName: 'owner42' };
  return { data, storage, persist, inbox, binding, fail: () => { fail = true; }, advance: () => { now += 26 * 3600000; } };
};

// Crash matrix: what the durable inbox does with each record state when the DO restarts with no live attempt.
// Policy under test (current code, not a proposal): an ordinary claimed turn is never replayed. A claimed or consumed
// turn becomes quarantined/recovered_uncertain with its body scrubbed, which is the non_replayable_uncertain class
// applied to the whole turn. One exception: a claimed steer that was never closed returns to the ordinary admission
// queue (recover() in telegram-owner-inbox.ts), because it was never consumed. A claimed attempt that is still
// live is left alone. An unclaimed record is still safe to run once.
describe('owner inbox crash matrix (restart with no live attempt)', () => {
  const seed = async (f: ReturnType<typeof fixture>, upTo: 'admitted' | 'claimed' | 'awaiting_delivery' | 'consumed' | 'completed') => {
    await f.inbox.admit(f.binding, 1, 'turn body'); const id = '7:telegram:1';
    if (upTo === 'admitted') return id;
    await f.inbox.claim(id, 'a1', 'run1', 5000);
    if (upTo !== 'claimed') await f.inbox.transition(id, 'a1', upTo);
    return id;
  };
  const cases: Array<['admitted' | 'claimed' | 'awaiting_delivery' | 'consumed' | 'completed', string, string | undefined]> = [
    ['admitted', 'admitted', undefined],
    ['claimed', 'quarantined', 'recovered_uncertain'],
    ['awaiting_delivery', 'awaiting_delivery', undefined],
    ['consumed', 'quarantined', 'recovered_uncertain'],
    ['completed', 'completed', undefined],
  ];
  for (const [from, to, reason] of cases) {
    it(`${from} -> ${to} after restart`, async () => {
      const f = fixture(); const id = await seed(f, from); await f.inbox.recover(new Set());
      const row = (await f.inbox.records()).find(r => r.id === id)!;
      expect(row.state).toBe(to); expect(row.reason).toBe(reason);
    });
  }
  it('a recovered-uncertain turn is never claimable again and its body is scrubbed', async () => {
    const f = fixture(); const id = await seed(f, 'claimed'); await f.inbox.recover(new Set());
    expect((await f.inbox.records())[0]?.body).toBe('');
    expect(await f.inbox.claim(id, 'a2', 'run2', 9000)).toBeNull();
  });
  it('an unclaimed record survives restart and can be claimed exactly once', async () => {
    const f = fixture(); const id = await seed(f, 'admitted'); await f.inbox.recover(new Set());
    expect(await f.inbox.claim(id, 'a2', 'run2', 9000)).not.toBeNull();
    expect(await f.inbox.claim(id, 'a3', 'run3', 9000)).toBeNull();
  });
  it('a restart replays the duplicate admission as a duplicate, not a second turn', async () => {
    const f = fixture(); await seed(f, 'claimed'); await f.inbox.recover(new Set());
    expect(await f.inbox.admit(f.binding, 1, 'turn body')).toBe('duplicate'); expect(await f.inbox.records()).toHaveLength(1);
  });
  it('an unclosed claimed steer is re-admitted, not quarantined', async () => {
    const f = fixture(); await f.inbox.admit(f.binding, 1, 'steer body', { kind: 'steer', targetRun: 'parent' });
    expect(await f.inbox.claim('7:telegram:1', 'a1', 'run1', 5000)).not.toBeNull(); await f.inbox.recover(new Set());
    const row = (await f.inbox.records())[0]!; expect(row.state).toBe('admitted'); expect(row.body).toBe('steer body');
  });
  it('a claimed attempt that is still live is left alone', async () => {
    const f = fixture(); const id = await seed(f, 'claimed'); await f.inbox.recover(new Set(['a1']));
    const row = (await f.inbox.records()).find(r => r.id === id)!; expect(row.state).toBe('claimed'); expect(row.body).toBe('turn body');
  });
});
