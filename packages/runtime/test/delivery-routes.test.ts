import { describe, expect, it } from 'vitest';
import { addressedTo, admittedRoute, appFirstExecutors, appRecordSend, routedDelivery, withPlainCopy, type Admission, type OutboxRoute } from '../src/channels/delivery-routes';
import { FinalNotSent, type FinalRecord } from '../src/channels/telegram-final-outbox';

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
    const seen: string[] = [], refused: string[] = [], { asked, admission } = asking('admitted');
    const admitted = admittedRoute(route(9, seen), admission, () => 1234, kind => refused.push(kind));
    expect(await admitted.defer(record(9))).toBeNull();
    expect(await admitted.allowed(record(9))).toBe(true);
    expect(await admitted.allowed(record(9))).toBe(true);
    expect(seen).toEqual(['defer 9', 'allowed 9', 'allowed 9']);
    expect(asked.count).toBe(1);
    expect(refused).toEqual([]);
  });

  it('holds a record until the retry time through an outage, and never allows it meanwhile', async () => {
    const seen: string[] = [], refused: string[] = [], { admission } = asking('retry');
    const admitted = admittedRoute(route(9, seen), admission, () => 1234, kind => refused.push(kind));
    expect(await admitted.defer(record(9))).toBe(1234);
    expect(await admitted.allowed(record(9))).toBe(false);
    expect(seen).toEqual([]);
    expect(refused).toEqual(['retry']);
  });

  it('blocks a record once the owner is no longer admitted, with no retry', async () => {
    const seen: string[] = [], refused: string[] = [], { admission } = asking('dormant');
    const admitted = admittedRoute(route(9, seen), admission, () => 1234, kind => refused.push(kind));
    expect(await admitted.defer(record(9))).toBeNull();
    expect(await admitted.allowed(record(9))).toBe(false);
    expect(seen).toEqual(['defer 9']);
    expect(refused).toEqual(['dormant']);
  });
});

describe('a delivery with a plain copy', () => {
  const run = async (delivery: 'ok' | 'fails', copy: 'ok' | 'refused' | 'fails') => {
    const steps: string[] = [];
    const deliver = async (text: string) => { steps.push(`deliver ${text}`); if (delivery === 'fails') throw new Error('not taken'); };
    const send = async (text: string) => { steps.push(`copy ${text}`); if (copy === 'fails') throw new Error('provider error 500'); return copy === 'ok' ? { message_id: 1 } : undefined; };
    const outcome = await withPlainCopy(deliver, send, code => steps.push(`report ${code}`))('hello').then(() => 'resolved', () => 'rejected');
    return { outcome, steps };
  };

  it('copies after the delivery, once, and reports nothing when both succeed', async () => {
    expect(await run('ok', 'ok')).toEqual({ outcome: 'resolved', steps: ['deliver hello', 'copy hello'] });
  });

  it('sends no copy when the delivery fails, and fails as the delivery did', async () => {
    expect(await run('fails', 'ok')).toEqual({ outcome: 'rejected', steps: ['deliver hello'] });
  });

  it.each([['refused', 'copy_blocked'], ['fails', 'copy_failed']] as const)('reports a %s copy by its code only, and the delivery still succeeds', async (copy, code) => {
    expect(await run('ok', copy)).toEqual({ outcome: 'resolved', steps: ['deliver hello', 'copy hello', `report ${code}`] });
  });
});

describe('the send for a record addressed to the app', () => {
  const unwritten = (error: unknown) => error instanceof RangeError;
  it('never sends while no app delivery is set', async () => {
    const send = async () => { throw new Error('must not be called'); };
    await expect(appRecordSend(send, () => null, unwritten)({ chat_id: 9, text: 'hi' })).rejects.toBeInstanceOf(FinalNotSent);
  });

  it('marks a failure the caller knows came before any write as not sent, and leaves every other failure as it was', async () => {
    const refused = new RangeError('refused before writing'), fault = new Error('storage fault');
    const failing = (error: Error) => appRecordSend(async () => { throw error; }, () => true, unwritten)({ chat_id: 9, text: 'hi' });
    await expect(failing(refused)).rejects.toMatchObject({ constructor: FinalNotSent, cause: refused });
    await expect(failing(fault)).rejects.toBe(fault);
    expect(await appRecordSend(async () => ({ message_id: 1 }), () => true, unwritten)({ chat_id: 9, text: 'hi' })).toEqual({ message_id: 1 });
  });
});

describe('who a record is addressed to', () => {
  it('needs both the chat and the owner subject to be the owner\'s', () => {
    const addressed = addressedTo(9);
    expect(addressed({ payload: { chat_id: 9, text: '' }, ownerSubject: '9' } as FinalRecord)).toBe(true);
    expect(addressed({ payload: { chat_id: 9, text: '' }, ownerSubject: '8' } as FinalRecord)).toBe(false);
    expect(addressed({ payload: { chat_id: 8, text: '' }, ownerSubject: '9' } as FinalRecord)).toBe(false);
  });
});

describe('the jobs of an owner on both surfaces', () => {
  it('run every job that messages the owner on the app, and keep nightly, which sends nothing', () => {
    const own = { reminder: 'tg-fire', heartbeat: 'tg-beat', dreaming: 'tg-nightly', pre_activity_spot: 'tg-briefs', brief: 'tg-cards', standing_order: 'tg-order' };
    const app = { fire: 'app-fire', beat: 'app-beat', briefs: 'app-briefs', cards: 'app-cards', fireOrder: 'app-order' };
    expect(appFirstExecutors(own, app)).toEqual({ reminder: 'app-fire', heartbeat: 'app-beat', dreaming: 'tg-nightly', pre_activity_spot: 'app-briefs', brief: 'app-cards', standing_order: 'app-order' });
  });
});
