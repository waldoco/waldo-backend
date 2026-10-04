// Durable WhatsApp admission (#745): the DO records a payload before the webhook acks, and a payload whose run was cut off by
// an eviction gets one notice and is never replayed. Ids only are stored; the notice goes through the WhatsApp api, never Telegram.
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { WHATSAPP_PARTIAL_NOTICE } from '../src/channels/whatsapp-api';

vi.mock('openai', () => ({ default: class {
  responses = { create: async () => ({ id: 'fixture', output_text: '{}', output: [], usage: { input_tokens: 1, output_tokens: 1 } }) };
} }));

const SUBJECT = '15550001111';
const harness = async (name: string, work: (ctx: { instance: TelegramOwnerDO; state: DurableObjectState; turn: ReturnType<typeof vi.fn>; urls: string[]; bodies: string[] }) => Promise<void>) => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const urls: string[] = []; const bodies: string[] = [];
    const net = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      urls.push(String(input)); bodies.push(String(init?.body)); return Response.json({ messages: [{ id: 'wamid.out' }] });
    });
    const instance = new TelegramOwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' });
    const turn = vi.spyOn(instance as unknown as { turn(): Promise<void> }, 'turn').mockImplementation(async () => undefined);
    try { await work({ instance, state, turn: turn as never, urls, bodies }); } finally { await state.storage.deleteAlarm(); turn.mockRestore(); net.mockRestore(); }
  });
};
const admit = (instance: TelegramOwnerDO, ids: string[], subject = SUBJECT) => instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
  method: 'POST', headers: { 'x-waldo-whatsapp-subject': subject },
  body: JSON.stringify({ messages: ids.map(id => ({ from: subject, id, type: 'text', text: { body: 'PRIVATE_WA_TEXT' } })) }),
}));
const settle = (instance: TelegramOwnerDO) => Promise.all([...(instance as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
const pending = (state: DurableObjectState) => [...state.storage.kv.list({ prefix: 'wa_pending:' })];

it('admission writes an ids-only record before any turn runs, acks, and the record ends with the run', async () => {
  await harness('wa-admit-record', async ({ instance, state, turn }) => {
    let release!: () => void;
    turn.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const response = await admit(instance, ['wamid.admit.A']);
    expect(response.status).toBe(200);
    const rows = pending(state);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE_WA_TEXT');
    expect((rows[0]![1] as { ids: string[] }).ids).toEqual(['wamid.admit.A']);
    expect(state.storage.kv.get('wamid:wamid.admit.A')).toBeDefined();
    await vi.waitFor(() => expect(turn).toHaveBeenCalledTimes(1));
    release(); await settle(instance);
    expect(pending(state)).toHaveLength(0);
  });
});

it('a redelivery of an admitted wamid is acked and never runs a second turn', async () => {
  await harness('wa-admit-duplicate', async ({ instance, state, turn }) => {
    expect((await admit(instance, ['wamid.dup.A'])).status).toBe(200); await settle(instance);
    expect((await admit(instance, ['wamid.dup.A'])).status).toBe(200); await settle(instance);
    expect(turn).toHaveBeenCalledTimes(1);
    expect(pending(state)).toHaveLength(0);
  });
});

it('a different subject is refused and stores nothing', async () => {
  await harness('wa-admit-subject', async ({ instance, state, turn }) => {
    expect((await admit(instance, ['wamid.s.A'])).status).toBe(200); await settle(instance);
    expect((await admit(instance, ['wamid.s.B'], '15550009999')).status).toBe(403);
    expect(state.storage.kv.get('wamid:wamid.s.B')).toBeUndefined();
    expect(pending(state)).toHaveLength(0);
    expect(turn).toHaveBeenCalledTimes(1);
    expect(state.storage.kv.get('whatsapp_subject')).toBe(SUBJECT);
  });
});

it('a payload cut off by an eviction gets exactly one WhatsApp notice, is not replayed, and never touches the Telegram sender or final outbox', async () => {
  await harness('wa-admit-eviction', async ({ instance, state, turn, urls, bodies }) => {
    state.storage.kv.put('whatsapp_subject', SUBJECT);
    // What a previous instance left behind: the wamid claim and the pending record, with no run in this instance.
    state.storage.kv.put('wamid:wamid.evicted.A', Date.now());
    state.storage.kv.put('wa_pending:evicted', { subject: SUBJECT, admittedAt: Date.now(), ids: ['wamid.evicted.A'] });
    await instance.alarm();
    expect(bodies.filter(body => body.includes(WHATSAPP_PARTIAL_NOTICE))).toHaveLength(1);
    expect(urls.every(url => url.startsWith('https://graph.facebook.com/'))).toBe(true);
    expect(bodies.join('')).not.toContain('PRIVATE_WA_TEXT');
    expect(pending(state)).toHaveLength(0);
    expect(state.storage.kv.get<unknown[]>('telegram_final_outbox_v1') ?? []).toEqual([]);
    await instance.alarm();
    expect(bodies.filter(body => body.includes(WHATSAPP_PARTIAL_NOTICE))).toHaveLength(1);
    expect(turn).not.toHaveBeenCalled();
    expect((await admit(instance, ['wamid.evicted.A'])).status).toBe(200); await settle(instance);
    expect(turn).not.toHaveBeenCalled();
  });
});

it('a run still alive in this instance is not mistaken for an evicted one by the alarm', async () => {
  await harness('wa-admit-live', async ({ instance, state, turn, bodies }) => {
    let release!: () => void;
    turn.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    await admit(instance, ['wamid.live.A']);
    await vi.waitFor(() => expect(turn).toHaveBeenCalledTimes(1));
    // The alarm's own work queues behind the running turn; recovery must already have run and left the live record alone.
    const alarm = instance.alarm();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(bodies.filter(body => body.includes(WHATSAPP_PARTIAL_NOTICE))).toHaveLength(0);
    expect(pending(state)).toHaveLength(1);
    release(); await settle(instance); await alarm;
    expect(bodies.filter(body => body.includes(WHATSAPP_PARTIAL_NOTICE))).toHaveLength(0);
  });
});

it('a turn that throws is still acked at admission, tells the owner once, and the alarm does not tell them again', async () => {
  await harness('wa-admit-throw', async ({ instance, state, turn, bodies }) => {
    turn.mockImplementationOnce(async () => { throw new Error('turn failed'); });
    expect((await admit(instance, ['wamid.throw.A'])).status).toBe(200); await settle(instance);
    expect(bodies.filter(body => body.includes(WHATSAPP_PARTIAL_NOTICE))).toHaveLength(1);
    await instance.alarm();
    expect(bodies.filter(body => body.includes(WHATSAPP_PARTIAL_NOTICE))).toHaveLength(1);
    expect(pending(state)).toHaveLength(0);
  });
});
