import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SPOOL_MAX_ATTEMPTS, SPOOL_MAX_BODY_BYTES, SPOOL_MAX_ENTRIES, telegramSpool, TELEGRAM_SPOOL_PREFIX } from '../src/channels/telegram-spool';
import { armAlarm } from '../src/scheduler/alarm-slot';

let seq = 0;
const freshStub = () => {
  seq += 1;
  return env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`spool-${Date.now()}-${seq}`));
};

const update = (id: number, text = 'hi') =>
  JSON.stringify({ update_id: id, message: { from: { id: 42 }, chat: { id: 42 }, text } });

const withStorage = <T>(stub: DurableObjectStub, work: (storage: DurableObjectStorage) => Promise<T>): Promise<T> =>
  runInDurableObject(stub, (_instance, state) => work(state.storage));

const keys = (stub: DurableObjectStub) =>
  withStorage(stub, async (s) => [...(await s.list({ prefix: TELEGRAM_SPOOL_PREFIX })).keys()].sort());

describe('telegram spool mechanics', () => {
  it('drains oldest-first and deletes each entry only after it processes', async () => {
    const stub = freshStub();
    await withStorage(stub, async (s) => {
      const seen: number[] = [];
      const spool = telegramSpool(s, (u) => { seen.push((u as { update_id: number }).update_id); return Promise.resolve(); });
      await spool.record(1_000_000_002, update(1_000_000_002));
      await spool.record(999_999_999, update(999_999_999));
      await spool.record(1_000_000_001, update(1_000_000_001));
      await spool.drain();
      expect(seen).toEqual([999_999_999, 1_000_000_001, 1_000_000_002]);
      expect(await spool.pending()).toBe(0);
    });
  });

  it('dedupes a redelivered update_id at the write, keeping the first body', async () => {
    const stub = freshStub();
    await withStorage(stub, async (s) => {
      const spool = telegramSpool(s, () => Promise.resolve());
      expect(await spool.record(9, update(9, 'first delivery'))).toBe('spooled');
      expect(await spool.record(9, update(9, 'redelivery'))).toBe('duplicate');
      expect(await s.get<{ body: string; attempts: number }>(`${TELEGRAM_SPOOL_PREFIX}9`)).toEqual({ body: update(9, 'first delivery'), attempts: 0 });
    });
  });

  it('refuses to spool an update_id at or below the processed offset', async () => {
    const stub = freshStub();
    await withStorage(stub, async (s) => {
      await s.put('offset', 100);
      const spool = telegramSpool(s, () => Promise.resolve());
      expect(await spool.record(50, update(50))).toBe('processed');
      expect(await spool.record(99, update(99))).toBe('processed');
      expect(await spool.record(100, update(100))).toBe('spooled');
      expect(await spool.pending()).toBe(1);
    });
  });

  it('stops the drain at the first failure, keeping that entry and everything after it', async () => {
    const stub = freshStub();
    await withStorage(stub, async (s) => {
      const seen: number[] = [];
      const spool = telegramSpool(s, (u) => {
        const id = (u as { update_id: number }).update_id;
        if (id === 1) return Promise.reject(new Error('boom'));
        seen.push(id);
        return Promise.resolve();
      });
      await spool.record(1, update(1));
      await spool.record(2, update(2));
      await spool.record(3, update(3));
      await spool.drain();
      expect(seen).toEqual([]);
      expect([...(await s.list({ prefix: TELEGRAM_SPOOL_PREFIX })).keys()].sort()).toEqual([
        `${TELEGRAM_SPOOL_PREFIX}1`, `${TELEGRAM_SPOOL_PREFIX}2`, `${TELEGRAM_SPOOL_PREFIX}3`,
      ]);
    });
  });

  it('survives isolate eviction between the durable write and the drain', async () => {
    const stub = freshStub();
    await withStorage(stub, async (s) => {
      await telegramSpool(s, () => Promise.resolve()).record(7, update(7));
    });
    await evictDurableObject(stub);
    const seen: number[] = [];
    await withStorage(stub, async (s) => {
      const spool = telegramSpool(s, (u) => { seen.push((u as { update_id: number }).update_id); return Promise.resolve(); });
      expect(await spool.pending()).toBe(1);
      await spool.drain();
    });
    expect(seen).toEqual([7]);
    expect(await keys(stub)).toEqual([]);
  });

  it('ensureWake arms a retry but never pushes out an earlier scheduler alarm', async () => {
    const stub = freshStub();
    await withStorage(stub, async (s) => {
      const spool = telegramSpool(s, () => Promise.resolve());
      await spool.ensureWake();
      const armed = await s.getAlarm();
      expect(armed).not.toBeNull();
      expect(armed!).toBeGreaterThan(Date.now());
      expect(armed!).toBeLessThanOrEqual(Date.now() + 31_000);
      const earlier = Date.now() + 5_000;
      await armAlarm(s, earlier);
      await spool.ensureWake();
      expect(await s.getAlarm()).toBe(earlier);
    });
  });
});

describe('spool bounds and failed-body retention', () => {
  it('rejects new updates at the entry bound without storing them', async () => {
    const stub = freshStub();
    await withStorage(stub, async (s) => {
      const spool = telegramSpool(s, () => Promise.resolve());
      for (let i = 1; i <= SPOOL_MAX_ENTRIES; i++) {
        expect(await spool.record(i, update(i, `update ${i}`))).toBe('spooled');
      }
      expect(await spool.record(SPOOL_MAX_ENTRIES + 1, update(SPOOL_MAX_ENTRIES + 1, 'one too many'))).toBe('full');
      expect(await s.get(`${TELEGRAM_SPOOL_PREFIX}${SPOOL_MAX_ENTRIES + 1}`)).toBeUndefined();
      expect((await s.list({ prefix: TELEGRAM_SPOOL_PREFIX })).size).toBe(SPOOL_MAX_ENTRIES);
    });
  });

  it('rejects an oversize body without storing it, so the payload never lands in storage', async () => {
    const stub = freshStub();
    await withStorage(stub, async (s) => {
      const spool = telegramSpool(s, () => Promise.resolve());
      const oversize = 'x'.repeat(SPOOL_MAX_BODY_BYTES + 1);
      expect(await spool.record(9, oversize)).toBe('too_large');
      expect(await s.get(`${TELEGRAM_SPOOL_PREFIX}9`)).toBeUndefined();
    });
  });

  it('drops a poison update - raw body included - after the attempt bound', async () => {
    const stub = freshStub();
    await withStorage(stub, async (s) => {
      const spool = telegramSpool(s, () => Promise.resolve());
      await spool.record(9, update(9, 'poison body that must not linger'));
      const poison = () => { throw new Error('turn crash'); };
      const poisonSpool = telegramSpool(s, poison);
      for (let i = 0; i < SPOOL_MAX_ATTEMPTS - 1; i++) await poisonSpool.drain();
      const entry = await s.get<{ body: string; attempts: number }>(`${TELEGRAM_SPOOL_PREFIX}9`);
      expect(entry?.attempts).toBe(SPOOL_MAX_ATTEMPTS - 1);
      await poisonSpool.drain();
      expect(await s.get(`${TELEGRAM_SPOOL_PREFIX}9`)).toBeUndefined();
      expect([...(await s.list({ prefix: TELEGRAM_SPOOL_PREFIX })).values()].map((v) => JSON.stringify(v)).join('')).not.toContain('poison body that must not linger');
    });
  });

  it('bounds the ingress endpoint: 503 when the spool is full, acked drop for oversize bodies', async () => {
    const stub = freshStub();
    await withStorage(stub, async (s) => {
      for (let i = 1; i <= SPOOL_MAX_ENTRIES; i++) await s.put(`${TELEGRAM_SPOOL_PREFIX}${i}`, { body: update(i, `update ${i}`), attempts: 0 });
    });
    const full = await stub.fetch('https://telegram-owner/telegram-ingress', { method: 'POST', body: update(SPOOL_MAX_ENTRIES + 1, 'overflow') });
    expect(full.status).toBe(503);
    const oversized = await stub.fetch('https://telegram-owner/telegram-ingress', { method: 'POST', body: JSON.stringify({ update_id: 5000, filler: 'x'.repeat(SPOOL_MAX_BODY_BYTES) }) });
    expect(oversized.status).toBe(200);
    expect(await withStorage(stub, (s) => s.get(`${TELEGRAM_SPOOL_PREFIX}5000`))).toBeUndefined();
  });
});

describe('telegram ingress endpoint', () => {
  // The test pool has no bot token, so every drain fails at runtime setup: entries stay
  // spooled, which makes the durable write directly observable after the ack.
  it('acks only after the update is durably spooled and arms a retry wake', async () => {
    const stub = freshStub();
    const res = await stub.fetch('https://telegram-owner/telegram-ingress', { method: 'POST', body: update(1) });
    expect(res.status).toBe(200);
    expect(await keys(stub)).toEqual([`${TELEGRAM_SPOOL_PREFIX}1`]);
    const alarmAt = await withStorage(stub, (s) => s.getAlarm());
    expect(alarmAt).not.toBeNull();
    expect(alarmAt!).toBeLessThanOrEqual(Date.now() + 31_000);
  });

  it('acks a redelivery without respooling and keeps the original body', async () => {
    const stub = freshStub();
    await stub.fetch('https://telegram-owner/telegram-ingress', { method: 'POST', body: update(9, 'first delivery') });
    const res = await stub.fetch('https://telegram-owner/telegram-ingress', { method: 'POST', body: update(9, 'redelivery') });
    expect(res.status).toBe(200);
    const stored = await withStorage(stub, (s) => s.get<{ body: string; attempts: number }>(`${TELEGRAM_SPOOL_PREFIX}9`));
    expect(stored?.body).toBe(update(9, 'first delivery'));
  });

  it('acks an update_id below the processed offset without spooling', async () => {
    const stub = freshStub();
    await withStorage(stub, (s) => s.put('offset', 100));
    const res = await stub.fetch('https://telegram-owner/telegram-ingress', { method: 'POST', body: update(50) });
    expect(res.status).toBe(200);
    expect(await keys(stub)).toEqual([]);
  });
});
