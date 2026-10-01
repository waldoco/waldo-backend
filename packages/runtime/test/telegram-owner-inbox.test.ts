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
describe('supported-owner durable inbox', () => {
  it('admits high then low ID concurrently in admission order, dedupes callbacks without highwater', async () => {
    const f = fixture(); await Promise.all([f.inbox.admit(f.binding, 100, 'high'), f.inbox.admit(f.binding, 2, 'callback')]);
    expect((await f.inbox.records()).map(r => r.updateId)).toEqual([100, 2]);
    expect(await f.inbox.admit(f.binding, 2, 'callback')).toBe('duplicate');
    expect(await f.inbox.admit(f.binding, 2, 'changed')).toBe('conflict');
  });
  it('does not ACK admission when atomic wake commit fails', async () => {
    const f = fixture(); f.fail(); await expect(f.inbox.admit(f.binding, 1, 'x')).rejects.toThrow('alarm commit'); expect(await f.inbox.records()).toEqual([]);
  });
  it('duplicate wins over capacity and active records are never evicted', async () => {
    const f = fixture(); await f.inbox.admit(f.binding, 1, 'x'); const row = (await f.inbox.records())[0]!;
    f.data.set(OWNER_INBOX_KEY, Array.from({ length: 512 }, (_, i) => ({ ...row, id: `7:telegram:${i + 1}`, updateId: i + 1 })));
    expect(await f.inbox.admit(f.binding, 1, 'x')).toBe('duplicate'); expect(await f.inbox.admit(f.binding, 999, 'x')).toBe('capacity'); f.advance(); expect(await f.inbox.admit(f.binding, 999, 'x')).toBe('capacity');
  });
  it('recovers only prior invocation uncertainty, not a live attempt; consumed control never replays', async () => {
    const f = fixture(); await f.inbox.admit(f.binding, 1, 'x'); await f.inbox.admit(f.binding, 2, 'steer', { kind: 'steer', targetRun: 'run1' });
    await f.inbox.claim('7:telegram:1', 'live', 'run1', 2000); await f.inbox.claim('7:telegram:2', 'dead', 'run2', 2000);
    await f.inbox.transition('7:telegram:2', 'dead', 'consumed'); await f.inbox.recover(new Set(['live']));
    expect((await f.inbox.records()).map(r => r.state)).toEqual(['claimed', 'quarantined']);
    expect(await f.inbox.claim('7:telegram:2', 'retry', 'run3', 3000)).toBeNull();
  });
  it('retains terminal tombstones through delivery window and scrubs body', async () => {
    const f = fixture(); await f.inbox.admit(f.binding, 1, 'secret'); await f.inbox.claim('7:telegram:1', 'a', 'r', 2000); await f.inbox.transition('7:telegram:1', 'a', 'completed');
    expect((await f.inbox.records())[0]?.body).toBe(''); expect(await f.inbox.admit(f.binding, 1, 'secret')).toBe('duplicate'); f.advance(); await f.inbox.recover(new Set()); expect(await f.inbox.records()).toEqual([]);
  });
});

it('atomically refuses a conflicting owner before admitting a body', async () => {
  const f = fixture(); await f.inbox.admit(f.binding, 1, 'first');
  await expect(f.inbox.admit({ ...f.binding, subject:'99' }, 2, 'wrong')).rejects.toThrow('owner binding conflict');
  expect(await f.inbox.records()).toHaveLength(1); expect(f.data.get('telegram_subject')).toBe('42');
});
it('retains uncertain records past expiry rather than evicting for capacity', async () => {
  const f = fixture(); await f.inbox.admit(f.binding, 1, 'possible effects'); await f.inbox.claim('7:telegram:1','a','r',2000); await f.inbox.transition('7:telegram:1','a','quarantined'); f.advance(); await f.inbox.recover(new Set());
  expect((await f.inbox.records())[0]?.state).toBe('quarantined'); expect(await f.inbox.admit(f.binding,1,'possible effects')).toBe('duplicate');
});
