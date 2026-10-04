// A WhatsApp message that fails after it is claimed must not vanish: the owner gets a fixed notice, and a payload whose
// turn never started releases its claim. Webhook already acked Meta, so the visible notice is the recovery path.
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { WHATSAPP_FAILURE_NOTICE } from '../src/channels/whatsapp-api';

vi.mock('openai', () => ({ default: class {
  responses = { create: async () => ({ id: 'fixture', output_text: '{}', output: [], usage: { input_tokens: 1, output_tokens: 1 } }) };
} }));

const harness = async (name: string, work: (instance: TelegramOwnerDO, state: DurableObjectState, turn: ReturnType<typeof vi.fn>, sent: string[]) => Promise<void>) => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const sent: string[] = [];
    const graph = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      sent.push(String(init?.body)); return Response.json({ messages: [{ id: 'wamid.out' }] });
    });
    const instance = new TelegramOwnerDO(state, {
      ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key',
      WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id',
    });
    const turn = vi.spyOn(instance as unknown as { turn(): Promise<void> }, 'turn').mockImplementation(async () => undefined);
    try { await work(instance, state, turn as never, sent); } finally { await state.storage.deleteAlarm(); turn.mockRestore(); graph.mockRestore(); }
  });
};
const post = (instance: TelegramOwnerDO, id: string) => instance.fetch(new Request('https://telegram-owner/whatsapp-turn', {
  method: 'POST', headers: { 'x-waldo-whatsapp-subject': '15550001111' },
  body: JSON.stringify({ messages: [{ from: '15550001111', id, type: 'text', text: { body: 'PRIVATE_WA_TEXT' } }] }),
}));

it('a wa_seq write fault before the turn releases the claim, tells the owner, and a redelivery runs', async () => {
  await harness('whatsapp-seq-write-fault', async (instance, state, turn, sent) => {
    const store = state.storage as unknown as { put(key: string, value: unknown): Promise<void> };
    const original = store.put.bind(state.storage);
    let faulted = false;
    // Same fault as Dalda's probe (reported on 1e818330): the first wa_seq write throws before any turn dispatch.
    const put = vi.spyOn(store, 'put').mockImplementation(async (key, value) => {
      if (key === 'wa_seq' && !faulted) { faulted = true; throw new Error('storage fault'); }
      return original(key, value);
    });
    await post(instance, 'wamid.fault.A').catch(() => undefined);
    put.mockRestore();
    expect(turn).not.toHaveBeenCalled();
    expect(state.storage.kv.get('wamid:wamid.fault.A')).toBeUndefined();
    expect(sent.filter(body => body.includes(WHATSAPP_FAILURE_NOTICE))).toHaveLength(1);
    expect(sent.join('')).not.toContain('PRIVATE_WA_TEXT');
    expect((await post(instance, 'wamid.fault.A')).status).toBe(200);
    expect(turn).toHaveBeenCalledTimes(1);
  });
});

it('a turn that throws tells the owner once and the same wamid is still not replayed', async () => {
  await harness('whatsapp-turn-throw-notice', async (instance, state, turn, sent) => {
    turn.mockImplementationOnce(async () => { throw new Error('turn failed'); });
    await post(instance, 'wamid.throw.N').catch(() => undefined);
    expect(sent.filter(body => body.includes(WHATSAPP_FAILURE_NOTICE))).toHaveLength(1);
    expect(state.storage.kv.get('wamid:wamid.throw.N')).toBeDefined();
    await post(instance, 'wamid.throw.N');
    expect(turn).toHaveBeenCalledTimes(1);
  });
});
