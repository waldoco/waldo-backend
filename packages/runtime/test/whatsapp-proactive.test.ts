// Proactive WhatsApp sends below the owner DO: the shim splits long text, the window caller holds only what did not go out,
// the outbox route accepts only an honest WhatsApp receipt, and Meta's later 131047 closes the window and re-holds the text.
import { describe, expect, it, vi } from 'vitest';
import { SEND_NOW_ONLY, type OutboxRoute } from '../src/channels/delivery-routes';
import { egressGuardedCaller } from '../src/channels/egress-guard';
import { createTelegramCaller, gatedCaller } from '../src/channels/telegram-api';
import { TelegramFinalOutbox } from '../src/channels/telegram-final-outbox';
import { WHATSAPP_TEXT_MAX_CHARS, WhatsAppPartialSend, whatsappTelegramShim } from '../src/channels/whatsapp-api';
import { WHATSAPP_HELD, WA_HELD_PREFIX, WA_LAST_INBOUND_KEY, deliverHeldWhatsApp, deliverWhatsAppFileInWindow, forgetHeldWhatsApp, clearWhatsAppNumber, recordWhatsAppInbound, releaseWhatsAppOutbox, whatsappReceipt, whatsappWindowCaller, whatsappWindowOpen, whatsappWindowRefused, whatsappWindowRoute } from '../src/channels/whatsapp-window';

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

  it('through the outbox: a WhatsApp receipt delivers with its message id, a Telegram-shaped answer is quarantined, held and gate-blocked ones are blocked and kept', async () => {
    for (const [answer, expected] of [
      [ack('wamid.ok'), { status: 'delivered', providerMessageIds: ['wamid.ok'] }],
      [{ message_id: 3, chat: { id: 15550001111 } }, { status: 'quarantined', reason: 'invalid_ack' }],
      [WHATSAPP_HELD, { status: 'blocked', reason: 'surface_held' }],
      // The owner's egress gate refused the send (e.g. presence_unavailable): never delivered, never removed.
      [undefined, { status: 'blocked', reason: 'egress_blocked' }],
    ] as const) {
      const { kv } = fakeKv();
      recordWhatsAppInbound(kv, [{ timestamp: String(Date.now() / 1000) }], Date.now());
      const outbox = new TelegramFinalOutbox(kv as never, () => Date.now() + 1_000);
      await outbox.enqueue({ id: 'heartbeat:1', trace: 't', payload: { chat_id: 15550001111, text: 'Checking in.' }, ownerSubject: SUBJECT, doName: 'do' });
      const route = whatsappWindowRoute({ addressed: () => true, allowed: async () => true, defer: async () => null, send: async () => answer },
        { kv, subject: SUBJECT, template, knock: vi.fn(), log: vi.fn() });
      const settled = vi.fn(async () => undefined);
      await releaseWhatsAppOutbox(outbox, route, settled);
      expect(outbox.records()).toHaveLength(1);
      expect(outbox.records()[0]).toMatchObject({ ...expected, payload: { text: 'Checking in.' } });
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
  it('closes the window until the owner writes and re-holds the text once per message id; the caller is told to knock once', () => {
    const { kv, map } = fakeKv();
    recordWhatsAppInbound(kv, [{ timestamp: String(T0 / 1000) }], T0);
    const log = vi.fn();
    expect(whatsappWindowOpen(kv, T0 + 60_000)).toBe(true);
    const late = { providerMessageId: 'wamid.late', refusedAt: T0 + 30_000 };
    expect(whatsappWindowRefused(kv, late, 'Your reminder: call Sam.', 15550001111, T0 + 60_000, log)).toBe(true);
    expect(whatsappWindowRefused(kv, late, 'Your reminder: call Sam.', 15550001111, T0 + 61_000, log)).toBe(false);
    expect(whatsappWindowOpen(kv, T0 + 60_000)).toBe(false);
    expect(held(map)).toEqual(['Your reminder: call Sam.']);
    // A direct reply's text is not kept, so there is nothing to re-hold; the line says so.
    whatsappWindowRefused(kv, { providerMessageId: 'wamid.direct', refusedAt: T0 + 31_000 }, null, 15550001111, T0 + 62_000, log);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ hop: 'whatsapp_status', code: 131047, held: false, detail: 'text_unavailable' }));
    // The owner writes again: the window reopens and what was re-held goes out.
    recordWhatsAppInbound(kv, [{ timestamp: String((T0 + 120_000) / 1000) }], T0 + 120_000);
    expect(whatsappWindowOpen(kv, T0 + 120_000)).toBe(true);
    const call = vi.fn(async () => ack('wamid.again'));
    return deliverHeldWhatsApp(kv, call, T0 + 120_000, vi.fn(), '15550001111').then(() => {
      expect(call).toHaveBeenCalledWith('sendMessage', { chat_id: 15550001111, text: 'Your reminder: call Sam.' });
    });
  });

  it('a refusal from before the owner\'s latest message re-holds the text but leaves the window open and asks for no knock', () => {
    const { kv, map } = fakeKv();
    recordWhatsAppInbound(kv, [{ timestamp: String((T0 + 120_000) / 1000) }], T0 + 120_000);
    expect(whatsappWindowRefused(kv, { providerMessageId: 'wamid.old', refusedAt: T0 }, 'Earlier note.', 15550001111, T0 + 130_000, vi.fn())).toBe(false);
    expect(whatsappWindowOpen(kv, T0 + 130_000)).toBe(true);
    expect(held(map)).toEqual(['Earlier note.']);
  });

  it('two overlapping deliveries of held messages send each one exactly once', async () => {
    const { kv } = fakeKv();
    const now = Date.now();
    recordWhatsAppInbound(kv, [{ timestamp: String(Math.floor(now / 1000)) }], now);
    kv.put(`${WA_HELD_PREFIX}000000000001`, { heldAt: now, body: { chat_id: 1, text: 'one' } });
    kv.put(`${WA_HELD_PREFIX}000000000002`, { heldAt: now, body: { chat_id: 1, text: 'two' } });
    const sent: string[] = [], waiting: (() => void)[] = [];
    const call = async (_method: string, body: object) => {
      sent.push((body as { text: string }).text);
      await new Promise<void>(resolve => waiting.push(resolve));
      return ack(`wamid.${sent.length}`);
    };
    const first = deliverHeldWhatsApp(kv, call, now, vi.fn(), '1'), second = deliverHeldWhatsApp(kv, call, now, vi.fn(), '1');
    for (let step = 0; step < 10; step += 1) { waiting.shift()?.(); await new Promise(resolve => setTimeout(resolve, 0)); }
    await Promise.all([first, second]);
    expect(sent).toEqual(['one', 'two']);
  });

  it('text held for another number after the clear (a put-back, or a recovery notice held during an unlink) is dropped, never sent', async () => {
    const { kv, map } = fakeKv();
    const now = Date.now();
    recordWhatsAppInbound(kv, [{ timestamp: String(Math.floor(now / 1000)) }], now);
    kv.put(`${WA_HELD_PREFIX}000000000001`, { heldAt: now, body: { chat_id: 15550001111, text: 'for the old number' } });
    kv.put(`${WA_HELD_PREFIX}000000000002`, { heldAt: now, body: { chat_id: 15550002222, text: 'for the new number' } });
    const call = vi.fn(async () => ack('wamid.new'));
    const log = vi.fn();
    // Unlinked: no number is bound, so nothing goes out and nothing waits.
    const unlinked = fakeKv();
    unlinked.kv.put(WA_LAST_INBOUND_KEY, now);
    unlinked.kv.put(`${WA_HELD_PREFIX}000000000001`, { heldAt: now, body: { chat_id: 15550001111, text: 'recovery notice' } });
    await deliverHeldWhatsApp(unlinked.kv, call, now, log, '');
    expect(call).not.toHaveBeenCalled();
    expect(held(unlinked.map)).toEqual([]);
    // Relinked to another number: only that number's text goes out.
    await deliverHeldWhatsApp(kv, call, now, log, '15550002222');
    expect(call.mock.calls).toEqual([['sendMessage', { chat_id: 15550002222, text: 'for the new number' }]]);
    expect(held(map)).toEqual([]);
    expect(log).toHaveBeenCalledWith({ hop: 'whatsapp_held', ok: false, code: 'other_number', dropped: 1 });
  });
});

describe('the closed window knocks only for a record the outbox would send', () => {
  const closedRoute = (inner: Partial<OutboxRoute>) => {
    const { kv } = fakeKv();
    recordWhatsAppInbound(kv, [{ timestamp: String((Date.now() - 30 * 60 * 60_000) / 1000) }], Date.now() - 30 * 60 * 60_000);
    const knock = vi.fn(async () => ack('wamid.knock'));
    const route = whatsappWindowRoute({ addressed: () => true, allowed: async () => true, defer: async () => null, send: async () => ack('wamid.x'), ...inner },
      { kv, subject: SUBJECT, template, knock, log: vi.fn() });
    return { route, knock };
  };
  const record = () => ({ createdAt: Date.now() }) as never;

  it('a record the route holds (quiet hours, low volume) waits for that hold and does not knock', async () => {
    const until = Date.now() + 10 * 60_000;
    const { route, knock } = closedRoute({ defer: async () => until });
    expect(await route.defer(record())).toBe(until);
    expect(knock).not.toHaveBeenCalled();
  });

  it('a record the route refuses (cancelled, ineligible) is not deferred and does not knock', async () => {
    const { route, knock } = closedRoute({ allowed: async () => false });
    expect(await route.defer(record())).toBeNull();
    expect(await route.allowed(record())).toBe(false);
    expect(knock).not.toHaveBeenCalled();
  });

  it('a record the route would send knocks once and waits out the retention', async () => {
    const { route, knock } = closedRoute({});
    expect(await route.defer(record())).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60_000);
    expect(await route.defer(record())).toBeGreaterThan(Date.now());
    expect(knock).toHaveBeenCalledTimes(1);
  });
});

describe('owner forget reaches held WhatsApp text', () => {
  it('cancels a held message carrying a forgotten literal and keeps the rest', () => {
    const { kv, map } = fakeKv();
    const call = whatsappWindowCaller(vi.fn(), { kv, template: null, now: () => T0, log: vi.fn() });
    return Promise.all([call('sendMessage', { chat_id: 1, text: 'Dana at Acme replied about the lease.' }), call('sendMessage', { chat_id: 1, text: 'Lunch at noon.' })]).then(() => {
      expect(forgetHeldWhatsApp(kv, ['  acme ', ''])).toEqual({ rewritten: 1, remaining: 0 });
      expect(held(map)).toEqual(['Lunch at noon.']);
      expect(forgetHeldWhatsApp(kv, [])).toEqual({ rewritten: 0, remaining: 0 });
    });
  });
});

describe('an unlink retires the bound chat', () => {
  it('discards held and re-held text and the window, refusal and knock markers, and nothing else', () => {
    const { kv, map } = fakeKv();
    for (const [key, value] of Object.entries({ 'wa_held:000000000001': { heldAt: T0, body: { chat_id: 1, text: 'Held.' } }, 'wa_held:000000000002': { heldAt: T0, body: { chat_id: 1, text: 'Also held.' } },
      'wa_reheld:wamid.out.1': true, 'wa_last_inbound_ms': T0, 'wa_knocked_for': T0, 'wa_window_refused_for': T0, 'wa_held_seq': 2, 'wa_seq': 7, 'whatsapp_subject': SUBJECT })) kv.put(key, value);
    clearWhatsAppNumber(kv);
    expect([...map.keys()].sort()).toEqual(['wa_held_seq', 'wa_seq', 'whatsapp_subject']);
  });

  it('discards a file link held outside the window along with held text', async () => {
    const { kv, map } = fakeKv();
    const graph = vi.fn();
    const call = whatsappWindowCaller(graph, { kv, template: null, now: () => T0, log: vi.fn() });
    await call('sendMessage', { chat_id: 1, text: 'Your reply.' });
    const file = { bytes: new TextEncoder().encode('%PDF-1.4 plan'), mime: 'application/pdf', filename: 'plan.pdf' };
    expect(await deliverWhatsAppFileInWindow(kv, T0, call, 1, file, async () => 'Open it here: https://waldo.example/f')).toEqual({ status: 'held', reason: 'window_closed' });
    expect(held(map)).toEqual(['Your reply.', 'Here is plan.pdf. Open it here: https://waldo.example/f']);
    clearWhatsAppNumber(kv);
    expect(held(map)).toEqual([]);
    expect(graph).not.toHaveBeenCalled();
  });
});

describe('a send that is only worth delivering now (a one-time code, a signed link)', () => {
  // The owner's real call stack above the window layer: link redaction, then the egress gate.
  const stack = (graph: ReturnType<typeof vi.fn>, opened: number | null) => {
    const { kv, map } = fakeKv();
    if (opened !== null) recordWhatsAppInbound(kv, [{ timestamp: String(opened / 1000) }], opened);
    const window = whatsappWindowCaller(whatsappTelegramShim('tok', 'pn1', SUBJECT, graph as unknown as typeof fetch), { kv, template, log: vi.fn() });
    return { map, call: egressGuardedCaller(gatedCaller(window, () => false), () => undefined) };
  };

  it('outside the window is refused, not held, through the real call stack; the owner still gets one knock', async () => {
    const graph = vi.fn(async () => Response.json(ack('wamid.knock')));
    const { map, call } = stack(graph, Date.now() - 30 * 60 * 60_000);
    expect(await call('sendMessage', { chat_id: 1, text: 'Code: 482913', [SEND_NOW_ONLY]: true })).toBeUndefined();
    expect(await call('sendMessage', { chat_id: 1, text: 'Code: 551200', [SEND_NOW_ONLY]: true })).toBeUndefined();
    expect([...map.keys()].filter(key => key.startsWith(WA_HELD_PREFIX))).toEqual([]);
    expect(JSON.stringify([...map.values()])).not.toContain('482913');
    expect(bodiesOf(graph).map(body => body.type)).toEqual(['template']);
  });

  it('inside the window goes out as ordinary text', async () => {
    const graph = vi.fn(async () => Response.json(ack('wamid.code')));
    const { call } = stack(graph, Date.now());
    expect(await call('sendMessage', { chat_id: 1, text: 'Code: 482913', [SEND_NOW_ONLY]: true })).toEqual(ack('wamid.code'));
    expect(bodiesOf(graph)).toEqual([{ messaging_product: 'whatsapp', to: `+${SUBJECT}`, type: 'text', text: { body: 'Code: 482913' } }]);
  });

  it('a 131047 refusal inside our window is refused too, and closes the window', async () => {
    const { kv, map } = fakeKv();
    recordWhatsAppInbound(kv, [{ timestamp: String(T0 / 1000) }], T0);
    const graph = vi.fn(async (_url: string, init?: RequestInit) => JSON.parse(String(init?.body)).type === 'template'
      ? Response.json(ack('wamid.knock')) : Response.json({ error: { code: 131047 } }, { status: 400 }));
    const call = whatsappWindowCaller(whatsappTelegramShim('tok', 'pn1', SUBJECT, graph as unknown as typeof fetch), { kv, template, now: () => T0 + 60_000, log: vi.fn() });
    expect(await call('sendMessage', { chat_id: 1, text: 'Code: 482913', [SEND_NOW_ONLY]: true })).toBeUndefined();
    expect(held(map)).toEqual([]);
    expect(whatsappWindowOpen(kv, T0 + 60_000)).toBe(false);
  });

  it('never reaches Telegram\'s JSON body', async () => {
    const telegram = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true, result: { message_id: 9, chat: { id: 7 } } }));
    const call = egressGuardedCaller(createTelegramCaller('7:token', telegram as unknown as typeof fetch), () => undefined);
    await call('sendMessage', { chat_id: 7, text: 'Code: 482913', [SEND_NOW_ONLY]: true });
    expect(JSON.parse(String(telegram.mock.calls[0]![1]!.body))).toEqual({ chat_id: 7, text: 'Code: 482913', link_preview_options: { is_disabled: true } });
  });
});

describe('the knock marker after a failed knock', () => {
  const knocks = async (status: number) => {
    const { kv } = fakeKv();
    let knocked = 0;
    const graph = vi.fn(async () => { knocked += 1; return knocked === 1 ? Response.json({ error: { code: status === 500 ? 1 : 132001 } }, { status }) : Response.json(ack('wamid.k')); });
    const call = whatsappWindowCaller(whatsappTelegramShim('tok', 'pn1', SUBJECT, graph as unknown as typeof fetch), { kv, template, now: () => T0, log: vi.fn() });
    await call('sendMessage', { chat_id: 1, text: 'first' });
    await call('sendMessage', { chat_id: 1, text: 'second' });
    return knocked;
  };

  it('is taken back after a definite refusal (4xx), so the next held message knocks again', async () => {
    expect(await knocks(404)).toBe(2);
  });

  it('stays after a server error (5xx), which may have sent the knock', async () => {
    expect(await knocks(500)).toBe(1);
  });
});
