// Durable WhatsApp admission (#745): the DO writes one inbox row per message before the webhook acks, and a turn cut off by an
// eviction gets one notice and is never replayed. A row's text is cleared when it closes; the notice goes through the WhatsApp
// api, never Telegram.
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { WHATSAPP_PARTIAL_NOTICE } from '../src/channels/whatsapp-api';
import { WhatsAppOwnerInbox } from '../src/channels/whatsapp-inbox';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';

vi.mock('openai', () => ({ default: class {
  responses = { create: async () => ({ id: 'fixture', output_text: '{}', output: [], usage: { input_tokens: 1, output_tokens: 1 } }) };
} }));

const SUBJECT = '15550001111';
const harness = async (name: string, work: (ctx: { instance: OwnerDO; state: DurableObjectState; turn: ReturnType<typeof vi.fn>; urls: string[]; bodies: string[] }) => Promise<void>) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const urls: string[] = []; const bodies: string[] = [];
    const net = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      urls.push(String(input)); bodies.push(String(init?.body)); return Response.json({ messages: [{ id: 'wamid.out' }] });
    });
    const instance = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' });
    const turn = vi.spyOn(instance as unknown as { turn(): Promise<void> }, 'turn').mockImplementation(async () => undefined);
    try { await work({ instance, state, turn: turn as never, urls, bodies }); } finally { await state.storage.deleteAlarm(); turn.mockRestore(); net.mockRestore(); }
  });
};
const admit = (instance: OwnerDO, ids: string[], subject = SUBJECT) => instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
  method: 'POST', headers: { 'x-waldo-whatsapp-subject': subject },
  body: JSON.stringify({ messages: ids.map(id => ({ from: subject, id, type: 'text', text: { body: 'PRIVATE_WA_TEXT' } })) }),
}));
const settle = drainWhatsAppTurns;
// Records from before the inbox, which only the one-release legacy recovery reads.
const pending = (state: DurableObjectState) => [...state.storage.kv.list({ prefix: 'wa_pending:' })];
const rows = (state: DurableObjectState) => new WhatsAppOwnerInbox(state.storage).records();
const open = (state: DurableObjectState) => rows(state).filter(row => row.state === 'admitted' || row.state === 'running');

it('admission writes the message\'s row before any turn runs and acks; the row\'s text is gone once its turn ends', async () => {
  await harness('wa-admit-record', async ({ instance, state, turn }) => {
    let release!: () => void;
    turn.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const response = await admit(instance, ['wamid.admit.A']);
    expect(response.status).toBe(200);
    expect(turn).not.toHaveBeenCalled();
    expect(rows(state).map(row => [row.wamid, row.state])).toEqual([['wamid.admit.A', 'admitted']]);
    expect(JSON.stringify(rows(state)[0]!.update)).toContain('PRIVATE_WA_TEXT');
    expect(state.storage.kv.get('wamid:wamid.admit.A')).toBeDefined();
    const drained = settle(instance);
    await vi.waitFor(() => expect(turn).toHaveBeenCalledTimes(1));
    release(); await drained;
    expect(rows(state).map(row => [row.state, row.update])).toEqual([['completed', null]]);
    expect(JSON.stringify(rows(state))).not.toContain('PRIVATE_WA_TEXT');
  });
});

it('a redelivery of an admitted wamid is acked and never runs a second turn', async () => {
  await harness('wa-admit-duplicate', async ({ instance, state, turn }) => {
    expect((await admit(instance, ['wamid.dup.A'])).status).toBe(200); await settle(instance);
    expect((await admit(instance, ['wamid.dup.A'])).status).toBe(200); await settle(instance);
    expect(turn).toHaveBeenCalledTimes(1);
    expect(rows(state)).toHaveLength(1);
  });
});

it('a different subject is refused and stores nothing', async () => {
  await harness('wa-admit-subject', async ({ instance, state, turn }) => {
    expect((await admit(instance, ['wamid.s.A'])).status).toBe(200); await settle(instance);
    expect((await admit(instance, ['wamid.s.B'], '15550009999')).status).toBe(403);
    expect(state.storage.kv.get('wamid:wamid.s.B')).toBeUndefined();
    expect(rows(state).map(row => row.wamid)).toEqual(['wamid.s.A']);
    expect(turn).toHaveBeenCalledTimes(1);
    expect(state.storage.kv.get('whatsapp_subject')).toBe(SUBJECT);
  });
});

it('a payload record left by the code before the inbox gets exactly one WhatsApp notice, is not replayed, and never touches the Telegram sender or final outbox', async () => {
  await harness('wa-admit-eviction', async ({ instance, state, turn, urls, bodies }) => {
    state.storage.kv.put('whatsapp_subject', SUBJECT);
    // What a deploy left behind from before the inbox: the wamid claim and the per-payload record, with no run anywhere.
    state.storage.kv.put('wamid:wamid.evicted.A', Date.now());
    state.storage.kv.put('wa_pending:evicted', { subject: SUBJECT, admittedAt: Date.now(), ids: ['wamid.evicted.A'] });
    // Admission records the owner's inbound time in the same step, which keeps the 24-hour window open for this notice.
    state.storage.kv.put('wa_last_inbound_ms', Date.now());
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
    const drained = settle(instance);
    await vi.waitFor(() => expect(turn).toHaveBeenCalledTimes(1));
    // The alarm's own drain queues behind the running turn and recovers only rows whose attempt is live nowhere.
    const alarm = instance.alarm();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(bodies.filter(body => body.includes(WHATSAPP_PARTIAL_NOTICE))).toHaveLength(0);
    expect(rows(state).map(row => row.state)).toEqual(['running']);
    release(); await drained; await alarm;
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
    expect(open(state)).toEqual([]);
  });
});

it('admission keeps the origin and timezone the webhook forwards, as the other owner paths do', async () => {
  await harness('wa-admit-origin-tz', async ({ instance, state }) => {
    const response = await instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
      method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT, 'x-waldo-origin': 'https://w.test', 'x-waldo-timezone': 'Asia/Kolkata' },
      body: JSON.stringify({ messages: [{ from: SUBJECT, id: 'wamid.tz.A', type: 'text', text: { body: 'hi' } }] }),
    }));
    expect(response.status).toBe(200); await settle(instance);
    expect(state.storage.kv.get('origin')).toBe('https://w.test');
    expect(state.storage.kv.get('timezone')).toBe('Asia/Kolkata');
  });
  await harness('wa-admit-origin-tz-refused', async ({ instance, state }) => {
    await admit(instance, ['wamid.tz.B']); await settle(instance);
    await instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
      method: 'POST', headers: { 'x-waldo-whatsapp-subject': '15550009999', 'x-waldo-origin': 'https://evil.test', 'x-waldo-timezone': 'UTC' },
      body: JSON.stringify({ messages: [] }),
    }));
    expect(state.storage.kv.get('origin')).not.toBe('https://evil.test');
    expect(state.storage.kv.get('timezone')).not.toBe('UTC');
  });
});

it('the failed turn closes before its notice goes: an instance recovering during the send sends nothing more', async () => {
  await harness('wa-admit-notice-once', async ({ instance, state, turn, bodies }) => {
    turn.mockImplementationOnce(async () => { throw new Error('turn failed'); });
    let colder = 0;
    const net = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      bodies.push(String(init?.body));
      // A cold instance runs its own drain while the first notice is in flight: no live attempts, only what storage holds.
      if (colder++ === 0) await settle(new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' }));
      return Response.json({ messages: [{ id: 'wamid.out' }] });
    });
    expect((await admit(instance, ['wamid.once.A'])).status).toBe(200); await settle(instance);
    net.mockRestore();
    expect(bodies.filter(body => body.includes(WHATSAPP_PARTIAL_NOTICE))).toHaveLength(1);
    expect(rows(state).map(row => row.state)).toEqual(['interrupted']);
  });
});

it('reviewer validation: transaction throw rolls back both claims and the inbox rows', async () => {
  await harness('review-wa-rollback', async ({ instance, state, turn }) => {
    const original = state.storage.transactionSync.bind(state.storage);
    const spy = vi.spyOn(state.storage, 'transactionSync').mockImplementation((callback: () => unknown) => original(() => {
      callback(); throw new Error('review injected abort');
    }) as never);
    try { await expect(admit(instance, ['wamid.review.rollback'])).rejects.toThrow('review injected abort'); }
    finally { spy.mockRestore(); }
    expect(state.storage.kv.get('wamid:wamid.review.rollback')).toBeUndefined();
    expect(rows(state)).toEqual([]);
    expect(turn).not.toHaveBeenCalled();
  });
});

it('reviewer repro: a cold instance restarting while the failure notice is in flight sends no second notice', async () => {
  await harness('review-wa-failure-notice-restart', async ({ instance, state, turn, bodies }) => {
    turn.mockImplementationOnce(async () => { throw new Error('turn failure'); });
    let release!: (r: Response) => void;
    const send = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    await admit(instance, ['wamid.review.notice']);
    const drained = settle(instance);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(rows(state).map(row => row.state)).toEqual(['interrupted']);
    const restarted = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' });
    await restarted.alarm();
    expect(send).toHaveBeenCalledTimes(1);
    release(Response.json({ messages: [{ id: 'wamid.out' }] })); await drained;
  });
});

