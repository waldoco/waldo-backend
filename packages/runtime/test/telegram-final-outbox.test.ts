import { describe, expect, it, vi } from 'vitest';
import { TelegramFinalOutbox, FINAL_OUTBOX_KEY, FINAL_OUTBOX_DUE_KEY } from '../src/channels/telegram-final-outbox';
import { TelegramRejection } from '../src/channels/telegram-api';
import { rearmSharedAlarm } from '../src/scheduler/alarm-slot';
const fixture = () => {
  const data = new Map<string, unknown>(); let now = 1000;
  const kv = { get: <T>(key: string): T | undefined => structuredClone(data.get(key)) as T | undefined,
    put: (key: string, value: unknown) => { data.set(key, structuredClone(value)); } } as DurableObjectStorage['kv'];
  const outbox = new TelegramFinalOutbox(kv, () => now);
  const input = { id: 'turn:1', trace: 'tg-1', payload: { chat_id: 7, text: 'final' }, ownerSubject: '7', doName: 'owner-7' };
  const settled = vi.fn(async () => undefined);
  return { kv, outbox, input, settled, advance: () => { now += 31000; }, now: () => now };
};
describe('frozen Telegram final outbox', () => {
  it('expires before quiet deferral and clamps a future hold to expiry for every receipt kind', async () => {
    for (const receipt of [{}, { mailFollowup: { loopId: 'l', due: '2026-10-03T10:00', sourceRef: 'mail:t', timezone: 'UTC', messageId: 'm' } }, { heartbeat: { id: 'h', occurrence: 1, schedulerRunId: 'r', loops: [] } }]) {
      const f = fixture();
      await f.outbox.enqueue({ ...f.input, ...receipt, expiresAt: f.now() + 40_000 });
      f.advance();
      const send = vi.fn(async () => undefined);
      const defer = vi.fn(async () => f.now() + 60_000);
      await f.outbox.drain({ allowed: async () => true, send, defer, settled: f.settled });
      expect(f.outbox.records()[0]?.dueAt).toBe(41_000);
      f.advance();
      await f.outbox.drain({ allowed: async () => true, send, defer, settled: f.settled });
      expect(f.outbox.records()[0]).toMatchObject({ status: 'blocked', reason: 'expired', settled: true, attempts: 0 });
      expect(send).not.toHaveBeenCalled();
      expect(defer).toHaveBeenCalledTimes(1);
    }
  });
  it('persists final before transport and deduplicates exact payload, conflicts different bytes', async () => {
    const f = fixture(); await f.outbox.enqueue(f.input); await f.outbox.enqueue(f.input);
    expect(f.outbox.records()).toHaveLength(1);
    await expect(f.outbox.enqueue({ ...f.input, payload: { chat_id: 7, text: 'changed' } })).rejects.toThrow('identity conflict');
    expect(f.outbox.records()[0]!.payload.text).toBe('final');
  });
  it('fresh sender retries explicit rejection without rerunning response, then validates ACK', async () => {
    const f = fixture(); const respond = vi.fn(async () => f.input);
    await f.outbox.enqueue(await respond()); f.advance();
    const send = vi.fn().mockRejectedValueOnce(new TelegramRejection(429, 'slow', 30)).mockResolvedValue({ message_id: 42, chat: { id: 7 } });
    await f.outbox.drain({ allowed: async () => true, send, settled: f.settled });
    expect(f.outbox.records()[0]!.status).toBe('pending'); f.advance();
    await new TelegramFinalOutbox(f.kv, f.now).drain({ allowed: async () => true, send, settled: f.settled });
    expect(f.outbox.records()[0]).toMatchObject({ status: 'delivered', messageId: 42, attempts: 2 });
    expect(respond).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(2);
  });
  it.each([new Error('network'), { message_id: '42' }, undefined])('does not retry unknown or blocked ACK %s', async value => {
    const f = fixture(); await f.outbox.enqueue(f.input); f.advance();
    const send = vi.fn(async () => { if (value instanceof Error) throw value; return value; });
    await f.outbox.drain({ allowed: async () => true, send, settled: f.settled }); f.advance();
    await f.outbox.drain({ allowed: async () => true, send, settled: f.settled });
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.outbox.records()[0]!.status).toBe(value === undefined ? 'blocked' : 'quarantined');
  });
  it('restart after attempting quarantines rather than resending and settles reminder unconfirmed', async () => {
    const f = fixture(); await f.outbox.enqueue(f.input);
    const rows = f.outbox.records(); rows[0]!.status = 'attempting'; f.kv.put(FINAL_OUTBOX_KEY, rows); f.advance();
    const send = vi.fn(); await f.outbox.drain({ allowed: async () => true, send, settled: f.settled });
    expect(send).not.toHaveBeenCalled(); expect(f.outbox.records()[0]!.reason).toBe('restart_during_send'); expect(f.settled).toHaveBeenCalledTimes(1);
  });
  it('rechecks owner before sending and fails closed', async () => {
    const f = fixture(); await f.outbox.enqueue(f.input); f.advance(); const send = vi.fn();
    await f.outbox.drain({ allowed: async () => false, send, settled: f.settled });
    expect(send).not.toHaveBeenCalled(); expect(f.outbox.records()[0]!.status).toBe('blocked');
  });
  it('empty scheduler cannot delete a pending transport alarm; earliest due wins', async () => {
    const f = fixture(); await f.outbox.enqueue(f.input);
    const storage = { get: async (key: string) => f.kv.get(key), setAlarm: vi.fn(async () => undefined), deleteAlarm: vi.fn(async () => undefined) } as unknown as DurableObjectStorage;
    await rearmSharedAlarm(storage, null, 1000); expect(storage.setAlarm).toHaveBeenLastCalledWith(1250); expect(storage.deleteAlarm).not.toHaveBeenCalled();
    await rearmSharedAlarm(storage, 2000, 1000); expect(storage.setAlarm).toHaveBeenLastCalledWith(1250);
    f.kv.put(FINAL_OUTBOX_DUE_KEY, null); await rearmSharedAlarm(storage, null, 1000); expect(storage.deleteAlarm).toHaveBeenCalledTimes(1);
  });
});
it('ACK-before-lifecycle-persist resumes bookkeeping without another send', async () => {
  const f = fixture(); await f.outbox.enqueue(f.input); f.advance(); const send = vi.fn(async () => ({ message_id: 99, chat: { id: 7 } }));
  await expect(f.outbox.drain({ allowed: async () => true, send, settled: async () => { throw new Error('crash bookkeeping'); } })).rejects.toThrow('crash bookkeeping');
  expect(f.outbox.records()[0]?.status).toBe('delivered');
  await new TelegramFinalOutbox(f.kv, f.now).drain({ allowed: async () => true, send, settled: f.settled });
  expect(send).toHaveBeenCalledTimes(1); expect(f.outbox.records()[0]?.settled).toBe(true);
});
it.each([NaN, -10, '300'])('bounds untrusted retry_after %s', async retry => {
  const f = fixture(); await f.outbox.enqueue(f.input); f.advance();
  await f.outbox.drain({ allowed: async () => true, send: async () => { throw new TelegramRejection(429, 'rate', retry as number); }, settled: f.settled });
  expect(Number.isFinite(f.outbox.records()[0]?.dueAt)).toBe(true);
  expect(f.outbox.records()[0]?.dueAt).toBe(f.now() + 30000);
});
it('matching message id with wrong chat is not delivery proof', async () => {
  const f = fixture(); await f.outbox.enqueue(f.input); f.advance();
  await f.outbox.drain({ allowed: async () => true, send: async () => ({ message_id: 88, chat: { id: 999 } }), settled: f.settled });
  expect(f.outbox.records()[0]?.status).toBe('quarantined');
});
it('expired ambiguous content is scrubbed and only then eligible for capacity recovery', async () => {
  const f = fixture(); await f.outbox.enqueue(f.input);
  const rows = f.outbox.records(); const row = rows[0]!;
  row.status = 'quarantined'; row.settled = true; row.createdAt = -90000000;
  f.kv.put(FINAL_OUTBOX_KEY, Array.from({ length: 256 }, (_, i) => ({ ...row, id: `old-${i}`, payload: { chat_id: 7, text: 'sensitive old final' } })));
  await f.outbox.enqueue({ ...f.input, id: 'fresh' });
  expect(f.outbox.records()).toHaveLength(256);
  expect(f.outbox.records().filter(r => r.status === 'quarantined').every(r => r.payload.text === '')).toBe(true);
});

it('excessive retry_after is quarantined, never shortened below provider wait', async () => {
  const f = fixture(); await f.outbox.enqueue(f.input); f.advance();
  await f.outbox.drain({ allowed: async () => true, send: async () => { throw new TelegramRejection(429, 'rate', 7200); }, settled: f.settled });
  expect(f.outbox.records()[0]?.status).toBe('quarantined');
});
it('idle maintenance scrubs delivered and ambiguous text independently of enqueue', async () => {
  const f = fixture(); await f.outbox.enqueue(f.input);
  const rows = f.outbox.records(); rows[0]!.status = 'delivered'; rows[0]!.settled = true; rows[0]!.createdAt = -90000000;
  f.kv.put(FINAL_OUTBOX_KEY, rows); await f.outbox.maintain();
  expect(f.outbox.records()[0]?.payload.text).toBe(''); expect(f.kv.get(FINAL_OUTBOX_DUE_KEY)).toBeNull();
});
