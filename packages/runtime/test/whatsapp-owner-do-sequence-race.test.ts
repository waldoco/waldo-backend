// Regression for the wa_seq read/turn/put race (fixed: allocation + turns + persist are one serial unit).
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { WA_UPDATE_BASE } from '../src/channels/whatsapp-api';

vi.mock('openai', () => ({ default: class {
  responses = { create: async () => ({ id: 'fixture', output_text: '{}', output: [], usage: { input_tokens: 1, output_tokens: 1 } }) };
} }));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

it('allocates distinct update_ids for overlapping different wamids (known wa_seq race)', async () => {
  const name = 'whatsapp-owner-do-sequence-race';
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const firstSend = deferred();
    const releaseSend = deferred();
    const secondQueued = deferred();
    const sent: unknown[] = [];
    const graph = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(String(input)).toBe('https://graph.facebook.com/v21.0/fictional-phone-id/messages');
      sent.push(JSON.parse(String(init?.body)));
      firstSend.resolve();
      await releaseSend.promise;
      return Response.json({ messages: [{ id: 'wamid.out' }] });
    });
    const instance = new TelegramOwnerDO(state, {
      ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key',
      WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id',
    });
    const turnHost = instance as unknown as { turn(update: { update_id: number }, channel: string): Promise<void> };
    const turns = vi.spyOn(turnHost, 'turn');
    // Observe the real serial queue, without replacing its behavior. The second allocation has
    // already happened when its turn is queued, while the first request still awaits Graph.
    const serialHost = instance as unknown as { serial(work: () => Promise<void>): Promise<void> };
    const serial = serialHost.serial.bind(instance);
    const queue = vi.spyOn(serialHost, 'serial').mockImplementation(work => {
      const result = serial(work);
      if (state.storage.kv.get('wamid:wamid.concurrent.B') !== undefined) secondQueued.resolve();
      return result;
    });
    const post = (id: string) => instance.fetch(new Request('https://telegram-owner/whatsapp-turn', {
      method: 'POST', headers: { 'x-waldo-whatsapp-subject': '15550001111' },
      body: JSON.stringify({ messages: [{ from: '15550001111', id, type: 'text', text: { body: '/stop' } }] }),
    }));
    const pending: Promise<Response>[] = [];
    try {
      pending.push(post('wamid.concurrent.A'));
      await firstSend.promise;
      pending.push(post('wamid.concurrent.B'));
      await secondQueued.promise;
      expect(state.storage.kv.get('wamid:wamid.concurrent.A')).toBeDefined();
      expect(state.storage.kv.get('wamid:wamid.concurrent.B')).toBeDefined();
      expect(await state.storage.get('wa_seq')).toBe(1); // A's allocation is persisted before its turn; B is still queued
      releaseSend.resolve();
      const replies = await Promise.all(pending);
      expect(replies.map(reply => reply.status)).toEqual([200, 200]);
      expect(turns).toHaveBeenCalledTimes(2);
      const ids = turns.mock.calls.map(([update]) => update.update_id);
      // Before the fix this yielded [BASE+1, BASE+1].
      expect(ids, 'different wamids must receive distinct update_ids').toEqual([WA_UPDATE_BASE + 1, WA_UPDATE_BASE + 2]);
      expect(sent).toHaveLength(2);
      expect(await state.storage.get('wa_seq')).toBe(2);
      expect(await state.storage.get('wa_offset')).toBe(WA_UPDATE_BASE + 3);
    } finally {
      releaseSend.resolve();
      await Promise.allSettled(pending);
      await state.storage.deleteAlarm();
      turns.mockRestore(); queue.mockRestore(); graph.mockRestore();
    }
  });
});

const harness = async (name: string, work: (instance: TelegramOwnerDO, state: DurableObjectState, turns: ReturnType<typeof vi.spyOn>) => Promise<void>) => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const instance = new TelegramOwnerDO(state, {
      ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key',
      WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id',
    });
    const turns = vi.spyOn(instance as unknown as { turn(update: { update_id: number }, channel: string): Promise<void> }, 'turn');
    try { await work(instance, state, turns as never); } finally { await state.storage.deleteAlarm(); turns.mockRestore(); }
  });
};
const post = (instance: TelegramOwnerDO, messages: { id: string }[]) => instance.fetch(new Request('https://telegram-owner/whatsapp-turn', {
  method: 'POST', headers: { 'x-waldo-whatsapp-subject': '15550001111' },
  body: JSON.stringify({ messages: messages.map(m => ({ from: '15550001111', id: m.id, type: 'text', text: { body: 'hi' } })) }),
}));

it('a turn that throws does not let the next message reuse its update_id', async () => {
  await harness('whatsapp-seq-after-throw', async (instance, state, turns) => {
    (turns as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { throw new Error('turn failed'); }).mockImplementation(async () => undefined);
    await post(instance, [{ id: 'wamid.throw.A' }]).catch(() => undefined);
    expect(await state.storage.get('wa_seq')).toBe(1);
    expect((await post(instance, [{ id: 'wamid.throw.B' }])).status).toBe(200);
    const ids = (turns as unknown as { mock: { calls: [{ update_id: number }][] } }).mock.calls.map(([update]) => update.update_id);
    expect(ids).toEqual([WA_UPDATE_BASE + 1, WA_UPDATE_BASE + 2]);
    expect(await state.storage.get('wa_seq')).toBe(2);
  });
});

it('when one message in a payload throws, the later claimed messages still get their turns', async () => {
  await harness('whatsapp-multi-after-throw', async (instance, state, turns) => {
    (turns as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { throw new Error('turn failed'); }).mockImplementation(async () => undefined);
    await post(instance, [{ id: 'wamid.m.A' }, { id: 'wamid.m.B' }]).catch(() => undefined);
    const ids = (turns as unknown as { mock: { calls: [{ update_id: number }][] } }).mock.calls.map(([update]) => update.update_id);
    expect(ids).toEqual([WA_UPDATE_BASE + 1, WA_UPDATE_BASE + 2]);
    expect(await state.storage.get('wa_seq')).toBe(2);
  });
});
