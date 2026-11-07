// WHATSAPP_LIST_CARDS: a card with more choices than WhatsApp's three reply buttons (Approve, Modify, Not now, Don't do this)
// goes out as one interactive list, and the owner's choice comes back through the same synthesized callback a reply button or
// a typed "a:p12" does. Anything that does not fit a list keeps the text form.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { approvalDesk } from '../src/channels/approvals';
import { whatsappWindowCaller, whatsappWindowOpen } from '../src/channels/whatsapp-window';
import type { GoogleClient } from '../src/connectors/google';
import { WHATSAPP_LIST_BODY_MAX, WhatsAppApiError, waListReplySchema, whatsappIngressUpdates, whatsappTelegramShim } from '../src/channels/whatsapp-api';

const OWNER = 15550001111;
const SUBJECT = String(OWNER);
const graph = () => vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ messages: [{ id: 'wamid.out' }], contacts: [{ wa_id: SUBJECT }] }));
const bodies = (fetcher: ReturnType<typeof graph>) => fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, any>);
const shim = (fetcher: ReturnType<typeof graph>, listCards: boolean, replyButtons = true) =>
  whatsappTelegramShim('tok', 'pn1', SUBJECT, fetcher as unknown as typeof fetch, { replyButtons, listCards });
const keyboard = (...buttons: [string, string][]) => ({ inline_keyboard: [buttons.map(([text, callback_data]) => ({ text, callback_data }))] });
const FOUR = keyboard(['Move it', 'a:p1'], ['Modify', 'e:p1'], ['Not now', 'd:p1'], ["Don't do this", 's:p1']);

describe('a card with more choices than reply buttons hold', () => {
  it('goes out as one interactive list whose rows are the card callbacks, quoting what it answers', async () => {
    const fetcher = graph(), heard: [string, string][] = [];
    const call = whatsappTelegramShim('tok', 'pn1', SUBJECT, fetcher as unknown as typeof fetch, { replyButtons: true, listCards: true, onSent: (id, text) => heard.push([id, text]) });
    await call('sendMessage', { chat_id: OWNER, text: 'Move the 10:30 to 11:00?', turn_reply: true, quote_message_id: 'wamid.in', reply_markup: FOUR });
    expect(bodies(fetcher)).toEqual([{ messaging_product: 'whatsapp', to: `+${SUBJECT}`, context: { message_id: 'wamid.in' }, type: 'interactive', interactive: { type: 'list',
      body: { text: 'Move the 10:30 to 11:00?' }, action: { button: 'Choose', sections: [{ title: 'Your choices', rows: [
        { id: 'a:p1', title: 'Move it' }, { id: 'e:p1', title: 'Modify' }, { id: 'd:p1', title: 'Not now' }, { id: 's:p1', title: "Don't do this" }] }] } } }]);
    expect(heard).toEqual([['wamid.out', 'Move the 10:30 to 11:00?']]);
  });

  it('with reply buttons off, still goes out as a list', async () => {
    const fetcher = graph();
    await shim(fetcher, true, false)('sendMessage', { chat_id: OWNER, text: 'Send it?', reply_markup: keyboard(['Send it', 'a:p2'], ['Not now', 'd:p2']) });
    expect(bodies(fetcher)[0]).toMatchObject({ type: 'interactive', interactive: { type: 'list' } });
  });

  it('that fits three reply buttons keeps them', async () => {
    const fetcher = graph();
    await shim(fetcher, true)('sendMessage', { chat_id: OWNER, text: 'Send it?', reply_markup: keyboard(['Send it', 'a:p2'], ['Not now', 'd:p2']) });
    expect(bodies(fetcher)[0]).toMatchObject({ type: 'interactive', interactive: { type: 'button' } });
  });

  it.each([
    ['the switch is off', false, 'Move it?', FOUR],
    ['a row title is longer than 24 characters', true, 'Move it?', keyboard(['Move it to the afternoon slot', 'a:p1'], ['Modify', 'e:p1'], ['Not now', 'd:p1'], ['Skip', 's:p1'])],
    ['two rows share a title', true, 'Move it?', keyboard(['Skip', 'a:p1'], ['Skip', 'e:p1'], ['Not now', 'd:p1'], ['No', 's:p1'])],
    ['a row is a link', true, 'Move it?', { inline_keyboard: [[{ text: 'Open', url: 'https://example.test/x' }, { text: 'Modify', callback_data: 'e:p1' }, { text: 'Not now', callback_data: 'd:p1' }, { text: 'Skip', callback_data: 's:p1' }]] }],
    ['an id is not a card callback', true, 'Move it?', keyboard(['Move it', 'move:everything'], ['Modify', 'e:p1'], ['Not now', 'd:p1'], ['Skip', 's:p1'])],
    ['an id is past 200 characters', true, 'Move it?', keyboard(['Move it', `a:${'p'.repeat(199)}`], ['Modify', 'e:p1'], ['Not now', 'd:p1'], ['Skip', 's:p1'])],
    ['there are more than ten rows', true, 'Pick one?', keyboard(...Array.from({ length: 11 }, (_, n) => [`Option ${n}`, `a:p${n}`] as [string, string]))],
    ['the words run past 4,096 characters', true, 'x'.repeat(WHATSAPP_LIST_BODY_MAX + 1), FOUR],
  ] as const)('stays text with reply instructions when %s', async (_why, on, text, markup) => {
    const fetcher = graph();
    await shim(fetcher, on)('sendMessage', { chat_id: OWNER, text, reply_markup: markup });
    const [sent] = bodies(fetcher);
    expect(sent!.type).toBe('text');
    expect(sent!.text.body.startsWith(text.slice(0, 20))).toBe(true);
  });

  it('falls back to the text form once when Meta refuses the list, and leaves a server error to its retry owner', async () => {
    const refused = vi.fn(async (_url: string, init?: RequestInit) => JSON.parse(String(init?.body)).type === 'interactive'
      ? Response.json({ error: { code: 131009, message: 'synthetic parameter refusal' } }, { status: 400 }) : Response.json({ messages: [{ id: 'wamid.text' }], contacts: [{ wa_id: SUBJECT }] }));
    await shim(refused as never, true)('sendMessage', { chat_id: OWNER, text: 'Move it?', reply_markup: FOUR });
    expect(bodies(refused as never).map(body => body.type)).toEqual(['interactive', 'text']);
    expect(bodies(refused as never)[1]!.text.body).toContain('- Modify: reply "e:p1"');
    const down = vi.fn(async () => Response.json({ error: { code: 1, message: 'synthetic outage' } }, { status: 500 }));
    await expect(shim(down as never, true)('sendMessage', { chat_id: OWNER, text: 'Move it?', reply_markup: FOUR })).rejects.toBeInstanceOf(WhatsAppApiError);
    expect(down).toHaveBeenCalledTimes(1);
  });
});

describe('a choice from a list', () => {
  const choose = (id: unknown, extra: object = {}) => ({ id: 'wamid.choice', from: SUBJECT, type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title: 'Modify' } }, context: { from: '15550009999', id: 'wamid.card' }, ...extra });

  it('is the callback a reply button or a typed reply is, naming the list it came from', () => {
    const { updates, sources } = whatsappIngressUpdates([choose('e:p12')], SUBJECT, 0);
    expect(updates).toEqual([{ update_id: expect.any(Number), callback_query: { id: 'wa-wamid.choice', from: { id: OWNER, is_bot: false }, data: 'e:p12', card_ref: 'wamid.card', message: { message_id: 0, chat: { id: OWNER } } } }]);
    expect(sources).toEqual(['wamid.choice']);
  });

  it('from anyone but the owner, or forwarded, never becomes a decision', () => {
    expect(whatsappIngressUpdates([choose('a:p12', { from: '15550009999' })], SUBJECT, 0).updates).toEqual([]);
    expect(whatsappIngressUpdates([choose('a:p12', { context: { forwarded: true } })], SUBJECT, 0).updates).toEqual([expect.objectContaining({ message: expect.objectContaining({ whatsapp_type: 'interactive' }) })]);
  });

  it.each([
    ['an id that is not a card callback', choose('send:everything')],
    ['an id past 200 characters', choose(`a:${'p'.repeat(199)}`)],
    ['no list named (no context)', choose('a:p12', { context: undefined })],
    ['no list_reply', { id: 'wamid.n', from: SUBJECT, type: 'interactive', interactive: { type: 'list_reply' } }],
  ])('%s is the shared unsupported message, never a decision', (_what, message) => {
    expect(whatsappIngressUpdates([message as never], SUBJECT, 0).updates).toEqual([{ update_id: expect.any(Number), message: expect.objectContaining({ whatsapp_type: 'interactive' }) }]);
  });

  it('is validated against the documented webhook payload', () => {
    expect(waListReplySchema.safeParse({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'e:p3', title: 'Modify', description: 'Change it first' } } }).success).toBe(true);
    for (const bad of [{ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'x' } } }, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'a:p1' } } }, {}])
      expect(waListReplySchema.safeParse(bad).success).toBe(false);
  });
});

// The card's journey: the desk proposes a calendar change (Do it, Modify, Not now, Don't do this), the real shim and window
// layer send it as a list, and the owner's choice of a row, read by the same ingress the owner object uses, decides it once.
describe('the card journey over a WhatsApp list', () => {
  it('a four-choice card goes out as a list, and choosing Do it applies the change once', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`list-journey-${crypto.randomUUID()}`)), async (_instance, state) => {
      const NOW = Date.UTC(2026, 10, 7, 9, 0, 0), fetcher = graph(), applied: string[] = [];
      state.storage.kv.put('wa_last_inbound_ms', NOW - 60_000);
      const client = { account: { connection_id: 'local:owner@example.test', email: 'owner@example.test' },
        createEvent: async (input: { title: string }) => { applied.push(input.title); return { id: 'ev-1', title: input.title, start: '', end: '', all_day: false, etag: 'v1' }; } } as unknown as GoogleClient;
      let n = 0;
      const desk = approvalDesk(state.storage.sql, { owner: OWNER, surface: 'whatsapp', appIdentity: () => true, writesFirstNow: () => whatsappWindowOpen(state.storage.kv, NOW),
        call: whatsappWindowCaller(shim(fetcher, true), { kv: state.storage.kv, template: null, now: () => NOW, log: () => undefined }),
        google: async () => client, newId: () => `w${++n}`, now: () => NOW, timezone: 'UTC', log: () => undefined, commit: work => state.storage.transactionSync(work) });
      const id = await desk.propose({ action: 'create', title: 'Focus', start: '2026-11-08T15:00:00Z' as never, end: '2026-11-08T16:00:00Z' as never, reason: 'deep work' });
      const [card] = bodies(fetcher);
      expect(card).toMatchObject({ type: 'interactive', interactive: { type: 'list' } });
      const rows = card!.interactive.action.sections[0].rows as { id: string; title: string }[];
      expect(rows.map(row => row.title)).toEqual(['Do it', 'Modify', 'Not now', "Don't do this"]);
      const choose = async (row: string) => {
        const { updates } = whatsappIngressUpdates([{ id: `wamid.choice.${row}`, from: SUBJECT, type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: row, title: 'Do it' } }, context: { from: '15550009999', id: 'wamid.out' } }], SUBJECT, 0);
        await desk.callback((updates[0] as { callback_query: Parameters<typeof desk.callback>[0] }).callback_query, 'trace');
      };
      await choose(rows[0]!.id);
      await choose(rows[0]!.id);
      expect(applied).toEqual(['Focus']);
      expect(state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('done');
    });
  });
});
