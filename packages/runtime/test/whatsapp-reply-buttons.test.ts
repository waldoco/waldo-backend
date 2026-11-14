// WHATSAPP_REPLY_BUTTONS: a card whose buttons fit WhatsApp's reply buttons goes out as one interactive message, and a tap
// comes back through the same synthesized callback a typed "a:p12" does. Anything that does not fit keeps the text form.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { approvalDesk } from '../src/channels/approvals';
import { WHATSAPP_REPLY_BODY_MAX, WhatsAppApiError, waButtonReplySchema, whatsappIngressUpdates, whatsappTelegramShim } from '../src/channels/whatsapp-api';
import { deliverHeldWhatsApp, whatsappWindowCaller, whatsappWindowOpen } from '../src/channels/whatsapp-window';
import { sha256Hex } from '../src/connectors/google';
import { stableJson } from '../src/context-composer/canonical';

const OWNER = 15550001111;
const SUBJECT = String(OWNER);
const NOW = Date.UTC(2026, 10, 6, 9, 0, 0);
const HOUR = 60 * 60_000;

const graph = () => vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ messages: [{ id: 'wamid.out' }], contacts: [{ wa_id: SUBJECT }] }));
const bodies = (fetcher: ReturnType<typeof graph>) => fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, any>);
const shim = (fetcher: ReturnType<typeof graph>, replyButtons: boolean) => whatsappTelegramShim('tok', 'pn1', SUBJECT, fetcher as unknown as typeof fetch, { replyButtons });
const keyboard = (...buttons: [string, string][]) => ({ inline_keyboard: [buttons.map(([text, callback_data]) => ({ text, callback_data }))] });

describe('a card sent with reply buttons', () => {
  it('goes out as one interactive message with up to three reply buttons whose ids are the card callbacks', async () => {
    const fetcher = graph();
    await shim(fetcher, true)('sendMessage', { chat_id: OWNER, text: 'Move the 10:30 to 11:00?', reply_markup: keyboard(['Do it', 'a:p1'], ['Not now', 'd:p1'], ["Don't do this", 's:p1']) });
    expect(bodies(fetcher)).toEqual([{ messaging_product: 'whatsapp', to: `+${SUBJECT}`, type: 'interactive', interactive: { type: 'button', body: { text: 'Move the 10:30 to 11:00?' },
      action: { buttons: [{ type: 'reply', reply: { id: 'a:p1', title: 'Do it' } }, { type: 'reply', reply: { id: 'd:p1', title: 'Not now' } }, { type: 'reply', reply: { id: 's:p1', title: "Don't do this" } }] } } }]);
  });

  it('keeps the quoted message and tells the sent-text listener the card\'s words once', async () => {
    const fetcher = graph(), heard: [string, string][] = [];
    const call = whatsappTelegramShim('tok', 'pn1', SUBJECT, fetcher as unknown as typeof fetch, { replyButtons: true, onSent: (id, text) => heard.push([id, text]) });
    await call('sendMessage', { chat_id: OWNER, text: 'Send it?', turn_reply: true, quote_message_id: 'wamid.in', reply_markup: keyboard(['Send it', 'a:p2']) });
    expect(bodies(fetcher)[0]).toMatchObject({ type: 'interactive', context: { message_id: 'wamid.in' } });
    expect(heard).toEqual([['wamid.out', 'Send it?']]);
  });

  it.each([
    ['the switch is off', false, 'Send this email?', keyboard(['Send it', 'a:p1'], ['Not now', 'd:p1'])],
    ['it needs four buttons', true, 'Move it?', keyboard(['Do it', 'a:p1'], ['Modify', 'e:p1'], ['Not now', 'd:p1'], ["Don't do this", 's:p1'])],
    ['a button is a link', true, 'Connect Google?', { inline_keyboard: [[{ text: 'Connect Google', url: 'https://example.test/connect' }]] }],
    ['a title is longer than 20 characters', true, 'Send it?', keyboard(['Send it to everyone on the list', 'a:p1'])],
    ['two buttons share a title', true, 'Send it?', keyboard(['Skip', 's:p1'], ['Skip', 'd:p1'])],
    ['an id is not a card callback', true, 'Send it?', keyboard(['Send it', 'send:everything'])],
    ['the words run past 1,024 characters', true, 'x'.repeat(WHATSAPP_REPLY_BODY_MAX + 1), keyboard(['Do it', 'a:p1'])],
  ] as const)('stays text with reply instructions when %s', async (_why, on, text, markup) => {
    const fetcher = graph();
    await shim(fetcher, on)('sendMessage', { chat_id: OWNER, text, reply_markup: markup });
    const [sent] = bodies(fetcher);
    expect(sent!.type).toBe('text');
    expect(sent!.text.body.startsWith(text.slice(0, 20))).toBe(true);
  });

  it('is exactly 1,024 characters at the limit and one interactive message', async () => {
    const fetcher = graph();
    await shim(fetcher, true)('sendMessage', { chat_id: OWNER, text: 'x'.repeat(WHATSAPP_REPLY_BODY_MAX), reply_markup: keyboard(['Do it', 'a:p1']) });
    expect(bodies(fetcher).map(body => body.type)).toEqual(['interactive']);
  });

  it('held outside the 24-hour window with its buttons, and sent as the interactive card once the owner writes', async () => {
    const fetcher = graph(), map = new Map<string, unknown>(), clock = { now: NOW };
    const kv = { get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); }, delete: (key: string) => map.delete(key),
      list: <T>({ prefix }: { prefix: string }) => [...map].filter(([key]) => key.startsWith(prefix)) as unknown as Iterable<[string, T]> };
    kv.put('wa_last_inbound_ms', NOW - 30 * HOUR);
    const call = whatsappWindowCaller(shim(fetcher, true), { kv, template: { name: 'waldo_update_ready', language: 'en' }, now: () => clock.now, log: () => undefined });
    await call('sendMessage', { chat_id: OWNER, text: 'Move the 10:30?', reply_markup: keyboard(['Do it', 'a:p9'], ['Not now', 'd:p9']) });
    expect(bodies(fetcher).map(body => body.type)).toEqual(['template']);
    kv.put('wa_last_inbound_ms', clock.now);
    await deliverHeldWhatsApp(kv, call, clock.now, () => undefined, SUBJECT);
    expect(bodies(fetcher).map(body => body.type)).toEqual(['template', 'interactive']);
    expect(whatsappWindowOpen(kv, clock.now)).toBe(true);
  });
});

describe('Meta refusing the interactive form', () => {
  const refusing = (status: number, code: number) => vi.fn(async (_url: string, init?: RequestInit) =>
    JSON.parse(String(init?.body)).type === 'interactive' ? Response.json({ error: { code } }, { status }) : Response.json({ messages: [{ id: 'wamid.text' }] }));
  const card = { chat_id: OWNER, text: 'Move the 10:30?', reply_markup: keyboard(['Do it', 'a:p1'], ['Not now', 'd:p1']) };
  it('falls back to the text form once, with the reply instructions, on a definite refusal', async () => {
    const fetcher = refusing(400, 131009);
    const ack = await shim(fetcher as ReturnType<typeof graph>, true)('sendMessage', card);
    expect(bodies(fetcher as ReturnType<typeof graph>).map(body => body.type)).toEqual(['interactive', 'text']);
    expect(bodies(fetcher as ReturnType<typeof graph>)[1]!.text.body).toBe('Move the 10:30?\n\n- Do it: reply "a:p1"\n- Not now: reply "d:p1"');
    expect(ack).toMatchObject({ messages: [{ id: 'wamid.text' }] });
  });
  it('does not resend after a server error or a timeout, which may have gone out, nor for the window, which the window layer owns', async () => {
    for (const [status, code] of [[500, 1], [400, 131047]] as const) {
      const fetcher = refusing(status, code);
      await expect(shim(fetcher as ReturnType<typeof graph>, true)('sendMessage', card)).rejects.toBeInstanceOf(WhatsAppApiError);
      expect(bodies(fetcher as ReturnType<typeof graph>).map(body => body.type)).toEqual(['interactive']);
    }
  });
});

describe('a tap on a reply button', () => {
  const tap = (id: unknown, extra: object = {}) => ({ id: 'wamid.tap', from: SUBJECT, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'Do it' } }, context: { from: '15550009999', id: 'wamid.card' }, ...extra });
  it('is the callback a typed approval reply is, from the owner, and nothing else', () => {
    const { updates, sources } = whatsappIngressUpdates([tap('a:p12', { context: { from: '15550009999', id: 'wamid.card' } })], SUBJECT, 0);
    expect(updates).toEqual([{ update_id: expect.any(Number), callback_query: { id: 'wa-wamid.tap', from: { id: OWNER, is_bot: false }, data: 'a:p12', card_ref: 'wamid.card', message: { message_id: 0, chat: { id: OWNER } } } }]);
    expect(sources).toEqual(['wamid.tap']);
    expect(whatsappIngressUpdates([{ id: 'wamid.typed', from: SUBJECT, type: 'text', text: { body: 'a:p12' } }], SUBJECT, 0).updates[0]).toMatchObject({ callback_query: { data: 'a:p12' } });
  });

  it('from anyone but the owner, or forwarded, never becomes a decision', () => {
    expect(whatsappIngressUpdates([tap('a:p12', { from: '15550009999' })], SUBJECT, 0).updates).toEqual([]);
    const { updates } = whatsappIngressUpdates([tap('a:p12', { context: { forwarded: true } })], SUBJECT, 0);
    expect(updates).toEqual([expect.objectContaining({ message: expect.objectContaining({ whatsapp_type: 'interactive' }) })]);
  });

  it.each([
    ['an id that is not a card callback', tap('send:everything')],
    ['an empty id', tap('')],
    ['an id past 256 characters', tap(`a:${'p'.repeat(255)}`)],
    ['a missing id', tap(undefined)],
    ['a list reply', { id: 'wamid.l', from: SUBJECT, type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'a:p1', title: 'x' } } }],
    ['no card named (no context)', tap('a:p12', { context: undefined })],
    ['an empty card name', tap('a:p12', { context: { from: '15550009999', id: '' } })],
    ['no button_reply', { id: 'wamid.n', from: SUBJECT, type: 'interactive', interactive: { type: 'button_reply' } }],
  ])('%s is the shared unsupported message, never a decision', (_what, message) => {
    const { updates } = whatsappIngressUpdates([message as never], SUBJECT, 0);
    expect(updates).toEqual([{ update_id: expect.any(Number), message: expect.objectContaining({ whatsapp_type: 'interactive' }) }]);
  });

  it('is validated against the documented webhook payload', () => {
    expect(waButtonReplySchema.safeParse({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 's:p3', title: 'Skip' } } }).success).toBe(true);
    for (const bad of [{ type: 'text' }, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'x', title: 'Skip' } } },
      { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'a:p1', title: 7 } } }, { type: 'interactive', interactive: {} }, {}])
      expect(waButtonReplySchema.safeParse(bad).success).toBe(false);
  });
});

// The card's whole journey on WhatsApp: the desk sends it through the real shim and window layer, a tap decides it, and a tap on
// a card another surface already settled is answered once, as a settled one, without deciding anything again.
const tainted = async () => {
  const args = { title: 'Pay the invoice from the email' };
  return { tool: 'create_task', args, args_digest: await sha256Hex(stableJson(args)), reasoning: 'The email asked for it.', source: 'external' as const };
};
const journey = (name: string, work: (f: { desk: ReturnType<typeof approvalDesk>; fetcher: ReturnType<typeof graph>; tap: (data: string, cardRef?: string) => Promise<void>; texts: () => string[]; sql: SqlStorage; ran: string[] }) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), async (_instance, state) => {
    const { kv, sql } = state.storage, fetcher = graph(), ran: string[] = [];
    kv.put('wa_last_inbound_ms', NOW - HOUR);
    const call = whatsappWindowCaller(shim(fetcher, true), { kv, template: null, now: () => NOW, log: () => undefined });
    let n = 0;
    const desk = approvalDesk(sql, { owner: OWNER, surface: 'whatsapp', call, writesFirstNow: () => whatsappWindowOpen(kv, NOW), google: async () => null, newId: () => `w${++n}`, now: () => NOW,
      timezone: 'UTC', log: () => undefined, commit: work => state.storage.transactionSync(work), appIdentity: () => true,
      replayTaintedAction: async proposal => { ran.push(proposal.tool); return { status: 'done', message: 'Created.' }; } });
    // A tap arrives as the webhook describes it and goes through the same ingress the owner object uses.
    const tap = async (data: string, cardRef: string | undefined = 'wamid.out') => {
      const { updates } = whatsappIngressUpdates([{ id: `wamid.tap.${data}`, from: SUBJECT, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: data, title: 'Tap' } },
        ...(cardRef ? { context: { from: '15550009999', id: cardRef } } : {}) }], SUBJECT, 0);
      await desk.callback((updates[0] as { callback_query: Parameters<typeof desk.callback>[0] }).callback_query, 'trace');
    };
    await work({ desk, fetcher, tap, texts: () => bodies(fetcher).flatMap(body => body.type === 'text' ? [String(body.text.body)] : []), sql, ran });
  });

describe('the card journey over WhatsApp reply buttons', () => {
  it('a card handed to the app goes out as an interactive Not now / Don\'t do this card, and a tap on Not now puts it off once', async () => {
    await journey('buttons-not-now', async ({ desk, fetcher, tap, texts, sql }) => {
      const id = await desk.proposeTaintedAction(await tainted());
      const [card] = bodies(fetcher);
      expect(card).toMatchObject({ type: 'interactive', interactive: { type: 'button', action: { buttons: [{ reply: { id: `d:${id}`, title: 'Not now' } }, { reply: { id: `s:${id}`, title: "Don't do this" } }] } } });
      await tap(`d:${id}`);
      expect(sql.exec<{ deferred_at: number | null }>('SELECT deferred_at FROM ledger WHERE id = ?', id).one().deferred_at).not.toBeNull();
      expect(texts().at(-1)).toBeTruthy();
    });
  });

  it('a tap on a card the app already settled is answered as settled, and decides nothing again', async () => {
    await journey('buttons-stale-tap', async ({ desk, tap, texts, sql, ran }) => {
      const id = await desk.proposeTaintedAction(await tainted());
      await desk.decide(id, 's', 'trace', { surface: 'app' });
      const status = () => sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;
      expect(status()).toBe('skipped');
      await tap(`s:${id}`);
      await tap(`d:${id}`);
      expect(status()).toBe('skipped');
      expect(texts()).toEqual(['Already handled.', 'Already handled.']);
      expect(ran).toEqual([]);
    });
  });

  it('a tap is accepted from the card the owner was shown, and refused from any other message while the approval waits', async () => {
    await journey('buttons-card-bound', async ({ desk, tap, texts, sql }) => {
      const id = await desk.proposeTaintedAction(await tainted());
      const deferred = () => sql.exec<{ deferred_at: number | null }>('SELECT deferred_at FROM ledger WHERE id = ?', id).one().deferred_at;
      await tap(`d:${id}`, 'wamid.some-other-message');
      expect(deferred()).toBeNull();
      expect(texts().at(-1)).toContain('no longer current');
      await tap(`d:${id}`, 'wamid.out');
      expect(deferred()).not.toBeNull();
    });
  });

  it('an Allow tap on a standing-grant card goes through the desk\'s own rule and makes no grant here', async () => {
    await journey('buttons-standing-grant', async ({ desk, tap, texts, sql }) => {
      const id = await desk.proposeStandingGrant({ scope: { class: 'calendar.move_own_block', account: 'owner@example.test', window: { from: '08:00', to: '19:00' }, weekdays: [1, 2, 3, 4, 5], min_lead_minutes: 30 },
        limits: { max_per_day: 3, timezone: 'UTC' }, valid_from: NOW, expires_at: NOW + 20 * 24 * HOUR });
      await tap(`a:${id}`, 'wamid.out');
      expect(sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('rejected');
      expect(texts().at(-1)).toContain('no grant was made');
    });
  });
});
