import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { alarmRetryDelay, armAlarm, rearmSharedAlarm } from '../src/scheduler/alarm-slot';
import { HEARTBEAT_EVERY_MS } from '../src/channels/heartbeat';

// Every pass here is fired by workerd's own alarm scheduler at a real owner object. A wake armed or deleted during a pass
// replaces or cancels the platform's retry, so the handler owns its retries: it counts the failure, arms its own backoff
// and returns. The four throw shapes: before any re-arm (a); after the arbiter deleted the alarm (b); after it armed its
// 250 ms floor for a past-due key (c); after it armed a later wake (d).
const { OwnerDO } = await import('../src/channels/owner-do');
type Passes = { alarm(): Promise<void>; alarmWork(): Promise<void>; drainApp(): Promise<void>; drainIMessage(): Promise<void> };
const proto = OwnerDO.prototype as unknown as Passes;
const FAILURES = 'owner_alarm_failures_v1';
const RETRY_DUE = 'owner_alarm_retry_due_v1';
const LINK_DUE = 'telegram_link_due_v1';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const watchPasses = async (name: string, seed: (state: DurableObjectState) => void, observe: (stub: DurableObjectStub, at: number[]) => Promise<void>) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  const inObject = <T>(work: (state: DurableObjectState) => Promise<T> | T) => runInDurableObject(stub, async (_instance, state) => work(state));
  const real = proto.alarm, at: number[] = [], start = Date.now();
  const passes = vi.spyOn(proto, 'alarm').mockImplementation(async function (this: unknown) { at.push(Date.now() - start); return real.call(this); });
  try {
    await inObject(async state => { seed(state); await armAlarm(state.storage, Date.now() + 100); });
    await observe(stub, at);
  } finally {
    // The failing lane stays mocked until no wake is left, so no pass runs the real alarm work on this owner afterwards.
    await inObject(state => state.storage.deleteAlarm());
    await sleep(300);
    await inObject(state => { state.storage.kv.delete(LINK_DUE); return state.storage.deleteAlarm(); });
    const left = await inObject(state => state.storage.getAlarm());
    passes.mockRestore();
    expect(left).toBeNull();
  }
};
const untilPasses = async (at: number[], count: number, withinMs: number) => {
  const deadline = Date.now() + withinMs;
  while (at.length < count && Date.now() < deadline) await sleep(50);
};
const failing = (lane: 'drainApp' | 'drainIMessage') => vi.spyOn(proto, lane).mockRejectedValue(new Error('synthetic lane failure'));

it.each([
  ['a', 'drainApp', () => undefined],
  ['b', 'drainIMessage', () => undefined],
  ['d', 'drainIMessage', (state: DurableObjectState) => state.storage.kv.put(LINK_DUE, Date.now() + 20 * 60_000)],
] as const)('throw shape (%s): the next pass comes after the first backoff step, not the platform\'s or a later wake', async (shape, lane, seed) => {
  const lines = vi.spyOn(console, 'error').mockImplementation(() => undefined), fail = failing(lane);
  try {
    await watchPasses(`alarm-retry-${shape}`, seed, async (stub, at) => {
      await untilPasses(at, 2, 4_000);
      expect(at.length, `passes at ${at.join(', ')} ms`).toBeGreaterThanOrEqual(2);
      const step = alarmRetryDelay(1, stub.id.toString(), HEARTBEAT_EVERY_MS);
      expect(at[1]! - at[0]!, `passes at ${at.join(', ')} ms; first step ${step} ms`).toBeGreaterThanOrEqual(step - 50);
      expect(at[1]! - at[0]!, `passes at ${at.join(', ')} ms; first step ${step} ms`).toBeLessThanOrEqual(step + 1_000);
    });
    const logged = lines.mock.calls.map(call => String(call[0]));
    expect(logged).toContain(JSON.stringify({ hop: 'alarm', ok: false, code: 'retry_scheduled', streak: 1 }));
    expect(logged.join('\n')).not.toContain('synthetic lane failure');
  } finally { fail.mockRestore(); lines.mockRestore(); }
}, 20_000);

it('throw shape (c): a past-due key and a throwing lane back off instead of re-arming every 250 ms', async () => {
  const lines = vi.spyOn(console, 'error').mockImplementation(() => undefined), fail = failing('drainIMessage');
  try {
    await watchPasses('alarm-retry-c', state => state.storage.kv.put(LINK_DUE, Date.now() - 1_000), async (_stub, at) => {
      await sleep(9_000);
      expect(at.length, `passes at ${at.join(', ')} ms`).toBeLessThanOrEqual(3);
    });
  } finally { fail.mockRestore(); lines.mockRestore(); }
}, 20_000);

it('a pass that succeeds after a failure clears the streak, and the next wake is the one the arbiter arms', async () => {
  const later = Date.now() + 20 * 60_000;
  const lines = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  // The first pass throws; the next one ends as a successful pass does, with the arbiter's re-arm.
  const work = vi.spyOn(proto, 'alarmWork').mockRejectedValueOnce(new Error('synthetic lane failure'))
    .mockImplementation(async function (this: unknown) { await rearmSharedAlarm((this as { ctx: DurableObjectState }).ctx.storage, null, Date.now()); });
  try {
    await watchPasses('alarm-retry-reset', state => state.storage.kv.put(LINK_DUE, later), async (stub, at) => {
      await untilPasses(at, 2, 4_000);
      await sleep(200);
      const after = await runInDurableObject(stub, async (_instance, state) => ({ streak: state.storage.kv.get(FAILURES), retryDue: state.storage.kv.get(RETRY_DUE), armed: await state.storage.getAlarm() }));
      expect(at.length, `passes at ${at.join(', ')} ms`).toBe(2);
      expect(after.streak).toBeUndefined();
      expect(after.retryDue).toBeUndefined();
      expect(after.armed).toBe(later);
    });
  } finally { work.mockRestore(); lines.mockRestore(); }
}, 20_000);

// A turn that ends while a retry is pending re-arms through the arbiter, which arms only listed wakes.
it('the retry wake is a listed due key, so an arbiter re-arm outside the handler keeps it', async () => {
  const lines = vi.spyOn(console, 'error').mockImplementation(() => undefined), fail = failing('drainIMessage');
  try {
    await watchPasses('alarm-retry-keyed', () => undefined, async stub => {
      const deadline = Date.now() + 2_000;
      while (await runInDurableObject(stub, (_instance, state) => state.storage.kv.get(FAILURES)) !== 1 && Date.now() < deadline) await sleep(25);
      const kept = await runInDurableObject(stub, async (_instance, state) => {
        await rearmSharedAlarm(state.storage, null, Date.now());
        return { retryDue: state.storage.kv.get<number>(RETRY_DUE), armed: await state.storage.getAlarm() };
      });
      expect(kept.armed, `armed ${kept.armed}, retry key ${kept.retryDue}`).not.toBeNull();
      expect(kept.armed).toBe(kept.retryDue);
    });
  } finally { fail.mockRestore(); lines.mockRestore(); }
}, 20_000);

it('the retry delay starts at 2 s, doubles, adds a fixed share of up to a quarter per owner, and never passes the cap', () => {
  const owners = ['5f2d9c0e7a1b4c3d8e6f0a9b2c4d6e8f1a3b5c7d9e0f2a4b6c8d0e1f3a5b7c9d', 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'];
  for (const owner of owners) for (let streak = 1; streak <= 12; streak++) {
    const floor = 2_000 * 2 ** (streak - 1), delay = alarmRetryDelay(streak, owner, HEARTBEAT_EVERY_MS);
    expect(delay, `streak ${streak}`).toBe(alarmRetryDelay(streak, owner, HEARTBEAT_EVERY_MS));
    expect(Number.isInteger(delay), `streak ${streak}: ${delay}`).toBe(true);
    expect(delay, `streak ${streak}`).toBeLessThanOrEqual(HEARTBEAT_EVERY_MS);
    if (floor < HEARTBEAT_EVERY_MS) {
      expect(delay, `streak ${streak}`).toBeGreaterThanOrEqual(floor);
      expect(delay, `streak ${streak}`).toBeLessThan(floor * 1.25);
    }
  }
  expect(alarmRetryDelay(1, owners[0]!, HEARTBEAT_EVERY_MS)).not.toBe(alarmRetryDelay(1, owners[1]!, HEARTBEAT_EVERY_MS));
  expect(alarmRetryDelay(10_000, owners[0]!, HEARTBEAT_EVERY_MS)).toBe(HEARTBEAT_EVERY_MS);
});
