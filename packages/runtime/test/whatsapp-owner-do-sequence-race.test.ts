// Regression for the wa_seq read/turn/put race (fixed: each message's update_id is allocated in its admitting step, beside
// its inbox row, so overlapping admissions can never share one).
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { WA_UPDATE_BASE } from '../src/channels/whatsapp-api';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';

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
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const firstSend = deferred();
    const releaseSend = deferred();
    const sent: unknown[] = [];
    const graph = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(String(input)).toBe('https://graph.facebook.com/v26.0/fictional-phone-id/messages');
      sent.push(JSON.parse(String(init?.body)));
      firstSend.resolve();
      await releaseSend.promise;
      return Response.json({ messages: [{ id: 'wamid.out' }] });
    });
    const instance = new OwnerDO(state, {
      ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key',
      WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id',
    });
    const turnHost = instance as unknown as { turn(update: { update_id: number }, channel: string): Promise<void> };
    const turns = vi.spyOn(turnHost, 'turn');
    const post = (id: string) => instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
      method: 'POST', headers: { 'x-waldo-whatsapp-subject': '15550001111' },
      body: JSON.stringify({ messages: [{ from: '15550001111', id, type: 'text', text: { body: '/stop' } }] }),
    }));
    let drained: Promise<void> | undefined;
    try {
      expect((await post('wamid.concurrent.A')).status).toBe(200);
      drained = drainWhatsAppTurns(instance);
      await firstSend.promise;
      // B is admitted while A's turn awaits Graph: its update_id is allocated now, beside its row, never from a stale read.
      expect((await post('wamid.concurrent.B')).status).toBe(200);
      expect(state.storage.kv.get('wamid:wamid.concurrent.A')).toBeDefined();
      expect(state.storage.kv.get('wamid:wamid.concurrent.B')).toBeDefined();
      expect(await state.storage.get('wa_seq')).toBe(2);
      releaseSend.resolve();
      await drained;
      expect(turns).toHaveBeenCalledTimes(2);
      const ids = turns.mock.calls.map(([update]) => update.update_id);
      // Before the fix this yielded [BASE+1, BASE+1].
      expect(ids, 'different wamids must receive distinct update_ids').toEqual([WA_UPDATE_BASE + 1, WA_UPDATE_BASE + 2]);
      expect(sent).toHaveLength(2);
      expect(await state.storage.get('wa_offset')).toBe(WA_UPDATE_BASE + 3);
    } finally {
      releaseSend.resolve();
      await drained?.catch(() => undefined);
      await state.storage.deleteAlarm();
      turns.mockRestore(); graph.mockRestore();
    }
  });
});

const harness = async (name: string, work: (instance: OwnerDO, state: DurableObjectState, turns: ReturnType<typeof vi.spyOn>) => Promise<void>) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const instance = new OwnerDO(state, {
      ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key',
      WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id',
    });
    const turns = vi.spyOn(instance as unknown as { turn(update: { update_id: number }, channel: string): Promise<void> }, 'turn');
    try { await work(instance, state, turns as never); } finally { await state.storage.deleteAlarm(); turns.mockRestore(); }
  });
};
const post = async (instance: OwnerDO, messages: { id: string }[]) => {
  const response = await instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
    method: 'POST', headers: { 'x-waldo-whatsapp-subject': '15550001111' },
    body: JSON.stringify({ messages: messages.map(m => ({ from: '15550001111', id: m.id, type: 'text', text: { body: 'hi' } })) }),
  }));
  await drainWhatsAppTurns(instance);
  return response;
};

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
