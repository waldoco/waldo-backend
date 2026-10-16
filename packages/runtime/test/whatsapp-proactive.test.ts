// Proactive WhatsApp sends below the owner DO: the shim splits long text, the window caller holds only what did not go out,
// the outbox route accepts only an honest WhatsApp receipt, and Meta's later 131047 closes the window and re-holds the text.
import { describe, expect, it, vi } from 'vitest';
import type { OutboxRoute } from '../src/channels/delivery-routes';
import { TelegramFinalOutbox } from '../src/channels/telegram-final-outbox';
import { WHATSAPP_TEXT_MAX_CHARS, WhatsAppPartialSend, whatsappTelegramShim } from '../src/channels/whatsapp-api';
import { WHATSAPP_HELD, WA_HELD_PREFIX, deliverHeldWhatsApp, recordWhatsAppInbound, releaseWhatsAppOutbox, whatsappReceipt, whatsappWindowCaller, whatsappWindowOpen, whatsappWindowRefused, whatsappWindowRoute } from '../src/channels/whatsapp-window';

const SUBJECT = '15550001111';
const T0 = 1_700_000_000_000;
const template = { name: 'waldo_update_ready', language: 'en' };
const fakeKv = () => {
  const map = new Map<string, unknown>();
  // Durable Object storage hands back copies, never the stored object itself.
  return { map, kv: { get: <T>(k: string) => structuredClone(map.get(k)) as T | undefined, put: (k: string, v: unknown) => { map.set(k, structuredClone(v)); }, delete: (k: string) => map.delete(k),
    list: <T>({ prefix }: { prefix: string }) => [...map].filter(([k]) => k.startsWith(prefix)) as [string, T][] } };
};
const ack = (id: string) => ({ messaging_product: 'whatsapp', contacts: [{ input: SUBJECT, wa_id: SUBJECT }], messages: [{ id }] });
const bodiesOf = (graph: ReturnType<typeof vi.fn>) => graph.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
const held = (map: Map<string, unknown>) => [...map].filter(([key]) => key.startsWith(WA_HELD_PREFIX)).map(([, value]) => (value as { body: { text: string } }).body.text);

describe('the WhatsApp shim splits text over 4,096 characters', () => {
  it('sends each part in order and answers the last part\'s receipt', async () => {
    let n = 0;
    const graph = vi.fn(async () => Response.json(ack(`wamid.${++n}`)));
    const shim = whatsappTelegramShim('tok', 'pn1', SUBJECT, graph as unknown as typeof fetch);
    const text = `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`;
    expect(await shim('sendMessage', { chat_id: 1, text })).toEqual(ack('wamid.2'));
    const bodies = bodiesOf(graph).map(body => body.text.body as string);
    expect(bodies).toEqual(['a'.repeat(3000), 'b'.repeat(3000)]);
    expect(bodies.every(body => body.length <= WHATSAPP_TEXT_MAX_CHARS)).toBe(true);
  });

  it('a failure after a part went out reports what was sent and what was not; a first-part failure is the plain error', async () => {
    const graph = vi.fn(async (_url: string, init?: RequestInit) => JSON.parse(String(init?.body)).text.body.startsWith('a')
      ? Response.json(ack('wamid.1')) : Response.json({ error: { code: 131000 } }, { status: 500 }));
    const shim = whatsappTelegramShim('tok', 'pn1', SUBJECT, graph as unknown as typeof fetch);
    const failure = await shim('sendMessage', { chat_id: 1, text: `${'a'.repeat(4090)}\n\n${'b'.repeat(10)}` }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WhatsAppPartialSend);
    expect(failure).toMatchObject({ sent: 1, ack: ack('wamid.1'), remaining: ['b'.repeat(10)], cause: { code: 131000 } });
    await expect(shim('sendMessage', { chat_id: 1, text: 'b' })).rejects.not.toBeInstanceOf(WhatsAppPartialSend);
  });

  it('the window caller holds only the parts the closed window refused, knocks, and answers the part that went out', async () => {
    const { kv, map } = fakeKv();
    recordWhatsAppInbound(kv, [{ timestamp: String(T0 / 1000) }], T0);
    const graph = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.type === 'template') return Response.json(ack('wamid.knock'));
      return body.text.body.startsWith('a') ? Response.json(ack('wamid.1')) : Response.json({ error: { code: 131047 } }, { status: 400 });
    });
    const call = whatsappWindowCaller(whatsappTelegramShim('tok', 'pn1', SUBJECT, graph as unknown as typeof fetch), { kv, template, now: () => T0 + 60_000, log: vi.fn() });
    expect(await call('sendMessage', { chat_id: 1, text: `${'a'.repeat(4090)}\n\n${'b'.repeat(10)}` })).toEqual(ack('wamid.1'));
    expect(held(map)).toEqual(['b'.repeat(10)]);
    expect(bodiesOf(graph).map(body => body.type)).toEqual(['text', 'text', 'template']);
  });

  it('a partial send that failed for another reason holds nothing and propagates', async () => {
    const { kv, map } = fakeKv();
    recordWhatsAppInbound(kv, [{ timestamp: String(T0 / 1000) }], T0);
    const graph = vi.fn(async (_url: string, init?: RequestInit) => JSON.parse(String(init?.body)).text.body.startsWith('a')
      ? Response.json(ack('wamid.1')) : Response.json({ error: { code: 131026 } }, { status: 400 }));
    const call = whatsappWindowCaller(whatsappTelegramShim('tok', 'pn1', SUBJECT, graph as unknown as typeof fetch), { kv, template, now: () => T0 + 60_000, log: vi.fn() });
    await expect(call('sendMessage', { chat_id: 1, text: `${'a'.repeat(4090)}\n\n${'b'.repeat(10)}` })).rejects.toBeInstanceOf(WhatsAppPartialSend);
    expect(held(map)).toEqual([]);
  });
});

describe('the WhatsApp outbox receipt', () => {
  it('is one message id sent to the owner\'s bound subject, and nothing else', () => {
    expect(whatsappReceipt(ack('wamid.ok'), SUBJECT)).toEqual({ providerMessageId: 'wamid.ok' });
    expect(whatsappReceipt(WHATSAPP_HELD, SUBJECT)).toBe('held');
    for (const bad of [undefined, null, {}, { message_id: 5, chat: { id: 1 } }, { ...ack('wamid.x'), contacts: [{ wa_id: '15559999999' }] },
      { ...ack(''), messages: [{ id: '' }] }, { contacts: ack('a').contacts, messages: [{ id: 'a' }, { id: 'b' }] }])
      expect(whatsappReceipt(bad, SUBJECT)).toBeNull();
  });

  it('through the outbox: a WhatsApp receipt delivers with its message id, a Telegram-shaped answer is quarantined, a held one is blocked', async () => {
    for (const [answer, expected] of [
      [ack('wamid.ok'), { status: 'delivered', providerMessageId: 'wamid.ok' }],
      [{ message_id: 3, chat: { id: 15550001111 } }, { status: 'quarantined', reason: 'invalid_ack' }],
      [WHATSAPP_HELD, { status: 'blocked', reason: 'surface_held' }],
    ] as const) {
      const { kv } = fakeKv();
      recordWhatsAppInbound(kv, [{ timestamp: String(Date.now() / 1000) }], Date.now());
      const outbox = new TelegramFinalOutbox(kv as never, () => Date.now() + 1_000);
      await outbox.enqueue({ id: 'heartbeat:1', trace: 't', payload: { chat_id: 15550001111, text: 'Checking in.' }, ownerSubject: SUBJECT, doName: 'do' });
      const route = whatsappWindowRoute({ addressed: () => true, allowed: async () => true, defer: async () => null, send: async () => answer },
        { kv, subject: SUBJECT, template, knock: vi.fn(), log: vi.fn() });
      const settled = vi.fn(async () => undefined);
      await releaseWhatsAppOutbox(outbox, route, settled);
      expect(outbox.records()[0]).toMatchObject(expected);
      expect(settled).toHaveBeenCalledTimes(1);
    }
  });

  it('the reply-time release touches only records addressed to the WhatsApp route', async () => {
    const { kv } = fakeKv();
    recordWhatsAppInbound(kv, [{ timestamp: String(Date.now() / 1000) }], Date.now());
    const outbox = new TelegramFinalOutbox(kv as never, () => Date.now() + 1_000);
    await outbox.enqueue({ id: 'telegram', trace: 't', payload: { chat_id: 7, text: 'For Telegram.' }, ownerSubject: '7', doName: 'do' });
    await outbox.enqueue({ id: 'whatsapp', trace: 't', payload: { chat_id: 15550001111, text: 'For WhatsApp.' }, ownerSubject: SUBJECT, doName: 'do' });
    const route: OutboxRoute = { addressed: r => r.ownerSubject === SUBJECT, allowed: async () => true, defer: async () => null, send: async () => ack('wamid.w') };
    await releaseWhatsAppOutbox(outbox, whatsappWindowRoute(route, { kv, subject: SUBJECT, template, knock: vi.fn(), log: vi.fn() }), async () => undefined);
    expect(outbox.records().map(({ id, status }) => ({ id, status }))).toEqual([{ id: 'telegram', status: 'pending' }, { id: 'whatsapp', status: 'delivered' }]);
  });
});

describe('Meta refusing a send later (a failed status with 131047)', () => {
  it('closes the window until the owner writes, re-holds the text once per message id, and knocks once', async () => {
    const { kv, map } = fakeKv();
    recordWhatsAppInbound(kv, [{ timestamp: String(T0 / 1000) }], T0);
    const knock = vi.fn(async () => ack('wamid.knock'));
    const log = vi.fn();
    expect(whatsappWindowOpen(kv, T0 + 60_000)).toBe(true);
    await whatsappWindowRefused(kv, 'wamid.late', 'Your reminder: call Sam.', 15550001111, knock, template, T0 + 60_000, log);
    await whatsappWindowRefused(kv, 'wamid.late', 'Your reminder: call Sam.', 15550001111, knock, template, T0 + 61_000, log);
    expect(whatsappWindowOpen(kv, T0 + 60_000)).toBe(false);
    expect(held(map)).toEqual(['Your reminder: call Sam.']);
    expect(knock).toHaveBeenCalledTimes(1);
    // A direct reply's text is not kept, so there is nothing to re-hold; the line says so.
    await whatsappWindowRefused(kv, 'wamid.direct', null, 15550001111, knock, template, T0 + 62_000, log);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ hop: 'whatsapp_status', code: 131047, held: false, detail: 'text_unavailable' }));
    // The owner writes again: the window reopens and what was re-held goes out.
    recordWhatsAppInbound(kv, [{ timestamp: String((T0 + 120_000) / 1000) }], T0 + 120_000);
    expect(whatsappWindowOpen(kv, T0 + 120_000)).toBe(true);
    const call = vi.fn(async () => ack('wamid.again'));
    await deliverHeldWhatsApp(kv, call, T0 + 120_000, vi.fn());
    expect(call).toHaveBeenCalledWith('sendMessage', { chat_id: 15550001111, text: 'Your reminder: call Sam.' });
  });
});
