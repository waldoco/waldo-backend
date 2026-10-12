import { describe, expect, it } from 'vitest';
import { admittedRoute, routedDelivery, type Admission, type OutboxRoute } from '../src/channels/delivery-routes';
import type { FinalRecord } from '../src/channels/telegram-final-outbox';

const record = (chat: number) => ({ id: `r${chat}`, payload: { chat_id: chat, text: 'hi' } }) as unknown as FinalRecord;
const route = (chat: number, seen: string[]): OutboxRoute => ({
  addressed: r => r.payload.chat_id === chat,
  allowed: async () => { seen.push(`allowed ${chat}`); return true; },
  defer: async () => { seen.push(`defer ${chat}`); return null; },
  send: async payload => { seen.push(`send ${chat} ${payload.text}`); return { ok: true }; },
});

describe('routed delivery', () => {
  it('checks, holds and sends each record on the surface it is addressed to', async () => {
    const seen: string[] = [];
    const delivery = routedDelivery([route(7, seen), route(9, seen)]);
    expect(await delivery.defer(record(9))).toBeNull();
    expect(await delivery.allowed(record(9))).toBe(true);
    await delivery.send({ chat_id: 9, text: 'part' }, record(9));
    await delivery.send({ chat_id: 7, text: 'other' }, record(7));
    expect(seen).toEqual(['defer 9', 'allowed 9', 'send 9 part', 'send 7 other']);
  });

  it('never allows or sends a record that no surface claims', async () => {
    const seen: string[] = [];
    const delivery = routedDelivery([route(7, seen)]);
    expect(await delivery.allowed(record(8))).toBe(false);
    expect(await delivery.defer(record(8))).toBeNull();
    await expect(delivery.send({ chat_id: 8, text: 'hi' }, record(8))).rejects.toThrow('no delivery route');
    expect(seen).toEqual([]);
  });
});

describe('a route that needs the owner admitted', () => {
  const asking = (answer: Admission) => { const asked = { count: 0 }; return { asked, admission: async () => { asked.count += 1; return answer; } }; };

  it('uses the route\'s own checks while the owner is admitted, and asks once', async () => {
    const seen: string[] = [], { asked, admission } = asking('admitted');
    const admitted = admittedRoute(route(9, seen), admission, () => 1234);
    expect(await admitted.defer(record(9))).toBeNull();
    expect(await admitted.allowed(record(9))).toBe(true);
    expect(await admitted.allowed(record(9))).toBe(true);
    expect(seen).toEqual(['defer 9', 'allowed 9', 'allowed 9']);
    expect(asked.count).toBe(1);
  });

  it('holds a record until the retry time through an outage, and never allows it meanwhile', async () => {
    const seen: string[] = [], { admission } = asking('retry');
    const admitted = admittedRoute(route(9, seen), admission, () => 1234);
    expect(await admitted.defer(record(9))).toBe(1234);
    expect(await admitted.allowed(record(9))).toBe(false);
    expect(seen).toEqual([]);
  });

  it('blocks a record once the owner is no longer admitted, with no retry', async () => {
    const seen: string[] = [], { admission } = asking('dormant');
    const admitted = admittedRoute(route(9, seen), admission, () => 1234);
    expect(await admitted.defer(record(9))).toBeNull();
    expect(await admitted.allowed(record(9))).toBe(false);
    expect(seen).toEqual(['defer 9']);
  });
});
